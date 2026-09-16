# Running the `ha` database

The operational half of `docs/citus.md`, which has the reasoning and the shape.
This page is what to actually do, and every procedure here was run against a
real three-node Kubernetes cluster rather than written from documentation.

The cluster is PostgreSQL 18 with Citus 14.2, run by Patroni. One Patroni
cluster per Citus group: group 0 is the coordinator, 1..N are workers, and each
group is a primary with streaming standbys. Patroni elects and promotes; Citus
shards and routes. Nothing in this product does either.

## What you are looking at

```sh
kubectl -n <namespace> exec <any database pod> -- \
  patronictl -c /etc/patroni/patroni.yml list
```

```
+ Citus cluster: sb-simple-balance-db ------+--------------+-----------+----+
| Group | Member                   | Host        | Role         | State     | TL |
+-------+--------------------------+-------------+--------------+-----------+----+
|     0 | sb-simple-balance-db-0-0 | 10.244.2.60 | Leader       | running   |  1 |
|     0 | sb-simple-balance-db-0-1 | 10.244.1.63 | Sync Standby | streaming |  1 |
|     1 | sb-simple-balance-db-1-0 | 10.244.1.61 | Leader       | running   |  1 |
|     1 | sb-simple-balance-db-1-1 | 10.244.2.63 | Sync Standby | streaming |  1 |
+-------+--------------------------+-------------+--------------+-----------+----+
```

**`Sync Standby` is the word to look for.** It means synchronous replication is
in force for that group: a transaction is not acknowledged until that standby
holds it, so promoting it cannot lose an acknowledged write. A group showing
`Replica` instead has fallen back to asynchronous, which happens when no standby
is available — the cluster keeps serving, and the no-loss guarantee is suspended
until a standby is back. That is the trade `database.synchronousReplication`
makes, and §Losing a standby says what to do about it.

`TL` is the timeline. It increases by one on every promotion, which makes it the
quickest way to tell whether a cluster has failed over since you last looked.

Where the application connects is `<release>-db-0`, the coordinator group's
Service. Patroni keeps its Endpoints pointed at whichever pod is currently
primary, so nothing needs redeploying when that changes.

## Adding a worker

Raise `database.workers` and upgrade. Patroni brings up the new group, elects a
primary, and registers it with Citus using `citus_add_node` on its own.

```sh
helm upgrade <release> deploy/helm/simple-balance \
  -f your-values.yaml --set database.workers=3
```

Confirm it joined before doing anything else — a group that exists in Kubernetes
but not in `pg_dist_node` holds no data and will not be given any:

```sh
kubectl -n <ns> exec <coordinator pod> -- psql -U postgres -d simple_balance -tAc \
  "select groupid, nodename, noderole from pg_dist_node order by groupid, noderole"
```

**A new worker starts empty.** Nothing moves to it until you rebalance, so
adding one changes nothing about how the load is spread until the next step.

## Rebalancing

```sh
kubectl -n <ns> exec <coordinator pod> -- psql -U postgres -d simple_balance -tAc \
  "select citus_rebalance_start()"
```

It returns immediately and runs as a background job. Watch it:

```sh
kubectl -n <ns> exec <coordinator pod> -- psql -U postgres -d simple_balance -tAc \
  "select state, details from citus_rebalance_status()"
```

Measured on a cluster holding the whole application schema, going from two
workers to three: **10 shard moves, finished in under two minutes**, taking each
worker from 286 shard placements to 201, 201 and 184. The unevenness is normal —
the rebalancer moves whole shards and stops when it is close enough.

**It does not take writes offline.** Citus moves a shard by logically
replicating it and cutting over at the end, which is why `wal_level` is
`logical` in this chart's Patroni configuration. If that is ever lowered to
`replica`, the rebalancer falls back to blocking writes on the shard it is
moving, and a rebalance becomes an outage rather than a background job.

To stop one: `select citus_rebalance_stop()`. Shards already moved stay moved;
this is safe to do under load.

## What a failover does

Killing the coordinator's primary, which is the case worth having seen:

```sh
kubectl -n <ns> delete pod <coordinator primary>
```

Patroni notices within the TTL (30 seconds by default), promotes the sync
standby, and updates the leader Endpoints. The application's connection string
does not change — it names the Service, and the Service now resolves to the new
primary. Measured end to end: promotion and the Service following it inside 40
seconds, with the ledger intact.

Two consequences worth knowing:

- **Open connections are dropped.** The application reconnects; a request in
  flight fails. Nothing is half-committed, because synchronous replication means
  the standby already had every acknowledged transaction.
- **The old primary comes back as a standby.** Patroni rewinds it with
  `pg_rewind` rather than recloning, so it is usually back in seconds.

