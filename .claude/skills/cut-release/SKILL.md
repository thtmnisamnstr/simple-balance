---
name: cut-release
description: Cut a release — set the version everywhere, date the changelog, freeze the release's migrations, commit, tag and publish. Use only when explicitly asked to cut, tag or publish a specific version in the current turn. Follows the procedure in docs/upgrades.md.
---

# Cut a release

`docs/upgrades.md` §Cutting a release is the procedure and this skill follows
it. Read that section before starting; if the two ever disagree, the document
wins and this file is wrong.

## Before anything: the go-ahead

**A version is never cut on inference.** Not a bump, not a tag, not a changelog
date, not even locally. The go-ahead must be explicit, name the version or
clearly authorize choosing one, and be given **in the current turn** — an
earlier "we're close to a release" is not it, and neither is a branch that
looks ready.

If a previous instruction said not to cut, that instruction stands until it is
withdrawn in as many words.

Every step below is easy to reverse *until* step 8. Say so when confirming.

## 1. Check the branch is releasable

```sh
git branch --show-current && git status --short
gh pr checks "$(git branch --show-current)" 2>/dev/null || gh run list --limit 3
```

Releases are cut on the default branch. If the work is on a feature branch, that
branch merges first — and merging is its own decision, not part of this skill.

Require: a clean tree, every check green, and `release-prep` already run. If it
has not been, run it first. Cutting on top of an unprepped branch is how a
release ships with a stale count or an unwritten upgrade note.

## 1a. Settle the open dependency pull requests

A release is the wrong moment to discover that every open dependabot pull
request is a security fix. Do this before choosing a number, because what you
find can change what ships.

```sh
gh pr list --state open --json number,title,author -q '.[] | "#\(.number) [\(.author.login)] \(.title)"'
gh api repos/OWNER/REPO/dependabot/alerts --paginate --jq '
  [.[]|select(.state=="open")]
  | map({p:.dependency.package.name, sev:.security_advisory.severity,
         fix:.security_vulnerability.first_patched_version.identifier})
  | group_by(.p+.fix) | map(.[0] + {n: length})
  | .[] | "\(.sev) \(.p) -> fixed \(.fix) (\(.n) alerts)"' | sort -u
```

**Read the alerts, not the labels.** Dependabot labels a version bump
`dependencies` whether or not it closes an advisory, so the labels say nothing
about urgency. Cross the alert list against the open pull requests: on the
release this step was written for, all twenty-seven open alerts — eleven high —
were exactly the packages the pull requests bumped, and none carried a
`security` label. Publishing without them would have shipped known
vulnerabilities.

**A red dependabot pull request is a finding, not a nuisance.** Open the failing
log before dismissing it. Two causes recur here:

- **The mirrored manifests.** `tests/dockerfile.test.ts` requires
  `runtime/package.json` to hold exactly the root's non-browser dependencies and
  both lockfiles to resolve every shared package to the same version. Dependabot
  opens one pull request per directory, so each half is red until the other
  lands. **Do not merge them one at a time** — every intermediate state leaves
  the default branch red. Apply both halves as one change.
- **A pinned digest and its label.** Dependabot rewrites a `FROM` line and
  leaves the `org.opencontainers.image.base.name` label beside it naming the old
  tag, which the same test catches.

**A transitive package moves with `npm update`, not by editing a manifest.**
`qs` and `fast-uri` sit under `express`/`body-parser` and `ajv`, so
`npm update <pkg> --package-lock-only` in each directory is what moves them.

**Judge a base-image bump on its own.** Dependabot offers the newest tag, which
may be a major. Ask whether CI exercises it — the verify matrix pins its own Node
versions — and whether an advisory is actually behind it. The security half is
usually available without the major: query the registry for the current digest
of the tag you are already on.

```sh
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
curl -s -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -D- -o /dev/null "https://registry-1.docker.io/v2/library/node/manifests/24-alpine" |
  grep -i '^docker-content-digest'
```

