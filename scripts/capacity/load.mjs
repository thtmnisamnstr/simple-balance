#!/usr/bin/env node
/**
 * The load the capacity proof applies, and the measurement it takes.
 *
 *   CAPACITY_BASE_URL=http://127.0.0.1:3100 node scripts/capacity/load.mjs
 *   ... --minutes 5 --rps 10 --no-imports      # a short rehearsal
 *
 * Run after `seed.mjs` and `credentials.mjs`. `docs/capacity.md` is the
 * schedule, the mix and the thresholds in prose; this file is the same thing
 * executable, and `tests/capacity-schedule.test.ts` holds the two together.
 *
 * Requests are fired on a clock rather than as fast as replies come back. That
 * is the difference between measuring a system and measuring your own patience:
 * a closed loop slows its own offered rate the moment the server slows down, so
 * the queue never builds and the tail the proof exists to find never appears.
 * Latency here is from the moment a request was *due* to the moment it
 * finished, which is what somebody waiting actually experiences.
 */
import { argv, env, exit } from "node:process";
import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pg from "pg";

import { TOTAL_USERS } from "./cohorts.mjs";
import { CAPACITY_PASSWORD } from "./credentials.mjs";
import { buildWheel, errorsIn, percentile } from "./measure.mjs";
import { MIX, SCHEDULE, THRESHOLDS } from "./schedule.mjs";

/**
 * `--name value`, strictly.
 *
 * A missing or non-numeric value used to become `NaN`, and `NaN` propagates
 * silently: `--minutes` with nothing after it made the loop's own condition
 * false, so the run dispatched no requests at all and failed at the end for a
 * reason that had nothing to do with the machine. Refusing here names the flag.
 */
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const raw = argv[at + 1];
  const value = Number(raw);
  if (raw === undefined || raw.startsWith("--") || !Number.isFinite(value) || value < 0) {
    console.error(`--${name} takes a number. Got ${raw === undefined ? "nothing" : `"${raw}"`}.`);
    exit(1);
  }
  return value;
};
const base = env.CAPACITY_BASE_URL ?? "http://127.0.0.1:3000";
const minutes = flag("minutes", SCHEDULE.measureMinutes);
const warmupMinutes = flag("warmup", SCHEDULE.warmupMinutes);
const rps = flag("rps", SCHEDULE.rps);
const burstRps = flag("burst-rps", SCHEDULE.burstRps);
const users = flag("users", SCHEDULE.virtualUsers);
const withImports = !argv.includes("--no-imports");
// Rehearsable. The import phase starts twenty minutes into the real schedule,
// which makes the one part of the run most likely to be misconfigured also the
// part nobody checks before committing to seventy minutes — and it was: the
// first full run spent its import phase collecting ten 422s.
const importsAt = flag("imports-at", SCHEDULE.importsAtMinute);
const metricsToken = env.METRICS_TOKEN ?? "";
const databaseUrl = env.CAPACITY_DATABASE_URL ?? env.DATABASE_URL;
const TOTAL_SEEDED = Number(env.CAPACITY_USERS) || TOTAL_USERS;
const run = promisify(execFile);

const started = Date.now();
const elapsed = () => (Date.now() - started) / 1000;
const say = (line) => console.log(`[${elapsed().toFixed(0).padStart(5)}s] ${line}`);

/* ------------------------------------------------------------ the users --- */

/**
 * Who the pool is drawn from: a random sample of whoever was actually seeded.
 *
 * Asked of the database rather than derived from the id scheme, because the
 * driver having its own opinion about what the seeder named things is a bug
 * waiting for the day somebody changes one of them. It also means a partial or
 * a scaled seed works without being told.
 *
 * Random rather than the first N, and that is the load-bearing part. The front
 * of the population is eight and a half thousand household ledgers; a pool
 * taken from there would never touch a user with seventy-five thousand
 * transactions, which is exactly where the tail of every percentile in this
 * proof comes from. A uniform sample includes heavy users in the proportion
 * there are heavy users, which is what a busy hour actually looks like.
 */
