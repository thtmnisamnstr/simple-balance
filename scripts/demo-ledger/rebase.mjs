/**
 * The demo ledger, moved through the calendar so it ends this month.
 *
 * `demo-ledger.json` beside this module is the one synthetic ledger this
 * repository seeds anything with — the product kit's screenshots, a design
 * review, a smoke test, a person trying the app — and it is an export from
 * the application itself, so it is exactly what a Simple Balance file is and
 * every rule a move holds a file to holds it. The README beside it says how it
 * is kept.
 *
 * **Why the dates move at all.** The file was exported on one day and is read
 * on another, and every page in this app defaults to a this-month range: a
 * ledger whose last entry is three months old photographs as an empty
 * dashboard. So every date in it moves by the same whole number of months,
 * chosen so the month of its last entry becomes the current one.
 *
 * **Whole months, never days.** A month keeps what the ledger is about: rent
 * on the 2nd, a monthly budget's periods starting on the 1st, a recurrence's
 * day of the month. A day of the month the target month is too short for
 * lands on its last day, which is what the app's own `last_day` month policy
 * does. A weekday is not kept, so a weekly budget or a weekend policy would
 * move to another day of the week; the file has none, and the integration test
 * that moves this file into a database is what would say so if one arrived.
 *
 * **Nothing is dated past today.** An entry the shift puts ahead of today is
 * dated today instead, because money dated ahead has not moved, this
 * application correctly declines to count it, and the current month would
 * come out short with nothing on screen to say so. A staged row is clamped the
 * same way. Schedules and budgets are not: a recurrence anchored next month is
 * what keeps it from photographing as past due.
 *
 * **The balance checks still hold.** They describe the file's `throughDate`,
 * and once nothing is dated past today every entry is on or before it, so
 * `throughDate` becomes today and every account's balance is the one the file
 * carries. A file holding an entry dated after its own `throughDate` — a
 * future-dated payment — would break that, and is refused here rather than at
 * the end of a move.
 *
 * Plain ESM with no imports, so `build.mjs`, `load.mjs` and the tests can all
 * use it, and so it can be read as the whole of the transformation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where the committed export lives. */
export const DEMO_LEDGER_PATH = fileURLToPath(new URL("./demo-ledger.json", import.meta.url));

/**
 * Who the demo ledger belongs to. A file carries no users, so the identity is
 * kept here, and it is fixed because it shows in the sidebar of every
 * screenshot.
 */
export const DEMO_PERSON = Object.freeze({
  name: "Alex Rivera",
  email: "alex@example.com",
  password: "correct-horse-battery-staple-9",
});