Then land the lot as **one** change through a pull request so CI judges the
combination, close the superseded ones with the reason, and re-run all three
tiers plus a `docker build` locally. Two things that bit here and will bite
again: taking a manifest from a pull request branch cut before the release
commit silently reverts the version, so run `set-version` again afterward and
let `tests/version.test.ts` confirm; and a dependency bump moves the numbers the
guides quote — zod changed how it emits nullable schemas and a third of the MCP
surface's `anyOf` composition disappeared, so recount before committing.

If a red pull request turns out to be a genuine incompatibility rather than
either of the above, that is a reason to delay the release, not to skip the
update.

## 2. Choose the number

Semantic Versioning 2.0.0, per `docs/standards/writing.md` §Versioning. This
product is not a library, so "breaking" is defined against four surfaces — HTTP
`/api/v1`, MCP, CSV and the deployment — and that section holds the table.

A migration is **never** a breaking change under this scheme: migrations run
forward on their own at startup and every shipped one is frozen. What a
migration can break is the way back, which belongs to the upgrade notes.

Read `## Unreleased` in `CHANGELOG.md` and decide from what is actually there.
State the number and the reasoning before running anything.

Prereleases are allowed (`0.2.0-rc.1`) and are accepted by `set-version`, by
`tests/version.test.ts` and by `tasks/product.prd.schema.json` — all three carry
the same pattern, after a release where two of them disagreed.

A prerelease is still a release: it is cut from the default branch, it freezes
the migrations it ships, and this whole procedure applies.

## 3. Confirm the upgrade note exists

```sh
grep -n "^## Before you upgrade to" docs/upgrades.md | head -3
```

The section for **this** version must already be written — it is written as the
work lands, not here. `tests/version.test.ts` refuses a release without it, and
the publish runs `npm run verify` first, so a missing note stops the release
rather than reaching an operator mid-upgrade.

It is usually written under a **provisional heading**. The suite asks for a note
headed with the next _patch_ of whatever `package.json` says, so while 0.1.6 is
the version, the notes for the coming 0.2.0 sit under
`## Before you upgrade to 0.1.7`, with a paragraph saying the number is
provisional. What this step checks is the content; step 4a gives it its number.

It must say what runs automatically, what an operator does by hand, what changed
under them, and what to check afterward — even when the answer is that nothing
changed.

## 4. Set the version

```sh
npm run set-version X.Y.Z
```

Twenty-two files: three manifests and their three lockfiles, four Dockerfiles'
`ARG APP_VERSION`, the chart's `appVersion` and its own `version`, the constant
the MCP server announces, the product backlog, the release the three product-kit
files in `docs/product/` say they describe, and the pinned image tags in the
split compose file, the `single` profile, the `vps` profile's `compose.app.yml`
and `compose.frontend.yml`, the Pulumi README and the single-machine Pulumi
programs.

Never edit any of these by hand. `tests/version.test.ts` holds every one of them
to `package.json`, asserts the script names each, and runs the script over a
scratch copy to prove it rewrites them, so a hand edit that misses one fails
late and confusingly.

**The product kit is stamped, not rebuilt.** Rewriting its `appVersion` is
honest only because `release-prep` phase 4a rebuilt the kit on the tree being
cut, and a cut changes nothing a screen shows. `set-version` cannot tell whether
4a ran, so check it: compare the capture date with the last change to the
browser app, and if a screen changed after the capture, run the `product-kit`
skill before going on.

```sh
grep -m1 capturedAt docs/product/screenshots.json
git log -1 --format='%cs %h %s' -- src/client
npx vitest run tests/product-kit.test.ts tests/product-facts.test.ts
```

`tests/version.test.ts` waits for step 4a: two of its checks read the upgrade
note's headings, which are still provisional at this point.

## 4a. Give the upgrade note its number, and open the next one

`set-version` does not touch `docs/upgrades.md`, and the moment it has run the
suite asks two things the provisional heading cannot answer: a line reading
exactly `## Before you upgrade to X.Y.Z` with something under it, and one
reading exactly `## Before you upgrade to X.Y.(Z+1)` with something under it.
Both belong in the cut commit:

