# Standards

What this product does the same way everywhere, and why.

These are the design and interface standards. They govern the web app, the MCP
surface, the HTTP API, the CSV round trip, mail, configuration, the machines and
charts an operator deploys, and the documentation. They do not govern the
ledger: what the books guarantee is in [`AGENTS.md`](../../AGENTS.md), and
nothing here restates it.

They also do not govern the source. How the code is *written* — strictness,
services, queries, React, errors, tests, metrics and logging, comments — is
[`code/`](code/index.md), a second set of eight guides that carries the linter
and formatter decisions with it. That is one subject per guide, and `AGENTS.md`
carries the same list for the same eight files; `tests/standards-index.test.ts`
holds the two together, because the commit that grew the set to eight edited the
count here and left the list, and the subject it dropped was the one the console
rule lives under. The split is by what breaks: an interface standard broken is
something a person can see, a code standard broken is something the next person
has to live with.

## The division with AGENTS.md

- **If breaking it corrupts data, loses money, or crosses a tenant boundary, it
  is an invariant.** It lives in `AGENTS.md` and it is not up for discussion.
- **If breaking it makes the product inconsistent, harder to use, or harder to
  operate, it is a standard.** It lives here.

A guide cites `AGENTS.md` by quoting the sentence, never by paraphrasing it. A
rule in two places drifts, and the copy that drifts is always the paraphrase.

One deliberate exception, stated so nobody tidies it away: **the money rule is
repeated wherever the temptation to break it lives.** `AGENTS.md` says "Never
represent money with JavaScript/JSON floating-point numbers." That sentence is
quoted in five of the seven interface guides, `common.md`, `web.md`, `mcp.md`,
`csv.md` and `operations.md`, and in one of the eight code guides,
`code/typescript.md`. Every temptation to break it lives in a presentation
layer, a bar width, a chart scale, a sort comparison, a CSV cell, a mail
subject, and those six are the guides that govern them. Repeating an invariant
where the temptation lives is placement, not duplication. Repeating it where
there is no temptation would be the drift the paragraph above forbids, which is
why the other two do not carry it: `http.md` settles money on the wire in its
own terms (`docs/standards/http.md:741-743`), and nothing `writing.md` governs
holds an amount. `tests/standards-index.test.ts` holds the list to the guides,
both ways, so "every guide" cannot creep back in.

## Every rule carries a label

| Label | Means |
| --- | --- |
| **Binding** | A specification, a WCAG 2.2 level A or AA success criterion, or an `AGENTS.md` invariant. Not a preference. Breaking one is a defect. |
| **House** | Defensible taste. Consistency is the point, so change it here rather than in one file, and change it everywhere at once. |
| **Contested** | Published guidance disagrees with itself. The guide records both positions and says which this product picked, so the next person argues with the decision rather than rediscovering the disagreement. |

There is no unlabeled rule in a guide. A rule nobody will label is a rule
nobody believes.

**This file is the exception, and says so rather than leaving it implicit.** The
sentences that *define* the scheme carry no label, because labeling them would
be circular: "**Binding**: every rule carries a label" tells a reader nothing
about which authority it comes from, because the answer is this document. For
the same reason this file carries no "What is not enforced" table. A rule this
file states about anything other than the scheme is labeled like any other, and
the one under the conformance table is.

**What checks the scheme is narrower than it reads, which is worth knowing
before citing it as cover.** The labeled-rule check in
`tests/standards-citations.test.ts` globs `docs/standards/code/*.md`, and its
one named exclusion is that directory's own `index.md`. This file is outside the
glob entirely and was never a candidate to be filtered, and so are the seven
interface guides. Two consequences follow. A labeled section with no stated
mechanism goes unreported everywhere above `code/`: forty-one of them when this
paragraph was written, twenty in `web.md` alone. That number moves as the guides
are brought up to the rule; what does not move is that nothing reports it. And
a section carrying no label at all is skipped rather than failed, in the code
guides too, because the test cannot tell an unlabeled rule from the four things
named below that are not rules. The silent state is therefore the invisible one,
which is the wrong way round: a rule nobody labeled reads as covered. Closing
either gap needs a check that can tell a rule from a preamble, and nothing has
one yet.

A label attaches to a rule. A preamble, a record of what the code does today, a
roll-up of what is checked, and a note of where a guide and the repository
disagree are none of them rules, and labeling them would make the labels mean
less. A subsection carrying rules of its own carries its own label rather than
inheriting one.

## Every rule says how it is checked

A rule enforced by a test names the test. A rule that is not enforced says so.
That is what turns the enforcement list into a maintenance task rather than an
aspiration, and it is how the count of rules only a person can catch stays
visible and gets smaller.

This repository already works this way. `tests/theme-tokens.test.ts` refuses a
color that is not a token, `tests/mcp-parity.test.ts` compares the two
transports route by route in both directions, `tests/security-header-parity.test.ts`
compares the Hono headers with the nginx ones character for character, and
`tests/nav-order.test.ts` pins an ordering somebody decided. The guides extend
that habit rather than introducing it.

**Name the check the test actually is, not the rule it serves.** That parity
sentence read "service by service" from the day this file was written, on the
strength of a second assertion inside the same file that compares which service
a route and its tool reach. The primary one is a map of routes to tools, and the
difference is the limit `AGENTS.md` states: "Route by route is where the test
can check, not where the rule stops: a request field only an agent ever sets is
the same defect one level down, and it is invisible to a comparison of route
lists." Describing the secondary check as the whole one is how a mechanism gets
believed past its reach, which is the same defect as a citation that lands on a
plausible wrong line.

