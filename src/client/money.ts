/**
 * Money and dates as text, exactly.
 *
 * Its own module rather than part of `components.tsx`, because none of it is a
 * component: it is the arithmetic every page's figures go through, and it was
 * sitting under three hundred lines of JSX where nobody looks for arithmetic.
 *
 * Every amount here is a decimal string and never a JS number. A double holds
 * fifteen significant digits and the database stores forty-four, so the moment a
 * figure becomes a number the ledger stops agreeing with itself. Comparisons and
 * sums go through scaled BigInt; only pixel geometry is allowed to be lossy.
 */

let isoCurrencyCodes: Set<string> | null = null;

/**
 * Account currencies cover both ISO codes and crypto asset symbols. Only the
 * ISO ones have a defined display precision to round to.
 */
function isoCurrency(currency: string) {
  if (!isoCurrencyCodes) {
    isoCurrencyCodes = new Set(
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
    );
  }
  return isoCurrencyCodes.has(currency);
}

/** Half-up rounding on the decimal string, so no precision is lost to floats. */
function roundDecimal(sign: string, integer: string, fraction: string, digits: number) {
  const kept = fraction.slice(0, digits);
  const roundUp = Number(fraction[digits] ?? "0") >= 5;
  const scaled = BigInt(`${integer}${kept.padEnd(digits, "0")}`) + (roundUp ? 1n : 0n);
  const text = scaled.toString().padStart(digits + 1, "0");
  const roundedInteger = digits ? text.slice(0, -digits) : text;
  const roundedFraction = digits ? text.slice(-digits) : "";
  // Rounding a tiny negative amount to zero must not render as "-$0.00".
  const signed = scaled === 0n ? "" : sign;
  return `${signed}${roundedInteger}${roundedFraction ? `.${roundedFraction}` : ""}`;
}

/**
 * Formatters, kept rather than rebuilt.
 *
 * `Intl.NumberFormat` is expensive to construct — three times the cost of using
 * one — and `formatMoney` built up to four of them per call. A two-hundred-row
 * report with three money columns is twenty-four hundred constructions in one
 * render, which measured at 17ms: a dropped frame spent entirely on making
 * objects that are identical to the ones made a moment earlier.
 *
 * Keyed on everything that changes the answer, so nothing is shared that should
 * not be. Unbounded on purpose: the keys are locale-and-currency pairs and a
 * ledger holds a handful of currencies, so there is nothing here to grow.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormat(locales: string | string[] | undefined, options: Intl.NumberFormatOptions) {
  const key = `${Array.isArray(locales) ? locales.join(",") : (locales ?? "")}|${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locales, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormat(options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options);
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatMoney(amount: string, currency: string, locales?: string | string[]) {
  try {
    const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(amount);
    if (!match) return `${amount} ${currency}`;

    const [, sign, integer, fraction = ""] = match;
    const baseFormatter = numberFormat(locales, {
      style: "currency",
      currency,
    });
    const currencyDigits = baseFormatter.resolvedOptions().minimumFractionDigits ?? 0;
    // A real currency is shown at its own precision, so a stored value carrying
    // more scale than the currency has does not leak extra digits into the UI.
    // Crypto symbols are not ISO currencies and genuinely need their scale, so
    // they keep every significant digit instead.
    const fractionDigits = isoCurrency(currency)
      ? currencyDigits
      : Math.max(currencyDigits, fraction.length);
    if (fraction.length > fractionDigits) {
      return formatMoney(
        roundDecimal(sign ?? "", integer!, fraction, fractionDigits),
        currency,
        locales,
      );
    }
    const template = numberFormat(locales, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).formatToParts(sign ? -1n : 1n);
    const groupedInteger = numberFormat(locales, {
      useGrouping: true,
      maximumFractionDigits: 0,
    })
      .formatToParts(BigInt(integer))
      .filter((part) => part.type === "integer" || part.type === "group")
      .map((part) => part.value)
      .join("");
    const digitFormatter = numberFormat(locales, {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
    const localizedFraction = [...fraction.padEnd(fractionDigits, "0")]
      .map((digit) => digitFormatter.format(BigInt(digit)))
      .join("");

    let insertedInteger = false;
    return template
      .map((part) => {
        if (part.type === "integer" || part.type === "group") {
          if (insertedInteger) return "";
          insertedInteger = true;
          return groupedInteger;
        }
        if (part.type === "fraction") {
          return localizedFraction;
        }
        return part.value;
      })
      .join("");
  } catch {
    return `${amount} ${currency}`;
  }
}

export function isNegativeMoney(amount: string) {
  return amount.startsWith("-") && !/^-?0(?:\.0+)?$/.test(amount);
}

export function isPositiveMoney(amount: string) {
  return !amount.startsWith("-") && !/^0(?:\.0+)?$/.test(amount);
}

/**
 * A decimal money string as a scaled integer, or null if it is not money.
 *
 * Eighteen fractional digits is the scale the database stores, so scaling every
 * value to it puts any two on the same footing: 1.5 and 1.45 compare by what
 * they say rather than by which has more digits.
 */
