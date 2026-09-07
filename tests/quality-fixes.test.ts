import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { compareMoney, formatDate, moneyUnits } from "../src/client/money.js";
import { bulkStageFilterSchema, stageListQuerySchema } from "../src/shared/domain.js";

/**
 * A balance is a decimal string carrying up to eighteen fractional digits, which
 * is more than a float can hold. Sorted through Number, two balances that differ
 * only in the last of those digits compare equal and settle into whatever order
 * they arrived in.
 */
describe("ordering money", () => {
  it("separates values a float cannot tell apart", () => {
    const a = "1000000000000.000000000000000001";
    const b = "1000000000000.000000000000000002";
    expect(Number(a) === Number(b)).toBe(true);
    expect(compareMoney(a, b)).toBe(-1);
    expect(compareMoney(b, a)).toBe(1);
  });

  it("orders across different numbers of decimal places", () => {
    expect(compareMoney("1.5", "1.45")).toBe(1);
    expect(compareMoney("2", "1.999999")).toBe(1);
    expect(compareMoney("0.9", "1")).toBe(-1);
    expect(compareMoney("5.00", "5")).toBe(0);
  });

  // A credit card or a loan holds a negative balance, so the comparator has to
  // read the sign rather than only the digits.
  it("puts what is owed below what is held", () => {
    expect(compareMoney("-300.00", "0")).toBe(-1);
    expect(compareMoney("-300.00", "-400.00")).toBe(1);
    expect(moneyUnits("-1.5")).toBe(-1_500_000_000_000_000_000n);
  });

  it("sorts what it cannot read last rather than throwing", () => {
    expect(compareMoney("banana", "1.00")).toBe(1);
    expect(compareMoney("1.00", "banana")).toBe(-1);
    expect(moneyUnits("banana")).toBeNull();
  });
});

/**
 * A staged row is allowed to hold whatever a CSV put in its date column, and
 * `Intl.DateTimeFormat` throws a RangeError on a date it cannot read. Thrown
 * during a render that unmounts the tree, which is a white page rather than a
 * badly formatted cell.
 */
describe("showing a date that may not be one", () => {
  it("formats a real date", () => {
    expect(formatDate("2026-08-04")).toMatch(/2026/);
  });

  it("shows what it was given rather than throwing", () => {
    for (const value of ["banana", "", "31/12/2026", "2026-13-45"]) {
      expect(() => formatDate(value)).not.toThrow();
    }
    expect(formatDate("banana")).toBe("banana");
    expect(formatDate("31/12/2026")).toBe("31/12/2026");
  });
});

/**
 * A filter a write path accepts and does not apply is worse than one it refuses:
 * the preview count and the fingerprint agree with the caller, and the edit then
 * covers every row rather than the ones asked for.
 */
