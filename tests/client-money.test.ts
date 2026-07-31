import { describe, expect, it } from "vitest";
import {
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  moneyRatioPercent,
} from "../src/client/components.js";

describe("exact client money rendering", () => {
  it("formats all numeric digits without converting through Number", () => {
    expect(
      formatMoney(
        "99999999999999999999999999.123456789012",
        "USD",
        "en-US",
      ),
    ).toBe("$99,999,999,999,999,999,999,999,999.123456789012");
    expect(formatMoney("-0.000000000001", "USD", "en-US")).toBe(
      "-$0.000000000001",
    );
    expect(formatMoney("42", "USD", "en-US")).toBe("$42.00");
  });

  it("uses string-safe signs and bounded ratios", () => {
    expect(isNegativeMoney("-0.000000000001")).toBe(true);
    expect(isNegativeMoney("-0.000000000000")).toBe(false);
    expect(isPositiveMoney("0.000000000001")).toBe(true);
    expect(isPositiveMoney("0.000000000000")).toBe(false);
    expect(
      moneyRatioPercent(
        "50000000000000000000000000.000000000001",
        "99999999999999999999999999.999999999999",
      ),
    ).toBe("50");
  });
});
