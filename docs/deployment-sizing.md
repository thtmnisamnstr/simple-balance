# Sizing a `single` deployment

Three sizes. `deploy/pulumi/single-common/index.ts` holds the same table as code
and both cloud programs read it from there, so a stack configured with
`simple-balance:size` gets these numbers — `tests/deployment-sizing.test.ts`
holds the two to each other.

**One table, read twice.** This profile is two machines, and each picks a row of
its own: `simple-balance:size` sizes the application node and
`simple-balance:databaseSize` the database node, which defaults to whatever
`size` is. They are separate settings because the two machines want opposite
things. The application is a Node process that is mostly idle and wants little
memory; PostgreSQL would take every byte on the machine and turn it into cache.

| `size` | vCPU | Memory | Data disk | Fits about |
| --- | --- | --- | --- | --- |
| `small` | 2 | 4 GiB | 20 GiB | 4.2M transactions |
| `medium` | 4 | 16 GiB | 50 GiB | 11.4M transactions |
| `large` | 8 | 32 GiB | 100 GiB | 23.0M transactions |

The boot disk is 20 GiB on AWS and 50 GiB on OCI, which is that provider's
minimum, and is the same on both machines. `oci-single` raises a data disk under
50 GB to 50 on both machines too, because OCI refuses a smaller block volume, so
`small` gets 50 GB there; AWS builds the table as written.

The two data disks hold different things, and the capacity column means
something different on each. On the **application node** the data disk holds the
nightly dumps, the generated secret and `env.local`. On the **database node** it
holds `PGDATA` — the ledger, its indexes and its write-ahead log — and the
superuser password generated there. Neither holds the whole of what the column
below is computed from, which is why the column is a floor for both rather than
an estimate for either.

**Start at `small` and expect to stay there.** A household ledger is a few
thousand transactions a year. Even a small business writing two hundred a day
takes fifty years to reach the first row of that table. The sizes exist for
memory and for concurrent readers, not for the ledger — see *What actually fills
a disk* below, because the answer is not the ledger either.

Past `large`, the answer is the `ha` profile rather than a bigger machine: one
host is still one restart, one disk and one upgrade window, however much of it
there is.

## PostgreSQL settings, per size

**These are applied, and that is new.** They used to be advice about a server
somebody else ran, written down here and set by nothing — which is the worst
shape a table can have, because it looks like configuration. The database node's
`deploy/compose/single/compose.postgres.yml` passes every one of them to the
server as a `-c` flag, from the row `simple-balance:databaseSize` picked, and
`tests/deployment-sizing.test.ts` holds the render and the compose file to each
other so a name that stopped lining up fails rather than quietly doing nothing.

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
way around on a machine whose one disk carries the tables and the write-ahead
log alike.

The defaults describe a spinning disk: `random_page_cost` of 4.0 tells the
planner a random read costs four sequential ones, and it is why an untuned
PostgreSQL prefers a sequential scan over the index that would have answered.

`max_connections` is the sixth, and it is a setting rather than a column because
it does not move with the machine's memory in the same way:
`simple-balance:databaseMaxConnections`, default 50, floor 10. See
*Connections* below for the arithmetic behind the number.

**A database you bring yourself takes the same table.** Set these wherever that
server takes its configuration — a managed service's parameter group, or
`postgresql.conf` and `ALTER SYSTEM` on one you keep — and pick the column by
that server's memory rather than by this machine's.

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

Not the ledger, and not one disk. The ledger, its write-ahead log and its bloat
are on the database node; the dumps are on the application node. A million
transactions is 1.2 GB there, and its fourteen daily dumps are 2.4 GB here. What
each disk is sized for:

- **Write-ahead log**, on the database node, bounded by `max_wal_size` — 4 GiB
  at `small`. It sits far below that in normal use; a bulk import is what drives
  it up, which is exactly when a forced checkpoint would stall the import.
  Reserve the whole of it.
- **The ledger itself**, on the database node, at 1,248 bytes a transaction.
- **Backups**, on the application node's data disk, which is what that disk is
  for: `SB_BACKUP_DIR` is `/var/lib/simple-balance/backups` on the machines the
  cloud programs build. Keeping them on the other machine is the point — a copy
  on the same disk as the original is not a backup — but it still protects
  against a mistake rather than against losing both machines. Copy the dumps
  off, and keep fewer here, and the arithmetic changes.
- **Bloat**, on the database node. An updated or deleted row is not space
  returned; autovacuum makes it reusable, not free. Postings are append-only by
  design, so this ledger bloats less than most — but `idempotency_record` and
  `auth_session` churn, and `IDEMPOTENCY_RETENTION_HOURS` is unset by default,
  which means forever.

The capacity column in the first table is that arithmetic done as if all of it
shared one disk of the size shown: the disk, less the write-ahead log, less a
gigabyte of slack, divided between a ledger and fourteen dumps of it at 0.15×
each. This profile splits it across two machines, and each holds less than the
whole, so the column is a floor for both — for the database node's disk, which
holds the ledger and its write-ahead log and not the dumps, and for the
application node's, which holds only the dumps and could be much smaller.

**And it is the constraint that binds first.** `docs/capacity.md` put ten
thousand users and thirty million transactions on a `small` machine, with its
database beside it, and found its CPU and memory ample — a 130 ms 95th
percentile across the whole mix — while the population itself came to 35 GB.
That is more than a `small`-sized disk holds on the database node, and its
fourteen dumps, 79 GB, need `large`'s data disk on the application node. This is
where sizing the two machines separately pays for itself: `medium` for the
database and `large` for the application node's disk, rather than `large` twice.
Size both disks from the table above and the processor keeps up; the reverse is
not true.

