/**
 * The idempotency key a seeded entry is posted under, so a re-run of the kit
 * against the same database replays it rather than posting it again.
 *
 * Keyed on the calendar month the entry belongs to and its place in
 * `seed.entries`, never on its date. `build.mjs` clamps a day still ahead of
 * today to today, so a clamped entry's date moves on every day the kit is run,
 * and keying on the date gave each such row a fresh key and a second posting.
 * Once the month turned, every date in the history had moved and the whole
 * history went in twice — inflating every figure in the marketing pictures
 * with nothing on screen to show it.
 *
 * The month is the unclamped one, because it is the part that does not move.
 * Nor is it `monthsAgo`: after the month turns, "one month ago" names what
 * "this month" named before, so the current month would replay last month's
 * keys and post nothing at all. An entry whose clamped date has moved since it
 * was posted meets its own key with a different body and is refused, which is
 * the row already being there.
 *
 * Its own module, free of Playwright and of anything that needs `tsx`, so
 * `tests/product-kit-entry-key.test.ts` can hold it without a browser.
 */
export function entryKey(today, monthsAgo, entryIndex) {
  const start = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
  const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return `kit-${month}-${entryIndex}`;
}
