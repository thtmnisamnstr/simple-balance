# Common

Rules about values that cross a boundary. Money is a decimal string in JSON, in
a tool result, in a CSV cell and on a screen; a category is called a category in
a table header, a tool description and an error message. Written once here,
cited from the interface guides, because a rule written five times says five
different things within a year.

**The test for whether a rule belongs here:** would the same value be wrong in
the same way on a different interface? If yes, it is here. If the rule is about
how one medium presents it, right alignment, a JSON key, a CSV column header, it
belongs to that interface.

## Money

**Binding.** `AGENTS.md`: "Never represent money with JavaScript/JSON
floating-point numbers. Use validated decimal strings and PostgreSQL
`numeric(44,18)`."

- **A ledger amount is a string, everywhere.** In a request body, in a tool
  result, in a CSV cell, in a database column, and in the browser's own state.
  There is no boundary at which it becomes a number. One money-shaped value in
  this product is not a ledger amount and *is* a number from the payment
  processor to the screen; §**Money that is not a ledger amount** below is the
  whole of that carve-out, and a reviewer who applies this bullet to a
  subscription price without reading it files working code as a violation.
- **Arithmetic goes through the one place that does it.** `decimal()` and
  `canonicalDecimal()` in `src/server/services/helpers.ts` on the server;
  `moneyUnits`, `sumMoney` and `compareMoney` in `src/client/money.ts` in the
  browser, which scale to eighteen fractional digits as `BigInt`.
- **A comparison is arithmetic.** Deciding whether a figure is negative, zero,
  or larger than another is a decision, and a float cannot hold eighteen
  fractional digits. `isNegativeMoney` and `compareMoney`, never `Number(x) < 0`.
  This one is worth stating because it is the rule most often broken by somebody
  who knows the first rule perfectly well.
- **Pixels may be lossy, and nothing else may.** A bar width, a chart scale or a
  tick position may become a number at the very last step, because the answer is
  a coordinate. `src/client/charts.tsx` computes its ticks in `BigInt` and
  converts only for geometry; `fillPercent` (`src/client/budget-display.ts:42`)
  does the same for a budget bar, and says in the same breath why
  `moneyRatioPercent` is the wrong helper there.
- **No figure spans currencies.** There is no exchange rate in this ledger that
  is not the rate some transfer actually got, so a total across currencies could
  only be invented. Response shapes must have nowhere for such a number to go:
  a per-currency array rather than a total with a currency field beside it.
- **Zero is a value.** Zero spent, a zero budget, a zero balance and an absent
  figure are four different things and read differently. A figure that did not
  load is the fourth and never the third: the category detail rendered a failed
  report as $0.00. And a card paid off to the cent owes nothing, so its balance
  reads "Amount owed: $0.00" rather than the credit balance it was labelled.

*Checked by:* `tests/client-money.test.ts`, `tests/ledger.test.ts`, and
`tests/quality-fixes.test.ts`'s "money on the server", which refuses `Number(`
and `parseFloat(` on any value whose *name* is money — amount, balance, spent,
remaining, total, rate, price and the rest — rather than refusing `Number(`
outright, because six of the six sites in the services are counts and a count is
a number. This footer claimed that scan "would catch it and does not exist" for
the whole of 0.2.0's development: it landed in `ca6bab1`, before this release
branched. What it genuinely does not read is `src/client`, which is where the
one sanctioned conversion lives and so where an unsanctioned one would hide;
`tests/common-guide.test.ts` holds that one to its single site instead, and holds
the comparison rule over the client: nothing outside `src/client/money.ts` asks
`=== "0"`, `!== "0"` or `.startsWith("-")` of a figure. Four places decided a
figure was zero by its text until it was written — right only while whatever
produced the string wrote zero one way — and `isZeroMoney` is what they ask
now.

## Dates and times

**Binding.** `AGENTS.md`: "Whether it is a given day, or a given time of day,
where somebody lives is answered in one place."

- **A calendar date is `YYYY-MM-DD`.** An instant is RFC 3339 with an offset.
  They are different types and never the same field. A posting has a date; an
  audit event has an instant.
