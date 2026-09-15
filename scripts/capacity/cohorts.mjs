/**
 * The population the capacity proof is about, in one place because three things
 * read it: the generator that creates it, the driver that picks users out of
 * it, and `docs/capacity.md`, which `tests/capacity-cohorts.test.ts` holds to
 * these numbers.
 *
 * Three cohorts rather than ten thousand identical users, because the shape of
 * the load depends on it. A query that is fast against a thousand transactions
 * and slow against seventy-five thousand is invisible in a population where
 * everybody has the same amount — and the tail is where the index either works
 * or does not.
 */
export const COHORTS = [
  // Somebody who keeps a household ledger: a current account, a savings
  // account, and two cards, with a few years of entries.
  { name: "household", users: 8_500, accounts: 4, transactions: 1_000, currencies: ["USD"] },
  // A sole trader or a couple running joint finances properly.
  { name: "engaged", users: 1_400, accounts: 10, transactions: 10_000, currencies: ["USD"] },
  // The tail: a small business with years of imported statements. A hundred of
  // them is a quarter of all the transactions in the population, which is the
  // point — these are the users a p99 is made of.
  { name: "heavy", users: 100, accounts: 20, transactions: 75_000, currencies: ["USD", "EUR"] },
];

/**
 * How many entries are not a plain two-posting write.
 *
 * Both defeat a single bulk statement, which is why the generator stages its
 * work instead of issuing one INSERT per table.
 *
 * A non-monetary edit — a renamed payee, a changed note — bumps the row's
 * version and writes an audit entry and no posting at all, because an edit that
 * changes nothing about the movement writes nothing. A void and restore appends
 * a reversal and then appends it back, so the entry nets to zero twice and
 * carries six postings rather than two while reading as present.
 */
export const NON_MONETARY_EDIT_RATE = 0.2;
export const VOID_RESTORE_RATE = 0.05;

/** Postings per transaction, on average, which is what sizes the disk. */
export const POSTINGS_PER_TRANSACTION = 2 * (1 - VOID_RESTORE_RATE) + 6 * VOID_RESTORE_RATE;

export const TOTAL_USERS = COHORTS.reduce((sum, c) => sum + c.users, 0);
export const TOTAL_ACCOUNTS = COHORTS.reduce((sum, c) => sum + c.users * c.accounts, 0);
export const TOTAL_TRANSACTIONS = COHORTS.reduce((sum, c) => sum + c.users * c.transactions, 0);
export const TOTAL_POSTINGS = Math.round(TOTAL_TRANSACTIONS * POSTINGS_PER_TRANSACTION);

/**
 * A fraction of the population, for proving the harness without seeding
 * thirty million rows. `--scale 100` gives a hundredth of every cohort and
 * keeps the shape: the heavy users stay heavy.
 */
export function scaled(scale) {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`--scale is a whole number of times smaller, at least 1. Got ${scale}.`);
  }
  return COHORTS.map((cohort) => ({
    ...cohort,
    // At least one user per cohort however small the scale, because a cohort
    // that rounds to nobody is a cohort the proof silently stopped covering.
    users: Math.max(1, Math.round(cohort.users / scale)),
  }));
}
