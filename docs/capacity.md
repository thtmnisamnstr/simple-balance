# Capacity

What one machine serves, measured rather than asserted.

The claim this page exists to support is narrow and worth stating before the
numbers: **ten thousand people's ledgers, on the `single` profile's smallest
size, answered inside the times below.** Not ten thousand people at once — that
is what `virtualUsers` is for, and it is five hundred.

Everything here is reproducible from this repository. `scripts/capacity/`
holds the generator, the driver and the thresholds; `scripts/capacity/README.md`
is how to run them. The numbers in the tables come from
`scripts/capacity/schedule.mjs` and `scripts/capacity/cohorts.mjs`, and
`tests/capacity-schedule.test.ts` fails when this page and those files disagree.

## The population

Thirty million transactions across ten thousand users, in three cohorts,
because a population where everybody has the same amount of data hides the
thing a capacity proof is for.

| Cohort | Users | Accounts each | Transactions each | Transactions |
| --- | --- | --- | --- | --- |
| `household` | 8,500 | 4 | 1,000 | 8,500,000 |
| `engaged` | 1,400 | 10 | 10,000 | 14,000,000 |
| `heavy` | 100 | 20 | 75,000 | 7,500,000 |
| | **10,000** | **50,000** | | **30,000,000** |

A hundred users hold a quarter of the transactions. That is deliberate: they
are what a p99 is made of, and a query that is comfortable against a thousand
rows and hopeless against seventy-five thousand is invisible in a flat
population.

Two shapes in it are not a plain two-posting write, and both defeat a single
bulk statement:

- **One entry in five** carries a later version and an audit row and no posting
  at all, which is what a renamed payee leaves behind — an edit that changes
  nothing about the movement writes nothing.
- **One in twenty** was deleted and restored, so it carries the original pair, a
  reversal, and the reversal reversed: six postings that net to the original
  two, on a row that reads as present because it is.

That comes to **66,000,000 postings**, or 2.2 per transaction — the entries
alone. Opening a book posts too: an account is credited and equity is debited,
so the fifty thousand accounts add another 100,000 on top, and a seeded database
reports 66,100,000. The two figures in this page are both right and count
different things.

## Proving the population is a ledger

The generator writes SQL. It has to — thirty million entries through the service
is a load test rather than a setup step — and that steps around `assertBalanced`
in `src/server/services/transactions.ts`, which is what normally makes it
impossible to store an entry that does not settle to zero.

So `scripts/capacity/verify.mjs` runs before any latency is recorded, and the
seed refuses to finish without it. Every check is one the service would have
enforced on the way in:

| Check | Why it is not redundant |
| --- | --- |
| Every currency sums to zero across all postings | The service's own rule, applied once to everything |
| Every *user's* books sum to zero in every currency | A population can balance overall while two users are each wrong and opposite in sign, and no query the application runs would show it |
| A sampled trial balance comes to zero | The figure a person would actually read |
| Every posting names an account of its own owner and currency | The composite foreign key says so; this says the data agrees |
| Every entry carries two postings, or six | Four would be an entry deleted and never restored, which reads as present and is not |
| Every opening balance was posted | An opening balance is posted against equity, not stored beside the ledger |

A number measured against a database that fails any of these is measuring rows
the application could never have written.

## The schedule

| | |
| --- | --- |
| Warm-up | 10 minutes, excluded from every figure |
| Measurement | 60 minutes |
| Steady rate | 25 requests a second |
| Burst | 100 requests a second for 5 minutes, from minute 40, **replacing** the steady rate |
| Imports | 10 concurrent, 10,000 rows each, from minute 20 |
| Recurrences due | 500 |
| Concurrent sessions | 500 |

The warm-up is excluded because the first minutes are PostgreSQL filling a cold
`shared_buffers` from disk. Measuring them reports the latency of a machine that
has just started rather than one that is running.

25 requests a second is roughly every one of the ten thousand making ninety
requests in the busiest hour of their day, which for a ledger — opened, read,
one or two entries added — is generous. The burst replaces rather than adds, so
the run describes one system under one load at a time.