- **"What day is it where this person lives" is `calendarDayIn`, `todayIn` or
  `clockTimeIn` from `src/shared/recurrence-dates.ts`.** Never the database, and
  never `new Date()` in a service. PostgreSQL reads a bare offset timezone with
  the POSIX sign convention and `Intl` reads it as ISO, so the two disagree by up
  to sixteen hours for anybody whose stored timezone is an offset.
- **A summary stops at today in the person's own timezone** and reports the day
  it used. Money dated in the future has not moved.
- **A date somebody reads is formatted, never raw.** `formatDate` in
  `src/client/money.ts`. A raw `2026-03-01` in a sentence is a bug report waiting
  to be filed by somebody outside the ISO-reading world.
- **A stored period start is the name of a period, not a boundary.** A budget
  window ending `2026-06-01` covers all of June. Rendering it raw says the
  opposite, and did: see `periodName` (`src/client/budget-display.ts:21`).
  Anywhere a date names a period rather than a day, it is rendered as the period.
  It was private to the budgets page until the overview grew a panel about
  budgets, and moving it out is the rule proving itself — two pages now name a
  period the same way instead of one of them saying "to June 1" about a window
  covering all of June (`src/client/budget-display.ts:4-10`).

*Checked by:* `tests/recurrence-dates.test.ts`, `tests/locale-detection.test.ts`
for the arithmetic, and `tests/raw-dates-on-screen.test.ts` for the fourth
bullet: a raw `YYYY-MM-DD` reaching a caption, an `aria-label` or any other
string somebody reads, including the ones only a screen reader reaches. Which
fields count as dates is derived from what the client already passes to a
formatter rather than listed, so a new one joins the population by being
formatted anywhere.

## Naming

**House.** One concept, one spelling, on every surface.

- **camelCase** in JSON bodies, query strings, tool arguments and TypeScript.
  **snake_case** in database columns and CSV headers. The boundary is the ORM and
  the CSV parser, and nothing else translates.
- **A name is the same word on every surface.** A `categoryId` in a tool argument
  is a `categoryId` in a request body and a `category_id` in a column. Where the
  browser calls something one thing and a tool another, the tool is wrong: an
  agent and a person are looking at one ledger. This is about the *name of a
  thing*, and it has one exception that `AGENTS.md` requires rather than
  tolerates: a closed set's member may be one word on the wire and another on
  screen, because renaming the wire value would break every client that has seen
  it and renaming the label would not. §**A wire value and the word a person
  reads** below says what that costs. Acting on this bullet alone and renaming
  `plus` to `premium` would be a change `AGENTS.md` forbids outright.
- **Enumerations are lowercase**, with the multi-word ones snake_case
  (`credit_card`, `last_day`). Four casings accreted before this rule; new ones
  follow it.
- **A boolean is named for what being true means** (`includeArchived`,
  `allowDuplicate`), never for what it disables.
- **American spelling, in prose and in names alike.** `normalization`, not
  `normalisation`; `color`, not `colour`; `canceled`, not `cancelled`. The
  product is sold in dollars to a mostly American audience and the marketing
  site is written that way, so this is the side the whole repository picks —
  including comments, guides, test names and the sentences the MCP surface
  hands an agent. It was the other way until the prices moved. The changelog
  turned over with everything else: its entries are documentation somebody
  reads today, not a transcript, and one product spelling itself two ways
  across its own history is the inconsistency this rule exists to stop. One
  carve-out, and it is the only one: `drizzle/`, whose comments are inside files
  the migrator identifies by hash. Editing one is editing a migration, which
  `AGENTS.md` forbids for a reason that has nothing to do with spelling, and
  `drizzle/0023_citus_distribution.sql:42` keeps a "catalogue" on exactly that
  footing.

  This bullet used to carve out a second case, a quotation: `web.md` was said to
  quote the GOV.UK style guide in its own spelling, because rewriting somebody
  else's sentence is not a convention change. The principle is right and the
  exception was empty. `web.md` contains no British spelling and contained none
  at `1d753f2`, the commit that wrote the carve-out, so it has only ever
  sanctioned a case nothing takes — which is how one gets back in unchallenged,
  under a permission somebody already granted. The principle survives as a
  principle: quote what somebody else wrote, as they wrote it. It is not a list
  of files, because the list was empty.

