import { describe, expect, it } from "vitest";
import {
  LEDGER_FILE_PART_MAX_BYTES,
  parseLedgerFile,
  splitLedgerFile,
  type LedgerFile,
} from "../src/shared/ledger-file.js";
import {
  MAX_LEDGER_FILE_DECISIONS,
  addDecimalText,
  canonicalDecimalText,
  importOriginsDiffer,
  ledgerAccountInput,
  ledgerAccountOpening,
  ledgerBudgetKey,
  ledgerBudgetPlanKey,
  ledgerCreatedKey,
  ledgerEntryDraft,
  ledgerFileAddInputSchema,
  ledgerFileFactsSchema,
  ledgerFilePlanSchema,
  ledgerFilePreviewInputSchema,
  ledgerFilePreviewSchema,
  ledgerRecurrenceInput,
  ledgerReferenceOpeningDate,
  ledgerStagedDraft,
  ledgerTemplateInput,
  mergeLedgerFileFacts,
  planLedgerFileAdd,
  suggestLedgerRename,
  type LedgerFileDecision,
  type LedgerFileFacts,
  type LedgerFilePlan,
  type LedgerFilePlannedRecord,
  type LedgerRefResolver,
} from "../src/shared/ledger-file-import.js";
import { chosenAccounts, origin, wholeLedger } from "./support/ledger-file.js";
import { ownAccount } from "./support/ledger-file-facts.js";

/**
 * What adding a Simple Balance file does to a ledger that already holds one,
 * decided by one function the page and the server both run.
 *
 * Each rule the owner's decision rests on is asserted here by what the plan
 * says and by the sentence a person reads: a record that is new is created
 * with nothing asked; one already here in the same form is used; one already
 * here in another form waits for a decision nobody makes for them; an account
 * in another currency can never be the same account; a free plan's places are
 * counted and never chosen for anybody; and a guess never overwrites a
 * decision about settings.
 */

type Json = Record<string, unknown>;
type Account = LedgerFile["accounts"][number];

function parsed(json: Json): LedgerFile {
  const result = parseLedgerFile(json);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.file;
}

const whole = () => parsed(wholeLedger());

type Records = Partial<
  Pick<LedgerFile, "groups" | "categories" | "accounts" | "templates" | "recurrences" | "budgets">
>;
type FactsOptions = {
  limit?: number | null;
  preferences?: {
    chosen: boolean;
    timezone: string;
    defaultCurrency: string;
    theme: "system" | "light" | "dark";
  };
  rows?: Partial<LedgerFileFacts["rows"]>;
};

/** A destination holding `records`, each given an id, and settings nobody chose. */
function factsOf(records: Records = {}, options: FactsOptions = {}): LedgerFileFacts {
  let next = 9000;
  const ids = <T extends { key: string }>(list: readonly T[] | undefined) =>
    Object.fromEntries((list ?? []).map((each) => [each.key, origin(next++)]));
  return ledgerFileFactsSchema.parse({
    here: {
      groups: records.groups ?? [],
      categories: records.categories ?? [],
      accounts: records.accounts ?? [],
      templates: records.templates ?? [],
      recurrences: records.recurrences ?? [],
      budgets: records.budgets ?? { plans: [], entries: [] },
      ids: {
        group: ids(records.groups),
        category: ids(records.categories),
        account: ids(records.accounts),
        template: ids(records.templates),
        recurrence: ids(records.recurrences),
      },
      limit: options.limit ?? null,
      preferences: options.preferences ?? {
        chosen: false,
        timezone: "UTC",
        defaultCurrency: "USD",
        theme: "system",
      },
    },
    rows: { alreadyHere: 0, stagedAlreadyHere: 0, ...options.rows },
    move: { qualifies: true, reason: null },
  });
}

/** An account as a destination exports it, with no balance check, since no entries come with it. */
const unchecked = (each: Account): Account => {
  if (each.detail !== "full") return each;
  const { balance: _balance, ...rest } = each;
  return rest;
};

/** The destination as the file's own source would export it: the same records, whole. */
function sameAs(file: LedgerFile, options: FactsOptions = {}): LedgerFileFacts {
  return factsOf(
    {
      groups: file.groups,
      categories: file.categories,
      accounts: file.accounts.map(unchecked),
      templates: file.templates,
      recurrences: file.recurrences,
      budgets: file.budgets,
    },
    options,
  );
}

const record = (plan: LedgerFilePlan, kind: string, key: string): LedgerFilePlannedRecord => {
  const found = plan.records.find((each) => each.kind === kind && each.key === key);
  if (!found) throw new Error(`no ${kind} ${key} in the plan`);
  return found;
};

const plan = (
  file: LedgerFile,
  facts: LedgerFileFacts,
  extra: {
    decisions?: LedgerFileDecision[];
    arriveArchived?: string[];
    preferences?: "file" | "keep";
  } = {},
) => {
  const planned = planLedgerFileAdd({ file, facts, ...extra });
  // Whatever the plan says has to be what the published schema says it is:
  // the preview and the result both carry it, and a tool whose reply does not
  // match its output schema fails the call.
  ledgerFilePlanSchema.parse(planned.plan);
  return planned.plan;
};

/** A copy of one of the file's accounts with some fields changed, as a destination holds it. */
const accountLike = (file: LedgerFile, key: string, change: Json) =>
  unchecked({ ...file.accounts.find((each) => each.key === key)!, ...change } as Account);

describe("records nothing here is like", () => {
  it("are created, with nothing asked", () => {
    const result = plan(whole(), factsOf());
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    // All but the group budget with a priority, which no create accepts and
    // so is left out with the reason rather than refused with the part.
    expect(
      result.records
        .filter((each) => each.outcome !== "create" || each.action !== "create")
        .map((each) => `${each.kind} ${each.key}`),
    ).toEqual(["budget_plan group:Home|EUR|month|2025-01-01"]);
    expect(result.records.every((each) => each.choices.length === 0)).toBe(true);
    const only = (create: number) => ({
      create,
      use: 0,
      skip: 0,
      leave_staged: 0,
      drop: 0,
      refused: 0,
      undecided: 0,
    });
    expect(result.counts).toEqual({
      group: only(1),
      category: only(4),
      account: only(3),
      template: only(2),
      recurrence: only(2),
      budget_plan: { ...only(1), refused: 1 },
      budget_entry: only(1),
    });
  });

  it("arrive in use when only a category was archived where it came from, and say so", () => {
    expect(record(plan(whole(), factsOf()), "category", "Old hobby")).toMatchObject({
      action: "create",
      arrivesArchived: false,
      message:
        "It was archived where it came from. It arrives in use so the transactions filed under it can be committed; archive it again once they are.",
    });
  });

  it("count what the rows will do", () => {
    const result = plan(whole(), factsOf({}, { rows: { alreadyHere: 2, stagedAlreadyHere: 1 } }));
    expect(result.rows).toEqual({
      entries: 6,
      deleted: 1,
      staged: 2,
      alreadyHere: 2,
      stagedAlreadyHere: 1,
      // Five live entries, two already here; two staged rows, one already here.
      toStage: 4,
      postedAsDiffers: 1,
    });
    expect(record(result, "account", "Checking").rows).toBe(7);
    expect(record(result, "account", "Brokerage").rows).toBe(1);
  });
});

