import { describe, expect, it } from "vitest";
import { assembleLedgerFile, type LedgerSnapshot } from "../src/server/services/ledger-file.js";
import type { CounterKind } from "../src/shared/domain.js";
import {
  ledgerFileSelectionSchema,
  parseLedgerFile,
  type LedgerFile,
  type LedgerFileSelection,
} from "../src/shared/ledger-file.js";
import { origin } from "./support/ledger-file.js";

/**
 * The exporter's rules that need no database: which records travel whole,
 * which travel as references, what is dropped, and what a stored value becomes
 * on its way into a file.
 *
 * Driven through `assembleLedgerFile` with a snapshot built by hand, and every
 * case read back through `parseLedgerFile`, because a file the exporter builds
 * and its own reader refuses is a 500 for whoever pressed Export. The figures
 * in a snapshot are whatever the test says they are; that they are the
 * postings' figures is `tests/integration/ledger-file-export.integration.test.ts`.
 */

const USER = "unit-user";
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const stamps = (minute: number) => ({ createdAt: at(minute), updatedAt: at(minute) });

type Snapshot = { -readonly [K in keyof LedgerSnapshot]: LedgerSnapshot[K] };

const account = (n: number, name: string, extra: Record<string, unknown> = {}) =>
  ({
    id: origin(100 + n),
    userId: USER,
    name,
    type: "checking",
    systemKind: null,
    inBudget: true,
    currency: "EUR",
    institution: null,
    notes: null,
    openingDate: "2025-01-01",
    openingBalance: "100.000000000000000000",
    archivedAt: null,
    active: true,
    version: 1,
    ...stamps(n),
    ...extra,
  }) as LedgerSnapshot["accounts"][number];

const category = (n: number, name: string, kind: string, groupId: string | null = null) =>
  ({
    id: origin(200 + n),
    userId: USER,
    name,
    kind,
    groupId,
    archivedAt: null,
    version: 1,
    ...stamps(n),
  }) as LedgerSnapshot["categories"][number];

const group = (n: number, name: string) =>
  ({
    id: origin(300 + n),
    userId: USER,
    name,
    normalizedName: name.toLowerCase(),
    policy: "standalone",
    version: 1,
    ...stamps(n),
  }) as LedgerSnapshot["groups"][number];

const entry = (n: number, fields: Record<string, unknown>) =>
  ({
    id: origin(n),
    userId: USER,
    date: "2026-03-01",
    description: null,
    payee: "Somebody",
    categoryId: null,
    templateId: null,
    importOrigin: null,
    notes: null,
    externalId: null,
    sourceAccountId: null,
    destinationAccountId: null,
    sourceAmount: null,
    destinationAmount: null,
    sourceCurrency: null,
    destinationCurrency: null,
    effectiveRate: null,
    legCount: 0,
    version: 1,
    deletedAt: null,
    ...stamps(n),
    ...fields,
  }) as LedgerSnapshot["entries"][number];

const template = (n: number, name: string, draft: Record<string, unknown>) =>
  ({
    id: origin(400 + n),
    userId: USER,
    name,
    draft,
    version: 1,
    ...stamps(n),
  }) as LedgerSnapshot["templates"][number];

const staged = (n: number, draft: unknown, rawData: unknown = null) =>
  ({
    id: origin(500 + n),
    userId: USER,
    status: "staged",
    draft,
    rawData,
    validationIssues: [],
    duplicateOfId: null,
    duplicateKey: null,
    importBatchId: null,
    committedTransactionId: null,
    recurrenceId: null,
    occurrenceDate: null,
    importOrigin: null,
    version: 1,
    deletedAt: null,
    ...stamps(n),
  }) as LedgerSnapshot["staged"][number];

const recurrence = (n: number, name: string, shape: Record<string, unknown>) =>
  ({
    id: origin(600 + n),
    userId: USER,
    name,
    shape,
    frequency: "monthly",
    interval: 1,
    anchorDate: "2026-01-31",
    monthPolicy: "last_day",
    weekendPolicy: "allow",
    positionOrdinal: null,
    positionWeekday: null,
    proposesFrom: "2026-01-01",
    lastOccurrenceDate: "2026-02-28",
    nextOccurrenceDate: "2026-03-31",
    notifyOnCreate: false,
    version: 1,
    ...stamps(n),
  }) as LedgerSnapshot["recurrences"][number];