*Not checked mechanically*, except the spelling and the idioms.
`tests/mcp-measurements.test.ts` holds the spelling on the agent surface by
naming the losing spelling and refusing it. `tests/american-wording.test.ts`
holds the British idioms a word map cannot see — "tick the box", "fortnight",
"straight away", "afterwards" and the rest it lists — across `src`,
`index.html`, and the product kit's seed and scripts, comments included. A
naming registry would need to know what a concept is, so the rest is review.

**Where the rule overreaches its mechanism.** The bullet says "the whole
repository" and the mechanism reaches `src`, the shell page and the product
kit — everything a person or an agent reads *out of the running product*.
Outside that scope there are 52 British spellings, counted at `cb67604` with
`drizzle/`, `LICENSE` and the two tests that name a losing spelling on purpose
left out: 17 in `tests/`, 17 in `deploy/`, 14 in `docs/` and 3 in
`CHANGELOG.md`, most of them written by this release. Those are a backlog
rather than a disagreement: each one is a defect under a rule nobody argues
with, and the only reason none of them was caught is that nothing was looking.
The scope is what makes widening the scan a change with a cost — three
populations have to be excluded by name first, and each exclusion is the kind
that quietly swallows a file: `drizzle/`, which may not be edited at all;
`LICENSE`, which is somebody else's sentence; and a test that refuses a word by
spelling it, which `tests/american-wording.test.ts:25-27` already says is out of
its own scope by construction. The honest reading of the rule until that lands
is that the convention is the repository's and the guard is the product's.

## Errors

**Binding** for the shape, **House** for the sentence.

- **One envelope, everywhere.** `{ error: { code, message, details? } }`. Over
  HTTP it is the body; over MCP it is the `result` member. The codes come from
  one enumeration and the enumeration is published.
- **The code is for a machine, the message is for a person, the details are for
  the field.** Never put a field path in the message and nothing in the details.
- **An error says what happened and what to do next.** Both halves. "This record
  changed since it was loaded" is the first half; "Refresh and try again" is a
  second half that means nothing to an agent, which has nothing to refresh.
  Where the two callers need different advice, the advice is the part that
  differs, never the diagnosis.
- **An id belonging to somebody else is not found, never forbidden.** Whether a
  row exists must not depend on who is asking.
- **A refusal offers the move that works.** A message telling somebody to do
  something the next validator refuses is worse than no advice at all: see the
  overlap refusal in `src/server/services/budgets.ts`, which had to learn the
  difference between "end the other budget" and "change the one you have".

Worked sentences, so the voice is not reinvented per site. **These are the
strings the product ships, quoted**, and that distinction is the whole value of
the table: it was written as prose and half of it described sentences nothing
said, which makes it a wish rather than a reference. A row here is checkable and
is checked.

| Situation | Message |
| --- | --- |
| Amount empty | Enter an amount |
| Amount not a decimal, in a CSV cell | Amount must be a number. Check the decimal and thousands separators. |
| Amount zero or negative where it may not be | Amount must be greater than zero |
| Budget amount negative | A budget cannot be negative. Use zero to budget nothing. |
| Date is not a calendar date | That date does not exist |
| Date in the wrong shape | Use YYYY-MM-DD |
| Version conflict, browser | This changed while you were editing it. Reload to see the current version. |
| Version conflict, agent, where the refusal carries the version | This changed since you read it. Read it again and retry with the version in details.currentVersion. |
| Version conflict, agent, where it carries no version | This changed since you read it. Read it again and retry with the version it reports. |
| Stale bulk fingerprint, browser | The rows this was about have changed. Preview the selection again and retry with the count and fingerprint it returns. |
| Stale bulk fingerprint, agent | The selected set has changed since it was previewed. Preview the selection again and send the count and fingerprint it returns. |
| Cursor under a changed ordering | This cursor belongs to a different sort order. Start again from the first page. |
| Cursor that cannot be read at all | This page marker cannot be read. Start again from the first page. |
| A staged row that is not ready to commit | Every selected row must be complete before it can commit. |
| A path id that is not an id this API issues | Use an id returned by a list or a create |

