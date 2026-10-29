---
name: release-prep
description: Prepare the branch for a release, or a pull request for merging, without cutting a version. Audits for upgrade-breaking changes, runs guides-update, then reads what the branch changed and what that reaches once — guides-comply's sweep and the adversarial defect hunt together — fixes what survives being reproduced, runs design-review on the pages the branch changed, removes dead code, rebuilds the product kit, recounts, runs all three test tiers, commits and pushes, and reports readiness. Use when asked to clean up, prep for a release or a merge, get things ready to cut, or "commit and push, don't cut a version".
---

# Prepare a release without cutting it

Twelve phases, in this order: 0 scope, 1 upgrade safety, 2 `guides-update`,
3 the sweep, 3a fix, 3b `design-review`, 4 dead code, 4a `product-kit`,
5 recount, 6 verify, 7 commit and push, 8 report. The order is load-bearing:
each phase can invalidate the phases before it, so running them out of sequence
means running them twice. That happened four times in the session this skill
came from.

This is the one procedure to run before a pull request merges, as well as
before a release. It runs the other four skills itself, so they are not steps
somebody has to remember beside it.

**Never cut the version.** No `set-version`, no changelog date, no tag, not even
locally. That is `cut-release`, and it needs a go-ahead given in the current
turn. This skill ends by reporting that a cut is *possible*.

## What it reads, and why not more

Every phase but the product kit is scoped to **the branch and its reach**: what
the diff changed, plus everything that uses something shared the diff changed —
a component, a token, a helper, a schema, a guide rule. A change can break a
rule in code it never touched, and the reach is how that code gets read. Code
outside it has not changed, and the whole-product sweeps are where it gets read
again: `guides-comply` and `design-review` run alone, on purpose, every few
releases or after a change to something everything uses.

That is a trim, and the reason is measured. The run on PR #98 in October 2026
swept the whole product, read the diff once per concern and again per guide,
and checked each finding with its own fresh agent: about 120 agents, 9,500
turns and over seven hours of running. Half of it went to re-reading and
re-fixing code the branch never touched, the 96 one-finding skeptics were more
than half of all the fresh input because each started cold and read the same
files again, and the one fixer handed every sweep finding ran 805 turns and
cost more than all eight audit passes together. So:

- **Each surface is read once**, by one reader asking both questions: what
  would have to be true for this to be wrong, and which rule does it break.
- **The fixer is the skeptic.** A finding is fixed only after it is reproduced
  (a failing test, a photograph, a command), and one that cannot be is rejected
  and recorded. A separate skeptic is worth its cold start only for a finding
  whose fix would redesign something.
- **No agent carries every fix.** A fixer's context grows with each one; take
  the surfaces in turn with a fresh one each.

Run as agents, that is about a dozen: phase 1 beside phase 2, a sweep reader
per surface, a fixer per surface in turn, one for the design review and its
fixes, one for dead code and the kit, and one for the recount and the three
tiers, which loop back on each other anyway. The commit message is written by
whoever holds all their reports.

## 0. Scope

```sh
git status --short && git log --oneline main..HEAD | cat
git diff main...HEAD --stat | tail -30
```

Write the list of changed surfaces — pages, routes, tools, services, config,
migrations — then its reach: for each shared thing the diff changed, find its
users and add them. Keep the list. Every later phase walks it and nothing else.

## 1. Upgrade safety — first, because a finding here redesigns a feature

`AGENTS.md` states it as an invariant and `docs/standards/writing.md` §Versioning
argues it: **a release upgrades cleanly from the one before it.** Not "breaks
only where documented" — does not break. Read that section for the reasoning
before judging anything; it holds the list of what the rule rules out.

A break found here is not a patch, it is a different design. In the source
session five changes had to be reverted to warnings and one setting redesigned
from scratch. So this phase reads only the five surfaces below and runs beside
phase 2, and a finding that redesigns something is fixed before phase 3 reads
the code it would change; the rest join phase 3a.

