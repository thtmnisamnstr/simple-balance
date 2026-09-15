#!/usr/bin/env node
/**
 * The population `docs/capacity.md` measures against.
 *
 *   node scripts/capacity/seed.mjs --scale 100        # a hundredth, to check the harness
 *   node scripts/capacity/seed.mjs                    # all ten thousand users
 *
 * Writes SQL rather than driving the API, because thirty million transactions
 * through the service is a load test rather than a setup step. That bypasses
 * the zero-sum check the service applies at write time
 * (`src/server/services/transactions.ts`, `assertBalanced`), so this script
 * ends by proving it produced a ledger that balances — see `verify.mjs`, which
 * runs automatically and refuses to leave a database nobody could trust a
 * measurement from.
 *
 * Every id is derived from a counter rather than generated, so a posting knows
 * its transaction and its account without a join or a returned value. That is
 * what lets each batch be one `INSERT ... SELECT generate_series`, computed
 * inside PostgreSQL, with nothing crossing the wire but the statement.
 */
import { argv, env, exit } from "node:process";
import pg from "pg";

import { COHORTS, scaled } from "./cohorts.mjs";
import { SCHEDULE } from "./schedule.mjs";
import { verify } from "./verify.mjs";

/**
 * `--scale N`, strictly.
 *
 * `Number(x) || 1` was the first spelling and it is a trap: `--scale 0`,
 * `--scale abc` and a bare `--scale` with nothing after it all become 1, which
 * is a full thirty-million-row seed taking most of an hour. The one command
 * here that costs real time should not be reachable by a typo.
 */
function readScale() {
  const at = argv.indexOf("--scale");
  if (at === -1) return 1;
  const raw = argv[at + 1];
  const value = Number(raw);
  if (raw === undefined || raw.startsWith("--") || !Number.isInteger(value) || value < 1) {
    console.error(
      `--scale takes a whole number of times smaller, at least 1. Got ${raw === undefined ? "nothing" : `"${raw}"`}.`,
    );
    exit(1);
  }
  return value;
}

const scale = readScale();
const cohorts = scale > 1 ? scaled(scale) : COHORTS;
const url = env.CAPACITY_DATABASE_URL ?? env.DATABASE_URL;
if (!url) {
  console.error("Set CAPACITY_DATABASE_URL (or DATABASE_URL) to a throwaway database.");
  exit(1);
}

/**
 * How many users each statement covers.
 *
 * Sized by rows rather than by users, because a heavy user is seventy-five
 * times an ordinary one and a fixed batch would be either trivial for the first
 * cohort or a statement building 150 million rows for the last.
 */
const ROWS_PER_BATCH = 2_000_000;

const KIND_ORDINAL = { income: 0, expense: 1, exchange: 2, equity: 3 };
const SYSTEM_NAMES = {
  income: "Income",
  expense: "Expenses",
  exchange: "Currency Exchange",
  equity: "Opening Balances",
};
/** Ordinals 0-7 are the system accounts; a user's own start here. */
const FIRST_USER_ACCOUNT_ORDINAL = 8;
const ACCOUNT_ORDINALS_PER_USER = 64;
/** Room for the six a voided-and-restored entry carries, and two spare. */
const POSTING_ORDINALS_PER_TRANSACTION = 8;

