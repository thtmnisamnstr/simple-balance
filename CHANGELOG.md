# Changelog

Notable changes, newest first.

## Unreleased

**This release upgrades cleanly from 0.1.5.** A deployment starts on the
configuration it already has, every path that answered still answers, and no
client loses a capability it had. Five changes in an earlier draft broke that
and were reverted to warnings, kept precedences and deprecated aliases;
`AGENTS.md` now carries the rule so the next release does not have to
rediscover it.

One change is a judgement call rather than a clean pass, and it is named here
rather than left to be discovered. Every MCP tool now declares a closed argument
object, where 57 of the 71 were open. An agent sending an argument nobody
declared used to have it dropped in silence and now gets an error naming it.
Nothing an agent could successfully do before is impossible now — the dropped
argument never had any effect — but a call that returned success will return a
failure, and that is worth knowing before upgrading. It is the whole point of
the change: an open object accepts a hallucinated argument, answers success, and
teaches the model that the argument works.


### Added

The application says what it is doing, in Prometheus' text format, at
`GET /metrics`. It is off until `METRICS_ENABLED=true`, and then it is
registered rather than refusing, so a deployment that never asked has no such
route at all. Both entrypoints answer: the API reports requests by route and
status, MCP tool calls by tool, ledger writes by kind, idempotent replays, its
connection pool and how long a transaction holds a connection; the scheduler
reports ticks, proposals, reminder sweeps and mail. `component="api"` or
`component="scheduler"` sits on every series, so a split deployment scrapes both
and the two never collide. Node's own heap, event-loop lag and garbage
collection come with it.

Nothing in a metric names a person. No label carries a user, an email, an
account or an amount, and a path with an id in it is counted under its route
pattern, so a ledger with ten thousand transactions is one time series rather
than ten thousand. What a scrape does say is how much a deployment is doing,
which is what `METRICS_TOKEN` is for: set it and the endpoint answers only a
request carrying `Authorization: Bearer`, leave it unset behind a private
network and a scraper needs no configuration at all. The bundled frontend does
not proxy `/metrics`, so the browser's own hostname never exposes it, and
turning it on in production without a token says so once in the log.

The Helm chart carries `config.metrics.enabled` and `secret.metricsToken`, and
`docs/deployment.md` has a scrape config for the two containers.

`LOG_LEVEL` now governs this product's own log lines. It reached exactly one
consumer before — Better Auth's logger — while the thirty-one `console` calls in
`src/server` ignored it, so a deployment asking for `error` still got the
startup banner, the mail notice and the scheduler's warnings. `error` is quiet
now, and is never itself silenced. The three places that warn about
configuration keep writing directly, because the gate has to read the
configuration to know the level and a warning about a setting cannot be gated by
one.


Seven secrets can be read from a file instead of the environment:
`AUTH_SECRET`, `DATABASE_URL`, `DIRECT_DATABASE_URL`, `SMTP_PASSWORD`,
`GOOGLE_CLIENT_SECRET`, `SETUP_TOKEN` and `METRICS_TOKEN`. Point `NAME_FILE` at a file whose contents are the value, and
the value never enters the process environment, so nothing that dumps an
environment can show it.

Set one of `NAME` and `NAME_FILE`. Both set is not an error — the environment
variable wins, which is what happened when `NAME_FILE` did nothing at all — but
it warns and names the file being ignored, because a change to that file will
look like it worked and will not have.

The bundled Helm chart and compose file still pass all seven as environment
variables; `docs/deployment.md` says what using the file form on either takes.

Budgets. A limit per category per period, compared against what was actually
spent, with nothing in it that writes a posting.

A budget is a standing instruction rather than a row per month. Both ends of its
window are snapped to the period, so any day inside a month names that whole
month and a budget set today applies today. One plan covers every period in its
window, so a budget that runs all year is one row and the
months nobody has reached yet are not materialised by anything. Setting an
amount for a single period overrides the plan for that period alone, and the
report says which of the two produced each figure. Windows for one category may
not overlap, which is what keeps last March answering with what last March
intended when the budget is raised in July.

A budget report shows whole periods. Every other report clips a bucket to the
range asked for, and a budget must not: a limit belongs to a whole period, so
weighing it against part of one reads as money still to spend when the month is
already overspent. A range chooses which periods to show. The period still
running is marked as such, because its spending is a total so far.

The comparison runs on the same `date_trunc` grid the reports bucket by, so a
limit and its spending cannot land on different months, and it joins from the
budget to the spending rather than the other way, so a category budgeted at two
hundred and spent nothing on reads as nought of two hundred instead of
disappearing. Splits attribute each leg to its own category and transfers
contribute nothing, both because legs are postings rather than because anything
special was written for them.

Deleting a budget leaves the books exactly as they were, because it never
touched them.

### Changed

A numeric setting outside its range says so at startup instead of falling back
in silence. `CSV_MAX_ROWS`, `CSV_MAX_BYTES`, `RECURRENCE_TICK_SECONDS`,
`RECURRENCE_CATCH_UP_LIMIT`, `RECURRENCE_CLAIM_LIMIT` and `DATABASE_POOL_SIZE`
are all read once as the process comes up, and one that cannot be used is named
in the log with the value it could not use and the number in force instead.

They still fall back. A deployment that meant `CSV_MAX_ROWS=1000` and typed
`1O00` was importing ten thousand rows and being told nothing, and the silence
was the defect — not the fallback. Refusing would have meant a typo in a tuning
knob taking a ledger offline, on a value the previous release accepted, and
nobody types a cap wrong and wants their accounts down for it.

`DATABASE_POOL_SIZE` used to refuse on its own and now falls back with the rest,
which accepts strictly more than before.

The scheduler container checks its mail server at startup, which the API already
did. It is the process that sends every reminder and proposal notice, and nobody
is waiting for one of those, so a relay refusing it failed silently and
indefinitely; it now logs the address it will be sending as, or logs the refusal
and goes on proposing. A scheduler with no mail configured says that in one line
too, because a container that was never handed the SMTP settings and one whose
relay answers look identical in a log that says nothing, and a split deployment
assembled by hand is exactly where that happens. Neither line stops it starting:
mail is optional and the schedule is not.

All four images now record the digest of the base they were built on, not only
its tag. `org.opencontainers.image.base.digest` sits beside `base.name`, and
every `FROM` naming a registry image is pinned by digest as well as tag, so the
build is reproducible and the label cannot name a base the image was not built
on. Dependabot watches the bases now, so a pin is raised deliberately rather
than freezing on whatever patches its base had the day it was typed. The runtime
stages still apply the distribution's own updates on every build, so pinned is
not the same as unpatched.

A refund now lowers the category it came back from, instead of raising income.

A deposit credits income and a withdrawal debits expense only when no category
contradicts it. A category whose kind runs against the direction makes the entry
a refund, and its other half posts to the counter-account the direction would
never have asked for. Thirty pounds back from the shop was previously refused
outright with "Choose an income category for a deposit", so there was no way to
enter one at all, and a spending figure could only ever go up.

A draft may say `categoryKind` alongside `categoryName`, which is how a refund
into a spending category that does not exist yet is recorded at all: without it
a deposit creates an income category and credits that, and the spending it was
reversing never moves. The transaction form asks the question whenever a name
with nothing behind it is typed — "money you earned" against "a refund of money
you spent" — and stays quiet when the category already exists or the picker is
empty, because there is nothing to decide. A CSV import that may only stage carries the same field
on the staged row, so the kind is the file's decision rather than whichever row
happened to commit first.

A CSV file's rows vote on the kind of a category the file creates: whichever
direction most of them run is what the category is, and a tie is spending. It
used to be created covering both directions when a file held a purchase and its
refund, which is the same defect one layer along, because a category covering
both agrees with whichever direction it is handed.

Naming a category rather than citing its id follows the same rule. A deposit
naming "Groceries" used to widen Groceries to cover both directions, and a
category covering both agrees with whichever direction it is handed, so the
refund credited income, the budget never moved, and every later refund into that
category was broken too. A category running against the direction is now kept as
it is, because that pairing is a reversal rather than an ambiguity. Two rows in
one CSV naming a category nobody has created yet still make one that covers
both, because there is no existing answer to preserve.

One entry may not name both an income and an expense category, because two
counter-accounts would be two movements and only one of them is the one somebody
entered. A bulk edit refuses to turn rows into refunds for the same reason it
refuses to flatten a split: not because it cannot be done, but because it cannot
be done to rows nobody looked at.

Nothing in the reports needed changing. Both counter-accounts already segment as
operating in the cash flow statement, and spending by category already sums
signed postings, so a refund lands correctly without any figure being taught
what a refund is.

