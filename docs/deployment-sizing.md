# Sizing a `single` deployment

Three sizes, and each one sizes **two machines**.
`deploy/pulumi/single-common/index.ts` holds the same table as code and both
cloud programs read it from there, so a stack configured with
`simple-balance:size` gets these numbers — `tests/deployment-sizing.test.ts`
holds the two to each other.

**One table, read twice, and each read takes a different half of the row.** This
profile is two machines and they want opposite things, so a row describes both:
`simple-balance:size` picks a row's application half and
`simple-balance:databaseSize` its database half, which defaults to whatever
`size` is. The application node runs a Node process that is mostly idle and
stores no ledger. The database node runs PostgreSQL, which turns every spare
byte of memory into cache and holds `PGDATA`.

**The two data disks used to be one number, and that was the defect.** They hold
completely different things — `PGDATA` on one, the nightly dumps on the other —
so a single figure was wrong for both at once, and at the population
`docs/capacity.md` measures it was wrong in both directions at the same time:
too small for the ledger and far too small for its backups.

| `size` | Application node | Its data disk | Database node | Its data disk |
| --- | --- | --- | --- | --- |
| `small` | 2 vCPU, 4 GiB | 20 GiB | 2 vCPU, 4 GiB | 30 GiB |
| `medium` | 2 vCPU, 4 GiB | 110 GiB | 4 vCPU, 16 GiB | 100 GiB |
| `large` | 2 vCPU, 8 GiB | 340 GiB | 8 vCPU, 32 GiB | 300 GiB |

**No disk in that table is smaller than the one it replaces, and that is a rule
rather than a coincidence.** Growing a volume is an in-place update on both
clouds; shrinking one AWS refuses outright, and on OCI it is a replacement,
which with `protectDataVolume` off is a deleted ledger. So the disks may be made
more generous and never less, which is why `small`'s application disk stays at
20 GiB where the arithmetic below asks for 10.

**The machines are the other way round, and that is safe for the opposite
reason.** The application node's shape comes *down* at `medium` and `large` —
two cores and 4 GiB where it used to take the database node's machine — because
resizing an instance is in place on both clouds and costs a restart rather than
a disk. The database node's shape does not move at all: nothing measured asks
for more, and replacing a running database machine to ask for less is not worth
the interruption.

What each disk holds, derived in *What actually fills a disk* below rather than
picked:

| | `small` | `medium` | `large` |
| --- | --- | --- | --- |
| The row is sized for | 2M transactions | 30M | 100M |
| Ledger the database disk holds | 9.4M transactions | 38.2M | 124.9M |
| Dumps the application disk holds, at `backupKeep` 14 | 5.6M transactions | 32.7M | 101.8M |
| The same at `backupKeep` 3 | 21.1M transactions | 122.5M | 381.8M |

**The application node's disk is the one that binds at the default**, and that
is the opposite of most people's instinct. Fifteen dumps — fourteen kept plus
the one being written — come to 2.175 times the live ledger, which is more than
`PGDATA` itself. `backupKeep` is the lever: at 3 the database node's disk
becomes the binding one at every size, which is where it belongs.

The boot disk is 20 GiB on AWS and 50 GiB on OCI, which is that provider's
minimum, and is the same on both machines. `oci-single` raises a data disk under
50 GB to 50 on both machines too, because OCI refuses a smaller block volume, so
`small` gets 50 GB there on each; AWS builds the table as written. That floor is
also why `small` still lands exactly on the Always Free storage allowance: two
50 GB boot volumes beside a 20 GiB and a 30 GiB data volume both raised to 50 is
200 GB to the byte, exactly as it was when both data disks were 20.

**A disk grows in place, and its filesystem does not — but the machine now
handles that.** Both clouds enlarge a block volume without replacing it, and
first boot formats a device only when it is not already a filesystem, so a
`size` change that raises a disk gives the machine a larger block device and the
same filesystem. `simple-balance-growfs.service` closes the gap: it runs at
every boot, after the data volume is mounted, so a reboot is all a grown disk
needs. Without a reboot — or on a machine built before that unit existed — the
command is `sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"`,
which is what the unit runs and is online. Neither data volume carries a
partition table, so `growpart` has nothing to grow here; `docs/upgrades.md`
spells that out. Plan the disk before the first `up` where you can;
`docs/deployment-costs.md` prices a generous one, and it is cheap next to the
machine.

