# The capacity harness

What `docs/capacity.md` claims, and the four commands that produce it. Read that
page first — it is the argument; this is the runbook.

| File | What it is |
| --- | --- |
| `cohorts.mjs` | The population: three cohorts, and the two rates that make it more than a flat pile of rows |
| `schedule.mjs` | The run: the rates, the burst, the imports, the mix, and what a pass means |
| `seed.mjs` | Builds the population in SQL, then refuses to finish until it balances |
| `verify.mjs` | The balance checks, runnable on their own against any seeded database |
| `reset.sql` | Empties a seeded database so it can be seeded again |
| `measure.mjs` | The percentile, the mix wheel and the error count the report is made of |
| `credentials.mjs` | Gives the seeded users a password, minted by the application |
| `load.mjs` | Applies the load and reports against the thresholds |
| `compose.capacity.yml` | The image under test, its metrics, and a published database port |
| `compose.limits.yml` | The `small` machine, enforced |

## Running it

A throwaway machine with about 50 GB free. The full population is 30 million
transactions and lands around 35 GB, plus write-ahead log.

```sh
# 1. The image under test. Not the released tag — a capacity proof of the
#    previous release would be a capacity proof of the previous release.
docker build -t simple-balance:capacity .

# 2. The profile, unconstrained, because seeding is setup rather than the
#    measurement.
cd deploy/compose/single
cp .env.example .env && $EDITOR .env      # POSTGRES_PASSWORD, AUTH_SECRET,
                                          # APP_BASE_URL=http://localhost:3100,
                                          # APP_PORT=3100, POSTGRES_DATA_DIR
docker compose -f compose.yml -f ../../../scripts/capacity/compose.capacity.yml up -d --wait

# 3. The population. Takes about an hour and a half at full scale; --scale 100
#    is a hundredth of it and takes under a minute.
cd ../../..
export CAPACITY_DATABASE_URL='postgresql://simple_balance:...@127.0.0.1:5442/simple_balance'
export CAPACITY_BASE_URL='http://localhost:3100'
node scripts/capacity/seed.mjs
node scripts/capacity/credentials.mjs

# 4. The machine the profile describes, and the run.
cd deploy/compose/single
docker compose -f compose.yml \
               -f ../../../scripts/capacity/compose.capacity.yml \
               -f ../../../scripts/capacity/compose.limits.yml up -d --wait
cd ../../..
node scripts/capacity/load.mjs
```

`load.mjs` exits non-zero when any threshold is missed, so it is usable as a
gate as well as a report.

## Rehearsing it

The full run is ninety minutes of seeding and seventy of load. Prove the harness
first:

```sh
node scripts/capacity/seed.mjs --scale 100
node scripts/capacity/credentials.mjs
node scripts/capacity/load.mjs --users 20 --warmup 0 --minutes 2 --rps 5 --no-imports
```

A rehearsal's *numbers* mean nothing — a hundredth of the data on an
unconstrained machine is not the claim — but every code path is the same one.

## Things that will surprise you

- **`CAPACITY_BASE_URL` must be the deployment's `APP_BASE_URL` exactly.**
  `http://localhost:3100` and `http://127.0.0.1:3100` are different origins, and
  every state-changing request is compared against that value. The symptom is a
  `CROSS_ORIGIN_REQUEST` on sign-up, which reads like a permissions problem.
- **The deployment needs `TRUST_PROXY=true` and `ALLOWED_EMAILS=*`.**
  `compose.capacity.yml` sets both. Sign-in attempts are counted per client
  address and the whole run arrives from one machine, so without the first the
  fifth sign-in is refused and the pool is four people.
- **Seeding twice into one database is refused**, because the ids are derived
  from a counter rather than generated and the second run would collide with the
  first on its primary key. Seed a fresh database, or empty this one:
  `psql "$CAPACITY_DATABASE_URL" -f scripts/capacity/reset.sql`.
- **`docker stats` reports CPU against one core.** A container using six cores
  of an eleven-core machine reads as 620%, which means nothing against a
  threshold. `load.mjs` divides by the container's own limit and says which it
  is reporting.
- **The driver measures from when a request was due**, not from when it was
  sent. Under load the two diverge, and the gap is the queue — which is the
  thing being measured, not an artefact.
