#!/usr/bin/env node
/**
 * Proves the seeded database is a ledger before anybody measures against it.
 *
 *   node scripts/capacity/verify.mjs
 *
 * `seed.mjs` writes SQL, which is the only way to build thirty million entries
 * in a sensible time and also the reason this file exists: writing SQL steps
 * around `assertBalanced` in `src/server/services/transactions.ts`, which is
 * what normally makes it impossible to store an entry that does not settle to
 * zero. A capacity number measured against a ledger that does not balance
 * measures nothing — the queries would be reading rows the application could
 * never have written, and the shape of a real one is exactly what the index
 * behaviour depends on.
 *
 * So: every check below is one the service would have enforced on the way in.
 */
import { env, exit } from "node:process";
import pg from "pg";

const failures = [];
const check = (ok, description, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${description}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(description);
};

export async function verify(client) {
  const one = async (text) => (await client.query(text)).rows;

  // The whole ledger, by currency. This is the check the service makes on every
  // single write, applied once to everything that was written.
  const totals = await one(
    "select currency, sum(amount) as total, count(*)::bigint as postings from posting group by currency order by currency",
  );
  check(totals.length > 0, "there are postings to check", `${totals.length} currencies`);
  for (const row of totals) {
    check(
      Number(row.total) === 0,
      `${row.currency} settles to zero`,
      `${Number(row.postings).toLocaleString()} postings, total ${row.total}`,
    );
  }

  // And per person, which is the stronger statement: a population can balance
  // overall while two users' books are each wrong by the same amount and
  // opposite in sign, and no query the application runs would ever show it.
  const unbalanced = await one(`
    select user_id, currency, sum(amount) as total
    from posting group by user_id, currency having sum(amount) <> 0 limit 5`);
  check(
    unbalanced.length === 0,
    "every user's books settle to zero in every currency they touch",
    unbalanced.length === 0 ? "all users" : JSON.stringify(unbalanced),
  );

  // A sampled trial balance: for twenty users, what the application would
  // compute as each account's balance, summed, against zero.
  const sampled = await one(`
    with sample as (select id from auth_user where id like 'cap-%' order by id limit 20)
    select p.user_id, p.currency, sum(p.amount) as total
    from posting p join sample s on s.id = p.user_id
    group by p.user_id, p.currency`);
  check(
    sampled.length > 0 && sampled.every((row) => Number(row.total) === 0),
    "a sampled trial balance comes to zero",
    `${sampled.length} user-currency pairs`,
  );

  // A posting names an account of the same owner, in the account's own
  // currency. The schema's composite foreign key says so; this says the data
  // agrees, because the seed can disable those triggers and a future one might.
  const mismatched = await one(`
    select count(*)::bigint as n from posting p
    join ledger_account a on a.id = p.account_id
    where a.user_id <> p.user_id or a.currency <> p.currency`);
  check(
    Number(mismatched[0].n) === 0,
    "every posting names an account of its own owner and currency",
    `${mismatched[0].n} mismatched`,
  );

  const orphans = await one(`
    select count(*)::bigint as n from posting p
    where p.transaction_id is not null
      and not exists (select 1 from ledger_transaction t where t.id = p.transaction_id)`);
  check(Number(orphans[0].n) === 0, "no posting names a transaction that is not there");

  // Every entry posted at least the pair it has to, and the voided-and-restored
  // ones carry six rather than four — four would be an entry that was deleted
  // and never brought back, which reads as present and is not.
  const shapes = await one(`
    select n, count(*)::bigint as entries from (
      select transaction_id, count(*)::int as n from posting
      where transaction_id is not null group by transaction_id
    ) s group by n order by n`);
  check(
    shapes.every((row) => row.n === 2 || row.n === 6),
    "every entry carries two postings, or six if it was voided and restored",
    shapes.map((row) => `${row.n}x${Number(row.entries).toLocaleString()}`).join(" "),
  );

  /**
   * And that an entry moved the amount it says it moved.
   *
   * Zero-sum does not catch this, which is the whole reason it is here. A
   * voided-and-restored entry carries three pairs — the original, its reversal,
   * and the reversal reversed — and *every* arrangement of three pairs sums to
   * zero, including three identical ones. Three identical pairs is not an entry
   * that was voided and restored; it is the same withdrawal made three times,
   * and the account balance is three times what it should be while every
   * currency still totals zero.
   *
   * Found by mutation: removing the sign flip from the generator's reversal pair
   * left every balance check passing.
   *
   * Sampled rather than exhaustive. The join is over both large tables and the
   * population is thirty million entries; fifty thousand of them settles the
   * question and takes a second.
   */
  const drifted = await one(`
    with sampled as (
      select id, type, coalesce(source_amount, destination_amount) as stated
      from ledger_transaction
      where type <> 'transfer'
      order by id limit 50000
    )
    select count(*)::bigint as n from (
      select s.id, s.type, s.stated, sum(p.amount) as moved
      from sampled s
      join posting p on p.transaction_id = s.id
      join ledger_account a on a.id = p.account_id and a.system_kind is null
      group by s.id, s.type, s.stated
    ) m
    where (m.type = 'withdrawal' and m.moved <> -m.stated)
       or (m.type = 'deposit' and m.moved <> m.stated)`);
  check(
    Number(drifted[0].n) === 0,
    "every entry moved the amount it says it moved",
    `${drifted[0].n} disagree in a sample of 50,000`,
  );

  // Opening balances are posted rather than stored beside the ledger, so an
  // account with an opening balance and no opening postings is a balance the
  // books do not contain.
  const openings = await one(`
    select count(*)::bigint as n from ledger_account a
    where a.system_kind is null and a.opening_balance <> 0
      and not exists (select 1 from posting p where p.opening_account_id = a.id)`);
  check(Number(openings[0].n) === 0, "every opening balance was posted");

  const counts = await one(`
    select
      (select count(*) from auth_user where id like 'cap-%') as users,
      (select count(*) from ledger_account) as accounts,
      (select count(*) from ledger_transaction) as transactions,
      (select count(*) from posting) as postings,
      pg_size_pretty(pg_database_size(current_database())) as size`);
  const c = counts[0];
  console.log(
    `\n  ${Number(c.users).toLocaleString()} users, ` +
      `${Number(c.accounts).toLocaleString()} accounts, ` +
      `${Number(c.transactions).toLocaleString()} transactions, ` +
      `${Number(c.postings).toLocaleString()} postings, ${c.size} on disk`,
  );
  return { failures: [...failures], counts: c };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = env.CAPACITY_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    console.error("Set CAPACITY_DATABASE_URL (or DATABASE_URL).");
    exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { failures: failed } = await verify(client);
  await client.end();
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed. This database is not a ledger.`);
    exit(1);
  }
  console.log("\nThe seeded database balances.");
}
