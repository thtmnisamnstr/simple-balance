import { describe, expect, it } from "vitest";
import { movementSign } from "../src/client/money.js";

/**
 * One rule for which way money went, shared by every list that shows amounts.
 *
 * A stored amount is always positive — `AGENTS.md` keeps direction in the
 * transaction's type — so nothing about the number says whether money arrived
 * or left. Four lists have to say it anyway, and they used to say it three
 * different ways: the register signed and coloured by type, the reports
 * coloured by the value's own sign, and the review queue, the templates and the
 * recurrences said nothing at all. The same withdrawal read three ways in three
 * places, and one of the three did not read at all.
 */
describe("which way a movement went", () => {
  it("reads a deposit as money arriving", () => {
    expect(movementSign("deposit")).toEqual({ sign: "+", className: "deposit" });
  });

  it("reads a withdrawal as money leaving", () => {
    expect(movementSign("withdrawal")).toEqual({ sign: "−", className: "withdrawal" });
  });

  // Not a hyphen. Intl uses U+2212 and a list mixing the two looks broken at
  // small sizes, which is the kind of thing nobody reports and everybody sees.
  it("uses a real minus sign", () => {
    expect(movementSign("withdrawal").sign).toBe("−");
    expect(movementSign("withdrawal").sign).not.toBe("-");
  });

  /**
   * A transfer's direction depends on which account is being looked at, so a
   * transfer seen from neither side has no direction to show. It is signed but
   * left uncoloured either way: moving money between your own accounts is not
   * spending, and colouring it red would say it was.
   */
  it("takes a transfer's direction from the account being viewed", () => {
    expect(movementSign("transfer", true)).toEqual({ sign: "+", className: "deposit" });
    expect(movementSign("transfer", false)).toEqual({ sign: "−", className: "transfer" });
    expect(movementSign("transfer")).toEqual({ sign: "", className: "transfer" });
  });

  /**
   * A staged row may carry a type a parser could not read, and that row is
   * exactly the one somebody opened the review queue to repair. Guessing a
   * direction for it would put a sign on the screen that the data does not
   * support.
   */
  it("says nothing about a row whose type it cannot read", () => {
    expect(movementSign(undefined)).toEqual({ sign: "", className: "" });
    expect(movementSign("")).toEqual({ sign: "", className: "" });
    expect(movementSign("nonsense-from-a-csv")).toEqual({ sign: "", className: "" });
  });
});
