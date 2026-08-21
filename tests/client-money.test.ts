import { describe, expect, it } from "vitest";
import {
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  moneyRatioPercent,
} from "../src/client/money.js";

describe("exact client money rendering", () => {
  it("keeps every integer digit exact without converting through Number", () => {
    expect(
      formatMoney(
        "99999999999999999999999999.123456789012",
        "USD",
        "en-US",
      ),
    ).toBe("$99,999,999,999,999,999,999,999,999.12");
    expect(formatMoney("42", "USD", "en-US")).toBe("$42.00");
  });

  it("shows a real currency at its own precision", () => {
    // Ledger amounts are stored with far more scale than a currency displays.
    expect(formatMoney("1234.56789", "USD", "en-US")).toBe("$1,234.57");
    expect(formatMoney("0.005", "USD", "en-US")).toBe("$0.01");
    expect(formatMoney("0.004", "USD", "en-US")).toBe("$0.00");
    expect(formatMoney("9.999", "USD", "en-US")).toBe("$10.00");
    expect(formatMoney("1234", "JPY", "en-US")).toBe("¥1,234");
    expect(formatMoney("1234.6", "JPY", "en-US")).toBe("¥1,235");
  });

  it("never renders a rounded-away amount as negative zero", () => {
    expect(formatMoney("-0.000000000001", "USD", "en-US")).toBe("$0.00");
    expect(formatMoney("-0.006", "USD", "en-US")).toBe("-$0.01");
  });

  it("keeps full precision for crypto symbols that have no ISO precision", () => {
    // Intl separates a non-symbol currency code with a non-breaking space.
    const plain = (value: string, currency: string) =>
      formatMoney(value, currency, "en-US").replaceAll(" ", " ");

    expect(plain("0.000000010000", "BTC")).toBe("BTC 0.000000010000");
    expect(plain("1.23456789", "ETH")).toBe("ETH 1.23456789");
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
