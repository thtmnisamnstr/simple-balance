# Writing

`common.md` owns the sentence: the voice, the nouns, the habit of explaining the
failure rather than the rule. This guide owns the document. What each one is
for, who reads it, where a new one goes, and when an existing one has to change.

Two of the forms below are not documents and are governed here anyway, because
nothing else governs them and both decay without anybody noticing: the commit
message and the code comment. They are the longest two sections here, which is
the right proportion. Every other file here is written once and
read for years. Those two are written every day, and this repository does both
of them unusually, so an unwritten convention is a convention with one holder.

## What each document is for

| Document | Reader | Mode | Changes when |
| --- | --- | --- | --- |
| `README.md` | Somebody deciding whether to run it | Orientation | The product's shape changes, or the commands to run it do |
| `docs/guide.md` | Somebody using it | Tutorial and explanation | A behavior changes, or the decision behind one does |
| `docs/how-to.md` | Somebody using it, mid-task | How-to | A screen changes what it asks for or what it does |
| `docs/architecture.md` | Somebody changing the code | Explanation | A boundary moves, or a guarantee is added or withdrawn |
| `docs/deployment.md` | An operator standing one up | Reference and how-to | A setting is added, renamed, or given a new default |
| `docs/deployment-profiles.md` | An operator choosing a shape before they own a machine | Explanation | A profile is added, or what separates two of them moves |
| `docs/deployment-sizing.md` | An operator deciding how big a machine to buy | Reference | The table in `deploy/pulumi/single-common/index.ts` moves |
| `docs/deployment-costs.md` | An operator deciding whether they can afford it | Reference | A price is re-quoted, which re-dates the whole page |
| `docs/capacity.md` | Somebody asking where one machine stops | Evidence | The harness is re-run, or the claim it supports changes |
| `docs/citus.md` | Somebody deciding whether to distribute the ledger | Explanation and evidence | What distributing costs changes |
| `docs/citus-runbook.md` | An operator running the `ha` database | How-to | A procedure against the cluster changes |
| `docs/monetization.md` | An operator deciding whether to sell anything | Reference | A setting, a plan or a limit changes |
| `docs/billing-operations.md` | An operator with Stripe configured, mid-problem | How-to | Stripe's setup changes, or a failure mode is found |
| `docs/acceptance.md` | Anybody weighing what this release claims | Evidence | Every release, like the upgrade notes |
| `docs/upgrades.md` | An operator mid-upgrade | How-to | Every release, without exception |
| `docs/mcp.md` | Somebody connecting an agent | Reference | A tool is added, renamed or retired |
| `docs/roadmap.md` | The owner, and anybody deciding whether to depend on this | Intent and evidence | An item ships, or the evidence under it moves |
| `docs/product/` | The marketing site at smpl.money, which is a program | Machine contract | A plan, a limit, a price, a capability or a screen changes |
| `CHANGELOG.md` | Somebody upgrading, and somebody who has just been surprised | Record | Every change a person would notice |
| `docs/standards/` | Somebody writing code, copy or a schema | Reference | A rule changes, everywhere at once |
| `AGENTS.md` | An agent, and a contributor | Invariants | An invariant changes, or a migration ships |
| `SECURITY.md` | Somebody who found a hole in it | How-to | The reporting channel changes, or what is in scope does |
| `deploy/compose/README.md`, `deploy/compose/single/README.md`, `deploy/helm/simple-balance/README.md`, `deploy/pulumi/README.md` | An operator running that one recipe | How-to | That recipe changes |
| `scripts/ralph/README.md`, `guardrails.md`, `iteration-prompt.md`, `progress.md` | The build loop and whoever runs it | Reference | The loop changes |
| `scripts/capacity/README.md` | Whoever is re-running the capacity harness | How-to | A command or a file in the harness changes |
| `.claude/skills/*/SKILL.md` | Whoever is starting one of six tasks that repeat | How-to | The order of a procedure changes, or a trap in it is found |
| `CLAUDE.md` | A Claude Code session | One line, `@AGENTS.md` | Never, by design |

**House. A new document names a reader and a mode before it is created.** If it
cannot name both, it is a section of a document that already exists. The reason
a reader can find the right document is that none of them overlap.

The other half of that rule used to be "the corpus is small enough to list on
one screen", and it was doing more work than it looked like: the table was short
enough to scan, so nobody could extend the tree without noticing it. The corpus
is no longer that size. 0.2.0 added nine documents to `docs/`, a fourth
deployment recipe, a harness README and the product kit, and the table noticed
none of them — it sat unchanged through all of it while claiming to be the whole
corpus. A table that claims completeness and is not complete is worse than one
that claims less, because the document it leaves out reads as one nobody has to
keep true.

So, decided here rather than left implied: **the table stays exhaustive and
stops being held by anybody's memory.** `tests/writing-guide.test.ts` walks the
tree and fails on a document no row names, and on a row naming a document that
has gone. The obvious alternative was to stop claiming completeness — to call it
a map of the important ones — and it is wrong for the reason the gap itself
demonstrated: an unlisted document has no reader and no mode written down
anywhere, which is exactly the state this rule exists to stop a document being
created in.

**House, and the reason the skills are not a sixteenth guide.** This set is
fifteen guides and two indexes; the sentence here said "a tenth guide" while the
set stood at fifteen, which is the same failure as the table above and the
reason both now answer to a test. Six procedures repeat — bringing the documents
back to true after work lands, sweeping the product against the guides,
reviewing the browser app, rebuilding the product kit the marketing site reads,
preparing a release, and cutting one — and each was being rediscovered, in the
wrong order, every time.
They are `.claude/skills/`, and the rule that keeps them from becoming a second
copy of this set is that **a skill cites a guide and never restates it.** A rule
written down twice drifts, which is the defect the whole set exists to prevent;
so a skill says "read `web.md` section 9" where it is tempted to summarize
section 9. What a skill is allowed to hold is what a guide has no place for: the
order the steps go in, and the traps. `release-prep` says twice that the recount
is last, because doing it early cost four passes in one session.

One mechanical hazard, learned by tripping over it. A `SKILL.md` is expanded
when it loads, so a bare dollar-sign followed by a name or a digit is replaced
before a reader sees it: `design-review` quoted a defect report saying a figure
"always show[ed] $0" and the loaded skill said it showed the skill's own name.
Command substitution and brace-wrapped forms survive; the bare form does not.
Write the word instead.

*Checked by:* `tests/skills.test.ts` for the four things about a skill a test
can decide — that the set on disk and the set `AGENTS.md` promises are the same
six, both ways round; that each carries frontmatter naming its own directory
and describing itself; that none contains a bare dollar-variable the loader
would swallow; and that each cites at least one of the documents it defers to,
since a skill that mentions no guide is either covering ground the guides do not
or quietly becoming a copy of one.

That test asserts six and attributes the number to this guide — its message
reads "six procedures, per writing.md" — while this guide said five, in two
places, for a release. A citation only one side reads proves nothing, so
`tests/writing-guide.test.ts` now holds the sentences here to the directory from
the other end.

*Not checked mechanically:* whether a document has a reader, and whether a
skill's order is the right order. Both are review.

### The product kit is a document with a machine for a reader

**House.** `docs/product/` is three JSON files and twenty-eight screenshots, and
until this pass no row in the table above and no sentence anywhere in this guide
described it. That is not an oversight about one directory. Every row in that
table names a *person* and the mode they read in, and the kit's reader is the
marketing site at smpl.money — a program, in a separate repository, that cannot
run this application. A table with no row whose reader is a machine does not
grow one by accident.

Three things about it invert what the rest of this guide assumes, which is why
it needs a rule and not just a row:

- **Its screenshots are retaken when a screen changes colour.** §House, pictures
  says the opposite and is right about `docs/images/dashboard.png`. The kit
  ships every screen in both themes, so a token change that moves no layout at
  all invalidates half of them.