## Memory, and why `small` is 4 GiB

The memory column is a database server's arithmetic, because the PostgreSQL
settings above describe a database server and `simple-balance:databaseSize`
reads the same row. At rest one of `small`'s shape wants `shared_buffers` plus a
few MiB per backend, a little over 500 MiB of its 4 GiB, and the rest is page
cache — which is the point. `effective_cache_size` tells the planner to expect
it, and a ledger that fits in it is a ledger served without touching the disk.
2 GiB is the size where that stops being true and PostgreSQL starts reading from
the disk for ordinary pages. It would work; it would be slower for no savings
worth having.

The application node needs far less. It runs the application, around 250 MiB of
Node heap and runtime at rest, and Caddy, under 50 MiB. `docs/capacity.md`
served its whole hour with the application held to 1 GiB beside its database,
and no container went past 72.7% of its memory limit. So on the application node
`small`'s 4 GiB is room rather than need, and there is no smaller row to drop it
to — which is a reason to leave `size` at `small` and spend on `databaseSize`
instead, when either needs spending on.

## Connections

One application process, holding `DATABASE_POOL_SIZE` connections and one more
while it starts: **11**. That number does not move with the size, because there
is nothing in this profile to scale out.

The ceiling it runs against is `simple-balance:databaseMaxConnections`, and the
default is **50**. Eleven for the application, one for `psql`, one for the
nightly `pg_dump`, and the rest is slack. It is lower than PostgreSQL's own
default of 100 on purpose: every allowed connection costs memory whether or not
it is used, and this profile knows exactly how many the application holds, which
a stock default cannot. The floor is 10, below which the pool alone would not
fit.

**It is also the first thing that runs out**, which `docs/capacity.md` measured
rather than predicted. A CSV import holds a connection for its whole duration —
161 seconds for a ten-thousand-row file on a `small` machine — so ten concurrent
imports hold all ten connections and everything else waits for an eleventh it
will not get. Half the imports failed and the interactive p95 went from 130 ms
to 30 seconds, while the server's own connection count sat at 11 and raising it
would have changed nothing.

A deployment that expects several people importing at once should raise
`DATABASE_POOL_SIZE`, and `simple-balance:databaseMaxConnections` with it where
the two would meet. The capacity run held the application to half a core beside
its database; in this profile it has a machine to itself, which is more
processor and not one more connection. One or two concurrent imports leave the
pool room; ten do not.

## Measuring your own

From the application node, which is where a `postgres:18` client container and
the `DATABASE_URL` are both already to hand — the same client the backups use.
`psql` is libpq, so where `DATABASE_URL` says `sslmode=no-verify`, write
`sslmode=require` — the same guarantee in libpq's spelling, as the backup script
does; `docs/deployment.md` has the reason. The URL these programs generate says
`verify-full` and needs no rewriting.

Under `sslmode=verify-full` the client needs the certificate to check against
inside its container, which is what the backup script mounts for it. Where
`DATABASE_URL` names `sslrootcert=/var/lib/simple-balance/tls/db-ca.pem`, which
is what the cloud programs write, add
`-v /var/lib/simple-balance/tls:/var/lib/simple-balance/tls:ro` to the
`docker run` below, so the path means the same file inside as out. Where it
names none, the certificate is from a public CA and the client image carries no
CA bundle, so add
`-v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro -e PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt`
instead.

```sh
psql() { sudo docker run --rm -i --network host \
  -v /var/lib/simple-balance/tls:/var/lib/simple-balance/tls:ro \
  postgres:18 psql "$@"; }
# The generated one is in /opt/simple-balance/env.db, and root reads it.
url="$(sudo sed -n 's/^DATABASE_URL=//p' /opt/simple-balance/env.db)"

# What the ledger occupies, by table.
psql "$url" -c \
  "select c.relname, s.n_live_tup,
          pg_size_pretty(pg_relation_size(c.oid)) as heap,
          pg_size_pretty(pg_indexes_size(c.oid)) as indexes,
          pg_size_pretty(pg_total_relation_size(c.oid)) as total
   from pg_class c join pg_stat_user_tables s on s.relid = c.oid
   order by pg_total_relation_size(c.oid) desc limit 10;"

# Whether the cache is doing its job. Below about 0.95 on a ledger that fits in
# memory means shared_buffers is too small or the machine is.
psql "$url" -c \
  "select round(sum(blks_hit)*100.0/nullif(sum(blks_hit+blks_read),0), 2) as cache_hit_pct
   from pg_stat_database where datname = current_database();"

# What is running now, longest first.
psql "$url" -c \
  "select now() - query_start as running, state, left(query, 80) as query
   from pg_stat_activity where datname = current_database() and state <> 'idle'
   order by running desc;"
```

What has been slow is the database's own log.
`alter system set log_min_duration_statement = '1s'` then
`select pg_reload_conf()` logs every statement that took over a second, and it
is the right way to reach a setting the compose file has no `-c` flag for:
`ALTER SYSTEM` writes `postgresql.auto.conf` inside `PGDATA`, which is on the
data volume, so it survives a restart and a rebuilt machine alike. The lines
come out of the container's log, which on the database node is
`sudo docker compose -f /opt/simple-balance/compose.postgres.yml logs` — capped
at 10 MiB across five files, so a setting left on forever rotates rather than
fills the disk. On a database you brought yourself it is a parameter like the
ones above, and the log is wherever that server keeps them.