export function moneyUnits(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) return null;
  const units = BigInt(`${match[2]}${(match[3] ?? "").padEnd(18, "0")}`);
  return match[1] === "-" ? -units : units;
}

/**
 * Orders two money strings exactly.
 *
 * Never through Number: a balance is a decimal string carrying up to eighteen
 * fractional digits, and a float cannot hold those, so two different balances
 * can compare equal and sort into whichever order they happened to arrive in.
 * Anything unparseable sorts last, the way a blank does elsewhere.
 */
export function compareMoney(left: string, right: string) {
  const a = moneyUnits(left);
  const b = moneyUnits(right);
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Scaled units back to the decimal string they came from, trailing zeroes and
 * a bare point trimmed off.
 */
export function moneyFromUnits(units: bigint) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(19, "0");
  const fraction = digits.slice(-18).replace(/0+$/, "");
  return `${negative ? "-" : ""}${digits.slice(0, -18)}${fraction ? `.${fraction}` : ""}`;
}

/**
 * What is left of `total` once every share is taken out of it, or null when any
 * of the values is not money yet.
 *
 * Exact, through scaled integers, because this decides whether a split may be
 * saved. A float would let 33.33 + 33.33 + 33.34 come to something that is not
 * quite 100 and refuse a receipt that adds up perfectly well.
 */
export function moneyRemainder(total: string, shares: readonly string[]) {
  const totalUnits = moneyUnits(total);
  if (totalUnits === null) return null;
  let remaining = totalUnits;
  for (const share of shares) {
    const units = moneyUnits(share);
    if (units === null) return null;
    remaining -= units;
  }
  return moneyFromUnits(remaining);
}

/** Several decimal money strings added up exactly. */
export function sumMoney(amounts: readonly string[]) {
  let total = 0n;
  for (const amount of amounts) {
    const units = moneyUnits(amount);
    if (units === null) return amounts[0] ?? "0";
    total += units;
  }
  return moneyFromUnits(total);
}

/**
 * The largest of several decimal money strings, compared exactly.
 *
 * Bar widths need the biggest row on show, and the biggest is no longer simply
 * the first now that uncategorised spending is pinned to the bottom of the
 * list. Compared as scaled integers rather than through Number, so a value with
 * eighteen fractional digits is ordered by what it says and not by what a float
 * can hold.
 */
export function largestMoney(amounts: readonly string[]) {
  let best: string | undefined;
  let bestUnits: bigint | undefined;
  for (const amount of amounts) {
    // moneyUnits rather than a private parse: the one written here rejected a
    // leading minus, so a category whose total is negative was dropped from the
    // comparison and the bars were scaled against the wrong maximum.
    const units = moneyUnits(amount);
    if (units === null) continue;
    if (bestUnits === undefined || units > bestUnits) {
      bestUnits = units;
      best = amount;
    }
  }
  return best;
}