const uuid = (namespace, n) =>
  `('00000000-0000-4000-${namespace}000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
const accountUuid = (user, ordinal) =>
  uuid("a", `(${user} * ${ACCOUNT_ORDINALS_PER_USER} + ${ordinal})`);
const transactionUuid = (n) => uuid("b", n);
const postingUuid = (transaction, ordinal) =>
  uuid("c", `(${transaction} * ${POSTING_ORDINALS_PER_TRANSACTION} + ${ordinal})`);
/**
 * Opening postings get their own namespace, because they are numbered by
 * account and the entry postings are numbered by transaction — and the two
 * counters collide on the first batch. Found by the primary key rather than by
 * reading, which is the argument for keeping that key rather than deriving ids
 * nobody checks.
 */
const openingPostingUuid = (account, ordinal) => uuid("d", `(${account} * 2 + ${ordinal})`);

/**
 * One connection per worker, because the batches are independent by
 * construction: each covers its own range of users, and every id in it is
 * derived from that range rather than from a sequence. Nothing two workers
 * write can collide, which is what makes the seed a pool rather than a loop.
 *
 * Four by default. The limit is the disk rather than the cores — past about
 * four writers this becomes one write-ahead log being contended for, and the
 * total slows down.
 */
const WORKERS = Number(argv[argv.indexOf("--workers") + 1]) || 4;

async function connect() {
  const worker = new pg.Client({ connectionString: url });
  await worker.connect();
  // Per session, so every worker sets them for itself.
  await worker.query("set synchronous_commit = off");
  await worker.query("set maintenance_work_mem = '256MB'");
  return worker;
}

const client = new pg.Client({ connectionString: url });
const sql = async (text, values = []) => (await client.query(text, values)).rows;

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const say = (line) => console.log(`[${elapsed().padStart(6)}] ${line}`);

await client.connect();

/**
 * Off for this session only, and it is the one setting here that trades safety
 * for speed.
 *
 * It lets PostgreSQL acknowledge a commit before the write-ahead log reaches
 * the disk, which on a bulk load is most of the cost. What it risks is losing
 * the last few seconds of work if the machine loses power mid-seed — and the
 * answer to that is to run this again, because the thing being built is a
 * throwaway dataset. Nothing about the measurement afterwards runs under it.
 */
await sql("set synchronous_commit = off");
await sql("set maintenance_work_mem = '1GB'");

const existing = await sql(
  "select count(*)::int as n from auth_user where id like 'cap-%'",
);
if (existing[0].n > 0) {
  console.error(
    `This database already holds ${existing[0].n.toLocaleString()} capacity users. ` +
      "Seed a fresh one, or run scripts/capacity/reset.sql against this one first.",
  );
  await client.end();
  exit(1);
}

let userBase = 0;
let transactionBase = 0;
const plan = [];
for (const cohort of cohorts) {
  plan.push({ ...cohort, userFrom: userBase, transactionFrom: transactionBase });
  userBase += cohort.users;
  transactionBase += cohort.users * cohort.transactions;
}

say(
  `seeding ${userBase.toLocaleString()} users, ` +
    `${transactionBase.toLocaleString()} transactions` +
    (scale > 1 ? ` (1/${scale} scale)` : ""),
);

// Every batch in the whole run, planned before any of it is written, so the
// pool below can be a flat queue rather than a nest of loops that would leave a
// worker idle at the end of each cohort.
const batches = [];
for (const cohort of plan) {
  const rowsPerUser = cohort.transactions * 3.2 + cohort.accounts * 3;
  const perBatch = Math.max(1, Math.min(cohort.users, Math.floor(ROWS_PER_BATCH / rowsPerUser)));
  for (let from = 0; from < cohort.users; from += perBatch) {
    const count = Math.min(perBatch, cohort.users - from);
    batches.push({ cohort, u0: cohort.userFrom + from, u1: cohort.userFrom + from + count - 1 });
  }
}

// Largest first. The heavy cohort's batches are the long poles, and starting
// them last would leave three workers waiting on one at the end.
batches.sort((a, b) => b.cohort.transactions - a.cohort.transactions);
say(`${batches.length} batches across ${WORKERS} workers`);

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Math.min(WORKERS, batches.length) }, async () => {
    const worker = await connect();
    try {
      while (next < batches.length) {
        const batch = batches[next++];
        await seedUsers(worker, batch.cohort, batch.u0, batch.u1);
        done += 1;
        if (done % 10 === 0 || done === batches.length) {
          say(`${done}/${batches.length} batches`);
        }
      }
    } finally {
      await worker.end();
    }
  }),
);

await seedRecurrences();
say(`${SCHEDULE.dueRecurrences} recurrences due`);

await sql("analyze");
say("analyzed");

// Not optional and not a separate command somebody might skip. A seed that
// produced an unbalanced ledger has produced something the application could
// never have written, and every number measured against it would be describing
// a database that cannot exist.
say("verifying");
const { failures: failed } = await verify(client);
await client.end();
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed. This database is not a ledger.`);
  exit(1);
}
say("the seeded database balances");