1. **Rename the provisional heading** — the first `## Before you upgrade to`,
   spelled as the next patch of the previous version (0.1.7 on the way to
   0.2.0) — to this release's number. A prerelease such as `0.2.0-rc.1` takes
   the release's number, 0.2.0: the test strips the suffix, because a
   prerelease upgrades on to the schema of the release it precedes.
2. **Delete the paragraph saying the number is provisional.** It is true now.
3. **Open the next one.** Above it, add `## Before you upgrade to X.Y.(Z+1)` —
   0.2.1 after 0.2.0 — with a one-paragraph body saying nothing has landed for
   it yet, the shape the 0.1.6 cut gave 0.1.7 in `035da59`. An empty note is
   written down because a missing heading and an unwritten one look the same
   from the outside.

When this release is itself the next patch — 0.1.7 after 0.1.6 — the heading
already has the right number, and only steps 2 and 3 apply.

When the previous version was a prerelease of the same release — 0.2.0 after
0.2.0-rc.1, or 0.2.0-rc.2 after 0.2.0-rc.1 — skip all three. The prerelease's own cut
already gave the note this release's number and opened the next patch's, so
renaming "the first heading" here would turn the empty 0.2.1 placeholder into a
second `## Before you upgrade to 0.2.0`, and the test, which finds the first
one, would pass on the empty copy. Check only that whatever landed since the
prerelease is written under this release's heading rather than the next one's.

```sh
npx vitest run tests/version.test.ts
```

## 5. Date the changelog

`## Unreleased` becomes `## X.Y.Z - YYYY-MM-DD`, with today's real date.

Nothing does this for you and nothing checks it — `writing.md` names it as a
hand step in the recipe. The upgrade notes send people here to read it.

## 6. Freeze this release's migrations

In `AGENTS.md`, move this release's migrations from "written and unreleased" to
the frozen list, attributed to this version, and leave behind only migrations
that are still genuinely unreleased.

Once an image has run a migration against somebody's data it can never be edited
again, and that list is what says so. `tests/migrations.test.ts` holds the list
to what is on disk.

## 7. Verify and commit

```sh
npm run verify
```

Subject `Cut X.Y.Z`. The body names what the release touched: the version
locations, the upgrade note given its number and the next one opened, the dated
changelog heading, and the migrations added to the frozen list with a word on
why that matters. Six release commits exist in four forms;
`Cut X.Y.Z` is the current one.

```text
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

```sh
git push
```

Wait for CI green before step 8.

## 8. Publish — the irreversible step

```sh
# The title carries the v. Every release here is named exactly as it is tagged.
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <the changelog section>
```

**The name and the tag are the same string, `v` included.** This line said
`--title "X.Y.Z"` and produced the one release out of seven named differently
from its tag — a thing nothing checks, because the gates read the tag and never
look at the name. Check it before and after:

```sh
gh api repos/OWNER/REPO/releases --jq '.[] | "name=\(.name) tag=\(.tag_name)"'
```

The notes are the changelog section for this version, whole. Previous releases
carry the entire section — v0.1.5 is 33,000 characters — so extract it between
its own heading and the one below it and pass it with `--notes-file` rather than
inline.

Confirm with the user immediately before this. Everything up to here can be
undone with a revert; a published image and a moved `latest` tag cannot.

Publishing keys off the **release**, not the tag push, so it runs once whether
the tag existed beforehand or GitHub creates it. The workflow runs the full
suite first, refuses to publish if the tag and the manifest disagree, then
pushes multi-architecture images to GHCR. `latest` moves unless the release is
marked prerelease or the version carries a suffix.

Mark a prerelease with `--prerelease` so `latest` stays put.

## 9. Watch the publish

```sh
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

If it fails for a reason unrelated to the code, re-run the release workflow by
hand from the Actions tab with the tag. It publishes the same version tag
without a new release, and leaves `latest` alone unless asked — a hand-started
run cannot see whether the release was a prerelease and must not guess.

## 10. Report

The version, the tag, the images published, whether `latest` moved, and the
migrations now frozen. Then open the next cycle: `## Unreleased` returns to
`CHANGELOG.md` when the next work lands. The next `## Before you upgrade to`
heading is already there, from step 4a; what it says is written as that work
lands rather than at the next cut.