| Surface | A break is |
| --- | --- |
| HTTP `/api/v1` | A field removed or renamed, an accepted input narrowed, a status or error code changed for an unchanged request, a default changed |
| MCP | A tool removed or renamed, a required argument added, a scope widened, an output field removed |
| CSV | A recognized column removed from `APP_CSV_COLUMNS`, or an existing column's meaning changed |
| The Simple Balance file | A published format token no longer read, a field removed or given a new meaning, or a field added that a file without it cannot be read past |
| Deployment | A configuration variable renamed, removed, or made required; a refusal to start on a configuration the previous version accepted; a new external dependency; a raised floor on PostgreSQL or Node |

The three shapes a fix almost always takes:

- A setting that was accepted stays accepted. If it is wrong, **warn and carry
  on** — never refuse. `src/server/config-limits.ts` is the model.
- A precedence that existed is kept, including which of `NAME` and `NAME_FILE`
  wins. The warning may be new; the outcome may not.
- A path that answered keeps answering, registered under its old spelling with
  `Deprecation` and `Sunset` headers.

A new setting defaults to **off**, so a deployment that never set it is
unchanged. A new behavior that deletes or prunes anything defaults to off in
the safe direction, and an invalid value falls back to off rather than to the
active default — the reverse prunes on a typo.

The deployment material the branch changed is this phase's to read in full, not
only for breaks: it is the one surface phase 3 leaves to it. Confirm every
`/api/v1` rename still answers on the old path, and that `docs/upgrades.md` has
a `## Before you upgrade to X.Y.Z` section for the *next* version.
`tests/version.test.ts` fails without it, so an unwritten note stops the
release rather than reaching an operator mid-upgrade.

## 2. Bring the guides true for this branch — before sweeping against them

Run the **`guides-update`** skill. Phase 3 holds the branch to the guides, so
the guides have to describe it first. Swept against a guide that still
describes the code from before the branch, a pattern the branch introduced on
purpose reads as a violation, and the sweep "fixes" it back to the old one.

It runs once. Every fix after it writes the sentence its own change makes
untrue in the same edit, so there is nothing for a second pass to find, and
phase 5 recounts the numbers rather than rereading the prose.

## 3. Sweep and hunt — one reading of each surface

Run the **`guides-comply`** skill's §1–5 over the phase 0 list instead of the
whole product: the list is the surface its §2 would otherwise enumerate. Read
each item once, against both questions, and write findings down with
`file:line` without fixing anything yet.

- **Which rule does it break.** The rules of its guide, Binding first.
  `guides-comply` §4 holds the checks that repeatedly find defects and the
  traps an ad-hoc script falls into.
- **What would have to be true for it to be wrong.** Then go and check that,
  rather than reading for reassurance. By surface:
  - services, shared modules and the database — the ledger invariants in
    `AGENTS.md`, transaction boundaries and concurrency, the N+1 and the
    unindexed read;
  - HTTP and MCP — auth and tenancy scoping, error paths and partial failure,
    parity including the request field only an agent can set;
  - the client — accessibility of anything new, and every state a changed
    section can reach.

`guides-comply` §6–7, building checks for rules nothing enforces, runs here
only for a rule this branch broke that no check caught: that is the one rule a
check has just been shown to be needed for. The rest of that inventory is
`guides-comply`'s own job, run alone.

## 3a. Fix what survives being reproduced

Argue every finding against itself before acting on it. The standard is that a
finding survives an attempt to refute it, not that it sounded plausible; the
last audit written up in `docs/standards/writing.md` had forty-one findings and
twenty-four did not survive. The attempt is the reproduction: a test that fails
on the code as it is, a photograph of the state, a command and its output. A
finding nobody can reproduce is rejected.

**Record the rejected ones with their reasons**, in the commit body.
`docs/standards/writing.md` §The body requires it, and gives the reason: a
rejected finding that is not written down gets re-found.

Every fix that changes domain behavior gets a focused test. Every new check
gets **mutation-proved**: break the thing it guards, watch the check fail by
name, restore it, watch it pass. A check nobody has seen fail is a check that
may not be able to fail. Several in this repository could not, each found
exactly this way; `git log --oneline --grep "able to fail"` has the history.

Take the surfaces in turn, phase 1's leftovers first. Never fix a violation by
weakening the rule; a rule that is wrong goes back through `guides-update`.

## 3b. Review the pages the branch changed

Run the **`design-review`** skill whenever the diff touches `src/client/` or the
stylesheet. A diff that touched neither cannot have changed a page; say so in
the report as the reason it did not run, rather than leaving it out silently.

