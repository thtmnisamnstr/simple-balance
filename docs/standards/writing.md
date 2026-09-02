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
| `docs/guide.md` | Somebody using it | Tutorial and explanation | A behaviour changes, or the decision behind one does |
| `docs/how-to.md` | Somebody using it, mid-task | How-to | A screen changes what it asks for or what it does |
| `docs/architecture.md` | Somebody changing the code | Explanation | A boundary moves, or a guarantee is added or withdrawn |
| `docs/deployment.md` | An operator standing one up | Reference and how-to | A setting is added, renamed, or given a new default |
| `docs/upgrades.md` | An operator mid-upgrade | How-to | Every release, without exception |
| `docs/mcp.md` | Somebody connecting an agent | Reference | A tool is added, renamed or retired |
| `docs/roadmap.md` | The owner, and anybody deciding whether to depend on this | Intent and evidence | An item ships, or the evidence under it moves |
| `CHANGELOG.md` | Somebody upgrading, and somebody who has just been surprised | Record | Every change a person would notice |
| `docs/standards/` | Somebody writing code, copy or a schema | Reference | A rule changes, everywhere at once |
| `AGENTS.md` | An agent, and a contributor | Invariants | An invariant changes, or a migration ships |
| `SECURITY.md` | Somebody who found a hole in it | How-to | The reporting channel changes, or what is in scope does |
| `deploy/compose/README.md`, `deploy/helm/simple-balance/README.md`, `deploy/pulumi/README.md` | An operator running that one recipe | How-to | That recipe changes |
| `scripts/ralph/README.md`, `guardrails.md`, `iteration-prompt.md`, `progress.md` | The build loop and whoever runs it | Reference | The loop changes |
| `CLAUDE.md` | A Claude Code session | One line, `@AGENTS.md` | Never, by design |

**House. A new document names a reader and a mode before it is created.** If it
cannot name both, it is a section of a document that already exists. The corpus
is small enough to list on one screen, and the reason a reader can find the
right document in it is that none of them overlap.

*Not checked mechanically.* A test cannot tell whether a document has a reader.

### Diátaxis, answered

**House.** Diátaxis is used here as a diagnostic and not as a site plan. Its
foundations page claims completeness, that there are only two dimensions and
"no other territory to cover"; its own how-to page is the honest one, calling
itself "a guide, a map to help you check that you're in the right place", and
warning against empty template sections. Only the second is actionable at this
size.

So: test a page against the four modes when it feels wrong to read, and fix the
page. Do not reorganise `docs/` into four directories. The existing documents
land in the quadrants without having been designed to, which is the evidence
that the shape is real rather than imposed.

Two deliberate departures, named so nobody tidies them:

- **`docs/deployment.md` mixes all three modes across 761 lines and stays that
  way.** An operator reads it once and greps it afterwards. Splitting a working
  reference to satisfy a model would cost the grep and buy nothing.
- **`docs/roadmap.md` and `AGENTS.md` are outside the model.** Neither is user
  documentation. One is intent, one is constitution.

*Not checked mechanically.* This is review, and it is review of a judgement.

## The changelog

**House.** Keep a Changelog is a convention rather than a specification, so
nothing here is Binding. The one principle worth quoting is its first:
"Changelogs are for humans, not machines." This file takes that further than the
convention expects.

- **Prose, not bullets.** `CHANGELOG.md` holds zero list items in 1,746 lines,
  and the paragraphs are why it can be read. An entry runs at the length and in
  the voice of a commit body: what changed, what it fixes, and what it costs.
- **Newest first, under `## Unreleased`, then `## X.Y.Z - YYYY-MM-DD`.** The
  date is ISO 8601 and is the day the release is cut. GitHub anchors those
  headings automatically, which is the whole of the linkability requirement; no
  explicit link definitions are needed and none exist.