describe("a file added to a ledger that already holds every record of it", () => {
  /**
   * The second import of a whole file, or the second part of one: everything
   * it carries is already here in the same form, so nothing is asked and
   * nothing created. This is what lets one set of decisions travel with every
   * part.
   */
  it("uses every record, asks nothing, and creates nothing", () => {
    const file = whole();
    const result = plan(
      file,
      sameAs(file, { preferences: { chosen: true, ...file.preferences! } }),
    );
    expect(result.problems).toEqual([]);
    expect(new Set(result.records.map((each) => each.outcome))).toEqual(new Set(["exists"]));
    expect(new Set(result.records.map((each) => each.action))).toEqual(new Set(["use"]));
    expect(result.preferences.action).toBe("none");
  });

  it("compares amounts by what they are, not by how many zeros they were written with", () => {
    const file = whole();
    const facts = sameAs(file);
    facts.here.accounts = facts.here.accounts.map((each) =>
      each.key === "Checking" ? { ...each, openingBalance: "1520.330000000000000000" } : each,
    );
    expect(record(plan(file, facts), "account", "Checking").outcome).toBe("exists");
  });
});

describe("a record already here in another form", () => {
  const file = whole();
  const facts = () =>
    factsOf({ accounts: [accountLike(file, "Checking", { openingBalance: "99" })] });

  it("waits for a decision nobody makes for the person", () => {
    const result = plan(file, facts());
    expect(record(result, "account", "Checking")).toMatchObject({
      outcome: "duplicate",
      action: "undecided",
      choices: ["use_existing", "skip", "rename"],
      importName: null,
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      field: "decisions",
      kind: "account",
      key: "Checking",
      message:
        "There is already an account called \"Checking\" here, and it differs from the file's in its opening. Here it opens on 2019-01-01 at 99 EUR, and the file's on 2019-01-01 at 1520.33 EUR. Using the one here keeps its own opening, so the 1421.33 EUR more that the file's opens with does not come with it; bringing it in under another name keeps the file's. Choose whether to use the one here, leave the file's out or bring it in under another name.",
    });
  });

  /**
   * What differs is said, because using the one here keeps all of it and the
   * opening is what decides a balance: a different note reads as a different
   * note, and an opening as both openings and what the gap between them does.
   */
  it("says what differs, and what using the one here does to the opening", () => {
    const differs = (change: Json) =>
      record(
        plan(file, factsOf({ accounts: [accountLike(file, "Checking", change)] })),
        "account",
        "Checking",
      ).message;
    expect(differs({ notes: "Joint" })).toBe(
      'There is already an account called "Checking" here, and it differs from the file\'s in its notes.',
    );
    expect(differs({ institution: null, inBudget: false })).toBe(
      'There is already an account called "Checking" here, and it differs from the file\'s in its institution and whether the budget is about the money in it.',
    );
    expect(differs({ openingDate: "2020-03-10", openingBalance: "2000" })).toBe(
      "There is already an account called \"Checking\" here, and it differs from the file's in its opening. Here it opens on 2020-03-10 at 2000 EUR, and the file's on 2019-01-01 at 1520.33 EUR. Using the one here keeps its own opening, which is 479.67 EUR more than the file's; bringing it in under another name keeps the file's.",
    );
    expect(differs({ openingDate: "2020-03-10" })).toContain(
      "Using the one here keeps its own opening day;",
    );
  });

  it("uses the one here when told to", () => {
    const here = facts();
    const result = plan(file, here, {
      decisions: [{ kind: "account", key: "Checking", action: "use_existing" }],
    });
    expect(record(result, "account", "Checking")).toMatchObject({
      action: "use",
      id: here.here.ids.account.Checking,
      importName: "Checking",
    });
    expect(result.ok).toBe(true);
  });

  it("leaves the file's out when told to, and says what needed it", () => {
    const result = plan(file, facts(), {
      decisions: [{ kind: "account", key: "Checking", action: "skip" }],
    });
    expect(record(result, "account", "Checking")).toMatchObject({
      action: "skip",
      importName: null,
    });
    expect(record(result, "recurrence", "Salary")).toMatchObject({
      outcome: "refused",
      action: "refused",
      message: 'Its account "Checking" is not coming in, so it is left out.',
    });
  });

  it("brings it in under another name, which has to be one", () => {
    const named = (name: string) =>
      plan(file, facts(), {
        decisions: [{ kind: "account", key: "Checking", action: "rename", name }],
      });
    expect(record(named("Checking (old bank)"), "account", "Checking")).toMatchObject({
      action: "create",
      importName: "Checking (old bank)",
    });
    expect(named("  CHECKING ").problems).toContainEqual({
      field: "decisions.0.name",
      kind: "account",
      key: "Checking",
      message:
        'A new name for "Checking" has to differ from it once case and spacing are set aside.',
    });
    expect(named("x".repeat(121)).problems[0]!.message).toBe(
      "An account name must be 120 characters or fewer",
    );
  });

  it("refuses a new name something here already has, unless it is the same record", () => {
    const savings = accountLike(file, "Brokerage", { key: "Savings", name: "Savings" });
    const taken = factsOf({
      accounts: [accountLike(file, "Checking", { openingBalance: "99" }), savings],
    });
    expect(
      plan(file, taken, {
        decisions: [{ kind: "account", key: "Checking", action: "rename", name: "savings" }],
      }).problems,
    ).toContainEqual({
      field: "decisions.0.name",
      kind: "account",
      key: "Checking",
      message: 'There is already an account called "Savings" here. Choose another name.',
    });

    // The second part of a file whose first part made the copy: it is here
    // under the new name, the same in every field, and is used.
    const made = accountLike(file, "Checking", {
      key: "Checking (old bank)",
      name: "Checking (old bank)",
    });
    const after = factsOf({
      accounts: [accountLike(file, "Checking", { openingBalance: "99" }), made],
    });
    const second = plan(file, after, {
      decisions: [
        { kind: "account", key: "Checking", action: "rename", name: "Checking (old bank)" },
      ],
    });
    expect(record(second, "account", "Checking")).toMatchObject({
      action: "use",
      id: after.here.ids.account["Checking (old bank)"],
    });
  });

  it("refuses a decision the record does not take", () => {
    const result = plan(file, facts(), {
      decisions: [{ kind: "account", key: "Checking", action: "leave_staged" }],
    });
    expect(result.problems[0]).toMatchObject({ field: "decisions.0.action", key: "Checking" });
  });
});

describe("an account here in another currency", () => {
  it("can never be the file's account, so using it is not offered", () => {
    const file = whole();
    const facts = factsOf({ accounts: [accountLike(file, "Checking", { currency: "USD" })] });
    const result = plan(file, facts, {
      decisions: [{ kind: "account", key: "Checking", action: "use_existing" }],
    });
    expect(record(result, "account", "Checking")).toMatchObject({
      outcome: "duplicate",
      choices: ["skip", "rename"],
      action: "undecided",
      message:
        'There is already an account called "Checking" here, in USD, and the file\'s is in EUR, so the two cannot be one account.',
    });
    expect(result.problems[0]!.message).toBe(
      'The account "Checking" cannot take that decision. Choose whether to leave the file\'s out or bring it in under another name.',
    );
  });
});

