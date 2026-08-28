# Standards

What this product does the same way everywhere, and why.

These are the design and interface standards. They govern the web app, the MCP
surface, the HTTP API, the CSV round trip, mail, configuration and the
documentation. They do not govern the ledger: what the books guarantee is in
[`AGENTS.md`](../../AGENTS.md), and nothing here restates it.

They also do not govern the source. How the code is *written* — strictness,
services, queries, React, errors, tests, comments — is
[`code/`](code/index.md), a second set of eight guides that carries the linter
and formatter decisions with it. The split is by what breaks: an interface
standard broken is something a person can see, a code standard broken is
something the next person has to live with.

## The division with AGENTS.md

- **If breaking it corrupts data, loses money, or crosses a tenant boundary, it
  is an invariant.** It lives in `AGENTS.md` and it is not up for discussion.
- **If breaking it makes the product inconsistent, harder to use, or harder to
  operate, it is a standard.** It lives here.

A guide cites `AGENTS.md` by quoting the sentence, never by paraphrasing it. A
rule in two places drifts, and the copy that drifts is always the paraphrase.

One deliberate exception, stated so nobody tidies it away: **the money rule is
repeated in every guide.** `AGENTS.md` says "Never represent money with
JavaScript/JSON floating-point numbers." Every temptation to break it lives in a
presentation layer, a bar width, a chart scale, a sort comparison, a CSV cell, a
mail subject. Repeating an invariant where the temptation lives is placement,
not duplication.

## Every rule carries a label

| Label | Means |
| --- | --- |
| **Binding** | A specification, a WCAG 2.2 level A or AA success criterion, or an `AGENTS.md` invariant. Not a preference. Breaking one is a defect. |
| **House** | Defensible taste. Consistency is the point, so change it here rather than in one file, and change it everywhere at once. |
| **Contested** | Published guidance disagrees with itself. The guide records both positions and says which this product picked, so the next person argues with the decision rather than rediscovering the disagreement. |

There is no unlabelled rule. A rule nobody will label is a rule nobody believes.

A label attaches to a rule. A preamble, a record of what the code does today, a
roll-up of what is checked, and a note of where a guide and the repository
disagree are none of them rules, and labelling them would make the labels mean
less. A subsection carrying rules of its own carries its own label rather than
inheriting one.

## Every rule says how it is checked

A rule enforced by a test names the test. A rule that is not enforced says so.
That is what turns the enforcement list into a maintenance task rather than an
aspiration, and it is how the count of rules only a person can catch stays
visible and gets smaller.

This repository already works this way. `tests/theme-tokens.test.ts` refuses a
colour that is not a token, `tests/mcp-parity.test.ts` compares the two
transports service by service in both directions, `tests/security-header-parity.test.ts`
compares the Hono headers with the nginx ones character for character, and
`tests/nav-order.test.ts` pins an ordering somebody decided. The guides extend
that habit rather than introducing it.

## The set

| File | Governs |
| --- | --- |
| [`common.md`](common.md) | Money, dates, naming, errors, the glossary, prose. Cited by everything below. |
| [`web.md`](web.md) | The browser app: tokens, layout, forms, tables, charts, accessibility, copy. |
| [`mcp.md`](mcp.md) | The agent surface: tools, schemas, descriptions, errors, scope, context cost. |
| [`http.md`](http.md) | `/api/v1` as a public contract: resources, bodies, errors, pagination, versioning. |
| [`csv.md`](csv.md) | The import and export format, and what makes a round trip lossless. |
| [`operations.md`](operations.md) | Mail, configuration, and the container an operator runs. |
| [`writing.md`](writing.md) | Documentation, the changelog, decisions, the README. |
| [`code/`](code/index.md) | The source itself: eight guides, plus the toolchain the whole repository is checked with. |

Read `common.md` first. Most of what looks like an interface question turns out
to be a question about a value crossing a boundary, and those are answered once.

## Conformance targets

| Surface | Target |
| --- | --- |
| Web app | WCAG 2.2 level AA |
| HTTP API | RFC 9110 semantics, RFC 9457 problem details, RFC 3339 dates |
| MCP | Model Context Protocol, revision 2026-07-28 |
| CSV | RFC 4180, with the departures named in `csv.md` |
| Container | OCI image spec, non-root, read-only filesystem |

A target is a claim somebody can check, which is why each names a document
rather than an adjective.

## Changing a rule

Change it here, in one place, and change every file it governs in the same
commit. A standard that is true of half the product is not a standard, it is a
description of the half that was easiest.

Where a guide and `AGENTS.md` conflict, `AGENTS.md` wins and the guide records
the conflict rather than quietly losing it, with the reasoning beside it. Those
are the places where published best practice and this product's invariants
genuinely disagree, and leaving them unwritten would mean the next person
rediscovers the argument instead of reading its conclusion.