**Those five rows are one helper's output, not five sites.** `staleVersion`
(`src/server/services/errors.ts:102-115`) picks by what the details carry:
a `currentFingerprint` means the refusal is about a *set* rather than a row, so
"read it again and retry with the version" is advice the caller cannot take;
a `currentVersion` means the number is in the payload and the sentence may name
the field it is in; neither means it is not, and the sentence has to say so
instead of sending somebody to a field that is absent. Call the helper. The
table had one agent row for a while, and a row somebody copies into a throw site
that sends no details is exactly the failure the helper was built to stop.

Three situations a reader will look for are deliberately not in that table,
because the product has no sentence for them and should not:

- **An empty required field.** The control carries `required` and the browser
  says so in the person's own language. Writing our own would be a second answer
  in one language, shown after theirs.
- **An idempotent replay.** It returns the stored response, unchanged and
  successful. Telling somebody "this was already saved" would describe our
  bookkeeping rather than their outcome, which is that it is saved.
- **A row belonging to somebody else.** It is `<Thing> not found` — "Account not
  found", "Category not found" — because the rule above is that whether a row
  exists must not depend on who is asking, and a bare "Not found" says less than
  the sentence a missing row of your own gets.

*Checked by:* `tests/ui-copy.test.ts`, which requires every message in the table
above to appear verbatim in `src`, and `tests/worked-sentence-reverse.test.ts`,
which reads the table the other way: a sentence in `src` that is *about* one of
these situations is one of these messages or is named in that file's register
with the argument for it. The forward check alone cannot see the failure this
table exists to prevent — a sixteenth message for a situation that already has
one, with the row it duplicates still quoted somewhere. `tests/ui-copy.test.ts`
also refuses the banned words anywhere a person can read them, across all three of `src/client`, `src/shared` and `src/server` —
`common.md` settles the voice for both surfaces and a service's refusal is
rendered on a screen. Also `tests/api-security.test.ts` and
`tests/mcp-output.test.ts` for the envelope.

That every code an interface can emit is in the published enumeration **is**
checked, and this footer said otherwise for a release while `http.md` named the
mechanism in the same breath. It is held in two halves. The compiler holds the
first: `AppError` takes `ServiceErrorCode` and `errorResponse` takes
`TransportErrorCode`, and `apiErrorCodes` is the sum of those two lists, so a
code outside the enumeration is not a value either constructor accepts.
`tests/service-errors.test.ts` holds the second, which is the only way past
them — "builds an error body in the two places that are allowed to" refuses any
other module writing `error: { code: "…" }` by hand, which is how a sixth
transport code reached the wire once before. A typed constructor nothing can
bypass is a contract; one anything can bypass is what somebody remembered.
[`http.md`](http.md) §Errors carries the enumeration itself and the argument
for splitting it in two.

## The glossary

**House.** The product's nouns, one definition each, and the same word on every
surface. Not a rule with a mechanism of its own: it is the vocabulary the rules
above are written in, and the thing to check a new label or tool description
against.

*Checked by:* `tests/common-guide.test.ts`, which holds every word in the table
to being a word this product's source actually uses, so a row cannot outlive the
concept it names or survive its rename. Whether the source uses the word in the
table's sense, and whether the "Not" column is honest, stays review.