describe("a record the file only names", () => {
  const file = () => parsed(chosenAccounts());
  const held = (name: string, currency = "USD"): Account => ({
    key: name,
    name,
    detail: "full",
    type: "investment",
    currency,
    openingDate: "2020-01-01",
    openingBalance: "0",
    inBudget: true,
    archivedAt: null,
    inUse: true,
  });

  it("is used when an account of that name and currency is here", () => {
    const facts = factsOf({ accounts: [held("Brokerage")] });
    expect(record(plan(file(), facts), "account", "Brokerage")).toMatchObject({
      detail: "reference",
      outcome: "exists",
      action: "use",
      id: facts.here.ids.account.Brokerage,
    });
  });

  it("asks what to do when nothing here answers to it", () => {
    const result = plan(file(), factsOf());
    expect(record(result, "account", "Brokerage")).toMatchObject({
      outcome: "missing",
      choices: ["create", "leave_staged"],
      action: "undecided",
    });
    expect(result.problems).toContainEqual({
      field: "decisions",
      kind: "account",
      key: "Brokerage",
      message:
        'This file names an account "Brokerage", which is not here. Choose whether to create it or leave what names it for review in Staged.',
    });
  });

  /**
   * "Use one here" is a dead end where nothing here could be chosen, so it is
   * offered only where something of the kind is here — for an account, in the
   * reference's own currency, the only match the decision accepts.
   */
  it("offers to use one here only where something here could be chosen", () => {
    const choices = (accounts: Account[]) =>
      record(plan(file(), factsOf({ accounts })), "account", "Brokerage").choices;
    expect(choices([held("Euro savings", "EUR")])).toEqual(["create", "leave_staged"]);
    expect(choices([held("Fidelity")])).toEqual(["match", "create", "leave_staged"]);
    expect(
      plan(file(), factsOf({ accounts: [held("Euro savings", "EUR")] }), {
        decisions: [{ kind: "account", key: "Brokerage", action: "match", id: origin(9000) }],
      }).problems[0]!.message,
    ).toBe(
      'The account "Brokerage" cannot take that decision. Choose whether to create it or leave what names it for review in Staged.',
    );
  });

  it("matches only an account in its own currency", () => {
    const facts = factsOf({ accounts: [held("Fidelity"), held("Euro savings", "EUR")] });
    const matched = (id: string) =>
      plan(file(), facts, {
        decisions: [{ kind: "account", key: "Brokerage", action: "match", id }],
      });
    expect(record(matched(facts.here.ids.account.Fidelity!), "account", "Brokerage")).toMatchObject(
      { action: "use", importName: "Fidelity" },
    );
    expect(matched(facts.here.ids.account["Euro savings"]!).problems[0]!.message).toBe(
      '"Euro savings" is in EUR, and the file\'s "Brokerage" is in USD. Choose an account in USD.',
    );
    expect(matched(origin(4242)).problems[0]!.message).toBe("No account here has that id.");
  });

  it("is created at zero on the first day the file names it", () => {
    const result = plan(file(), factsOf(), {
      decisions: [{ kind: "account", key: "Brokerage", action: "create" }],
    });
    expect(record(result, "account", "Brokerage")).toMatchObject({
      action: "create",
      importName: "Brokerage",
      message:
        "This file names an account \"Brokerage\", which is not here. Created from its name alone, it opens at zero on the day of the first transaction naming it, so its balance is only what this file's transactions move. Add a file carrying the account's details first to bring its opening.",
    });
    const brokerage = file().accounts.find((each) => each.key === "Brokerage")!;
    expect(ledgerAccountInput(brokerage, "Brokerage", file())).toEqual({
      name: "Brokerage",
      type: "investment",
      currency: "USD",
      openingDate: "2026-03-03",
      openingBalance: "0",
    });
  });

  it("cannot take a name an account in another currency has, nor be used for it", () => {
    const facts = factsOf({ accounts: [held("Brokerage", "EUR")] });
    expect(record(plan(file(), facts), "account", "Brokerage")).toMatchObject({
      outcome: "missing",
      message:
        'The file\'s account "Brokerage" is in USD, and the one called that here is in EUR, so it cannot be used.',
    });
    expect(
      plan(file(), facts, { decisions: [{ kind: "account", key: "Brokerage", action: "create" }] })
        .problems[0]!.message,
    ).toBe('There is already an account called "Brokerage" here. Choose another name.');
    const renamed = plan(file(), facts, {
      decisions: [{ kind: "account", key: "Brokerage", action: "create", name: "Brokerage (USD)" }],
    });
    expect(record(renamed, "account", "Brokerage")).toMatchObject({
      action: "create",
      importName: "Brokerage (USD)",
    });
  });

  it("can be left for review", () => {
    const result = plan(file(), factsOf(), {
      decisions: [{ kind: "account", key: "Brokerage", action: "leave_staged" }],
    });
    expect(record(result, "account", "Brokerage").action).toBe("leave_staged");
    expect(result.ok).toBe(true);
  });

  it("is used, and the difference said, when a category of that name takes another kind here", () => {
    const json = chosenAccounts();
    json.scope = {
      ...(json.scope as Json),
      kinds: ["accounts", "entries"],
      start: null,
      end: null,
    };
    json.categories = [
      { key: "Groceries", name: "Groceries", detail: "reference", kind: "expense", group: null },
    ];
    json.accounts = (json.accounts as Json[]).map((each) =>
      each.detail === "full" ? { ...each, carriedForward: null } : each,
    );
    const here = factsOf({
      categories: [
        {
          key: "Groceries",
          name: "groceries",
          detail: "full",
          kind: "income",
          group: null,
          archivedAt: null,
        },
      ],
      accounts: [held("Brokerage")],
    });
    expect(record(plan(parsed(json), here), "category", "Groceries")).toMatchObject({
      outcome: "exists",
      action: "use",
      message:
        '"groceries" takes only income here and only spending where the file came from. Transactions filed under it are posted by the kind it has here.',
    });
  });

  it("drops a template's provenance, asking nothing, when no template here answers", () => {
    const json = wholeLedger();
    const kinds = (json.scope as { kinds: string[] }).kinds;
    json.scope = {
      ...(json.scope as Json),
      kinds: kinds.filter((kind) => kind !== "templates" && kind !== "history"),
    };
    delete json.history;
    json.templates = [{ key: "Coffee", name: "Coffee", detail: "reference" }];
    const result = plan(parsed(json), factsOf());
    expect(record(result, "template", "Coffee")).toMatchObject({
      outcome: "missing",
      action: "drop",
      choices: [],
    });
    expect(result.problems.filter((each) => each.kind === "template")).toEqual([]);
  });
});

describe("a group brought in under another name", () => {
  /**
   * Whether a category is the same as one here depends on what its group
   * became, and the second part of a file has to read the first part's work
   * as the same records, or every later part would stop for decisions the
   * person has already made.
   */
  it("carries its categories with it, and they read as the same on the next part", () => {
    const file = whole();
    const decisions: LedgerFileDecision[] = [
      { kind: "group", key: "Home", action: "rename", name: "Home (moved)" },
    ];
    const before = factsOf({
      groups: [{ key: "Home", name: "Home", detail: "full", policy: "sum_of_children" }],
    });
    const first = plan(file, before, { decisions });
    expect(record(first, "group", "Home")).toMatchObject({
      action: "create",
      importName: "Home (moved)",
    });
    expect(record(first, "category", "Groceries").action).toBe("create");

    const after = factsOf({
      groups: [
        { key: "Home", name: "Home", detail: "full", policy: "sum_of_children" },
        { key: "Home (moved)", name: "Home (moved)", detail: "full", policy: "standalone" },
      ],
      categories: file.categories.map((each) =>
        each.group === "Home" ? { ...each, group: "Home (moved)" } : each,
      ),
    });
    const second = plan(file, after, { decisions });
    expect(record(second, "group", "Home")).toMatchObject({
      action: "use",
      importName: "Home (moved)",
    });
    expect(record(second, "category", "Groceries")).toMatchObject({
      outcome: "exists",
      action: "use",
    });
    expect(
      second.problems.filter((each) => each.kind === "group" || each.kind === "category"),
    ).toEqual([]);
  });

  it("makes a category here in the old group a different one", () => {
    const file = whole();
    const here = factsOf({
      groups: [{ key: "Home", name: "Home", detail: "full", policy: "sum_of_children" }],
      categories: [file.categories.find((each) => each.key === "Groceries")!],
    });
    const result = plan(file, here, {
      decisions: [{ kind: "group", key: "Home", action: "rename", name: "Home (moved)" }],
    });
    expect(record(result, "category", "Groceries").outcome).toBe("duplicate");
  });
});

