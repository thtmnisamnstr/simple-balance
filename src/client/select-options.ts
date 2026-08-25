const fallbackCurrencies = [
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "NOK",
  "NZD",
  "SEK",
  "SGD",
  "USD",
] as const;

export const popularCryptocurrencies = [
  "BTC",
  "ETH",
  "SOL",
  "USDC",
  "USDT",
  "XRP",
  "ADA",
  "DOGE",
  "LTC",
  "AVAX",
  "DOT",
  "LINK",
  "XLM",
  "BCH",
] as const;

const cryptocurrencyNames: Record<(typeof popularCryptocurrencies)[number], string> = {
  BTC: "Bitcoin",
  ETH: "Ether",
  SOL: "Solana",
  USDC: "USD Coin",
  USDT: "Tether",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  LTC: "Litecoin",
  AVAX: "Avalanche",
  DOT: "Polkadot",
  LINK: "Chainlink",
  XLM: "Stellar",
  BCH: "Bitcoin Cash",
};

function supportedValues(kind: "currency" | "timeZone", fallback: readonly string[]) {
  try {
    return Intl.supportedValuesOf(kind);
  } catch {
    return [...fallback];
  }
}

function includeSelected(values: string[], selected: string) {
  return [...new Set([...values, selected])].sort((left, right) => left.localeCompare(right));
}

export function currencyOptions(selected: string) {
  return includeSelected(
    [...supportedValues("currency", fallbackCurrencies), ...popularCryptocurrencies],
    selected.toUpperCase(),
  );
}

export function timezoneOptions(selected: string) {
  return includeSelected(supportedValues("timeZone", ["UTC"]), selected);
}

export function currencyOptionLabel(code: string) {
  const cryptoName = cryptocurrencyNames[code as keyof typeof cryptocurrencyNames];
  if (cryptoName) return `${cryptoName} (${code})`;
  try {
    const name = new Intl.DisplayNames(undefined, { type: "currency" }).of(code);
    return name ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

function timezonePart(timezone: string, timeZoneName: "short" | "shortOffset") {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}

function utcOffset(value: string | undefined) {
  if (!value || value === "UTC" || value === "GMT") return "UTC+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (!match) return value.replace("GMT", "UTC");
  return `UTC${match[1]}${match[2]!.padStart(2, "0")}:${match[3] ?? "00"}`;
}

export function timezoneOptionLabel(timezone: string) {
  const abbreviation = timezonePart(timezone, "short") ?? timezone;
  const offset = utcOffset(timezonePart(timezone, "shortOffset"));
  const place = timezone.replaceAll("_", " ").replace("/", " / ");
  return `${place} — ${abbreviation} (${offset})`;
}
