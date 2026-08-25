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

- **A monetary value is a string, everywhere.** In a request body, in a tool
  result, in a CSV cell, in a database column, and in the browser's own state.
  There is no boundary at which it becomes a number.
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
  converts only for geometry; a budget bar does the same.
- **No figure spans currencies.** There is no exchange rate in this ledger that
  is not the rate some transfer actually got, so a total across currencies could
  only be invented. Response shapes must have nowhere for such a number to go:
  a per-currency array rather than a total with a currency field beside it.
- **Zero is a value.** Zero spent, a zero budget, a zero balance and an absent
  figure are four different things and read differently.

*Checked by:* `tests/client-money.test.ts`, `tests/ledger.test.ts`. Not yet
checked mechanically: that no `Number()` reaches a money decision. A source scan
would catch it and does not exist.

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
  opposite, and did: see `periodName` in `src/client/pages/BudgetsPage.tsx`.
  Anywhere a date names a period rather than a day, it is rendered as the period.

*Checked by:* `tests/recurrence-dates.test.ts`, `tests/locale-detection.test.ts`.

## Naming

**House.** One concept, one spelling, on every surface.

- **camelCase** in JSON bodies, query strings, tool arguments and TypeScript.
  **snake_case** in database columns and CSV headers. The boundary is the ORM and
  the CSV parser, and nothing else translates.
- **A name is the same word on every surface.** A `categoryId` in a tool argument
  is a `categoryId` in a request body and a `category_id` in a column. Where the
  browser calls something one thing and a tool another, the tool is wrong: an
  agent and a person are looking at one ledger.
- **Enumerations are lowercase**, with the multi-word ones snake_case
  (`credit_card`, `last_day`). Four casings accreted before this rule; new ones
  follow it.
- **A boolean is named for what being true means** (`includeArchived`,
  `allowDuplicate`), never for what it disables.

*Not checked mechanically.* A naming registry would need to know what a concept
is, so this one is review.

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

Worked sentences, so the voice is not reinvented per site:

| Situation | Message |
| --- | --- |
| Amount empty | Enter an amount |
| Amount not a decimal | Amount must be a number, like 24.50 |
| Amount negative where it may not be | A budget cannot be negative. Use zero to budget nothing. |
| Date empty | Enter a date |
| Future-dated committed entry | Date must be today or earlier |
| Split legs do not sum | The legs must add up to 100.00. They currently add up to 94.00 |
| Transfer with one account | Choose the account the money went to |
| Version conflict, browser | This changed while you were editing it. Reload to see the current version |
| Version conflict, agent | This changed since you read it. Read it again and retry with the version in `details.currentVersion` |
| Idempotent replay | This was already saved |
| Stale bulk fingerprint | The selection changed. Preview the selection again and retry |
| Cursor under a changed ordering | This page marker was issued for a different order. Start from the first page |
| Row belongs to another tenant | Not found |

*Checked by:* `tests/api-security.test.ts`, `tests/mcp-output.test.ts`. Not yet
checked: that every code an interface can emit is in the published enumeration.

## The glossary

**House.** The product's nouns, one definition each, and the same word on every
surface. Not a rule with a mechanism of its own: it is the vocabulary the rules
above are written in, and the thing to check a new label or tool description
against.

*Not checked mechanically.*

| Word | Means | Not |
| --- | --- | --- |
| **Account** | Somewhere money sits: a bank account, a card, a wallet. | A user. A person has a sign-in, not an account. |
| **Counter-account** | A server-owned account, one per kind and currency, holding the other side of an entry. | Anything a person can name, see in a picker, or transact with. |
| **Transaction** | One movement of money, of three shapes: deposit, withdrawal, transfer. | A posting. |
| **Posting** | One signed amount against one account on one date. The thing every figure is computed from. | A transaction. A transaction has at least two. |
| **Leg** | One category's share of the counter-account side of a split. | A posting, although each leg has its own. |
| **Split** | One entry whose counter-account side is cut into legs. | Two transactions. |
| **Category** | What a movement was for. | An account. |
| **Payee** | Who the money went to or came from, derived from transaction text. | A stored record with an id. |
| **Staged transaction** | A proposal in the review queue. Affects no balance. | A draft of a saved thing. Nothing about it is in the books. |
| **Budget plan** | A standing amount for one category, per period, over a window of periods. | A posting. Nothing in budgeting writes one. |
| **Budget entry** | An amount for one period, overriding the plan for that period alone. | A plan for one period. |
| **Recurrence** | A saved shape and a schedule that proposes a staged row on its due date. | Something that posts. |
| **Template** | A saved shape with no schedule. | A recurrence. |

Where the UI and a tool description disagree about a word, this table decides.

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
- **No em dashes.** They are a house preference and the codebase is consistent
  about it.
- **Numbers a person reads are formatted.** Money through `formatMoney`, dates
  through `formatDate`, counts spelled out below ten in prose.

*Not checked mechanically.* This is review, and it is the one place that is
honestly fine as review, because the thing being judged is whether a sentence is
true.