The imports overlap the steady load on purpose. An import holds a transaction
open and writes tens of thousands of postings; what matters is what that does to
somebody reading their register at the same moment.

## The mix

| Share | Request | What it is |
| --- | --- | --- |
| 35% | `GET /api/v1/transactions` | The register — the page people live on |
| 20% | `GET /api/v1/summary` | The dashboard |
| 15% | `GET /api/v1/accounts/:id/balances` | An account and what it holds |
| 10% | `GET /api/v1/reports/:report` | Net worth, income and expense, categories, cash flow |
| 10% | `POST /api/v1/transactions` | The write path |
| 5% | `PATCH /api/v1/transactions/:id` | A rename, which posts nothing |
| 5% | `GET /api/v1/budget-report` | Budgets |

Weighted towards reading because that is what people do with a ledger, and
deliberately not all reading: a proof with no write path measures the half of
the system that never takes a lock.

## The thresholds

| | Limit | Why that number |
| --- | --- | --- |
| p50 | 100 ms | A page that feels immediate |
| p95 | 500 ms | Noticeable, not annoying |
| p99 | 2,000 ms | Where somebody checks whether the tab is still loading |
| Error rate | 0.1% | Not zero: a connection reset and a 409 from two sessions editing one entry are both real and both fine. What is not fine is a rate that says the machine is shedding load |
| Peak CPU | 85% of the container's limit | Headroom for the tick and the backup |
| Peak memory | 90% of the container's limit | |
| Connections | 40 of 100 | The application holds 11; the rest is `psql`, `pg_dump`, and the person wondering why something is slow |

Latency is measured from when each request was **due**, not from when it was
sent. A driver that waits for each reply before sending the next quietly reduces
its own offered rate the moment the server slows down, so the queue never builds
and the tail the proof exists to find never appears.

## The machine

The `single` profile at `small`: 2 vCPU and 4 GiB, which
`docs/deployment-sizing.md` prices and `scripts/capacity/compose.limits.yml`
enforces. The two processes share it — PostgreSQL gets 1.5 cores and 3 GiB, the
application 0.5 and 1 GiB — and the remainder is the page cache
`effective_cache_size` tells the planner to expect.

Seeding runs unconstrained, and that is not a thumb on the scale: building the
dataset is setup, and in a real deployment it arrives as a restored backup
rather than as an hour of writes. What is measured is the machine serving it.

## Results

One run, 15 September 2026, against the machine above: 10,000 users,
30,000,039 transactions, 66,100,078 postings, 35 GB. 112,500 requests measured
across the hour, after a warm-up that was discarded.

Three figures in the run fell short of the schedule and are given as they were
rather than as they were meant to be. **471 of the 500 sessions** were
established; the other 29 failed to sign in, for the same reason the imports
later failed, and the paragraph on the connection pool below is about both.
**464 of the 500 recurrences** were due, because on this run they were inserted
by hand before every user existed — the generator now does it as its own last
step, so a fresh run has all 500. And the 30,000,039 transactions are 39 more
than the cohorts describe, left over from the probes that established what the
application writes for a deposit and a withdrawal.

| Arm | Requests | p50 | p95 | p99 | Errors |
| --- | --- | --- | --- | --- | --- |
| Steady, 25 rps | 67,500 | 17 ms | 130 ms | 835 ms | 0 |
| Burst, 100 rps for 5 min | 30,000 | 10 ms | 696 ms | 1,820 ms | 0 |
| The import window | 15,000 | 25 ms | 30,372 ms | 43,663 ms | 0.93% (140) |

**The import row understates itself, and by how much is known.** The run
labelled requests as belonging to the import window by a fixed ten minutes from
the moment the imports began, and the imports actually took 161 seconds — so
about 4,000 of those 15,000 requests overlapped an import and roughly 11,000 did
not. Diluted that way, the figure shown as the 95th percentile is nearer the
81st of the window that mattered, and the true one is worse. The steady and
burst rows are unaffected: the burst window is defined by the clock, and the
requests wrongly taken out of the steady arm were the fast ones, so 130 ms is if
anything generous.

