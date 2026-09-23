# Sizing a `single` deployment

Three sizes. `deploy/pulumi/single-common/index.ts` holds the same table as code
and both cloud programs read it from there, so a stack configured with
`simple-balance:size` gets these numbers — `tests/deployment-sizing.test.ts`
holds the two to each other.

This profile's database is not on the machine: it is whatever server
`DATABASE_URL` names. So the table sizes two things. The machine the cloud
programs build — its processor, memory and data disk — and, in the PostgreSQL
settings further down, a database server of the same shape, which is what a
small managed instance usually is.

| `size` | vCPU | Memory | Data disk | Fits about |
| --- | --- | --- | --- | --- |
| `small` | 2 | 4 GiB | 20 GiB | 4.2M transactions |
| `medium` | 4 | 16 GiB | 50 GiB | 11.4M transactions |
| `large` | 8 | 32 GiB | 100 GiB | 23.0M transactions |

The boot disk is 20 GiB on AWS and 50 GiB on OCI, which is that provider's
minimum, and holds no database; neither does the data disk, which holds the
nightly dumps, the generated secret and `env.local`. `oci-single` raises a data
disk under 50 GB to 50, because OCI refuses a smaller block volume, so `small`
gets 50 GB there; AWS builds the table as written.

**Start at `small` and expect to stay there.** A household ledger is a few
thousand transactions a year. Even a small business writing two hundred a day
takes fifty years to reach the first row of that table. The sizes exist for
memory and for concurrent readers, not for the ledger — see *What actually fills
a disk* below, because the answer is not the ledger either.

Past `large`, the answer is the `ha` profile rather than a bigger machine: one
host is still one restart, one disk and one upgrade window, however much of it
there is.

## PostgreSQL settings, per size

These are for the PostgreSQL server `DATABASE_URL` names, and nothing in this
profile applies them: the machine it builds runs no database. Set them wherever
that server takes its configuration — a managed service's parameter group or
flags, or `postgresql.conf` and `ALTER SYSTEM` on one you keep — and pick the
column by the database server's memory, not by this machine's.

| Setting | `small` | `medium` | `large` | What it is |
| --- | --- | --- | --- | --- |
| `shared_buffers` | 512MB | 4GB | 8GB | PostgreSQL's own cache. A quarter of memory, which is the standing advice, less the room the application needed when the two shared a machine, so it is conservative on a server of its own |
| `effective_cache_size` | 1536MB | 11GB | 22GB | Not an allocation — what the planner assumes the kernel is caching. Too low and it costs index scans it should have chosen |
| `work_mem` | 8MB | 16MB | 32MB | Per sort or hash, and a report can hold several. Multiplied by concurrent operations, not by the pool |
| `maintenance_work_mem` | 256MB | 1GB | 2GB | Index builds and VACUUM. This decides how long a migration that rewrites an index takes, and it is claimed only while such work runs |
| `max_wal_size` | 4GB | 8GB | 16GB | How much write-ahead log accumulates before a checkpoint is forced. Sized against the disk below |

Three more are the same at every size, because they describe the storage rather
than the machine: `random_page_cost=1.1` and `effective_io_concurrency=200` say
the disk is an SSD, which on every server this is sized for it is, and
`wal_compression=on` trades a little CPU for less write-ahead log — the right
way around on a small server whose one disk carries the tables and the
write-ahead log alike.

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

Not the ledger, and on this profile not one disk either. The ledger, its
write-ahead log and its bloat are on the database server; the dumps are on this
machine's data disk. A million transactions is 1.2 GB there, and its fourteen
daily dumps are 2.4 GB here. What each disk is sized for:

- **Write-ahead log**, on the database server, bounded by `max_wal_size` — 4 GiB
  at `small`. It sits far below that in normal use; a bulk import is what drives
  it up, which is exactly when a forced checkpoint would stall the import.
  Reserve the whole of it.
- **Backups**, on this machine's data disk, which is what that disk is for:
  `SB_BACKUP_DIR` is `/var/lib/simple-balance/backups` on the machines the cloud
  programs build. That protects against a mistake and not against losing the
  disk, which is the more likely of the two. Copy the dumps off, and keep fewer
  here, and the arithmetic changes.
