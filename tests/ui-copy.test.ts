import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The words the product says, against the rules `web.md` §16 states about them.
 *
 * Two halves of that section are a grep and the guide said so for a release
 * without anybody writing one. The half that is not a grep — whether a message
 * names the *right* next action — is review and stays review.
 *
 * Scoped to string literals, which is where a sentence a person reads comes
 * from. A comment or an identifier saying "invalid" is not copy, and a check
 * that could not tell them apart would be answered by renaming things rather
 * than by fixing them.
 *
 * `src/server` is in scope too, and it should be: `common.md` settles the voice
 * for both surfaces, and a service's refusal is rendered on a screen. Six
 * shipped there — a cursor that "is invalid", staged rows that "must be valid",
 * a setup code the sign-up screen called invalid to somebody who had just copied
 * it out of a log.
 */
const SOURCES = [
  ...globSync("src/client/**/*.{ts,tsx}"),
  ...globSync("src/shared/**/*.ts"),
  ...globSync("src/server/**/*.ts"),
];

/** Every double-quoted literal on a line that is not a comment. */
function literals(source: string) {
  const found: { text: string; line: number }[] = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    for (const match of line.matchAll(/"([^"\\]{2,})"/g)) {
      found.push({ text: match[1]!, line: index + 1 });
    }
  });
  return found;
}

/**
 * Words banned outright, and why each one is.
 *
 * From GOV.UK by way of `common.md`. "Valid" and "invalid" are the two that
 * ship: they describe the rule rather than the input, so a person is told their
 * value failed a check they cannot see instead of what to type. The CSV
 * importer said "Amount has invalid decimal or thousands separators" on the
 * preview screen, which is a sentence about a parser.
 */
const BANNED = /\b(please|sorry|valid|invalid|oops|forbidden|illegal|you forgot)\b/i;

/**
 * Machine words that are spelled like banned ones, named individually.
 *
 * Every one is a wire value or a code, never a sentence, and a blanket skip for
 * "anything short" or "anything upper case" is how a check like this stops
 * meaning anything.
 */
const NOT_COPY = new Set([
  // Three states a staged row can be in, on the wire and in a `<option value>`.
  // The option's own label is "Needs attention", which is the copy.
  "valid",
  "invalid",
  "duplicate",
  // A published `ApiErrorCode`, and a scope-refusal code. Frozen contract.
  "FORBIDDEN",
  "insufficient_scope",
  // A deliberately unusable bearer value, proving an audience-bound JWT is
  // refused. Nobody reads it.
  "invalid-audience-bound-jwt",
]);

/**
 * Two `new Error(...)` messages that are not copy and cannot become copy.
 *
 * Both say the database returned something impossible, both are thrown rather
 * than raised as an `AppError`, and the transport renders any of those as "An
 * unexpected error occurred". Nobody outside a log ever sees the words, so
 * rewriting them would be rewriting a note to whoever is reading the stack.
 */
const FOR_THE_LOG = /new Error\(/;

describe("what the product says", () => {
  it("uses none of the banned words in a sentence a person reads", () => {
    const banned: string[] = [];
    for (const path of SOURCES) {
      for (const { text, line } of literals(readFileSync(path, "utf8"))) {
        if (NOT_COPY.has(text)) continue;
        if (!BANNED.test(text)) continue;
        if (FOR_THE_LOG.test(readFileSync(path, "utf8").split("\n")[line - 1] ?? "")) continue;
        // A className or a route is not copy, and both are string literals.
        if (/^[a-z0-9-]+(\s+[a-z0-9-]+)*$/.test(text) && !text.includes(" ")) continue;
        banned.push(`${path}:${line} "${text.slice(0, 60)}"`);
      }
    }
    expect(banned, "say what to type, not that the value failed a check").toEqual([]);
  });

  /**
   * A button leads with a verb, and four bare verbs are allowed.
   *
   * `Save` is named in the guide as specifically not one of them and shipped
   * twice — a bare `Save` in a dialog with three things in it does not say which
   * one it is about. Literal children only, and the docblock says so: a computed
   * label needs rendering to read, and this is a source scan.
   */
  it("labels every button with a verb phrase or one of the four bare actions", () => {
    const BARE = new Set(["Done", "Close", "Cancel", "OK"]);
    const wrong: string[] = [];
    let checked = 0;
    for (const path of globSync("src/client/**/*.tsx")) {
      const source = readFileSync(path, "utf8");
      // `<Button …>` through to its closing tag, with only text between: a
      // child that is an expression or an element is a computed label.
      for (const match of source.matchAll(/<Button[^>]*>([^<>{}]+)<\/Button>/g)) {
        const label = match[1]!.replaceAll(/\s+/g, " ").trim();
        if (label === "") continue;
        checked += 1;
        if (BARE.has(label)) continue;
        // A verb phrase is two words or more, the first a verb. Checking that
        // the first word is a verb needs a dictionary; checking that there is
        // an object after it is the half that catches the real failure, which
        // is a bare verb saying nothing about what it acts on.
        if (/^[A-Z][a-z]+ \S/.test(label)) continue;
        wrong.push(`${path}: "${label}"`);
      }
    }
    // Twenty of roughly a hundred `<Button>` uses have a literal child; the
    // rest compute their label from state and need rendering to read. That is
    // the scope, and it is the scope because the failure this catches — a bare
    // verb — is one somebody types as a literal.
    expect(checked).toBeGreaterThan(15);
    expect(wrong, "a bare verb is only Done, Close, Cancel or OK").toEqual([]);
  });

  /**
   * One word per concept, in the three bars that act on a selection.
   *
   * The transactions bar said "Mass edit" where the templates and staged bars
   * said "Edit selected", and the templates bar said "Clear" where the other two
   * said "Clear selection" — three spellings for two operations, on three
   * screens a person moves between.
   */
  it("spells a bulk action the same way on every screen", () => {
    const SANCTIONED = ["Edit selected", "Delete selected", "Clear selection", "Commit selected"];
    // A row menu's own Delete is a single-row action and is correctly `Delete`;
    // what is refused is a *bulk* action spelled a fifth way, so the window is
    // the bar rather than the file.
    const DRIFTED = /(Mass edit)|<Button[^>]*>\s*(?:<[^>]+>\s*)?(Clear|Apply|Delete)\s*<\/Button>/;
    const bars: string[] = [];
    for (const path of [
      "src/client/TransactionBrowser.tsx",
      "src/client/pages/TemplatesPage.tsx",
      "src/client/pages/StagingPage.tsx",
    ]) {
      const lines = readFileSync(path, "utf8").split("\n");
      const at = lines.findIndex((line) => line.includes("Delete selected"));
      expect(at, `${path} has no bulk action bar`).toBeGreaterThan(-1);
      const bar = lines.slice(Math.max(0, at - 40), at + 40).join("\n");
      const found = SANCTIONED.filter((one) => bar.includes(one));
      expect(found.length, `${path}'s bar names one action`).toBeGreaterThan(1);
      const drift = DRIFTED.exec(bar);
      if (drift) bars.push(`${path}: ${drift[0].replaceAll(/\s+/g, " ")}`);
    }
    expect(bars, "the four sanctioned strings, and no fifth spelling").toEqual([]);
  });

  /**
   * An eyebrow names a section and never repeats the title.
   *
   * Two pages had `eyebrow="Accounts" title="Accounts"`, which is a line of
   * uppercase text above a heading saying the same word — decoration that reads
   * as structure, and a second thing for a screen reader to announce.
   */
  it("never repeats a page title in its own eyebrow", () => {
    const repeats: string[] = [];
    for (const path of globSync("src/client/**/*.tsx")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/eyebrow="([^"]+)"\s*\n\s*title="([^"]+)"/g)) {
        if (match[1] === match[2]) repeats.push(`${path}: "${match[1]}"`);
      }
    }
    expect(repeats).toEqual([]);
  });
});

