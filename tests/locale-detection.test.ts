import { afterEach, describe, expect, it, vi } from "vitest";

const realNavigator = globalThis.navigator;
const intlAsRecord = Intl as unknown as Record<string, unknown>;
const realLocale = intlAsRecord.Locale;

afterEach(() => {
  if (realNavigator) {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  }
  intlAsRecord.Locale = realLocale;
  vi.restoreAllMocks();
  vi.resetModules();
});

function withBrowser(options: {
  languages?: string[];
  language?: string;
  timeZone?: string;
  noIntlLocale?: boolean;
}) {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      languages: options.languages,
      language: options.language ?? options.languages?.[0],
    },
    configurable: true,
  });
  if (options.timeZone !== undefined) {
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: options.timeZone }),
    } as unknown as Intl.DateTimeFormat);
  }
  // Removed deliberately, to exercise the path older engines take.
  if (options.noIntlLocale) intlAsRecord.Locale = undefined;
  return import("../src/client/locale.js");
}

/**
 * A new account used to start on UTC and USD whoever opened it. That is wrong
 * for most of the world, and wrong in a way that misdates entries rather than
 * merely looking foreign: something recorded on a California evening lands on
 * tomorrow in UTC.
 */
describe("what the browser implies about where its owner is", () => {
  it("takes the timezone the browser reports", async () => {
    const { detectedTimezone } = await withBrowser({
      timeZone: "America/Los_Angeles",
      language: "en-US",
    });
    expect(detectedTimezone()).toBe("America/Los_Angeles");
  });

  it("falls back to UTC when the browser will not say", async () => {
    const { detectedTimezone } = await withBrowser({
      timeZone: "",
      language: "en",
    });
    expect(detectedTimezone()).toBe("UTC");
  });

  it("reads the currency from the region of the language tag", async () => {
    for (const [tag, currency] of [
      ["en-GB", "GBP"],
      ["de-DE", "EUR"],
      ["ja-JP", "JPY"],
      ["en-CA", "CAD"],
      ["pt-BR", "BRL"],
      ["en-US", "USD"],
    ] as const) {
      const { detectedCurrency } = await withBrowser({ language: tag });
      expect(detectedCurrency(), tag).toBe(currency);
      vi.resetModules();
    }
  });

  // A bare language says nothing about the place. Reading the United States
  // out of "en" is how software tells a Scot their money is dollars, so the
  // fallback has to be a fallback rather than a guess dressed up as one.
  it("falls back rather than inventing a region from a bare language", async () => {
    const { detectedCurrency } = await withBrowser({ language: "en" });
    expect(detectedCurrency()).toBe("USD");
  });

  it("prefers the first language that names a region", async () => {
    const { detectedCurrency } = await withBrowser({
      languages: ["en", "fr-CH", "de-DE"],
      language: "en",
    });
    expect(detectedCurrency()).toBe("CHF");
  });

  it("falls back to USD for a region it does not list", async () => {
    const { detectedCurrency } = await withBrowser({ language: "en-AQ" });
    expect(detectedCurrency()).toBe("USD");
  });

  it("still finds the region without Intl.Locale", async () => {
    const { detectedCurrency } = await withBrowser({
      language: "en-AU",
      noIntlLocale: true,
    });
    expect(detectedCurrency()).toBe("AUD");
  });

  it("survives a malformed language tag", async () => {
    const { detectedCurrency } = await withBrowser({ language: "!!!not-a-tag" });
    expect(detectedCurrency()).toBe("USD");
  });
});