- **Bloat**, on the database server. An updated or deleted row is not space
  returned; autovacuum makes it reusable, not free. Postings are append-only by
  design, so this ledger bloats less than most — but `idempotency_record` and
  `auth_session` churn, and `IDEMPOTENCY_RETENTION_HOURS` is unset by default,
  which means forever.

The capacity column in the first table is that arithmetic done as if all of it
shared one disk of the size shown: the disk, less the write-ahead log, less a
gigabyte of slack, divided between a ledger and fourteen dumps of it at 0.15×
each. This profile splits it across two, and each holds less than the whole, so
the column is a floor for both — for this machine's data disk, which holds only
the dumps, and for a database server given a disk the same size, which holds
the ledger and its write-ahead log and not the dumps.

**And it is the constraint that binds first.** `docs/capacity.md` put ten
thousand users and thirty million transactions on a `small` machine, with its
database beside it, and found its CPU and memory ample — a 130 ms 95th
percentile across the whole mix — while the population itself came to 35 GB.
That is more than a `small`-sized disk holds on the database server, and its
fourteen dumps, 79 GB, need `large`'s data disk here. Size both disks from the
table above and the processor keeps up; the reverse is not true.

## Memory, and why `small` is 4 GiB

The sizes were set while this profile ran PostgreSQL beside the application, and
the memory column is still a database server's arithmetic, because that is the
server the PostgreSQL settings above describe. At rest one of `small`'s shape
wants `shared_buffers` plus a few MiB per backend, a little over 500 MiB of its
4 GiB, and the rest is page cache — which is the point. `effective_cache_size`
tells the planner to expect it, and a ledger that fits in it is a ledger served
without touching the disk. 2 GiB is the size where that stops being true and
PostgreSQL starts reading from the disk for ordinary pages. It would work; it
would be slower for no savings worth having.

The machine this profile builds needs far less. It runs the application, around
250 MiB of Node heap and runtime at rest, and Caddy, under 50 MiB.
`docs/capacity.md` served its whole hour with the application held to 1 GiB
beside its database, and no container went past 72.7% of its memory limit. So
on this machine `small`'s 4 GiB is room rather than need.

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
`DATABASE_POOL_SIZE`, and the database server's `max_connections` with it where
the two would meet. The capacity run held the application to half a core beside
its database; on this profile's machine it has every core to itself, which is
more processor and not one more connection. One or two concurrent imports leave
the pool room; ten do not.

The rest of the hundred is headroom for `psql`, for `pg_dump`, and for the
connection somebody opens while wondering why something is slow. Every allowed
connection costs memory whether or not it is used, so lowering
`max_connections` on a `small` database server is a reasonable thing to do —
just not below about 25. A managed service usually sets it from the instance
size; check that it leaves room for the eleven this deployment holds and the
nightly dump's one.

## Measuring your own

Against the database `DATABASE_URL` names, from anywhere that can reach it. On
the machine itself that is a `postgres:18` client container, the one the
backups use. `psql` is libpq, so where `DATABASE_URL` says `sslmode=no-verify`,
write `sslmode=require` — the same guarantee in libpq's spelling, as the backup
script does; `docs/deployment.md` has the reason.

```sh
psql() { sudo docker run --rm -i --network host postgres:18 psql "$@"; }
url='postgresql://user:password@host:5432/simple_balance?sslmode=require'

# What the ledger occupies, by table.
psql "$url" -c \
  "select c.relname, s.n_live_tup,
          pg_size_pretty(pg_relation_size(c.oid)) as heap,
          pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
          pg_size_pretty(pg_total_relation_size(c.oid)) as total
   from pg_class c join pg_stat_user_tables s on s.relid = c.oid
   order by pg_total_relation_size(c.oid) desc limit 10;"

# Whether the cache is doing its job. Below about 0.95 on a ledger that fits in
# memory means shared_buffers is too small or the server is.
psql "$url" -c \
  "select round(sum(blks_hit)*100.0/nullif(sum(blks_hit+blks_read),0), 2) as cache_hit_pct
   from pg_stat_database where datname = current_database();"

# What is running now, longest first.
psql "$url" -c \
  "select now() - query_start as running, state, left(query, 80) as query
   from pg_stat_activity where datname = current_database() and state <> 'idle'
   order by running desc;"
```

What has been slow is the database server's own log, once it is asked to keep
one: `log_min_duration_statement` set to `1000` logs every statement that took
over a second. On a managed service it is a parameter like the ones above, and
the log is wherever that service keeps them.