Four API paths were renamed to the conventions the rest of them follow.
`POST /api/v1/accounts/{id}/archive` and `POST /api/v1/categories/{id}/archive`
are now `.../archived`, because they take `{"archived": boolean}` and that is a
state rather than a verb, the way `POST /api/v1/transactions/{id}/deleted`
already was. `POST /api/v1/staged-transactions/delete` is now
`.../bulk-delete`, which is how the same operation over committed transactions
has always been spelled; the two remain two routes, because one voids entries by
posting their reversal and the other removes rows that never posted.
`GET /api/v1/staged/{id}/duplicate` is now
`GET /api/v1/staged-transactions/{id}/duplicate`, since there is no `staged`
collection anywhere else. The MCP tools keep their names.

**All four old paths still answer**, on the same handlers, marked `Deprecation`
with a `Sunset` date. The first version of this renamed them outright, on the
argument that `/api/v1` is cookie-only and same-origin so the only client that
could be calling them ships in this image — which is true of this image and not
of the one already running. A browser tab left open across the upgrade is
serving the previous build, and would have met a 404 on the first archive
somebody attempted, with nothing to tell it apart from a bug.

Committing or deleting staged transactions now refuses a selection that leaves
out the version for one of its own rows, and says which row, instead of
reporting it as a version conflict on a row nothing had changed. A repeated id
in the same selection is refused as a duplicate rather than reported as a row
that could not be found. Over MCP both requests also refuse an unrecognised
field rather than dropping it — a body typing `expectedVersion` where the field
is `expectedVersions` is refused by name — and over HTTP they still drop it, as
they did in 0.1.5. Tightening the HTTP side was in an earlier draft of this
release and was taken back out: a client that has been sending a stray field
since 0.1.5 keeps working, and the release that refuses it is a later one.

Both discovery documents still advertise all seven scopes. An earlier draft of
this release narrowed the protected-resource document to
`openid profile email offline_access ledger:read`, on the argument that a client
builds its authorization request from that list and every scope in it is one
more thing somebody is asked to approve before there is anything to approve it
for. That argument still stands and the change does not: a client that read the
document under 0.1.5 and asked for `ledger:write` would have found the scope it
already holds missing from the list it builds its request from, which is a
capability narrowing on an upgrade. It comes back in a release that can
deprecate it first.

A version conflict reaching an agent now says to read the record again and retry
with the version it reports, rather than to refresh and try again. An agent has
nothing to refresh. The browser keeps its own wording, and the two sentences say
the same thing happened.

The repository documents how it is written, in two sets under `docs/standards/`.
One describes the interfaces — the browser app, the MCP surface, the HTTP API,
the CSV format and the container — and the other the source. Every rule in the
second says who enforces it: the compiler, the linter, a named test, or nobody
at all, and the rules in that last group are counted on the index page so the
number is visible and can be argued down. Seven of them became tests in the pass
that followed writing them.

`npm run lint` runs oxlint and `npm run format` runs oxfmt, in place of ESLint
and Prettier. TypeScript 7 forced the linter question — typescript-eslint does
not run on it — and the formatter was measured rather than assumed: oxfmt
reflowed no comment prose in a repository whose comments were 14.9% of its
non-blank source lines at the time, and are 17.1% now. Neither is visible in the
running application. Adopting the formatter reformatted the tree once, and two
Pulumi deployment files are nothing but that reflow; no other file changed shape
without a reason beside it.

### Fixed

The list of dates on a recurrence form could go on describing a schedule that
was no longer on screen. It walked the rule the parser produced while its
dependency array named the raw fields, and those are not the same set: an
interval of 0 and a blank one both read as no usable number to the fields, and
only the blank one parses, so typing over either with the other left whichever
list was already showing. Both previews are worked out during render now, five
dates being cheaper than the comparison that was avoiding them.

Merging two categories moves the budgets onto the target instead of destroying
them with the source row, and refuses when both are budgeted for the same period
rather than picking a winner. Same failure as the prune below, one door along.

A category is no longer tidied away underneath a budget. Moving the last
transaction off a category prunes it, which is right, and the composite foreign
key then took its budgets with it, which is not: the docstring on that prune
already promised that "a category held only by a standing instruction is held
all the same", and a budget is exactly that. Asking to delete a category still
takes its budgets, because that is a decision somebody made and the story says
a budget is never a reason to refuse one.

Creates that write no postings no longer claim to need an idempotency key they
never had. `AGENTS.md` said every create required one and four of the six did
not, which described the code as broken rather than describing what it does: a
record somebody names is protected by its name being unique, so a second submit
fails instead of duplicating. Only creates that write postings, which have no
natural key, need the key.

## 0.1.5 - 2026-08-22

### Added

A dark theme, and a light one, either chosen or left to the machine.

The default is to follow the machine, and that is a standing instruction rather
than a value somebody was assigned: it keeps following, so a screen that goes dark
in the evening takes the app with it. Nothing detects the setting once and stores
the answer, which sounds like the same thing and is not. A stored answer cannot be
told apart from a decision, so the app could either follow the machine or remember
a choice, never both — and the mechanism that would have written it only fires for
an account that has never chosen anything, which no existing account qualifies as,
because saving a timezone counts. Every one of them would have upgraded into a
light app on a dark machine.

So there are three states, not two. Light and Dark stay where you put them.
Follow my system is the default and is the media query, which means it is right on
the first paint with no JavaScript at all. The choice is on the account rather than
in the browser, so it travels to another device, and a `theme` column defaulting to
`system` lands every existing account on the honest answer with no backfill to
guess at.

The moon in the sidebar switches it, next to Sign out — the only part of the shell
that already holds controls about this session rather than about the ledger. It is
a plain button that says what it will do, not a switch reporting what is on: a
two-state control cannot honestly report a three-valued setting. Pressing it while
the setting is Follow my system resolves the machine and sets the opposite
explicitly. Settings has the three-way choice, applying as you pick it rather than
on a Save button, because it is the one preference whose result is visible while
you are choosing it and two controls for one value must not be able to disagree.

Painting it before the page paints took a file rather than the usual inline script,
because the Content-Security-Policy here is `script-src 'self'` with no nonce and
no hash. An inline script would have been refused, reported nowhere — nothing
declares a report endpoint — and would have looked perfect locally, since neither
dev server applies the policy and one of them never serves the shell at all. It
would have reached a release as a flash of the wrong theme on every load.

The stylesheet had one palette written into it in 189 places. It now has two, in
one place each: 57 tokens, every one declared in both themes, with a test that
fails on a colour written anywhere else and on a token given a value in only one
theme — which is the bug that makes half an app unreadable while looking fine to
whoever wrote it. Four literals turned out to be two colours sharing a spelling:
white is both a card and the text on a green button, and only one of those is
still white in the dark. The same split runs through the accent, where the green
that reads as a link is not the green a button is filled with, and in dark the
first has to lift while the second stays dark enough to carry white.

Three repairs to the light theme came out of writing the second one down. Six
greys carrying real text were under the contrast a person needs, the input
placeholder worst at 2.65:1. An input's border was 1.39:1 against the field it
edges, which is not a boundary — and an input here is white on a white card, so
that border is the only thing saying where the field is. It holds 3:1 now, and a
focused field is darker again rather than only greener, which is what it had
briefly become once the resting edge moved up to meet it. And the focus ring took
its contrast from whatever happened to be behind it, because it was
semi-transparent; it is opaque now.

The report palette was worse than it looked. Under simulated deuteranopia its
green and its pink were 1.78 apart as CIEDE2000 measures it, which is to say they
were the same colour, and that shipped in 0.1.4 when six colours became ten. The
two palettes now reach 5.6 and 4.7 by keeping each slot's hue family across both
themes and varying lightness, which is the channel that survives. An honest limit
on that: ten categorical colours cannot all be told apart by somebody with
dichromatic vision, and a search that held hue identity and the contrast a line
needs could not beat about 7 and 4. The remedy is a second channel that is not
colour, which is a change to the charts rather than to the palette. Until then the
legend and the table under every chart carry identity, and both are always there.

Emailed notifications, on a schedule, in two kinds.

A recurrence can say to write when it proposes. One message per proposal however
many rows it holds, naming the dates and pointing at Staged transactions, sent to
the address on the account. It says nothing on a tick that proposes nothing, so a
schedule that has caught up goes quiet rather than arriving every five minutes.
The Recurring list says which recurrences are set to send one.

A template can carry a reminder, which is the other half of the same idea: a
template is filled in by hand, so nothing can make it for you, but something can
tell you it is the day. Once on a date, or repeating on the same schedules a
recurrence offers, and either way at a time of day — the first thing here that
needs more than a date, and it is read on the person's own clock rather than the
server's. The Templates list says which templates have one and whether it
repeats.