async function sampleUsers(total) {
  if (!databaseUrl) return null;
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select u.id, u.email from auth_user u
       join auth_account a on a.user_id = u.id and a.provider_id = 'credential'
       where u.id like 'cap-%'
       order by md5(u.id) limit $1`,
      [total],
    );
    return rows;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

async function signIn(total) {
  const sampled = await sampleUsers(total);
  if (sampled && sampled.length > 0) return signInEach(sampled);
  say("no database to sample from; deriving ids from the seeding scheme");
  return signInEach(
    Array.from({ length: total }, (_, i) => {
      const n = Math.floor((i * 9973) % TOTAL_SEEDED);
      return { id: `cap-${n}`, email: `cap${n}@capacity.invalid` };
    }),
  );
}

/**
 * How many sign-ins are in flight at once.
 *
 * Firing all five hundred together fails about one in eight, and the reason is
 * worth knowing rather than working around: verifying a password is deliberately
 * expensive, each verification holds a database connection while it runs, and
 * the application's pool is ten. Five hundred at once exhausts it and the
 * overflow times out waiting — "Connection terminated due to connection
 * timeout", on the query that reads the credential.
 *
 * That is not a defect and it is not what this proof measures. Real sign-ins
 * arrive spread across a morning, not in one burst from one script, and a run
 * that quietly started with 438 of its documented 500 sessions would be
 * reporting a schedule it did not follow. Twenty at a time fills the pool
 * without queueing past it.
 */
const SIGN_IN_CONCURRENCY = 20;

async function signInEach(people) {
  const pool = [];
  const failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SIGN_IN_CONCURRENCY, people.length) }, async () => {
      while (next < people.length) {
        const i = next++;
        await signInOne(people[i], i, pool, failures);
      }
    }),
  );
  if (pool.length === 0) {
    console.error(`No user could sign in. First failures: ${failures.slice(0, 3).join("; ")}`);
    exit(1);
  }
  if (failures.length > 0) say(`${failures.length} of ${people.length} could not sign in`);
  return pool;
}

async function signInOne(person, i, pool, failures) {
  // Its own address, because sign-in attempts are counted per client address and
  // the whole run arrives from one machine. The deployment under test trusts the
  // header; without that, the fifth of these is refused and the pool is four
  // people.
  const address = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${(i % 254) + 1}`;
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-Forwarded-For": address },
    body: JSON.stringify({ email: person.email, password: CAPACITY_PASSWORD }),
  });
  if (!response.ok) {
    failures.push(`${person.id}: ${response.status} ${(await response.text()).slice(0, 80)}`);
    return;
  }
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(";")[0])
    .join("; ");
  pool.push({ id: person.id, address, cookie, accounts: [], transactions: [] });
}

/** What each virtual user needs to make a realistic request: their own rows. */
async function warmUser(user) {
  // A bare array, not an envelope — and it already excludes the
  // counter-accounts, which never appear in a list or a picker. Read off a real
  // response rather than assumed: the first spelling of this looked for
  // `.accounts`, found nothing, and reported that nobody had an account.
  const accounts = await get(user, "/api/v1/accounts");
  user.accounts = (Array.isArray(accounts) ? accounts : [])
    .filter((a) => !a.systemKind)
    .map((a) => ({ id: a.id, currency: a.currency }));
  // This one is paged, so it is an envelope: `items` plus the cursor and the
  // counts the register's footer shows.
  const page = await get(user, "/api/v1/transactions?limit=25");
  // The whole entry, not just its id: an edit is a PUT of a complete draft
  // rather than a patch of one field, so the driver has to be able to send back
  // what is already there with one thing changed.
  user.transactions = (page?.items ?? [])
    .filter((t) => t.legCount === 0 && t.type !== "transfer")
    .map((t) => ({
      id: t.id,
      version: t.version,
      type: t.type,
      date: t.date,
      payee: t.payee,
      categoryId: t.categoryId,
      accountId: t.type === "deposit" ? t.destinationAccountId : t.sourceAccountId,
      amount: t.type === "deposit" ? t.destinationAmount : t.sourceAmount,
    }));
}

/* --------------------------------------------------------- the requests --- */

const headersFor = (user, extra = {}) => ({
  Cookie: user.cookie,
  Origin: base,
  "X-Forwarded-For": user.address,
  ...extra,
});

async function get(user, path) {
  const response = await fetch(`${base}${path}`, { headers: headersFor(user) });
  if (!response.ok) return null;
  return response.json();
}

