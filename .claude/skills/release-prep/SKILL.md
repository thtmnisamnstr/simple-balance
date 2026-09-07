---
name: release-prep
description: Prepare the branch for a release without cutting one. Audits for upgrade-breaking changes, runs an adversarial defect hunt, removes dead code, brings the docs' measured numbers back to true, runs all three test tiers, commits and pushes, and reports readiness. Use when asked to clean up, prep for a release, get things ready to cut, or "commit and push, don't cut a version".
---

# Prepare a release without cutting it

Nine phases, in this order. The order is load-bearing: each phase can invalidate
the phases before it, so running them out of sequence means running them twice.
That happened four times in the session this skill came from.

**Never cut the version.** No `set-version`, no changelog date, no tag, not even
locally. That is `cut-release`, and it needs a go-ahead given in the current
turn. This skill ends by reporting that a cut is *possible*.

## 0. Scope

```sh
git status --short && git log --oneline main..HEAD | cat
git diff main...HEAD --stat | tail -30
```

Everything below is scoped to that diff. Write the list of changed surfaces —
pages, routes, tools, services, config, migrations — and keep it; phases 1, 2
and 5 each walk it.

## 1. Upgrade safety — first, because a finding here redesigns a feature

`AGENTS.md` states it as an invariant and `docs/standards/writing.md` §Versioning
argues it: **a release upgrades cleanly from the one before it.** Not "breaks
only where documented" — does not break. Read that section for the reasoning
before judging anything; it holds the four-surface table below and the list of
what the rule rules out.

This is first because a break found here is not a patch, it is a different
design. In the source session five changes had to be reverted to warnings and
one setting redesigned from scratch — finding that after the dead-code sweep and
the recount would have wasted both.

Check the diff against each surface:

| Surface | A break is |
| --- | --- |
| HTTP `/api/v1` | A field removed or renamed, an accepted input narrowed, a status or error code changed for an unchanged request, a default changed |
| MCP | A tool removed or renamed, a required argument added, a scope widened, an output field removed |
| CSV | A recognised column removed from `APP_CSV_COLUMNS`, or an existing column's meaning changed |
| Deployment | A configuration variable renamed, removed, or made required; a refusal to start on a configuration the previous version accepted; a new external dependency; a raised floor on PostgreSQL or Node |

The three shapes a fix almost always takes:

- A setting that was accepted stays accepted. If it is wrong, **warn and carry
  on** — never refuse. `src/server/config-limits.ts` is the model.
- A precedence that existed is kept, including which of `NAME` and `NAME_FILE`
  wins. The warning may be new; the outcome may not.
- A path that answered keeps answering, registered under its old spelling with
  `Deprecation` and `Sunset` headers.

A new setting defaults to **off**, so a deployment that never set it is
unchanged. A new behaviour that deletes or prunes anything defaults to off in
the safe direction, and an invalid value falls back to off rather than to the
active default — the reverse prunes on a typo.

Confirm every `/api/v1` rename still answers on the old path, and that
`docs/upgrades.md` has a `## Before you upgrade to X.Y.Z` section for the
*next* version. `tests/version.test.ts` fails without it, so an unwritten note
stops the release rather than reaching an operator mid-upgrade.

## 2. Adversarial audit

Hunt for what the suite does not catch. Work from the diff, and for each area
ask what would have to be true for the code to be wrong, then go and check that
rather than reading for reassurance.

Give each area its own pass rather than one sweep: correctness and the ledger
invariants in `AGENTS.md`; concurrency and transaction boundaries; the N+1 and
the unindexed read; auth and tenancy scoping; error paths and partial failure;
MCP parity, including the one-level-down case where a request field only an
agent can set; accessibility on anything new in the client.

Then argue every finding against itself before acting on it. The standard is
that a finding survives an attempt to refute it, not that it sounded plausible.
The last audit written up in `docs/standards/writing.md` had forty-one findings
and twenty-four did not survive being argued against.

**Record the rejected ones with their reasons**, in the commit body.
`docs/standards/writing.md` §The body requires it, and gives the reason: a
rejected finding that is not written down gets re-found. Two of the last audit's
claims did not survive checking and are named in the commit that closed it.

## 3. Fix what phases 1 and 2 found

Every fix that changes domain behaviour gets a focused test. Every new check
gets **mutation-proved**: break the thing it guards, watch the check fail by
name, restore it, watch it pass. A check nobody has seen fail is a check that
may not be able to fail. Several in this repository could not, each found
exactly this way; `git log --oneline --grep "able to fail"` has the history.

## 4. Dead code — after the fixes, because fixes orphan code

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

## 5. Bring the documents back to true

Do not do this inline — run the **`guides-update`** skill, which owns it. It
covers the guides, `AGENTS.md`, `CHANGELOG.md` and `docs/upgrades.md`, and it
ends where phase 6 begins.

## 6. Recount — last of the document work, and never earlier

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

Adding a test file moves **both** the tier table and the run table, and the
density percentage in two files. Expect a second pass and take it.

**Fix citations from the failure output, not from a diff.** The test names the
guide line and what actually sits at the line it points to, which is idempotent
— you can run it as many times as you like. Renumbering mechanically from
`git diff -U0` double-applies as soon as the diff grows, which is a whole
afternoon of confusing failures.

Registers inside tests carry `file:line` too (`NOT_A_FIELD` and friends) and
drift the same way, with no citation test watching them.

## 7. Verify, all three tiers

```sh
npm run verify
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:integration
BROWSER_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:browser
```

`verify` is typecheck → lint → format:check → test → build. The other two need a
throwaway PostgreSQL and are not in it. Run all three: the integration tier is
where a migration and a query plan are actually exercised, and CI runs it too,
so skipping it locally only moves the failure.

If anything changed after phase 6, go back to phase 6.

## 8. Commit, push, watch

`docs/standards/writing.md` §Commit messages owns the shape; read it rather than
guessing. In brief: an imperative subject naming what is now true from the
reader's side, no prefix, no scope, no full stop, 70 characters as a ceiling.
The test for a subject is whether somebody who has not seen the diff could tell
whether it affects them. A body of hard-wrapped prose in the low-to-mid 70s,
never absent, owing five things — why the bug survived review, numbers for any
performance claim, what was checked and how, findings that were rejected and
why, and corrections to the previous commit's message.

Trailer, in this casing:

```text
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Then push and wait for all of it:

```sh
git push && gh run watch "$(gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh pr checks "$(git branch --show-current)"
```

Thirteen checks: ten in the verify workflow (four `verify` matrix entries across
PostgreSQL 15/16 and Node 22/24, four image builds, browser, deployment
material) and three CodeQL. Green means green — do not report success off the
workflow conclusion alone while a check is still pending.

## 9. Report readiness, and stop

Say plainly what is true:

- Version unchanged, `## Unreleased` still undated, no tag.
- `CHANGELOG.md` `## Unreleased` covers this branch's work.
- `docs/upgrades.md` has the next version's `## Before you upgrade` section.
- `AGENTS.md` names every unreleased migration.
- All three tiers and all thirteen checks green.
- What the audits found, what was fixed, and what was rejected and why.
- Anything deliberately left, and why.

Then stop. Do not merge the PR. Do not cut the version.