| Word | Means | Not |
| --- | --- | --- |
| **Account** | Two senses, both shipped. Unqualified and inside the ledger: somewhere money sits, a bank account, a card, a wallet. Qualified as *your account* and only in account management: the sign-in, its plan and its data. | Interchangeable. One sentence never uses both senses. |
| **Counter-account** | A server-owned account, one per kind and currency, holding the other side of an entry. | Anything a person can name, see in a picker, or transact with. |
| **Transaction** | One movement of money, of three shapes: deposit, withdrawal, transfer. | A posting. |
| **Posting** | One signed amount against one account on one date. The thing every figure is computed from. | A transaction. A transaction has at least two. |
| **Leg** | One category's share of the counter-account side of a split. | A posting, although each leg has its own. |
| **Split** | One entry whose counter-account side is cut into legs. | Two transactions. |
| **Category** | What a movement was for. | An account. |
| **Category group** | A named set of categories. A budget may be about one, directly or as the sum of its members, never both at once. | A category. Nothing posts against a group. |
| **Payee** | Who the money went to or came from, derived from transaction text. | A stored record with an id. |
| **Staged transaction** | A proposal in the review queue. Affects no balance. | A draft of a saved thing. Nothing about it is in the books. |
| **Budget plan** | A standing amount for one category or one group, never both, per period, over a window of periods. | A posting. Nothing in budgeting writes one. |
| **Budget entry** | An amount for one period, overriding the plan for that period alone. | A plan for one period. |
| **Forecast** | A projection of what the books would hold if the future arrived as scheduled. | A balance. Money dated in the future has not moved. |
| **Recurrence** | A saved shape and a schedule that proposes a staged row on its due date. | Something that posts. |
| **Template** | A saved shape with no schedule. | A recurrence. |
| **Plan** | What a sign-in is entitled to and billed for: free or paid. `plus` on the wire, **Premium** on screen. | A budget plan, which is always written out in full. |
| **Entitlement** | What a plan permits, worked out from the plan and the moment rather than stored (`resolveEntitlement`, `src/shared/domain.ts:3518`). | A plan. An entitlement follows from one and changes with nobody present, which is why no column holds it. |
| **Frozen** | A live account a plan's limit leaves closed to every change to what it holds: fully readable, counted in every balance, summary and report, and still free to be archived, or deleted while nothing is on it. | Archived. An archived account already refuses writes, is outside the limit, and uses up no place. |
| **Place** | One of the accounts a plan keeps usable; the product's word for the slot. | An account. A place opens up only when an account in use is archived or deleted. |

Where the UI and a tool description disagree about a word, this table decides.
It can only decide about words it lists, which is why the four account-management
nouns are here: the plan work put all four into tool descriptions, refusals and
page copy while the table was still purely a bookkeeping vocabulary, and the
spelling guard was already having to reason about one of them from a comment
(`tests/american-wording.test.ts:24-25`) because nothing else said what it meant.

**The one collision, recorded rather than resolved.** The Account row above gives
the word two senses and asks that one sentence never use both. One screen uses
both, a sentence apart: the deletion panel is titled "Delete this account"
(`src/client/pages/SettingsPage.tsx:449`), meaning the sign-in, and its next
sentence is "Everything in it goes: accounts, transactions, categories…"
(`src/client/pages/SettingsPage.tsx:450-452`), meaning the financial ones. The
confirmation repeats it (`:584`, `:578`). `AGENTS.md` wins over this guide and
calls a sign-in an account throughout, as do three places in the product
(`src/client/App.tsx:395`, `src/client/pages/SettingsPage.tsx:169`,
`src/client/pages/PlanPage.tsx:1137`), so the old row — "A user. A person has a
sign-in, not an account." — was asserting a rule the repository has never
followed, and the sharp case is the one screen where the ambiguity it was written
to prevent actually bites. Rewriting the panel is a copy change this guide cannot
make on its own: the title is the one a person looks for, and "Delete your
sign-in and everything in this ledger" is longer than a panel heading wants to
be. It is the owner's call, and until it is made the row is the rule and the
panel is the exception that is written down.

## Prose

**House.** The voice is the same in a tool description, a button, an error, a
commit subject and a comment: plain, declarative, specific.

- **Say what a thing does, not that it is good.** No marketing adjectives, no
  "simply", no "just", no "seamlessly".
- **Sentence case** for headings, labels and buttons. Not Title Case.
- **A button says what will happen**, in the words the confirmation will use.
  "Delete budget", then "Budget deleted".
- **Explain the failure the rule prevents, not the rule.** This is the house
  habit worth keeping most: comments and docs here record the specific bug a line
  exists to stop, in the past tense, because that is the thing a reader cannot
  reconstruct.
- **No em dash in a control's own words.** Not in a button, a heading, a table
  header, a field label or one of the worked sentences above. In those, a dash
  stands in for deciding what the sentence says, and the words are short enough
  that the decision is always available. Everywhere else an em dash is ordinary
  punctuation: in this guide, in a comment, in a commit body, and in the
  explanatory paragraphs the product itself ships to an agent. It also joins two
  values in a composed label, `Annual — $30.00` and
  `Europe/London — GMT (+00:00)`, and it fills an empty table cell, where it is
  a glyph rather than punctuation.