describe("budgets", () => {
  const file = whole();
  const groceriesPlan = file.budgets.plans[0]!;
  const groceries = file.categories.find((each) => each.key === "Groceries")!;

  it("are left out, with the reason, when what they are about cannot hold one", () => {
    const income = factsOf({ categories: [{ ...groceries, kind: "income" }] });
    const result = plan(file, income, {
      decisions: [{ kind: "category", key: "Groceries", action: "use_existing" }],
    });
    expect(record(result, "budget_plan", ledgerBudgetPlanKey(groceriesPlan))).toMatchObject({
      outcome: "refused",
      action: "refused",
      message:
        '"Groceries" takes only income, which has no spending to budget, so its budget is left out.',
    });
    const skipped = plan(file, factsOf({ categories: [{ ...groceries, kind: "expense" }] }), {
      decisions: [{ kind: "category", key: "Groceries", action: "skip" }],
    });
    expect(record(skipped, "budget_entry", ledgerBudgetKey(file.budgets.entries[0]!)).message).toBe(
      '"Groceries" is not coming in, so its budget amounts are left out.',
    );
    expect(skipped.counts.budget_entry.refused).toBe(1);
    expect(skipped.counts.category.skip).toBe(1);
  });

  it("ask before leaving out a budget that overlaps a different one here", () => {
    const here = sameAs(file);
    here.here.budgets = {
      plans: [{ ...groceriesPlan, amount: "450.00", activeFrom: "2024-06-01" }],
      entries: [],
    };
    const key = ledgerBudgetPlanKey(groceriesPlan);
    expect(record(plan(file, here), "budget_plan", key)).toMatchObject({
      outcome: "duplicate",
      choices: ["skip"],
      action: "undecided",
    });
    const decided = plan(file, here, { decisions: [{ kind: "budget_plan", key, action: "skip" }] });
    expect(record(decided, "budget_plan", key).action).toBe("skip");
  });

  it("decide per-period amounts per budget, and write only the new ones", () => {
    const here = sameAs(file);
    const march = file.budgets.entries[0]!;
    const april = { ...march, periodStart: "2026-04-01", amount: "500" };
    const may = { ...march, periodStart: "2026-05-01", amount: "475" };
    const withMore = { ...file, budgets: { ...file.budgets, entries: [march, april, may] } };
    here.here.budgets = {
      plans: file.budgets.plans,
      entries: [
        { ...march, amount: "600" },
        { ...april, amount: "500.00" },
      ],
    };
    const key = ledgerBudgetKey(march);
    const undecided = plan(withMore, here);
    expect(record(undecided, "budget_entry", key)).toMatchObject({
      outcome: "duplicate",
      periods: { create: 1, exists: 1, conflict: 1 },
      action: "undecided",
    });
    expect(undecided.counts.budget_entry).toMatchObject({ create: 1, use: 1, undecided: 1 });

    expect(record(undecided, "budget_entry", key)).toMatchObject({
      choices: ["use_existing", "skip"],
      message:
        "\"Groceries\" already has different amounts here for 1 of the file's periods, so the file's cannot come in for those. Its 1 new period comes in beside the ones here, unless the file's amounts are all left out.",
    });
    expect(undecided.problems).toContainEqual(
      expect.objectContaining({ kind: "budget_entry", key, conflict: 1 }),
    );
    expect(undecided.problems.find((each) => each.kind === "budget_entry")!.message).toContain(
      "Choose whether to keep the amounts here and add the new ones or leave all of the file's amounts out.",
    );

    // Keeping the ones here brings the new period and nothing that differs.
    const kept = planLedgerFileAdd({
      file: withMore,
      facts: here,
      decisions: [{ kind: "budget_entry", key, action: "use_existing" }],
    });
    expect(record(kept.plan, "budget_entry", key).action).toBe("create");
    expect(kept.plan.counts.budget_entry).toMatchObject({ create: 1, use: 1, skip: 1 });
    expect([march, april, may].map((entry) => kept.budgetEntryAction(entry))).toEqual([
      "skip",
      "skip",
      "create",
    ]);

    // Leaving them out leaves every one out, the new period too.
    const left = planLedgerFileAdd({
      file: withMore,
      facts: here,
      decisions: [{ kind: "budget_entry", key, action: "skip" }],
    });
    expect(record(left.plan, "budget_entry", key).action).toBe("skip");
    expect(left.plan.counts.budget_entry).toMatchObject({ create: 0, use: 1, skip: 2 });
    expect([march, april, may].map((entry) => left.budgetEntryAction(entry))).toEqual([
      "skip",
      "skip",
      "skip",
    ]);
  });

  it("ask one thing to acknowledge when a budget's amounts bring nothing new", () => {
    const here = sameAs(file);
    const march = file.budgets.entries[0]!;
    here.here.budgets = { plans: file.budgets.plans, entries: [{ ...march, amount: "600" }] };
    const key = ledgerBudgetKey(march);
    expect(record(plan(file, here), "budget_entry", key)).toMatchObject({
      choices: ["skip"],
      message:
        "\"Groceries\" already has different amounts here for 1 of the file's periods, so the file's cannot come in for those. It has no others, so none of its amounts come in.",
    });
  });

  /**
   * A group's budget cannot carry a priority, and a carry cap means nothing
   * without rollover. The format reads a plan's fields and none of the rules
   * between them, so these are the create's own rules run in the preview —
   * one function with the service — and such a plan is left out with the
   * create's sentence rather than refusing the whole part once it is sent.
   */
  it("are left out, with the create's own sentence, when a create would refuse them", () => {
    const home = file.budgets.plans.find((each) => each.group === "Home")!;
    expect(home.priority).toBe(2);
    expect(record(plan(file, factsOf()), "budget_plan", ledgerBudgetPlanKey(home))).toMatchObject({
      outcome: "refused",
      action: "refused",
      message:
        "It cannot come in as it is: A funding order is about categories. Ranking a group and the categories under it would spend the same income twice, so a group's budget carries no priority.",
    });
    const capped = { ...groceriesPlan, rollover: false };
    const withCap = { ...file, budgets: { ...file.budgets, plans: [capped] } };
    expect(
      record(plan(withCap, factsOf()), "budget_plan", ledgerBudgetPlanKey(capped)).message,
    ).toBe(
      "It cannot come in as it is: A carry cap only means something when rollover is on, and this budget does not carry anything forward.",
    );
  });

  /**
   * One budget's amounts can straddle parts. The part holding the periods
   * that meet different ones here asks; the part holding only new ones meets
   * nothing, and a "leave them all out" the person gave the whole file still
   * has to mean all of them there.
   */
  it("leave every amount out in a part that asks nothing, once told to", () => {
    const march = file.budgets.entries[0]!;
    const key = ledgerBudgetKey(march);
    const left = planLedgerFileAdd({
      file,
      facts: factsOf(),
      decisions: [{ kind: "budget_entry", key, action: "skip" }],
    });
    expect(left.plan.ok).toBe(true);
    expect(left.budgetEntryAction(march)).toBe("skip");
    expect(record(left.plan, "budget_entry", key).choices).toEqual([]);
  });
});