/** One batch of users, complete: identity, accounts, categories, ledger. */
async function seedUsers(db, cohort, u0, u1) {
  const sql = (text) => db.query(text);
  const currencies = cohort.currencies;
  const users = `generate_series(${u0}, ${u1}) u`;

  await sql(`
    insert into auth_user (id, name, email, email_verified, created_at, updated_at)
    select 'cap-' || u, 'Capacity ' || u, 'cap' || u || '@capacity.invalid', true,
           now() - interval '2 years', now()
    from ${users}`);

  await sql(`
    insert into user_preferences (user_id, timezone, default_currency)
    select 'cap-' || u, 'UTC', '${currencies[0]}' from ${users}`);

  // The counter-accounts, one of each kind per currency, exactly as
  // `ensureSystemAccount` would have made them. A ledger missing these has
  // nowhere to put the other half of a deposit.
  const systemRows = currencies
    .flatMap((currency, c) =>
      Object.entries(KIND_ORDINAL).map(
        ([kind, k]) =>
          `(${c * 4 + k}, '${SYSTEM_NAMES[kind]} (${currency})', '${kind}', '${currency}')`,
      ),
    )
    .join(", ");
  await sql(`
    insert into ledger_account
      (id, user_id, name, type, system_kind, in_budget, currency, opening_date,
       opening_balance, version, created_at, updated_at)
    select ${accountUuid("u", "s.ord")}, 'cap-' || u, s.name, 'system',
           s.kind::system_account_kind, true, s.currency, date '1970-01-01', 0, 1,
           now() - interval '2 years', now()
    from ${users}
    cross join (values ${systemRows}) s(ord, name, kind, currency)`);

  // The person's own accounts. The heavy cohort's second currency is spread
  // across them rather than given its own user, so a per-currency total has
  // something to group by inside one ledger.
  const accountCurrency =
    currencies.length > 1
      ? `(array['${currencies.join("','")}'])[(a % ${currencies.length}) + 1]`
      : `'${currencies[0]}'`;
  await sql(`
    insert into ledger_account
      (id, user_id, name, type, system_kind, in_budget, currency, opening_date,
       opening_balance, version, created_at, updated_at)
    select ${accountUuid("u", `${FIRST_USER_ACCOUNT_ORDINAL} + a`)}, 'cap-' || u,
           'Account ' || (a + 1), 'checking', null, true, ${accountCurrency},
           date '2022-01-01', 250 + (a * 137 % 4000), 1,
           now() - interval '2 years', now()
    from ${users}
    cross join generate_series(0, ${cohort.accounts - 1}) a`);

  // The opening balance is posted, not stored as a number beside the ledger:
  // the account is credited and equity is debited, so the books net to zero
  // from the first row rather than starting from a figure kept outside them.
  await sql(`
    insert into posting
      (id, user_id, transaction_id, opening_account_id, account_id, date, amount,
       currency, created_at, updated_at)
    select ${openingPostingUuid(`(u * ${ACCOUNT_ORDINALS_PER_USER} + ${FIRST_USER_ACCOUNT_ORDINAL} + a)`, "side.i")},
           'cap-' || u, null,
           ${accountUuid("u", `${FIRST_USER_ACCOUNT_ORDINAL} + a`)},
           case side.i when 0
             then ${accountUuid("u", `${FIRST_USER_ACCOUNT_ORDINAL} + a`)}
             else ${accountUuid("u", `(a % ${currencies.length}) * 4 + ${KIND_ORDINAL.equity}`)}
           end,
           date '2022-01-01',
           (250 + (a * 137 % 4000)) * case side.i when 0 then 1 else -1 end,
           ${accountCurrency}, now() - interval '2 years', now()
    from ${users}
    cross join generate_series(0, ${cohort.accounts - 1}) a
    cross join generate_series(0, 1) side(i)`);

  await sql(`
    insert into category (id, user_id, name, kind, version, created_at, updated_at)
    select ${accountUuid("u", "40 + c.k")}, 'cap-' || u, c.name, c.kind::category_kind, 1,
           now() - interval '2 years', now()
    from ${users}
    cross join (values
      (0,'Groceries','expense'),(1,'Rent','expense'),(2,'Transport','expense'),
      (3,'Utilities','expense'),(4,'Dining','expense'),(5,'Health','expense'),
      (6,'Salary','income'),(7,'Interest','income')
    ) c(k, name, kind)`);

  await seedTransactions(db, cohort, u0, u1);
}

