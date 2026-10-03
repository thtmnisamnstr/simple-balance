import { globSync, readFileSync } from "node:fs";
import { sourceFiles } from "./support/source.js";
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
/**
 * The text between a `>` and a `<` on one line: what JSX renders as words.
 *
 * `literals` cannot see any of it, and the defect this was written for was
 * exactly there — `<span className="row-note"> (closed)</span>` is a sentence a
 * reader sees and not a string literal anywhere. Mutation-proving the first
 * version of this check is what found that: putting the defect back left it
 * green.
 *
 * Deliberately per line and deliberately crude. A fragment carrying an
 * expression (`{entry.label}`) comes back as the surrounding words with a gap,
 * which is enough for a word check and nothing like enough for a parser. What
 * it must not do is match attribute values, so a `>` inside a tag is not a
 * boundary: a line is only considered once its last `<` is behind its last `>`.
 */
function jsxText(source: string) {
  const found: { text: string; line: number }[] = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    for (const match of line.matchAll(/>([^<>{}"]{2,})</g)) {
      const text = match[1]!.trim();
      if (text) found.push({ text, line: index + 1 });
    }
  });
  return found;
}

/**
 * Legitimate uses of "close", named one at a time.
 *
 * Every one is either a control that dismisses something or the accounting
 * sense of a balance a window closes on, and neither is what `web.md` 7.6 is
 * about. A blanket skip for "anything short" or "anything containing balance"
 * is how a check like this stops meaning anything, so each is here by its
 * exact text.
 */
const CLOSE_IS_NOT_ARCHIVED = new Set([
  // Dismissal: a className, two labels on the navigation drawer's button, and
  // the shared modal's own.
  "mobile-close",
  "Close navigation",
  "Close",
  // The accounting sense. A register and a balance report both state the
  // figure a window closes on, which is a different word from an account
  // having been put away.
  "Closing balance",
  "Closing",
  // Wire values, never sentences: a register posting's origin, and the band a
  // budget's fill lands in.
  "closing",
  "close",
]);

/**
 * The frozen sense, which is a live account refusing writes rather than an
 * archived one.
 *
 * `common.md`'s table draws exactly this distinction — Frozen is "a live
 * account a plan's limit leaves closed to every write", against Archived — so
 * "closed to" is the one phrasing that may carry the word next to the word
 * "account".
 */
const CLOSED_TO = /\bclosed to\b/i;

describe("the word for an account that has been put away", () => {
  /**
   * `web.md` 7.6: **`archived`, never `closed`**, for `ledger_account.archived_at`.
   *
   * The rule's own argument names the page that was breaking it: somebody who
   * archives an account on Accounts and then asks Reports whether it is counted
   * is looking for the word they just used, and Reports said "(closed)" on every
   * archived row, "the ones you have closed" in its empty state and "before they
   * closed" in the note above the table. A shared schema description said
   * "an account you have since closed" to the browser and to every agent at once.
   *
   * 7.6 filed this as one of four grep-shaped rules with no grep. This is the
   * grep. It is narrow on purpose: the word is fine as a control and fine as the
   * accounting sense, so the register above names those rather than the pattern
   * trying to tell senses apart.
   */
  it("is archived, in every sentence a person or an agent reads", () => {
    const offenders: string[] = [];
    for (const path of SOURCES) {
      if (path.startsWith("src/server/")) continue;
      const source = readFileSync(path, "utf8");
      const candidates = [...literals(source), ...jsxText(source)];
      for (const { text, line } of candidates) {
        if (!/\bclos(e|ed|es|ing)\b/i.test(text)) continue;
        if (CLOSE_IS_NOT_ARCHIVED.has(text.trim())) continue;
        if (CLOSED_TO.test(text)) continue;
        offenders.push(`${path}:${line} "${text.trim().slice(0, 70)}"`);
      }
    }
    expect(offenders, "an account that has been put away is archived, never closed").toEqual([]);
  });

  it("has something to check, so a broken pattern cannot pass as a clean sweep", () => {
    // The register itself is the population: if these stop being found, the
    // literal walk above has broken rather than the product having improved.
    const found = SOURCES.filter((path) => !path.startsWith("src/server/")).flatMap((path) =>
      literals(readFileSync(path, "utf8"))
        .map(({ text }) => text)
        .filter((text) => CLOSE_IS_NOT_ARCHIVED.has(text)),
    );
    expect(new Set(found).size, "the register names uses that no longer exist").toBeGreaterThan(4);
  });
});

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

  it("styles the uncategorized word the same way wherever it stands as text", () => {
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
    // `aria-label`, where the word takes the button's color by design and is
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
   * Every page that renders an empty state, and the ones where one message is
   * right listed with the argument.
   *
   * **This was a list of four and it missed two real defects.** It named
   * TransactionBrowser, Staging, Templates and Recurring — the four that were
   * already correct — so Payees told a mistyped search to go and commit a
   * transaction, and Accounts told somebody with every account archived that
   * they had none. A check that enumerates the compliant cases is not a check;
   * it is a record of what somebody had already looked at.
   *
   * The comment that stood here argued that deriving "is this list filtered"
   * would guess wrong, and it was right: `query` matches the `useQuery` import,
   * `search` matches the `location.search` every link carries, `filter` matches
   * `Array.filter`, and `search:` matches an object key. Four attempts, four
   * false positives, three of them pages with no controls at all.
   *
   * So the question is asked of every page and the exceptions are named — the
   * shape `NOT_A_FIELD` and `NOT_A_TOOL` already use here. An entry is a claim
   * that the list cannot be filtered into emptiness, and somebody has to
   * defend it.
   */
  const ONE_SITUATION: Record<string, string> = {
    // A log. Nothing on the page narrows it, so empty means empty.
    "src/client/pages/ActivityPage.tsx#No activity yet": "nothing on the page narrows the log",
    // The queue is the whole population: a reviewed pair leaves it.
    "src/client/pages/DuplicateReviewPage.tsx#No duplicates left to review":
      "no control narrows the queue",
    // One pair, not a list: it empties when the last spelling is kept or
    // dropped, which is a change to the set rather than a view of it.
    "src/client/pages/DuplicateReviewPage.tsx#Nothing repeats this anymore":
      "the pair under review is not a list",
    // Not one `useState` on it. Empty means the ledger has no currencies.
    "src/client/pages/DashboardPage.tsx#Create your first account": "the page has no controls",
    "src/client/pages/DashboardPage.tsx#No spending in this range":
      "the only narrowing is the shared date range",
    "src/client/pages/DashboardPage.tsx#No budget in this range":
      "the only narrowing is the shared date range",
    // A register for one account over the date range every view carries. 12.1
    // excludes that range deliberately: counting it would report every empty
    // account as a filtered one. The two screens are told apart by the opening
    // balance instead, which is the honest test on this list.
    "src/client/pages/AccountDetailPage.tsx#Nothing posted to this account yet":
      "the only narrowing is the shared date range",
    // Every plan this ledger holds. The bar above narrows the report below it,
    // not this table.
    "src/client/pages/BudgetsPage.tsx#No standing budgets yet": "no control narrows the plan list",
    // The two checkboxes beside the period select both ship checked and both
    // only ever ADD rows — archived spending, and categories with no budget —
    // and `includeUnbudgeted` filters a period's rows rather than the periods.
    // So neither can be why the range holds no period, and the message names
    // the one thing that can.
    "src/client/pages/BudgetsPage.tsx#Nothing budgeted in this range":
      "the only narrowing is the shared date range",
    // The one list whose "nothing matches" answer differs per control value
    // rather than being one sentence: it reads the basis select and says what
    // that basis counts and why there is none of it.
    "src/client/pages/BudgetsPage.tsx#Nothing to project yet":
      "the body already names the control, per basis",
    // The groups table, which is its own list beside the categories one. The
    // search box and the archived toggle narrow the categories; nothing on the
    // page narrows groups.
    "src/client/pages/CategoriesPage.tsx#No groups yet": "no control narrows the group list",
    // Three preconditions rather than a list: no account, every account
    // frozen, and no file chosen yet. None of the three can be reached by
    // narrowing anything, because there is nothing to narrow until a file is.
    "src/client/pages/ImportPage.tsx#Create an account first": "a precondition, not a list",
    "src/client/pages/ImportPage.tsx#Every account is frozen": "a precondition, not a list",
    "src/client/pages/ImportPage.tsx#No file yet": "a precondition, not a list",
    // The agents a person has approved. Nothing on the page narrows that set:
    // revoking removes one, which is a change to the set rather than a view
    // of it.
    "src/client/pages/SettingsPage.tsx#Nothing is connected": "no control narrows the agent list",
  };

  /** Everything between a call's parentheses, counted rather than sliced. */
  const callArguments = (source: string, open: string) => {
    const start = source.indexOf(open);
    if (start < 0) return "";
    let depth = 0;
    for (let at = start + open.length - 1; at < source.length; at++) {
      if (source[at] === "(") depth += 1;
      else if (source[at] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(start + open.length, at);
      }
    }
    return "";
  };

  const withEmptyState = sourceFiles("src/client").filter(
    (file) => file.path.endsWith(".tsx") && file.code.includes("<EmptyState"),
  );

  /**
   * One self-closing JSX element, from its `<` to the `/>` that closes it.
   *
   * Counted rather than sliced to the next `/>`, for the reason a sweep over
   * this file met twice: a prop holding an element or a path ends the slice at
   * its own slash, and the rest of the element is then read as though it were
   * not there. So a `/` closes this one only outside every brace and string.
   */
  const jsxElement = (code: string, from: number) => {
    let depth = 0;
    let index = from;
    while (index < code.length) {
      const character = code[index]!;
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === '"' || character === "'" || character === "`") {
        const quote = character;
        index += 1;
        while (index < code.length && code[index] !== quote) {
          if (code[index] === "\\") index += 1;
          index += 1;
        }
      } else if (character === "/" && code[index + 1] === ">" && depth === 0) {
        return code.slice(from, index + 2);
      }
      index += 1;
    }
    return code.slice(from);
  };

  /**
   * The words on the empty screen, which is what names it in the register.
   *
   * The longest string literal in the `title` prop, because a title is often a
   * conditional of two and the expression deciding between them carries
   * literals of its own — the account register's reads `compareMoney(opening,
   * "0")`, and taking the first literal would have keyed that list as `#0`.
   * Keyed by what it says rather than by a line, so moving a list inside its
   * page changes nothing and rewording its headline is a decision somebody
   * sees.
   */
  const titleOf = (element: string) => {
    const at = element.indexOf("title=");
    if (at < 0) return "";
    const start = at + "title=".length;
    if (element[start] === '"') return element.slice(start + 1, element.indexOf('"', start + 1));
    if (element[start] !== "{") return "";
    let depth = 0;
    let index = start;
    while (index < element.length) {
      if (element[index] === "{") depth += 1;
      else if (element[index] === "}" && (depth -= 1) === 0) break;
      index += 1;
    }
    let longest = "";
    for (const literal of element.slice(start + 1, index).matchAll(/"([^"]*)"/g)) {
      if (literal[1]!.length > longest.length) longest = literal[1]!;
    }
    return longest;
  };

  /**
   * Every empty screen in the product, one entry per LIST rather than one per
   * file — which is the whole of what this check was missing.
   *
   * The test that stood here passed a file on `file.code.includes(
   * "emptyScreen(")`, so one list asking the question excused every other list
   * in the same file. `CategoriesPage` renders two: the categories, which ask,
   * and the groups beside them, which do not. `BudgetsPage` renders three and
   * was excused by one line of register. That is the same shape as the defect
   * the register's own entry describes — an opt-out that costs nothing is taken
   * by accident — one level up from the case it already fixed.
   *
   * A list asks the question by using what `emptyScreen` handed back: the names
   * bound off it are read per file, and the element has to mention one. A page
   * that calls it for its other list no longer covers this one.
   */
  const emptyStates = withEmptyState.flatMap((file) => {
    const bound = [...file.code.matchAll(/const\s*\{([^}]*)\}\s*=\s*emptyScreen\(/g)]
      .flatMap((match) => match[1]!.split(",").map((name) => name.trim()))
      .filter(Boolean);
    return [...file.code.matchAll(/<EmptyState\b/g)].map((hit) => {
      const element = jsxElement(file.code, hit.index);
      return {
        key: `${file.path}#${titleOf(element)}`,
        asks: bound.some((name) => new RegExp(`\\b${name}\\b`).test(element)),
      };
    });
  });

  it("is asked of every page that renders one", () => {
    // An empty population passes every claim made over it.
    expect(withEmptyState.length).toBeGreaterThanOrEqual(10);
    expect(withEmptyState.map((file) => file.path)).toContain("src/client/pages/PayeesPage.tsx");
    // And of every list on those pages, which is more lists than pages. A
    // reader that stopped finding elements would report one per file and pass.
    expect(emptyStates.length).toBeGreaterThan(withEmptyState.length);
    expect(emptyStates.filter((state) => state.key.endsWith("#"))).toEqual([]);
  });

  /**
   * Every list asks the same function, or says in one sentence why it has no
   * question to ask.
   *
   * The question is whether the list decides its screen through `emptyScreen`,
   * which is the one place `src/client/list-filters.ts` keeps the rule. A list
   * that renders an empty state and asks nothing is either a defect or an entry
   * above with an argument.
   */
  it("distinguishes nothing-yet from nothing-matching", () => {
    const collapsed = emptyStates
      .filter((state) => !state.asks && !(state.key in ONE_SITUATION))
      .map((state) => state.key);
    expect(collapsed, "ask `emptyScreen`, or name the list above with why not").toEqual([]);
    // An exemption list as long as the population would pass by examining
    // nothing.
    expect(emptyStates.length - Object.keys(ONE_SITUATION).length).toBeGreaterThan(6);
  });

  it("excuses nothing that no longer renders an empty state", () => {
    // A register outlives the code it excuses unless something says so.
    const keys = new Set(emptyStates.map((state) => state.key));
    expect(Object.keys(ONE_SITUATION).filter((key) => !keys.has(key))).toEqual([]);
    // And nothing that has since started asking, which would leave an argument
    // standing for a list that no longer needs one.
    const asking = new Set(emptyStates.filter((state) => state.asks).map((state) => state.key));
    expect(Object.keys(ONE_SITUATION).filter((key) => asking.has(key))).toEqual([]);
  });

  it("decides it from the filters the reader can reach, and not from the row count", () => {
    // Three things may never appear inside an `emptyScreen` call, and each was
    // a shipped defect. The row count is zero either way, so a check on it
    // cannot tell the two screens apart. The date range is carried by every
    // view, so counting it would report an empty ledger as a filtered one. And
    // a `fixed*` prop is the page's own subject — the register passed four of
    // them, which is why a category created a minute ago was told to clear
    // filters that are not on the screen.
    // What this cannot see, said here rather than left for somebody to assume
    // otherwise: it reads the call's own text, so a page that puts its subject
    // behind a named constant passes. The shape it does catch is the one that
    // shipped — four props spelled `fixed*` listed beside the search box.
    const asking = withEmptyState.filter((file) => file.code.includes("emptyScreen("));
    expect(asking.length, "nothing asks, so this examined nothing").toBeGreaterThan(6);
    const wrong: string[] = [];
    for (const file of asking) {
      const args = callArguments(file.code, "emptyScreen(");
      expect(args, `${file.path}: unbalanced emptyScreen call`).not.toBe("");
      if (/\.length/.test(args)) wrong.push(`${file.path}: a row count`);
      if (/\bstart\b|\bend\b/.test(args)) wrong.push(`${file.path}: the date range`);
      if (/fixed[A-Z]/.test(args)) wrong.push(`${file.path}: the page's own subject`);
    }
    expect(wrong).toEqual([]);
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
      "No spending in this range",
      // Guarded at the head of the same chain, like the register: the panel
      // sits inside `summary.data.currencies.map(...)`, a hundred lines below
      // the `summary.error ? null :` that decides whether any of it renders.
      /summary\.error \? null :/,
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
