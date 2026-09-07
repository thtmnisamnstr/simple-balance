---
name: guides-update
description: Bring the standards guides, AGENTS.md, CHANGELOG.md and docs/upgrades.md back to true after development lands. Updates rule text that development contradicted, adds rules for genuinely new patterns, writes the changelog and upgrade notes, and repoints drifted citations. Use after finishing a feature or fix, or when asked to update the guides, standards or docs for work that is done.
---

# Bring the documents back to true

`docs/standards/writing.md` §Keeping a document true states the rule: **a change
that alters behaviour a document describes changes that document in the same
commit.** This skill is that step done systematically instead of from memory.

**Point at the guides, never copy them.** If you find yourself restating a rule
here or in a test comment, cite `file:line` instead. A copied rule drifts, which
is the exact defect this whole guide set exists to prevent.

## 1. What actually changed

```sh
git diff main...HEAD --stat
git log --oneline main..HEAD | cat
```

For each change, write one sentence about the *behaviour* — not the edit. "A
disabled submit now says why" rather than "added a `disabledReason` prop". The
behaviour sentence is what a document describes; the edit is not.

Then sort each into exactly one of:

- **Contradicts a rule that is written down.** The guide is now false. Highest
  priority — a guide that lies is worse than a guide that is silent, because it
  is believed and cited.
- **A new pattern that will recur.** Wants a rule of its own.
- **A one-off inside an existing rule.** May want a citation refresh and nothing
  else.
- **Invisible to every document.** Most refactors. Nothing to do.

## 2. Find the documents that describe it

Map the surface to its guide. `docs/standards/index.md` and
`docs/standards/code/index.md` are the maps; read them rather than guessing.

| Changed | Read |
| --- | --- |
| A page, a component, CSS, an interaction | `web.md` |
| An `/api/v1` route, status, envelope, header | `http.md` |
| A tool, its schema, its description | `mcp.md` |
| The CSV format | `csv.md` |
| Config, Docker, Helm, startup, metrics | `operations.md` |
| Wording on screen or in a message | `common.md` |
| Types, services, queries, React, errors, tests, logging, comments | `code/*.md` |
| A ledger invariant | `AGENTS.md` |

Then find every place that mentions it, because a rule is usually stated once
and cited several times:

```sh
grep -rn "<the thing>" docs/ AGENTS.md
```

## 3. Update what is now false

Rewrite the rule so it describes what the code does now, and keep the argument.
These guides argue from the code — a rule with its reasoning removed is a rule
the next person deletes.

Four specific things to check, all of which went stale in the source session:

- **A stated blocker that no longer blocks.** `web.md` carried two "Still to do"
  notes whose reason — that `Field` gave its control no `id` — had been fixed
  two commits earlier. Whenever you land something another note names as its
  blocker, go and correct that note. Grep the guides for the thing you just
  built.
- **A "not checked" that is now checked.** Move it into the guide's
  "What is checked" section and name the test.
- **The `*Checked by:*` line**, which every rule carries. If a mechanism landed,
  it changes.
- **An example that no longer compiles or no longer matches the source.**

Where the code is right and the guide is right and they still disagree, do not
quietly pick one. `AGENTS.md` wins over any guide, and the guide **records the
disagreement** rather than losing it — `writing.md` §Where this guide and the
repository disagree is the established place and shape.

## 4. Write rules for genuinely new patterns

Only for something that will recur. A rule for a one-off is noise, and this set
is already 11,000 lines.

Match the house shape exactly, because every rule here has it:

- A `###` heading in sentence case.
- A label: `**Binding.**` (a rule that cannot be broken — 63 of them, and WCAG
  or `AGENTS.md` usually says why), `**House.**` (a settled preference — 136),
  or `**Contested.**` (recorded, not resolved — 6).
- The argument, from the code, with `file:line` citations.
- **What the obvious alternative was and why it is wrong.** This is what makes
  the rule survive review.
- A closing `*Checked by:*` naming the test, or saying honestly that it is not
  checked and why.

If the pattern can be mechanically checked, write the test in the same change
and mutation-prove it. A rule with no mechanism is a rule that decays, and the
guide has to say so out loud.

## 5. The changelog

`docs/standards/writing.md` §The changelog owns the shape. Entries go under
`## Unreleased` in `Added` / `Changed` / `Fixed`. Leave the heading undated —
dating it is `cut-release`'s job.

Write for somebody deciding whether to upgrade, in the same voice as the
guides: what was wrong, what it cost them, what it does now. Not what was
edited. An entry naming a file or a function has failed. Internal work earns an
entry when it changes what a maintainer can rely on; a pure refactor does not.

## 6. The upgrade note

If anything touched a surface in `writing.md`'s four-surface table — HTTP, MCP,
CSV, deployment — `docs/upgrades.md` needs it under
`## Before you upgrade to X.Y.Z` for the **next** version.

Write it even when the answer is that nothing changed: a missing heading and an
unwritten note look identical from outside, and `tests/version.test.ts` refuses
a release whose section has not been written.

Say what runs automatically, what an operator does by hand, what changed under
them, and what to check afterwards. Migrations get named with what they do and
whether anything is rewritten.

## 7. AGENTS.md

Only for a genuine invariant — something that makes the books wrong if broken.
`AGENTS.md` is the top of the hierarchy and every guide defers to it. A new
migration is named in the frozen list as *written and unreleased*; check
`tests/migrations.test.ts` passes, since it holds that list to what is on disk.

## 8. Recount and repoint

Every edit above moved line numbers. Run the meta-tests and take the numbers
they report:

```sh
npx vitest run tests/standards-citations.test.ts tests/comment-density.test.ts \
  tests/testing-guide-counts.test.ts tests/mcp-measurements.test.ts
```

`tests/standards-citations.test.ts` names each drifted citation and what sits at
the line it points to. Fix from that output — it is idempotent. Renumbering
mechanically from a diff double-applies the moment the diff grows.

A citation with no filename (`:567`, continuing the previous one) is invisible
to a mechanical pass and has to be checked by eye.

Then:

```sh
npm run format && npm run verify
```

## 9. Report

Name the documents changed and why, any rule newly mechanised, any disagreement
recorded rather than resolved, and anything you found false that you did not fix
— with the reason.
