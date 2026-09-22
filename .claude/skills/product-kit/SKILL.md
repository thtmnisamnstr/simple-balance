---
name: product-kit
description: Rebuild docs/product — the tiered feature list and a screenshot of every screen — which the marketing site at smpl.money reads. Use when the app's look or capabilities change, as part of release-prep, or when asked to refresh the marketing screenshots or feature list.
---

# Rebuild what the marketing site reads

`docs/product/` is this repository's public description of itself:

| File | What it is |
| --- | --- |
| `facts.json` | The plans, their labels, the free account limit and the prices. Half of it is read out of the source and half of it is declared — see below. |
| `features.json` | What the product does, tiered by how much a general reader would care. **Declared** — a judgement, not a property of a module. |
| `screenshots/` | Every screen, both themes, 1600px WebP. |
| `screenshots.json` | The manifest tying the two together. |

**`facts.json` is generated, and only half of it is checked.** `derived` — the
plans, their labels and the free account limit — is read out of `src/shared/`,
and `tests/product-facts.test.ts` fails when the committed file disagrees with
those constants. `declared` — the prices and the capability list — is written
by hand in `scripts/build-product-facts.mjs`, because the prices live at Stripe
and only the ids are here; the test checks that a price is a decimal string and
nothing more. So **a price, plan, label or limit change is an edit to that
script and a re-run of it, in the same commit as the change itself**:

```sh
npx tsx scripts/build-product-facts.mjs   # `node` cannot: it imports TypeScript
```

Nothing in CI runs it. The test compares rather than regenerating, so a stale
file fails instead of being quietly rewritten by the thing checking it.

The marketing site is a separate repository at
`https://github.com/thtmnisamnstr/simple-balance-web`. It **cannot run this
application**, so if the kit is not built here it is not built anywhere, and
that site falls back to describing screens nobody has looked at.

## 1. The feature list

Edit `docs/product/features.json` when a capability lands, changes or goes.

**Tiers are about the reader, not the engineering.**

- **A** — the reason somebody would use this at all. If a stranger reads
  three things, these are the three. Keep it to four or five; a tier A of ten
  is not a tier, and `tests/product-kit.test.ts` caps it.
- **B** — matters once they are using it. Not why they arrive; why they stay.
- **C** — depth. Only some people need these, and those people need them a
  lot.

`rank` orders within a tier, from 1, no gaps and no ties — the marketing site
presents them in that order, so a tie makes the order arbitrary.

**Write `plain` for somebody with no accounting background.** It is the
starting point the marketing site rewrites from, and a sentence written for
whoever wrote the code gives it nothing to work with. Say what the person
gets, not what the system does: "Upload the file your bank gives you", not
"CSV ingestion with format inference".

**`why` is the half the marketing site cannot invent honestly**, because it
is a claim about who uses this and what goes wrong for them. One sentence.

## 2. The screenshots

They need this application running against a seeded database.
`docs/standards/operations.md` owns the runbook this repeats in short; read it
there if anything below does not work.
`scripts/product-kit/seed.json` is the fixture, committed rather than
generated: a screenshot of random data cannot be reproduced, so two captures
a month apart cannot be compared and a layout regression hides in the noise.

```sh
# 1. a throwaway database — not your development one, and not on 5432
docker run -d --name sb-kit-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=sb_kit -p 55434:5432 postgres:18-alpine

# 2. this application against it
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55434/sb_kit \
APP_BASE_URL=http://localhost:5173 PORT=3000 AUTH_MODE=local ALLOWED_EMAILS='*' \
AUTH_SECRET=product-kit-secret-long-enough-for-the-config-validator-01 \
NODE_ENV=development RECURRENCE_SCHEDULER=false npx tsx src/server/index.ts &
npx vite --port 5173 --strictPort &

# 3. build it — `tsx`, because it asks `calendarDayIn` what day it is
npx tsx scripts/product-kit/build.mjs

# 4. and put the database away
docker rm -f sb-kit-pg
```

### Six traps, all paid for already

- **Do not pipe the output through `head`.** SIGPIPE kills it mid-capture and
  leaves a partial set that looks complete. Redirect to a file.
- **The seed's dates are relative on purpose.** Every page defaults to a
  this-month range, so a fixed calendar renders an empty dashboard the moment
  the month turns.
- **Both currencies need budgets.** The overview renders a block per
  currency; seeding one leaves the other reporting "no budget set" beside a
  populated one, which reads as a broken feature.
- **The identity is fixed and visible** in the sidebar of every shot, so a
  re-run meets an account that already exists. The script signs in instead of
  failing, and the seed is idempotent.
- **A re-run against a dirty database is fine; a re-run against a *different*
  database is not.** Drop it and start clean if anything looks off.
- **One clock, or the current month comes out short.** The seed's dates and
  the browser's "today" have to be the same day. They were not: the dates
  were computed in UTC and the browser used the machine's zone, so a capture
  run in the evening in California dated the month's last entries into
  tomorrow — and this application correctly declines to count money that has
  not moved, so the dashboard, the budgets and the reports were all quietly
  a hundred and seventy dollars light with nothing on screen to say so — two
  entries, and no sign of them anywhere. The script now asks
  `calendarDayIn` and hands the browser the same zone. If `capturedAt` in
  `screenshots.json` disagrees with the "As of" date in the pictures, this is
  what has come apart again.

## 3. Check the output, do not assume it

The suite holds the shape. It cannot see whether a picture is any good.

```sh
npx vitest run tests/product-kit.test.ts
```

Then **open several of them**, in both themes. `docs/standards/web.md` is what
they are being judged against, and nothing in this suite can see any of it. A screen that rendered an
error, an empty state, or a loading skeleton is a screen the marketing site
will publish. The file size will not tell you.

## 4. When a screen is added or removed

The script photographs whatever the main navigation contains, so a new screen
appears without being listed. What does *not* update itself is
`features.json` — a new screen with no feature pointing at it is a picture
nobody will use, and a feature pointing at a screen that has gone fails the
build. The test catches the second; the first is worth a thought.

## 5. Finish

The kit is committed, and `AGENTS.md` records it as this repository's public
description of itself. The marketing site pulls it from `main`, so **it is not
available to that site until this branch merges** — say so when handing over,
because the obvious assumption is that pushing is enough.

Then `npm run verify`, and `release-prep` if this is part of one.