A reminder that happens once is a first-class answer rather than a yearly rule
nobody means: its frequency is null, and it refuses the interval and the policies
a repeating rule needs rather than storing leftovers of them. Once sent it says
so and the scheduler stops looking at it.

Both ride the recurrence scheduler's existing tick rather than a loop of their
own, and a backlog collapses into one message: coming back from a week of
downtime brings one reminder, not seven. Neither can be delivered without
`SMTP_HOST` and `MAIL_FROM`, and the form says so rather than accepting a setting
that would quietly never fire.

Reports. Six of them, over one date range, per currency and never added across
currencies: net worth and a balance sheet for what the accounts hold, income
against expense and categories for what moved, a cash flow statement for where
the money that can be spent came from and went to, and a trial balance that
totals zero when the books are whole. Each is a preset over one query that
differs by which accounts it reads, whether it reports a period's movement or
the balance it ends on, and how time is bucketed — weekly, monthly, quarterly,
yearly, or not at all. Reachable at `/reports` and over MCP as `get_report`.

The category report covers income as well as expense. Spending by category on
the dashboard answers only where money went, and the same question about money
arriving had no answer.

A per-account register: every posting in date order with the balance before and
after it, and the balance the window opens and closes on. It is for finding
mistakes rather than for analysis — where a balance goes wrong, this is the row
it went wrong on. An archived account ends at zero with the postings that closed
it out to equity still in the list. On the account page behind **Show register**,
fetched only when asked for so the ordinary visit costs nothing, and
`get_account_register` over MCP.

`whoami` says whether this deployment can send mail at all. A reminder is stored
whether or not it can, so an agent could set one up and had no way to tell
somebody it would never arrive.

The Reminder and Notifies columns sort, ranked by what they are going to tell
you rather than alphabetically by the badge text: a reminder still to come above
one already sent above none at all.

The reminder section of the template form is laid out like the schedule section
of the recurrence form, which is the same kind of thing and did not look like it.
It was a bare fieldset, so it took the browser's own `padding-inline` and its
heading sat indented from every other label on the screen, with eleven controls
stacked against each other for want of a gap. It is the same card now, with the
same small-caps heading, and it ends the way schedule ends: with the next five
dates it will actually send on, and the time each goes at. The note explaining
what a reminder does moved up under the checkbox it explains, from the bottom
where it read as a footnote to the weekend policy.

The notifications section of the recurrence form had the same bare fieldset, one
section below the schedule it was supposed to match. And the template form's
description field was half a row wide, alone inside a two-column grid.

Axes on the report charts, which shipped without any. A line that ended higher
than it started was all either chart actually said: there was no value scale
beside it and no date under it, only a caption naming the range. Both now carry
gridlines on round numbers — worked out in scaled integers, so a tick sits
exactly where its own label says it does — and the dates of the periods they
cover, written as that period is named rather than as a full date, so a year of
months fits.

The axis text is HTML rather than drawn into the SVG. The drawing scales to its
panel, so a label inside it would read as twelve pixels wide on a desktop and
four on a phone, which is an axis nobody can read on the device most likely to
need one. How many dates fit comes from measuring the chart rather than from a
breakpoint, because the same chart is wide on the reports page and narrow in a
card at the same viewport.

Reports sits after Recurring in the sidebar rather than after Transactions. The
sidebar reads in order: where the money is and what moved it, then the work
waiting on you, then the things that file and repeat it, then what it all adds up
to. A test holds the order, because an ordering nothing asserts is one a later
edit reorders by accident.

Each account on the overview opens that account. The whole row rather than the
name, because the balance is what somebody is looking at when they decide to go
in, and the date range travels with them, so the account page opens on the
period they were reading.

The cash flow statement will not agree with income and expense, and the gap is
widest for whoever uses a credit card most: a purchase is an expense the day the
card is swiped, while the cash leaves when the bill is paid, in a different
period and as borrowing rather than spending. Both figures are right. The report
says so on the page rather than leaving it to be discovered.

Staged transactions finds a row that repeats something already recorded,
not just one that repeats another row still waiting. The check it had wanted the
same day and the same payee, which a real import has neither of: the bank posts
when it settles and names the merchant its own way. So the amount is the anchor
now, with the account and the direction to keep two unrelated spends of the same
size apart, and three days of latitude on the date. Payee and category are
ignored, being the two most likely to differ between a bank's record of a
purchase and yours. The same `duplicate` filter finds all of it.

That looser test is advisory. What refuses a commit is unchanged and still
strict, because loosening it would start turning down two genuine coffees bought
on one card in one week.

A run through every flagged row, from **Review N possible duplicates** at the
top of Staged transactions. Each comparison says which one of how many it is and
carries Previous and Next, and dropping a copy lands on the next pair rather than
back at the list, so a dozen duplicates are a dozen decisions instead of a dozen
round trips through the queue to find the next badge. The badge on a single row
still opens that pair directly.

A side-by-side review, reached from the badge on any flagged row. Both records
are open to edit and each saves on its own; a staged row saves rather than
commits. The one already in the books sits second — on the right, or underneath
on a phone — and where both are staged the older one does. Only a staged side
can be dropped, because the way out of a duplicate is to remove the copy that
has not been recorded yet. It is not a diff: the fields that differ are the ones
that always differ, and colouring them says nothing a person reading two
transactions cannot already see.

### Changed

How this describes itself. Every page inside the app already spoke plainly —
"Where your money sits and how it moved", "Everything you track, from checking
and cards to cash and crypto wallets", "Rows waiting on you" — and the marketing
copy was the one place that talked like a spec sheet. It led with the automation,
then with double-entry, then with privacy, none of which is what somebody wants
from a personal accounting app; they are how it delivers what somebody wants.

So the front page, the manifest, the container label and the sign-in screen all
lead with what you get: where your money is and where it went, every account in
one place, statements that file themselves, bills you set up once, reports that
add up. The double-entry books and the MCP server follow as the reasons those
things can be relied on — which is the honest ordering, since the books are what
the agents are being careful with. The Helm chart's own description and the
scheduler image's label had been left on the old framing and now match: those are
what `helm search` and a registry listing show, so they are the front page for
anybody who arrives that way.

The queue in front of the books is called Staged transactions, everywhere. Twenty
places in the app called it "the review queue" instead, which is what it is and
has never been what it is called — so a recurrence promising to propose "into the
review queue" was naming a screen that is not in the sidebar under that name, and
a person who went looking for it would not find it. The name is used wherever
somebody has to go and find it, including the notification mail's subject line;
the description is kept where the sentence is explaining what the screen is for.
One verb phrase covers it throughout — a recurrence adds a row to Staged
transactions — rather than five ways of saying the same thing. The two dialogs on
the page itself say "the queue", because you are already standing on it, and the
consent screen describes what the agent can do rather than where the rows land,
which is what the three scopes beside it do.

An idempotency key means the same thing over MCP as it does over the HTTP API.
Ten MCP writes kept a replay record of their own on top of the one the service
they call already keeps, and the two matched a retry differently: the outer one
against the request as it arrived, the inner against what the service had
normalised. A retry of a mass edit that listed the same rows in a different
order was a different request to one and the same request to the other. They
call their service directly now. Records already written are inert, and no key
in an existing database loses its replay.

`set_preferences` no longer advertises a call it refuses. Every field of the
patch is optional, so an agent reading the schema was told that sending nothing
but an idempotency key was valid, and found out otherwise at runtime.

`create_transaction` says that a near-identical entry is refused and what
`allowDuplicate` is for. Both mass edits say that one split anywhere in a
selection refuses a category or type change for the whole call.

`list_payees` described itself as returning canonical payee names. It returns
every stored spelling, one row each, which is the opposite and the reason
`list_duplicate_payees` exists. Both now say which question they answer.

Recurrences report their shape over MCP. `get_recurrence` and
`list_recurrences` declared it as an unknown value, so the one thing an agent
reads a recurrence for was the one thing the tools would not describe.

Recategorising the last transaction off a category removes that category. Only
what an edit moved off is considered, so one made ahead of time and standing
empty on purpose is left alone, and anything a recurrence or a template still
names is kept — neither holds a foreign key, so nothing else would stop the
delete and what would be left is a standing instruction naming a category that
is gone. A queue-scoped agent edits the row and leaves the category, on the same
rule that stops it creating one.

Payees needed no such change and got none. Every list of them is a group-by over
the rows that name them, so a payee nothing references has already stopped
existing.

### Fixed

The keyboard could not work the choices these forms offer. Six sets of radio
buttons had no shared `name`, which is the attribute that makes a set of radios
one group rather than several unrelated controls — so the arrow keys did nothing
and every option was its own tab stop, putting four presses between a four-option
group and the field after it. React enforces one-of-many through its own state
regardless, which is why it survived: it looked right, it clicked right, and only
the keyboard was wrong. The names are per instance now, so two of the same form on
one page do not share a group and clear each other.