const checking = account(1, "Checking");
const savings = account(2, "Savings", { type: "savings" });
const groceries = category(1, "Groceries", "expense", origin(301));
const salary = category(2, "Salary", "income");
const home = group(1, "Home");

function snapshot(fields: Partial<Snapshot> = {}): LedgerSnapshot {
  return {
    today: "2026-10-25",
    throughDate: "2026-10-25",
    preferences: null,
    accounts: [checking, savings],
    balances: null,
    carried: null,
    frozen: new Set(),
    groups: [home],
    categories: [groceries, salary],
    templates: [],
    notifications: new Map(),
    recurrences: [],
    plans: [],
    budgetEntries: [],
    entries: [],
    committedFrom: new Map(),
    legs: new Map(),
    postedSides: new Map(),
    staged: [],
    history: [],
    ...fields,
  };
}

const selection = (input: Record<string, unknown>): LedgerFileSelection =>
  ledgerFileSelectionSchema.parse(input);

/** Assemble, then read back through the format's own reader, failing with its issues. */
function exported(input: Record<string, unknown>, fields: Partial<Snapshot> = {}): LedgerFile {
  const parsed = parseLedgerFile(assembleLedgerFile(selection(input), snapshot(fields), at(0)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues, null, 2));
  return parsed.file;
}

const deposit = entry(1, {
  type: "deposit",
  destinationAccountId: checking.id,
  destinationAmount: "12.500000000000000000",
  categoryId: groceries.id,
});
const transfer = entry(2, {
  type: "transfer",
  sourceAccountId: checking.id,
  destinationAccountId: savings.id,
  sourceAmount: "50",
  destinationAmount: "50",
});

describe("what travels whole and what travels as a reference", () => {
  it("names a record of a kind left out by reference, so the file still resolves", () => {
    const file = exported(
      { kinds: ["entries"] },
      { entries: [deposit, transfer], templates: [template(1, "Coffee", {})] },
    );
    expect(file.accounts.map((it) => [it.key, it.detail])).toEqual([
      ["Checking", "reference"],
      ["Savings", "reference"],
    ]);
    // The category, and the group it sits in, because a reference names its
    // group and that name has to resolve too.
    expect(file.categories).toEqual([
      { key: "Groceries", name: "Groceries", detail: "reference", kind: "expense", group: "Home" },
    ]);
    expect(file.groups).toEqual([
      { key: "Home", name: "Home", detail: "reference", policy: "standalone" },
    ]);
    // Nothing names the template, so nothing carries it.
    expect(file.templates).toEqual([]);
  });

  it("carries only what something names, and nothing it does not", () => {
    const file = exported({ kinds: ["entries"] }, { entries: [transfer] });
    expect(file.categories).toEqual([]);
    expect(file.groups).toEqual([]);
  });

  it("exports every record of a kind that was asked for, whether or not anything names it", () => {
    const file = exported({ kinds: ["accounts", "categories"] });
    expect(file.accounts.map((it) => it.detail)).toEqual(["full", "full"]);
    expect(file.categories.map((it) => [it.key, it.detail])).toEqual([
      ["Groceries", "full"],
      ["Salary", "full"],
    ]);
    expect(file.groups.map((it) => it.detail)).toEqual(["full"]);
  });

  it("keeps a template's provenance on an entry as a reference when templates are left out", () => {
    const coffee = template(1, "Coffee", { payee: "Kiosk" });
    const made = entry(3, {
      type: "withdrawal",
      sourceAccountId: checking.id,
      sourceAmount: "3",
      templateId: coffee.id,
    });
    const file = exported({ kinds: ["entries"] }, { entries: [made], templates: [coffee] });
    expect(file.templates).toEqual([{ key: "Coffee", name: "Coffee", detail: "reference" }]);
    expect(file.entries[0]).toMatchObject({ template: "Coffee" });
  });
});