- **Numbers a person reads are formatted.** Money through `formatMoney`, dates
  through `formatDate`. A count written as a literal in a sentence is spelled out
  below ten. A count that arrives as a *value* cannot be spelled out by writing
  the sentence differently, so it is spelled out by a map where the sentence
  reads as a sentence — `NUMBER_WORDS` and `GRACE_IN_WORDS`
  (`src/client/pages/PlanPage.tsx:638-644`) turn `BILLING_GRACE_DAYS` into words
  and fall back to digits past the end of the list, which "reads worse and is
  still true" — and left as a digit where it reads as a figure beside others.
  The plan and freezing copy is all of the second kind and none of the first,
  and the two halves of it currently disagree: the grace period is spelled out
  and the account limit is not. `MAX_FREE_ACCOUNTS` is three, and it renders as
  "up to 3 accounts" (`src/client/pages/PlanPage.tsx:1706`), "Your plan keeps 3
  accounts usable" (`src/client/pages/AccountsPage.tsx:656`) and "All 3 places
  are in use" (`src/client/pages/AccountsPage.tsx:697`), the last of which is a
  figure beside a figure and right as a digit. The first two are sentences and
  would read better in words. Say so in a review; do not grep for it, because
  there is nothing to find. Every one of these literals says `${limit}`, and the
  violation exists only once a number has been substituted into it.

**Why the em-dash rule is scoped rather than absolute.** It used to read "No em
dashes. They are a house preference and the codebase is consistent about it",
and the second sentence was false by an order of magnitude.
[`writing.md`](writing.md) §Where this guide and the repository disagree
recorded it and said the choice belonged to this document; this is the choice,
and it is to scope rather than to sweep. Measured at `cb67604`: 922 lines under
`src` carry an em dash, 798 of them comments, and 77 string literals carry one —
16 the empty-cell glyph, 11 composed or short labels, and **50 sentences of
explanatory prose, 45 of those on the agent surface** in `src/shared/domain.ts`,
`src/server/mcp.ts` and `src/server/mcp-output-schemas.ts`. Outside `src` the
counts are larger still. Sweeping all of that was the obvious alternative and it
is the wrong one twice: it would rewrite 45 published tool descriptions, which
are contract an agent has already read, in service of a typographic preference;
and a rule nothing enforces loses ground at the rate the repository grows, so
the next release would start the count again. What is left after the scoping is
true and stays true — zero in any heading, table header, label or worked
sentence — which is a rule somebody can keep rather than a tally somebody
periodically loses.

*Checked by:* `tests/ui-copy.test.ts` for the worked sentences and the banned
words, and `tests/common-guide.test.ts` for the em dash in a heading, a table
header or a label. What that last one cannot see is a `<Button>` whose words sit
on the next line, which is most of them, so it catches the regression in the
shape it has taken and not in every shape it could. The rest of this section is
review, and it is the one place that is honestly fine as review, because the
thing being judged is whether a sentence is true.

## Carve-outs

Two rules above do not apply everywhere, and both exceptions are cited from the
interface guides rather than restated there. Each one names the rule it is an
exception to, the test for whether a value is inside it, and what the obvious
fix would cost.

### Money that is not a ledger amount

**Binding**, deferring to `AGENTS.md`, and the single owner of this carve-out:
[`web.md`](web.md) §10 and [`code/client.md`](code/client.md) §2.1 cite it
rather than repeating it, because a rule about floating-point money written in
three places is three rules within a year.

The membership test is the whole of it, and all four clauses have to hold:

- the value never reaches a posting, a balance, a report or the trial balance;
- it is rendered and discarded, never stored;
- it is never summed, compared or carried into a second figure;
- and it *arrives as an integer from a vendor* rather than being written down
  here. Where the same figure is written down here it is a decimal string, like
  everything else.

One value passes today. Stripe reports a subscription price as an integer count
of the currency's smallest unit (`src/server/stripe.ts:1262`), the server hands
it on untouched (`src/server/services/billing.ts:1153`), and `formatPrice`
(`src/client/pages/PlanPage.tsx:588-608`) divides it by the scale `Intl` already
knows and formats it in the same breath. The argument is written at the site and
ends "Do not copy this into anything that touches a posting", which is the
sentence to read before deciding a second value qualifies.