describe("a free plan's places", () => {
  /**
   * More accounts in use somewhere else than places here: the person chooses
   * which arrive archived, nothing is chosen for them, and an account archived
   * where it came from costs nothing.
   */
  const file = whole();
  const facts = (inUse: number, limit: number | null = 3) =>
    factsOf(
      {
        accounts: Array.from({ length: inUse }, (_, at): Account => ({
          key: `Here ${at}`,
          name: `Here ${at}`,
          detail: "full",
          type: "checking",
          currency: "EUR",
          openingDate: "2020-01-01",
          openingBalance: "0",
          inBudget: true,
          archivedAt: null,
          inUse: true,
        })),
      },
      { limit },
    );

  it("count the accounts arriving live, and ask for enough of them to arrive archived", () => {
    const result = plan(file, facts(2));
    expect(result.places).toEqual({ limit: 3, inUse: 2, arriving: 2, needed: 1, chosen: 0 });
    expect(result.problems).toContainEqual({
      field: "arriveArchived",
      message:
        "A free plan keeps 3 accounts in use, and this ledger has 2. This file brings 2 more, so choose at least 1 of them to arrive archived — or upgrade under Settings.",
      limit: 3,
      current: 2,
      arriving: 2,
      needed: 1,
      chosen: 0,
    });
    expect(record(result, "account", "Old card")).toMatchObject({
      action: "create",
      arrivesArchived: true,
    });
  });

  it("are satisfied by the person's own choice and nothing else", () => {
    const result = plan(file, facts(2), { arriveArchived: ["Brokerage"] });
    expect(result.ok).toBe(true);
    expect(result.places).toMatchObject({ needed: 1, chosen: 1 });
    expect(record(result, "account", "Brokerage").arrivesArchived).toBe(true);
    expect(record(result, "account", "Checking").arrivesArchived).toBe(false);
  });

  it("say how many are chosen so far when it is not enough", () => {
    expect(plan(file, facts(3), { arriveArchived: ["Checking"] }).problems[0]!.message).toContain(
      "choose at least 2 of them to arrive archived — 1 so far — or upgrade",
    );
  });

  it("ask nothing where nothing limits them", () => {
    expect(plan(file, facts(9, null)).places).toEqual({
      limit: null,
      inUse: 9,
      arriving: 2,
      needed: 0,
      chosen: 0,
    });
  });

  it("refuse an account key the file does not have", () => {
    expect(plan(file, facts(0), { arriveArchived: ["Nowhere"] }).problems).toContainEqual({
      field: "arriveArchived",
      kind: "account",
      key: "Nowhere",
      message: 'No account in this file has the key "Nowhere".',
    });
  });
});

describe("settings", () => {
  const file = whole();
  const mine = { timezone: "America/New_York", defaultCurrency: "USD", theme: "dark" as const };

  it("are applied where nobody here chose any", () => {
    expect(plan(file, factsOf()).preferences).toEqual({
      inFile: true,
      chosenHere: false,
      differs: true,
      action: "apply",
    });
  });

  it("wait for a choice where this copy chose its own and they differ", () => {
    const facts = factsOf({}, { preferences: { chosen: true, ...mine } });
    const result = plan(file, facts);
    expect(result.preferences.action).toBe("undecided");
    expect(result.problems).toContainEqual({
      field: "preferences",
      message:
        "This copy has its own regional settings, and the file's differ. Choose whether to use the file's or keep this copy's.",
    });
    expect(plan(file, facts, { preferences: "file" }).preferences.action).toBe("apply");
    expect(plan(file, facts, { preferences: "keep" }).preferences.action).toBe("keep");
  });

  it("pass over a choice nobody needed to make", () => {
    const facts = factsOf({}, { preferences: { chosen: true, ...file.preferences! } });
    const result = plan(file, facts, { preferences: "keep" });
    expect(result.preferences.action).toBe("none");
    expect(result.ok).toBe(true);
  });
});

describe("decisions", () => {
  const file = whole();

  it("refuse one about a key the file does not have, and a second about one record", () => {
    const result = plan(file, factsOf(), {
      decisions: [
        { kind: "account", key: "Nowhere", action: "skip" },
        { kind: "group", key: "Home", action: "skip" },
        { kind: "group", key: "Home", action: "use_existing" },
      ],
    });
    expect(result.problems).toEqual([
      {
        field: "decisions.2",
        kind: "group",
        key: "Home",
        message:
          'Decide once for each record: there is already a decision about the category group "Home".',
      },
      {
        field: "decisions.0.key",
        kind: "account",
        key: "Nowhere",
        message: 'No account in this file has the key "Nowhere".',
      },
    ]);
  });

  it("pass over one about a record that needs none, which is what every later part sends", () => {
    const result = plan(file, factsOf(), {
      decisions: [{ kind: "account", key: "Checking", action: "rename", name: "Elsewhere" }],
    });
    expect(result.ok).toBe(true);
    expect(record(result, "account", "Checking").importName).toBe("Checking");
  });

  it("refuse two records coming in under one name", () => {
    const here = factsOf({ accounts: [accountLike(file, "Checking", { openingBalance: "1" })] });
    const result = plan(file, here, {
      decisions: [{ kind: "account", key: "Checking", action: "rename", name: "brokerage" }],
    });
    expect(result.problems).toContainEqual({
      field: "decisions",
      kind: "account",
      key: "Brokerage",
      message:
        'Another account in this file is coming in as "Brokerage". Choose another name for "Brokerage".',
    });
  });
});

describe("caps", () => {
  it("refuse more templates than a ledger keeps", () => {
    const many = Array.from({ length: 199 }, (_, at) => ({
      key: `T${at}`,
      name: `T${at}`,
      detail: "full" as const,
      draft: {},
    }));
    // Only moves that work: a new template takes no decision, so the
    // sentence offers no "leave some out", and every number it says is a
    // field beside it.
    expect(plan(whole(), factsOf({ templates: many })).problems).toContainEqual({
      field: "decisions",
      kind: "template",
      message:
        "A ledger keeps at most 200 templates. This one has 199 and the file brings 2 more, so delete at least 1 here first.",
      limit: 200,
      current: 199,
      more: 2,
      over: 1,
    });
    // A skip sent about a template that is not a duplicate is passed over,
    // and the same problem comes back: which is why it is not offered.
    const skipped = plan(whole(), factsOf({ templates: many }), {
      decisions: [{ kind: "template", key: "Rent", action: "skip" }],
    });
    expect(skipped.problems.map((each) => each.message)).toContain(
      "A ledger keeps at most 200 templates. This one has 199 and the file brings 2 more, so delete at least 1 here first.",
    );
  });

  it("offer leaving out only the templates the preview asks about", () => {
    const many = Array.from({ length: 199 }, (_, at) => ({
      key: `T${at}`,
      name: `T${at}`,
      detail: "full" as const,
      draft: {},
    }));
    const rent = { key: "Rent", name: "Rent", detail: "full" as const, draft: { payee: "Other" } };
    const result = plan(whole(), factsOf({ templates: [...many.slice(1), rent] }), {
      decisions: [{ kind: "template", key: "Rent", action: "rename", name: "Rent (file)" }],
    });
    expect(result.problems.find((each) => each.kind === "template")!.message).toBe(
      "A ledger keeps at most 200 templates. This one has 199 and the file brings 2 more, so delete at least 1 here first, or leave out some of the 1 the preview asks about instead of bringing them in under another name.",
    );
  });
});

describe("recurring transactions", () => {
  it("between two accounts this file creates are not taken for a transfer to itself", () => {
    expect(record(plan(whole(), factsOf()), "recurrence", "Savings sweep")).toMatchObject({
      outcome: "create",
      action: "create",
    });
  });

  it("are refused, with the create's own reason, when the rules a create meets refuse them", () => {
    const json = wholeLedger();
    const recurrences = json.recurrences as Json[];
    recurrences[1] = {
      ...recurrences[1],
      shape: { ...(recurrences[1]!.shape as Json), to: "Checking" },
    };
    expect(record(plan(parsed(json), factsOf()), "recurrence", "Savings sweep")).toMatchObject({
      outcome: "refused",
      message: "It cannot come in as it is: Transfer accounts must be different",
    });
  });
});

