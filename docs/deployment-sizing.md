# Sizing a `single` deployment

Three sizes. `deploy/pulumi/single-common/index.ts` holds the same table as code
and both cloud programs read it from there, so a stack configured with
`simple-balance:size` gets exactly these numbers —
`tests/deployment-sizing.test.ts` holds the two to each other.

| `size` | vCPU | Memory | Data disk | Fits about |
| --- | --- | --- | --- | --- |
| `small` | 2 | 4 GiB | 20 GiB | 4.2M transactions |
| `medium` | 4 | 16 GiB | 50 GiB | 11.4M transactions |
| `large` | 8 | 32 GiB | 100 GiB | 23.0M transactions |

The boot disk is 20 GiB on AWS and 50 GiB on OCI, which is that provider's
minimum, and holds no database.

**Start at `small` and expect to stay there.** A household ledger is a few
thousand transactions a year. Even a small business writing two hundred a day
takes fifty years to reach the first row of that table. The sizes exist for
memory and for concurrent readers, not for the ledger — see *What actually fills
a disk* below, because the answer is not the ledger either.

Past `large`, the answer is the `ha` profile rather than a bigger machine: one
host is still one restart, one disk and one upgrade window, however much of it
there is.

## PostgreSQL settings, per size

These are what the cloud programs write into `.env`, and what
`deploy/compose/single/compose.yml` defaults to at `small`. Set them by hand for
a machine that is not one of the three.

| Setting | `small` | `medium` | `large` | What it is |
| --- | --- | --- | --- | --- |
| `shared_buffers` | 512MB | 4GB | 8GB | PostgreSQL's own cache. A quarter of memory, which is the standing advice, less the room the application needs |
| `effective_cache_size` | 1536MB | 11GB | 22GB | Not an allocation — what the planner assumes the kernel is caching. Too low and it costs index scans it should have chosen |
| `work_mem` | 8MB | 16MB | 32MB | Per sort or hash, and a report can hold several. Multiplied by concurrent operations, not by the pool |
| `maintenance_work_mem` | 256MB | 1GB | 2GB | Index builds and VACUUM. This decides how long a migration that rewrites an index takes, and it is claimed only while such work runs |
| `max_wal_size` | 4GB | 8GB | 16GB | How much write-ahead log accumulates before a checkpoint is forced. Sized against the disk below |

Three more are the same at every size, because they describe the storage rather
than the machine: `random_page_cost=1.1` and `effective_io_concurrency=200` say
the disk is an SSD, which on every machine this profile targets it is, and
`wal_compression=on` trades a little CPU for less write-ahead log — the right
way round on a small machine where the disk is shared with everything else.

The defaults describe a spinning disk: `random_page_cost` of 4.0 tells the
planner a random read costs four sequential ones, and it is why an untuned
PostgreSQL prefers a sequential scan over the index that would have answered.

## What a ledger actually costs

Measured rather than estimated, on PostgreSQL 16 with this schema and its
indexes: 50,000 transactions, one in ten split three ways, which is 110,000
postings and 15,000 legs.

| | Rows | Heap | Indexes | Total |
| --- | --- | --- | --- | --- |
| `posting` | 110,000 | 14 MB | 17 MB | 31 MB |
| `ledger_transaction` | 50,000 | 9.6 MB | 14 MB | 23 MB |
| `transaction_leg` | 15,000 | 1.8 MB | 3.6 MB | 5.5 MB |
| | | | | **60 MB** |

**1,248 bytes per transaction**, indexes included. Roughly half of that is index
rather than row, which is the price of a list that can be ordered by any column
it displays and resumed by a cursor.

A `pg_dump` of the same database is **8.7 MB**, or 0.15× the live size.

| Transactions | Ledger | One dump | 14 dumps |
| --- | --- | --- | --- |
| 10,000 | 12 MB | 2 MB | 25 MB |
| 100,000 | 119 MB | 18 MB | 250 MB |
| 1,000,000 | 1.2 GB | 179 MB | 2.4 GB |
| 10,000,000 | 11.9 GB | 1.8 GB | 24.4 GB |

## What actually fills a disk

Not the ledger. On a 20 GiB data disk, a million transactions is 1.2 GB and the
fourteen daily dumps beside them are another 2.4 GB. The other three things are
what the disk is sized for:

