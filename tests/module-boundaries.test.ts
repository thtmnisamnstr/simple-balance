import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blankComments, repoRoot, sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/typescript.md` 3.3, which said "checked by nothing yet"
 * and named this test as the thing worth building.
 *
 * The direction is `shared ← server` and `shared ← client`, never the reverse
 * and never `server ↔ client`. Nothing about that is visible at a call site:
 * `src/shared` is bundled into the browser, so an import reaching up into
 * `src/server` fails at build time if it drags a `node:` module along and
 * silently ships server code to the browser if it does not. The second is the
 * one worth a test, because it produces no error at all.
 *
 * Substrings cannot decide this. `src/server/db/client.ts` exists, so grepping
 * the server for `client` finds ten imports that are perfectly correct. Every
 * specifier is therefore resolved to a real file before it is judged.
 */
const AREAS = ["shared", "server", "client"] as const;
type Area = (typeof AREAS)[number];

/** Which areas a file in each area may import from. */
const MAY_IMPORT: Record<Area, readonly Area[]> = {
  shared: ["shared"],
  server: ["server", "shared"],
  client: ["client", "shared"],
};

/**
 * The two areas that end up in the browser bundle. A `node:` import in either
 * is a build failure waiting for the first person who runs `npm run build`
 * after adding one.
 */
const BROWSER_AREAS: readonly Area[] = ["shared", "client"];

const areaOf = (file: string): Area =>
  AREAS.find((area) => file.startsWith(`src/${area}/`)) ??
  (() => {
    throw new Error(`${file} is not in one of ${AREAS.join(", ")}`);
  })();

const allowed = (from: string, target: string) => MAY_IMPORT[areaOf(from)].includes(areaOf(target));

type Edge = { from: string; specifier: string; line: number };

/**
 * Every module specifier a file names, whether statically, as a re-export, or
 * through a dynamic `import()`.
 *
 * Comments are blanked first. Without that, `src/client/date-range.ts:70` —
 * "Deriving it from \"this-month\"" — reads as an import of a package that does
 * not exist.
 */
const specifiersIn = (code: string): { specifier: string; offset: number }[] => {
  const found: { specifier: string; offset: number }[] = [];
  const patterns = [
    // `import … from "x"`, and `export … from "x"`, including the multi-line
    // form where the closing brace and the `from` share a line of their own.
    /\bfrom\s*["']([^"'\n]+)["']/g,
    // A side-effect import, which names no bindings and so has no `from`.
    /(?:^|\n)\s*import\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      found.push({ specifier: match[1]!, offset: match.index });
    }
  }
  return found;
};

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * Where a relative specifier lands, or null when nothing is there.
 *
 * Imports say `.js` because that is what Node resolves at runtime (3.1), and
 * the file on disk is `.ts` or `.tsx`, so the extension is swapped back before
 * the file is looked for.
 */
const resolveRelative = (from: string, specifier: string): string | null => {
  const joined = path.join(path.dirname(from), specifier);
  const candidates = specifier.endsWith(".js")
    ? [joined.replace(/\.js$/, ".ts"), joined.replace(/\.js$/, ".tsx")]
    : [joined, `${joined}.ts`, `${joined}.tsx`, path.join(joined, "index.ts")];
  return candidates.find((candidate) => existsSync(path.join(repoRoot, candidate))) ?? null;
};

const files = sourceFiles("src");
const edges: Edge[] = files.flatMap((file) =>
  specifiersIn(file.code).map((found) => ({
    from: file.path,
    specifier: found.specifier,
    line: lineOf(file.code, found.offset),
  })),
);
const relative = edges.filter((edge) => edge.specifier.startsWith("."));
const bare = edges.filter((edge) => !edge.specifier.startsWith("."));

describe("reading source with its comments blanked", () => {
  it("leaves code, strings and line numbers exactly where they were", () => {
    const source = [
      'const url = "https://example.com/x"; // a trailing note',
      "const next = 1;",
    ].join("\n");
    const blanked = blankComments(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked.split("\n").length).toBe(2);
    expect(blanked).toContain('const url = "https://example.com/x";');
    expect(blanked).not.toContain("a trailing note");
  });

  it("does not read a slash inside a string or a template as the start of anything", () => {
    const blanked = blankComments('const a = `/* ${x} */`; const b = "/* still text */";');
    expect(blanked).toContain("still text");
    expect(blanked).toContain("${x}");
  });

  it("keeps the code after a regular expression that contains a slash", () => {
    const blanked = blankComments('const name = value.replace(/^\\//, ""); const after = 2;');
    expect(blanked).toContain("const after = 2;");
  });

  it("blanks a block comment without moving the lines around it", () => {
    const blanked = blankComments(
      ["const a = 1;", "/* two", "   lines */", "const b = 2;"].join("\n"),
    );
    expect(blanked.split("\n")).toHaveLength(4);
    expect(blanked).not.toContain("two");
    expect(blanked.split("\n")[3]).toBe("const b = 2;");
  });

  // The reader is the thing every check below trusts, so it is checked against
  // the tree as well as against fixtures: an extractor that quietly found
  // nothing would make each of these tests pass by having no work to do. Every
  // statement that begins a line with `import` names exactly one module, so the
  // two counts have to agree file by file.
  it("finds every import statement the tree actually has", () => {
    expect(files.length).toBeGreaterThan(50);
    const short = files
      .map((file) => ({
        path: file.path,
        statements: (file.code.match(/^import\b/gm) ?? []).length,
        found: specifiersIn(file.code).length,
      }))
      .filter((file) => file.found < file.statements);
    expect(short).toEqual([]);
  });
});

describe("the import graph", () => {
  // Stated against real paths rather than the real graph, because the graph is
  // clean and a check nothing can fail is a check nobody should believe.
  it("knows which direction is which", () => {
    expect(allowed("src/client/App.tsx", "src/shared/domain.ts")).toBe(true);
    expect(allowed("src/server/api.ts", "src/shared/domain.ts")).toBe(true);
    expect(allowed("src/shared/domain.ts", "src/server/services/errors.ts")).toBe(false);
    expect(allowed("src/shared/csv.ts", "src/client/money.ts")).toBe(false);
    expect(allowed("src/server/api.ts", "src/client/App.tsx")).toBe(false);
    expect(allowed("src/client/api.ts", "src/server/api.ts")).toBe(false);
  });

  it("resolves every relative import to a file that exists", () => {
    const missing = relative
      .filter((edge) => !resolveRelative(edge.from, edge.specifier))
      .map((edge) => `${edge.from}:${edge.line} → ${edge.specifier}`);
    expect(missing).toEqual([]);
  });

  it("never points upward or sideways", () => {
    const wrong = relative.flatMap((edge) => {
      const target = resolveRelative(edge.from, edge.specifier);
      if (!target) return [];
      if (allowed(edge.from, target)) return [];
      return [`${edge.from}:${edge.line} imports ${areaOf(target)} (${target})`];
    });
    expect(wrong, `${AREAS.join(" and ")} may only import what MAY_IMPORT allows`).toEqual([]);
  });

  it("keeps Node's built-in modules out of anything the browser loads", () => {
    const builtin = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    const leaked = bare
      .filter((edge) => BROWSER_AREAS.includes(areaOf(edge.from)) && builtin.has(edge.specifier))
      .map((edge) => `${edge.from}:${edge.line} → ${edge.specifier}`);
    expect(leaked).toEqual([]);
  });

  // Not a boundary rule but the same read of the same graph, and it catches the
  // mistake that looks identical in an editor: a package that is only installed
  // because something else pulls it in works locally and is absent from a
  // production install, where `devDependencies` are not there at all.
  it("imports only packages this repository depends on", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const declared = Object.keys(manifest.dependencies);
    const builtin = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    const undeclared = bare
      .filter(
        (edge) =>
          !builtin.has(edge.specifier) &&
          !declared.some(
            (name) => edge.specifier === name || edge.specifier.startsWith(`${name}/`),
          ),
      )
      .map((edge) => `${edge.from}:${edge.line} → ${edge.specifier}`);
    expect(undeclared).toEqual([]);
  });
});