/** The committed export, parsed. */
export function readDemoLedger() {
  return JSON.parse(readFileSync(DEMO_LEDGER_PATH, "utf8"));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (value) => String(value).padStart(2, "0");
const monthIndex = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** `date` moved `months` whole months, landing on the month's last day where it is too short. */
export function shiftDay(date, months) {
  const index = monthIndex(date) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(Math.min(Number(date.slice(8, 10)), last))}`;
}

/** An RFC 3339 instant moved the same way, its time and offset kept. */
const shiftInstant = (instant, months) =>
  shiftDay(instant.slice(0, 10), months) + instant.slice(10);

/** The later of the dates the file's entries carry, or its `throughDate` when it has none. */
export function lastEntryDate(file) {
  let last = null;
  for (const entry of file.entries) if (last === null || entry.date > last) last = entry.date;
  return last ?? file.throughDate;
}

/** How many whole months separate the month of `from` and the month of `to`. */
export const monthsBetween = (from, to) => monthIndex(to) - monthIndex(from);

/**
 * A copy of `file` with every date and instant in it moved `months` whole
 * months, the file's own `exportedAt` and `throughDate` included, and nothing
 * else changed. `rebaseLedgerFile` uses it to bring the file forward and
 * `save.mjs` to take a fresh export back to the months the committed one is in.
 */
export function shiftLedgerFile(file, months) {
  const day = (value) =>
    typeof value === "string" && DAY.test(value) ? shiftDay(value, months) : value;
  const instant = (value) => (typeof value === "string" ? shiftInstant(value, months) : value);
  // Only the fields a record carries are touched, so an optional one the file
  // left out stays left out rather than coming back as `undefined`.
  const each = (record, keys, change) => {
    if (!record) return;
    for (const key of keys) if (key in record) record[key] = change(record[key]);
  };

  const next = structuredClone(file);
  each(next, ["throughDate"], day);
  each(next, ["exportedAt"], instant);
  each(next.scope, ["start", "end"], day);
  for (const account of next.accounts) {
    each(account, ["openingDate"], day);
    each(account, ["archivedAt"], instant);
  }
  for (const category of next.categories) each(category, ["archivedAt"], instant);
  for (const template of next.templates) {
    each(template.draft, ["date"], day);
    each(template.notification, ["anchorDate", "lastNotifiedDate", "nextNotificationDate"], day);
  }
  for (const recurrence of next.recurrences) {
    each(recurrence.schedule, ["anchorDate"], day);
    each(recurrence, ["lastOccurrenceDate"], day);
  }
  for (const plan of next.budgets.plans) each(plan, ["activeFrom", "activeTo", "targetDate"], day);
  for (const amount of next.budgets.entries) each(amount, ["periodStart"], day);
  for (const entry of next.entries) each(entry, ["date"], day);
  for (const row of next.staged) each(row.draft, ["date"], day);
  return next;
}

/**
 * A copy of `file` whose last entry falls in the month `monthsBack` before the
 * one `today` is in, with nothing dated past `today`.
 *
 * `monthsBack` is 0 for anything that reads the ledger — the current month is
 * the one every page opens on. Keeping the file is the other use: load it at 1,
 * so the whole of its last month is already past and no entry is clamped,
 * change what needs changing, and save it again. A clamped entry saved back
 * would carry today's date into the file for good.
 *
 * @param {object} file A parsed Simple Balance file.
 * @param {{ today: string, monthsBack?: number }} options
 *   `today` is the calendar day where the ledger will be read, `YYYY-MM-DD`.
 */
export function rebaseLedgerFile(file, { today, monthsBack = 0 }) {
  if (!DAY.test(today)) throw new Error(`today has to be a YYYY-MM-DD day, not ${today}`);
  const future = file.entries.find((entry) => entry.date > file.throughDate);
  if (future) {
    throw new Error(
      `The entry dated ${future.date} is after the file's balance checks (${file.throughDate}), so moving it could not keep them true. Save the demo ledger without future-dated entries.`,
    );
  }
  const next = shiftLedgerFile(file, monthsBetween(lastEntryDate(file), today) - monthsBack);
  const notAfterToday = (value) => (typeof value === "string" && value > today ? today : value);
  for (const entry of next.entries) entry.date = notAfterToday(entry.date);
  for (const row of next.staged) {
    if ("date" in row.draft) row.draft.date = notAfterToday(row.draft.date);
  }
  // From the day rather than the clock, so the same day rebases to the same
  // bytes and a second load replays the first under its idempotency key.
  next.exportedAt = `${today}T00:00:00.000Z`;
  next.throughDate = today;
  return next;
}

/**
 * The body of `POST /api/v1/ledger-file:move` that puts the demo ledger into
 * a new sign-up's books, rebased for `today`.
 *
 * A move rather than an add because an add stages every transaction for
 * review, and the demo is a ledger somebody already kept. The key names the
 * day and the offset, so a second run on the same day replays the first
 * instead of being refused, and a run on another day — a different file —
 * passes over every entry already there by its origin. That second case
 * leaves the old dates in place, which is why the README says to start from a
 * fresh database.
 */
export function demoLedgerMove({ today, monthsBack = 0 }) {
  const file = rebaseLedgerFile(readDemoLedger(), { today, monthsBack });
  return {
    ledgerFile: JSON.stringify(file),
    fileName: "demo-ledger.json",
    idempotencyKey: `demo-ledger-${today}-${monthsBack}`,
  };
}