describe("budgets", () => {
  it("aims each plan and amount at a category or a group by key, and names both by reference", () => {
    const plan = (n: number, fields: Record<string, unknown>) =>
      ({
        id: origin(1000 + n),
        userId: USER,
        categoryId: null,
        groupId: null,
        currency: "EUR",
        periodUnit: "month",
        amount: "400.000000000000000000",
        activeFrom: "2026-01-01",
        activeTo: null,
        rollover: false,
        rolloverCap: null,
        targetAmount: null,
        targetDate: null,
        ruleLookback: null,
        rulePercent: null,
        priority: 0,
        amountRule: "fixed",
        version: 1,
        ...stamps(n),
        ...fields,
      }) as LedgerSnapshot["plans"][number];
    const file = exported(
      { kinds: ["budgets"] },
      {
        plans: [
          plan(1, { categoryId: groceries.id }),
          plan(2, { groupId: home.id, amountRule: "incremental", rulePercent: "3.5000" }),
        ],
        budgetEntries: [
          {
            id: origin(1101),
            userId: USER,
            categoryId: groceries.id,
            groupId: null,
            currency: "EUR",
            periodUnit: "month",
            periodStart: "2026-03-01",
            amount: "550.000000000000000000",
            version: 1,
            ...stamps(3),
          } as LedgerSnapshot["budgetEntries"][number],
        ],
      },
    );
    expect(file.budgets.plans.map((it) => [it.category, it.group, it.amount])).toEqual([
      ["Groceries", undefined, "400"],
      [undefined, "Home", "400"],
    ]);
    // One stored percentage, answering to the name its rule gives it.
    expect(file.budgets.plans[1]).toMatchObject({
      percentOfPrevious: "3.5",
      percentOfIncome: null,
    });
    expect(file.budgets.entries).toEqual([
      {
        category: "Groceries",
        currency: "EUR",
        periodUnit: "month",
        periodStart: "2026-03-01",
        amount: "550",
      },
    ]);
    expect(file.categories.map((it) => [it.key, it.detail])).toEqual([["Groceries", "reference"]]);
    expect(file.groups.map((it) => [it.key, it.detail])).toEqual([["Home", "reference"]]);
  });
});

describe("a file of chosen accounts", () => {
  it("is whole for the accounts chosen and a reference for the far side of a transfer", () => {
    const file = exported(
      { kinds: ["accounts", "categories", "entries"], accountIds: [checking.id] },
      { entries: [deposit, transfer] },
    );
    expect(file.scope.accounts).toBe("chosen");
    expect(file.accounts.map((it) => [it.key, it.detail])).toEqual([
      ["Checking", "full"],
      ["Savings", "reference"],
    ]);
    // Only the categories its entries name, and those whole, with their group.
    expect(file.categories.map((it) => [it.key, it.detail])).toEqual([["Groceries", "full"]]);
    expect(file.groups.map((it) => [it.key, it.detail])).toEqual([["Home", "full"]]);
  });

  it("carries the chosen accounts alone when it is account details only", () => {
    const file = exported(
      { kinds: ["accounts"], accountIds: [savings.id] },
      { entries: [], balances: new Map([[savings.id, "75"]]) },
    );
    expect(file.accounts.map((it) => it.key)).toEqual(["Savings"]);
    expect(file.entries).toEqual([]);
  });
});