describe("what a staged bulk selection may filter on", () => {
  it("refuses fields the staged predicates do not apply", () => {
    for (const field of ["currency", "includeDeleted"] as const) {
      const result = bulkStageFilterSchema.safeParse({ [field]: "USD" });
      expect(result.success, `${field} must be refused`).toBe(false);
    }
  });

  it("still accepts every field it does apply", () => {
    const result = bulkStageFilterSchema.safeParse({
      search: "shop",
      accountId: "11111111-1111-4111-8111-111111111111",
      categoryId: "22222222-2222-4222-8222-222222222222",
      type: "withdrawal",
      payee: "Corner Shop",
      start: "2026-01-01",
      end: "2026-12-31",
      validity: "invalid",
      importBatchId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.success).toBe(true);
  });

  // The read-only listing keeps them, because ignoring a filter on a list only
  // shows more rows than asked for. It is carrying them into a write that made
  // it dangerous.
  it("leaves the read-only listing alone", () => {
    expect(stageListQuerySchema.safeParse({ currency: "USD" }).success).toBe(true);
  });
});

/**
 * A filter selection resolves twice, once for the count and fingerprint the
 * person is shown and once for the write, and both go through one predicate.
 * A key the schema accepts but the predicate does not implement therefore
 * widens the write silently: the fingerprint agrees, because it described the
 * same wrong set. This keeps the two definitions of "the rows you are looking
 * at" from drifting apart.
 */
describe("every staged filter the schema accepts is one the query applies", () => {
  it("implements each key", async () => {
    const accepted = Object.keys(bulkStageFilterSchema.shape).sort();
    const source = await readFile(
      new URL("../src/server/services/staging.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("export function stageFilterConditions"),
      source.indexOf("export async function listStages"),
    );
    const applied = new Set([...body.matchAll(/query\.([A-Za-z]+)/g)].map((match) => match[1]!));
    const ignored = accepted.filter((key) => !applied.has(key));
    expect(ignored, `accepted but never applied: ${ignored.join(", ")}`).toEqual([]);
  });

  // The list query is the same predicate with paging and ordering on top, so a
  // filter it accepts and the predicate ignores is the same silent no-op.
  it("offers no staged listing filter the query ignores", async () => {
    const presentation = new Set(["cursor", "page", "limit", "sort", "direction"]);
    const accepted = Object.keys(stageListQuerySchema.shape).filter(
      (key) => !presentation.has(key),
    );
    const source = await readFile(
      new URL("../src/server/services/staging.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("export function stageFilterConditions"),
      source.indexOf("export async function listStages"),
    );
    const applied = new Set([...body.matchAll(/query\.([A-Za-z]+)/g)].map((match) => match[1]!));
    const ignored = accepted.filter((key) => !applied.has(key));
    expect(ignored, `accepted but never applied: ${ignored.join(", ")}`).toEqual([]);
  });
});

/**
 * And the same rule on the server, where a float would reach the books.
 *
 * `services.md` section 3.3 is **Binding** — `AGENTS.md`'s "Never represent
 * money with JavaScript/JSON floating-point numbers" — and it was the one
 * Binding rule in that guide with no mechanism named. A money value's whole life
 * on the server is `numeric(44,18)` in, `decimal()` through, canonical decimal
 * string out, and no stage in between is a `number`.
 *
 * Refusing `Number(` outright is the wrong rule and the first run proved it: six
 * of the six sites in the services are counts — periods, entries, staged rows —
 * and a count is a number. What has to be refused is `Number(` reaching a value
 * whose *name* is money, which is the vocabulary this codebase actually uses for
 * one. A count passes, `Number(row.amount)` does not, and somebody who wants to
 * add a money word has to come here and say so.
 *
 * `value` is deliberately not one of them. It is the most generic identifier in
 * the language and names a bounded integer in four places here, so including it
 * measures naming rather than arithmetic.
 */
const MONEY_WORDS =
  /\b(amount|balance|spent|received|remaining|limit|available|assigned|carried|funded|total|net|opening|closing|rate|price|debit|credit)\b/i;

describe("money on the server", () => {
  it("never travels through a JavaScript number", async () => {
    const { globSync } = await import("node:fs");
    const floats: string[] = [];
    let converted = 0;
    for (const path of globSync("src/server/**/*.ts")) {
      const lines = (await readFile(path, "utf8")).split("\n");
      lines.forEach((line, index) => {
        // Comments talk about `Number(...)`; only code converts with it.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        for (const call of line.matchAll(/\b(?:Number|parseFloat)\s*\(([^)]*)/g)) {
          converted += 1;
          // `Number.isSafeInteger` and friends are the guard, not a conversion.
          if (/^\s*$/.test(call[1]!)) continue;
          if (MONEY_WORDS.test(call[1]!)) floats.push(`${path}:${index + 1} ${call[0]!.trim()})`);
        }
      });
    }
    // A walk that converted nothing would pass by looking at nothing.
    expect(converted).toBeGreaterThan(5);
    expect(floats, "convert money with `decimal()`, never with Number()").toEqual([]);
  });

  it("gives every service the two helpers that replace it", async () => {
    const helpers = await readFile("src/server/services/helpers.ts", "utf8");
    expect(helpers).toContain("export const decimal");
    expect(helpers).toContain("export function canonicalDecimal");
  });
});