describe("a file in parts, every part planned with the whole file's decisions", () => {
  /**
   * The splitter puts budget amounts after every entry, so the first parts of
   * a large file carry none. The page asks about a budget whose amounts meet
   * different ones here and sends that answer with every part; a part without
   * the amounts has to pass over it rather than refuse it as a key nobody has.
   */
  it("passes over a decision about budget amounts a part does not carry", () => {
    const json = wholeLedger();
    json.entries = Array.from({ length: 6 }, (_, n) => ({
      id: origin(700 + n),
      type: "withdrawal",
      date: `2026-10-0${n + 1}`,
      from: "Checking",
      amount: "1.00",
      payee: `Shop ${n}`,
    }));
    json.staged = [];
    const file = parsed(json);
    const split = splitLedgerFile(file, { maxRows: 3, maxBytes: LEDGER_FILE_PART_MAX_BYTES });
    if (!split.ok) throw new Error(split.message);
    expect(split.parts.length).toBeGreaterThan(2);
    expect(split.parts[0]!.budgets.entries).toEqual([]);
    const here = sameAs(file);
    here.here.budgets = {
      plans: file.budgets.plans,
      entries: [{ ...file.budgets.entries[0]!, amount: "999" }],
    };
    const key = ledgerBudgetKey(file.budgets.entries[0]!);
    expect(record(plan(file, here), "budget_entry", key).outcome).toBe("duplicate");
    const decisions: LedgerFileDecision[] = [{ kind: "budget_entry", key, action: "skip" }];
    for (const part of split.parts) {
      expect(plan(part, here, { decisions }).problems).toEqual([]);
    }
    // A key no budget has is still refused for every other kind of record.
    expect(
      plan(split.parts[0]!, here, {
        decisions: [{ kind: "account", key: "Nowhere", action: "skip" }],
      }).problems[0]!.message,
    ).toBe('No account in this file has the key "Nowhere".');
  });

  /**
   * An account the file only names is created by the first part, which need
   * not hold the entry that names it: the page works the day out over the
   * whole file and sends it with the decision, and every part opens the
   * account on the day a single part would.
   */
  it("opens an account made from a reference on the whole file's day, whichever part makes it", () => {
    const file = parsed(chosenAccounts());
    const split = splitLedgerFile(file, { maxRows: 1, maxBytes: LEDGER_FILE_PART_MAX_BYTES });
    if (!split.ok) throw new Error(split.message);
    const [first] = split.parts;
    expect(first!.entries.map((entry) => entry.type)).toEqual(["withdrawal"]);
    const brokerage = file.accounts.find((each) => each.key === "Brokerage")!;
    const whole = ledgerReferenceOpeningDate(file, "Brokerage");
    expect(whole).toBe("2026-03-03");
    // On its own, the first part knows no entry naming it, and falls back.
    expect(ledgerAccountInput(brokerage, "Brokerage", first!).openingDate).toBe(first!.throughDate);
    expect(ledgerAccountInput(brokerage, "Brokerage", first!, whole).openingDate).toBe(whole);
    expect(
      plan(first!, factsOf(), {
        decisions: [{ kind: "account", key: "Brokerage", action: "create", openingDate: whole }],
      }).ok,
    ).toBe(true);
  });
});

describe("a record an earlier part made, read back from here", () => {
  /**
   * A template and a recurring transaction filed under a category the file
   * only names, which the person left for review: the write files them by
   * name, so that is the form the next part reads them back in, and it has
   * to read as the same record or every later part asks a question the
   * preview never had.
   */
  it("is the same one when it was filed under a category left for review", () => {
    const json = wholeLedger();
    json.scope = {
      ...(json.scope as Json),
      kinds: ["accounts", "templates", "recurrences"],
      start: null,
      end: null,
    };
    delete json.history;
    json.preferences = null;
    json.groups = [];
    json.categories = [
      { key: "Dining", name: "Dining", detail: "reference", kind: "expense", group: null },
    ];
    json.accounts = (json.accounts as Json[]).filter((each) => each.key === "Checking");
    json.templates = [
      {
        key: "Lunch",
        name: "Lunch",
        detail: "full",
        draft: { type: "withdrawal", from: "Checking", category: "Dining", amount: "12.00" },
        notification: null,
      },
      {
        key: "Split lunch",
        name: "Split lunch",
        detail: "full",
        draft: {
          payee: "Canteen",
          legs: [
            { category: "Dining", amount: "8.00" },
            { categoryName: "Treats", amount: "4.00" },
          ],
        },
        notification: null,
      },
    ];
    const schedule = {
      frequency: "monthly",
      interval: 1,
      anchorDate: "2026-01-05",
      monthPolicy: "last_day",
      weekendPolicy: "allow",
      position: null,
    };
    json.recurrences = [
      {
        key: "Lunch money",
        name: "Lunch money",
        shape: {
          type: "withdrawal",
          from: "Checking",
          amount: "50.00",
          payee: "Canteen",
          category: "Dining",
        },
        schedule,
        notifyOnCreate: false,
        lastOccurrenceDate: null,
      },
    ];
    json.budgets = { plans: [], entries: [] };
    json.entries = [];
    json.staged = [];
    const file = parsed(json);
    const decisions: LedgerFileDecision[] = [
      { kind: "category", key: "Dining", action: "leave_staged" },
    ];
    expect(plan(file, factsOf(), { decisions }).ok).toBe(true);

    // What the first part made, as the destination's own export writes it.
    const here = factsOf({
      accounts: file.accounts.map(unchecked),
      templates: [
        {
          key: "Lunch",
          name: "Lunch",
          detail: "full",
          draft: { type: "withdrawal", from: "Checking", categoryName: "Dining", amount: "12.00" },
          notification: null,
        },
        {
          key: "Split lunch",
          name: "Split lunch",
          detail: "full",
          draft: {
            payee: "Canteen",
            legs: [
              { categoryName: "Dining", amount: "8.00" },
              { categoryName: "Treats", amount: "4.00" },
            ],
          },
          notification: null,
        },
      ],
      recurrences: [
        {
          key: "Lunch money",
          name: "Lunch money",
          shape: {
            type: "withdrawal",
            from: "Checking",
            amount: "50.00",
            payee: "Canteen",
            categoryName: "Dining",
            categoryKind: "expense",
          },
          schedule,
          notifyOnCreate: false,
          lastOccurrenceDate: null,
        },
      ],
    } as Records);
    const again = plan(file, here, { decisions });
    expect(again.problems).toEqual([]);
    for (const [kind, key] of [
      ["template", "Lunch"],
      ["template", "Split lunch"],
      ["recurrence", "Lunch money"],
    ] as const) {
      expect(record(again, kind, key), `${kind} ${key}`).toMatchObject({
        outcome: "exists",
        action: "use",
      });
    }
  });

  /**
   * A record brought in renamed carries no origin, so a resumed import whose
   * decisions are gone finds the copy it made by its fields: the one record
   * here, under another name, that is the same as the file's. Offered as the
   * name to bring it in under, which the planner then reads as that record.
   */
  it("is offered as the copy to use when one record here is the same under another name", () => {
    const file = whole();
    const checking = file.accounts.find((each) => each.key === "Checking")!;
    const copy = { ...unchecked(checking), key: "Checking (2)", name: "Checking (2)" } as Account;
    const facts = factsOf({
      accounts: [accountLike(file, "Checking", { institution: "Another bank" }), copy],
    });
    const asked = record(plan(file, facts), "account", "Checking");
    expect(asked).toMatchObject({
      outcome: "duplicate",
      copy: {
        key: "Checking (2)",
        name: "Checking (2)",
        id: facts.here.ids.account["Checking (2)"],
      },
    });
    const renamed = plan(file, facts, {
      decisions: [{ kind: "account", key: "Checking", action: "rename", name: asked.copy!.name }],
    });
    expect(record(renamed, "account", "Checking")).toMatchObject({
      action: "use",
      id: facts.here.ids.account["Checking (2)"],
    });
    // Two alike are a coincidence, and nobody is steered between them.
    const twice = factsOf({
      accounts: [
        accountLike(file, "Checking", { institution: "Another bank" }),
        copy,
        { ...copy, key: "Checking (3)", name: "Checking (3)" },
      ],
    });
    expect(record(plan(file, twice), "account", "Checking").copy).toBeNull();
  });
});