- **Its reader cannot check it.** `docs/guide.md` describing a button that is
  not there is caught by the next person who follows it. The site quoting a plan
  label this application stopped using is caught by a stranger, because the site
  has no way to run the thing it is describing. That is not hypothetical:
  `tests/product-facts.test.ts` exists because this application displayed "Plus"
  while the site said "Premium", and its docblock records it as the reason.
- **The release is pinned in all three of its files**, which is why
  `tests/version.test.ts` sweeps the kit along with everything else the version
  is written in, and why `AGENTS.md` carries the standing obligation that a
  change to a plan, a limit, a label or a price is a change to `facts.json` in
  the same commit.

The obvious alternative is to treat the kit as build output and leave it outside
a guide about documents — it is generated, after all. That is what was done, and
it is wrong twice over. `facts.json` is deliberately **compared** rather than
regenerated by its test, "because a check that rewrites the thing it is checking
is not a check", so a stale file has to fail rather than be quietly repaired by
the suite. And `features.json`'s tiering is a judgement about how much a
stranger would care, which no generator can make. Half of the kit is written, so
all of it answers here.

*Checked by:* `tests/product-kit.test.ts` on the kit's shape, its internal
agreement and whether it points at pictures that exist;
`tests/product-facts.test.ts` on its `derived` half against
`src/shared/domain.ts` and `src/shared/version.ts`; and
`tests/version.test.ts:331` on the release all three files name.
`tests/writing-guide.test.ts` holds the screenshot count here to the directory.
*Not checked:* whether a screenshot still shows the screen it is named for,
which is the `product-kit` skill's job and a person's eye.

### Diátaxis, answered

**House.** Diátaxis is used here as a diagnostic and not as a site plan. Its
foundations page claims completeness, that there are only two dimensions and
"no other territory to cover"; its own how-to page is the honest one, calling
itself "a guide, a map to help you check that you're in the right place", and
warning against empty template sections. Only the second is actionable at this
size.

So: test a page against the four modes when it feels wrong to read, and fix the
page. Do not reorganize `docs/` into four directories. The existing documents
land in the quadrants without having been designed to, which is the evidence
that the shape is real rather than imposed.

Two departures were recorded here, named so nobody tidied them. One is still
live and the other has been reversed, and both stay:

- **`docs/deployment.md` mixed all three modes in one file and stayed that way.
  Superseded in 0.2.0, by the split described below.** Kept rather than deleted,
  per §Recording a decision: a deleted decision is rediscovered and remade. The
  argument was that an operator reads the page once and greps it afterwards, so
  splitting a working reference to satisfy a model would cost the grep and buy
  nothing. It was right about the grep and wrong about what it was defending.
  The file was 761 lines when that was written; it is 1,137 now, and the
  deployment reference is seven documents running to nearly four thousand lines
  — `deployment.md`, `deployment-profiles.md`, `deployment-sizing.md`,
  `deployment-costs.md`, `capacity.md`, `citus.md` and `citus-runbook.md`.

  What reversed it was not Diátaxis. Each of the six new files has a reader the
  one file did not: somebody choosing a shape before they own a machine,
  somebody deciding what size to buy, somebody deciding whether they can afford
  it, somebody running a Citus cluster, somebody asking where one machine stops.
  Those are different people at different moments, and the rule above — a new
  document names a reader and a mode — had already decided it. The grep was kept
  by cross-linking rather than by merging. Nothing holds the links between the
  `docs/` pages; `tests/deploy-readme-links.test.ts` holds the ones under
  `deploy/`, after two in `deploy/compose/single/README.md` turned out never to
  have worked.
- **`docs/roadmap.md` and `AGENTS.md` are outside the model.** Neither is user
  documentation. One is intent, one is constitution.

*Not checked mechanically.* This is review, and it is review of a judgement.

## The changelog

**House.** Keep a Changelog is a convention rather than a specification, so
nothing here is Binding. The one principle worth quoting is its first:
"Changelogs are for humans, not machines." This file takes that further than the
convention expects.

- **Prose, not bullets.** The paragraphs are why the file can be read. An entry
  runs at the length and in the voice of a commit body: what changed, what it
  fixes, and what it costs. This rule used to be quotable as "zero list items in
  3,508 lines", and that sentence is what made it stick; it is no longer true,
  and how it stopped being true is worth keeping. There are five list items in
  the file, all five in the 0.2.0 entry: the five decisions that make
  a hook deleting database cluster state safe, each with its own
  counter-argument, which run together into mush as a paragraph. That is the one
  shape a list earns — a set of parallel decisions a reader has to take one at a
  time — and it is not a licence for a bulleted summary of a release, which is
  what this rule exists to refuse. `tests/writing-guide.test.ts` holds the file
  to that ceiling, so a sixth is a decision somebody makes rather than a habit
  nobody notices forming.
- **Newest first, under `## Unreleased`, then `## X.Y.Z - YYYY-MM-DD`.** The
  date is ISO 8601 and is the day the release is cut. GitHub anchors those
  headings automatically, which is the whole of the linkability requirement; no
  explicit link definitions are needed and none exist.
- **Section headings borrow Keep a Changelog's vocabulary**: Added, Changed,
  Deprecated, Removed, Fixed, Security. This file also uses `Internal`, for a
  change with no user-visible effect that an operator or a contributor would
  still want to find. Across the dated sections: six Added, six Changed, seven
  Fixed, one Security, one Internal. Counting `## Unreleased` as well gives
  seven Changed and eight Fixed. The 0.1.0 entry predates the convention and uses its own
  headings; leave it.
- **A change a person would notice gets an entry.** "Notice" means one of four
  things: behavior on a screen, a value on the wire in any of the three
  contracts, something an operator configures, or something that changes at
  startup. A refactor with none of those is not an entry. This is the rule that
  decides, and it decides at commit time, not at release time.
- **An entry says why, not only what.** The entry that reads well a year later
  is the one carrying the reason, including the limits: "ten categorical colors
  cannot all be told apart by somebody with dichromatic vision" is the model.
- **State the limit rather than omitting it.** A fix that is partial says which
  part.

*Checked by:* `tests/writing-guide.test.ts`, on the two rules above a file can
answer: that the list items stay at the five that earned their shape, and that
the lines running past 80 columns do not grow past where they already are.
*Not checked:* that the top heading matches `package.json`. That is a hand step
in the release recipe at `docs/upgrades.md:1568`, step 4, "Date the
`## Unreleased` heading in `CHANGELOG.md`", and it has already been the subject
of a commit ("Date 0.1.4 the day it is cut"). Nor is whether an entry describes
a change somebody would notice, which is the judgement this section is mostly
about.

## Versioning