The three transaction type grids are one control, and it now does what it always
claimed. All three declared themselves radio groups with radio children and
implemented none of what that promises, so a screen reader was told to expect a
keyboard interface that was not there. The group is one tab stop, the arrows move
the choice and wrap, and Home and End go to the ends. One of the three was not a
radio group at all: on a template, clicking the chosen type again is how somebody
says there is no type, and a radio has no way to become unset — that one says what
it is, a set of toggles.

Filtering Staged transactions by a payee could return nothing at all. The
comparison folds Unicode presentation forms on the way in — that is what makes
"ﬁ" and "fi" the same payee everywhere else — and this one place did not, so a
payee holding a ligature or a full-width letter never matched anything and the
queue came back empty rather than saying why. The rule is now spelled the same
way in all six places it appears in SQL, and a test fails when they diverge,
because a spelling that differs does not raise: it silently fails to match.

Merging payees left a staged row's fingerprint describing the payee it used to
have. The queue flags a row as repeating another by comparing those fingerprints,
so two rows that had just been made identical stopped being reported as repeats
of each other. Rows keyed on a bank's own reference were never affected, which is
why this was easy to miss.

Resolving a payee to the spelling the ledger already keeps stopped reading the
whole ledger. It runs on every single transaction write, and the expression it
matched on — the same Unicode folding as above — was one no index could serve, so
each save scanned the account's own rows. Both sides of it are indexed now: on
five thousand transactions that is 6.3ms and two hundred buffers becoming 0.02ms
and three.

Staged transactions died on a single row it exists to show. A draft date matching
the shape of a date but naming no real day — `2026-02-30`, `2026-13-01` — was
accepted, filed with a "Date is not valid" issue, and from then on every attempt
to list the queue failed on the cast. The queue was the only place that row could
be seen, so the only cure was deleting it by an id nothing would show you. The
guard now asks what validation already decided instead of trying to out-guess the
calendar. The amount guard had the same hole with no bound on length, where a
draft of two hundred thousand digits overflowed `numeric` and took the default
sort down with it; both now hold to the shape the domain accepts.

Two answers to what day it is. PostgreSQL reads a bare offset timezone with the
POSIX sign convention and `Intl` reads it as ISO, so for anyone whose stored
timezone was an offset rather than a zone name the two disagreed by sixteen
hours. An account archived in that window closed on a day the dashboard had not
reached, and its balance was left out of the headline total while the ledger went
on counting it. One implementation now answers the question, and PostgreSQL is
not asked.

Net worth and the balance sheet took an archived account's history away along
with the account. Excluding it dropped it from every bucket, including the months
it was open and holding money, so a monthly chart lost history it had reported
correctly the day before. Archiving posts the balance out to equity, which is
what carries the account to zero on the day it closed; the row is kept and hidden
only when it is flat at zero across the whole window. So on those two reports
`includeArchived` no longer changes a figure, only which rows are listed, and
each row now carries `archived` — a closed account's past would otherwise read as
money still sitting in the live ones. A currency with nothing left to list is
left out rather than returned as an empty section.

A payee-sorted list paged with a cursor could skip rows or never end. The
ordering was `lower()` in the database and `toLowerCase()` in JavaScript, and
those are different functions — they disagree on a Turkish dotted capital and on
a final sigma, and whether they disagree at all depends on the database's
collation. The cursor now carries the value the database sorted on.

The categories report added income to expenses and headed the answer "Net". Each
row is a magnitude there, on purpose, so the column sum is a total filed rather
than a net, and it says so. The trailing column of a running-balance report is
headed "Closing" rather than "Total", because that is what it holds.

The same report showed one name twice with no way to tell the rows apart. A
category set to cover both sides is two rows there, correctly — one for what came
in under it, one for what went out — and Uncategorized always is. Only a name
that really does span both sides is qualified now; every other row reads as the
person wrote it.

A report chart had six colours and no limit on how many rows it would draw, so a
seventh account shared the first account's line and the legend said two things at
once. There are ten, and a test fails if the stylesheet and the code disagree
about how many.

Every badge in a transaction row sat on a line of its own, doubling the row's
height. The class holding the payee beside it had never been defined in the
stylesheet. Six other class names in the browser named nothing at all and are
gone.

The audit log recorded a template's reminder as having never existed. Three of
the five paths that write a snapshot took a default of null, and in an
append-only record null does not read as "nobody asked" — it reads as "there was
no reminder". A bulk edit therefore claimed to have removed one, and both delete
paths recorded the reminder as never having been there.

A template saved again re-sent a reminder that had already gone. The row is
replaced whole, so an edit to the payee replaced the watermark with it and the
reminder was owed again. A schedule that really did change still starts afresh,
which is what somebody moving the date is asking for.

The rows waiting above a committed list were not narrowed by the filters the
list was. On a category, payee or template page the two read as one list, so
choosing a type or typing into the search box moved the committed rows and left
the staged ones standing above a list they had just been excluded from.

The register's link on each posting carried a parameter no list in the product
accepts, so it was dropped and the row landed on the whole unfiltered
transactions list. It narrows by account and that one day now.

The application shell described the product differently from the manifest the
release publishes, and coloured a phone's browser chrome near-black on a
stylesheet that commits to a light scheme.

A staged mass edit left behind a category the identical edit, done one row at a
time, would have cleared. The committed side had the same split and was fixed in
this cycle; the queue had it too. A caller holding only `ledger:stage` still
leaves the category standing, on the rule that a queue token proposes and never
decides.

The reminder sweep claimed rows on a deployment with no mail server. Every claim
advanced a watermark past an occurrence nobody was told about, so configuring
SMTP a month later would have found a schedule that had quietly eaten its own
backlog — the opposite of what the form promises. It leaves before claiming
anything now.

The split deployment served the one document that runs the app without seven of
the headers every other response on the origin carries, including both
`Cross-Origin-*` policies. nginx repeats the whole set now, the list lives in one
place, and a test runs a real response through the middleware and fails if the
two differ by a header or a value. `X-Frame-Options` is `DENY` on both, rather
than Hono's `SAMEORIGIN` contradicting the `frame-ancestors 'none'` beside it.

The generated first-run setup code belonged to one process. On a web tier running
more than one replica — which the chart does by default — the code printed in the
log was rejected by every other pod, so the claim the chart's own notes describe
failed about half the time. It is stored now, like the MCP signing key, so every
replica agrees on it. An operator-chosen `SETUP_TOKEN` still never touches the
database, and Pulumi can supply one, which it could not before.

Validating a staged draft opened a ledger account. Preparation is meant to answer
whether a draft would balance and nothing else, so an agent holding only
`ledger:stage` — the posture that is supposed to be unable to touch the books —
added a counter-account and a new zero row to the trial balance. It looks the
account up now and stands one in when there is none.

Smaller ones. A malformed request body answered 500 with a stack trace instead of
400. A mistyped `/api/v1` path, and any with a trailing slash, came back as the
application shell with a 200. Responses carrying a session token had no
`Cache-Control`. A broken consent cookie 500ed. An `APP_BASE_URL` that was not a
URL, and every strict scalar setting, refused to start without saying which
variable was wrong. A register window opening after today summed future postings
into a balance labelled as of today. The cash flow statement read every posting
in the ledger to answer about one month, at eight times the cost. A failed report
also told a full ledger it was empty, and reports could show figures from before
an edit. The recurring list ordered amounts as text, so 1.50 sorted below 1.45.
One search box had no accessible name.

A table wider than the panel holding it spilled past the edge instead of
scrolling inside it, so the far columns could not be reached at all. The
templates and recurrences pages both wrapped their table in `table-wrap`, a
class nothing in the stylesheet ever defined, and had done since they shipped.
The rule exists now, and a test names any table left without a wrapper that
scrolls.

Cash flow, income and expense, and spending by category asked whether each entry
still runs through an archived account once per posting rather than once per
query. On a ledger of a hundred thousand postings the dashboard's own cash flow
ran that subquery twenty-eight thousand times, reading a hundred and seventy
thousand buffers to produce two rows. The same rule is now one aggregate the
planner turns into a hash anti-join: sixty times fewer buffers and seven times
faster, with the netting that decides membership unchanged.

A duplicate payee group offers the spelling the ledger would itself keep. The
group was ordered by how often each spelling is used and then by name, while a
write reusing a payee breaks a tie by preferring a name already equal to its own
cleaned form. So three equally used spellings of one shop offered
`" ACME MARKET "` as the one to merge into, where the ledger would have kept
`"Acme Market"`. Both the browser and the MCP guide say the first entry is the
target, so this was the wrong answer rather than a cosmetic ordering. One rule
now, used by the group and by the write.