Its matrix still compares down the columns, but only the pages in phase 0's list
are photographed, in their states and at the widths that skill names. The other
pages' cells come from the committed kit, `docs/product/screenshots/` — every
screen in both themes at 1440px — rather than being shot again. A change to a
shared component or a token puts every page that uses it on the list, which can
be all of them; then it is the whole matrix, and that is the right cost.

A layout fix is measured, never argued, so the photograph that shows a defect
is its reproduction. It comes after 3a because those fixes can change pages,
and before 4a because the product kit photographs what this phase leaves.

## 4. Dead code — after every fix, because fixes orphan code

```sh
npx knip --no-config-hints
```

knip is not a dependency here and has no config, so **vet every hit**. It
reports "unused export" for anything nothing *imports*, which conflates two
different things:

- Used only inside its own module → the code is live, the `export` is too wide.
  Narrow it, then let `npm run typecheck` prove it was internal.
- Referenced nowhere at all → genuinely dead. Delete.

Three traps, all hit in the source session:

- Two different symbols can share a name across modules. Resolve real `import`
  statements, not bare word matches, before believing a cross-module hit.
- A test may reference a symbol inside a *regex* rather than importing it.
  Narrowing the export is still correct.
- `src/client/api.ts` is a **types barrel by design** — pages import response
  shapes from it. Its unused exports stay.

Also sweep the stylesheet — every class it defines against every name the
source could produce:

```sh
node -e '
const {readFileSync,globSync}=require("node:fs");
const css=readFileSync("src/client/styles.css","utf8");
const defined=new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m=>m[1]));
const src=globSync("src/**/*.{ts,tsx}").filter(f=>!f.endsWith(".css"))
  .map(f=>readFileSync(f,"utf8")).join("\n");
console.log([...defined].filter(c=>!src.includes(c)).join("\n"));'
```

Nearly every hit will be a false positive: classes are built by interpolation
(`button-${variant}`, `alert-${kind}`, `badge-${tone}`, `chart-series-${n}`), and
a `.class` written inside a comment looks like a definition. Confirm each by
finding how it is composed before deleting anything.

Report "nothing was dead" when nothing was. That is a real result, and inventing
removals to look productive is worse than a clean sweep.

## 4a. Rebuild the product kit

Run the **`product-kit`** skill, which owns this. It is the one phase that is
not scoped to the branch: the marketing site shows every screen, and the
sidebar alone changes all of them.

`docs/product/` is what the marketing site at smpl.money reads: the tiered
feature list, and a screenshot of every screen in both themes. That site is a
separate repository and **cannot run this application**, so if the kit is not
rebuilt here it is not rebuilt anywhere, and it goes on describing a version
of the product that no longer exists.

Two things decide whether this phase has work in it:

- **Did any screen change?** Then the screenshots are stale, and stale
  screenshots are the most convincing way to be wrong — they look current.
- **Did a capability land, change or go?** Then `features.json` is stale, and
  the marketing site will keep advertising something that is gone or miss
  something new.

**And always the skill's §6, whatever those two say.** It runs
`node scripts/sync-learn.mjs --check`, which takes seconds and needs neither
the database nor a browser, and compares the money guides the MCP server
carries with what smpl.money publishes. That direction changes when the site
does, not when this branch does, so a branch with no new screen and no new
capability is exactly where it goes stale unseen. Its exit decides the rest —
0 nothing, 1 the `--write` and the step-map edits §6 tabulates, 2 nothing
concluded — and its one line goes in the readiness report.

**The marketing site reads the kit from `main` once `main` carries it, and
until then from the branch of the open release pull request**, and it works
out which itself. A kit rebuilt on any other branch reaches nobody until it
lands on one of those, so say in the readiness report which branch the rebuilt
kit is on rather than assuming the next person infers it.

## 5. Recount — last of the document work, and never earlier

Every source edit moves line numbers and counts, so a recount done before the
last edit is a recount you will do again. This is the single biggest waste in
the source session: four full passes because it was run too early.

Do not compute these by hand. Run the suite and let the meta-tests report the
true numbers, then write those numbers in:

```sh
npx vitest run tests/comment-density.test.ts tests/testing-guide-counts.test.ts \
  tests/standards-citations.test.ts tests/mcp-measurements.test.ts
```

