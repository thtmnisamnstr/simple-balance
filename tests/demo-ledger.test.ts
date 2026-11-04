import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseLedgerFileText,
  serializeLedgerFile,
  type LedgerFile,
} from "../src/shared/ledger-file.js";
import {
  DEMO_LEDGER_PATH,
  demoLedgerMove,
  lastEntryDate,
  monthsBetween,
  rebaseLedgerFile,
  shiftDay,
  shiftLedgerFile,
} from "../scripts/demo-ledger/rebase.mjs";

/**
 * The demo ledger: the one synthetic ledger this repository seeds anything
 * with, kept as an export and moved into the books with its dates brought up
 * to this month. `tests/integration/demo-ledger.integration.test.ts` moves it
 * into a real database; this holds the file and the date arithmetic.
 */
const text = readFileSync(DEMO_LEDGER_PATH, "utf8");

function read(source: string): LedgerFile {
  const parsed = parseLedgerFileText(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.file;
}

const committed = read(text);
const rebased = (today: string, monthsBack = 0) =>
  read(JSON.stringify(rebaseLedgerFile(committed, { today, monthsBack })));

describe("the committed demo ledger", () => {
  it("is a Simple Balance file exactly as this release writes one", () => {
    // Saved through the export and the writer, so a hand edit that changed
    // the layout, or a field the reader no longer takes, shows here.
    expect(serializeLedgerFile(committed)).toBe(text);
  });

  it("ends on a month that was wholly past when it was saved", () => {
    // `save.mjs` refuses anything else, because a copy loaded at the current
    // month has had its later entries dated today.
    expect(monthsBetween(lastEntryDate(committed), committed.throughDate)).toBeGreaterThanOrEqual(
      1,
    );
    expect(committed.entries.every((entry) => entry.date <= committed.throughDate)).toBe(true);
  });

  it("has something on every screen the product kit photographs", () => {
    // Each of these was once an empty state in a marketing picture, or a
    // record kind a design review had nothing to look at for.
    expect(committed.accounts.map((account) => account.currency)).toEqual(
      expect.arrayContaining(["USD", "EUR"]),
    );
    expect(committed.groups.length).toBeGreaterThan(0);
    expect(committed.templates.length).toBeGreaterThan(0);
    expect(committed.recurrences.length).toBeGreaterThan(0);
    expect(committed.staged.length).toBeGreaterThan(0);
    const currencies = new Set(committed.budgets.plans.map((plan) => plan.currency));
    expect([...currencies].sort()).toEqual(["EUR", "USD"]);
    const entries = committed.entries;
    expect(entries.some((entry) => "legs" in entry && entry.legs !== undefined)).toBe(true);
    expect(entries.some((entry) => entry.deleted === true)).toBe(true);
    expect(
      entries.some(
        (entry) => entry.type === "transfer" && entry.sourceAmount !== entry.destinationAmount,
      ),
    ).toBe(true);
  });

  it("carries no settings, so the browser that opens it offers its own zone and currency", () => {
    // A timezone in the file would be the server's "today" for the demo
    // person, and the kit's dates are worked out in the machine's zone.
    expect(committed.preferences).toBeNull();
  });
});

describe("bringing the demo ledger up to this month", () => {
  const today = "2027-03-12";
  const file = rebased(today);

  it("puts the last entry's month on the current one and nothing past today", () => {
    expect(monthsBetween(lastEntryDate(file), today)).toBe(0);
    expect(file.entries.every((entry) => entry.date <= today)).toBe(true);
    expect(file.staged.every((row) => (row.draft.date ?? "") <= today)).toBe(true);
    expect(file.throughDate).toBe(today);
  });

  it("dates an entry the shift puts ahead of today today, and moves every other whole months", () => {
    const months = monthsBetween(lastEntryDate(committed), today);
    const byOrigin = new Map(file.entries.map((entry) => [entry.id, entry.date]));
    for (const entry of committed.entries) {
      const moved = shiftDay(entry.date, months);
      expect(byOrigin.get(entry.id)).toBe(moved > today ? today : moved);
    }
  });

  it("keeps every balance check, since nothing lands after the day they describe", () => {
    expect(file.accounts.map((account) => "balance" in account && account.balance)).toEqual(
      committed.accounts.map((account) => "balance" in account && account.balance),
    );
  });

  it("anchors every recurrence ahead of today, so none photographs as past due", () => {
    for (const recurrence of file.recurrences) {
      expect(recurrence.schedule.anchorDate > today).toBe(true);
    }
  });

  it("starts every budget on the first of a month, as the file's did", () => {
    for (const plan of file.budgets.plans) expect(plan.activeFrom.endsWith("-01")).toBe(true);
  });

  it("comes out the same on the same day, so a second load replays the first", () => {
    expect(demoLedgerMove({ today })).toEqual(demoLedgerMove({ today }));
    expect(demoLedgerMove({ today }).idempotencyKey).not.toBe(
      demoLedgerMove({ today: "2027-03-13" }).idempotencyKey,
    );
  });

  it("clamps nothing a month back, which is the load that may be saved again", () => {
    const kept = rebased(today, 1);
    expect(monthsBetween(lastEntryDate(kept), today)).toBe(1);
    const back = shiftLedgerFile(
      kept,
      -monthsBetween(lastEntryDate(committed), lastEntryDate(kept)),
    );
    expect(back.entries.map((entry) => entry.date)).toEqual(
      committed.entries.map((entry) => entry.date),
    );
  });

  it("refuses a file holding an entry after its own balance checks", () => {
    const future = structuredClone(committed);
    future.entries[0]!.date = "2099-01-01";
    expect(() => rebaseLedgerFile(future, { today })).toThrow(/after the file's balance checks/);
  });
});

describe("moving a day by whole months", () => {
  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2026-10-17", 3, "2027-01-17"],
    ["2026-03-31", -1, "2026-02-28"],
    ["2026-01-05", -13, "2024-12-05"],
  ])("%s moved %i is %s", (day, months, expected) => {
    expect(shiftDay(day, months)).toBe(expected);
  });
});