Sorting Staged transactions by amount could fail on a row whose amount a CSV left
unreadable. The guard meant to catch that admitted anything with a digit either
side of any character, so `42x50` passed it and then raised on the cast — a
backslash lost to a template literal, in a regex that has been there since the
column was sortable.

The recurrence form's preview test asserted a date that has now gone by, and
would have failed from here on whatever anybody changed.

### Internal

Gates that could not fail. The PostgreSQL job would have gone green having
skipped every integration file if it ever lost its database URL, and nothing
asserted otherwise. The chart's negative gate checked that a render failed
without checking why, so deleting the guard under test still read as "refused".
The NetworkPolicy template was never rendered at all, being off at default
values. A release resolved its tag twice, so a tag moved mid-run could verify one
commit and publish another; it resolves to a commit once now. A dispatched
re-publish inferred that an unsuffixed version was final and moved `latest` on to
a release marked as a prerelease — it asks instead. Two tags could publish at
once and race for `latest`. And no test covered the chart's `appVersion`, the one
version location whose drift installs the previous release's images.

A refused second Ralph run deleted the lock the first one was holding, because
the lock was named before it was taken, leaving a third free to start alongside
the first. The git guard's config scan missed git's one-line
`[section] key = value` form, catching the same key only when written underneath.
`set-version` did not know about the Pulumi project's manifests. They happen to
be current, because the version they were added at is still the version — but
nothing in the root install or the root verify reads them, so nothing would have
said otherwise.

Thirteen schemas in the shared contracts no longer carry an export nothing
outside the file used. Six types the browser had hand-written copies of are
re-exported from the contracts they duplicated.

CI starts the frontend image rather than only building it. Its nginx
configuration is a template the entrypoint renders at startup, so a malformed
`add_header` — or a location-scoped directive in an include the main config
pulls into `http{}` — is a startup error a build never sees, and it would have
reached a release. The shell and a hashed asset are both asked for, because
nginx drops inherited `add_header` from any level with one of its own.

The two lockfiles are held to the same resolved versions rather than only the
same ranges, so installing in one and not the other cannot ship an image running
a version the suite never saw.

`clockTimeIn` had no test. It is what decides whether a reminder goes out at the
hour somebody asked for, by string comparison against a stored `HH:MM`. Covered
now, along with a bare offset read as ISO rather than POSIX, both ends of the
date line, both daylight-saving boundaries, and an unreadable timezone falling
back to UTC rather than throwing inside a loop that serves every tenant.

Both `.env.example` files and the chart's values said a mail server buys a
password reset and address confirmation. It also decides whether any scheduled
reminder is ever delivered, which was in none of them.

`set-version` now rewrites the example image tags in the split-deployment
compose file and the Pulumi README. Six tags a release would have left pinned to
the previous version, on the two pages somebody copies from.

Four indexes are dropped whose leading column another unique constraint on the
same table already leads with. No query loses a plan; four tables stop
maintaining a second copy of their own first column.

Money arithmetic moved out of `components.tsx` into `money.ts`. It was three
hundred lines of exact decimal comparison filed under a name that says React
component, which is not where anybody looks for arithmetic. Two report suites
compared money by casting it to a double, which is the mistake the house rule
exists to forbid, and two brute-force property tests had unbounded scan loops:
an implementation that stopped advancing would have hung the file rather than
failing it.

The README is half the length. Everything it said about how each feature works
moved to a guide of its own, so the front page answers what this is, what is
good about it, and how to start, and the walkthrough is one link away rather
than a hundred and fifty lines down. The architecture notes now cover the mail
half of the scheduler, which had shipped undocumented.

## 0.1.4 - 2026-08-14

### Added

Recurring transactions. Rent, a salary, a subscription: anything that arrives on
a schedule can be set up once and left. Daily, weekly, monthly or yearly, every
N of those, on a day of the month or on a relative day such as the second
Tuesday or the last Friday. You choose what a schedule anchored to the 31st does
in February, and what happens when a date lands on a weekend.

On each due date it puts an ordinary row in the review queue, dated its own
occurrence rather than the day the scheduler ran, and posts nothing. Leave the
amount out and each proposal waits in the queue for a number, which is what the
electricity bill wants. A recurrence naming an account that has since been
deleted still proposes its row, flagged and saying which field, rather than
failing where nobody would see it. Deleting a recurrence leaves every row it
proposed alone.

Open the menu on any row, on the transactions list or the review queue, and save
it as a recurring transaction, beside where you would save it as a template. The
row fills the form in, and the date it fell on becomes the day of the month the
schedule keeps to, rather than whatever today happens to be. What it does not
carry is the reference it was imported under, for the reason a template does not
carry one: on every proposal, it would make the next real import of that
statement row look like one already seen. Two accounts in different currencies
say so before you save, since the rate belongs to the day it was got and each
proposal has to wait in the queue for it.

The scheduler runs inside the server process and is on by default, so the
documented single container keeps working with nothing added to it. Set
`RECURRENCE_SCHEDULER=false` to switch it off on replicas that serve the API.
Running several with it on is safe: each recurrence is claimed with `for update
skip locked`, so replicas divide the due list rather than wait on one another,
and a per-occurrence unique key refuses a duplicate proposal even if a claim
were bypassed. Public holidays are not modelled; a business day means Monday to
Friday.

Four settings control it: `RECURRENCE_SCHEDULER`, `RECURRENCE_TICK_SECONDS`,
`RECURRENCE_CATCH_UP_LIMIT` and `RECURRENCE_CLAIM_LIMIT`. Only the first is
likely to matter to you, and only if you split the deployment up.

A Helm chart under `deploy/helm/`, a compose file that runs the same split on
one machine under `deploy/compose/`, and Pulumi programs for EKS and GKE under
`deploy/pulumi/`. All three tiers autoscale. The chart provisions no database:
raising a PostgreSQL StatefulSet's replica count gives you empty databases
rather than capacity, so it takes a `DATABASE_URL` and leaves the database to
you.

Set `DIRECT_DATABASE_URL` when PgBouncer or another transaction pooler sits in
front of PostgreSQL. Every lock the ledger takes is transaction-scoped and suits
transaction pooling exactly; the two that are not, the migration lock and the
first-account claim, use this string to go past the pooler.

Three Dockerfiles under `deploy/docker/` split the single container into a
server, an nginx frontend, and a scheduler, for running this under Kubernetes.
Each publishes alongside the single container, on the same tags, as
`simple-balance-server`, `simple-balance-frontend` and
`simple-balance-scheduler`. The single container remains the supported way to
run this. See [deployment](docs/deployment.md).

One transaction can now be split across several categories. The grocery receipt
that is partly food, partly household and partly something for the dog is one
entry with three legs, and each leg is attributed to its own category in
spending reports, on category pages, and over the MCP.

A split is the counter-account side of the entry cut into pieces rather than a
second record of the money, so nothing is counted twice: the categories add up
to exactly the cash that left the account. Every existing rule holds unchanged.
The entry still settles to zero in each currency it touches, postings are still
append-only, a correction still costs the difference and nothing more, and
deleting still voids the entry a leg at a time.

Relabelling a leg writes no postings at all, because the label lives on the leg
and the leg's identity does not change when you rename what it is for. Changing
what a leg is worth writes two, which is right: the money was divided
differently.

Splits work on committed transactions, on rows waiting in the staging queue, and
on templates, where the categories are stored and the amounts left for you to
fill in. A CSV export carries a split by category name and reads back as the
same split in a different ledger or a fresh install. Mass editing category or
type is refused on a split rather than flattening it, and the panel says why.

Upgrading runs three new migrations: 0005 for splits, 0006 for recurrences and
0007 for the shared sign-in attempt table. All three are schema changes rather
than data migrations: nothing existing is rewritten, no row is backfilled, and
every figure reads the same the moment they finish.

### Changed