describe("the check fields", () => {
  it("writes each whole account's balance from the snapshot, and only beside its entries", () => {
    const balances = new Map([
      [checking.id, "62.5"],
      [savings.id, "150"],
    ]);
    const withEntries = exported({ kinds: ["accounts", "entries"] }, { balances });
    expect(withEntries.accounts.map((it) => (it.detail === "full" ? it.balance : null))).toEqual([
      "62.5",
      "150",
    ]);
    // The read leaves `balances` null when there are no entries to add up to
    // them, and the file then says nothing rather than something unreachable.
    const without = exported({ kinds: ["accounts"] });
    expect(without.accounts.every((it) => it.detail === "full" && it.balance === undefined)).toBe(
      true,
    );
  });

  /**
   * Keyed to the range and not to the opening date. An account opened inside
   * the range can still hold money dated before it — opened today, then filled
   * from last year's statements — and that money is in no entry of the file,
   * so a carry is the only place it can be.
   */
  it("carries a balance forward for every account of a ranged file, whenever it opened", () => {
    const late = account(3, "Late", { openingDate: "2026-02-15" });
    const ranged = { kinds: ["accounts", "entries"], start: "2026-02-01", end: "2026-03-31" };
    const file = exported(ranged, {
      accounts: [checking, late],
      balances: new Map([
        [checking.id, "1"],
        [late.id, "2"],
      ]),
      carried: new Map([
        [checking.id, "87.5"],
        [late.id, "-20"],
      ]),
      throughDate: "2026-03-31",
    });
    const [early, opened] = file.accounts;
    expect(early).toMatchObject({ carriedForward: { date: "2026-02-01", amount: "87.5" } });
    expect(opened).toMatchObject({ carriedForward: { date: "2026-02-01", amount: "-20" } });

    // A snapshot that never read the day before is the exporter's defect, and
    // the reader turns it into one rather than the file quietly carrying zero.
    expect(() => exported(ranged, { accounts: [checking], carried: null })).toThrow(
      /carriedForward/,
    );
    // No range, or a range on the history alone, and nothing is carried: there
    // are no entries starting partway through for a carry to lead into.
    for (const input of [
      { kinds: ["accounts", "entries"] },
      { kinds: ["accounts", "history"], start: "2026-02-01" },
    ]) {
      expect(
        exported(input).accounts.map((it) => it.detail === "full" && it.carriedForward),
      ).toEqual([null, null]);
    }
  });

  it("says an account is in use only while it is live and not frozen", () => {
    const closed = account(3, "Closed", { archivedAt: at(9) });
    const file = exported(
      { kinds: ["accounts"] },
      { accounts: [checking, savings, closed], frozen: new Set([savings.id]) },
    );
    expect(
      file.accounts.map((it) => (it.detail === "full" ? [it.inUse, it.archivedAt] : null)),
    ).toEqual([
      [true, null],
      [false, null],
      [false, at(9).toISOString()],
    ]);
  });

  /**
   * `postedAs` is the one figure the exporter reads off the postings itself, and
   * it is written only where it disagrees with what the categories would say
   * now. A refund filed against spending that was later widened to `both`
   * posted to expense, and a fresh entry against `both` would post to income.
   */
  it("writes the side an entry posted to only where the categories now say otherwise", () => {
    const widened = category(3, "Market", "both");
    const refund = entry(4, {
      type: "deposit",
      destinationAccountId: checking.id,
      destinationAmount: "5",
      categoryId: widened.id,
    });
    const income = entry(5, {
      type: "deposit",
      destinationAccountId: checking.id,
      destinationAmount: "100",
      categoryId: salary.id,
    });
    const sides = new Map<string, CounterKind[]>([
      [refund.id, ["expense"]],
      [income.id, ["income"]],
    ]);
    const file = exported(
      { kinds: ["categories", "entries"] },
      {
        categories: [groceries, salary, widened],
        entries: [refund, income],
        postedSides: sides,
      },
    );
    const byId = new Map(file.entries.map((it) => [it.id, it]));
    expect(byId.get(refund.id)).toMatchObject({ postedAs: "expense" });
    expect(byId.get(income.id)).not.toHaveProperty("postedAs");
  });

  it("writes the actual side where the categories no longer resolve to one at all", () => {
    const split = entry(6, {
      type: "deposit",
      destinationAccountId: checking.id,
      destinationAmount: "10",
      legCount: 2,
    });
    const legs = [
      { id: origin(701), categoryId: groceries.id, amount: "4", note: null, ordinal: 0 },
      { id: origin(702), categoryId: salary.id, amount: "6", note: "most", ordinal: 1 },
    ].map((leg) => ({ ...leg, userId: USER, transactionId: split.id, ...stamps(1) }));
    const file = exported(
      { kinds: ["categories", "entries"] },
      {
        entries: [split],
        legs: new Map([[split.id, legs]]),
        postedSides: new Map([[split.id, ["income"]]]),
      },
    );
    expect(file.entries[0]).toMatchObject({
      postedAs: "income",
      legs: [
        { category: "Groceries", amount: "4" },
        { category: "Salary", amount: "6", note: "most" },
      ],
    });
  });

  it("writes no side for a deleted entry, whose postings net to nothing", () => {
    const voided = entry(7, {
      type: "withdrawal",
      sourceAccountId: checking.id,
      sourceAmount: "9",
      deletedAt: at(30),
    });
    const file = exported(
      { kinds: ["entries", "deletedEntries"] },
      { entries: [voided], postedSides: new Map([[voided.id, ["income"]]]) },
    );
    expect(file.entries[0]).toMatchObject({ deleted: true });
    expect(file.entries[0]).not.toHaveProperty("postedAs");
  });
});