**Start at `small` and expect to stay there.** A household ledger is a few
thousand transactions a year. Even a small business writing two hundred a day
takes seventy years to fill the first row of that table. The sizes exist
for memory and for concurrent readers, not for the ledger — see *What actually
fills a disk* below, because the answer is the backups rather than the ledger.

Past `large`, the answer is the `ha` profile rather than a bigger machine: one
host is still one restart, one disk and one upgrade window, however much of it
there is.

## Is 6 OCPU and 16 GB better than 4 and 8?

The short answer: **the memory is right and only on the database node, the
extra cores are not, and the thing that was actually undersized is neither.**

The row being described does not exist: `medium` was already 4 vCPU and 16 GiB,
on both machines, so the question is really "is `medium` enough". It breaks into
three, and only the third is a yes.

**Cores: no, and the measurement is unusually direct.** `docs/capacity.md` held
PostgreSQL to **1.5 cores** and the application to **0.5 of a core**, sharing one
two-core machine, against thirty million transactions and sixty-six million
postings. The steady hour came back at a 95th percentile of 130 ms with no
errors, and a four-times burst was absorbed. Six cores is four times a number
that was already sufficient on the harder arrangement, where the two processes
competed for one pair. Here each machine has its own.

So the database node keeps the cores it had — 2, 4 and 8 — because there is no
evidence for raising them and an existing stack should not be replaced to lower
them. What changed is the **application** node, which comes down to two cores at
every size. It peaked at 108.6% of half a core and 745 MiB of its gigabyte under
that run. Two cores and 4 GiB is roughly four times its measured peak, and the
four and eight it used to buy were bought for a machine that stores no ledger
and whose memory does nothing for the database's cache.

The one threshold that failed in that run was the application's peak CPU, 108.6%
of half a core, and it failed during the imports — which is the second point.

**The thing that broke was the connection pool, and cores do not touch it.**
Five of ten concurrent maximum-size imports failed with `timeout exceeded when
trying to connect`, while the server's own connection count sat at 11 of 100.
`DATABASE_POOL_SIZE` is 10 and an import holds a connection for its whole
duration. Buying cores against that failure buys nothing; `DATABASE_POOL_SIZE`
and `simple-balance:databaseMaxConnections` are the settings that do. See
*Connections* below.

**Memory: yes, on the database node, and here is why 8 is the wrong side of the
line.** What PostgreSQL wants resident is the indexes, because that is what a
list ordered by any column it displays is made of. At the capacity target the
two large tables' indexes alone come to:

```
posting             66,100,078 rows x 162.1 B =  10.72 GB
ledger_transaction  30,000,000 rows x 293.6 B =   8.81 GB
                                                 --------
                                                  19.52 GB  = 18.2 GiB
```

Against roughly 0.7 GiB of the machine going to the kernel and the server's own
backends, the share of that 18.2 GiB a machine can hold in `shared_buffers` and
page cache together is:

| Machine memory | Cache available | Share of the index | Whole ledger that fits |
| --- | --- | --- | --- |
| 4 GiB | ~3.3 GiB | 18% | 2.8M transactions |
| 8 GiB | ~7.3 GiB | 40% | 6.3M transactions |
| 16 GiB | ~15.3 GiB | **84%** | 13.2M transactions |
| 32 GiB | ~31.3 GiB | 100%, and 13 GiB of heap besides | 26.9M transactions |

Eight to sixteen is the step that takes index coverage from 40% to 84%. That is
the whole argument for `medium`'s database node, and it is an argument about the
database node only: the application node's memory caches nothing the database
reads. Sixteen to thirty-two covers the rest of the index and starts on the
heap, which is `large`.

So the instinct behind the question was right about the memory and right about
the machine it belongs to. It was the cores that were not being bought by
anything, and on Oracle they are the expensive half: 6 OCPU and 16 GB on each of
two nodes is $122.64 a month in compute alone, against $65.70 for the `medium`
row — for processors no measurement in this repository asks for, on
machines whose disks would still have been too small.

**And `small` staying at 4 GiB is that same arithmetic, not thrift.** A `small`
deployment is sized for 2M transactions, and 4 GiB holds a 2.8M-transaction
ledger entirely in cache — indexes, heap and all. There is nothing for more
memory to do there.

