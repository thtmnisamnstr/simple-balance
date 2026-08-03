/**
 * What the browser already knows about where its owner is.
 *
 * A new account used to start at UTC and USD whoever opened it, which is wrong
 * for most of the world and wrong in a way that quietly misdates every entry: a
 * transaction recorded late in the evening in California lands on tomorrow in
 * UTC. The browser knows its own timezone exactly, so there is no reason to
 * guess.
 *
 * These are a starting point, not a decision. Both are ordinary preferences the
 * person can change in Settings, and nothing here overwrites a choice already
 * made.
 */

/** The IANA zone the browser is set to, which is authoritative for its owner. */
export function detectedTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The region of the browser's own language tag, as an ISO 3166-1 country.
 *
 * `en-GB` gives GB. A bare `en` gives nothing, which is honest: it says the
 * language and not the place, and guessing the United States from it is how
 * software ends up telling a Scot their money is dollars.
 */
function browserRegion() {
  const tags = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  for (const tag of tags) {
    try {
      const region = new Intl.Locale(tag).region;
      if (region) return region.toUpperCase();
    } catch {
      // Older engines have no Intl.Locale, and a tag can be malformed. The
      // subtag after the language is the region when it is two letters.
      const part = tag.split(/[-_]/)[1];
      if (part && /^[A-Za-z]{2}$/.test(part)) return part.toUpperCase();
    }
  }
  return undefined;
}

/**
 * The currency a country actually spends, for the countries a self-hosted
 * ledger is plausibly opened in.
 *
 * Deliberately not exhaustive: an unlisted region falls back rather than being
 * given a currency by a guess nobody checked. Every value is an ISO 4217 code.
 */
const CURRENCY_BY_REGION: Record<string, string> = {
  AE: "AED", AR: "ARS", AT: "EUR", AU: "AUD", BD: "BDT", BE: "EUR", BG: "BGN",
  BR: "BRL", CA: "CAD", CH: "CHF", CL: "CLP", CN: "CNY", CO: "COP", CY: "EUR",
  CZ: "CZK", DE: "EUR", DK: "DKK", EE: "EUR", EG: "EGP", ES: "EUR", FI: "EUR",
  FR: "EUR", GB: "GBP", GR: "EUR", HK: "HKD", HR: "EUR", HU: "HUF", ID: "IDR",
  IE: "EUR", IL: "ILS", IN: "INR", IS: "ISK", IT: "EUR", JP: "JPY", KE: "KES",
  KR: "KRW", LT: "EUR", LU: "EUR", LV: "EUR", MA: "MAD", MT: "EUR", MX: "MXN",
  MY: "MYR", NG: "NGN", NL: "EUR", NO: "NOK", NZ: "NZD", PE: "PEN", PH: "PHP",
  PK: "PKR", PL: "PLN", PT: "EUR", RO: "RON", RS: "RSD", SA: "SAR", SE: "SEK",
  SG: "SGD", SI: "EUR", SK: "EUR", TH: "THB", TR: "TRY", TW: "TWD", UA: "UAH",
  US: "USD", VN: "VND", ZA: "ZAR",
};

/** The currency to start a new account on, or USD when the region is unknown. */
export function detectedCurrency() {
  const region = browserRegion();
  return (region && CURRENCY_BY_REGION[region]) || "USD";
}