export function moneyRatioPercent(amount: string, maximum: string) {
  // Both through moneyUnits, which scales everything to eighteen fractional
  // digits, so the ratio is taken between two numbers on one scale and a sign
  // is read rather than refused.
  const numerator = moneyUnits(amount);
  const denominatorUnits = moneyUnits(maximum);
  if (numerator === null || denominatorUnits === null) return "4";
  if (denominatorUnits <= 0n) return "4";
  if (numerator <= 0n) return "4";

  const hundredthsOfPercent = (numerator * 10_000n) / denominatorUnits;
  const bounded = hundredthsOfPercent > 10_000n ? 10_000n : hundredthsOfPercent;
  const visible = bounded < 400n ? 400n : bounded;
  const whole = visible / 100n;
  const fraction = (visible % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function moneyExtent(amounts: readonly string[]) {
  let low: bigint | undefined;
  let high: bigint | undefined;
  for (const amount of amounts) {
    const units = moneyUnits(amount);
    if (units === null) continue;
    if (low === undefined || units < low) low = units;
    if (high === undefined || units > high) high = units;
  }
  if (low === undefined || high === undefined) return null;
  return { low: moneyFromUnits(low), high: moneyFromUnits(high) };
}

/**
 * Where a value sits between two bounds, as a percentage.
 *
 * Not `moneyRatioPercent`, which floors at four percent and answers "4" for
 * anything at or below zero. That is right for a bar measuring spending against
 * the largest spend, and wrong for anything that can be negative: a net worth
 * below zero would plot as a short positive bar and the chart would read as the
 * opposite of the truth.
 */
export function moneyScalePercent(amount: string, low: string, high: string): string {
  const value = moneyUnits(amount);
  const bottom = moneyUnits(low);
  const top = moneyUnits(high);
  if (value === null || bottom === null || top === null) return "0";
  const span = top - bottom;
  if (span <= 0n) return "50";

  const clamped = value < bottom ? bottom : value > top ? top : value;
  const hundredths = ((clamped - bottom) * 10_000n) / span;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Total on purpose. A staged row is allowed to hold whatever a CSV put in its
 * date column, and Intl throws a RangeError on an invalid date, which unmounts
 * the tree and leaves a white page rather than a badly formatted cell. Anything
 * this cannot read is shown as it arrived, which is also what somebody needs to
 * see in order to fix it.
 */
/**
 * A month named for an axis: "Aug 2026".
 *
 * Here rather than in charts.tsx because web.md 10.4's own check is a grep for
 * `Intl.DateTimeFormat` outside this module — every date rendering shares one
 * gate, and the axis label was the one path around it.
 */
export function formatMonth(value: string) {
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return formatDate(value);
  return dateFormat({ month: "short", year: "numeric", timeZone: "UTC" }).format(day);
}

export function formatDate(value: string) {
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return value;
  return dateFormat({
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(day);
}

/**
 * An instant, rendered where this person lives.
 *
 * The two places that print one — the activity log and the connected-apps
 * panel — each rolled their own formatter in the browser's zone, so an audit
 * trail read while travelling disagreed with the dates on the entries it
 * audits. Total for formatDate's reason: an unreadable timestamp renders as it
 * arrived rather than unmounting the page, and an unknown zone falls back to
 * the browser's rather than throwing.
 */
export function formatTimestamp(value: string, timezone: string) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(instant);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(instant);
  }
}

/**
 * Which way a movement went, as a sign and a class.
 *
 * A stored amount is always positive: `AGENTS.md` keeps direction in the
 * transaction's type rather than in the number, so nothing about the value
 * itself says whether money arrived or left. A list of movements has to say so
 * anyway, and it has to say it the same way on every page.
 *
 * It used to say it three ways. The register signed and coloured by type; the
 * reports coloured by the value's own sign; and the review queue, the templates
 * and the recurrences said nothing at all, so the same withdrawal read three
 * ways in three places and one of the three did not read at all.
 *
 * `inbound` is for a transfer seen from one account: the same transfer leaves
 * one side and arrives at the other, so the answer depends on which account is
 * being looked at, and a transfer seen from neither has no direction to show.
 */
export function movementSign(
  type: string | undefined,
  inbound?: boolean,
): { sign: string; className: string } {
  if (type === "deposit") return { sign: "+", className: "deposit" };
  if (type === "withdrawal") return { sign: "−", className: "withdrawal" };
  if (type === "transfer") {
    // A transfer between somebody's own accounts is not spending, so it is
    // signed but left uncoloured. The inbound side reads as an arrival, which
    // is why it takes the deposit colour and the outbound side takes none.
    // That asymmetry is the register's own and is preserved here rather than
    // tidied, because tidying it would repaint a screen without being asked.
    if (inbound === true) return { sign: "+", className: "deposit" };
    if (inbound === false) return { sign: "−", className: "transfer" };
    return { sign: "", className: "transfer" };
  }
  // A staged row can carry a type a parser could not read, and that row is
  // exactly the one somebody opened the queue to repair. It gets no sign rather
  // than a guessed one.
  return { sign: "", className: "" };
}