**Storage: yes, and it is the real defect.** Both disks were wrong, in opposite
directions, because they were one number. The arithmetic is below.

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

| | Rows | Heap | Indexes | Total | Heap + indexes per row |
| --- | --- | --- | --- | --- | --- |
| `posting` | 110,000 | 14 MB | 17 MB | 31 MB | 296 B |
| `ledger_transaction` | 50,000 | 9.6 MB | 14 MB | 23 MB | 495 B |
| `transaction_leg` | 15,000 | 1.8 MB | 3.6 MB | 5.5 MB | 378 B |
| | | | | **60 MB** | |

The last column divides heap plus indexes rather than the `Total` column, which
is `pg_size_pretty` rounding the same figure: 9.6 plus 14 is 23.6 and prints as
23.

**1,248 bytes per transaction**, indexes included. Roughly half of that is index
rather than row — 162 of `posting`'s 296 bytes and 294 of
`ledger_transaction`'s 495 — which is the price of a list that can be ordered by
any column it displays and resumed by a cursor.

It holds at six hundred times the scale. `docs/capacity.md`'s population is
66,100,078 postings and 30,000,000 transactions in a quite different shape — no
splits, one entry in five audited, one in twenty voided and restored — and the
per-row figures above put those two tables alone at 34.4 GB, against 35 GB
measured for the whole database. Within a few per cent across a six-hundred-fold
change of scale and a different mix of rows, which is close enough to size a
disk from.

One thing the measurement does not cover: both databases were seeded with short
user identifiers, and a real deployment's are about thirty-two characters. That
adds a few bytes to every heap row and to every entry of the many
`(user_id, …)` indexes — call it five to eight per cent, which is inside the
headroom the formulas below reserve.

