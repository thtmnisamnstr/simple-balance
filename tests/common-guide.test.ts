import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The two rules in `docs/standards/common.md` that a grep can hold.
 *
 * Both were written because the guide had been saying something false for a
 * release. §Money said a monetary value is a string with "no boundary at which
 * it becomes a number", while a subscription price has been a JavaScript
 * number from Stripe to the screen since billing shipped; and §Naming said a
 * name is the same word on every surface, while `AGENTS.md` requires the paid
 * plan to be `plus` on the wire and **Premium** on screen. Neither sentence was
 * wrong about what it wanted. Both were wrong about what the product does, and
 * a guide that is wrong gets cited anyway.
 *
 * So the carve-outs are written down here as well as argued there, in the shape
 * `tests/service-errors.test.ts` uses for the same job: an exception is a named
 * list with a reason per entry, never a blanket skip, so a sixth site has to be
 * argued for in a diff rather than discovered in a bug report.
 */

/** Stripe's integer count of a currency's smallest unit, as it reaches us. */
const MINOR_UNITS = /\b(?:unitAmount|unit_amount)\b/;

/**
 * Every file allowed to name that integer, and what it is allowed to do.
 *
 * The membership test `common.md` states is that the value never reaches a
 * posting, a balance or a report, is rendered and discarded, and is never
 * summed. Three of these four carry it without touching it; one converts it,
 * once, at the last step before `Intl` formats it.
 */
const PRICE_SITES: { file: string; because: string; converts?: boolean }[] = [
  {
    file: "src/server/stripe.ts",
    because: "Reads `price.unit_amount` off the Stripe object and hands it on unchanged.",
  },
  {
    file: "src/server/services/billing.ts",
    because: "Carries it through the plan summary. No arithmetic, no storage.",
  },
  {
    file: "src/client/api.ts",
    because: "Declares the field's type on the wire. A declaration, not a use.",
  },
  {
    file: "src/client/pages/PlanPage.tsx",
    because: "`formatPrice`, the one converter, which divides and immediately formats.",
    converts: true,
  },
];

/**
 * `formatPrice` and nothing else in the file.
 *
 * Sliced rather than parsed, because what is being asked is narrow: does the
 * division live inside this function. The page is 1,700 lines and every other
 * money figure on it is a decimal string, so a slice that silently grew to the
 * whole file would stop asking anything — hence the assertion that the opening
 * was found at all.
 */
function converter(code: string): string {
  const from = code.indexOf("function formatPrice(");
  expect(from, "formatPrice has been renamed or moved").toBeGreaterThan(-1);
  const to = code.indexOf("\n}", from);
  return code.slice(from, to);
}