A worker failover is the same, with one addition: Patroni pauses coordinator
traffic across the switchover and calls `citus_update_node`, so the coordinator
learns the new address rather than holding connections to a node that is gone.

## Losing a standby

A group whose standby is gone shows `Replica` or nothing in `patronictl list`,
and the primary keeps serving. This is deliberate — `synchronous_mode_strict`
is off — and it means the no-loss guarantee is suspended while you are in that
state.

If you would rather stop than serve without it:

```sh
kubectl -n <ns> exec <pod in that group> -- \
  patronictl -c /etc/patroni/patroni.yml edit-config -s synchronous_mode_strict=true
```

That is a per-group setting and it makes writes fail while no standby is
available. For most deployments that is the wrong trade; for one where a lost
transaction is worse than an outage, it is the right one.

## Changing PostgreSQL settings

`bootstrap.dcs` in the chart's Patroni ConfigMap applies **once**, when a group
first initialises. After that the cluster owns its own configuration, and
changing the chart does not reach a running database. That is Patroni's design
and it is the right one — a `helm upgrade` should not be able to quietly change
a live database's WAL settings.

To change a running cluster:

```sh
kubectl -n <ns> exec <pod in that group> -- \
  patronictl -c /etc/patroni/patroni.yml edit-config
```

Do it per group. `database.parameters` in values.yaml still matters: it is what
a *newly added* group starts with, so leaving the two disagreeing means the next
worker you add is configured differently from the rest.

## Moving an existing database onto a cluster

A deployment already running this release on a single PostgreSQL has
`0023_citus_distribution.sql` recorded as applied — it ran and did nothing,
because there was no Citus extension to act on. Installing Citus later does not
re-run it.

So the distribution is applied by hand, once:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/0023_citus_distribution.sql
```

The file is gated on the extension being present, so running it against a
database without Citus is a no-op rather than a mistake. It is one transaction:
it either distributes everything or changes nothing.

**Take a dump first.** It rewrites fifteen primary keys and rebuilds every index
on them, and while it is atomic, an `ALTER TABLE` that takes a lock on
`posting` for the duration is not something to meet unprepared.

## Backups

`pg_dump` against the coordinator, exactly as for a single database — Citus
makes the shards an implementation detail and a dump taken here restores into a
single PostgreSQL, or into a cluster with a different number of workers.

```sh
kubectl -n <ns> exec <coordinator primary> -- \
  pg_dump -U postgres -Fc simple_balance > simple-balance.dump
```

Check it before you rely on it — `docs/upgrades.md` has the reasoning and the
one-line `pg_restore --list` that does it.

**Do not back up a worker directly.** A worker's shards are meaningless without
the coordinator's metadata, and restoring one on its own produces a database
full of tables named `posting_102153` that nothing will ever read.

## Rebuilding the image

`deploy/docker/citus.Dockerfile` pins three things that move independently: the
PostgreSQL base by digest, the Citus version and its source checksum, and the
Patroni version. Raise them together and deliberately.

The build reads the binary it produces and fails if the extension references
libcurl without linking it — which is the failure PostgreSQL 18 introduces,
because its `pg_config.h` defines `HAVE_LIBCURL` for its own OAuth support and
Citus's `--without-libcurl` then produces a library that cannot load. The
comment in the Dockerfile has the whole story.

`.github/workflows/citus-image.yml` builds it on every change and starts it
before publishing, checking that Citus is loaded, that statistics collection is
off, and that the collation is glibc's rather than musl's.

**Bumping the PostgreSQL major version is not an image bump.** A major version
cannot read the previous major's data directory; that is a dump, a new cluster
and a restore. It is why this image has no `latest` tag.

## When something is wrong

| What you see | What it usually is |
| --- | --- |
| `Could not take out TTL lock`, forever | Patroni cannot find the objects it expects, so it tries to create them and collides with ones that already exist. Check that every Service carries the `cluster-name` label matching the Patroni scope |
| `failed to bootstrap from leader`, in about a millisecond | The leader published no connection URL. Almost always the leader Service has acquired a selector, which hands its Endpoints to Kubernetes and overwrites what Patroni wrote there |
| The Service has the right address and refuses every connection | The Service port is named and Patroni's endpoint port is not. Kubernetes matches them by name |
| `fe_sendauth: no password supplied` naming a worker | `pg_dist_authinfo` has no row for the role running the statement. The post-install Job writes one for the application role; re-run it with `helm upgrade` |
| `helm upgrade` fails with `conflict with "Patroni"` | Something in the chart is claiming a field Patroni owns. The chart must not ship Endpoints objects |