A `pg_dump -Fc` of the same database is **8.7 MB**, or **0.145×** the live size.
That ratio is measured on 60 MB and applied to tens of gigabytes below, which is
an assumption rather than a measurement: a custom-format archive is zlib over
the `COPY` stream, and this ledger's numerics and dates compress well while its
uuid columns render as thirty-six incompressible hex characters. Treat 0.145 as
a working figure above about a gigabyte, and measure your own with
[the recipe below](#measuring-your-own) if the answer decides a disk.

| Transactions | Ledger | One dump | 15 dumps |
| --- | --- | --- | --- |
| 10,000 | 12 MB | 1.7 MB | 26 MB |
| 100,000 | 119 MB | 17 MB | 259 MB |
| 1,000,000 | 1.2 GB | 173 MB | 2.5 GB |
| 10,000,000 | 11.6 GB | 1.7 GB | 25.3 GB |

## What actually fills a disk

Not the ledger, and not one disk. Each machine has its own formula, and they
have almost nothing in common.

**The database node**, which holds `PGDATA` and nothing else:

```
disk = (ledger × 1.20 + ledger × 0.15 + 2 × max_wal_size) ÷ 0.95 ÷ 0.80
```

- **× 1.20 for bloat.** An updated or deleted row is not space returned;
  autovacuum makes it reusable, not free. Postings are append-only by design, so
  this ledger bloats less than most — but `ledger_transaction.version` bumps on
  every edit, recategorizing rewrites a leg, and `idempotency_record` and
  `auth_session` churn, with `IDEMPOTENCY_RETENTION_HOURS` unset by default,
  which means forever.
- **× 0.15 for a reindex.** `REINDEX` builds the new index before dropping the
  old one, so the largest index has to fit twice, and `posting` carries seven of
  them. Fifteen per cent of the whole ledger is comfortably more than
  `posting_user_account_date_idx`, which is the largest — it is a reserve rather
  than a measurement, and the room it leaves is what lets the rebuild run on a
  ledger that is not idle.
- **2 × `max_wal_size`**, because it is a soft target rather than a ceiling:
  write-ahead log keeps accumulating while the checkpoint drains at
  `checkpoint_completion_target` 0.9. A bulk import is what drives it up, which
  is exactly when a forced checkpoint would stall the import — and a full
  `pg_wal` is a PANIC and a cluster that will not restart.
- **÷ 0.95** for ext4's reserved blocks, and **÷ 0.80** because a `PGDATA`
  volume should not be run fuller than that.

**The application node**, which holds the dumps, `env.local`, the generated
secret and the database's CA certificate:

```
disk = ((backupKeep + 1) × 0.145 × ledger + 1 GiB) ÷ 0.95 ÷ 0.80
```

- **`backupKeep` + 1, not `backupKeep`.** `simple-balance-backup` writes
  `…partial`, verifies it by reading it back with `pg_restore --list`, moves it
  into place, and only *then* prunes. So fifteen dumps coexist at the default of
  fourteen, for the minutes the newest one is being written and verified — and
  that is the peak the disk has to survive, not the average.
- **`SB_BACKUP_DIR` is `/var/lib/simple-balance/backups`** on the machines the
  cloud programs build. The dumps live on the *application* node and are taken
  over the network, because a copy on the same disk as the original is not a
  backup. It still protects against a mistake rather than against losing both
  machines: copy them off, keep fewer here, and the arithmetic changes by the
  factor in the table at the top.
- **1 GiB** covers `env.local`, `AUTH_SECRET`, the CA certificate and room to
  restore into.

Worked at each row's target, which is where the table at the top comes from:

| | `small`, 2M | `medium`, 30M | `large`, 100M |
| --- | --- | --- | --- |
| Live ledger | 2.3 GiB | 34.9 GiB | 116.2 GiB |
| × 1.35, bloat and reindex | 3.1 GiB | 47.1 GiB | 156.9 GiB |
| + 2 × `max_wal_size` | 11.1 GiB | 63.1 GiB | 188.9 GiB |
| ÷ 0.95 ÷ 0.80 → **database disk** | 14.7 → **30 GiB** | 83.0 → **100 GiB** | 248.6 → **300 GiB** |
| 15 dumps at 0.145× | 5.1 GiB | 75.8 GiB | 252.8 GiB |
| + 1 GiB, ÷ 0.95 ÷ 0.80 → **application disk** | 8.0 → **20 GiB** | 101.1 → **110 GiB** | 333.9 → **340 GiB** |

Each is rounded up rather than to the nearest, the database node's hardest, and
`small`'s application disk is rounded up past its own arithmetic to the 20 GiB
the single data-disk column used to give it. **No row's disk may ever get
smaller.** AWS refuses to shrink a volume and OCI would replace one, so a table
that took a number back would either break the next `pulumi up` or, with
`protectDataVolume` off, delete the thing it was sizing. Growing one is in
place on both clouds but is not only a `pulumi up`: the filesystem on it has to
be grown too, which a machine built from this release does at its next boot and
an older one wants one command for. A database disk that fills is a
cluster that will not restart, which is a worse way to discover a rounding
decision than paying for a few gigabytes.

**And the disk is the constraint that binds first.** `docs/capacity.md` put ten
thousand users and thirty million transactions on `small`'s processor and
memory, with the database beside it, and found them ample — a 130 ms 95th
percentile across the whole mix — while the population itself came to 35 GB. So
that deployment wants `medium` on both machines: `medium`'s database disk holds
38 million transactions and its application disk holds fifteen dumps of a
32-million-transaction one. Size both disks from the table above and the
processor keeps up; the reverse is not true.

## Memory, on each machine

**The database node's memory column is a database server's arithmetic**, which
is what the PostgreSQL settings above describe and what
`simple-balance:databaseSize` reads. At rest one of `small`'s shape wants
`shared_buffers` plus a few MiB per backend, a little over 500 MiB of its
4 GiB, and the rest is page cache — which is the point.
`effective_cache_size` tells the planner to expect it, and a ledger that fits in
it is a ledger served without touching the disk. 2 GiB is the size where that
stops being true and PostgreSQL starts reading from the disk for ordinary pages.
It would work; it would be slower for no savings worth having. Above `small`,
the table earlier in this page is what the memory buys.

**The application node's is not, and it is far smaller.** It runs the
application, around 250 MiB of Node heap and runtime at rest, and Caddy, under
50 MiB. `docs/capacity.md` served its whole hour with the application held to
1 GiB beside its database, and no container went past 72.7% of its memory limit.
4 GiB is therefore about five times the measured peak, and it stays 4 GiB at
`medium` for that reason: memory on this machine becomes page cache for files
nothing reads twice, where the same memory on the other machine becomes index
cache. `large` takes it to 8 GiB for a larger `DATABASE_POOL_SIZE` and more
concurrent requests, and that one is headroom rather than a measurement — no run
in this repository has asked the application node for more than 745 MiB.

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
