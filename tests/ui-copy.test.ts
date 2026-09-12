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

/**
 * A list with nothing in it says which kind of nothing.
 *
 * `web.md` 12.1: every list has four states and they are four different
 * screens — loading, empty because nothing exists yet, empty because nothing
 * matches the filter, and error. "No transactions yet" and "No transactions
 * match this view" are different sentences with different next actions, and
 * collapsing them is the most common way a list lies to somebody: the
 * transactions list told a person with an empty ledger to adjust a date range,
 * and the staged queue told somebody who had just imported four hundred rows
 * that nothing was staged.
 *
 * Read from the source, because each of these lists needs a router, a query
 * client and a session to render, and what is under test is that the two
 * screens exist rather than which words they use. The words are held where the
 * list is rendered — `tests/account-register-ui.test.tsx` does it for the
 * register, which is the same rule on a third list.
 */
describe("a filtered list with nothing in it", () => {
  /**
   * The lists that carry a filter and so need two empty screens.
   *
   * Named rather than derived: whether a list is filtered is a fact about the
   * controls above it, and a derivation that guessed would either miss one or
   * demand two screens from a list that cannot be narrowed.
   */
  const FILTERED = [
    "src/client/TransactionBrowser.tsx",
    "src/client/pages/StagingPage.tsx",
    "src/client/pages/TemplatesPage.tsx",
    "src/client/pages/RecurrencesPage.tsx",
  ];

  it("distinguishes nothing-yet from nothing-matching", () => {
    for (const path of FILTERED) {
      const source = readFileSync(path, "utf8");
      const at = source.indexOf("<EmptyState");
      expect(at, `${path} renders no EmptyState`).toBeGreaterThan(-1);
      const element = source.slice(at, at + 900);
      // A conditional title is the shape: one element, two sentences. A literal
      // title is one sentence for two situations, which is the defect.
      expect(element, `${path}'s empty state says one thing for two states`).toMatch(
        /title=\{[^}]*\?/s,
      );
    }
  });

  it("decides it from the filters and not from the row count", () => {
    // The row count is zero either way, so a check on it cannot tell the two
    // apart. The date range is deliberately excluded from what counts as
    // narrowing: every view carries one, so counting it would report an empty
    // ledger as a filtered one — the same defect from the other side.
    for (const path of ["src/client/TransactionBrowser.tsx", "src/client/pages/StagingPage.tsx"]) {
      const source = readFileSync(path, "utf8");
      const narrowed = /const narrowed = Boolean\(([\s\S]*?)\);/.exec(source);
      expect(narrowed, `${path} should decide narrowed from its filters`).not.toBeNull();
      expect(narrowed![1]).not.toContain("length");
      expect(narrowed![1]).not.toMatch(/\bstart\b|\bend\b/);
    }
  });
});

/**
 * The fourth state, which is not a banner above the other three.
 *
 * `web.md` 12.1 asks for four screens — loading, nothing yet, nothing matching,
 * and error — and six lists were showing three of them plus a stripe. React
 * Query's `isPending` is `status === "pending"`, so an errored query is not
 * pending: it fell straight past the loading branch into the empty state, and
 * the page said "No transactions yet" over the top of an alert explaining that
 * it could not tell. Telling somebody their ledger is empty when the truth is
 * that the request failed is the most consequential way a list can lie.
 *
 * Read from the source, because the shape is structural: a list slot that can
 * render an `EmptyState` has to consult the query's `error` somewhere in the
 * same expression. jsdom would need every one of these pages mounted with a
 * failing fetch to see the same thing.
 */
describe("a list whose query failed", () => {
  /**
   * Every list that renders an `EmptyState`, checked at the slot rather than
   * in the file.
   *
   * The first version of this grepped the whole source for the query's `error`,
   * which every one of these pages mentions anyway in the alert above the list
   * — so it passed on all nine and would have passed on all six defects. The
   * guard has to be in the expression that decides the slot, so the window is
   * the text immediately before the `EmptyState` it governs.
   */
  const WINDOW = 700;
  const GUARD = /\b[A-Za-z]*[Ee]rror\b[^;]{0,40}\?/;

  /**
   * Two that the window cannot read, named with what makes each exempt.
   *
   * The register is by the empty state's own title, which is stable, rather
   * than by a line number that drifts with every edit above it.
   */
  const EXEMPT = new Map([
    [
      "Nothing posted to this account yet",
      // Guarded at the head of the same chain rather than beside the slot:
      // `AccountDetailPage.tsx:157` is `register.error ? <Alert> : …`, and the
      // register's table sits ninety lines below it inside that same ternary.
      /register\.error \?/,
    ],
    [
      "No file yet",
      // No query behind it. This is the CSV preview before a file is chosen —
      // local state, not a request that can fail, so there is no error for it
      // to be behind.
      /const \[csv, setCsv\]|setCsv\(/,
    ],
  ]);

  /**
   * `DuplicateReviewPage` is the one that cannot be read this way: its empty
   * state is a `caughtUp` constant defined far above, and the guard sits at the
   * two use sites. Named, and its shape asserted directly.
   */
  const AT_THE_USE_SITE = "src/client/pages/DuplicateReviewPage.tsx";

  it("shows the failure instead of claiming there is nothing", () => {
    const unguarded: string[] = [];
    let checked = 0;
    for (const path of globSync("src/client/**/*.tsx")) {
      if (path === AT_THE_USE_SITE) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/<EmptyState/g)) {
        const before = source.slice(Math.max(0, match.index - WINDOW), match.index);
        const after = source.slice(match.index, match.index + WINDOW);
        checked += 1;
        const exemption = [...EXEMPT].find(([title]) => after.includes(`"${title}"`));
        if (exemption) {
          // The exemption is only good while the reason for it still holds.
          expect(source, `${path} no longer matches its exemption`).toMatch(exemption[1]);
          continue;
        }
        if (!GUARD.test(before)) {
          unguarded.push(`${path}:${source.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(unguarded, "the empty state has to be behind the error, not beside it").toEqual([]);
    expect(checked, "no empty states found, so this examined nothing").toBeGreaterThan(8);
  });

  it("puts the duplicate queue's finished screen behind its error too", () => {
    const source = readFileSync(AT_THE_USE_SITE, "utf8");
    // One or the other, never both: "No duplicates left to review" is the one
    // screen that says somebody is finished, and it was printed over an alert
    // saying the queue could not be read.
    expect(source).toMatch(/error \? <Alert>\{error\.message\}<\/Alert> : caughtUp/);
    expect(source).not.toMatch(
      /\{error \? <Alert>\{error\.message\}<\/Alert> : null\}\s*\{caughtUp\}/,
    );
  });
});