describe("what a stored value becomes", () => {
  it("writes a canonical amount and leaves blanks out", () => {
    const file = exported(
      { kinds: ["entries"] },
      { entries: [{ ...deposit, description: "", notes: null, externalId: "REF-1" }] },
    );
    expect(file.entries[0]).toEqual({
      id: deposit.id,
      type: "deposit",
      date: "2026-03-01",
      to: "Checking",
      amount: "12.5",
      payee: "Somebody",
      category: "Groceries",
      externalId: "REF-1",
    });
  });

  it("gives a name that folds onto an earlier one a key of its own, and names it by that key", () => {
    const twin = account(3, "checking");
    const moved = entry(8, {
      type: "transfer",
      sourceAccountId: checking.id,
      destinationAccountId: twin.id,
      sourceAmount: "1",
      destinationAmount: "1",
    });
    const file = exported(
      { kinds: ["accounts", "entries"] },
      { accounts: [checking, savings, twin], entries: [moved] },
    );
    expect(file.accounts.map((it) => [it.key, it.name])).toEqual([
      ["Checking", "Checking"],
      ["Savings", "Savings"],
      ["checking (2)", "checking"],
    ]);
    expect(file.entries[0]).toMatchObject({ from: "Checking", to: "checking (2)" });
  });

  it("drops a reference a template no longer resolves, and keeps the rest of its draft", () => {
    const stale = template(2, "Rent", {
      type: "withdrawal",
      fromAccountId: origin(999),
      categoryId: origin(998),
      amount: "1200.00",
      legs: undefined,
    });
    const file = exported({ kinds: ["templates"] }, { templates: [stale] });
    expect(file.templates).toEqual([
      {
        key: "Rent",
        name: "Rent",
        detail: "full",
        draft: { type: "withdrawal", amount: "1200.00" },
        notification: null,
      },
    ]);
  });

  it("carries a reminder's rule and the watermark of the last one sent", () => {
    const rent = template(3, "Rent", { payee: "Landlord" });
    const notification = {
      id: origin(801),
      userId: USER,
      templateId: rent.id,
      frequency: "monthly",
      interval: 1,
      anchorDate: "2026-01-01",
      monthPolicy: "last_day",
      weekendPolicy: "allow",
      positionOrdinal: 2,
      positionWeekday: 3,
      notifyAt: "08:30",
      lastNotifiedDate: "2026-10-14",
      nextNotificationDate: "2026-11-11",
      ...stamps(3),
    } as LedgerSnapshot["notifications"] extends ReadonlyMap<string, infer V> ? V : never;
    const file = exported(
      { kinds: ["templates"] },
      { templates: [rent], notifications: new Map([[rent.id, notification]]) },
    );
    expect(file.templates[0]).toMatchObject({
      notification: {
        frequency: "monthly",
        position: { ordinal: 2, weekday: 3 },
        time: "08:30",
        lastNotifiedDate: "2026-10-14",
      },
    });
    expect(file.templates[0]).not.toHaveProperty("notification.nextNotificationDate");
  });

  /**
   * A staged row is allowed to be wrong, and the one wrong thing a file cannot
   * hold is a JSON number where money goes. So a number becomes the text JSON
   * spelled it with, everything else survives as it was, and a uuid that names
   * nothing — or a key the file has no place for — is left behind.
   */
  it("carries a staged row's mistakes, but never a number or a stray uuid", () => {
    const row = staged(
      1,
      {
        type: "transfer",
        date: "20.10.2026",
        payee: "To savings",
        fromAccountId: checking.id,
        toAccountId: origin(997),
        amount: 12.5,
        sourceAmount: "1,00 €",
        categoryId: "not-a-uuid",
        templateId: origin(996),
        legs: [{ id: origin(703), categoryId: groceries.id, amount: 3, extra: true }],
        stray: "kept by the queue, not by the file",
      },
      { Betrag: "12,50" },
    );
    const file = exported({ kinds: ["staged"] }, { staged: [row] });
    expect(file.staged).toEqual([
      {
        id: row.id,
        draft: {
          type: "transfer",
          date: "20.10.2026",
          from: "Checking",
          amount: "12.5",
          sourceAmount: "1,00 €",
          payee: "To savings",
          legs: [{ category: "Groceries", amount: "3" }],
        },
        rawData: { Betrag: "12,50" },
      },
    ]);
    expect(file.accounts).toEqual([
      { key: "Checking", name: "Checking", detail: "reference", type: "checking", currency: "EUR" },
    ]);
  });

  /**
   * An entry that arrived in a Simple Balance file is written out under the
   * origin it arrived with, not the id it was given here, and so is a staged
   * row. Otherwise a ledger moved on a second time would carry new origins,
   * and the copy it started in would take every entry for a new one.
   */
  it("writes the origin an entry or a staged row arrived with, not the id it has here", () => {
    const arrived = { ...deposit, importOrigin: origin(990) };
    const waiting = { ...staged(3, { payee: "Waiting" }), importOrigin: origin(991) };
    const file = exported(
      { kinds: ["entries", "staged"] },
      { entries: [arrived, transfer], staged: [waiting, staged(4, { payee: "Typed" })] },
    );
    expect(file.entries.map((entry) => entry.id)).toEqual([origin(990), transfer.id].sort());
    expect(file.staged.map((row) => row.id)).toEqual([origin(991), origin(504)]);
  });

  /**
   * A row that waited in Staged with no origin was exported under its own id,
   * and committing it gives the entry no origin. The entry is written under
   * the row's id from then on, so a ledger the earlier file went into reads
   * the later one's entry as the one it already has rather than a new one —
   * and an origin of its own still wins over it.
   */
  it("writes an entry committed from an origin-less staged row under the row's id", () => {
    const fromCsv = origin(992);
    const arrived = { ...transfer, importOrigin: origin(993) };
    const file = exported(
      { kinds: ["entries"] },
      {
        entries: [deposit, arrived],
        committedFrom: new Map([
          [deposit.id, fromCsv],
          [arrived.id, origin(994)],
        ]),
      },
    );
    expect(file.entries.map((entry) => entry.id).sort()).toEqual([fromCsv, origin(993)].sort());
  });

  it("drops a staged row's legs when they are not a list of legs", () => {
    const file = exported({ kinds: ["staged"] }, { staged: [staged(2, { legs: [1, 2] })] });
    expect(file.staged[0]!.draft).toEqual({});
  });

  it("leaves out a recurrence whose own account is gone, and nothing it named stays behind", () => {
    const orphan = recurrence(1, "Rent", {
      type: "withdrawal",
      fromAccountId: origin(995),
      payee: "Landlord",
      description: null,
      categoryId: groceries.id,
    });
    const kept = recurrence(2, "Pay", {
      type: "deposit",
      toAccountId: checking.id,
      amount: "3100.00",
      payee: "Employer",
      description: null,
      categoryId: salary.id,
    });
    const file = exported({ kinds: ["recurrences"] }, { recurrences: [orphan, kept] });
    expect(file.recurrences.map((it) => it.key)).toEqual(["Pay"]);
    expect(file.recurrences[0]).toMatchObject({
      shape: { type: "deposit", to: "Checking", category: "Salary", amount: "3100.00" },
      schedule: { frequency: "monthly", anchorDate: "2026-01-31", position: null },
      lastOccurrenceDate: "2026-02-28",
    });
    expect(file.categories.map((it) => it.key)).toEqual(["Salary"]);
  });

  it("keeps the activity history without the owner's id or the agent's", () => {
    const event = {
      id: origin(901),
      userId: USER,
      actorSource: "mcp",
      clientId: "some-agent",
      entityType: "transaction",
      entityId: deposit.id,
      operation: "create",
      before: null,
      after: { userId: USER, payee: "Somebody", rawData: { userId: "a column" } },
      createdAt: at(5),
    } as LedgerSnapshot["history"][number];
    const file = exported({ kinds: ["history"] }, { history: [event] });
    expect(file.history).toEqual([
      {
        createdAt: at(5).toISOString(),
        actorSource: "mcp",
        entityType: "transaction",
        entityId: deposit.id,
        operation: "create",
        before: null,
        after: { payee: "Somebody", rawData: { userId: "a column" } },
      },
    ]);
  });
});