- **Section headings borrow Keep a Changelog's vocabulary**: Added, Changed,
  Deprecated, Removed, Fixed, Security. This file also uses `Internal`, for a
  change with no user-visible effect that an operator or a contributor would
  still want to find. Across the dated sections: four Added, four Changed, five
  Fixed, one Security, one Internal. Counting `## Unreleased` as well gives
  five, five and six. The 0.1.0 entry predates the
  convention and uses its own headings; leave it.
- **A change a person would notice gets an entry.** "Notice" means one of four
  things: behaviour on a screen, a value on the wire in any of the three
  contracts, something an operator configures, or something that changes at
  startup. A refactor with none of those is not an entry. This is the rule that
  decides, and it decides at commit time, not at release time.
- **An entry says why, not only what.** The entry that reads well a year later
  is the one carrying the reason, including the limits: "ten categorical colours
  cannot all be told apart by somebody with dichromatic vision" is the model.
- **State the limit rather than omitting it.** A fix that is partial says which
  part.

*Not checked mechanically.* Nothing in `tests/`, `scripts/` or `.github/`
reads `CHANGELOG.md`. In particular nothing checks that the top heading matches
`package.json`, which is a hand step in the release recipe at
`docs/upgrades.md:205` and has already been the subject of a commit ("Date
0.1.4 the day it is cut").

## Versioning

**House, and this guide owns the question for the whole set.** The scheme is
Semantic Versioning 2.0.0. Nothing in the repository stated a versioning policy
before this set. [`operations.md`](operations.md#what-the-version-number-is-about)
cites this section and adds the one consequence that belongs to an operator,
which is that renaming a configuration variable is a breaking release.

The shape of a version is written in three places and two of them disagree.
`scripts/set-version.mjs:25` and `tests/version.test.ts:25` accept a prerelease
suffix; `tasks/product.prd.schema.json:10` pins three numeric parts and nothing
else, so `npm run set-version 0.2.0-rc.1` succeeds, the suite stays green, and
the build loop then refuses to start on an error two steps from its cause.
Widen the schema.

This product is not a library, so "breaking" has to be defined against the four
things somebody can depend on:

| Surface | A breaking change is |
| --- | --- |
| HTTP `/api/v1` | A field removed or renamed, an accepted input narrowed, a status or error code changed for an unchanged request, a default changed. [`http.md`](http.md#what-counts-as-a-breaking-change) holds the full list and the deprecation policy this obliges. |
| MCP | A tool removed or renamed, a required argument added, a scope widened for an existing tool, an output field removed. |
| CSV | A recognised column removed from `APP_CSV_COLUMNS`, or an existing column's meaning changed. Adding a column is not breaking and column order is not part of the contract; [`csv.md`](csv.md#6-the-columns) says why. |
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
tried: three changes in this release each refused a configuration the release
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
  away from anybody who re-authorises without step-up support, so it waits.

None of these is permanent. A break becomes fine once it has been announced for
a release and the thing being removed has been deprecated in the field — which
is what `Sunset` dates and `docs/upgrades.md` are for. What is not fine is
arriving with it.

**What would make it 1.0.0 is not decided.** Recorded as an open question rather
than answered with something invented here.

*Checked by:* `tests/version.test.ts`, which holds fifteen locations to
`package.json`, asserts that `scripts/set-version.mjs` knows about every one of
them, and refuses a version whose `## Before you upgrade to X.Y.Z` section has
not been written. Its own docblock explains why the count is deliberately not
written down. That last check exists because the release recipe used to end
without it, so this guide specified a document the procedure never asked
anybody to write, and 0.1.0 through 0.1.3 shipped eight migrations between them
with no note. The publish runs `npm run verify` first, so an unwritten note now
stops the release rather than reaching an operator mid-upgrade. *Also checked:*
the frozen migration list, which `tests/migrations.test.ts` holds to what is on
disk. *Not checked:* the changelog heading, a hand step in the release recipe at
`docs/upgrades.md:205`, and which release a migration is attributed to,
which is prose inside a list a test can only check the membership of.

## Upgrade notes

**Binding, quoting `AGENTS.md:181-196`:** "Every migration that has shipped is
frozen" and "Never edit or regenerate one: someone's database has already run
it, and changing it would leave their schema and its recorded history
disagreeing." What follows is the documentation the operator is owed for that.

**House, the shape.** A `## Before you upgrade to X.Y.Z` section, and its first
sentence tells an operator whether they can stop reading. `docs/upgrades.md:8-9`
is the model: "Nothing refuses to start that 0.1.5 accepted, and nothing about
an existing configuration has to change. Five things are worth knowing." The
0.1.4 section is the other model, because the answer there was different: "0.1.4
refuses to start on three configurations 0.1.3 accepted", followed by a table of
what to do about each.

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
constant default and therefore rewrites no table, and
`tests/migrations.test.ts:264` is called "adds the theme without rewriting a
row". Six tests in that file make a claim of that kind, covering migrations
0005 through 0011. A note that makes a promise about somebody's data
and has no test behind it has been wrong before: the 0.1.5 contrast note quoted
a number that was not the old value, and the change it described as an
improvement was a small regression.

*Checked by:* `tests/migrations.test.ts`. Per-migration behaviour assertions
cover 0005 through 0011; the frozen ordering list at `:36-43` names the first
five explicitly and the rest are held by number, file and snapshot rather than
by name, and 0012 has no assertion there at all. *Checked by:* `tests/migrations.test.ts`, which reads `AGENTS.md` and fails when
a file in `drizzle/` is not named there. That test exists because the list had
already fallen behind: `AGENTS.md` stopped at `0012` while `drizzle/` held
`0013`, and nothing in `tests/` read `AGENTS.md` at all. *Not checked:* that a
release containing a migration has an upgrade note.

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
  Nine of the fifteen headings carry the state today: SB-016 and SB-017, whose
  lines name the migration that shipped them, and SB-018, SB-019 and SB-025
  through SB-029, whose lines say "Built, unreleased". This
  paragraph said "once the item has shipped" for a while, and the practice never
  did: SB-018 was marked in the commit that built it, a week before the release
  that carried it. The heading answers "is there anything left to write", and the
  line under it answers "can anybody use it", which are different questions and
  are worth keeping apart.
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
  auto-categorisation entry states the case against its own decision and names
  the condition under which to revisit it. That is what makes the section
  useful rather than defensive.
- **Nothing is committed to here.** `tasks/product.prd.json` records the product
  as built; the roadmap records intent, and says so in its opening paragraph.

*Not checked mechanically.* `tests/version.test.ts:89-91` checks that the
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
  is `AGENTS.md:181-196`, the frozen migration list, which names every migration
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
  naming the page. `README.md:27` carries 185 characters of it, naming every
  figure on the page and the fact that currencies are reported separately.
- **A section per question somebody actually asks**, in this order: what it is,
  everything else it does, run it locally, run the tests, host it, connect an
  agent, security, not built yet, more, built with, license.
- **The licence is stated in the README, not only in `LICENSE`.** For an AGPL
  project the licence is a term of use. `README.md:263-273` names it, links it,
  and explains what section 13 adds, including for versions published under the
  older licence.
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
219 commits consistent is that somebody knows the shape.

*Not checked mechanically.* A subject-length and prefix check would catch the
shape and not the substance, and the substance is the whole point of this
convention. Review.

### What it is not

Not Conventional Commits, and not close. Across 219 subjects: zero carry a
`feat:` / `fix:` / `chore:` prefix, zero carry a scope, zero end in a full stop,
and seven carry a pull request number, all of them on dependabot branches. Four
merge commits exist, all dependabot. Three subjects begin lowercase, and all
three predate the convention.

### The subject

**House.** An imperative sentence naming what is now true, from the reader's side. Not
what was edited. Not where. Median 54 characters, and 150 of 219 fall between 45
and 70; treat 70 as the ceiling and let a subject be short when it can be.

The recurring verbs, which are worth knowing because they are the shape of the
thought: Stop, Let, Say, Make, Give, Refuse, Keep, Never, Fix, Take out, Close,
Prove, Record, Answer, Put, Find. Nineteen subjects start with Let, fifteen with
Stop, thirteen with Say.

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
thing where both would do: "spell a payee", not "normalise the payee string".
And where a commit really does several things, join them with a comma rather
than inventing a category: "Stop a staging token making ledger changes, and a
JWT carrying a credential".

### The body

**House.** Multi-paragraph prose, hard-wrapped in the low-to-mid 70s, in the same voice
as the documents. Measured at 219 commits: 41 of 5,389 body lines exceed 80
columns, and three of the 219 have no body at all — a commit with no body is a
commit claiming there was nothing to explain.

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
casing. 183 commits use it. Three hand-written commits use the lowercase
`Co-authored-by`, which is drift; two more carry it because GitHub wrote the
trailer on a squash or a merge, in the casing git itself uses, and those are left
alone for the same reason dependabot subjects are.

**Release commits.** `Cut X.Y.Z`, with a body naming what the release touched:
the version locations, the dated changelog heading, and the migrations added to
the frozen list. Six release commits exist in four forms: "Release Simple
Balance 0.1.0", "Release 0.1.0" and its two successors, "Cut 0.1.5", and 0.1.1
folded into a feature subject. `Cut X.Y.Z` is the one to keep; it is the most
recent and the least ambiguous.

**Dependabot subjects are left alone.** They are the one place a machine writes
the subject, and rewriting them would lose the correspondence with the PR.

*Not checked mechanically.* There is no commit-message tooling of any kind, and
adding a hook would be new infrastructure. A subject-length and prefix check in
CI would be cheap and does not exist.

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
- **The trade named, not only the choice.** `src/client/components.tsx:422-436`:
  a fixed popover, why absolute fails in a scrolling table card, what fixed
  costs, and then the harder half: "Deliberately not `role="menu"` ... menu
  roles without the keyboard behaviour they imply are worse than none."
- **The invariant with the consequence of breaking it.**
  `src/shared/domain.ts:2229-2236`: "`.strict()` is the load-bearing part: a
  filter this cannot honour is an error rather than a key quietly dropped,
  because a selection resolves twice and an ignored filter makes the count and
  the fingerprint agree about the wrong set."
- **The rule stated where somebody will try to break it.**
  `src/client/styles.css:73-92`: why every colour is a token, which test fails
  if one is not, and why the two dark blocks cannot be merged.

Three further rules:

- **Density tracks how surprising the code is, not how important.** It runs
  from 56 per cent of lines in `src/server/services/sorting.ts` to under 1 per
  cent in `src/client/router.tsx`, and that is correct. A function that
  follows a pattern documented once elsewhere earns no comment.
- **No markers, no attributions, no furniture.** Zero `TODO`, `FIXME`, `XXX` and
  `HACK` exist in `src/`. A thing worth doing later is a roadmap item or a
  changelog line, both of which somebody reads. No author names, no
  section-heading banners, no decorative separators.
- **A comment that has stopped being true is a defect, not untidiness.** Two
  have shipped and both were found by audit rather than by a test: a comment
  claiming a cache could spot another account's entry, describing a mechanism
  that did not exist, and a comment stating that six SQL expressions matched
  when one of them did not.

Two files sit near zero and both are exemptions rather than gaps.
`src/server/services/errors.ts` carries none in 43 because every choice in it a
reader could get wrong is argued in [`code/errors.md`](code/errors.md): the six
constructors and their statuses, why "not yours" is a 404, why `staleVersion` is
separate and why its message is fixed at the constructor. Repeating that in the
source would create the restatement `code/comments.md` §2 bans, plus a second
copy to go stale, which the third rule above calls a defect.
`src/server/services/audit.ts` carries three in 49, all on its one trap: a limit
that parsed to `NaN` surviving `Math.min` into the query. The rest is the keyset
page every list here shares.

`code/comments.md` §3 has already decided this, in "Ordinary CRUD carries almost
none, and should not", and §8 says why a density floor would be worse than none:
it is gamed by exactly the restatement comments §2 bans. A density that
tracks surprise will always leave some files at zero, and listing them proposes
the threshold this set has argued against.

*Not checked mechanically.* A grep for `TODO` and `FIXME` over `src/` would be
one line and would hold the third rule above; it does not exist. Nothing else
here is testable, because the thing being judged is whether a sentence is true.

## Keeping a document true

**House. A change that alters behaviour a document describes changes that
document in the same commit.** `AGENTS.md`'s definition of done covers the code
half. The documentation half is habit, and habit is why four of these are
checked and four are not.

What is checked:

| Correspondence | Checked by |
| --- | --- |
| Every MCP tool name appears in `docs/mcp.md` | `tests/mcp-parity.test.ts:300-305`, by name rather than by count, "so the failure says which" |
| Example image tags in `deploy/pulumi/README.md` and the split compose file match the release | `tests/version.test.ts:80-91` |
| The product backlog's version matches the manifest | `tests/version.test.ts:89-91` |
| `docs/deployment.md`'s settings tables against `.env.example` and `deploy/compose/.env.example`, both directions | `tests/env-example.test.ts`, which documents every variable an example names and shows an example of every variable the tables document, and holds its own two exception lists to being genuinely exceptional |

The last of those was on the list below until it was written. It moved because
the hand-kept version had already drifted six variables in both directions at
once: `NODE_ENV` and the two Google settings were in `.env.example` and in no
table, and the three the nginx image reads were in a table and in no example.
Both halves are the same defect from opposite ends. An operator who copies the
example gets a variable nothing documents; one who reads the tables looks for a
line that is not there. A drifted example file is worse than no example file,
because it is believed.

What is not, in the order they are likely to drift:

- `.env.example` against `config.ts`, both directions.
- `docs/deployment.md`'s stated defaults against `config.ts`.
- `docs/architecture.md`'s "Where things live" paths against the tree.
- The run command in `README.md` against the hardening flags it should carry.
- `docs/how-to.md`'s named buttons and fields against the screens that carry
  them. This one has already drifted once, and the commit that repaired it is
  titled "Correct the manual where the fact-check caught it inventing UI".

All five hold today, by hand.

**House, and specific to this product.** Any convention stated in `docs/mcp.md`
prose that an agent must obey also appears in a tool or field description,
because an agent never reads the prose. The document already articulates the
principle at `:67`: "Fields carry descriptions, so an agent reading the schema
learns the conventions that matter."
[`mcp.md`](mcp.md#descriptions) owns the rule; it is repeated here because the
temptation is to write the convention down in the guide and consider it
delivered.

**House, format.** Hard-wrapped at 80 columns, without breaking a word. Table
rows are single unwrapped lines however long they get. Sentence case headings,
per [`common.md`](common.md#prose), with proper nouns excepted. Fenced code
blocks always carry a language tag, including `text` for things that are not
code. Modal line length is 78 in the
changelog and the upgrade notes, 80 in the roadmap, 77 in the architecture
document; 76 lines in `CHANGELOG.md` currently run past 80 and should come back.

**House, pictures.** A diagram is Mermaid in the document, never an exported
image, because an image cannot be diffed and goes stale in silence. There is
exactly one, at `docs/architecture.md:8-19`. There is exactly one screenshot,
`docs/images/dashboard.png`, and it is replaced when the thing it shows changes
shape rather than when it changes colour. It was last retaken against a real
production build during the 0.1.5 cut, which is the standard: a seeded ledger
and the real Content-Security-Policy in force, not a development server.

*Checked by:* the four rows above, and nothing else.

## Where this guide and the repository disagree

Recorded rather than resolved, because each needs a decision rather than an
edit.

- **Em dashes.** `common.md` says "No em dashes. They are a house preference and
  the codebase is consistent about it." The corpus is not: 70 in
  `CHANGELOG.md`, 43 in `docs/roadmap.md`, 238 across the commit bodies
  reachable from `HEAD`, and 272 comment lines in `src/`. Those four read 44,
  33, 94 and 79 when this bullet was written, and none of them moved because
  anybody argued the rule down: a rule nothing enforces loses ground at the rate
  the repository grows, which is the case for scoping it rather than for
  restating it. In user-visible copy the rule holds almost everywhere, with
  four exceptions: `App.tsx:577`, `select-options.ts:110`,
  `TemplatesPage.tsx:595`, and the review queue's inline-edit labels
  (`StagingPage.tsx:942`), which lead with the visible value and set the
  instruction off behind a dash. The lone "—" in an empty table cell is a
  placeholder glyph rather than punctuation and is not counted here. Two
  further sites,
  `SettingsPage.tsx:135` and `ReportsPage.tsx:167-171`, are prose inside JSX
  and read as copy but are comments, so they answer to the comment rule rather
  than this one. Three of those citations have now drifted off the line they
  name at least once, which is what a line number into a file somebody is
  still editing does when nothing checks it. The
  rule as written is therefore nearly true of UI strings and plainly false of
  documents, commit bodies and comments.
  `common.md` owns the sentence and this guide cannot narrow it, so the choice
  is the owner's: scope the rule to copy, or accept an edit across six files and
  every future commit body. Until then, new prose written under this guide
  takes the rule as written.
- **The frozen migration list has two homes.** `AGENTS.md` names every
  migration in prose and `tests/migrations.test.ts` pins the first five by name.
  The two are now held together, because that test reads `AGENTS.md` and fails
  on a file it does not name. What is still unpinned is the order of everything
  after the fifth.
- **`Co-Authored-By` casing**, three hand-written commits of 186, plus two
  trailers GitHub wrote.
- **Four forms of a release subject** across six release commits.
- **`Humanize the docs`**, an American spelling in a subject, in a repository
  whose prose is British. Pre-convention, and the only one.
- **The browser tier is new and thin.** `tests/browser/` covers the budgets
  page and nothing else. Every other page still rests on jsdom, which cannot
  see the class of defect that tier was added for.
- **No `CONTRIBUTING.md` and no Contributing section**, on a published AGPL
  project that accepts dependabot pull requests. Whether pull requests are taken
  at all is the owner's answer to give, and until it is given there is nothing
  truthful to write.

## What is checked, and what is not

Everything in this guide is review except what five test files cover:
`tests/version.test.ts` on the version, `tests/migrations.test.ts` on what an
upgrade note promises about somebody's data, `tests/mcp-parity.test.ts` on
whether `docs/mcp.md` names every tool, `tests/env-example.test.ts` on whether
the deployment tables and the example files still describe the same set of
variables, and `tests/docs-conventions.test.ts` on whether the README still
points at a reporting channel and every shipped roadmap item still says how it
was met. That is the honest count, and it is the highest ratio in this set,
because a document's defects are almost all defects of truth rather than of
form. The three worth naming, because they are the ones
that actually go wrong:

- Whether a changelog entry describes a change somebody would notice, or a
  change the author found interesting.
- Whether an upgrade note's first sentence lets the right operator stop reading.
- Whether a decision recorded in `AGENTS.md` or the roadmap is still true.

The cheap checks that do not exist and would pay: a `TODO`/`FIXME` grep over
`src/`, a subject-length and prefix check on commits, and `.env.example` against
`config.ts` in both directions. The frozen migration list is no longer on this
list: `tests/migrations.test.ts` reads `AGENTS.md` and fails on a migration it
does not name, which it was written to do after the prose had already fallen
behind the tree.

A rule that appears in neither column is a rule nobody is responsible for, and
that is a defect in this guide rather than in the repository.
