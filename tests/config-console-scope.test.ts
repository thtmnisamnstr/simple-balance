import { describe, expect, it } from "vitest";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * Where the one exception to the logging gate is allowed to sit.
 *
 * `code/observability.md` 2.1 is **Binding**: every line goes through `log`, so
 * `LOG_LEVEL` means something. The rule that cost a release — the one about the
 * *identifier* rather than the call, including `logger = console` as a default
 * parameter — is held by `tests/log-level.test.ts`, which walks `src/server`
 * and allows `console` in three named files and nowhere else.
 *
 * This is the residue that guide calls review: **where inside those three**.
 * The exception exists for one reason and the guide gives it — routing a
 * configuration warning through `log` would be re-entrant during the first
 * `getConfig()`, which is a stack overflow rather than a quiet line, and a
 * warning about configuration should not be gated by a configuration value
 * that may be the thing that is wrong. A `console.warn` added to one of these
 * files somewhere the first read never reaches has none of that behind it: it
 * is simply outside the gate, in a file the gate has been told to skip.
 *
 * `tests/log-level.test.ts:204-221` asks only that each named file still writes
 * a console line *somewhere in it*, and the guide says so plainly — "a file
 * whose warning had left the first configuration read would also pass — and
 * that read is the whole of what the exception is for."
 *
 * So the unit here is the function, and the permitted ones are a register.
 * Keyed by file and function name rather than by line, because a line number
 * drifts the first time anything above it moves and nothing watches that.
 */

/**
 * The functions a configuration warning may be written from, and why each one
 * is read before `log` can be.
 *
 * `src/server/log.ts` is absent on purpose: it is on 2.1's exception list
 * because it is the gate, so every `console` call in it is the one doing the
 * writing, and asking where they sit would be asking the gate to explain
 * itself.
 */
const WRITES_BEFORE_THE_GATE = [
  {
    file: "src/server/config.ts",
    // The first read itself. Every warning here is about a setting `getConfig`
    // has just parsed, and `log` reads `getConfig()` to learn its level.
    functions: ["getConfig"],
  },
  {
    file: "src/server/config-files.ts",
    // `resolveFileBackedSecrets` memoizes and runs on first read — before
    // `getConfig` in the paths that never call it, since `getPool` and
    // `npm run db:migrate` read the connection string directly. `warnOnce` is
    // its only way of saying a `_FILE` path was unreadable.
    functions: ["warnOnce"],
  },
  {
    file: "src/server/config-limits.ts",
    // These two are read at startup *and* on a schedule —
    // `configuredRecurrenceTickSeconds` runs on every scheduler tick — which is
    // the same argument one step along: the first of those reads happens before
    // anything has a level, and warning once per name is what keeps the later
    // ones quiet.
    functions: ["boundedEnvironmentInteger", "configuredIdempotencyRetentionHours"],
  },
];

/** Top-level `function name(…) { … }` declarations, with their extents. */
function topLevelFunctions(file: SourceFile): { name: string; from: number; to: number }[] {
  const found: { name: string; from: number; to: number }[] = [];
  // Anchored at the start of a line, which is what makes it top level: a nested
  // declaration is indented, and a method on an object literal is too. An
  // `export` prefix is allowed and nothing else.
  for (const match of file.code.matchAll(
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
  )) {
    const open = file.code.indexOf("{", match.index);
    if (open === -1) continue;
    let depth = 0;
    let to = file.code.length;
    for (let index = open; index < file.code.length; index++) {
      if (file.code[index] === "{") depth += 1;
      else if (file.code[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          to = index;
          break;
        }
      }
    }
    found.push({ name: match[1]!, from: match.index, to });
  }
  return found;
}

type Line = { readonly file: string; readonly line: number; readonly enclosing: string };

function consoleLines(file: SourceFile): Line[] {
  const functions = topLevelFunctions(file);
  // Comments blanked, so the paragraphs in these files that discuss `console`
  // — and 2.1's own argument, quoted in two of them — are not read as calls.
  return [...file.code.matchAll(/\bconsole\.(?:warn|error|info|log|debug|trace)\(/g)].map(
    (match) => ({
      file: file.path,
      line: file.text.slice(0, match.index).split("\n").length,
      enclosing:
        functions.find((fn) => match.index > fn.from && match.index < fn.to)?.name ??
        "module scope",
    }),
  );
}

describe("the configuration layer's console lines", () => {
  const files = sourceFiles("src/server");
  const layer = WRITES_BEFORE_THE_GATE.map((entry) => ({
    ...entry,
    lines: consoleLines(files.find((file) => file.path === entry.file)!),
  }));

  /**
   * The reading, before any verdict. Every assertion below is satisfied by an
   * empty list, and a scanner that had stopped finding either the calls or the
   * functions around them would produce exactly that.
   */
  it("are found, and so are the functions around them", () => {
    for (const entry of layer) {
      expect(entry.lines.length, `${entry.file} writes no console line at all`).toBeGreaterThan(0);
      expect(
        entry.lines.filter((line) => line.enclosing === "module scope"),
        `${entry.file}: a console line was not placed in any function`,
      ).toEqual([]);
    }
    // And the brace walk really walks: `getConfig` is a long function with
    // nested blocks, closures and object literals in it, and a scanner that
    // stopped at the first `}` would attribute its warnings to nothing.
    const config = layer.find((entry) => entry.file === "src/server/config.ts")!;
    expect(config.lines.length).toBeGreaterThanOrEqual(4);
    expect(new Set(config.lines.map((line) => line.enclosing))).toEqual(new Set(["getConfig"]));
  });

  it("are written only from a function the first configuration read reaches", () => {
    const stray = layer.flatMap((entry) =>
      entry.lines
        .filter((line) => !entry.functions.includes(line.enclosing))
        .map(
          (line) =>
            `${line.file}:${line.line} writes console from ${line.enclosing}, which is not ` +
            `${entry.functions.join(" or ")}`,
        ),
    );
    expect(
      stray,
      "code/observability.md 2.1: the exception is for a warning the gate cannot carry, " +
        "not for the three files as a whole. Route it through `log`, or add the function to " +
        "WRITES_BEFORE_THE_GATE with the argument for why it runs before a level exists.",
    ).toEqual([]);
  });

  /**
   * A register entry that no longer names anything is the quiet failure: the
   * check above would go on passing while every function it excuses had been
   * renamed or retired.
   */
  it("keep no excuse for a function that has stopped writing one", () => {
    const unused = layer.flatMap((entry) =>
      entry.functions
        .filter((name) => !entry.lines.some((line) => line.enclosing === name))
        .map((name) => `${entry.file}: ${name} no longer writes a console line`),
    );
    expect(unused).toEqual([]);
  });
});