The licence is now the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`), where it was the LGPL. What changes for somebody running this
is nothing: self-hosting it for yourself, your household or your company was
free before and is free now. What section 13 adds is that offering a *modified*
version to people over a network entitles those people to that version's source.

Every release up to and including 0.1.3 was published under the LGPL and remains
available under it. This applies from 0.1.4 onward.

The AGPL is a complete licence rather than a set of permissions layered on the
GPL, so the images carry one licence file where they used to carry two, and
`COPYING` is gone.

### Security

`NODE_ENV` was compared against one string, so any other spelling, and leaving
it unset, read as development: no first-run setup code, no sign-in rate
limiting, no secure cookies, and nothing to say it had happened. It is parsed
against a closed set now, and a process outside production that has been given a
real `APP_BASE_URL` refuses to start rather than warning about it.

`AUTH_SECRET` clearing 32 characters said nothing about whether it was secret.
The value this project falls back to outside production and the one
`.env.example` carried both cleared it, so a deployment could sign every session
with a published string. Production names and refuses them, and the example file
now ships no placeholder to leave in place. If you copied that line, generate a
real one: `openssl rand -base64 32`.

The agent consent screen read the client name and the scopes it displayed out of
the query string, which is written by whoever wants the grant. A link could show
a familiar client and read-only access while approving a stored request for
something else. Both now come from the record the consent code names.

Guessing the first-run setup code cost nothing: a wrong one was refused before
the rate limiter ever saw the attempt. Attempts are counted per caller now, five
to a fifteen-minute window.

Adding a sign-in password to an account that has only ever used Google took a
session and nothing else, so a borrowed cookie could mint a second permanent
credential in silence. It now needs a session created in the last fifteen
minutes.

Changing or resetting your password revokes every agent's access along with the
approvals behind it. Before, an MCP token an agent already held kept working for
its hour and its refresh token kept minting replacements for a week.

Sign-in attempts were counted in the process, which bounds nothing once more
than one is serving: each replica kept its own tally, so the allowance was
multiplied by the replica count and a guesser only had to spread their attempts.
Both counters, the sign-in one and the first-run setup code, are counted in
PostgreSQL now. A tally in the process still refuses a caller already over the
allowance without asking the database, so a flood does not become a write storm.

Dynamic MCP client registration is unauthenticated and was minting a client
secret for whoever asked, then storing it in the clear. The
`storeClientSecret: "hashed"` setting never reached it: that one belongs to the
OIDC provider's own register endpoint, and discovery advertises a different one.
Clients register as public now. PKCE was already required and plain challenges
already refused, which is what binds a code to its caller.

`stage_csv` created categories, brought archived ones back, and widened what
kind of entry a category may carry, all under `ledger:stage` — the scope for an
agent that may propose and never decide. Those three need `ledger:write` now;
with only staging authority the row is staged under the category's name and
committing it is what makes the category.

The MCP access token carried the opaque grant token as a readable claim. A JWT
is signed and not encrypted, so a proxy or a log holding one held a credential
good for seven days. It names the grant by row id now, which opens nothing on
its own, and a revoked grant stops working immediately rather than at expiry.

The frontend container served the application shell with no content security
policy, no `nosniff` and no framing policy, because those headers are set by the
API process the static files never reach. It also appended to `X-Forwarded-For`
rather than replacing it, against the trust model its own deployment guide
documents, so with `TRUST_PROXY=true` sign-in attempts counted against an
address the caller chose.

Signing in returned to the path in the address bar unfiltered, and
`//elsewhere.example` is a legal path that a browser sends to another origin.

### Fixed

A staged split can now be found under a category one of its legs names. The
queue's filter read only the entry's own category, so a split showed in the
count on the category page and then was missing from the list that count links
to.

Merging a category carries recurring transactions through with everything else,
and deleting one now counts them as a use rather than destroying the category
underneath them. Deleting your whole account also names the recurring
transactions it is about to take.

A stored timezone that has stopped being recognisable, after an ICU update or a
hand-edited row, no longer throws when the dashboard works out what day it is.
It falls back to UTC. The value is free text checked only when it was written,
and the scheduler now reads it in a loop that serves everybody, where one bad
row must not be able to stop the rest.

Deleting a category a template refers to, or an account a recurring transaction
names, is refused rather than leaving a template that cannot be saved or a
schedule that proposes a flagged row every month with nothing saying why.
Neither reference has a foreign key, because both live inside JSON.

The audit trail records a split's legs. Relabelling one is a single update to
the leg: it writes no posting and changes no column on the transaction, so
Activity showed a before and after that were identical for the change most worth
looking up later.

A mass edit no longer drops the record of which template a transaction was
started from.

A search containing `%` or `_` searches for those characters instead of treating
them as wildcards, and the search box waits for you to stop typing rather than
querying the ledger on every keystroke.

The review queue shows a staged row's category even when that category has since
been archived, instead of rendering it as Uncategorized with a blank field in
its editor.

One import stages at most what one action can then commit, edit or delete. The
CSV row limit was 25,000 by default and up to a million, while every mass action
caps at 10,000, so a large import produced a queue nothing could clear in one
go. `CSV_MAX_ROWS` now defaults to 10,000 and cannot be set above it. Lowering
it still works.

"Select all filtered" on a mass edit or delete is refused past 10,000 rows in
the database rather than after every matching row has been read and
fingerprinted in memory, and the CSV preview enforces the same size limit the
import does.

The dashboard runs its three aggregates together instead of one after another,
the CSV export walks the ledger once instead of re-counting it for every page,
and a transaction write asks about the one payee it names rather than grouping
every payee in the ledger.

A CSV export now carries the bank's own reference for each row, and an import
no longer invents one. The file had no column for it, and restoring one wrote
the source ledger's internal id into that field instead, so the check that stops
a statement being imported twice was keying on an identity that means nothing in
the ledger it was read into. Files written by 0.1.3 and earlier still import; their
rows simply carry no reference, which is the honest answer for a file that has
none. One consequence worth knowing: a row with no bank reference, re-imported a
second time under a different account, is no longer refused as a duplicate,
because the invented id that used to catch it is gone.

A transfer keeps its category when an export is restored into another ledger,
and a category whose name begins with `=`, `+`, `-` or `@` no longer gains an
apostrophe on every round trip and becomes a second category each time. The
visible column stays safe to open in a spreadsheet; the value the import trusts
travels beside it where nothing rewrites it.

Archiving an account now closes it at zero on the day you archive it, not on the
date of the last transaction it happens to hold. A single closing entry dated
that last transaction left the account holding a balance on every day in
between, while every total had already stopped counting it: a report for a date
in that window showed money in an account you had retired, and restoring it in
that window put the balance back on top of one that had never left. Accounts
archived before this are re-closed once, the first time the server starts, which
is logged. Nothing is deleted and no total changes for an account whose
transactions are all in the past.

A negative number in a mapped Debit or Credit column no longer has its sign
quietly removed. Where the file has both columns the other one is what a
reversal goes in, so the column decides and a sign changes nothing, which is how
nearly every two-column bank export is written. Where it has only one, the sign
is the only way that file could say the other direction and nothing says which
was meant, so the row is refused with the reason rather than staged in whichever
direction the column implied.

A recurring transaction set to a relative day, such as the second Tuesday, no
longer proposes a date that has already passed, and the form's preview shows the
date the scheduler will actually propose first. Typing a negative interval no
longer freezes the tab.

Editing the amount of a transfer between two accounts in the same currency now
works. The form was sending a received amount from a field it never showed, and
the ledger refused every save. A transfer also keeps its category when you edit
it, rather than losing it to a form that has nowhere to display one.

A staged row filed under a category by name keeps that name when you open it to
review it, instead of committing uncategorised.

Two settings changes made at the same time no longer overwrite one another.

The timezone and currency the browser detects are offered only while nobody has
chosen, and that is now decided by the server at the moment of writing rather
than by the page against the session it loaded with. Choosing a timezone in
Settings on one tab, or on another device, while a Simple Balance page is open
elsewhere could previously have that choice replaced by the other page's guess.

## 0.1.3 - 2026-08-06

### Added

A template holds whatever subset of a transaction you give it, and only the name
is required now. The type is optional like everything else, and a date and a
category name are stored where before they were refused. The import reference is
still refused, and is the only one: copied onto every transaction made from the
template it would make the next real import of that statement row look like one
already seen.

Applying a template fills in the fields it carries and leaves the rest as they
were, so it works on a transaction that already exists as well as on a new one.
The picker is on the edit form now, not only on Add transaction, which is the
point of the change: a template is a quick way to correct a row somebody else's
import got wrong, not only a way to start one.

The exception is a field the previously chosen template set, which goes back to
what the form held before any template. Without that, picking Rent and then
Coffee would leave Rent's amount attached to Coffee, which is a wrong
transaction one click from being committed. Typing a value yourself and then
applying a template keeps what you typed, because no template put it there.

Each template also reports what came of it: how many committed transactions,
how many rows still waiting in the review queue, and the two added together, the
same three numbers the categories and payees lists show. The count is a link to
those transactions, on a screen of the template's own. A transaction records
which template it was started from, and `list_transactions` takes a `templateId`
filter so an agent can read the same thing.

That record is provenance rather than current state, so it carries no foreign
key. Deleting a template is still allowed and still leaves the transactions made
from it untouched; they simply stop being counted. A key would have made a used
template undeletable, or deleted real entries along with it.

Templates have a screen of their own, above Import CSV in the menu, and Settings
no longer has them. Settings was where the feature landed because it arrived as
one small management panel; a list you sort, search, page, and change many rows
of at once is not a setting.