/**
 * One request of the mix, chosen by weight. Every arm returns the response so
 * the caller can record its status; none of them throws, because a driver that
 * falls over on the first 500 measures nothing about how often 500s happen.
 */
async function fire(user, kind) {
  const h = headersFor(user);
  switch (kind) {
    case "register":
      // The page people live on, and the one the keyset cursor exists for.
      return fetch(`${base}/api/v1/transactions?limit=50&order=date&direction=desc`, { headers: h });
    case "summary":
      return fetch(`${base}/api/v1/summary`, { headers: h });
    case "accounts": {
      const account = pick(user.accounts);
      return account
        ? fetch(`${base}/api/v1/accounts/${account.id}/balances`, { headers: h })
        : fetch(`${base}/api/v1/accounts`, { headers: h });
    }
    case "report":
      return fetch(`${base}/api/v1/reports/${pick(SCHEDULE.reports)}`, { headers: h });
    case "budget":
      return fetch(`${base}/api/v1/budget-report`, { headers: h });
    case "write": {
      const account = pick(user.accounts);
      if (!account) return fetch(`${base}/api/v1/accounts`, { headers: h });
      return fetch(`${base}/api/v1/transactions`, {
        method: "POST",
        headers: headersFor(user, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          draft: {
            type: "withdrawal",
            date: "2024-06-01",
            payee: `Load ${randomInt(1000)}`,
            fromAccountId: account.id,
            amount: "12.34",
            categoryName: "Groceries",
            categoryKind: "expense",
          },
        }),
      });
    }
    case "edit": {
      const entry = pick(user.transactions);
      if (!entry) return fetch(`${base}/api/v1/transactions?limit=10`, { headers: h });
      // A rename, which is the non-monetary edit the population is one fifth
      // made of: it bumps the version and writes no posting at all, because an
      // edit that changes nothing about the movement writes nothing.
      //
      // PUT with a whole draft, not PATCH with one field. The first spelling of
      // this used PATCH, which is not a route — so every edit in the run
      // answered 404, and 404 is not an error by the threshold's definition, so
      // the run passed while a twentieth of it did nothing at all.
      const response = await fetch(`${base}/api/v1/transactions/${entry.id}`, {
        method: "PUT",
        headers: headersFor(user, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          expectedVersion: entry.version,
          draft: {
            type: entry.type,
            date: entry.date,
            payee: `Renamed ${randomInt(1000)}`,
            categoryId: entry.categoryId,
            ...(entry.type === "deposit"
              ? { toAccountId: entry.accountId }
              : { fromAccountId: entry.accountId }),
            amount: entry.amount,
          },
        }),
      });
      // The version moved, so the cached one is now stale. Left alone, every
      // later edit of this entry answers 409 — which is a real answer to a real
      // question and exactly the wrong thing to spend 5% of a run on.
      if (response.ok) entry.version += 1;
      return response;
    }
    default:
      throw new Error(`unknown request kind ${kind}`);
  }
}

/**
 * One of a list, uniformly.
 *
 * `randomInt` rather than `Math.random`, and the reason is a linter rather than
 * a requirement: nothing this driver randomizes is a secret — which request to
 * fire, which account to touch, what to rename a payee to — so `Math.random`
 * was correct and CodeQL's `js/insecure-randomness` flagged all four uses
 * anyway. The rule cannot tell a load generator from a token mint. Swapping it
 * costs nothing at three hundred draws a second and is cheaper than arguing.
 */
const pick = (list) => (list.length === 0 ? undefined : list[randomInt(list.length)]);

/** The mix, expanded once into a lookup so choosing is one random number. */
const WHEEL = buildWheel(MIX);

/* ------------------------------------------------------------- the clock --- */

/**
 * Fires requests on a schedule and records what each one cost.
 *
 * `due` advances by the interval whether or not the previous request has come
 * back, and latency is measured from `due` rather than from dispatch. That is
 * the whole point: if the server slows to half the offered rate, the queue
 * grows and every sample carries the wait, which is what the person refreshing
 * the page is actually experiencing. A loop that waited for each reply would
 * quietly reduce its own offered load and report that everything was fine.
 */