/**
 * The ledger itself, in one statement per table per batch.
 *
 * Both of the shapes that are not a plain two-posting write are produced here
 * rather than by a second pass, because a second pass over thirty million rows
 * costs more than the case distinction does:
 *
 * - One entry in five carries a later version and an audit row, which is what a
 *   renamed payee or a corrected note leaves behind. No posting: an edit that
 *   changes nothing about the movement writes nothing at all.
 * - One in twenty was deleted and restored, so it carries the original pair, a
 *   reversal, and the reversal reversed — six postings that net to the original
 *   two, on a row that reads as present because it is.
 */
async function seedTransactions(db, cohort, u0, u1) {
  const sql = (text) => db.query(text);
  const currencies = cohort.currencies;
  const perUser = cohort.transactions;
  const accounts = cohort.accounts;
  // Which global transaction index the first entry of user u0 has.
  const base = `${cohort.transactionFrom} + (u - ${cohort.userFrom}) * ${perUser}`;

  const currencyOf = (ordinal) =>
    currencies.length > 1
      ? `(array['${currencies.join("','")}'])[((${ordinal}) % ${currencies.length}) + 1]`
      : `'${currencies[0]}'`;
  const currencyIndex = (ordinal) =>
    currencies.length > 1 ? `((${ordinal}) % ${currencies.length})` : "0";

  // Everything an entry and its postings need, computed once. The amounts and
  // dates are arithmetic on the index rather than random, so seeding the same
  // scale twice produces the same database and a measurement can be repeated.
  const entries = `
    select
      u,
      i,
      (${base} + i) as t,
      (i % ${accounts}) as a,
      (case when i % 10 < 7 then 'withdrawal' else 'deposit' end) as kind,
      (date '2022-01-01' + ((i * 1093) % 1095)) as on_date,
      round(((i * 7919 % 38000) + 137) / 100.0, 2) as amount,
      (i % 5 = 0) as edited,
      (i % 20 = 0) as void_restored
    from generate_series(${u0}, ${u1}) u
    cross join generate_series(0, ${perUser - 1}) i`;

  await sql(`
    insert into ledger_transaction
      (id, user_id, type, date, description, payee, category_id,
       source_account_id, destination_account_id, source_amount, destination_amount,
       source_currency, destination_currency, version, created_at, updated_at, leg_count)
    select ${transactionUuid("e.t")}, 'cap-' || e.u, e.kind::transaction_type, e.on_date,
           case when e.i % 3 = 0 then 'Card payment ' || e.i else null end,
           'Merchant ' || (e.i % 400),
           ${accountUuid("e.u", "40 + case when e.kind = 'withdrawal' then e.i % 6 else 6 + (e.i % 2) end")},
           case when e.kind = 'withdrawal'
                then ${accountUuid("e.u", `${FIRST_USER_ACCOUNT_ORDINAL} + e.a`)} end,
           case when e.kind = 'deposit'
                then ${accountUuid("e.u", `${FIRST_USER_ACCOUNT_ORDINAL} + e.a`)} end,
           case when e.kind = 'withdrawal' then e.amount end,
           case when e.kind = 'deposit' then e.amount end,
           case when e.kind = 'withdrawal' then ${currencyOf("e.a")} end,
           case when e.kind = 'deposit' then ${currencyOf("e.a")} end,
           case when e.edited then 2 else 1 end,
           e.on_date, e.on_date, 0
    from (${entries}) e`);

  await sql(`
    insert into posting
      (id, user_id, transaction_id, account_id, date, amount, currency, created_at, updated_at)
    select ${postingUuid("e.t", "p.j")}, 'cap-' || e.u, ${transactionUuid("e.t")},
           case when p.j % 2 = 0
             then ${accountUuid("e.u", `${FIRST_USER_ACCOUNT_ORDINAL} + e.a`)}
             else ${accountUuid(
               "e.u",
               `${currencyIndex("e.a")} * 4 + case when e.kind = 'withdrawal' then ${KIND_ORDINAL.expense} else ${KIND_ORDINAL.income} end`,
             )}
           end,
           e.on_date,
           -- The entry's own direction, then which side of it this posting is,
           -- then whether this pair is the void or the restore. Multiplied out,
           -- every currency sums to zero however many pairs there are.
           e.amount
             * (case when e.kind = 'withdrawal' then -1 else 1 end)
             * (case when p.j % 2 = 0 then 1 else -1 end)
             * (case when p.j in (2, 3) then -1 else 1 end),
           ${currencyOf("e.a")}, e.on_date, e.on_date
    from (${entries}) e
    cross join lateral generate_series(0, case when e.void_restored then 5 else 1 end) p(j)`);

  await sql(`
    insert into audit_event
      (id, user_id, actor_source, entity_type, entity_id, operation, before, after, created_at)
    select ${uuid("e", "e.t")}, 'cap-' || e.u, 'web', 'transaction',
           ${transactionUuid("e.t")}::text, 'update',
           jsonb_build_object('payee', 'Merchant ' || (e.i % 400), 'version', 1),
           jsonb_build_object('payee', 'Merchant ' || (e.i % 400), 'version', 2),
           e.on_date
    from (${entries}) e
    where e.edited`);
}

