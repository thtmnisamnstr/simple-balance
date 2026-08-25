import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reading `src` the way a check on the source has to read it.
 *
 * Several rules in `docs/standards/code/` are properties of the text — a type
 * that must not appear, an import that must not cross a boundary, a cast a SQL
 * fragment must carry. Each is one grep away from being enforced, and each is
 * also one grep away from firing on prose: `from "this-month"` is a comment in
 * `src/client/date-range.ts`, and `count(*)` is a comment three times over in
 * `src/server/services`. A check that read those as code would have called four
 * correct files wrong, which is the failure mode that keeps these rules marked
 * `human` in the first place.
 *
 * So every file arrives here twice: as written, and with every comment blanked
 * to spaces. Blanking rather than deleting keeps offsets and line numbers lined
 * up, so a match found in the second can be reported against the first.
 */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export type SourceFile = {
  /** Repository-relative and slash-separated, e.g. `src/shared/domain.ts`. */
  readonly path: string;
  /** The file as somebody reads it. */
  readonly text: string;
  /** The same characters, every comment replaced by spaces. */
  readonly code: string;
};

/** Every `.ts` and `.tsx` file under a repository-relative directory. */
export function sourceFiles(relative: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    // Sorted so a failure lists the same files in the same order on every
    // machine; readdir order is the filesystem's business, not this test's.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      found.push({
        path: path.relative(repoRoot, full).split(path.sep).join("/"),
        text,
        code: blankComments(text),
      });
    }
  };
  walk(path.join(repoRoot, relative));
  return found;
}

/**
 * The characters after which a `/` starts a regular expression rather than
 * dividing.
 *
 * Deliberately a small allowlist rather than "anything that cannot end an
 * expression". `<` is the one that matters: in a `.tsx` file the `/` of
 * `</div>` follows one, and reading that as a regular expression would swallow
 * the JSX up to the next slash. Guessing division where a regular expression
 * was meant costs nothing here — the body is scanned as ordinary code, and the
 * only way that misleads is a regular expression containing `//` or `/*`, of
 * which this repository has none.
 */
const REGEX_MAY_FOLLOW = new Set(["(", ",", "=", ":", "[", "{", ";", "!", "&", "|", "?", "+"]);

/**
 * Replace every comment with spaces, leaving every other character in place.
 *
 * Three things have to be got right, in the order they bite:
 *
 * - A `//` inside a string is not a comment. `https://` is the one that appears
 *   here, and a scanner that missed it would delete the rest of the line.
 * - A template literal holds `${…}`, and inside those braces the ordinary rules
 *   apply again, so the two states nest rather than alternate.
 * - A `/` may open a regular expression whose body holds a `//`. Which one it is
 *   cannot be decided without a parser, so `REGEX_MAY_FOLLOW` decides it the
 *   conservative way.
 */
export function blankComments(source: string): string {
  const out = [...source];
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  // One frame per nesting level. A template literal pushes a frame in which
  // characters are literal; a `${` inside it pushes a code frame back on top,
  // and that frame counts its own braces so the `}` that closes the expression
  // can be told from a `}` that closes a block inside it.
  const stack: { kind: "code" | "template"; braces: number }[] = [{ kind: "code", braces: 0 }];
  let previous = "";
  let index = 0;

  while (index < source.length) {
    const frame = stack.at(-1)!;
    const character = source[index]!;
    const next = source[index + 1];

    if (frame.kind === "template") {
      if (character === "\\") {
        index += 2;
      } else if (character === "`") {
        stack.pop();
        index += 1;
      } else if (character === "$" && next === "{") {
        stack.push({ kind: "code", braces: 0 });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      index = endOfString(source, index, character);
      previous = character;
      continue;
    }
    if (character === "`") {
      stack.push({ kind: "template", braces: 0 });
      index += 1;
      previous = character;
      continue;
    }
    if (character === "/" && REGEX_MAY_FOLLOW.has(previous)) {
      index = endOfRegex(source, index);
      previous = "/";
      continue;
    }
    if (character === "{") frame.braces += 1;
    if (character === "}") {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop();
        index += 1;
        continue;
      }
      frame.braces -= 1;
    }
    if (!/\s/.test(character)) previous = character;
    index += 1;
  }

  return out.join("");
}

/** The index just past a string literal that opens at `start`. */
function endOfString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index]!;
    // An unterminated string is a syntax error the compiler will report; here
    // it must not run away to the end of the file, so the line ends it.
    if (character === "\n") return index;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return index;
}

/** The index just past a regular expression literal that opens at `start`. */
function endOfRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const character = source[index]!;
    // A regular expression literal cannot span lines, so a newline means the
    // slash was something else and the scan gives the character back.
    if (character === "\n") return start + 1;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) return index + 1;
    index += 1;
  }
  return start + 1;
}

/** The 1-based line a character offset falls on. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * Cut a file into its top-level declarations.
 *
 * A rule about "this function" needs a body to look in, and the alternative to
 * this is a parser the repository does not have: TypeScript 7 ships a compiler,
 * not a compiler API. What makes the split reliable here is the formatter —
 * `oxfmt` puts every top-level `function` and `const` at column zero, so a line
 * that starts one is unambiguous, and a nested declaration is indented and
 * stays with the declaration that contains it.
 */
export type Declaration = {
  readonly name: string;
  readonly exported: boolean;
  /** 1-based line the declaration starts on. */
  readonly line: number;
  /** The declaration's text, comments blanked. */
  readonly body: string;
};

export function topLevelDeclarations(file: SourceFile): Declaration[] {
  const lines = file.code.split("\n");
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      /^(export\s+)?(async\s+)?function\s/.test(line) ||
      /^(export\s+)?const\s+\w+\s*=/.test(line)
    )
      starts.push(index);
  }
  starts.push(lines.length);

  const found: Declaration[] = [];
  for (let position = 0; position < starts.length - 1; position++) {
    const body = lines.slice(starts[position]!, starts[position + 1]!).join("\n");
    const named =
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(body) ??
      /^(?:export\s+)?const\s+(\w+)/.exec(body);
    found.push({
      name: named?.[1] ?? "(anonymous)",
      exported: body.startsWith("export "),
      line: starts[position]! + 1,
      body,
    });
  }
  return found;
}
