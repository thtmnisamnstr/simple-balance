import { describe, expect, it } from "vitest";
import {
  qualifyRepeatedLabels,
  type Cell,
} from "../src/server/services/reports.js";

const cell = (over: Partial<Cell>): Cell => ({
  bucketStart: "2026-01-01",
  currency: "USD",
  key: "expense:food",
  label: "Food",
  kind: "expense",
  value: "10",
  ...over,
});

/**
 * A category can be set to cover both sides, and Uncategorized always does. The
 * report is right to return two rows for one such name — one for what came in
 * under it and one for what went out — but they arrived with the same label, so
 * the table and the chart legend showed that label twice with no way to tell
 * which row was which.
 */
describe("naming the rows of a category report", () => {
  it("says which side a name that spans both is on", () => {
    const qualified = qualifyRepeatedLabels([
      cell({ key: "expense:refunds", label: "Refunds", kind: "expense" }),
      cell({ key: "income:refunds", label: "Refunds", kind: "income" }),
    ]);
    expect(qualified.map((entry) => entry.label)).toEqual([
      "Refunds (expense)",
      "Refunds (income)",
    ]);
  });

  it("leaves a name that is only ever on one side as the person wrote it", () => {
    const qualified = qualifyRepeatedLabels([
      cell({ label: "Food" }),
      cell({ bucketStart: "2026-02-01", label: "Food" }),
      cell({ key: "income:salary", label: "Salary", kind: "income" }),
    ]);
    expect(qualified.map((entry) => entry.label)).toEqual([
      "Food",
      "Food",
      "Salary",
    ]);
  });

  it("qualifies every bucket of a spanning row, not just the first", () => {
    const qualified = qualifyRepeatedLabels([
      cell({ key: "expense:uncategorized", label: "Uncategorized" }),
      cell({
        bucketStart: "2026-02-01",
        key: "expense:uncategorized",
        label: "Uncategorized",
      }),
      cell({ key: "income:uncategorized", label: "Uncategorized", kind: "income" }),
    ]);
    expect(qualified.map((entry) => entry.label)).toEqual([
      "Uncategorized (expense)",
      "Uncategorized (expense)",
      "Uncategorized (income)",
    ]);
  });
});