| What drifts | Held by | Lives in |
| --- | --- | --- |
| Comment density | `tests/comment-density.test.ts` | `docs/standards/code/comments.md`, `AGENTS.md` |
| Test tier and run tables | `tests/testing-guide-counts.test.ts` | `docs/standards/code/testing.md` |
| Every `file:line` citation | `tests/standards-citations.test.ts` | all of `docs/standards/` |
| MCP payload measurements | `tests/mcp-measurements.test.ts` | `docs/standards/mcp.md`, `AGENTS.md` |
| Route table | `tests/http-route-table.test.ts` | `docs/standards/http.md` |
| Lint rules documented | `tests/lint-config-documented.test.ts` | `docs/standards/code/index.md` |
| Tool names | `tests/mcp-parity.test.ts` | `docs/mcp.md` |
| Frozen migrations | `tests/migrations.test.ts` | `AGENTS.md` |
| The money guides' steps, mapped to tools | `tests/learn-pack.test.ts` | `src/server/learn/in-simple-balance.ts` |

Adding a test file moves **both** the tier table and the run table, and the
density percentage in two files. Expect a second pass and take it.

**Fix citations from the failure output, not from a diff.** The test names the
guide line and what actually sits at the line it points to, which is idempotent
— you can run it as many times as you like. Renumbering mechanically from
`git diff -U0` double-applies as soon as the diff grows, which is a whole
afternoon of confusing failures.

The test proves a cited line exists, not that it is the line meant. After a big
branch, map each citation into a changed file from the branch's base with
Python's `difflib` and read by eye where a line does not map: on 2026-09-23,
312 of 685 citations were wrong and passing. Registers inside tests carry
`file:line` too (`NOT_A_FIELD` and friends) and drift the same way, with no
citation test watching them.

## 6. Verify, all three tiers

```sh
npm run verify
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:integration
BROWSER_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:browser
```

`verify` is typecheck → lint → format:check → test → build. The other two need a
throwaway PostgreSQL and are not in it. Run all three: the integration tier is
where a migration and a query plan are actually exercised, and CI runs it too,
so skipping it locally only moves the failure.

If anything changed after phase 5, go back to phase 5 — which is why one pair
of hands should own both.

## 7. Commit, push, watch

`docs/standards/writing.md` §Commit messages owns the shape; read it rather than
guessing. In brief: an imperative subject naming what is now true from the
reader's side, no prefix, no scope, no full stop, 70 characters as a ceiling.
The test for a subject is whether somebody who has not seen the diff could tell
whether it affects them. A body of hard-wrapped prose in the low-to-mid 70s,
never absent, owing five things — why the bug survived review, numbers for any
performance claim, what was checked and how, findings that were rejected and
why, and corrections to the previous commit's message. End it with the
`Co-Authored-By:` trailer for the model that did the work.

Then push and wait for all of it:

```sh
git push && gh run watch "$(gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh pr checks "$(git branch --show-current)"
```

Green means every check `gh pr checks` lists, not the workflow conclusion
alone while a check is still pending. "Skipping" on the citus-image manifest
job is the expected state on a pull request rather than something to chase: it
only runs when a run publishes.

## 8. Report readiness, and stop

Say plainly what is true:

- Version unchanged, `## Unreleased` still undated, no tag.
- `CHANGELOG.md` `## Unreleased` covers this branch's work.
- `docs/upgrades.md` has the next version's `## Before you upgrade` section.
- `AGENTS.md` names every unreleased migration.
- Whether `docs/product/` was rebuilt, and that the marketing site does not
  see it until this merges.
- The learn pack's line from `product-kit` §6: in sync with smpl.money, from
  a local site build, or not checkable and why.
- All three tiers and every check green.
- What the sweep found, what was fixed, and what was rejected and why — the
  checks it built included.
- What `design-review` found and fixed, or that no page changed and so it did
  not run.
- Anything deliberately left, and why.

`docs/acceptance.md` is where the standing version of that last pair lives: one
row per claim, each naming the evidence that closes it, and a second table of
what is outstanding with the reason. Update it rather than restating it here — a
report is read once and a table is read before every cut.

Then stop. Do not merge the PR. Do not cut the version.