**House, and this guide owns the question for the whole set.** The scheme is
Semantic Versioning 2.0.0. Nothing in the repository stated a versioning policy
before this set. [`operations.md`](operations.md#what-the-version-number-is-about)
cites this section and adds the one consequence that belongs to an operator,
which is that renaming a configuration variable is a breaking release.

The shape of a version is written in three places and two of them used to
disagree. `scripts/set-version.mjs:28` and `tests/version.test.ts:146` accept a
prerelease suffix; `tasks/product.prd.schema.json:10` pinned three numeric parts
and nothing else, so `npm run set-version 0.2.0-rc.1` succeeded, the suite
stayed green, and the build loop then refused to start on an error two steps
from its cause. The schema now carries the same pattern as the other two.

This product is not a library, so "breaking" has to be defined against the four
things somebody can depend on:

| Surface | A breaking change is |
| --- | --- |
| HTTP `/api/v1` | A field removed or renamed, an accepted input narrowed, a status or error code changed for an unchanged request, a default changed. [`http.md`](http.md#what-counts-as-a-breaking-change) holds the full list and the deprecation policy this obliges. |
| MCP | A tool removed or renamed, a required argument added, a scope widened for an existing tool, an output field removed. |
| CSV | A recognized column removed from `APP_CSV_COLUMNS`, or an existing column's meaning changed. Adding a column is not breaking and column order is not part of the contract; [`csv.md`](csv.md#6-the-columns) says why. |
| The deployment | A configuration variable renamed, removed, or made required; a refusal to start on a configuration the previous version accepted; a new external dependency; a raised floor on PostgreSQL or Node. |

**A surface's own version and the release version answer different questions**,
which is why two of the four carry a version of their own. `/api/v1` and
`simple-balance-csv-1` say *which* contract a caller is holding, so a client can
detect the break; the release version says *when* it happened, so an operator can
avoid it. A break in a wire contract moves both. Nothing here means a wire
contract versions instead of the release, and the MCP surface, which carries no
version at all, has only the release number to say so.

The schema is not on that list, and deliberately. A migration is never a
breaking change under this scheme, because migrations run forward on their own
at startup and every shipped one is frozen. What a migration can break is the
way back, and that belongs to the upgrade notes rather than to the version
number.

**Binding: a release upgrades cleanly from the one before it.** Not "breaks
only where it is documented" — does not break. A deployment running the previous
release starts on this one, with the configuration it already has, and every
client that worked against it still works.

That is stricter than this guide used to be, and stricter than Semantic
Versioning asks for a zero major. It is the rule because the alternative was
tried: three changes in 0.1.4 each refused a configuration the release
before it accepted, each was documented in advance with the fix beside it, and
each was still a person's ledger failing to start over a setting that had been
fine yesterday. A documented break is a break somebody reads about *after* the
container will not come up.

What that rules out, and what it leaves:

- A setting that was accepted must stay accepted. If it was wrong, **warn and
  carry on** — `config-limits.ts` does exactly this for six bounded integers
  that used to fall back in silence. The silence was the defect; the fallback
  never was.
- A precedence that existed must be kept. When `NAME` and `NAME_FILE` are both
  set, `NAME` wins, because that is what happened when `NAME_FILE` did nothing.
  The warning is new; the outcome is not.
- A path that answered must keep answering. A renamed route stays registered
  under its old spelling with `Deprecation` and `Sunset` headers, and goes in a
  later release rather than this one.
- A capability a client had must not narrow. Advertising a smaller scope in the
  RFC 9728 document would be least privilege and would also take write access
  away from anybody who re-authorizes without step-up support, so it waits.

None of these is permanent. A break becomes fine once it has been announced for
a release and the thing being removed has been deprecated in the field — which
is what `Sunset` dates and `docs/upgrades.md` are for. What is not fine is
arriving with it.

**0.2.1 is an approved exception, and it is named here so that it does not
become a precedent by accident.** It ships four narrowings in a patch release,
none deprecated first: a save that changes nothing no longer bumps `version`; a
second account whose name differs from another only in case or spacing is
refused; a recurring transfer naming one account on both sides is refused; and
the auth routes' JSON no longer carries the session token. Each closes
something the product should never have allowed, and none touches what a ledger
already holds. The owner approved them as an exception to the rule above rather
than a change to it, so the rule stands for every release after this one: a
narrowing that is not named here as approved is a break.
`docs/upgrades.md` §Before you upgrade to 0.2.1 tells a client what to do about
each.

**What would make it 1.0.0 is not decided.** Recorded as an open question rather
than answered with something invented here.

*Checked by:* `tests/version.test.ts`, which holds every place the version is
written to `package.json`, asserts that `scripts/set-version.mjs` knows about
each one, and refuses a version whose `## Before you upgrade to X.Y.Z` section
has not been written.

**How many places there are is deliberately not written down**, and this guide
wrote it down anyway. The sentence said fifteen. The test's own docblock, at
`tests/version.test.ts:139-141`, says the count is left out because "it has
already been wrong once, when three Dockerfiles were added and the prose still
said seven, and a number in a comment is not something anything checks". There
were twenty-four by the time anybody counted. The docblock was right and this
guide quoted straight past it. Anybody who wants the number can read it off
`versionsWrittenIn` at `tests/version.test.ts:94`, and the argument for not
freezing it in prose is in that function: it discovers the locations rather than
listing them, so a new one is covered the day it appears and no sentence
anywhere has to be edited. See §A measured number carries a test or a date.

The upgrade-note check exists because the release recipe used to end without it,
so this guide specified a document the procedure never asked anybody to write,
and 0.1.0 through 0.1.3 shipped eight migrations between them with no note. The
publish runs `npm run verify` first, so an unwritten note now stops the release
rather than reaching an operator mid-upgrade. *Also checked:* the frozen
migration list, which `tests/migrations.test.ts` holds to what is on disk.
*Not checked:* the changelog heading, a hand step in the release recipe at
`docs/upgrades.md:1568`, and which release a migration is attributed to, which
is prose inside a list a test can only check the membership of.

## Upgrade notes

**Binding, quoting `AGENTS.md:338-390`, the frozen migration list:** "Every
migration that has shipped is frozen" and "Never edit or regenerate one:
someone's database has already run it, and changing it would leave their schema
and its recorded history disagreeing." What follows is the documentation the
operator is owed for that. The range used to read lines 289 to 326, which stopped
eleven lines short of the second of those two sentences and fifteen short of the
end of the bullet — it grew, and the number did not.

**House, the shape.** A `## Before you upgrade to X.Y.Z` section, and its first
sentence tells an operator whether they can stop reading. The 0.1.6 note at
`docs/upgrades.md:1227-1228` is the model: "Nothing refuses to start that 0.1.5
accepted, and nothing about an existing configuration has to change. Five
things are worth knowing." The 0.1.4 section is the other model, because the
answer there was different: "0.1.4 refuses to start on three configurations
0.1.3 accepted", followed by a table of what to do about each.

Then four parts, in this order:

1. **What runs automatically.** Every migration in the release, named, with what
   it does to existing rows and whether it rewrites a table. A constant default
   is metadata-only and says so; an index build that takes a moment before
   readiness opens says that too.
2. **What the operator must do by hand.** Nothing, where nothing is the answer.
3. **What changed under them.** A silently clamped limit, an invalidated token,
   a default that moved.
4. **What to check afterwards.** The readiness endpoint, and anything the first
   start repairs and logs.

**House. A claim in an upgrade note is a claim, so it is worth a test.** Nothing
in a specification or in `AGENTS.md` asks for one; a past failure does. The best
example in the repository: the 0.1.5 note promises the theme column is a
constant default and therefore rewrites no table, and the test at
`tests/migrations.test.ts:413` is called "adds the theme without rewriting a
row". Nine assertions of that kind sit in that file now, plus three on the one
migration that decides at runtime whether to run at all, and between them they
cover 0005 through 0011 and 0022 through 0025, every migration an upgrade note
has made a promise about. A note that
makes a promise about somebody's data and has no test behind it has been wrong
before: the 0.1.5 contrast note quoted a number that was not the old value, and
the change it described as an improvement was a small regression.

*Checked by:* `tests/migrations.test.ts`, three ways. Per-migration behavior
assertions cover 0005 through 0011 and 0022 through 0025. The frozen ordering
list at `:39-45` names the first five explicitly and holds the rest by number,
file and snapshot rather than by name, so 0012 has no assertion of its own. And
the same file reads `AGENTS.md` and fails when a file in `drizzle/` is not named
there, which it does because the list had already fallen behind: `AGENTS.md`
stopped at `0012` while `drizzle/` held `0013`, and nothing in `tests/` read
`AGENTS.md` at all.

*Also checked, and this section used to say otherwise:* that a release has an
upgrade note. The line here read "*Not checked:* that a release containing a
migration has an upgrade note", and the mechanism had been in place for two
releases and goes further than the sentence asked for.
`tests/version.test.ts:375`, "is the version the upgrade notes tell an operator
about", refuses a version whose `## Before you upgrade to X.Y.Z` heading is
missing — every release, migration or not. `tests/version.test.ts:355`, "already
has the note for the release after this one", requires the *next* release's
heading to exist as well, so the slot an entry goes into is open before the work
that fills it lands. That is what turns the habit this section describes — write
the note as the work lands, not from memory at the freeze — into something a
suite enforces. *Not checked:* which release a migration is attributed to, which
is prose inside a list a test can only check the membership of.

## The roadmap

**House.** `docs/roadmap.md` has a structure that is unusual enough to be worth
protecting, because its value is entirely in the parts a normal roadmap leaves
out.

- **Every item carries its evidence, and the evidence is sourced.** Prices are
  quoted against vendor pricing pages. Competitor claims are verified at the
  protocol level rather than from marketing, and the document says which:
  "verified at the protocol level, not from its marketing".
- **The document says once, up front, what the research failed to establish.**
  `docs/roadmap.md:24-29` names seven products the passes did not cover, plus
  one question they could not answer, and then does the harder thing:
  "Only two data points survived on that, so the manual-entry comparison in this
  document rests on less than it should." A roadmap that only lists what it
  knows is a roadmap nobody can weigh.
- **The heading carries the story id and its title, and adds `**done**` once the
  item is built**; the line under it carries the mechanics, including whether it
  has shipped. `docs/roadmap.md:67-69` reads SB-017, "Split transactions",
  **done**, then "Priority 160. Depends on SB-015. Shipped as migration 0005."
  Nine of the fifteen headings carry the state today: SB-016, SB-017 and
  SB-018, whose lines name the migration or the release that carried them, and
  SB-019 and SB-025 through SB-029, whose lines say "Built, unreleased". This
  paragraph said "once the item has shipped" for a while, and the practice never
  did: SB-018 was marked in the commit that built it, a week before the release
  that carried it. The heading answers "is there anything left to write", and the
  line under it answers "can anybody use it", which are different questions and
  are worth keeping apart. The second question is the one that goes stale
  without anybody noticing, and it has: the six lines still reading "Built,
  unreleased" include items 0.1.6 carried.
- **Acceptance criteria before it is built, "How it was met" after.** The second
  is where the decision record lives, along with the list introduced at
  `docs/roadmap.md:114`: "Two decisions worth writing down rather than leaving
  implied". It appears under all nine done items, and the convention held
  only after SB-016 was given one: it had shipped with a paragraph headed
  "Shipped as" sitting above its acceptance criteria, which is a second name for
  the section in the wrong place rather than a second convention.
  `tests/docs-conventions.test.ts` now requires the heading of every item marked
  **done**, because that is presence rather than judgement and presence is the
  half that fell behind.
- **A "Deliberately not planned" section with the counter-argument in it.** The
  auto-categorization entry states the case against its own decision and names
  the condition under which to revisit it. That is what makes the section
  useful rather than defensive.
- **Nothing is committed to here.** `tasks/product.prd.json` records the product
  as built; the roadmap records intent, and says so in its opening paragraph.

*Not checked mechanically.* `tests/version.test.ts:321-323` checks that the
backlog's version matches the manifest, which is the only mechanical link
between intent and release.

## Recording a decision

**Contested.** Whether Architecture Decision Records pay for themselves on a
single-maintainer project is argued in both directions in published guidance and
settled by evidence in neither. This product's pick: **no ADR directory.**

The reasoning, which is what the next person should argue with:

- The substance already exists in three places without the form. `AGENTS.md`
  holds decisions with consequences and no context. `docs/roadmap.md`'s "How it
  was met" sections hold context and consequences and no status.
  `docs/architecture.md` carries the reasoning at length. A fourth place would
  be a fourth copy.
- The commit body is the working decision record, and it is better than a
  template would be, because it is written while the reasoning is still in
  somebody's head and it is attached to the diff it explains.
- **The failure mode a one-maintainer project actually hits is not "why did we
  do this", it is "is this still true".** None of the three places records
  status. That is the gap worth closing, and it is closed with two rules rather
  than a directory.

So, taking Nygard's Status field and immutability rule without the ceremony:

- **House. A recorded decision names the release it was made in.** The exemplar
  is `AGENTS.md:338-390`, the frozen migration list, which names every migration
  and the release it shipped in, and is the most reliable section in the file
  for exactly that reason.
- **House. A reversal edits the old text to say it is superseded, and says by
  what.** It does not delete it. A deleted decision is rediscovered and remade.

*Not checked mechanically.* Whether a recorded decision is still current is
review by construction. It is the one item on the review list that no test could
ever replace.

## The README

**House.** Its job is to let somebody decide in about thirty seconds whether to
run this, and then to let them run it. It is not the manual. That job left the
README on purpose, in a commit titled "Put the walkthrough in a guide and give
the README its job back", and the walkthrough lives today in `docs/how-to.md`,
with `docs/guide.md` keeping the explanations.

- **Plain language before any feature list.** Four lines saying what it is and
  who it is for, then the bullets. The commit that set this was "Open the README
  with what it is, not with everything it does".
- **A feature bullet leads with a bolded outcome, not a component name.**
  "**Statements that file themselves.**", not "CSV importer". The commit that
  set this was "Sell what somebody gets, not how it is built".
- **One screenshot, with alt text that says what the picture shows** rather than
  naming the page. `README.md:38` carries 185 characters of it, naming every
  figure on the page and the fact that currencies are reported separately.
- **A section per question somebody actually asks**, in this order: what it is,
  everything else it does, run it locally, run the tests, host it, connect an
  agent, security, contributing, not built yet, more, built with, license. That
  list left `## Contributing` out for a release while the paragraph three below
  it said where the section sits, which is the shape of error an ordered list
  invites: it reads as complete and nobody counts it against the file.
- **The license is stated in the README, not only in `LICENSE`.** For an AGPL
  project the license is a term of use. `README.md:288-298` names it, links it,
  and explains what section 13 adds, including for versions published under the
  older license.
- **No badge wall.** There are none today.
- **A Security section, and a `SECURITY.md` behind it.** It ships an OAuth
  authorization server with dynamic client registration and a public MCP
  endpoint, so where to report a hole is a question somebody asks before they
  run it. The section is short and links the file; the file holds which versions
  get a fix, what is in scope, and what the server already guarantees, each
  linked to the document that argues it rather than restated.

**Settled, within what a guide can settle.** The README now carries a
`## Contributing` section between Security and Not built yet. It does not
promise that a pull request will be taken — that is the owner's call and no
guide can make it — and it says so in its first sentence rather than implying
an answer by silence.

What it does carry is the half that is not a policy question: which documents
hold the rules, that `npm run verify` has to pass, that a change needs a test,
which suites need a database, and that releases are not a contributor's to cut.
Somebody who reads it knows what a serious change looks like before they spend
an evening on one.

The `More` list no longer labels `AGENTS.md` "Contributing", because that file
answers a different question and the label now says what it is.

*Checked by:* `tests/docs-conventions.test.ts`, on the presence of the Security
section, the link behind it, and the `More` list no longer calling `AGENTS.md`
Contributing. *Not checked:* everything else, including the run command it hands
people, which is the thing most likely to be copied and most likely to go stale,
and is not compared against anything.

## Commit messages

**House, and the convention with the most riding on it**, because there is no
tooling, no `.gitmessage`, no hook, and no commitlint, so the only thing keeping
387 commits consistent is that somebody knows the shape.

Every figure in this section was counted over the commits reachable from `HEAD`
on **2026-10-01**, when there were 387 of them. They carry a date rather than a
test, and §A measured number carries a test or a date says why: the history
grows under every commit, so a check on these numbers is a check the commit
under test has to update, and a check somebody has to update is a check nobody
reads.

*Not checked mechanically.* A subject-length and prefix check would catch the
shape and not the substance, and the substance is the whole point of this
convention. Review.

### What it is not

Not Conventional Commits, and not close. Across 387 subjects: zero carry a
`feat:` / `fix:` / `chore:` prefix, zero carry a scope, zero end in a full stop,
and eight carry a pull request number. Five merge commits exist. Those last two
counts used to read "all of them on dependabot branches" and "all dependabot",
and both are now false by exactly one, because a feature branch was hand-merged
during 0.2.0: `Merge pull request #46 from thtmnisamnstr/frozen-accounts` is
the single commit that breaks both claims, and it is the same commit twice.
Three subjects begin lowercase, and all three predate the convention.

### The subject

**House.** An imperative sentence naming what is now true, from the reader's side. Not
what was edited. Not where. Median 55 characters, and 277 of 387 fall between 45
and 70; treat 70 as the ceiling and let a subject be short when it can be.

The recurring verbs, which are worth knowing because they are the shape of the
thought: Say, Let, Make, Stop, Give, Fix, Close, Write, Put, Bring, Record,
Publish, Prove, Keep, Take out, Refuse. The order has turned over since it was
first counted, and the leading verb is not the one this paragraph used to name:
Let led with nineteen then and Say leads with thirty-three now, ahead of Let at
twenty-seven, Make at twenty-five and Stop at twenty-two. Worth noticing rather
than correcting — the verb that leads is the verb the work is doing, and a
release spent saying what a deployment costs, what a profile builds and what the
whole thing claims is a release that says things.

There is a second form, the contrastive, which states the alternative that was
rejected inside the subject:

```text
Stop every save reading the ledger to spell a payee
Let the keyboard work the choices these forms offer
Refuse a delete that leaves a schedule or a template pointing at nothing
Fail the pull request the chart breaks on, not the install
Sell what somebody gets, not how it is built
Make four tests capable of failing
Take out what nothing reaches
```

**The test for a subject: could somebody who has not seen the diff tell whether
it affects them?** "Fix bug in payees" fails it. "Find the copy of a purchase
the bank spelled differently" passes it. A subject naming a file, a function or
a layer has almost always failed it, because those are answers to "where" and
the subject's question is "what changed for somebody".

Two habits that follow from that. Say the domain thing rather than the technical
thing where both would do: "spell a payee", not "normalize the payee string".
And where a commit really does several things, join them with a comma rather
than inventing a category: "Stop a staging token making ledger changes, and a
JWT carrying a credential".

### The body

**House.** Multi-paragraph prose, hard-wrapped in the low-to-mid 70s, in the same voice
as the documents. 73 of 8,749 non-blank body lines exceed 80 columns, and three
of the 387 commits have no body at all — a commit with no body is a commit
claiming there was nothing to explain. This one has held: it was 41 of 5,389
when it was first measured, which is the same share, so the convention survived
the history doubling. That is worth saying beside the em-dash bullet in §Where
this guide and the repository disagree, where the same arithmetic went the other
way. The difference is not enforcement — neither is enforced — it is that this
one is about the shape of a paragraph somebody is writing and that one is about
a character they are not thinking about.

A body owes five things a conventional body does not, and this is where the
repository's decision record actually lives:

1. **Why the bug survived review.** "React enforces one-of-many through
   `checked` regardless, which is exactly why this survived: it looks right, it
   clicks right, and only the keyboard is wrong."
2. **Numbers, before and after, where the claim is a performance claim.** "on
   five thousand transactions, 6.3ms and 205 buffers become 0.02ms and 3." No
   performance claim without one, because nothing else measures them: there is
   no benchmark in this repository and no performance budget.
3. **What was checked, and how.** Especially where the check was manual, which
   here it often has to be: "Verified in a browser, because jsdom has neither
   `matchMedia` nor `localStorage`". That sentence is the only record that the
   step happened.
4. **Findings that were rejected, and why.** "Forty-one findings across
   correctness, efficiency, MCP coverage, documentation and dead code;
   twenty-four did not survive being argued against, and these are the rest",
   and later, a paragraph headed "Two claims in the audit did not survive my own
   checking and are deliberately not acted on". A rejected finding that is not
   written down gets re-found.
5. **Corrections to the previous commit's message.** "And the previous commit's
   message claimed a `mergePayees` fix that was not in it. It is in this one."
   The history is append-only, so a correction is an entry rather than an edit.

**Trailer.** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, in that
casing. 352 commits carry a trailer, 350 of those lines in that casing, across
four model names. Five use the lowercase `Co-authored-by`: three hand-written
commits, which is drift, and two that GitHub wrote on a squash or a merge, in
the casing git itself uses, and those are left alone for the same reason
dependabot subjects are.

**Release commits.** `Cut X.Y.Z`, with a body naming what the release touched:
the version locations, the dated changelog heading, and the migrations added to
the frozen list. Seven release commits exist in four forms: "Release Simple
Balance 0.1.0", "Release 0.1.0" and its two successors, "Cut 0.1.5" and
"Cut 0.1.6", and 0.1.1 folded into a feature subject. `Cut X.Y.Z` is the one to
keep, and it is no longer the single data point it was when this guide picked
it: it is what the last two cuts used, and what `cut-release` names.

**Dependabot subjects are left alone.** They are the one place a machine writes
the subject, and rewriting them would lose the correspondence with the PR.

*Not checked mechanically, and the decision was made with the measurement in
hand rather than from the armchair.* There is no commit-message tooling of any
kind, and adding a hook would be new infrastructure. A subject-length and prefix
check in CI would be cheap; here is what it would do, measured over the 384
non-merge subjects reachable on 2026-10-01, two commits later than the 387 this
section's other figures were counted over.

**The half a program can decide has never been broken by anybody, with nothing
watching.** Zero subjects carry a `feat:` / `fix:` / `chore:` prefix or any
other conventional one, and zero end in a full stop. A gate on either would have
nothing to catch and would go green forever, which is a check that teaches
nobody anything.

**The half that is broken cannot be gated without becoming a different rule.**
Twenty-five subjects exceed the 70-character ceiling, the longest at 79. A CI
step at 70 fails on history, so it would have to be a rule about *new* commits
only — and "treat 70 as the ceiling and let a subject be short when it can be"
is not that rule. Writing it as a check would be deciding it rather than
recording it, which is what `index.md` says this guide does not do.

So it stays review, on the argument the section already makes: a length check
catches the shape and not the substance, and "could somebody who has not seen
the diff tell whether it affects them" is not a shape.

## Code comments

**House, and the most-praised convention in the codebase.** It survives because
whoever writes here keeps doing it, which is exactly the kind of thing that
stops happening without anybody deciding to stop, so it is written down.

**A comment records the specific failure the line prevents, in the past tense.**
`common.md` states the principle for prose generally; this is the form it takes
in code, and it is stricter. A comment answers one of four questions and nothing
else:

- Why this and not the obvious alternative.
- What went wrong when it was done the obvious way.
- What would break if this line were removed.
- What a future reader is about to be tempted to do, and must not.

**There is no comment that explains a mechanism.** No `// increment the
version`. If the code says what it does, the comment says why it is allowed to.

The one-liner form, at `src/client/money.ts:37`:

```ts
// Rounding a tiny negative amount to zero must not render as "-$0.00".
```

The docblock form: one line saying what the thing is, a blank line, then two or
three short paragraphs each making one point. Four worked examples that between
them cover the whole range:

- **The counterfactual as something that actually happened, with a
  measurement.** `src/client/money.ts:42-54`: "`Intl.NumberFormat` is expensive
  to construct ... a two-hundred-row report with three money columns is
  twenty-four hundred constructions in one render, which measured at 17ms".
  Note the last line, which states the bound: "Unbounded on purpose: the keys
  are locale-and-currency pairs and a ledger holds a handful of currencies, so
  there is nothing here to grow."
- **The trade named, not only the choice.** `src/client/components.tsx:882-906`:
  a fixed popover, why absolute fails in a scrolling table card, what fixed
  costs, and then the harder half: "Deliberately not `role="menu"` ... menu
  roles without the keyboard behavior they imply are worse than none."
- **The invariant with the consequence of breaking it.**
  `src/shared/domain.ts:2462-2464`: "`.strict()` is the load-bearing part: a
  filter this cannot honor is an error rather than a key quietly dropped,
  because a selection resolves twice and an ignored filter makes the count and
  the fingerprint agree about the wrong set."
- **The rule stated where somebody will try to break it.**
  `src/client/styles.css:73-92`: why every color is a token, which test fails
  if one is not, and why the two dark blocks cannot be merged.

Three further rules:

- **Density tracks how surprising the code is, not how important.** Over files
  of forty lines or more it runs from 96 per cent in `src/client/zod-jitless.ts`
  — one Zod flag, and six paragraphs on why a content security policy with no
  `'unsafe-eval'` makes the flag necessary — down to **zero** in
  `src/client/select-options.ts`, which is a hundred lines of currency codes and
  timezone names. Both are correct. A function that follows a pattern documented
  once elsewhere earns no comment.

  The floor in this bullet used to read "under 1 per cent in
  `src/client/router.tsx`", and that file measures 19 per cent: wrong by a
  factor of twenty, in the one sentence this guide offers as the picture of a
  legitimately uncommented file. Somebody calibrating against it would read a
  normally commented module as the bottom of the range and write accordingly.
  `tests/writing-guide.test.ts` now recomputes both ends and fails if the files
  named here are not the files at them.
- **No markers, no attributions, no furniture.** Zero `TODO`, `FIXME`, `XXX` and
  `HACK` exist in `src/`. A thing worth doing later is a roadmap item or a
  changelog line, both of which somebody reads. No author names, no
  section-heading banners, no decorative separators.
- **A comment that has stopped being true is a defect, not untidiness.** Two
  have shipped and both were found by audit rather than by a test: a comment
  claiming a cache could spot another account's entry, describing a mechanism
  that did not exist, and a comment stating that six SQL expressions matched
  when one of them did not.

A file near zero is an exemption rather than a gap when the choices in it are
argued somewhere a reader will reach. `src/server/services/audit.ts` is the
clean case: seven comment lines in 49, all on its one trap — a limit that parsed
to `NaN` surviving `Math.min` into the query — because everything else in it is
the keyset page every list here shares.

`src/server/services/errors.ts` was the other example and is now the correction,
which is worth more than the example was. This guide said it "carries none in
43" because every choice in it a reader could get wrong is argued in
[`code/errors.md`](code/errors.md) — the six constructors and their statuses,
why "not yours" is a 404, why `staleVersion` is separate and why its message is
fixed at the constructor — and that a comment there would be the restatement
`code/comments.md` §2 bans. Comment is 47 per cent of its 117 non-blank lines
now, across five docblocks, and every one of them argues something
`code/errors.md` does not and could not: why a transport refusal is a class of
its own rather than an `AppError`, why the service half of `ApiErrorCode` is
typed narrower than the
published union so the compiler can refuse a code a service cannot have seen,
why `agentMessage` widens a constructor instead of adding a sixth, and twice
over why a `staleVersion` message telling a caller to "retry with the version it
reports" is wrong where there is no version to report.

That is the sentence in this guide with the most riding on it, and it was false.
`AGENTS.md` tells an agent, before its first edit, that comments here are dense
on purpose and not to tidy them away. This guide told the same agent that
comments in that exact file would be a banned restatement. The lesson is the one
`code/comments.md` §2 is actually making: the ban is on repeating what another
document says, not on commenting a file another document happens to discuss. A
file is exempt while every choice in it is somebody else's to explain, and stops
being exempt the moment it makes one of its own.

So no file is listed here as permanently exempt, and that is the rule rather
than a gap in it. `code/comments.md` §3 has already decided the general case, in
"Ordinary CRUD carries almost none, and should not", and §8 says why a density
floor would be worse than none: it is gamed by exactly the restatement comments
§2 bans. A density that tracks surprise will always leave some files at zero,
and naming them in a guide turns an observation into a licence.

*Checked by:* `tests/comment-density.test.ts`, three ways, which is two more
than this paragraph used to say existed. It holds `src` above a floor, so
somebody tidying the comments away fails the suite. It holds the percentage
`AGENTS.md` and `code/comments.md` quote to within a point and a half of the
measurement *and* to each other, so a reader never meets two numbers and has to
work out which is current. And it pins the raw `N of M` pair beside the
percentage exactly, because "a band wide enough to survive a normal week's edits
is wide enough to hide three hundred lines". `tests/writing-guide.test.ts` holds
the two files named above to being the ends of the range they are called.

*Not checked:* a grep for `TODO` and `FIXME` over `src/`, which would be one
line and would hold the second of the three rules above. It still does not
exist, and `src/` is still clean of all four markers. And whether a comment is
*true* is not testable at all — that is the third rule, and it is the one that
has shipped defects twice.

## Keeping a document true

**House. A change that alters behavior a document describes changes that
document in the same commit.** `AGENTS.md`'s definition of done covers the code
half. The documentation half is habit, and habit is why ten of these are
checked and three are not.

What is checked:

| Correspondence | Checked by |
| --- | --- |
| Every MCP tool name appears in `docs/mcp.md` | `tests/mcp-parity.test.ts:314-324`, by name rather than by count, "so the failure says which" |
| Every pinned image tag in the tree matches the release, *and* is a file `set-version` rewrites | `tests/version.test.ts:232-262`, which finds them by sweeping the repository rather than by holding a list — the list had gone stale once, leaving a third file deploying the release it was written during |
| The product backlog's version matches the manifest | `tests/version.test.ts:321-323` |
| `docs/deployment.md`'s settings tables against `.env.example` and `deploy/compose/.env.example`, both directions | `tests/env-example.test.ts`, which documents every variable an example names and shows an example of every variable the tables document, and holds its own two exception lists to being genuinely exceptional. Two of the four example files are outside this row: `deploy/compose/single/.env.example` and `deploy/compose/single/.env.postgres.example` arrived with the `single` profile, and no table on the deployment page describes either |
| Every example file under `deploy/compose/` against the Compose projects beside it | `tests/env-example.test.ts` again, by recipe — a directory holding an example and the compose files it is an example for, discovered rather than listed, after a check written for one pair left the `single` profile's two pairs unwatched. A variable can be documented, uncommented by an operator, and reach no container at all |
| Every name `src/server` reads against every compose file that runs it, both directions | `tests/env-example.test.ts`, the one check here that starts from the source rather than from a document. Its docblock names what drove it: `PRIVACY_POLICY_URL` was in no compose example, all three shapes dropped it, and an operator turning AdSense on was refused at startup over a variable they had just set |
| The `docker run` command in `README.md` and `docs/deployment.md` carries its hardening flags | `tests/deployment-docs.test.ts`, which requires `--read-only`, the `noexec,nosuid` tmpfs, `--stop-timeout 30`, `--cap-drop=ALL` and `--security-opt=no-new-privileges` in both, and hardens every service in the compose recipe the same way |
| The README tells somebody who found a hole where to report it, and does not answer the contributing question with the invariants file | `tests/docs-conventions.test.ts` |
| The roadmap says how every shipped item was met | `tests/docs-conventions.test.ts` |
| `docs/deployment.md`'s stated defaults against `config.ts` | `tests/operations-defaults-and-send-failures.test.ts`, which reads sixteen literal defaults back off the running configuration with nothing set and holds its register to the table in both directions; it was on the list below, as "the likelier drift of the two", until it was written |

The example-file row was on the list below until it was written. It moved
because the hand-kept version had already drifted six variables in both
directions at once: `NODE_ENV` and the two Google settings were in
`.env.example` and in no table, and the three the nginx image reads were in a
table and in no example.
Both halves are the same defect from opposite ends. An operator who copies the
example gets a variable nothing documents; one who reads the tables looks for a
line that is not there. A drifted example file is worse than no example file,
because it is believed.

What is not, in the order they are likely to drift:

- The example files against `config.ts`, which is far narrower than this bullet
  used to be. The source-side row above starts from `src/server` and holds every
  compose file to passing exactly the names it finds, so a name the server reads
  and a compose file drops now fails. What is left is the example files
  themselves: nothing compares the set of names they *offer* against the set the
  source reads.
- `docs/architecture.md`'s "Where things live" paths against the tree.
- `docs/how-to.md`'s named buttons and fields against the screens that carry
  them. This one has already drifted once, and the commit that repaired it is
  titled "Correct the manual where the fact-check caught it inventing UI".

All three hold today, by hand. There were four, and the one that left is worth
naming because it was called "the likelier drift of the two":
`docs/deployment.md`'s stated defaults against `config.ts`. The names were held
and the values beside them were not.
`tests/operations-defaults-and-send-failures.test.ts` holds them now — sixteen
literal defaults read back off the running configuration with nothing set, with
an inventory case holding the register to the table in both directions, so a
default argued to belong to the nginx container has to say so by name.

**House, and specific to this product.** Any convention stated in `docs/mcp.md`
prose that an agent must obey also appears in a tool or field description,
because an agent never reads the prose. The document already articulates the
principle at `:105`: "Fields carry descriptions, so an agent reading the schema
learns the conventions that matter."
[`mcp.md`](mcp.md#descriptions) owns the rule; it is repeated here because the
temptation is to write the convention down in the guide and consider it
delivered.

**House, format.** Hard-wrapped at 80 columns, without breaking a word. Table
rows are single unwrapped lines however long they get. Sentence case headings,
per [`common.md`](common.md#prose), with proper nouns excepted. Fenced code
blocks always carry a language tag, including `text` for things that are not
code. Modal line length is 78 in the changelog and the upgrade notes, 79 in the
roadmap and 77 in the architecture document, counted 2026-10-01 in characters
rather than bytes — the two differ by about eighty per cent on a file this full
of em dashes, and a column is a character.

**Long lines in `CHANGELOG.md` should come back to 80**, and that instruction is
now stated without a number on purpose. It used to read "76 lines currently run
past 80"; there are 108. An instruction carrying a count is a deadline nobody
set: it was true when written, nothing checked it, and the sentence went on
sounding like a small tidy-up while the thing it asked for got further away. The
number lives in `tests/writing-guide.test.ts` as a ceiling, where it fails,
rather than here, where it rotted.

**House, pictures.** A diagram is Mermaid in the document, never an exported
image, because an image cannot be diffed and goes stale in silence. There is
exactly one, at `docs/architecture.md:8-19`.

Screenshots are two populations with opposite cadences, and this rule used to
describe only the smaller one. `docs/images/dashboard.png` is the README's, and
it is replaced when the thing it shows changes **shape** rather than when it
changes colour. It was last retaken against a real production build during the
0.1.5 cut, which is the standard: a seeded ledger and the real
Content-Security-Policy in force, not a development server. The other
twenty-eight are `docs/product/screenshots/` — every screen in both themes,
rebuilt against a committed seed and pinned to the release — and those are
retaken when a screen changes **colour**, which is the opposite rule, because a
token change invalidates half of them while moving no layout at all. §The
product kit is a document with a machine for a reader has the rest, and
`tests/writing-guide.test.ts` holds the count.

*Checked by:* the ten rows above, and nothing else.

### A measured number carries a test or a date

**House**, partly mechanizable, and the rule that pays for this whole pass.
Eighteen of the thirty things this guide got wrong were counts. Every one of
them was true when it was written. Not one of them failed anything.

The argument is already in the repository twice, and both mechanisms make it in
their own docblocks rather than leaving it to be inferred.
`tests/comment-density.test.ts` exists because a percentage quoted in two
documents "was 14.9% when it was written and 16.8% two steps of work later,
which nobody noticed, because a number in prose is checked by whoever recounts
it, and nobody recounts it". `tests/testing-guide-counts.test.ts` exists because
a tier table "said 48 node files when there were 68" and a run table claimed 812
tests where there were 1,025. That is the same failure, found twice, in two
guides, by accident both times.

So:

- **A number recoverable from the tree gets a test**, written in the same change
  that writes the number. Not a recount at release time. Recounting by hand is
  what the release procedure already does, and it is what produced these thirty
  findings rather than what prevented them — the recount is not the mechanism,
  it is what you do when there is no mechanism.
- **A number that is not recoverable gets the date it was taken.** Corpus-wide
  counts of a punctuation mark, commit statistics, anything measured across a
  history that grows under every commit. A dated number is one a reader can
  weigh: "that was 2026-10-01 and 168 commits ago" is useful, and an undated one
  invites a belief it has not earned.

And the half to resist, because both existing mechanisms resist it and say why.
**Do not pin a number the change under test has to update.**
`tests/testing-guide-counts.test.ts` holds the file counts and deliberately
leaves the test counts beside them alone, because "a check that the change under
test has to update teaches people to update it without reading it".
`tests/comment-density.test.ts` holds a floor and a band rather than an
equality, for the same reason, and pins the raw pair only because a band wide
enough to survive a normal week is wide enough to hide three hundred lines. A
number that moves with every commit wants a date; a number that moves when a
*file* is added wants a test, and being made to edit the page then is the point
rather than the friction.

The obvious alternative is what this guide was already doing: write the number,
recount at release time, fix what drifted. The evidence against it is this
section's own first paragraph.

*Checked by:* nothing general, and there cannot be — no test can tell a measured
number from a date, a version or a line reference. What is checked is the
numbers themselves, one mechanism per claim:
`tests/comment-density.test.ts`, `tests/testing-guide-counts.test.ts`,
`tests/standards-citations.test.ts` for `web.md`'s three censuses, and
`tests/writing-guide.test.ts` for this guide's.

### Cite by name, then by line

**House**, not mechanizable, and the practice that decides whether a citation is
still worth following in a year. Four citations in this guide alone had drifted
onto something else entirely: `tests/migrations.test.ts`:363 onto a docblock
about a different migration, `docs/upgrades.md`:1227 onto the closing fence of a
code block, `AGENTS.md`:289-326 onto a range whose second quoted sentence now
sits thirty-one lines past its end, and `StagingPage.tsx`:1075 onto a row
checkbox.
All four passed `tests/standards-citations.test.ts`, which says as much itself:
"what it cannot prove is that the line still holds the thing the sentence
claims. That half stays a person's job."

What survives the drift is the thing's own **name** beside the number — a test
title, an exported symbol, a heading, a CSS class — because a name survives a
move and a number does not. `tests/version.test.ts:375` alone is a line somebody
has to open and squint at. `tests/version.test.ts:375`, "is the version the
upgrade notes tell an operator about", is a citation the next reader resolves
with a search once the line has moved. The number is what makes it cheap to
follow today; the name is what makes it followable at all.

Dropping the line number instead is the obvious alternative, and it is worse.
`tests/standards-citations.test.ts` already checks bare paths for exactly this
reason, and found a guide naming the budgets integration test directly under
`tests/` when it has only ever lived in `tests/integration/` — a path spelled
with no line number and never followed by anybody. A citation with no line is
also a citation nobody follows into a three-thousand-line stylesheet. The answer
is both, not either.

This is not a defect of this guide in particular. The same pass found drifted
citations across this set rather than only here, which is a property of line
numbers and not of anybody's care.

**A citation quoted as history keeps its number outside the code span.** The
four drifts above are records of what a citation used to say, and a repoint pass
that moved them "fixed" the history into something false: one landed on prose
it claims is a closing fence. So a number quoted as it once was is written
`` `AGENTS.md`:289-326 ``, the line outside the backticks, which no check and
no repoint pass reads as a pointer — and a citation meant to be followed is
written as one span, `` `AGENTS.md:338` ``, and is repointed when it drifts.

*Checked by:* `tests/standards-citations.test.ts`, as far as a test can go: that
the file exists, that the lines are inside it, that a range does not run
backwards, that a citation does not come to rest on a closing brace or a blank
line, that a heading link points at a heading that exists, and — for the one
shape where the claim itself is checkable — that a citation naming a CSS class
lands on or beside that class's own rule. *Not checked:* whether the line still
holds the claim, which is review, and which the four drifts above are what
review is for.

## Where this guide and the repository disagree

Recorded rather than resolved, because each needs a decision rather than an
edit.

- **Em dashes.** `common.md` said "No em dashes. They are a house preference and
  the codebase is consistent about it." The corpus is not, and the gap is now
  the whole argument. Counted 2026-10-01: 294 in `CHANGELOG.md`, 63 in
  `docs/roadmap.md`, 604 across the commit bodies reachable from `HEAD`, and 905
  comment lines in `src/`. Those four read 44, 33, 94 and 79 when this bullet
  was first written, and 70, 43, 238 and 272 when it was first corrected — a
  third generation of the same four numbers, every one of them larger, and not
  one of them moved because anybody argued the rule down. A rule nothing
  enforces loses ground at the rate the repository grows: that was the case for
  scoping the rule rather than restating it, and three generations of the same
  evidence make it stronger, not weaker. The numbers carry the argument on their
  own, which is why they are dated rather than merely quoted — see §A measured
  number carries a test or a date.

  In browser copy the rule holds almost everywhere, across eight files rather
  than the four sites this bullet used to name, each cited by what it is as well
  as by where it is:

  - `App.tsx:710`, the scope description on the authorization page.
  - `select-options.ts:110`, the timezone label.
  - `components.tsx:1211`, every page title: `` `${title} — ${APP_NAME}` ``.
  - `TemplatesPage.tsx:713`, "never — every date is skipped".
  - `AccountsPage.tsx:660-661`, the sentence explaining what a frozen account
    still does, and `BudgetsPage.tsx:1578`, the note under an average with
    nothing behind it. Both arrived in 0.2.0.
  - `SettingsPage.tsx:523`, the warning about what cancelling takes with it.
  - `PlanPage.tsx:1980` and `:2000`, the "Annual — $30.00 a year" price
    labels.

  The review queue's inline-edit labels were a ninth, and are off the list: they
  were accessible names, where `common.md` refuses a dash outright, and the
  payee one had been written as a `const` beside its row to keep the dash off
  the line the label check reads. They join their halves with a comma now.

  The lone "—" in an empty table cell is a placeholder glyph rather than
  punctuation and is not counted. Two further sites, `SettingsPage.tsx:143` and
  `ReportsPage.tsx:252-256`, are prose inside JSX and read as copy but are
  comments, so they answer to the comment rule rather than to this one.

  The inline-edit citation is the one worth dwelling on. It read
  `StagingPage.tsx`:1075, and that line had become a row checkbox — a non-blank line
  of plausible-looking code, so every check in
  `tests/standards-citations.test.ts` passed on it, including the one that
  catches a citation landing on a closing brace. §Cite by name, then by line is
  the practice that would have saved it.

  The rule as it was written was therefore nearly true of browser copy and
  plainly false of documents, commit bodies and comments. `common.md` owned the
  sentence and this guide could not narrow it, so the choice went to the owner,
  and `common.md` §Prose has made it: the rule is scoped to a control's own
  words — a heading, a label, a button, an accessible name — and is ordinary
  punctuation everywhere else, including in this guide, a commit body and a
  comment. `tests/writing-guide.test.ts` holds the list above to the browser
  copy, so a ninth file is a decision rather than a drift.
- **The frozen migration list has two homes.** `AGENTS.md` names every
  migration in prose and `tests/migrations.test.ts` pins the first five by name.
  The two are now held together, because that test reads `AGENTS.md` and fails
  on a file it does not name. What is still unpinned is the order of everything
  after the fifth.
- **`Co-Authored-By` casing**, three hand-written commits of the 352 that carry
  a trailer, plus two GitHub wrote (2026-10-01).
- **Four forms of a release subject** across seven release commits, though
  `Cut X.Y.Z` has two of them now and is no longer one cut's habit.
- **`Humanize the docs`**, an American spelling in a subject, in a repository
  whose prose was British when that commit landed. Pre-convention, and the only
  one — and the convention has since turned over to meet it
  (`docs/standards/common.md` §Naming).
- **The browser tier is thin.** `tests/browser/` is two specs,
  `budgets.spec.ts` and `plan-buttons.spec.ts`. Every other page still rests on
  jsdom, which cannot see the class of defect that tier was added for. The
  second sentence is the one somebody acts on when deciding whether a new page
  needs a spec of its own, and the first was wrong about the size of the tier
  for a release: "covers the budgets page and nothing else" was true when it was
  written and stopped being true when the plan tab shipped, which is a
  browser-only surface if anything here is.
- **No `CONTRIBUTING.md`**, on a published AGPL project that accepts dependabot
  pull requests. The README carries a `## Contributing` section
  (`README.md:228`) and `tests/docs-conventions.test.ts` holds it to not
  answering the question by pointing at the invariants file, so the half that
  was missing is the separate document a forge links to from a pull request
  form. Whether pull requests are taken at all is the owner's answer to give,
  and until it is given there is nothing truthful to write in one.

## What is checked, and what is not

Everything in this guide is review except what fifteen test files cover. The list
said six for a release, and what it left out was the half that reads worst: the
test holding **this guide's own evidence** was not on it, which left the
impression that the citations here answer to nothing.

- `tests/version.test.ts` — the version, in every place it is written, that
  `set-version` rewrites each one, and that the upgrade note for this release
  and the next one both exist.
- `tests/migrations.test.ts` — what an upgrade note promises about somebody's
  data, and that `AGENTS.md` names every file in `drizzle/`.
- `tests/mcp-parity.test.ts` — whether `docs/mcp.md` names every tool, by name
  rather than by count, "so the failure says which".
- `tests/env-example.test.ts` — the deployment tables, the four example files,
  the Compose recipes beside them, and every name `src/server` reads.
- `tests/docs-conventions.test.ts` — whether the README still points at a
  reporting channel, whether every shipped roadmap item still says how it was
  met, and whether the links out of the root resolve.
- `tests/deployment-docs.test.ts` — whether the run command a reader copies
  still carries the flags that make it safe.
- `tests/standards-citations.test.ts` — **this guide's own citations**, and
  every other guide's: that they resolve, that they land on something, that a
  heading link points at a heading, that `web.md`'s censuses match the
  stylesheet, and that a sentence attributed to `AGENTS.md` quotes it rather
  than paraphrasing it.
- `tests/writing-guide.test.ts` — the claims here that the tree can answer: the
  document table against the corpus both ways, the skill count, the guide count,
  the screenshots, the roadmap's tally of marked items, the two ends of the
  comment-density range, the em dashes in browser copy, two ceilings on
  `CHANGELOG.md`, and a language tag on every fenced block in every document,
  where seventeen had none.
- `tests/skills.test.ts` — the six skills, against `AGENTS.md` and against this
  guide's table.
- `tests/comment-density.test.ts` — the density rule, three ways.
- `tests/testing-guide-counts.test.ts` — `testing.md`'s file counts against the
  files, and its test counts against each other.
- `tests/deploy-readme-links.test.ts` — every relative link in every document
  under `deploy/`, after two that had never worked.
- `tests/operations-defaults-and-send-failures.test.ts` — the deployment
  tables' stated defaults, read back off the running configuration.
- `tests/product-facts.test.ts` — `docs/product/facts.json`'s derived half
  against the source it is read out of, compared rather than regenerated.
- `tests/product-kit.test.ts` — the rest of the kit the marketing site reads:
  the feature list's shape and every screen in both themes.

That is the honest count, and it is the highest ratio in this set, because a
document's defects are almost all defects of truth rather than of form. The
three worth naming, because they are the ones that actually go wrong:

- Whether a changelog entry describes a change somebody would notice, or a
  change the author found interesting.
- Whether an upgrade note's first sentence lets the right operator stop reading.
- Whether a decision recorded in `AGENTS.md` or the roadmap is still true.

The cheap checks that do not exist and would pay: a `TODO`/`FIXME` grep over
`src/`, a subject-length and prefix check on commits, and the example files
against the set of names `config.ts` reads — the compose half of that is held
now and the example half is not.

Two items have left this list since it was written, and both left the same way,
by somebody building the mechanism rather than by the list being edited: the
frozen migration list, which `tests/migrations.test.ts` now reads out of
`AGENTS.md`, and the upgrade note for a release, which `tests/version.test.ts`
now requires a release ahead of time. Both had already fallen behind before the
check caught up with them, which is the pattern worth noticing — a rule in this
column is a rule somebody is currently keeping true by remembering.

A rule that appears in neither column is a rule nobody is responsible for, and
that is a defect in this guide rather than in the repository.