describe("a group the file only names", () => {
  const file = () => {
    const json = chosenAccounts();
    json.groups = [{ key: "Home", name: "Home", detail: "reference", policy: "standalone" }];
    json.categories = [
      { key: "Groceries", name: "Groceries", detail: "reference", kind: "expense", group: "Home" },
    ];
    json.scope = { ...(json.scope as Json), kinds: ["accounts", "entries"] };
    return parsed(json);
  };

  /**
   * Nothing staged names a group, so there is no review to leave one to:
   * leaving it out is offered instead, and says that its categories come in
   * without a group, which is what the write does.
   */
  it("offers leaving it out, not leaving it for review, and says what that does", () => {
    const facts = factsOf({ accounts: [ownAccount("Brokerage", "USD")] });
    const asked = record(plan(file(), facts), "group", "Home");
    expect(asked).toMatchObject({ choices: ["create", "skip"], action: "undecided" });
    expect(asked.message).toBe(
      'This file names a category group "Home", which is not here. Left out, the categories in it come in without a group.',
    );
    const withGroup = factsOf({
      groups: [{ key: "Rooms", name: "Rooms", detail: "full", policy: "standalone" }],
    });
    expect(record(plan(file(), withGroup), "group", "Home").choices).toEqual([
      "match",
      "create",
      "skip",
    ]);
    expect(
      plan(file(), facts, { decisions: [{ kind: "group", key: "Home", action: "leave_staged" }] })
        .problems[0]!.message,
    ).toBe(
      'The category group "Home" cannot take that decision. Choose whether to create it or leave the file\'s out.',
    );
    const left = planLedgerFileAdd({
      file: file(),
      facts,
      decisions: [
        { kind: "group", key: "Home", action: "skip" },
        { kind: "category", key: "Groceries", action: "create" },
        { kind: "account", key: "Brokerage", action: "leave_staged" },
      ],
    });
    expect(record(left.plan, "group", "Home").action).toBe("skip");
    expect(left.resolve("group", "Home", new Map())).toBeNull();
  });
});

describe("a record waiting on another's question", () => {
  /**
   * An account or a category still being asked about is not one that is not
   * coming, and what depends on it says it waits rather than that it is left
   * out — which would state as settled what the open question decides.
   */
  it("waits rather than being left out while what it needs is undecided", () => {
    const file = whole();
    const facts = factsOf({
      accounts: [accountLike(file, "Checking", { institution: "Another bank" })],
      categories: [
        { ...file.categories.find((each) => each.key === "Groceries")!, kind: "income" },
      ],
    });
    const result = plan(file, facts);
    expect(record(result, "recurrence", "Salary")).toMatchObject({
      action: "undecided",
      choices: [],
      message: 'It waits on what you choose for its account "Checking".',
    });
    expect(result.counts.recurrence).toMatchObject({ undecided: 2, refused: 0 });
    const groceriesPlan = file.budgets.plans[0]!;
    expect(record(result, "budget_plan", ledgerBudgetPlanKey(groceriesPlan))).toMatchObject({
      action: "undecided",
      message: 'It waits on what you choose for "Groceries".',
    });
    expect(record(result, "budget_entry", ledgerBudgetKey(file.budgets.entries[0]!))).toMatchObject(
      { action: "undecided", periods: null },
    );
    expect(result.counts.budget_entry).toMatchObject({ undecided: 1, refused: 0 });
    // Told to leave the account out, it is left out, and says so.
    expect(
      record(
        plan(file, facts, {
          decisions: [
            { kind: "account", key: "Checking", action: "skip" },
            { kind: "category", key: "Groceries", action: "skip" },
          ],
        }),
        "recurrence",
        "Salary",
      ).message,
    ).toBe('Its account "Checking" is not coming in, so it is left out.');
  });
});

describe("money as text", () => {
  it("is written the way the API writes it", () => {
    expect(["12.500", "-0.00", "007", "0.10", "-12", "abc"].map(canonicalDecimalText)).toEqual([
      "12.5",
      "0",
      "7",
      "0.1",
      "-12",
      "abc",
    ]);
  });

  it("adds exactly, where a float would not", () => {
    expect(addDecimalText("0.1", "0.2")).toBe("0.3");
    expect(addDecimalText("-120.50", "100")).toBe("-20.5");
    expect(addDecimalText("0.000000000000000001", "99999999999999999999999999")).toBe(
      "99999999999999999999999999.000000000000000001",
    );
  });
});

describe("an account's opening", () => {
  const checking = (change: Json) =>
    ({ ...(parsed(chosenAccounts()).accounts[0] as Json), ...change }) as Extract<
      Account,
      { detail: "full" }
    >;

  it("is the file's own without a carried-forward balance", () => {
    expect(ledgerAccountOpening(checking({ carriedForward: null }))).toEqual({
      openingDate: "2019-01-01",
      openingBalance: "1520.33",
    });
  });

  it("moves to the range's first day when the account opened before it", () => {
    expect(ledgerAccountOpening(checking({}))).toEqual({
      openingDate: "2026-01-01",
      openingBalance: "3120",
    });
  });

  it("keeps its own day when it opened inside the range, and takes the earlier money with it", () => {
    const opened = (openingDate: string, amount: string) =>
      ledgerAccountOpening(
        checking({
          openingDate,
          openingBalance: "100",
          carriedForward: { date: "2026-01-01", amount },
        }),
      );
    expect(opened("2026-02-01", "-40.5")).toEqual({
      openingDate: "2026-02-01",
      openingBalance: "59.5",
    });
    // The first day counts as inside: the carry is what the account held the
    // day before, so an opening on the first day is not already in it.
    expect(opened("2026-01-01", "7")).toEqual({ openingDate: "2026-01-01", openingBalance: "107" });
  });

  it("of an account created from a reference is the first live row that names it", () => {
    const file = whole();
    expect(ledgerReferenceOpeningDate(file, "Brokerage")).toBe("2026-10-03");
    expect(ledgerReferenceOpeningDate(file, "Checking")).toBe("2026-09-30");
    expect(ledgerReferenceOpeningDate(file, "Nobody")).toBe(file.throughDate);
  });
});