The driver no longer does this — it labels a request as belonging to the import
window only while an import is genuinely in flight — so the next run measures it
exactly. The numbers above are from the run that found the problem.

And the steady arm by request, at p95: register 83 ms over 23,593 requests,
accounts 94 ms, edit 131 ms, budget 141 ms, write 143 ms, summary 158 ms,
report 180 ms.

| | Measured | Threshold | |
| --- | --- | --- | --- |
| p50 | 17 ms | 100 ms | pass |
| p95 | 130 ms | 500 ms | pass |
| p99 | 835 ms | 2,000 ms | pass |
| Error rate | 0.000% | 0.1% | pass |
| Peak CPU | 108.6% of the app's limit | 85% | **fail** |
| Peak memory | 72.7% | 90% | pass |
| Connections | 11 of 100 | 40 | pass |

**The steady hour is comfortable and the burst is absorbed.** Thirty million
transactions, a quarter of them belonging to a hundred users, and the register —
the page people live on, and the most-requested thing in the mix — answers at
95th percentile in 83 milliseconds. Four times the rate for five minutes costs a
p99 of 1.8 seconds and no errors at all.

**The import arm is where this machine stops coping, and the mechanism is the
connection pool rather than the CPU.** Five of the ten imports failed; the
application's log names 27 instances of `timeout exceeded when trying to
connect`. `DATABASE_POOL_SIZE` is 10, each import holds a connection for its
whole duration — the slowest ran 161 seconds — and ten concurrent imports
therefore hold every connection the application has. Everything else waits for
an eleventh and does not get one. That is also why the connection count reads
11 of 100 at its peak: the limit being hit is the application's pool, not
PostgreSQL's `max_connections`, and raising the latter would change nothing.

So the honest shape of it: **ten concurrent maximum-size imports is past what
the `small` profile absorbs**, and a deployment that expects them should raise
`DATABASE_POOL_SIZE` and give the application more than half a core, or accept
that imports and interactive use contend. One or two concurrent imports leave
the pool with room; ten do not.

**The peak CPU failure is that same window.** 108.6% of half a core, sampled
during the imports. The steady and burst arms sat far below it.

The evidence for the pool being the limit does not depend on the diluted
percentile, which is worth saying because that percentile is the one number here
that is imprecise. Five of ten imports failed, 27 `timeout exceeded when trying
to connect` appear in the log, and `max_connections` never went above 11 of 100.
Those are counts, and they are exact.

### Two things the run measured that the thresholds do not

**The disk is the binding constraint, not the CPU.** This population is 35 GB,
and `docs/deployment-sizing.md` sizes `small`'s data disk at 20 GiB. So the
machine that served this comfortably could not have stored it: ten thousand
users needs `medium`'s disk at minimum, and only with dumps kept off the box —
fourteen daily dumps of a 37 GB ledger is another 79 GB, which is past `large`.
The CPU and memory of `small` are ample for ten thousand users; the disk is not,
and it is the disk that should be sized from the table.

**Signing 500 sessions in at once loses some of them.** 29 of 500 failed, for
the same reason the imports did: verifying a password is deliberately expensive,
each verification holds a connection, and the pool is ten. The driver already
limits itself to twenty at a time, which took it from 62 failures to 29. Real
sign-ins arrive spread across a morning rather than in one burst from a script,
so this is a property of the harness rather than of the product — but it is the
same pool, and it is worth knowing that the pool is what runs out first under
every kind of concurrency this deployment meets.

## What this does not prove

- **Ten thousand people at once.** Five hundred concurrent sessions drawn from
  ten thousand ledgers. A deployment where all ten thousand are active in the
  same minute is a different question and a different profile.
- **Anything about the `ha` profile.** That is a cluster, and its capacity is
  the subject of its own work.
- **Durability.** The generator runs with `synchronous_commit` off, which is
  safe for a throwaway dataset and says nothing about what a real deployment
  survives losing power. Nothing in the measurement runs under it.
- **Multi-currency conversion.** The population holds two currencies, and no
  transfer crosses them. Zero-sum per currency is checked; FX is not exercised.