- **Write-ahead log**, bounded by `max_wal_size` — 4 GiB at `small`. It sits far
  below that in normal use; a bulk import is what drives it up, which is exactly
  when a forced checkpoint would stall the import. Reserve the whole of it.
- **Backups, if they are on this disk**, which by default they are:
  `SB_BACKUP_DIR` is under `/var/lib/simple-balance`. That protects against a
  mistake and not against a disk, which is the more likely of the two. Point it
  at something else, or copy the dumps off, and the arithmetic above changes.
- **Bloat.** An updated or deleted row is not space returned; autovacuum makes it
  reusable, not free. Postings are append-only by design, so this ledger bloats
  less than most — but `idempotency_record` and `auth_session` churn, and
  `IDEMPOTENCY_RETENTION_HOURS` is unset by default, which means forever.

The capacity column in the first table is that arithmetic: the disk, less the
write-ahead log, less a gigabyte of slack, divided between a ledger and fourteen
dumps of it at 0.15× each.

**And it is the constraint that binds first.** `docs/capacity.md` put ten
thousand users and thirty million transactions on a `small` machine and found
its CPU and memory ample — a 130 ms 95th percentile across the whole mix — while
the population itself came to 35 GB, which is more than `small`'s data disk
holds. Size the disk from the table above and the processor keeps up; the
reverse is not true.

## Memory, and why `small` is 4 GiB

At rest the three processes want roughly: PostgreSQL `shared_buffers` plus a few
MiB per backend, the application around 250 MiB of Node heap and runtime, and
Caddy under 50 MiB. At `small` that is about 800 MiB of the 4 GiB, and the rest
is page cache — which is the point. `effective_cache_size` tells the planner to
expect it, and a ledger that fits in it is a ledger served without touching the
disk.

2 GiB is the size where that stops being true and PostgreSQL starts reading from
the disk for ordinary pages. It would work; it would be slower for no saving
worth having.

## Connections

One application process, holding `DATABASE_POOL_SIZE` connections and one more
while it starts: **11** of the 100 PostgreSQL allows by default. That number does
not move with the size, because there is nothing in this profile to scale out.

**It is also the first thing that runs out**, which `docs/capacity.md` measured
rather than predicted. A CSV import holds a connection for its whole duration —
161 seconds for a ten-thousand-row file on a `small` machine — so ten concurrent
imports hold all ten connections and everything else waits for an eleventh it
will not get. Half the imports failed and the interactive p95 went from 130 ms
to 30 seconds, while PostgreSQL's own `max_connections` sat at 11 of 100 and
raising it would have changed nothing.

A deployment that expects several people importing at once should raise
`DATABASE_POOL_SIZE` and `POSTGRES_MAX_CONNECTIONS` together, and give the
application more than the half core `small` allots it. One or two concurrent
imports leave the pool room; ten do not.

The rest of the hundred is headroom for `psql`, for `pg_dump`, and for the
connection somebody opens while wondering why something is slow. Every allowed
connection costs memory whether or not it is used, so lowering
`POSTGRES_MAX_CONNECTIONS` on a `small` machine is a reasonable thing to do —
just not below about 25.

## Measuring your own

```sh
cd /opt/simple-balance
# What the ledger occupies, by table.
docker compose exec -T postgres psql -U simple_balance -d simple_balance -c \
  "select c.relname, s.n_live_tup,
          pg_size_pretty(pg_relation_size(c.oid)) as heap,
          pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
          pg_size_pretty(pg_total_relation_size(c.oid)) as total
   from pg_class c join pg_stat_user_tables s on s.relid = c.oid
   order by pg_total_relation_size(c.oid) desc limit 10;"

# Whether the cache is doing its job. Below about 0.95 on a ledger that fits in
# memory means shared_buffers is too small or the machine is.
docker compose exec -T postgres psql -U simple_balance -d simple_balance -c \
  "select round(sum(blks_hit)*100.0/nullif(sum(blks_hit+blks_read),0), 2) as cache_hit_pct
   from pg_stat_database where datname='simple_balance';"

# What is slow. POSTGRES_LOG_MIN_DURATION_MS is 1000 by default, so anything
# here took over a second.
docker compose logs postgres | grep 'duration:'
```