It is the transactions screen's shape. Every column it shows orders by that
column, the search narrows on name, payee, and notes, and the row menu edits or
deletes one. Tick some rows and the selection bar offers a mass edit and a mass
delete, both atomic. The screen also creates a template, which Settings could not
do: a management screen with an edit and a delete and no way to add a row sends
you back to the transactions list to invent a transaction you did not want. Saving
one from a transaction or a staged row is unchanged.

A template mass edit has a third answer per field that a transaction mass edit
does not need. A template's fields are blank on purpose, so besides leaving a
field alone and setting it, you can clear it: the template stops carrying an
amount and starts asking for one each time you use it. An empty string is refused
rather than read as a clear, because blank and absent meaning different things is
the whole of what a template records.

Two things the screen decides rather than guesses. Changing a template's type
drops whichever account side the new type cannot hold, because nothing asked for
that side and a template holding an account nothing reads is worse than a blank;
a change that does not touch the type leaves both sides alone. Setting a side the
type cannot hold is refused and names the templates that could not take it,
because something did ask for that one. And a template naming an
account or category that no longer exists now says Unavailable in its row; the
Settings list dropped those silently, which hid the one thing most worth knowing
about an old template.

`bulk_edit_transaction_templates` and `bulk_delete_transaction_templates` give an
agent the same two operations, so the MCP surface still does everything the
browser does. Each names every template outright with the version it was read at,
and one that moved underneath refuses the whole call. There is no fingerprinted
filter selection here: that contract exists for rows a browser has never loaded,
and a person can hold two hundred templates, so naming them all is cheaper and
more honest than describing them.

Templates, for the transactions you enter again and again. Open the menu on any
row, on the transactions list or the review queue, and save it as a template:
what you keep is a starting point, not a copy. Anything you clear before saving
is simply not saved, which is the point of the feature rather than a limitation
of it. A template with a payee and a category and no amount is the one most
people want, because the amount is the part that changes.

Pick one from the new dropdown at the top of Add transaction and the form fills
in. From there it is an ordinary form: change anything, change everything, the
template is untouched. There is no path from that form back to the template, so
that is a property of the code rather than a promise about it.

One thing a template deliberately never keeps: the reference a row came in from
a bank file under, because copying that into every transaction made from the
template would make the next real import of that statement row look like one
already seen.

An account or category the template names is looked up when you use it, and
dropped with a note if it is not there any more. Templates outlive the accounts
they mention rather than being deleted along with them. Rename, reshape, or
delete them on the Templates screen.

Agents get templates too, through `list_transaction_templates` and the create,
update, and delete tools.

The categories list says how much each category is actually used: how many
committed transactions, how many rows still waiting in the review queue, and the
two added together, the same three numbers the payees list has always shown. You
can sort by any of them, so the category nothing has ever been filed under is
one click away, which is the one worth archiving or merging. A category with
nothing under it is listed at zero rather than left out.

The counts cover the whole ledger rather than a date range, because this page
has no date range on it. A category's own page does, and shows it, so a badge
reading 43 landing on a list of 7 has its reason on screen.

Agents get the same three numbers from `list_categories`, which is the cheapest
way to stop a ledger accumulating a third spelling of Groceries.

Mass edit for staged rows, on the same terms as committed ones. Select rows in
the review queue, or select everything matching the current filters, and change
the date, payee, category, account, description, notes, or deposit/withdrawal
type in one atomic request. This is the fastest way through the case the queue
exists for: a CSV whose account column meant nothing to the importer leaves
several hundred rows all failing the same check, and one edit fixes the lot.

Every row it writes is validated again, so a batch that was failing on a missing
account comes back ready to commit, and the reply says how many are ready and
how many still need attention. The selection is protected the way a committed
mass edit is: explicit rows carry the version they were read at, and an
all-matching selection carries a server-issued count and `id:version`
fingerprint, so a row that moved underneath makes the whole request stale rather
than quietly taking a value nobody saw.

Account and type are refused on a transfer, which has two accounts and no single
one to move. Setting an account on a row that does not yet say which way the
money went is refused unless the same edit sets the type. Both refuse rather
than skip, so the count of rows changed always matches what was selected.

Agents get the same thing through `bulk_edit_staged_transactions` and
`preview_bulk_staged_selection`, with `dryRun` to see what a change would do
first.

The MCP surface now does everything the web app does. Fourteen tools closed the
gaps that had accumulated: reading and setting the timezone and default
currency, which is the one that mattered most because what counts as today is
decided by the person's timezone and an agent previously had no way to read it
or explain the figures it was given; payee suggestions, which is how an agent
avoids forking a shop into a second spelling; previewing a CSV's columns before
staging it and listing the imports still awaiting review; fetching a single
account or category; the five template tools; counting everything in the ledger;
and `whoami`, which also lets a client pick itself out of the list of connected
agents.

Two things stay out of an agent's reach, and they are now the whole of the list
rather than the part somebody remembered to write down: deleting the account,
which destroys the audit trail that makes every other agent action recoverable,
and setting a sign-in password. Both are account management rather than
bookkeeping. A test compares the two surfaces route by route and fails if a
capability lands on one without reaching the other, so the boundary cannot drift
quietly.

### Fixed

An export could only be imported back into the ledger it came from. The importer
recognised its own format and then read the account ids out of the file, and
those ids name accounts of the ledger that wrote it. Into a different account,
a different person's books, or a fresh install they resolved to nothing, so
every row was rejected with "An exported account is unavailable" and staged
blank: no payee, no account, no category, no amount. A 5,334-row file arrived as
5,334 empty rows.

No account is read out of a file any more, by any import path. The account is
the one chosen on the import screen, which is the only thing that decides where
rows land. The same export now stages with its payees, amounts, categories,
notes, and bank references intact, against whichever account was picked, for
whoever picked it.

An export also needs no column mapping now. Its columns are already known, so
the import screen asks for the account and nothing else, and `stage_csv` takes
one with no `mapping` at all.

Transfers are the one row this cannot decide. A transfer moves between two
accounts and an import names one, so those rows stage with everything else they
carry and ask for both accounts in the queue, where mass edit can answer for
every transfer in a file at once. Which side to put the chosen account on is not
guessed: a transfer pointed the wrong way is a wrong entry one click from being
committed.

A row that cannot be turned into a draft now keeps whatever could be read from
it rather than staging empty, so what reaches the queue is a row missing one
field instead of a row missing everything.

A quality pass over the whole application, driven by nine independent reviews
and by running it and using it. Everything below was found rather than
suspected, and each one has a test that fails without the fix.

Archiving an account could hang forever on a small connection pool. The closing
entry it posts read the person's timezone from the pool while its own
transaction was holding the only connection, so with `DATABASE_POOL_SIZE=1` the
request waited on itself: no answer, no error, nothing in the log. Preference
reads now travel on the transaction the caller already has.

An idle database connection that dropped took the whole container with it. `pg`
reports those on the pool rather than on any request, and with no listener that
is an uncaught exception and an exit, so a database restart or a proxy timeout
became a crash instead of a reconnect.

The accounts list sorted balances through `Number`, which cannot hold the
eighteen decimal places the ledger stores, so two balances differing in the last
of them sorted arbitrarily. Balances now compare exactly, sign included.

A staged row whose date column held something that is not a date turned the
category and payee pages white. `Intl` throws on a date it cannot read, and the
throw unmounted the page. Dates that cannot be read are now shown as they
arrived, which is what somebody needs to see to fix them.

A staged mass edit accepted `currency` and `includeDeleted` filters, advertised
them to agents, and applied neither. Narrowing an edit to one currency would
have had the preview count and the fingerprint agree and then rewritten every
row in the queue. Both are now refused rather than ignored.

A category could become permanently undeletable with nothing on screen to
explain it: the guard counted staged rows that had already been committed, which
keep their draft, so a category showing no transactions at all still refused to
go.

A mistyped id in a URL returned 500 and wrote a Postgres stack trace to the log,
on every `/:id` route. Ids are now checked before they reach a query.

Six pages told people they had nothing when a request had actually failed:
"Create your first account", "No accounts yet", "No categories in this view",
"No activity yet", "Create an account first". Each now shows the error, and none
of them claims emptiness while still loading.

Renaming a category left the old name on the transactions list and in the
spending figures until something else happened to refresh them. Committing a
transaction that created a category or a payee did not refresh either list.

The staged queue's row cap notice was tested against the page rather than the
total, so it could never appear however long the queue was, and a whole-list
selection that hit the cap still said "All … selected". It now says how many of
how many, and a selection that fails partway says so instead of quietly
stopping.

An MCP client configured with a trailing slash was capped at 256 KiB rather than
the CSV-sized limit, so it could complete the OAuth flow and then be refused an
upload the other spelling was allowed. The CHANGELOG entry that claimed
otherwise has been corrected.

The mobile navigation stayed in the tab order while off screen, so tabbing from
the header walked into a menu nobody could see.