## The set

| File | Governs |
| --- | --- |
| [`common.md`](common.md) | Money, dates, naming, errors, the glossary, prose. Cited by everything below. |
| [`web.md`](web.md) | The browser app: tokens, layout, forms, tables, charts, accessibility, copy. |
| [`mcp.md`](mcp.md) | The agent surface: tools, schemas, descriptions, errors, scope, context cost. |
| [`http.md`](http.md) | `/api/v1` as a public contract: resources, bodies, errors, pagination, versioning. |
| [`csv.md`](csv.md) | The import and export format, and what makes a round trip lossless. |
| [`operations.md`](operations.md) | Mail, configuration, and everything an operator runs: the images this project publishes, the two machines of the `single` profile, and the Helm chart at its two shapes. |
| [`writing.md`](writing.md) | Documentation, the changelog, decisions, the README. |
| [`code/`](code/index.md) | The source itself: eight guides, plus the toolchain the whole repository is checked with. |
| `docs/product/` | **Governed, not governing.** This repository's published description of itself, which the marketing site at smpl.money reads. `writing.md` for its shape and cadence; `AGENTS.md` for its contract. |

Read `common.md` first. Most of what looks like an interface question turns out
to be a question about a value crossing a boundary, and those are answered once.

The last row is not a guide, and it is in the table because this is the page a
reader reaches first. `docs/product/` is a published interface with an external
consumer that cannot run this application, so a kit not rebuilt here is not
rebuilt anywhere. What it may claim about plans, limits, labels and prices is an
invariant rather than a preference, which is why its contract is `AGENTS.md` and
`tests/product-facts.test.ts` fails when the committed file disagrees with the
source. The `product-kit` skill rebuilds it. Leaving it out left the one
question routing exists to answer with no answer at all.

## Conformance targets

| Surface | Target |
| --- | --- |
| Web app | WCAG 2.2 level AA |
| HTTP API | RFC 9110 semantics, RFC 9457 problem details, RFC 3339 dates. **Not met:** an error is this product's own envelope and not `application/problem+json` ([`http.md`](http.md#the-envelope-and-where-it-is-going)) |
| MCP | Model Context Protocol, revision 2026-07-28 |
| CSV | RFC 4180, with the departures named in `csv.md` |
| Container | OCI image spec, non-root, read-only filesystem. **Not met:** the `single` profile's database machine runs the official `postgres` entrypoint as root against a writable data directory ([`operations.md`](operations.md#hardening)). The same database under the chart conforms |

A target is a claim somebody can check, which is why each names a document
rather than an adjective.

### A target that is not met records the miss here

**House.** A row whose target the repository does not meet carries **Not met:**,
one sentence saying what falls short, and a link to the section of the guide
that argues it. A guide that records a new miss edits this table in the same
commit, the way [changing a rule](#changing-a-rule) obliges every file a rule
governs to change at once.

Two of the five rows are in that state and neither said so until this rule.
The error format is a labeled `Contested` section in `http.md` closing "this API
does not conform to its own error target", written because publishing the API
settles an argument the MCP transport had kept open. The container is a prose
paragraph under `operations.md` §Hardening, and its status changed on this
branch: the exception used to cover a one-command trial alone, and now covers a
production machine as well. The `single` profile's database runs the official
`postgres` entrypoint, which starts as root to chown PGDATA before dropping
privilege, so that service declares no `user`, no `read_only` and no `cap_drop`
(`deploy/compose/single/compose.postgres.yml:248-253`). Two misses, two guides,
two shapes, and the table making both claims linked to neither.

**The obvious alternative is to let each guide record its own miss**, which is
what happened, and it is wrong for this file in particular. A reader reaches
this table *instead of* the guide, because routing is what the page is for, so
somebody checking whether the API emits problem details stops at the row that
says it does. An unmarked target is not merely silent: it is believed and cited,
which is the failure mode of a guide that lies rather than of one that is quiet.
Nor can the target itself be softened to match the code, which was the other
alternative. The target is right and the code is right, and this file's existing
convention for that is to record the conflict rather than quietly pick a side.
This rule is that convention carried over from a guide against `AGENTS.md` to a
target against the repository. Five rows, five surfaces that keep moving, and
two misses in the two release cycles this file has existed for is not a rate
that stays at two.

*Checked by:* `tests/standards-index.test.ts`, which parses this table and holds
three things: every **Not met:** marker carries a link that resolves to a
heading that exists, the section behind it still records a miss, and a guide
whose prose says it does not conform to its own target is linked from a row
here. The third is the one that goes stale on its own, and it is also the weaker
half: it can only see a miss stated in those words, so `operations.md`'s, which
is argued as an exception and never names a conformance target, is reachable
from the link and not from a grep. That is the reason the rule asks for the
marker rather than for a phrase.

## Changing a rule

Change it here, in one place, and change every file it governs in the same
commit. A standard that is true of half the product is not a standard, it is a
description of the half that was easiest.

Where a guide and `AGENTS.md` conflict, `AGENTS.md` wins and the guide records
the conflict rather than quietly losing it, with the reasoning beside it. Those
are the places where published best practice and this product's invariants
genuinely disagree, and leaving them unwritten would mean the next person
rediscovers the argument instead of reading its conclusion.