describe("money that is not a ledger amount", () => {
  it("is named in four files and converted in one", () => {
    const named = new Set(PRICE_SITES.map((site) => site.file));
    const found = sourceFiles("src")
      .filter((file) => MINOR_UNITS.test(file.code))
      .map((file) => file.path);
    // Both directions. An unnamed file is a fifth site nobody argued for; a
    // named file that no longer mentions it is a reason kept past its subject,
    // which is how a list of exceptions turns into a list of folklore.
    expect(found.filter((file) => !named.has(file))).toEqual([]);
    expect([...named].filter((file) => !found.includes(file))).toEqual([]);
  });

  it("is divided only inside the converter", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      if (!MINOR_UNITS.test(file.code)) continue;
      const site = PRICE_SITES.find((entry) => entry.file === file.path);
      const body = site?.converts ? file.code.replace(converter(file.code), "") : file.code;
      file.code.split("\n").forEach((line, index) => {
        if (!body.includes(line) || !MINOR_UNITS.test(line)) return;
        // An operator on the same line as the identifier. `=` and `:` are how a
        // value is carried; `/`, `*`, `+` and `-` are how it becomes an amount.
        // `| null` is a type union rather than arithmetic, so it goes first.
        const code = line.replace(/\|\s*null/g, "");
        const near =
          /\b(?:unitAmount|unit_amount)\b[^\n]*[/*+-]|[/*+-][^\n]*\b(?:unitAmount|unit_amount)\b/;
        if (near.test(code)) offenders.push(`${file.path}:${index + 1}`);
      });
    }
    expect(offenders, "a price is rendered and discarded, never summed").toEqual([]);
  });

  it("keeps the amount at Stripe, where only its id is configured", () => {
    const config = readFileSync(path.join(repoRoot, "src/server/config.ts"), "utf8");
    // An amount copied into configuration is the one that does not get charged:
    // Stripe charges what the price object says, so a second copy here could
    // only ever be the number the customer was shown and not billed.
    const names = [...config.matchAll(/\bSTRIPE_PRICE_[A-Z_]+\b/g)].map((match) => match[0]);
    expect(new Set(names).size, "the price ids have stopped matching").toBeGreaterThan(1);
    expect(names.filter((name) => !name.endsWith("_ID"))).toEqual([]);
  });
});

/**
 * `common.md` §Money: "A comparison is arithmetic."
 *
 * Four places in the browser decided a figure was zero by comparing its text —
 * `=== "0"` and `!== "0"` on a split's remainder and a category's total — and a
 * fifth decided one was negative by its first character. Each was right only
 * because whatever produced the string happened to write it canonically; "0.00"
 * and "-0" are zero too. The helpers in `src/client/money.ts` are the one place
 * a figure's spelling may be read, because they are what decide it for
 * everybody else.
 */
describe("a comparison of money", () => {
  it("is arithmetic everywhere in the browser but the helpers that do it", () => {
    const BY_SPELLING = /[!=]==?\s*"0"|\.startsWith\("-"\)/;
    const files = sourceFiles("src/client").filter((file) => file.path !== "src/client/money.ts");
    const helpers = files.reduce(
      (count, file) =>
        count + (file.code.match(/\b(isZeroMoney|isNegativeMoney|compareMoney)\(/g) ?? []).length,
      0,
    );
    // The helpers are in use, so this is not passing on a client that stopped
    // comparing money at all.
    expect(helpers).toBeGreaterThan(10);
    const spelled = files.flatMap((file) =>
      file.code
        .split("\n")
        .flatMap((line, index) => (BY_SPELLING.test(line) ? [`${file.path}:${index + 1}`] : [])),
    );
    expect(spelled).toEqual([]);
  });

  /**
   * A figure whose currency is not known is shown bare, through `shownMoney`,
   * and never handed to `formatMoney` with an empty one: that falls through to
   * `${amount} ${currency}` and draws "45.00 ", which is what the Recurring
   * list showed for a recurring transaction whose account had gone.
   */
  it("never formats a figure with an empty currency", () => {
    const BLANK = /formatMoney\([^;]*?(?:\?\?\s*""|,\s*"")\s*\)/;
    const blank = sourceFiles("src/client").flatMap((file) =>
      file.code
        .split("\n")
        .flatMap((line, index) => (BLANK.test(line) ? [`${file.path}:${index + 1}`] : [])),
    );
    expect(blank, "shownMoney says the bare figure where the currency is unknown").toEqual([]);
  });
});

/**
 * `common.md` §Prose: numbers a person reads are formatted.
 *
 * `formatCount` groups thousands, and it was `selectionCount` and only the
 * selection bars asked it: the bar read "4,318" while the dialog it opened
 * read "4318 … will be edited", the notice after it "Deleted 4318", the pages
 * under the list "of 12345", and the import's result counts up to ten
 * thousand were never grouped. So a count shown in JSX or written into a
 * template literal goes through it — named by its shape, a path whose last
 * part is a count or a length.
 */
describe("a count a person reads", () => {
  const COUNTED = /(?:Count|length|^count|^moved|^staged|^total)$/;
  /** Shown, and never a count of anything that reaches four digits. */
  const NOT_A_COUNT: Record<string, string> = {
    "src/client/pages/BudgetsPage.tsx#count":
      "The forecast's period choices, the strings 3, 6, 12 and 24, shown as their own option labels.",
  };

  it("groups its thousands wherever it is shown", () => {
    const shown: string[] = [];
    const excused = new Set<string>();
    for (const file of sourceFiles("src/client")) {
      if (!file.path.endsWith(".tsx")) continue;
      const places = [
        ...file.code.matchAll(/(?<![=\w$])\{([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\}/g),
        ...file.code.matchAll(
          /\$\{\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)(?:\s*\?\?\s*0)?\s*\}/g,
        ),
      ];
      // A value pluralizing the noun after it is a count whatever it is called:
      // `${deletion.value} transaction${deletion.value === 1 ? "" : "s"}` was
      // three confirmations' worth of "4318" that a name alone could not find.
      const pluralized = new Set(
        [
          ...file.code.matchAll(
            /\$\{\s*([A-Za-z_$][\w$.]*)(?:\s*\?\?\s*0)?\s*\}\s+[a-z]+\$\{\s*\1\s*===\s*1/g,
          ),
        ].map((match) => match[1]!),
      );
      for (const place of places) {
        const path = place[1]!;
        if (!COUNTED.test(path.split(".").at(-1)!) && !pluralized.has(path)) continue;
        if (`${file.path}#${path}` in NOT_A_COUNT) {
          excused.add(`${file.path}#${path}`);
          continue;
        }
        shown.push(`${file.path}:${file.code.slice(0, place.index).split("\n").length} ${path}`);
      }
    }
    // Formatted ones are calls and are not read above, so the floor is on the
    // calls: the bars, the notices, the pagination and the import at least.
    const formatted = sourceFiles("src/client").reduce(
      (total, file) => total + (file.code.match(/\bformatCount\(/g) ?? []).length,
      0,
    );
    expect(formatted).toBeGreaterThan(25);
    expect(shown, "write it through formatCount, or name it with why it never groups").toEqual([]);
    expect([...excused].sort(), "the register excuses something the scan no longer finds").toEqual(
      Object.keys(NOT_A_COUNT).sort(),
    );
  });
});

/**
 * The word a person reads, where the wire value is not it.
 *
 * `tests/plan-labels.test.ts` already holds the plan half: no file spells
 * **Premium** by hand. What it cannot see is where the map lives, and that is
 * the half that decides whether the rule is usable. A label in
 * `src/client/pages/PlanPage.tsx` would be correct on screen and unreachable
 * from the mail the scheduler sends and from the descriptions an agent reads,
 * so the next surface to need the word would write it out again — which is the
 * failure the constant exists to prevent, one module along.
 */
describe("a wire value and the word a person reads", () => {
  it("writes the map where every surface can reach it", () => {
    const shared = sourceFiles("src/shared").find((file) => /PLAN_LABELS\s*=/.test(file.code));
    expect(shared?.path, "PLAN_LABELS has left src/shared").toBe("src/shared/domain.ts");
    for (const directory of ["src/client", "src/server"]) {
      const declared = sourceFiles(directory).filter((file) => /PLAN_LABELS\s*=/.test(file.code));
      expect(
        declared.map((file) => file.path),
        "a second map is a second answer",
      ).toEqual([]);
    }
  });

  /**
   * §Prose: sentence case, not Title Case — and a label map is where a word is
   * written once for every screen, so a capital there is a capital everywhere.
   * `accountTypeLabels` read "Credit Card", "Crypto Wallet", "Other Asset" and
   * "Other Liability" in the account-type picker and in every group heading on
   * Accounts and the Overview, beside "Checking" and "Income or expense".
   */
  it("writes every label in a map in sentence case", () => {
    const titled: string[] = [];
    let maps = 0;
    for (const file of sourceFiles("src")) {
      for (const map of file.code.matchAll(
        /\b\w*(?:Labels|_LABELS)\b\s*(?::[^=\n]+)?=\s*\{([^}]*)\}/g,
      )) {
        maps += 1;
        for (const value of map[1]!.matchAll(/:\s*"([^"]+)"/g)) {
          if (/\s[A-Z]/.test(value[1]!)) titled.push(`${file.path} "${value[1]}"`);
        }
      }
    }
    expect(maps, "the scan found none of the six maps common.md names").toBeGreaterThanOrEqual(6);
    expect(titled, "a capital after the first word is Title Case").toEqual([]);
  });
});

/**
 * The em dash, where §Prose scopes it to.
 *
 * The rule used to be "No em dashes" and the sentence after it said the
 * codebase was consistent about that. It was not: 922 lines under `src` carry
 * one, and 50 string literals are whole sentences of prose that use it as
 * punctuation, 45 of them published tool descriptions. So the rule is now
 * scoped to a control's own words, where the alternative to a dash is always
 * available because the words are short.
 *
 * What is grepped is the short half of that scope: a heading, a table header, a
 * label and an accessible name all put their words on the same line as the
 * thing they name. A `<Button>` does not — its words are children, usually a
 * line below — so this catches the regression in the shape it has taken and
 * says so rather than implying it covers the rule. Comments are blanked by
 * `sourceFiles`, which matters here: `src/client/components.tsx` has a docblock
 * about empty states that wraps on a dash, and a check that read it would be
 * answered by rewording a correct comment.
 */
describe("the em dash", () => {
  it("stays out of a heading, a table header and a label", () => {
    const named = /<h[1-6]\b|<th\b|aria-label=|confirmLabel=|\blabel:\s*"/;
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      file.code.split("\n").forEach((line, index) => {
        if (line.includes("—") && named.test(line)) {
          offenders.push(`${file.path}:${index + 1}`);
        }
      });
    }
    expect(offenders, "a dash here stands in for deciding what it says").toEqual([]);
  });
});

/**
 * The glossary's words, against the source that is supposed to use them.
 *
 * §The glossary is the vocabulary the rest of `common.md` is written in, and it
 * was "not checked mechanically" while four nouns the plan work put into tool
 * descriptions, refusals and page copy — plan, entitlement, frozen, and the
 * product's word for an account slot — were missing from it entirely. A
 * glossary cannot settle an argument about a word it does not list.
 *
 * What this can prove is the cheap half and it is worth having: every word the
 * table defines is a word this product's source actually uses, so a row cannot
 * outlive the concept it names or survive its rename. What it cannot prove is
 * that the source uses the word in the table's sense, or that the "Not" column
 * is honest. That half is review, and saying so is better than implying the
 * machine has it covered.
 */
describe("the glossary", () => {
  const guide = readFileSync(path.join(repoRoot, "docs/standards/common.md"), "utf8");
  const table = guide.slice(guide.indexOf("| Word | Means | Not |"));
  const words = [...table.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((match) => match[1]!.trim());

  it("defines words this product says", () => {
    // A table that stopped parsing would pass by examining nothing.
    expect(words.length).toBeGreaterThan(15);
    const source = sourceFiles("src")
      .map((file) => file.text)
      .join("\n");
    const unused = words.filter(
      (word) => !new RegExp(`\\b${word.replace(/[-\s]/g, "[-\\s]")}\\b`, "i").test(source),
    );
    expect(unused, "define what ships, or ship what is defined").toEqual([]);
  });

  it("gives each word one row", () => {
    const seen = words.map((word) => word.toLowerCase());
    expect(seen.filter((word, index) => seen.indexOf(word) !== index)).toEqual([]);
  });
});
