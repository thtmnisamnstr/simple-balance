import { describe, expect, it } from "vitest";
import {
  accountTypeLabels,
  accountTypeOrder,
  groupAccountsByType,
  userAccountTypes,
} from "../src/shared/domain.js";

const account = (id: string, type: string) => ({ id, type });

describe("grouping accounts by type", () => {
  /**
   * The enum is stored in the database and cannot be reordered, so the display
   * order is a second list. Two lists of the same thing drift, and a type
   * missing from this one would vanish off the bottom of both screens.
   */
  it("covers every type a person can create, exactly once", () => {
    expect([...accountTypeOrder].sort()).toEqual([...userAccountTypes].sort());
    expect(new Set(accountTypeOrder).size).toBe(accountTypeOrder.length);
    for (const type of accountTypeOrder) {
      expect(accountTypeLabels[type], type).toBeTruthy();
    }
  });

  it("puts what you hold before what you owe", () => {
    const order = (type: (typeof accountTypeOrder)[number]) => accountTypeOrder.indexOf(type);
    expect(order("cash")).toBeLessThan(order("checking"));
    expect(order("checking")).toBeLessThan(order("savings"));
    expect(order("savings")).toBeLessThan(order("credit_card"));
    expect(order("credit_card")).toBeLessThan(order("loan"));
    expect(order("loan")).toBeLessThan(order("investment"));
  });

  it("orders the groups by type rather than by first appearance", () => {
    const groups = groupAccountsByType([
      account("a", "loan"),
      account("b", "cash"),
      account("c", "credit_card"),
      account("d", "checking"),
    ]);
    expect(groups.map((group) => group.type)).toEqual(["cash", "checking", "credit_card", "loan"]);
    expect(groups.map((group) => group.label)).toEqual(["Cash", "Checking", "Credit Card", "Loan"]);
  });

  it("keeps every account, and leaves out the types nobody has", () => {
    const groups = groupAccountsByType([
      account("a", "checking"),
      account("b", "checking"),
      account("c", "cash"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.accounts.map((one) => one.id))).toEqual(["c", "a", "b"]);
  });

  it("keeps the order it was given inside a group", () => {
    const groups = groupAccountsByType([
      account("second", "checking"),
      account("first", "checking"),
    ]);
    expect(groups[0]!.accounts.map((one) => one.id)).toEqual(["second", "first"]);
  });

  /**
   * The dashboard summary sends the type as free text, so a type this build
   * does not know about has to land somewhere visible rather than be dropped
   * from a page of balances.
   */
  it("shows a type it does not recognise, at the end", () => {
    const groups = groupAccountsByType([
      account("odd", "something_new"),
      account("normal", "cash"),
    ]);
    expect(groups.map((group) => group.type)).toEqual(["cash", "something_new"]);
    expect(groups[1]!.label).toBe("something_new");
  });

  it("returns nothing for nothing", () => {
    expect(groupAccountsByType([])).toEqual([]);
  });
});