async function drive({ seconds, rateAt, phaseAt, pool, record, label }) {
  const begin = Date.now();
  let due = begin;
  let dispatched = 0;
  const inFlight = new Set();

  while (Date.now() - begin < seconds * 1000) {
    const second = (Date.now() - begin) / 1000;
    const interval = 1000 / rateAt(second);
    due += interval;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);

    const user = pool[dispatched % pool.length];
    const kind = WHEEL[randomInt(WHEEL.length)];
    const dueAt = due;
    // Which arm of the schedule this request belongs to, decided when it is
    // dispatched rather than when it returns — a request issued during the
    // burst belongs to the burst however long it takes to come back.
    const phase = phaseAt(second);
    dispatched += 1;

    const task = (async () => {
      let status = 0;
      try {
        const response = await fire(user, kind);
        status = response.status;
        // Drained, because an unread body holds the socket and the next
        // request queues behind it — which would show up as latency the
        // server never caused.
        await response.arrayBuffer();
      } catch {
        status = 0;
      }
      record(kind, status, Date.now() - dueAt, label === "warmup" ? "warmup" : phase);
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }
  // The set is iterated synchronously here, before any pending task can get a
  // microtask to remove itself, so there is nothing to copy.
  await Promise.allSettled(inFlight);
  return dispatched;
}

/* ------------------------------------------------------------ the extras --- */

/**
 * The largest CSV the product accepts, in the format it round-trips.
 *
 * Built from a real export rather than from a header written out here, and that
 * is the whole design. The import only recognizes a file as one of its own when
 * *every* one of the nineteen app columns is present, and the format marker is
 * a version string rather than a number. A hand-written header got both wrong —
 * fourteen columns and a `1` — so all ten imports in the first full run came
 * back 422 "Map the columns this file uses", and the report showed ten fast
 * imports rather than ten refusals.
 *
 * Asking the application for one row of its own export and cloning it cannot
 * drift: a column added to the format appears here the next time it runs.
 */
async function exportTemplate(user) {
  const response = await fetch(`${base}/api/v1/csv/export?limit=1`, { headers: headersFor(user) });
  if (!response.ok) return null;
  const text = await response.text();
  const [header, ...rows] = text.split("\n").filter((line) => line.trim().length > 0);
  if (!header || rows.length === 0) return null;
  return { header, row: rows[0], columns: header.split(",") };
}

/**
 * Both caps at once, which is the point: `CSV_MAX_ROWS` is 10,000 and
 * `CSV_MAX_BYTES` is 10 MB, and an import of ten thousand short rows is a
 * megabyte — a tenth of the work the schedule says it applies. The note column
 * is padded so the file lands just under the byte cap with the row cap met.
 *
 * Just under, deliberately. At or over, the server refuses it and the run
 * measures ten rejections instead of ten imports.
 */
function buildCsv(template, targetBytes = 10_000_000) {
  const notesAt = template.columns.indexOf("notes");
  const payeeAt = template.columns.indexOf("payee");
  const dateAt = template.columns.indexOf("date");
  // The id has to be blank or every row is an update of the same entry.
  const idAt = template.columns.indexOf("transaction_id");
  const cells = template.row.split(",");

  const row = (i, note) => {
    const copy = [...cells];
    if (idAt >= 0) copy[idAt] = "";
    if (payeeAt >= 0) copy[payeeAt] = `Import payee ${i}`;
    if (dateAt >= 0) copy[dateAt] = `2024-03-${String((i % 28) + 1).padStart(2, "0")}`;
    if (notesAt >= 0) copy[notesAt] = note;
    return copy.join(",");
  };

  const rows = 10_000;
  const bare = row(0, "").length + 1;
  const padding = Math.max(0, Math.floor((targetBytes - template.header.length) / rows) - bare);
  const note = "n".repeat(padding);
  return [template.header, ...Array.from({ length: rows }, (_, i) => row(i, note))].join("\n");
}

async function runImports(pool, count, rows, record) {
  const users = pool.filter((u) => u.accounts.length > 0).slice(0, count);
  const template = users.length > 0 ? await exportTemplate(users[0]) : null;
  if (!template) {
    say("no export to build an import from; skipping the import phase");
    return;
  }
  const csv = buildCsv(template);
  importsRunning = true;
  say(
    `${users.length} concurrent imports of ${csv.split("\n").length - 1} rows, ` +
      `${(csv.length / 1e6).toFixed(1)} MB each`,
  );
  await Promise.allSettled(
    users.map(async (user) => {
      const at = Date.now();
      try {
        const response = await fetch(`${base}/api/v1/csv/stage`, {
          method: "POST",
          headers: headersFor(user, { "Content-Type": "application/json" }),
          // `fileName` and `defaultAccountId` are required; no `mapping` is
          // sent because the file is an export and its columns are known.
          body: JSON.stringify({
            csv,
            fileName: `capacity-${user.id}.csv`,
            defaultAccountId: user.accounts[0].id,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        await response.arrayBuffer();
        record("import", response.status, Date.now() - at, "import");
      } catch {
        record("import", 0, Date.now() - at, "import");
      }
    }),
  );
  importsRunning = false;
}

/* ------------------------------------------------------- what was measured --- */

/**
 * How much of its *allowance* each container is using.
 *
 * `docker stats` reports CPU against one core, so a container using six cores
 * of an eleven-core machine reads as 620% — a number that means nothing against
 * a threshold and everything against a limit. The proof is about a two-vCPU
 * machine, so the figure that matters is the share of the 1.5 and 0.5 cores
 * `compose.limits.yml` grants, and that is what this returns.
 *
 * An unlimited container falls back to the raw percentage and says so, because
 * silently dividing by the host's core count would make the seeding phase look
 * comfortable when it is saturating the disk.
 */
const cpuLimits = new Map();
async function cpuLimitOf(name) {
  if (cpuLimits.has(name)) return cpuLimits.get(name);
  let cores = 0;
  try {
    const { stdout } = await run("docker", ["inspect", name, "--format", "{{.HostConfig.NanoCpus}}"]);
    cores = Number(stdout.trim()) / 1e9;
  } catch {
    cores = 0;
  }
  cpuLimits.set(name, cores);
  return cores;
}

async function containerStats() {
  try {
    const { stdout } = await run("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}",
    ]);
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("simple-balance"));
    return Promise.all(
      lines.map(async (line) => {
        const [name, cpu, mem, usage] = line.split("\t");
        const cores = await cpuLimitOf(name);
        const raw = Number.parseFloat(cpu);
        return {
          name,
          // Of the limit where there is one; of a single core where there is not.
          cpu: cores > 0 ? raw / cores : raw,
          limited: cores > 0,
          memory: Number.parseFloat(mem),
          usage,
        };
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The application's own view, which answers a different question from the
 * driver's.
 *
 * The histogram here starts when the server received the request and ends when
 * it replied, so it excludes the client, the loopback and any time a request
 * spent queued in the driver. A gap between the two is the harness; agreement
 * means the numbers are the product's.
 */
async function serverPercentiles() {
  try {
    const response = await fetch(`${base}/metrics`, {
      headers: metricsToken ? { Authorization: `Bearer ${metricsToken}` } : {},
    });
    if (!response.ok) return null;
    const text = await response.text();
    const buckets = new Map();
    let total = 0;
    for (const line of text.split("\n")) {
      const bucket = /^simple_balance_http_request_duration_seconds_bucket\{[^}]*le="([^"]+)"[^}]*\}\s+(\d+)/.exec(line);
      if (bucket) {
        const le = Number(bucket[1]);
        buckets.set(le, (buckets.get(le) ?? 0) + Number(bucket[2]));
        continue;
      }
      const count = /^simple_balance_http_request_duration_seconds_count\{[^}]*\}\s+(\d+)/.exec(line);
      if (count) total += Number(count[1]);
    }
    if (total === 0) return null;
    const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const at = (p) => {
      const target = total * (p / 100);
      for (const [le, cumulative] of ordered) if (cumulative >= target) return le * 1000;
      return Infinity;
    };
    // Bucket boundaries, so these are upper bounds rather than exact figures.
    // Said plainly in the report for the same reason.
    return { total, p50: at(50), p95: at(95), p99: at(99) };
  } catch {
    return null;
  }
}

/**
 * How full the disk the database is on has got.
 *
 * Asked of the container rather than the host, because the number that matters
 * is the one PostgreSQL will hit — a bind mount onto a 2 TB laptop disk says
 * nothing about a 20 GiB data volume, and the profile puts the database on the
 * latter.
 */
async function diskUsage() {
  try {
    const { stdout } = await run("docker", [
      "exec",
      "simple-balance-postgres-1",
      "df",
      "-P",
      "/var/lib/postgresql/data",
    ]);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const used = /(\d+)%/.exec(line);
    return used ? Number(used[1]) : null;
  } catch {
    return null;
  }
}

async function databaseState() {
  if (!databaseUrl) return null;
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query(`
      select
        (select count(*) from pg_stat_activity where datname = current_database()) as connections,
        (select setting::int from pg_settings where name = 'max_connections') as max_connections,
        pg_size_pretty(pg_database_size(current_database())) as size`);
    return rows[0];
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ------------------------------------------------------------- the run --- */

/**
 * Whether the imports are in flight right now.
 *
 * A flag rather than an assumed window, and the difference is not cosmetic. The
 * first spelling guessed ten minutes; a rehearsal with `--imports-at 0` then
 * labeled every request in a one-minute run as an import, which left the steady
 * arm with no samples — and an arm with no samples reports a 0 ms p95 and a
 * 100% error rate, which is a failing verdict on a phase that never ran.
 * Imports take as long as they take, and only the driver knows when.
 */
let importsRunning = false;

const phases = new Map();
const phaseOf = (name) => {
  if (!phases.has(name)) {
    phases.set(name, { samples: [], statuses: new Map(), byKind: new Map() });
  }
  return phases.get(name);
};
const samples = [];
const statuses = new Map();
const byKind = new Map();
/**
 * Statuses per route as well as overall, because "9% errors" is a number and
 * "every budget report 500s" is a finding. The first rehearsal reported the
 * former and it took a look at the server's log to learn the latter.
 */
const statusByKind = new Map();
const importSamples = [];
const record = (kind, status, ms, label) => {
  // The warm-up is recorded and then thrown away rather than not recorded: the
  // requests still have to be made, and keeping the label makes it possible to
  // say in the report how much was discarded and why.
  //
  // The imports are kept apart rather than thrown away, and that is a judgement
  // rather than convenience. A ten-thousand-row import taking half a minute is
  // the product working; a page load taking half a minute is not, and the
  // thresholds are about the second. Ten import samples among a hundred
  // thousand would barely move a percentile either — which is the other reason
  // to separate them, because a number that cannot fail a threshold should not
  // be counted towards one.
  if (label === "import") {
    importSamples.push({ ms, status });
    return;
  }
  if (label === "warmup") return;

  const phase = phaseOf(label);
  phase.samples.push(ms);
  phase.statuses.set(status, (phase.statuses.get(status) ?? 0) + 1);
  if (!phase.byKind.has(kind)) phase.byKind.set(kind, []);
  phase.byKind.get(kind).push(ms);

  samples.push(ms);
  if (!byKind.has(kind)) byKind.set(kind, []);
  byKind.get(kind).push(ms);
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  if (!statusByKind.has(kind)) statusByKind.set(kind, new Map());
  const perKind = statusByKind.get(kind);
  perKind.set(status, (perKind.get(status) ?? 0) + 1);
};

say(`signing in ${users} of ${TOTAL_SEEDED.toLocaleString()} seeded users`);
const pool = await signIn(users);
say(`${pool.length} sessions`);

await Promise.all(pool.map((user) => warmUser(user).catch(() => {})));
const withAccounts = pool.filter((u) => u.accounts.length > 0).length;
say(`${withAccounts} of ${pool.length} have accounts to act on`);
if (withAccounts === 0) {
  console.error("No user has an account. Was the database seeded?");
  exit(1);
}

if (warmupMinutes > 0) {
  say(`warm-up: ${warmupMinutes} min at ${rps} rps, excluded from every figure`);
  await drive({
    seconds: warmupMinutes * 60,
    rateAt: () => rps,
    phaseAt: () => "warmup",
    pool,
    record,
    label: "warmup",
  });
}

const before = await databaseState();
const peak = { cpu: new Map(), memory: new Map(), limited: new Map(), connections: 0, disk: 0 };
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    for (const stat of await containerStats()) {
      peak.cpu.set(stat.name, Math.max(peak.cpu.get(stat.name) ?? 0, stat.cpu));
      peak.memory.set(stat.name, Math.max(peak.memory.get(stat.name) ?? 0, stat.memory));
      peak.limited.set(stat.name, stat.limited);
    }
    const db = await databaseState();
    if (db) peak.connections = Math.max(peak.connections, Number(db.connections));
    const disk = await diskUsage();
    if (disk !== null) peak.disk = Math.max(peak.disk, disk);
    await sleep(10_000);
  }
})();

say(
  `measuring: ${minutes} min at ${rps} rps, ${burstRps} rps for ${SCHEDULE.burstMinutes} min ` +
    `from minute ${SCHEDULE.burstAtMinute}`,
);

// Started but not awaited: the imports run alongside the steady load, which is
// the arm of the schedule that matters. Awaiting them here would make the run
// sequential and measure two things that never happen at the same time.
let imports;
if (withImports && importsAt < minutes) {
  imports = sleep(importsAt * 60_000).then(() =>
    runImports(pool, SCHEDULE.concurrentImports, SCHEDULE.importRows, record),
  );
} else if (withImports) {
  // A rehearsal shorter than the import point would otherwise sit waiting for
  // twenty minutes after its own load had finished, which looks like a hang and
  // is one. Said out loud rather than silently skipped, because an import phase
  // that did not happen is a schedule that was not followed.
  say(`no imports: they start at minute ${importsAt} and this run is ${minutes}`);
}

const burstFrom = SCHEDULE.burstAtMinute * 60;
const burstTo = burstFrom + SCHEDULE.burstMinutes * 60;
const dispatched = await drive({
  seconds: minutes * 60,
  // The burst replaces the steady rate rather than adding to it, so the run
  // describes one system under one load at a time.
  rateAt: (second) => (second >= burstFrom && second < burstTo ? burstRps : rps),
  // Three arms, reported apart. A single percentile over all of them answers
  // nothing: the burst is four times what the machine is being asked to sustain
  // and the import window is ten maximum-size files at once, so a p95 that
  // blends them describes a load nobody ever applies. The thresholds are about
  // the steady arm, which is the one a deployment lives in.
  phaseAt: (second) => {
    if (second >= burstFrom && second < burstTo) return "burst";
    if (importsRunning) return "imports";
    return "steady";
  },
  pool,
  record,
  label: "measure",
});

if (imports) await imports;
sampling = false;
await sampler;

/* ---------------------------------------------------------- the verdict --- */

const steady = phaseOf("steady");
if (steady.samples.length === 0) {
  console.error(
    "\nNo request fell in the steady arm, so there is nothing to hold to the thresholds.\n" +
      "A run shorter than the burst and import windows put together has no steady phase.",
  );
  exit(1);
}
const sorted = [...steady.samples].sort((a, b) => a - b);
const errorRate = errorsIn(steady.statuses) / steady.samples.length;
const samplesAll = samples;
const server = await serverPercentiles();
const after = await databaseState();

const results = {
  requests: steady.samples.length,
  dispatched,
  p50: percentile(sorted, 50),
  p95: percentile(sorted, 95),
  p99: percentile(sorted, 99),
  errorRate,
  peakCpu: Math.max(0, ...peak.cpu.values()),
  peakMemory: Math.max(0, ...peak.memory.values()),
  connections: peak.connections,
};

console.log(`\n${"=".repeat(64)}\nCapacity run\n${"=".repeat(64)}`);
console.log(`  requests measured   ${samplesAll.length.toLocaleString()} (${dispatched.toLocaleString()} dispatched)`);

/**
 * Each arm of the schedule on its own line.
 *
 * The steady arm is the load a deployment lives in and is what the thresholds
 * are about. The other two are stress: the burst offers four times the steady
 * rate, and the import window puts ten maximum-size files through at once. Both
 * are there to find where the machine stops coping, so blending them into one
 * percentile would hide the answer to both questions — what it serves
 * comfortably, and what it does not.
 */
console.log("\n  By arm of the schedule, from when each request was due:");
console.log(`    ${"arm".padEnd(9)} ${"requests".padStart(9)} ${"p50".padStart(8)} ${"p95".padStart(9)} ${"p99".padStart(9)}  errors`);
for (const name of ["steady", "burst", "imports"]) {
  const phase = phases.get(name);
  if (!phase || phase.samples.length === 0) continue;
  const list = [...phase.samples].sort((a, b) => a - b);
  const bad = errorsIn(phase.statuses);
  console.log(
    `    ${name.padEnd(9)} ${phase.samples.length.toLocaleString().padStart(9)} ` +
      `${percentile(list, 50).toFixed(0).padStart(6)}ms ${percentile(list, 95).toFixed(0).padStart(7)}ms ` +
      `${percentile(list, 99).toFixed(0).padStart(7)}ms  ` +
      `${((bad / phase.samples.length) * 100).toFixed(2)}% (${bad.toLocaleString()})`,
  );
}
console.log(`\n  Statuses overall    ${[...statuses.entries()].sort().map(([s, n]) => `${s}:${n}`).join("  ")}`);

console.log("\n  Steady arm, by request kind (p95):");
for (const [kind, list] of [...steady.byKind.entries()].sort()) {
  const ordered = [...list].sort((a, b) => a - b);
  console.log(
    `    ${kind.padEnd(10)}        ${percentile(ordered, 95).toFixed(0).padStart(6)} ms over ${list.length.toLocaleString().padStart(7)}`,
  );
}
if (importSamples.length > 0) {
  const ok = importSamples.filter((i) => i.status >= 200 && i.status < 300).length;
  const times = importSamples.map((i) => i.ms).sort((a, b) => a - b);
  console.log(
    `\n  Imports (kept out of the figures above): ${ok}/${importSamples.length} accepted, ` +
      `slowest ${(times.at(-1) / 1000).toFixed(1)}s, median ${(percentile(times, 50) / 1000).toFixed(1)}s`,
  );
  const codes = new Map();
  for (const i of importSamples) codes.set(i.status, (codes.get(i.status) ?? 0) + 1);
  console.log(`    statuses            ${[...codes.entries()].sort().map(([c, n]) => `${c}:${n}`).join("  ")}`);
}
if (server) {
  console.log("\n  The application's own histogram, which excludes the driver and the loopback.");
  console.log("  Bucket boundaries, so these are upper bounds rather than exact figures:");
  console.log(`    p50 <= ${server.p50} ms   p95 <= ${server.p95} ms   p99 <= ${server.p99} ms`);
}
console.log("\n  Resources at their peak:");
for (const [name, cpu] of peak.cpu) {
  const of = peak.limited.get(name) ? "of its limit" : "of one core, unlimited";
  console.log(
    `    ${name.padEnd(28)} ${cpu.toFixed(0)}% cpu ${of}, ${(peak.memory.get(name) ?? 0).toFixed(0)}% memory`,
  );
}
if (after) {
  console.log(`    connections                  ${peak.connections} of ${after.max_connections}`);
  console.log(`    database                     ${before?.size ?? "?"} -> ${after.size}`);
}

console.log("\n  Against the thresholds, which are about the steady arm:");
const verdicts = [
  ["p50", results.p50, THRESHOLDS.p50Ms, "ms"],
  ["p95", results.p95, THRESHOLDS.p95Ms, "ms"],
  ["p99", results.p99, THRESHOLDS.p99Ms, "ms"],
  ["error rate", errorRate * 100, THRESHOLDS.errorRate * 100, "%"],
  ["peak cpu", results.peakCpu, THRESHOLDS.cpuPercent, "%"],
  ["peak memory", results.peakMemory, THRESHOLDS.memoryPercent, "%"],
  ["connections", results.connections, THRESHOLDS.connections, ""],
  ["disk", peak.disk, THRESHOLDS.diskPercent, "%"],
];
let failed = 0;
for (const [name, value, limit, unit] of verdicts) {
  const ok = value <= limit;
  if (!ok) failed += 1;
  console.log(
    `    ${ok ? "pass" : "FAIL"}  ${name.padEnd(12)} ${value.toFixed(unit === "%" ? 3 : 0)}${unit} against ${limit}${unit}`,
  );
}
console.log(`${"=".repeat(64)}`);
exit(failed === 0 ? 0 : 1);
