import { describe, expect, it } from "vitest";
import { compareMoney, formatDate, moneyUnits } from "../src/client/components.js";
import {
  bulkStageFilterSchema,
  stageListQuerySchema,
} from "../src/shared/domain.js";

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