**The obvious alternative was to convert at the server edge**, turning the
vendor's minor units into a canonical decimal string before anything else sees
it, so that §Money above needed no exception at all. It is wrong twice
over. It invents a per-currency scale the vendor does not promise: how many
minor units make a major one is the currency's business, `Intl` already answers
it, and encoding the answer here would be a table that is correct until a
deployment sells in a currency nobody tested. And it creates a second place the
price lives, which is what `src/server/config.ts:329-332` already refuses for
the ids by keeping only the id in configuration. An amount copied out of Stripe
is the one that does not get charged, because Stripe charges what the price
object says; the copy can only ever be the number the customer was shown.

The published contract takes the other side and is not a contradiction.
`docs/product/facts.json` declares the same two prices as decimal strings and
`tests/product-facts.test.ts:71` refuses a number there, because that file is
written by hand, read by a separate repository, and never arrives from anywhere.
A figure somebody types is a figure that has no excuse to be a float.

This recurs. An invoice total, a proration, a tax line, a refunded amount and a
second payment processor all arrive the same way, and each one has to pass all
four clauses rather than inherit this one's answer: a refunded amount that
reaches a posting is a ledger amount, whatever shape it arrived in.

*Checked by:* `tests/common-guide.test.ts`, which names the four files allowed
to touch Stripe's minor-unit integer, refuses a fifth, and refuses arithmetic on
it outside `formatPrice`; `tests/product-facts.test.ts:71` for the published
half; and `tests/quality-fixes.test.ts` for everything the carve-out is an
exception to.

### A wire value and the word a person reads

**House.** §Naming says a name is the same word on every surface, and names no
exception. Six closed sets already read against that sentence:
`accountTypeLabels` (`src/shared/domain.ts:53`), `PLAN_LABELS`
(`src/shared/domain.ts:3432`), `categoryKindLabels`
(`src/client/select-options.ts:113`, which both category pages read),
`transactionTypeLabels`
(`src/client/pages/TemplatesPage.tsx:70`), and `ORDINAL_LABELS` and
`FREQUENCY_LABELS` (`src/client/forms.tsx:2537`, `:2617`) for the two schedule
pickers. In four of the six the label is a different *word* rather than the same
word capitalized: `credit_card` reads Credit Card, `plus` reads Premium, `both`
reads "Income or expense", and the ordinal `-1` reads Last.

The exception, and what it costs:

- **The wire value is frozen contract and lowercase.** `credit_card`, `plus`,
  `both`, `last_day`. It appears in a request body, a column, a CSV cell and a
  tool argument, and `plan === "plus"` stays legal everywhere.
- **The label is prose and may change.** Credit Card, Premium, "Income or
  expense". Changing one breaks nothing and needs no deprecation.
- **The map is written once, where every surface that renders the word can
  reach it.** `PLAN_LABELS` is in `src/shared` for that reason: the same word
  has to be available to the browser, to the mail the scheduler sends, and to
  anything the server says about a plan. A label defined on the page that
  renders it is correct exactly once, and the second surface writes it out
  again.

**The obvious alternative was to rename the wire value so the two agree**, which
`AGENTS.md` forbids outright: renaming `plus` to `premium` would break every
client that has seen the API, and renaming the label breaks nothing. The
asymmetry is the whole argument, and it is why the map goes in one direction
only. There is no reverse lookup from a label to a wire value, because a label
is not an identifier.

**One gap is open and named here rather than implied.** `whoami` returns the
plan as a bare wire value (`src/server/mcp-output-schemas.ts:680-681`) and its
description never says the screen reads a different word, so an agent explaining
why a write was refused says "plus" about a product that sells Premium. That is
the defect `AGENTS.md` records one level down from a route-by-route parity
check: a field only an agent ever reads is invisible to a comparison of route
lists, and `categoryKind` was exactly that for a release.

*Checked by:* `tests/plan-labels.test.ts`, which refuses any file spelling the
label by hand and derives the renamed set from `PLAN_LABELS` rather than listing
it, and `tests/common-guide.test.ts`, which holds the map in `src/shared` and
refuses a second copy of it. Not checked: that a tool returning a wire value
tells its reader what a person sees. The gap above is that rule unenforced, and
a mechanism for it would have to know which output fields are closed sets, which
is the registry §Naming already says cannot be written.