Also removed: three CSS rules no component used, two type exports nothing
imported, and a `vitest` run that collected a second copy of every test when a
git worktree sat inside the repo.

The MCP endpoint answers on `/mcp/` as well as `/mcp`. They are different paths
to a router and only the second was registered, so a client configured with the
trailing slash completed OAuth correctly, had its grant recorded in Settings and
a valid token in hand, and then got a bare 404 on every call, which an agent
reports as an authorization problem. Discovery under the resource path accepts
the slash for the same reason, and so does the larger request body an MCP CSV
upload is allowed: the route was registered for both spellings but the body
limit still recognised only one, so a client using the slash could reach the
endpoint and then be refused a payload the other spelling was allowed.

### Changed

Uncategorised spending sits at the bottom of spending by category rather than
wherever its total ranks. It is not a category anybody chose, so putting it
first answers "what needs filing" on a panel that was asked where the money
went. It is still shown, and shown even when the list is cut short, because it
is the one row that says there is filing left to do. Ordered in the summary
itself, so an agent reading `get_financial_summary` sees the same order as the
page.

## 0.1.2 - 2026-08-03

### Added

Deleting your own account, from Settings, taking everything in it: accounts,
transactions and the postings under them, categories, payees, staged rows,
import history, preferences, audit history, sessions, sign-in methods, and every
agent you had connected. What will go is counted and shown first, and the address
on the account has to be typed, because that is the one thing on the screen a
stray click cannot produce. Nothing is kept and there is no undo.

It works by one delete: every table holding a person's data references
`auth_user` with `on delete cascade`, so nothing enumerates tables and a table
added later cannot be forgotten. The test reads the tables out of the database
and asserts not one row of the deleted account is left in any of them, which a
hand-kept list would not have done.

An agent cannot do it. Deleting is reachable only with a session cookie, which
an MCP token never becomes.

### Fixed

Signing up with Google. Better Auth declares its social callback as the route
pattern `/callback/:id` and hands database hooks that pattern rather than the URL
requested, so the policy deciding who may open an account was told
`/callback/:id`, matched nothing, and fell through to refusing. A first-ever
Google sign-up therefore failed with `unable_to_create_user` while linking
Google to an account that already existed kept working, because linking creates
no user. Both forms of the path are now recognised.

The icon. It was in the built bundle and nothing routed to it: only `/assets/*`
was served as files, so a request for `/favicon.svg` fell through to the
single-page shell and a browser was handed HTML under a `text/html` content type
for an image. The whole root of the bundle is served now, and the Apple touch
icon is a PNG rather than an SVG, which iOS does not accept.

### Changed

A new account starts on the timezone and currency its browser implies rather
than UTC and USD. UTC is wrong for most of the world in a way that misdates
entries: something recorded on a California evening lands on tomorrow. The
timezone comes from the browser, which knows it exactly, and the currency from
the region of its language tag, with USD when the tag names no region. Both are
ordinary settings afterwards, and nothing is adopted once anybody has chosen.

The sign-in screen and Settings no longer describe anything as "local".
`AUTH_MODE=local` is a name for a deployment mode, not something a person
signing in has any use for, and on a hosted instance it suggests the data lives
on their own machine.

Settings lays its cards out in columns rather than rows, so a short panel no
longer leaves a stretch of nothing beneath it to line up with the tall one
beside it.

## 0.1.1 - 2026-08-03

Two things a first deployment ran into. No schema change, no data migration:
pull the new image and restart.

### Fixed

Reaching a database on another host over TLS. The deployment guide said to
append `?sslmode=require`, which in libpq means "encrypt and do not check the
certificate" but in node-postgres does check it. A self-hosted PostgreSQL almost
always presents a certificate it signed itself, so the setting the guide
recommended was the one that could not work, and it failed with
`DEPTH_ZERO_SELF_SIGNED_CERT` while Node advised installing a root CA that does
not exist. Use `?sslmode=no-verify` for a self-signed server: the connection is
still encrypted, it just stops checking who signed the certificate. The guide
now sets out all three modes and what each does, and the startup failure names
the one to use instead of leaving an operator with a certificate error and no
way forward.

The first-run setup code is no longer printed where it cannot be used. The code
is read only after `ALLOWED_EMAILS` has turned an address away, so a rule
admitting everyone makes it unreachable, and printing one sent operators looking
for a code the sign-up form does not ask for. Where it is still live, the log
now says which it is: the only way in when the rule admits nobody, or the way to
claim the instance with an address the rule would turn away.

## 0.1.0 - 2026-08-02

The first release. Everything below is new, so this reads as a description of
what Simple Balance does rather than a list of differences.

### The ledger

The books are double-entry. Every transaction settles to zero in each currency
it touches, checked before anything is written, with server-owned income,
expense, exchange, and equity accounts doing the balancing. Opening balances
post against equity, so the ledger sums to zero from the first account onward.
None of those counter-accounts appear in a picker, and no transaction can name
one as a side.

Archiving an account posts its remaining balance out to equity, so it closes at
zero and the totals that leave it out stay right. Restoring puts the balance
back. The dashboard stops at today, so an entry dated next month is not counted
as money you have, and its balance, cash flow, and spending all describe the
same set of accounts.

Postings are append-only and carry their own date. Correcting an entry appends
only the difference, so changing an amount costs one adjusting row per side and
an edit that touches only labels writes nothing at all. Deleting posts the
reversal instead of setting a flag, which is why no balance or report has to
remember to exclude deleted rows. A balance as of a date reads an index rather
than scanning the ledger.

Balances, cash flow, and spending by category all come from the postings.

### Accounts and transactions

Accounts for assets and liabilities, each fixed to one currency once it is in
use. Crypto wallets track native quantities and quote no prices. Deposits,
withdrawals, and transfers, including cross-currency conversions that keep the
sent and received amounts separate.

Editing uses optimistic concurrency and creating uses idempotency keys, so a
retry cannot duplicate work and a stale edit fails rather than overwriting
someone else's.

Mass edit and mass delete cover up to 10,000 rows in one atomic request from any
transaction view. Explicit selections carry row versions; all-matching
selections carry a server-issued count and fingerprint, so a concurrent change
makes the request stale rather than silently changing its scope.

### Getting data in and out

Bank CSV import detects the format, maps columns, parses localised dates and
numbers, matches or creates categories and payees, and lands everything in a
review queue. Committing a batch validates every row first and runs as one
transaction. Simple Balance's own export reads back in without loss.

Categories and payees match case-insensitively, surface their own near
duplicates, and merge by rewriting every reference at once. Typing a category on
a transaction is enough: an existing one is matched whatever its capitalization,
and a new one is created on save, so a ledger does not end up with three
spellings of the same thing.

### Using it

Every list sorts by any column it displays, in either direction, and pages by
number. Amounts show at their currency's own precision, with crypto keeping the
digits it needs. Date ranges live in the URL, so a view can be linked to.
Destructive actions ask first, in the app's own dialogs, and say what will
happen and how to undo it.

### Agents

An MCP server over OAuth with separate read, stage, and write scopes, calling
the same ledger code the browser does. Tools outside a token's scope are not
even discoverable. Schema fields carry descriptions, so an agent does not have
to infer that money is a string or that a credit card opens negative. Access
tokens are audience-bound RS256 JWTs backed by revocable records.

Settings lists every agent you have approved and what it may do, and revoking
one deletes its tokens rather than waiting for them to lapse, so it loses access
on its next call. An agent can do the same: listing what is connected needs only
read, and revoking needs write, so a read-only token cannot lock your other
agents out.

### Accounts and who may have one

One deployment holds as many people as you let it. Each has their own accounts,
transactions, categories, payees, totals, and audit history, and none of them
can see or name another's. `ALLOWED_EMAILS` decides who may register: exact
addresses, whole domains such as `example.com`, or `*` for anybody. Leave it
unset and nobody can, which keeps a personal deployment personal.

It governs registration and nothing else, so an address removed from the list
keeps the account it already has rather than losing access to its own books.

Sign in with a password, with Google, or with both on one account. Google
sign-ups must carry a verified address, so a domain entry means what it says.

Give the deployment a mail server, with `SMTP_HOST` and `MAIL_FROM`, and two
things follow: a forgotten password can be reset from the sign-in screen, and a
new account has to open a link sent to its address before it works. That is what
makes a domain entry mean something in password mode too. Leave them unset and
neither happens, which is the right answer for a deployment of one. Accounts
made before a mail server was added keep working after it arrives.

### Running it

One non-root image that never writes to its own filesystem, with PostgreSQL as
the only thing it stores anything in. Migrations run at startup under an
advisory lock, and readiness stays closed until they finish. Local sign-in works
with no configuration at all; Google is optional.

Tagged multi-architecture images publish to GHCR on release.