/**
 * The two shapes of "there is nothing here", which had come apart.
 *
 * §6.2 records both. A blank cell is an em dash *as a fallback* — `x ? x : "—"`
 * — and one of the seventeen wrote it as literal cell text instead, so a staged
 * row on the transactions list read as having no category while the review
 * queue showed the one it had. And `Uncategorized` was `.subtle` on one page and
 * bare on another, which is one word for one state rendered two ways on two
 * screens a person moves between.
 */
describe("a cell with nothing in it", () => {
  it("writes the dash as a fallback and never as cell text", () => {
    const literal: string[] = [];
    for (const path of globSync("src/client/**/*.tsx")) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          // `<td>—</td>` with nothing else on the line. A dash inside a
          // conditional is the fallback this rule is asking for.
          if (/<td[^>]*>\s*—\s*<\/td>/.test(line)) literal.push(`${path}:${index + 1}`);
        });
    }
    expect(literal, "a dash is what a missing value renders as, not what a cell says").toEqual([]);
  });

  it("styles the uncategorised word the same way wherever it stands as text", () => {
    const bare: string[] = [];
    let styled = 0;
    for (const path of globSync("src/client/**/*.tsx")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/<span([^>]*)>\s*Uncategorized\s*<\/span>/g)) {
        if (match[1]!.includes('className="subtle"')) styled += 1;
        else bare.push(`${path}: <span${match[1]}>`);
      }
    }
    // The two remaining sites are an inline-edit button's own label and its
    // `aria-label`, where the word takes the button's colour by design and is
    // not a span at all. Only text standing on its own is in scope.
    expect(styled).toBeGreaterThan(2);
    expect(bare, "one state, one rendering").toEqual([]);
  });
});

/**
 * The worked sentences, held to the product rather than to a wish.
 *
 * `common.md` publishes a table of "worked sentences, so the voice is not
 * reinvented per site", and six of its thirteen rows named messages that were
 * nowhere in `src`. A table of sentences nobody says is worse than no table: it
 * reads as a reference, so the next person writes a fourteenth message rather
 * than reusing one of the thirteen, and the voice drifts under a document that
 * exists to stop it drifting.
 *
 * So the table now quotes the strings that ship, and this holds it there.
 */
describe("the worked sentences", () => {
  it("are the sentences the product actually says", () => {
    const guide = readFileSync("docs/standards/common.md", "utf8");
    const table = guide.slice(guide.indexOf("| Situation | Message |"));
    const rows = [...table.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|$/gm)]
      .map((match) => [match[1]!.trim(), match[2]!.trim()] as const)
      .filter(([situation]) => situation !== "---");
    // A table that stopped parsing would pass by examining nothing.
    expect(rows.length).toBeGreaterThan(8);
    const source = SOURCES.map((path) => readFileSync(path, "utf8")).join("\n");
    const missing = rows
      .filter(([, message]) => !source.includes(message))
      .map(([situation, message]) => `${situation}: "${message}"`);
    expect(missing, "quote what ships, or ship what is quoted").toEqual([]);
  });
});
