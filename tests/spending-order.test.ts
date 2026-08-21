import { describe, expect, it } from "vitest";
import {
  largestMoney,
  moneyRatioPercent,
} from "../src/client/money.js";

/**
 * Uncategorised spending is pinned to the bottom of the list, so the first row
 * is no longer necessarily the largest, and the bar widths are scaled against
 * whichever row on show actually is. `moneyRatioPercent` clamps a ratio above
 * one to a full bar, so getting this wrong draws two different amounts the same
 * width rather than failing visibly.
 */
describe("the widest amount on show", () => {
  it("finds the largest whatever order it arrives in", () => {
    expect(largestMoney(["120.00", "80.00", "300.00"])).toBe("300.00");
    expect(largestMoney(["300.00", "120.00", "80.00"])).toBe("300.00");
  });

  // The reason this is not Number(): a float cannot tell these apart.
  it("orders by what the decimal says, not what a float can hold", () => {
    expect(
      largestMoney(["0.100000000000000001", "0.100000000000000002"]),
    ).toBe("0.100000000000000002");
    expect(largestMoney(["9007199254740993", "9007199254740992"])).toBe(
      "9007199254740993",
    );
  });

  it("compares across different numbers of decimal places", () => {
    expect(largestMoney(["1.5", "1.45"])).toBe("1.5");
    expect(largestMoney(["2", "1.999999"])).toBe("2");
    expect(largestMoney(["0.9", "1"])).toBe("1");
  });

  it("handles one row, equal rows, and zero", () => {
    expect(largestMoney(["5.00"])).toBe("5.00");
    expect(largestMoney(["5.00", "5.00"])).toBe("5.00");
    expect(largestMoney(["0", "0"])).toBe("0");
  });

  // A caller falls back when there is nothing to scale against.
  it("says nothing rather than guessing when there is nothing to compare", () => {
    expect(largestMoney([])).toBeUndefined();
    expect(largestMoney(["not-money", "also-not"])).toBeUndefined();
  });

  it("ignores what it cannot parse rather than letting it win", () => {
    expect(largestMoney(["10.00", "-5.00", "banana", "20.00"])).toBe("20.00");
  });
});

/**
 * The ordering itself is the server's, so that the page and an agent reading
 * get_financial_summary see the same list. This pins the shape the page relies
 * on: uncategorised last, and everything else by amount.
 */
describe("how the page arranges what the server sent", () => {
  type Row = { categoryId: string | null; category: string; amount: string };

  // The same expression the dashboard uses.
  const arrange = (rows: Row[]) => [
    ...rows.filter((row) => row.categoryId !== null).slice(0, 7),
    ...rows.filter((row) => row.categoryId === null),
  ];

  const row = (id: string | null, category: string, amount: string): Row => ({
    categoryId: id,
    category,
    amount,
  });

  it("keeps uncategorised last even when it is the biggest", () => {
    const arranged = arrange([
      row("a", "Rent", "900.00"),
      row("b", "Food", "300.00"),
      row(null, "Uncategorized", "5000.00"),
    ]);
    expect(arranged.map((entry) => entry.category)).toEqual([
      "Rent",
      "Food",
      "Uncategorized",
    ]);
  });

  // Cutting the list at seven would drop it at rank eight, which is the one row
  // that says there is filing left to do.
  it("keeps uncategorised even past the seven it shows", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      row(`c${index}`, `Category ${index}`, `${100 - index}.00`),
    );
    const arranged = arrange([...many, row(null, "Uncategorized", "1.00")]);
    expect(arranged).toHaveLength(8);
    expect(arranged[7]?.category).toBe("Uncategorized");
  });

  it("changes nothing when there is no uncategorised spending", () => {
    const rows = [row("a", "Rent", "900.00"), row("b", "Food", "300.00")];
    expect(arrange(rows)).toEqual(rows);
  });
});

/**
 * A category total can be negative: repostTransaction writes each delta at its
 * own date, so moving a January expense to February leaves the expense account
 * with a negative posting in January. A parser that refuses a leading minus
 * dropped those rows from the comparison and scaled every bar against the wrong
 * maximum.
 */
describe("bar scaling when a total is negative", () => {
  it("still finds the largest when a negative is in the list", () => {
    expect(largestMoney(["-100.00", "30.00", "12.50"])).toBe("30.00");
    expect(largestMoney(["-100.00", "-30.00"])).toBe("-30.00");
  });

  it("gives a negative share the minimum width rather than a wrong one", () => {
    expect(moneyRatioPercent("-50.00", "100.00")).toBe("4");
  });

  it("scales an ordinary share against the maximum", () => {
    expect(moneyRatioPercent("50.00", "100.00")).toBe("50");
    expect(moneyRatioPercent("100.00", "100.00")).toBe("100");
  });
});
