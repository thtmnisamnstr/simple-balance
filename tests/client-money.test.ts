import { describe, expect, it } from "vitest";
import {
  amountForInput,
  formatMoney,
  isNegativeMoney,
  isPositiveMoney,
  moneyRatioPercent,
} from "../src/client/money.js";

describe("exact client money rendering", () => {
  it("keeps every integer digit exact without converting through Number", () => {
    expect(formatMoney("99999999999999999999999999.123456789012", "USD", "en-US")).toBe(
      "$99,999,999,999,999,999,999,999,999.12",
    );
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

describe("an amount put into an input", () => {
  it("starts at the currency's own decimal places, whatever scale it was stored at", () => {
    expect(amountForInput("3250.000000000000000000", "USD")).toBe("3250.00");
    expect(amountForInput("12.5", "USD")).toBe("12.50");
    expect(amountForInput("1850", "USD")).toBe("1850.00");
    expect(amountForInput("-480.25", "USD")).toBe("-480.25");
    expect(amountForInput("116250", "JPY")).toBe("116250");
    expect(amountForInput("116250.000", "JPY")).toBe("116250");
  });

  it("adds and removes only zeros, never a digit somebody stored", () => {
    expect(amountForInput("12.345", "USD")).toBe("12.345");
    expect(amountForInput("0.000000000000000001", "BTC")).toBe("0.000000000000000001");
    expect(amountForInput("2.500000000000000000", "BTC")).toBe("2.5");
    expect(amountForInput("not a number", "USD")).toBe("not a number");
  });
});