/**
 * Recurrences the scheduler will find due the moment it ticks.
 *
 * Without these the sweep runs every five minutes, finds an empty list, and
 * costs nothing — which would leave the proof silent about the one piece of
 * work this profile does on a timer while people are using it. The scheduler
 * shares the process with the API here, so what it costs is taken out of the
 * same half-core answering requests.
 *
 * `next_occurrence_date` is in the past, which is what due means. The shape is
 * a withdrawal against the user's first account, because a proposal whose
 * account does not resolve becomes an issue on the staged row rather than a
 * proposal — still work, but not the work being measured.
 */
async function seedRecurrences() {
  const spread = Math.max(1, Math.floor(userBase / SCHEDULE.dueRecurrences));
  await sql(`
    insert into recurrence
      (id, user_id, name, shape, frequency, "interval", anchor_date, month_policy,
       weekend_policy, proposes_from, next_occurrence_date, version,
       created_at, updated_at, notify_on_create)
    select ${uuid("f", "u")}, 'cap-' || u, 'Rent ' || u,
           jsonb_build_object(
             'type', 'withdrawal',
             'payee', 'Landlord',
             'fromAccountId', ${accountUuid("u", FIRST_USER_ACCOUNT_ORDINAL)}::text,
             'amount', '1200.00'
           ),
           'monthly', 1, date '2024-01-01', 'last_day', 'next_business_day',
           date '2024-01-01', date '2024-02-01', 1,
           now() - interval '1 year', now(), false
    from generate_series(0, ${userBase - 1}) u
    where u % ${spread} = 0
    limit ${SCHEDULE.dueRecurrences}`);
}