describe("what an entry stages as", () => {
  const ids: Record<string, string> = {
    Checking: origin(801),
    Brokerage: origin(802),
    Groceries: origin(803),
    Household: origin(804),
  };
  const resolve: LedgerRefResolver = (kind, key) => {
    if (kind === "category" && key === "Salary") return { name: "Salary", kind: "income" };
    return ids[key] ? { id: ids[key] } : null;
  };
  const entry = (n: number) => whole().entries.find((each) => each.id === origin(n))!;

  it("is a transfer with both sides and both amounts", () => {
    expect(ledgerEntryDraft(entry(2), resolve)).toEqual({
      type: "transfer",
      date: "2026-10-03",
      payee: "Transfer",
      fromAccountId: origin(801),
      toAccountId: origin(802),
      sourceAmount: "1000.00",
      destinationAmount: "1081.40",
    });
  });

  it("keeps the known side when the other is left for review", () => {
    const left: LedgerRefResolver = (kind, key) =>
      key === "Brokerage" ? null : resolve(kind, key);
    expect(ledgerEntryDraft(entry(2), left)).not.toHaveProperty("toAccountId");
    expect(ledgerEntryDraft(entry(2), left)).toHaveProperty("fromAccountId", origin(801));
  });

  it("files a split's legs, a share filed nowhere included", () => {
    expect(ledgerEntryDraft(entry(3), resolve).legs).toEqual([
      { categoryId: origin(803), amount: "60.00" },
      { categoryId: origin(804), amount: "15.00", note: "bulbs" },
      { categoryId: null, amount: "5.00" },
    ]);
  });

  it("carries a category left for review by name and by the kind to create it as", () => {
    expect(ledgerEntryDraft(entry(6), resolve)).toMatchObject({
      categoryName: "Salary",
      categoryKind: "income",
    });
    expect(ledgerEntryDraft(entry(6), resolve)).not.toHaveProperty("categoryId");
  });

  it("is a staged row's own draft again, with its keys back to ids", () => {
    const [bakery, transfer] = whole().staged;
    expect(ledgerStagedDraft(bakery!, resolve)).toEqual({
      type: "withdrawal",
      date: "2026-10-20",
      fromAccountId: origin(801),
      amount: "12,50 €",
      payee: "Bäckerei Müller",
      categoryName: "Bakery",
      categoryKind: "expense",
    });
    expect(ledgerStagedDraft(transfer!, resolve)).toEqual({
      type: "transfer",
      sourceAmount: "50.00",
      payee: "To savings",
    });
  });
});

describe("templates and recurring transactions as their creates take them", () => {
  const file = whole();
  const ids: Record<string, string> = {
    Checking: origin(801),
    Brokerage: origin(802),
    Groceries: origin(803),
    Household: origin(804),
    Salary: origin(805),
  };
  const resolve: LedgerRefResolver = (_kind, key) => (ids[key] ? { id: ids[key] } : null);

  it("keep the reminder's watermark beside the rule rather than in it", () => {
    const rent = file.templates[0] as Extract<LedgerFile["templates"][number], { detail: "full" }>;
    const built = ledgerTemplateInput(rent, "Rent", resolve);
    expect(built.lastNotifiedDate).toBe("2026-10-01");
    expect(built.input.notification).not.toHaveProperty("lastNotifiedDate");
    expect(built.input.draft).toEqual({
      type: "withdrawal",
      fromAccountId: origin(801),
      categoryId: origin(804),
      amount: "1200.00",
    });
  });

  it("keep the last occurrence beside the recurrence rather than in it", () => {
    const built = ledgerRecurrenceInput(file.recurrences[0]!, "Salary", resolve);
    expect(built.lastOccurrenceDate).toBe("2026-09-30");
    expect(built.input.shape).toMatchObject({
      type: "deposit",
      toAccountId: origin(801),
      categoryId: origin(805),
    });
    expect(built.input.shape).not.toHaveProperty("to");
  });
});

describe("the requests", () => {
  const minimal = {
    ledgerFile: "{}",
    fileName: "simple-balance-2026-10-25.json",
    idempotencyKey: "part-one-key",
  };

  it("take a part and default to the file being one", () => {
    expect(ledgerFileAddInputSchema.parse(minimal)).toEqual({
      ...minimal,
      part: { index: 1, count: 1 },
      decisions: [],
      arriveArchived: [],
    });
  });

  it("refuse what they do not know, a part numbered past its count, and too many decisions", () => {
    expect(ledgerFileAddInputSchema.safeParse({ ...minimal, userId: "x" }).success).toBe(false);
    expect(
      ledgerFileAddInputSchema.safeParse({ ...minimal, part: { index: 3, count: 2 } }).error
        ?.issues[0]?.message,
    ).toBe("A part's number cannot be more than the number of parts");
    const many = Array.from({ length: MAX_LEDGER_FILE_DECISIONS + 1 }, (_, at) => ({
      kind: "account",
      key: `A${at}`,
      action: "skip",
    }));
    expect(ledgerFileAddInputSchema.safeParse({ ...minimal, decisions: many }).success).toBe(false);
    expect(
      ledgerFileAddInputSchema.safeParse({
        ...minimal,
        decisions: [{ kind: "account", key: "A", action: "rename" }],
      }).success,
    ).toBe(false);
  });

  it("refuse a part heavier than a part may be, counted in UTF-8", () => {
    const half = LEDGER_FILE_PART_MAX_BYTES / 2;
    expect(
      ledgerFilePreviewInputSchema.safeParse({ ledgerFile: "é".repeat(half + 1) }).error?.issues[0]
        ?.message,
    ).toBe(
      "One part of a Simple Balance file is at most 16 MiB. A larger file goes in parts, each a file of its own, which the import page cuts for you.",
    );
    expect(ledgerFilePreviewInputSchema.safeParse({ ledgerFile: "é".repeat(half) }).success).toBe(
      true,
    );
  });
});

describe("a file in parts", () => {
  it("previews as one, with the rows of every part added up", () => {
    const one = factsOf(
      {},
      {
        rows: {
          alreadyHere: 3,
          stagedAlreadyHere: 0,
          alreadyHereOn: { Checking: 3 },
          heldHere: { Checking: { entries: 9, fromFile: 2 } },
        },
      },
    );
    const two = factsOf(
      {},
      {
        rows: {
          alreadyHere: 4,
          stagedAlreadyHere: 2,
          alreadyHereOn: { Checking: 1, Savings: 3 },
          heldHere: { Checking: { entries: 9, fromFile: 5 } },
        },
      },
    );
    // What an account here holds is one read of the ledger, and what came
    // from the file is each part's own, added up: 9 held, 7 from this file,
    // so the whole file sees the 2 that came from elsewhere.
    expect(mergeLedgerFileFacts([one, two]).rows).toEqual({
      alreadyHere: 7,
      stagedAlreadyHere: 2,
      deletedAlreadyHere: 0,
      waiting: 0,
      alreadyHereOn: { Checking: 4, Savings: 3 },
      heldHere: { Checking: { entries: 9, fromFile: 7 } },
    });
    expect(mergeLedgerFileFacts([one, two]).here).toBe(one.here);
  });

  it("resolves what a part created by the key the write kept it under", () => {
    const planned = planLedgerFileAdd({ file: whole(), facts: factsOf() });
    const created = new Map([[ledgerCreatedKey("account", "Checking"), origin(777)]]);
    expect(planned.resolve("account", "Checking", created)).toEqual({ id: origin(777) });
    expect(planned.resolve("account", "Brokerage", created)).toBeNull();
  });

  it("carries a preview the published schema accepts", () => {
    const facts = factsOf();
    const preview = {
      ...facts,
      plan: planLedgerFileAdd({ file: whole(), facts }).plan,
      movePlan: planLedgerFileAdd({ file: whole(), facts, mode: "move" }).plan,
    };
    expect(ledgerFilePreviewSchema.parse(preview)).toEqual(preview);
  });
});

describe("small rules", () => {
  it("offers the first free copy name, never one already used", () => {
    expect(suggestLedgerRename("Checking", ["checking (2)", "Savings"])).toBe("Checking (3)");
  });

  it("tells two entries apart by origin only when both have one", () => {
    expect(importOriginsDiffer(origin(1), origin(2))).toBe(true);
    expect(importOriginsDiffer(origin(1), origin(1))).toBe(false);
    expect(importOriginsDiffer(origin(1), null)).toBe(false);
    expect(importOriginsDiffer(undefined, origin(2))).toBe(false);
  });
});
