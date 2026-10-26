# MCP

The agent surface: 82 tools over Streamable HTTP at `/mcp`, authorized by OAuth
2.1 on three scopes, built per request in `src/server/mcp.ts`.

[`common.md`](common.md) decides money, dates, naming, the error envelope, the
glossary and the voice, and this guide does not restate any of it. What is left
is the part only an agent has: what becomes a tool, what its schema owes a model
that cannot see the screen, what a description must say before a model calls
something it should not, and what the whole surface costs to load.

## The revision this is written against

**Binding.** The target is Model Context Protocol revision **2026-07-28**, as
[`index.md`](index.md) states. Revisions are dated and the current one is the
contract. Anything in this guide that contradicts it loses.

- **A document naming a revision names this one.** Much MCP writing still cites
  2025-06-18. That revision negotiated once at initialize, had no `title` on a
  tool, no mandatory `server/discover` and no deprecation policy, so a rule
  written against it describes a protocol that no longer exists in that shape.
- **Statelessness is normative.** "The Model Context Protocol (MCP) is a
  stateless protocol: all the information needed to process a request is
  contained in the request itself." This surface holds by construction rather
  than by discipline: `handleMcpRequest` builds a server and a transport per
  request (`src/server/mcp.ts:2425-2460`), so there is no connection to carry
  state in — and so anything but a POST is a `405` (`methodNotAllowed`,
  `:2299`), because a stream nothing can write to and a session that does not
  exist are not things to hand out.
- **Where the target is not met, say so rather than claiming it.** The installed
  SDK, `@modelcontextprotocol/sdk` 1.32.0, declares
  `LATEST_PROTOCOL_VERSION = "2025-11-25"` and supports nothing newer, so the
  endpoint negotiates 2025-11-25 today. Three 2026-07-28 obligations are
  unreachable from here and none of them is a design decision: `server/discover`,
  the caching hints (`ttlMs` and `cacheScope`) that a `resultType: "complete"`
  result MUST carry, and per-request version negotiation through `_meta`.
- **When the SDK ships the revision, `cacheScope` on `tools/list` is `private`.**
  The tool list varies by scope, so a shared cache holding a `public` list would
  serve a `ledger:write` tool list to a `ledger:read` token. The specification's
  own `tools/list` example ships `public`. Do not copy it.

*Checked by:* `tests/mcp-protocol-surface.test.ts`, which compares the SDK's
`LATEST_PROTOCOL_VERSION` and its package version against the two this section
names. It fails on the day the SDK is upgraded, which is the day this section
needs rereading, and the failure message is the reading list: `server/discover`,
the `ttlMs`/`cacheScope` hints, `_meta` negotiation, and `cacheScope: "private"`
on `tools/list`. That it fires on a dependency bump is the argument for it — an
SDK line is approved in a minute and nothing else here would ask anybody to
reread four bullets.

## Tool, resource or prompt

**Binding**, and the specification's own rule is worth quoting rather than
paraphrasing. Tools are "model-controlled, meaning that the language model can
discover and invoke tools automatically". Resources are "application-driven,
with host applications determining how to incorporate context based on their
needs". Prompts are "user-controlled... with the intention of the user being
able to explicitly select them for use".

- **Tool when the model decides. Resource when a person attaches. Prompt when a
  person invokes by name.** Simple Balance ships tools only: `registerResource`
  and `registerPrompt` appear nowhere in `src/server`.
- **Two conditions reopen it.** Somebody wanting to pin a report or a chart of
  accounts into a conversation is asking for a resource. A recurring named
  workflow, "reconcile last month", is asking for a prompt. Neither has been
  asked for.
- **The money guides are tools, although what they return is text.**
  `list_learn_articles` and `get_learn_article` hand an agent prose rather
  than records, which reads like the resource case, and the rule above decides
  it the other way because of who reaches for them: what was asked for is that
  somebody asking how to balance an account, or what net worth is, be answered
  from the guides, and that is the model choosing one in the middle of a
  conversation. A resource waits for a person to attach it, and in most clients
  the model cannot open one on its own. The guides do carry both conditions
  above inside them, and neither is met yet: a person wanting a guide pinned
  into a conversation is the resource case, and "balance my checking account
  for last month" walked through with the guide and the tools is the named
  workflow a prompt is for.
- **`list_payee_suggestions` is correctly a tool**, although it looks like an
  argument completion. `completion/complete` covers `ref/prompt` and
  `ref/resource` only; there is no `ref/tool`.

*Checked by:* `tests/mcp-protocol-surface.test.ts`, over the source rather than
over a connection, since a resource registered behind a condition no test sets
up would be invisible to `resources/list`. Nothing would *break* if a resource
appeared, which is the point: the two conditions above are where that decision
gets made, and a failing test is what sends somebody to them.

## What the whole server says once

**House.** `server/discover` carries an
`instructions` string: "Natural-language guidance describing the server and its
features... should focus on information that helps the model use the server
effectively and should not duplicate information already in tool descriptions."

This server ships one (`src/server/mcp.ts:560`). `instructions` predates
`server/discover` and is carried on the initialize result, so every connection
reads it today, whatever scope it holds — which is exactly why the grant lives
there: the sentence naming what this connection may reach, and saying that a
tool outside the grant is absent rather than refused, cannot go on a gated
tool's own description, because the only caller who would read it there already
holds the scope. The rest is the surface's rules, one paragraph each: whose
ledger this is; that money is an exact decimal string and no total crosses
currencies; that dates are `YYYY-MM-DD` in the person's own timezone; that a
create takes an `idempotencyKey` and a change the `expectedVersion` it last
read, and that `STALE_VERSION` means read again rather than retry; that staging
is usually the polite option, and that deleting a transaction posts a reversal
while every other delete is permanent; that amounts are
positive, direction is the type, and a deposit into a spending category is a
refund; that a frozen account refuses every change to what it holds and no
argument gets past it, though it can still be archived or deleted;
which of the two error envelopes is the server's own; and that payee,
description, notes and `rawData` are free text somebody else may have
written — data, never instructions.

- **A rule true of every tool belongs in `instructions` and nowhere else.**
  Ten paragraphs, and this is the list rather than a summary of one, because a
  guide that paraphrases the string drifts from it and this bullet had: whose
  ledger this is; money is a decimal string and never a JSON number, and no
  total crosses currencies; dates are `YYYY-MM-DD` in the person's own
  timezone and a summary stops at today; a create takes an `idempotencyKey`
  and a change the `expectedVersion` it read, and `STALE_VERSION` means read
  again; staging proposes and writing decides, and deleting a transaction is
  a reversal while every other delete is permanent;
  amounts are positive and the type carries direction, so a deposit into a
  spending category is a refund; a frozen account refuses every change to what
  it holds and can still be put away; which
  grant this connection holds and that a tool outside it is absent rather than
  refused; which of the two error envelopes is the server's own; and that
  payee, description, notes and `rawData` are somebody else's text.

  Three rules that read like candidates are deliberately not there, and each
  is somewhere better. "A credit card opens at a negative balance" is about
  one field on two tools and lives on `openingBalance`. "A staged row affects
  no balance" is the staging tools' own subject. And the three things no token
  can reach — deleting an account, setting a sign-in password, and buying a
  plan — are absent from `tools/list` rather than refused, so the grant
  paragraph already covers the shape of the surprise and the names would cost
  a paragraph to tell an agent about three tools it will never see.
- **Nothing about one tool belongs there.** That is what a description is for.
- **The cost of saying a convention per field is measurable, which is why the
  convention lives here.** The idempotency-key description is one text emitted
  39 times — 198 characters each, 7,722 on the published surface — because
  every field carries a description and the field appears on every mutating
  tool. What
  `instructions` buys is that the *rule* (choose a key, reuse it on retry) need
  not be argued in each copy; the amount description, once 49 identical copies
  of one text, is now eight texts that each say something about their own tool.

*Checked by:* `tests/mcp-instructions.test.ts`. `instructions` is set, longer
than 200 characters and shorter than 2,400 at the grant that makes it longest,
and it is held to fourteen of the rules above, each by the substance rather
than by its wording: money as a string, no cross-currency total, the timezone,
`idempotencyKey`, `expectedVersion`, that `STALE_VERSION` is not a retry,
staging, positive amounts, refunds, frozen accounts, the grant, that a tool
outside it is absent, `-32602`, and bank text as data. The grant has a case of
its own, because it is the one sentence here that is not a constant and a
string that reads correctly for a read-only token would be a lie to every other
one. **"Whose ledger this is" is not among them**, and it is the first sentence
in the string: it is prose nothing would notice losing.

### A refusal a whole tier of tools can return is said once, in the server's instructions

**House, and the gap between the two rules above.** The section settles what is
said once; the descriptions section asks each tool to name its own refusals. A
refusal class that cuts across the tier falls between them, and the
frozen-account refusal is the worked case.

One guard, `assertAccountsWritable` (`src/server/services/accounts.ts:856-868`),
gates about a dozen write paths from four services — `accounts.ts`,
`transactions.ts`, `categories.ts` and `payees.ts` — so roughly thirty-five
write tools can return it. Exactly one description mentioned it, and that was
`set_active_accounts`, the tool the freeze is *about*: the one caller that did
not need telling. An agent writing an entry met a sentence it had never been
warned about, under `VALIDATION_ERROR`, which on this surface means fix the
arguments — and no argument it could change would ever get past it.

**The obvious alternative was to name it in each of the thirty-five write
descriptions, and that is the 4,000-character case the section above already
refuses.** It is also the wrong place twice over: most of those tools name no
account at all (an entry deleted by id, a payee merge that walks the whole
ledger), so the sentence would be about a parameter they do not have. So it
goes beside the grant sentence, which every connection reads whatever it holds
(`src/server/mcp.ts:586`), and it has somewhere to send the agent, because
`whoami` already carries the plan, its ceiling and how much of it is used.

The ceiling moved to pay for it: the instructions budget went from 2,000 to
2,400 characters, which is the same one-line justification the payload table
demands lower down, and about a tenth of what the per-tool spelling would have
cost.

*Checked by:* `tests/mcp-guide.test.ts`, which proves the premise before the
rule — it counts the services reaching the guard and fails if that is no longer
several — and then holds `instructions` to naming the refusal, to saying that
no argument gets past it, and to naming the two tools that answer "why". A
guard that shrinks back to one service fails it too, which is the rule asking
to be argued again rather than quietly standing.

## Naming

- **Binding.** A tool name is drawn from `A-Z a-z 0-9 _ - .`, is 1 to 128
  characters, and is unique within the server. All three are the
  specification's, not this product's, and none is available to change.
- **House.** Within that, `verb_noun` in snake_case, following VS Code's MCP
  guide. 81 of 82 tools follow it; `whoami` is the exception and it is a good
  one, because it is the name the thing has.
- **House.** Arguments are camelCase, which is `common.md`'s naming rule and
  also what VS Code's MCP guide recommends. Recorded as an alignment rather than
  a new decision.
- **House.** `name` is for a machine and `title` is for a person. They do not
  converge, because `title` is what an approval dialog shows and a person acts on
  what it says, and the rule that follows is that no title may claim another
  tier's verb. `create_transaction` was titled "Commit a transaction", which is
  the sentence `commit_staged_transactions` owns: a person approving that dialog
  could believe they were releasing a row they had already reviewed rather than
  writing one they had never seen. It is titled "Write a new transaction
  straight into the books" (`src/server/mcp.ts:2062`), and "Commit" now
  appears in exactly one title on this surface, on the tool that commits.
- **Contested, decided 2026-08-23: no namespace prefix.** The specification puts
  disambiguation on the client: aggregating clients "SHOULD implement a
  disambiguation strategy such as prefixing tool names with a server identifier".
  Anthropic puts it on the server, with the format `{service}_{action}_{resource}`
  and the only evaluation evidence anybody has published. This product picks the
  specification's side, because it is a single-domain server whose user is
  unlikely to be running a second ledger, and because renaming the whole
  surface breaks every configured client while
  `notifications/tools/list_changed` reaches only clients that opened a
  `subscriptions/listen` stream. **Reopen it** if this
  deployment ships a second server, or if a collision is observed in the wild. If
  it is reopened, dual-register old and new names for a release and mark the old
  ones deprecated in their descriptions; the notification is not a migration
  plan on its own.

*Checked by:* `tests/mcp-parity.test.ts:373-378` fails a registered tool that
`docs/mcp.md` does not name, because "the guide fell seventeen tools behind
before anything noticed". *Also checked by:* `tests/mcp-parity.test.ts` for the
one regex that covers the rest — the character set and the 1-to-128 length, the
`verb_noun` shape with `whoami` as the single named exception, that no two
titles read alike, and that no title but `commit_staged_transactions`'s contains
"commit".

## Descriptions

**House.** A description is "a 'hint' to the model", and Anthropic's position is
that it is "by far the most important factor in tool performance". The five
parts, in order:

1. **What it does**, in one sentence, in the ledger's vocabulary from
   `common.md`'s glossary.
2. **When not to call it, and what to call instead.** This is the part most
   often missing and the part that saves the most calls. `list_accounts` should
   say that its `balance` includes future-dated postings and that
   `get_account_balances` separates what has moved from what is still to come.
3. **What it does not return.** `get_staged_transaction` returns
   `repeatsStagedRow` as null always, because only the list computes it, and null
   there means "not compared" rather than "no".
4. **The refusals, named.** A transfer cannot be split. A daily schedule of one
   or two days cannot use a business-day policy. An entry-level category, by id
   or by name, cannot be sent alongside `legs`: `checkLegs`
   (`src/shared/domain.ts:489-496`) refuses it with "Send either a category or
   legs, not both".
5. **What a person must be asked first, and what cannot be undone.** A
   description tells an agent what it cannot perceive. The model sentence on the
   surface is in `set_preferences`: "Set the theme only when asked to: it is what
   their screen looks like, and you cannot see it."

Further rules:

- **House.** A floor of three to four sentences. Measured today: 82
  descriptions, 36,022 characters, median 373, range 33 to 1,980, and **7 under
  100 characters**. The distribution is bimodal, but the terse half does not
  cover the dangerous tools: `commit_staged_transactions` is 431 characters and
  tells the agent to confirm with the person first and what `DUPLICATE` means,
  `merge_categories` is 508 and `merge_payees` 169, and each says there is no
  undo.

  `list_transactions` was the one under-100 description that mattered — 54
  characters on the entry point to the ledger's largest collection, mentioning
  none of the ordering and cursor rules this guide gives a section to. It now
  says the default order, the page size and its ceiling, that a cursor is bound
  to both its ordering *and* its filters, that `cursorAvailable` says whether
  this ordering can be resumed at all, and that staged rows are somewhere else.
  `list_accounts` was the other: it now says that `balance` counts future-dated
  postings, which is the one thing about it an agent would otherwise get wrong,
  and names the two tools that answer the neighboring questions.

  What is left under 100 characters is seven: five reads of one record by its
  id, `create_category`, whose contract is a name, a kind and a group and which
  now names all three, and `create_staged_transaction`, whose draft carries a
  description on every field. That is the honest floor rather than a number to
  drive down. A sixth read left the list by learning to say something:
  `get_transaction_template` was "Get one saved transaction template by ID",
  and nothing on the surface said how an agent uses a template — its draft goes
  into `create_transaction` or `create_staged_transaction` with `templateId`
  set, or the template never counts the entry. Both template reads say so now,
  which is rule 2's "what to call instead" on the one pair of tools whose whole
  point is the call after them. The list was once
  twelve, and the sentence said all twelve had a contract that was a bare id or
  a name, which was not true of four of them: `list_staged_transactions` took
  sixteen parameters, with the same cursor rules `list_transactions` had been
  rewritten to state; `create_account` gave no hint of the account limit; and
  `delete_category` and `archive_category` said nothing about what went with
  the category or how to come back. All four now say it.
- **House.** A tool that changes the ledger irreversibly says so and asks for
  confirmation, in the way `archive_account` does: "This moves money in the
  books, so confirm it with the person first." Measured: 32 of the 32 `destructiveHint` tools carry a confirm-or-undo word and 0 do not, having been
  7 and 20. The wording differs by what the operation actually costs, because
  "confirm first" and "this cannot be undone" are different warnings: a merge
  and a payee merge say there is no undo, a bulk write says to show the count
  with `dryRun` first, and a transaction delete says it posts a reversal and can
  be undone. The word counted is "confirm" or "can be undone" and nothing
  softer: the count accepted "permanent" and "restore" for a while, so two
  deletes that asked nobody and an archive whose only qualifying word was its
  own verb were counted as asking.
- **House, narrowed 2026-08-25: only a tool whose behavior changes with scope
  names one.** Scope is enforced by non-registration, so a tool the caller
  cannot use is absent from discovery: "needs ledger:write" on `create_account`
  is read only by an agent that already holds ledger:write, and never by the one
  that does not. It could not have mitigated the `insufficient_scope` challenge
  either, back when that was missing, because the agent that got "Tool not
  found" never saw the description. The challenge is met now — it is the
  `WWW-Authenticate` rule further down — and the reason this sentence stands is
  that it is the argument against writing the tier on 41 tools, not a record of
  an outstanding gap.
  Writing it on all 41 gated tools (36 write-only, 5 stage-tier) would add about
  4,000 characters of one convention repeated per tool, which is the case "What
  the whole server says once" exists to refuse. So the tier is said once, in
  `instructions`, which every connection receives whatever it holds, and which
  names the grant this connection actually has and says that a tool outside it
  is absent rather than refused. What a description owes is the *behavior*:
  `stage_csv`, `update_staged_transaction` and `bulk_edit_staged_transactions`
  do different things under `ledger:stage` than under `ledger:write` — a
  category is matched but not created, and a category emptied by the edit is
  left standing rather than removed — and each says so. `create_budget_plan`
  keeps its sentence for a different reason: it answers "why can I not propose
  this?" for the tier that can write, which is a fact about the propose/decide
  boundary rather than a scope challenge.
- **Contested.** A 2026 study of 856 tools found that systematically augmenting
  descriptions improved task success by a median of 5.85 points but increased
  execution steps by 67% and regressed 17% of cases, and that removing worked
  examples did not degrade performance. So: the floor stands, and **worked
  examples go in `instructions`, not in descriptions**. A description that
  invites exploration costs calls.
- **House.** Backticks mark an identifier: a tool name, a field name, or a
  literal value an agent sends. The narrower "literal only" rule is not the one
  the surface keeps, and the wider one is the useful one, because an identifier
  set in prose is an identifier a model retypes wrong. This stood for a while on
  an enumeration of the ten descriptions that used backticks, every one of which
  fit — and nothing looked at the descriptions that did not, ten of which named
  another tool in bare prose. A tool's name is the one identifier a test can
  find without a judgment, so that half is checked: every registered tool a
  description names is set in backticks. Field names and literals are still a
  reviewer's, because telling a field from an English word is the judgment.
  *Checked by:* `tests/mcp-measurements.test.ts` ("sets every tool it names in
  backticks").
- **House.** One person and one spelling, per `common.md`. The surface drifted
  between "this user's" and "this person" — two descriptions against seventeen —
  and between "normalisation" and "normalization". Both are settled the way the
  product's prose is: "this person", and the American spelling. The
  `normalizedName` **field** was already American while the prose around it was
  not, which is why the check excludes it by name — a field name is published
  contract and an identifier rather than prose, and it could not turn over with
  the sentences even when they were on the other side. The exclusion stays: it
  is what keeps the check's positive control honest rather than counting the
  field as evidence that the prose says the word.
- **House, and this guide owns it for the whole set.** Any convention an agent
  must obey appears in a tool or field description, not only in `docs/mcp.md`.
  An agent never reads the prose. `docs/mcp.md:107` states the principle
  already, "Fields carry descriptions, so an agent reading the schema learns the
  conventions that matter"; what makes it a rule is that a convention written
  only in the guide is a convention that has not shipped.
  [`writing.md`](writing.md#keeping-a-document-true) cites this rather than
  restating it.

*Checked by:* `tests/mcp-measurements.test.ts` for the spellings, which counts
the losing one and holds it at zero — a count rather than a list, so a
seventeenth "this person" needs no edit and a third "this user's" fails. And
`tests/mcp-parity.test.ts:488-506`, which asserts only
`length > 30`. All 82 pass, including the 7 under a hundred characters. The same
file also holds the set of descriptions allowed to name a scope at all
(`:555-567`), which is the narrowed rule above, and pins the naming and title
rules (`:522-543`). *Also checked by:* `tests/mcp-measurements.test.ts:180-190`
for the warning word on a destructive tool, which is the sentence above read
back off the surface: it holds both of that sentence's numbers, so a destructive
tool added without a confirm-or-undo word leaves the first alone, moves the
second off zero, and fails. *Also checked by:*
`tests/mcp-measurements.test.ts:368-391`, which reads every `snake_case` word in
a description as a claim about a tool and fails on one that is not registered.
Twenty-one descriptions name a tool, and the failure it catches is a renamed
tool leaving the sentences that named it behind: the agent that follows one
gets a protocol error, with nothing in the reply saying the instruction was
stale rather than its own call malformed. Its floor is on a different quantity
and the guard says so now: it counts *occurrences*, because a description
naming two tools is two claims — thirty-two today, against a floor of nineteen.
*Review only:* whether a description actually teaches, as opposed to being long
enough. The only real
check for that is the evaluation below, and even that measures the outcome.

### A tool named inside a field description is a claim like any other

**House, and it is the check above with its reasoning followed to the end.**
That check reads every `snake_case` word in a *tool* description as a claim
that the tool exists, because a renamed tool leaves the sentences that named it
behind and the agent that follows one gets a protocol error with nothing saying
the instruction was stale.

None of that reasoning stops at the tool description, and the surface no longer
does either. **Thirty-one field-description sites name a tool**, forty claims
between them: `frozen` sends an agent to `set_active_accounts` on six result
schemas (`src/server/mcp-output-schemas.ts:165`), `accountLimit` and
`activeChoicePending` on `whoami` to `create_account` and `set_active_accounts`,
`rollover` and `amountRule` to `get_budget_report` on four budget tools,
`importBatchId` to `list_import_batches` on five staged-row shapes, `notes` and
`defaultAccountId` on `stage_csv` to `preview_csv` and `list_accounts`,
`simpleBalanceExport` and `suggestedMapping` on `preview_csv` to `stage_csv`,
`ledgerFile` on the two tools that read one to `export_ledger_file`, `legs` on
the two staged drafts to `create_transaction`, `slug` on `get_learn_article`
to `list_learn_articles`, and `clientId` on `revoke_connected_agent` to
`list_connected_agents`. When this check was written there were seventeen,
nine of them that release's, including every one on an account result, and not
one of them was covered.

**Leaving it because the tool-description check will catch the rename is
wrong**, and that is the whole argument. A rename changes the registry and the
tool descriptions together, both inside `src/server/mcp.ts`, which is why that
check is easy to satisfy by accident. All but one of the field sentences live
in `src/shared/domain.ts`, `src/shared/csv.ts`,
`src/shared/ledger-file-import.ts` and `src/server/mcp-output-schemas.ts`, so
they go on naming the old word with every test green.

The implementation is one walk over field descriptions using the traversal the
file already has, with one rule the tool-description check does not need: **a
`snake_case` word a tool publishes as a value it accepts is a value, not a
tool.** `sum_of_children` is how a category group is budgeted, `credit_card` is
an account type, `next_business_day` is a weekend policy — twenty such words
across the surface, against three in the tool descriptions, which is why that
check could keep a hand-written exemption list and this one cannot. Reading the
enums off the same tool's schemas makes the exemption derive itself, so a new
enum value named in its own description needs no edit and a new tool name still
has to exist.

*Checked by:* `tests/mcp-guide.test.ts`, which walks both schemas of all 82
tools and fails by naming the tool, the field and the word. Its floor is 17
sites, with the claim count held at or above it, so a traversal that stopped
matching cannot pass on nothing — the failure the tool-description check below
it already learned to guard against.

## Inputs a model cannot get wrong

**House.** The goal is not to reject an invalid call. It is to make one
unrepresentable, so the model's own sampling cannot produce it.

- **Flat over nested, and enums over free text.** A nested object is a shape a
  model has to hold; an enum is a choice it cannot get wrong. Measured: 78
  enums across the input schemas, and 192 more on the output side, where they
  constrain nothing a model sends but are what
  `tests/mcp-output.test.ts:252-275` exists to guard. Half of that output figure
  is the error code, published once per tool for the reason the errors section
  gives. Nesting exists where the
  domain is nested (`legs`) and nowhere else.
- **Unambiguous names.** `categoryId`, never `category`. This is `common.md`'s
  naming rule with a reason attached: a parameter named for a concept rather
  than for the value it takes is a parameter a model fills with the wrong type.
- **Ids are `format: "uuid"`.** See the budget section for why the pattern
  beside the format is a defect rather than a second safeguard.
- **A name beside an id, where the server can resolve it.** `categoryName`
  (`src/shared/domain.ts:555-563` for the entry-level field,
  `:422-429` for the leg-level one, which defers to it) lets an agent send the
  human word: it is "matched case-insensitively against your existing categories
  and created only if it is genuinely new", and `categoryId` wins if both are
  sent. It is on 7 tools. The creation half is why `stage_csv` reports the
  resolution as deferred under `ledger:stage`; see the scope section. This is
  Anthropic's finding that "resolving
  arbitrary alphanumeric UUIDs to more semantically meaningful and interpretable
  language... significantly improves Claude's precision" applied at the schema
  rather than in a preamble. **Considered for accounts and declined.** An
  `accountName` looks like the same idea and is not, because what `categoryName`
  actually buys is the creation half: a name matching nothing becomes a
  category. An account can never be created by being named — it carries a
  currency, a type and an opening balance, and inventing one from a transaction
  would post money into an account nobody opened. So `accountName` could only
  resolve or refuse, and refusing would be the common case: the only safe match
  is exact ignoring case and space, so "amex" finds "Amex" and "amex gold" does
  not find "Amex Gold Card" — failing in exactly the situation where a name was
  all the agent had. It would also widen every account field on the surface from
  a uuid to a union, to save a `list_accounts` call the agent usually has to
  make anyway.
- **Money is a decimal string with a pattern, and dates are `YYYY-MM-DD` with
  one.** Both from `common.md`. **Binding.** `AGENTS.md`: "Never represent money
  with JavaScript/JSON floating-point numbers." A tool argument is a boundary
  like any other, and a JSON number here is the same defect as a JSON number in
  a response body.
- **House.** A no-argument tool publishes
  `{"type": "object", "additionalProperties": false}`, which is the
  specification's recommended form, and which `whoami` and `summarize_own_data`
  now publish along with everything else. Measured: 82 of 82 input schemas are
  closed and 0 are open, having been 14 and 57. An open object accepts a
  hallucinated argument in silence and returns success, which teaches the model
  the argument worked and that whatever it thought the argument did is a thing
  this surface does; the next call leans on it. Tools close their own shape with
  a `toolInput` helper or a `.strict()` at the tool boundary rather than by
  closing the schemas they share with `/api/v1`, because what a browser may send
  and what an agent may invent are different questions.
- **Binding, and now true of every field rather than of every parameter.**
  Measured: **0 of 760 carry none**, having been 146 of 225 at the top level and
  263 of 673 once anybody counted the fields inside `draft`, `shape`, `patch`,
  `selection`, `schedule` and `mapping` — which is to say the fields an agent
  has to fill in to write anything. The measurement said zero for a year because
  it walked one level.

  Most of the distance came from describing a shared thing once rather than at
  each site that uses it. `list_transactions` was the worst case, publishing
  `sort`, `direction`, `cursor`, `page` and `limit` with nothing on any of
  them — exactly the five an agent has to guess at — and those five are shared
  by every list. One described `id`, one `expectedVersion`, one `dryRun`, one
  `selection`, one `patch` and one `expectedVersions` covered ninety more
  across twenty-seven tools. The last thirty-three were genuinely per-tool and
  were written one at a time.

  A description says what the parameter is *for* and what goes wrong when it is
  wrong, not what its type is — the schema already carries the type.
  `decimalSeparator` says that getting it wrong misreads an amount by a factor
  of a thousand rather than refusing it; `dateFormat` says 03/04/2026 is two
  different days and nothing in the file says which. That is the half a model
  cannot infer.

  *Checked by:* `tests/mcp-measurements.test.ts`, which holds this at zero
  rather than at whatever this sentence claims. A new tool with an undescribed
  parameter fails the suite.
- **House, and the half a count cannot see: a shared description has to be true
  everywhere it is published.** `currencyCodeSchema`
  (`src/shared/domain.ts:249-254`) ends "An account's currency is fixed once it
  is in use", which is what somebody opening an account needs and is not what
  the parameter does on a listing. `currency` filters entries rather than
  accounts: it matches a row either of whose sides carries that code
  (`src/server/services/transactions.ts:1606-1613`), so a conversion comes back
  under both of its currencies and a filtered page is not a page in one
  currency, which is the thing an agent totaling it has to know. It used to
  read that way at five published positions — on `list_transactions` and
  `export_transactions_csv`, and inside `selection.filter` on
  `preview_bulk_transaction_selection`, `bulk_edit_transactions` and
  `bulk_delete_transactions`. **Done**, and in one edit rather than five:
  `listQuerySchema.currency` now carries a filter sentence of its own
  (`src/shared/domain.ts:2240-2244`), and the other four derive from it through
  `bulkTransactionFilterSchema`, which keeps the field and drops only paging and
  ordering (`:2261-2263`). **Five, and exactly five.** A sixth position was
  claimed here for a while, on `stageListQuerySchema` at `:2518-2519` — and
  those two lines are the `.omit()` that *removes* `currency`, because a draft
  carries no currency of its own. The claim was the opposite of what the code
  does, which is the worse kind of wrong in a sentence whose job is to say how
  many copies have to be kept in step. The shared sentence is untouched, because
  it is right where an account is being opened. `set_preferences`'s `defaultCurrency` was the same
  sentence in a third context and now says what a default is
  (`src/shared/domain.ts:4544-4546`).
- **House.** Where a mutual exclusion cannot be expressed in a schema that stays
  strict-compatible, state it in the parameter description and refuse it with a
  teaching error. The two bulk selection shapes and the leg-versus-category
  exclusivity are the cases.
- **Binding (a MUST NOT and a SHOULD).** Keep schemas bounded. Implementations
  "MUST NOT automatically dereference `$ref` values that resolve to a network
  URI" and SHOULD bound schema depth and subschema count as a denial-of-service
  defense, so heavy `oneOf`/`anyOf` composition is both a strict-sampling risk
  and a thing clients are told to refuse. Measured: 452 `anyOf` and 8 `oneOf`
  across the surface. 361 of the 452 are two-member nullable pairs, 143 of them
  on inputs; 149 of all the `anyOf` are on inputs and 303 on outputs. The 8
  `oneOf` are all on inputs and are the boolean-or-string-literal coercion. So the composition is
  shallow rather than deep, which is the property the bound is about, and it is
  overwhelmingly nullability rather than genuine union.

*Checked by:* `tests/mcp-parity.test.ts:569-590`, which pins three listings to
the schema their service actually parses, `list_transactions`,
`list_staged_transactions` and `list_import_batches`, because "a tool declaring
a wider schema than its service parses is worse than a missing filter".
`list_audit_events` is the fourth cursor-taking listing and is not pinned.
*Also checked by:* `tests/mcp-measurements.test.ts:435-442` for the closed
objects and `:459-490` for the described fields, both against the counts above,
so an open schema or an undescribed field fails the suite rather than the
sentence. *Also checked by:* `tests/mcp-money-arguments.test.ts` for the one
this section used to list as not checked, that no money argument is a number: it
walks every input schema off a live `tools/list` under all three scopes and
fails any node declared `number` or `integer` whose property name is a money
name. `stage_csv`'s `mapping` is its one registered exception, because the
values under it are headings in somebody's CSV rather than figures.

## Outputs, and what the surface costs

Measure before arguing. Re-counted over a real `tools/list` on 2026-10-01, at
roughly four characters to the token. Each earlier count had gone stale by
about a quarter within a release, which is what a measurement nothing pins
does, so the table and the composition line are now held by
`tests/mcp-measurements.test.ts`; only the pattern and per-tool figures below
them still answer to their date, and both had drifted again by the time this
date moved — which is the argument for pinning them rather than for recounting
them more often.

| Token holds | Tools | `tools/list` characters | Approx tokens |
| --- | --- | --- | --- |
| no ledger scope | 0 | `tools/list` is not offered at all | 0 |
| `ledger:read` | 41 | 199,881 | ~50,000 |
| `ledger:stage` | 46 | 240,698 | ~60,000 |
| `ledger:write` | 82 | 543,705 | ~136,000 |

Composition at the write tier: names 1,555, titles 2,027, descriptions 36,022,
input schemas 229,435, output schemas 257,020. **Descriptions are 6.6% of what
an agent loads; names, titles and descriptions together are 7.3%.** Output
schemas are 47.3%.

The rises were bought on purpose: describing the output fields whose names
mislead, publishing the error-code enum at 150 characters a tool and 12,300
across the write tier — each named in the rule it belongs to below — and, since,
the budget, group and recurrence tools arriving with full schemas. Dropping `userId` from
every schema and every payload took some of it back. `export_ledger_file` added
4,442 characters to every tier, measured on 2026-10-25 as a tier with and
without it, and declined to add tens of thousands more by returning the file as
one string rather than publishing the format's schema — the rule for that is
below. Reading a file back added the two tools that take that string:
`preview_ledger_file` at 13,514 characters on every tier and `add_ledger_file`
at 18,931 more at the write tier, measured the same way on 2026-10-25. Both
take the file as text for the same reason, and the preview's reply describes
this ledger's own records as plain records rather than by the format's schema,
which would have been some 28,000 characters more on every tier and cannot be
published at all: the format refuses a JSON number in an amount with a pipe,
and a pipe has no JSON Schema. Both grew after review, and on purpose: every
plan problem carries its numbers as fields, a planned record carries the
`copy` and `periods` the page explains it with, and a decision can carry the
`openingDate` and the budget-amount answers that let one set of decisions mean
the same thing in every part of a file.

The money guides added 5,523 characters to every tier, measured on 2026-10-26
as a tier with and without them: `list_learn_articles` at 2,306 and
`get_learn_article` at 3,217. That figure is the whole of what they will ever
cost here, because neither publishes anything the guides decide — the slug is a
string rather than an enum of the guides there are, and both descriptions name
topics rather than titles — so a sync of the guides moves no number on this
page. A test that fails after one says something other than the guides changed.

Handing an agent what the import page and the Accounts page already knew cost
2,767 characters at `ledger:read`, 2,910 at `ledger:stage` and 3,486 at
`ledger:write`, measured on 2026-10-26 against the commit before it. Most of it
is three reads: `preview_csv` at 1,064 for the column guess and the export
check, `whoami` at 537 for `activeChoicePending`, and 517 across the two
template reads for the sentence saying how a template is used. The
frozen-account correction is 94 on each of six account results, which is what
a sentence costs on a field every account tool publishes; that is why it says
what it must and stops.

The largest single contributor was not a tool. It was **352 copies of one
166-character UUID pattern, 58,432 characters, 11.0% of the whole surface**, and
the share was higher still at the smaller tiers. `"format":"uuid"` is emitted
beside every one of them, so the pattern bought nothing a client cannot get from
the format — and a client that cannot read `format: "uuid"` cannot use this API
anyway, since every id it will ever hold came from a list or a create.

They are gone, and it was one shared schema: `uuid()`
(`src/shared/domain.ts:17-24`), which is `z.string().uuid()` with
`.meta({ pattern: undefined })`. The metadata lands in the JSON Schema output,
where an undefined value removes the key Zod would otherwise have written; the
check itself is untouched, so a value that is not a UUID is still refused. The
write tier went 534,682 to 471,674 characters, the read tier 191,414 to 166,712
— **12% of the context an agent spends on this server**, or about sixteen
thousand tokens at the write tier. It was sixty declaration sites rather than
one, which is why the helper is exported from `src/shared/domain.ts` rather than
written at each of them.

After that, recounted 2026-10-01 and each 16 to 27% smaller than the figures
that stood here: `update_transaction` is 26,427 characters and
`create_transaction` 25,721, both still the two largest and both mostly input
schema. The third is no longer `get_staged_duplicate`: `update_recurrence` at
21,666 and `create_recurrence` at 21,353 went past it, and at 17,675 it is now
sixth. It keeps the distinction it was named for — 16,817 of those characters
are output schema, which is still the largest output schema on the surface,
where every tool above it is carrying an input schema instead.

The rules:

- **Binding.** `AGENTS.md`: "A tool whose result does not satisfy its declared
  output schema fails the call with an `Output validation error` naming the
  offending path, so a wrong schema breaks the tool rather than trimming its
  reply." This is stricter than the specification, which requires that servers
  "provide structured results that conform to this schema" and puts the checking
  on the other side: "Clients SHOULD validate structured results against this
  schema." Record the strictness as deliberate rather than as framework
  behavior that happens to be there. The failure it exists to stop is the quiet
  one: an enum pinned to a subset of the actor sources "makes every page of the
  audit log containing a new source come back empty"
  (`tests/mcp-output.test.ts:252-275`).
- **Binding.** One envelope, from `common.md`:
  `{ result: <success> | { error: { code, message, details? } } }`, published as
  a two-member `anyOf` by `mcpOutputSchema`
  (`src/server/mcp-output-schemas.ts:107-111`) and returned as both
  `structuredContent` and a JSON text mirror built from one serialization
  (`src/server/mcp.ts:238-245`), which is what the specification
  recommends: a tool returning structured content "SHOULD also return the
  serialized JSON in a TextContent block".
- **House, and worth stating because a client author will assume otherwise.**
  Because the published schema legitimizes the error member, a strictly
  validating client cannot tell success from failure by schema alone. `isError`
  carries that, correctly.
- **Contested, and Anthropic contradicts itself.** The engineering post says to
  "eschew low-level technical identifiers (for example: uuid, 256px_image_url,
  mime_type)"; the platform docs say to "return semantic, stable identifiers (for
  example, slugs or UUIDs)... and include only the fields Claude needs to reason
  about its next step". This product takes the platform position, because the next
  call requires `id` and `expectedVersion` and an agent that cannot name a row
  cannot correct one.
- **House.** Include what the next call needs and nothing else. `userId` used to
  be on every versioned entity in the output schemas — 37 property positions
  across 34 of the surface's then 71 tools, `required` at every one, and every
  one carrying the
  same constant: the id of the actor that authorized the connection. No agent
  could do anything with it. `AGENTS.md` says "Never accept a public `userId`",
  which is an input rule and does not by itself forbid publishing one; what it
  means here is that nothing on this surface will ever read one back, so the
  field failed this section's own rule rather than an invariant. It is gone from
  both halves. The four declarations that carried it no longer publish it
  (`src/server/mcp-output-schemas.ts`, the versioned entity block and the audit,
  preferences and identity results), and `toolResult` drops the key from the
  payload on the way out (`src/server/mcp.ts`), so the schema and the reply say
  the same thing. The strip is one walk rather than a mapping per tool, and it
  stops where the keys are somebody else's rather than this server's: a CSV
  preview's `rows` are keyed by the uploaded file's own headers, and a staged
  row's `rawData` is that same record kept beside the draft — on
  `create_staged_transaction` it is whatever the caller sent, so walking into it
  would let an agent stage a row and read back a different one. Audit
  `before`/`after` snapshots do lose it, which is display only — the stored row
  and the HTTP surface are untouched. `whoami` is not an exception: its own
  description already points an agent at `clientId` as what tells one caller
  from another. The two edits had to land together, and it is the client that
  holds them to each other: the SDK client compiles the published JSON Schema
  and validates every reply, so a schema still declaring `userId` as `required`
  would have refused a payload that had lost it, and a payload still carrying
  one would have broken `identityResultSchema`, the one closed object of the
  four, which publishes `additionalProperties: false`. The server's own check is
  the Zod schema rather than the published one, and it is not strict, so it
  would have stripped a stray key and passed either way — worth knowing before
  trusting it to catch a schema and a payload that disagree.
  `tests/mcp-output.test.ts` holds it: no output schema may declare a `userId`
  property except by named exception.
- **House.** Describe an output field whose meaning its name does not give — and
  only those. Measured: **1,990 output properties, 560 with a description**,
  having been 52, and having gone up by forty-eight when the input fields were
  described — a schema shared between a draft and the row it becomes carries its
  sentences both ways. `decimalSchema` and `timestampSchema` were bare `z.string()`,
  so an agent reading `list_accounts` learned that `balance` is "a string": one
  undescribed primitive repeated across more than a thousand properties. Both
  now say what they are, and most of the described count comes from those two
  plus `versionSchema` (`src/server/mcp-output-schemas.ts:49-64`). The rest of
  the surface is deliberately bare: nearly every undescribed name is `id`,
  `name`, `currency`, `date`, `payee` or `notes`, which already give their
  meaning, and where a sentence would buy nothing and cost the payload budget
  three bullets down — one 110-character sentence on `version` costs about 4,700
  characters, because it is emitted 42 times. What was missing was the closed
  list of fields whose names mislead, and the file already explained most of
  them in TypeScript comments an agent cannot read. Those are now `.describe()`,
  and the list is thirteen rather than the ten this paragraph named for a
  release: `version`, `legs` and `legCount`,
  `deletedAt` (voided by reversal, still in every balance), `archivedAt` (posted
  out to equity, and a different sentence on a category),
  `effectiveRate` (audit only, never applied), `templateId` (provenance, no
  foreign key), `externalId`, `status`, `repeatsStagedRow` (null is "not worked
  out", not "no"), `duplicateOfId`, `likelyDuplicateOfId`, and `chosen`.
  `tests/mcp-output.test.ts:425-439` is where that list lives, and it holds every
  published copy to carrying one, so a new result schema spreading
  an undescribed copy fails rather than passing a total nobody remembers to
  raise. **Read the list there rather than this sentence.** It stood at ten here
  for a release while the test held thirteen, so somebody writing a new result
  schema from this paragraph shipped it three fields short and met a failure
  naming a rule they had just read a shorter version of.

  `frozen` is the fourteenth in substance and is in neither list. It is held by
  `tests/active-accounts-mcp.test.ts`, which asks for more than a description:
  every published copy has to name `set_active_accounts`, and none may say the
  choice is the browser's — six account results told an agent exactly that while
  the tool that makes the choice sat in its `tools/list`. A field that needs a
  *particular* sentence rather than any sentence is why it has a file of its
  own, and it is named here because nothing else connects the two.
- **House.** "Nothing found" is never an error and never an empty content block.
  It is the empty collection with the shape intact. It also said the filters
  were echoed back, and no list on this surface does that — the page envelopes
  carry no filters and several lists are bare arrays — so the clause is gone
  rather than excepted everywhere.
- **House, against the vendor skill's advice.** JSON only, with the
  `structuredContent` mirror. No Markdown response format and no prose rendering
  of a figure. A decimal string rendered into a sentence is a decimal string a
  model may reformat, round, or add across currencies, and `common.md` rules that
  no cross-currency total exists.
- **House. A file an agent is handed is one string, not structure.**
  `export_transactions_csv` returns `{csv, rowCount, fileName}` and
  `export_ledger_file` returns `{ledgerFile, rowCount, fileName}`
  (`src/server/mcp-output-schemas.ts:540-546`, `:557-573`), and in both the name
  is the one the browser's download is saved under, worked out by the service
  rather than by each surface — the CSV's was the route's alone until 0.2.2, so
  an agent had to invent one. The bytes an import later
  checks are then the bytes that were exported, with nothing re-encoded on the
  way through an agent. Publishing the Simple Balance file's own schema as the
  result was the obvious alternative and is wrong here: it would put tens of
  kilobytes into every tier's `tools/list` for one tool, and tie the figures
  this section pins to the format, so a field added to a file would move them.
  What it costs is that an agent cannot read the file's shape off the schema;
  the description names the format token, and
  [`ledger-file.md`](ledger-file.md) is where the shape is written down. The
  same string goes back in: `preview_ledger_file` and `add_ledger_file` take
  `ledgerFile` as the text `export_ledger_file` returned, so a file passes
  from one copy to another through an agent with nothing re-encoded, and an
  agent never holds more than one part, because one export call is one.
  *Checked by:* `tests/integration/ledger-file-export.integration.test.ts`
  ("answers the MCP tool with the same file, held to its published schema"),
  over a real connection with output validation,
  `tests/integration/ledger-file-export-route.integration.test.ts` ("hands an
  agent the same file the browser downloads"), and
  `tests/integration/ledger-file-add.integration.test.ts` ("is two tools over a
  real connection, the add only behind ledger:write"), which hands both tools
  the text the exporter wrote, with output validation on. The CSV's name is
  held the same way, in the route file's "names the download and the agent's
  copy one way, dated where the person lives".
- **House. A money guide is one Markdown string, and the JSON-only rule above
  does not reach it.** `get_learn_article` returns the copy smpl.money publishes
  of a guide as `markdown`, byte for byte, inside the envelope, beside
  `inSimpleBalance`, the structured half
  (`src/server/mcp-output-schemas.ts:1296`).
  The JSON-only rule exists because a ledger figure rendered into prose is one a
  model may reformat, round or add across currencies. A guide's dollar figures
  were never ledger amounts: they are invented examples, the copy says so under
  every picture, and the tool's description says so again, so neither that
  rule nor `AGENTS.md`'s money invariant has anything here to protect. Breaking
  the guide into fields was the obvious alternative and is wrong for the file
  rule's reason: the copy is checked against the site by a hash of its exact
  bytes, and a guide reshaped on the way out could no longer be. *Checked by:*
  `tests/mcp-learn.test.ts` ("hands over a guide as the exact bytes the site
  publishes") and `tests/learn-pack.test.ts` ("are the copies they were synced
  as, byte for byte").
- **House.** The payload is a tracked number with a ceiling, the way the
  ten-thousand-row cap is. The ceiling is the measured figure above; a change
  that raises it names why in the same commit.

*Checked by:* `tests/mcp-output.test.ts:27-53` for the two-member envelope,
which requires every tool to publish an `anyOf` whose success member is concrete
rather than `{}`, and `:55-85`, which pins eight output schemas and one input
schema to a distinguishing substring. The same file walks every published schema
for the two output rules above: that no schema declares a `userId` outside a
named exception, and that every copy of the closed list of misleading field
names carries a description. *Also checked by:* `tests/mcp-measurements.test.ts:117-122` for the payload
budget, which is the one `JSON.stringify` and comparison this footer spent a
release calling the highest-value MCP test not yet written. It is written, it is
stricter than a ceiling — each tier's exact character count is parsed out of the
table above and compared against the live surface — and two other places in this
guide already said so. A reader of this footer went and wrote a test that
already existed.

## Paging and ordering

- **Binding.** Protocol pagination is opaque-cursor only and covers
  `tools/list`, `prompts/list`, `resources/list` and
  `resources/templates/list`. None of it constrains a `tools/call` result, so
  paging inside a tool result is this server's design and answers to `AGENTS.md`
  rather than to the specification.
- **Binding.** `AGENTS.md`: "A cursor records the order it was issued for and is
  refused under another; an ordering a keyset cannot resume offers no cursor and
  pages by number instead." Four tools take a cursor: `list_transactions`,
  `list_staged_transactions`, `list_import_batches`, `list_audit_events`.
- **House.** `nextCursor: null` means two things, end of list and ordering not
  keyset-resumable, and the envelope says which: `cursorAvailable` is on every
  page of both listings (`src/server/services/transactions.ts:1561`), and
  `nextCursor`'s own description says that null means either "last page" or
  "this ordering cannot be resumed" and points at the flag. Before it, an agent
  walking a ledger under `sort: "account"` got one page, a null cursor, and no
  way to tell a finished walk from an unresumable one short of inferring the
  fallback from `totalPages`, which the result carries beside `page`,
  `pageSize` and `totalCount` — numbered paging being the fallback the
  `AGENTS.md` sentence above prescribes.
- **House.** A default page size and a maximum are stated in the parameter
  description, because the specification's rule that "clients MUST NOT assume a
  fixed page size" is about the protocol's own lists and gives an agent no help
  here.
- **Binding (SHOULD).** `tools/list` returns tools in a deterministic order, so
  a client can cache the list and a prompt cache can hit. Registration order in
  `src/server/mcp.ts` is that order today and nothing pins it. At the write
  tier's half-million characters, measured in the pinned table above, the
  cache is worth more here than on most servers.

*Checked by:* nothing on the MCP side. The ordering and cursor rules are tested
at the service layer.

## Errors as a teaching surface

**Binding** for the split, **House** for the sentence, and `common.md` owns the
envelope and the worked sentences.

- **Binding.** A tool fault is a result with `isError: true`, not a protocol
  error, because "otherwise, the LLM would not be able to see that an error
  occurred and self-correct". Unknown tool and malformed request are protocol
  errors. `runTool` (`src/server/mcp.ts:251-290`) does this and its comment says
  why.
- **House, and a correction owed to the documentation.** There are two error
  envelopes and only one is this project's. The SDK validates `inputSchema`
  first, so a bad argument never reaches `runTool`. Verified over a real
  connection: `get_transaction {"id":"not-a-uuid"}` returns
  `{"content":[{"type":"text","text":"MCP error -32602: Input validation error:
  Invalid arguments for tool get_transaction: Invalid UUID at id"}],"isError":true}`,
  with no `structuredContent`, no `code` and no `details`. The rule: **the
  project envelope covers semantic refusals, `-32602` is the schema-failure
  contract, and anything an agent must branch on is raised as an `AppError`**.
  `docs/mcp.md` used to claim "Every tool returns both
  `structuredContent.result` and the same thing as JSON text", which was false
  for the failure an agent hits most; it now says which envelope carries which
  refusal, and the server instructions say it too, because an agent that reads
  `structuredContent` unconditionally breaks on its first typo.
  `tests/mcp-output.test.ts` pins the shape of that refusal and holds
  `docs/mcp.md` to naming it.
- **House.** The code list is closed and published. `serviceErrorCodes`
  (`src/shared/domain.ts:2784-2794`) is a `const` array rather than a bare
  TypeScript union precisely so `toolErrorSchema` can publish it as an enum
  (`src/server/mcp-output-schemas.ts:99-105`): a closed list exists so a caller
  can branch — `STALE_VERSION` means read it again, `DUPLICATE` may mean it
  already saved, `VALIDATION_ERROR` means fix the arguments — and it cannot
  branch on a type it cannot see. It is the service half of `apiErrorCodes` and
  not the whole of it, because the five transport codes refuse before any tool
  runs and can never reach a tool result. It costs 150 characters per tool and
  12,300 across the write tier's 82, which is the ceiling above being spent on
  purpose. Two sentences describe this cost — the other is in the payload
  section — and for a release they disagreed with each other and both were
  stale, which is the case for one of them citing the other rather than
  recounting. It gates nothing: the SDK skips output validation whenever `isError`
  is set, and every error path sets it, so a published enum can never drop a
  reply.
- **House.** A message names what was wrong and the next call, by name. The
  specification's own worked example is a sentence, not a code: "Invalid
  departure date: must be in the future. Current date is 08/08/2025."
  `staleVersion` (`src/server/services/errors.ts:102-115`) used to say "This
  record changed since it was loaded. Refresh and try again", which is browser
  copy: an
  agent has nothing to refresh. It now carries both of `common.md`'s worked
  sentences — the diagnosis is the same for everyone and only the advice differs
  — as `message` and an optional `agentMessage` that only the MCP transport
  reads (`src/server/mcp.ts:275`), so the browser keeps its own words and
  neither caller is told to do something it cannot. The agent sentence names
  `details.currentVersion` only where the throw site actually carried it;
  thirteen of the fifty do not, and a refusal pointing at a field that is not
  there is the same defect one level down. `notFound`
  (`src/server/services/errors.ts:63`) no longer has a
  default message at all: all forty call sites name what was not found, and
  removing the default makes the compiler keep it that way.
- **House, and the worked rule's second case, met late.** The frozen-account
  refusal is the most common new refusal on this surface and it broke the rule
  above in the same way `staleVersion` had: browser copy, reaching an agent
  unchanged. `frozenAccountRefusal` (`src/shared/domain.ts:4091-4100`) ended "so
  its entries and details cannot change until you make it one of the active ones
  or upgrade",
  and both of those are moves an agent cannot make — and the first was not a
  move a person could make either once the one-time choice was made, so the
  browser's sentence now names the one that works: an account in use archived
  or deleted, or an upgrade. Upgrading is one of the
  three things reachable only from a session. Making it active is
  `set_active_accounts`, which the choose-once rule refuses once the choice has
  been made, so an agent that tries is refused twice. **It carries an
  `agentMessage` now** (`src/server/services/accounts.ts:860-866`): same
  diagnosis, and the advice is to work on an account that is not frozen, to read
  the plan and its ceiling from `whoami` and `frozen` from `list_accounts`, and
  to say that no argument it changes will help. The class rule that keeps it
  from having to be repeated on thirty-five tools is in "What the whole server
  says once".
- **Contested, recorded rather than resolved: it arrives as
  `VALIDATION_ERROR`.** That code means "fix the arguments" everywhere else on
  this surface, and here nothing an agent sends can be fixed. The code has an
  argued reason and the guide does not get to overrule it:
  `validateDraft` catches a validation error and files it as an issue on the
  staged row, so a frozen account makes a CSV import row *repairable* instead of
  killing the batch it arrived in, and archiving already refuses the same way
  (`src/server/services/accounts.ts:838-842`). `FORBIDDEN` would read more
  truthfully to an agent and would kill the batch; `CONFLICT` would read as
  something to retry. So the code stays and the sentence compensates, in two
  places: the `agentMessage` above and the instructions paragraph every
  connection reads. **Reopen it** if a second refusal of this shape appears, or
  if staged-row repair stops keying on the code.
- **House.** Where there is no recovery, the message says so and stops. Setting
  preferences has no undo. Do not invent one.
- **Binding.** Do not emit `-32002` or `-32042`; a missing resource is `-32602`.
  New application codes, if any are ever allocated, go outside `-32768` to
  `-32000`.

*Checked by:* `tests/mcp-output.test.ts` for the envelope shape, for the
published code enum on every tool, and for the `-32602` refusal that never
reaches one; `tests/api-security.test.ts` for the HTTP half, where a live
refusal's code is held to the published enumeration;
`tests/error-messages.test.ts` for the two version-conflict sentences and for
the agent one naming `details.currentVersion` only where the details carry it,
and `tests/integration/mcp-tools.integration.test.ts` for the sentence and that
field arriving together over a real connection. The frozen-account half has no
test of its own on this surface and does not need one: what an agent must be
told is the class rule, and `tests/mcp-guide.test.ts` holds that. *Not checked:*
that a message names the next call, which is prose and stays a reviewer's job,
and that a browser sentence reaching an agent unchanged is one it can act on —
two refusals have now needed an `agentMessage` and both were found by reading.

## Annotations, and what each one promises

**Binding.** The specification is explicit that "all properties in
`ToolAnnotations` are hints... Clients should never make tool use decisions
based on `ToolAnnotations` received from untrusted servers", and normatively that
"clients MUST consider tool annotations to be untrusted unless they come from
trusted servers". That is a rule for clients. For a server, an annotation is a
claim, and a false claim is a defect.

| Hint | Default | What it says here |
| --- | --- | --- |
| `readOnlyHint` | false | The call writes nothing. VS Code skips its confirmation dialog on it, so a wrong value silently removes a human gate. |
| `destructiveHint` | true, and meaningful only when `readOnlyHint` is false | The call can destroy or overwrite what is already in the ledger, as opposed to only adding to it. |
| `idempotentHint` | false, and meaningful only when `readOnlyHint` is false | Repeating the call with the same arguments has no additional effect. |
| `openWorldHint` | true | The tool reaches something outside a closed system. False here: every tool reaches one PostgreSQL database and nothing else. |

- **House.** Four shared constants, so a tool's class is one word at the call
  site: `readAnnotations`, `additiveAnnotations`, `destructiveAnnotations` and
  `unrecoverableAnnotations` (`src/server/mcp.ts:327-380`).
  Measured: 41 read, 9 additive, 32 destructive.
  Two of the thirty-two are unrecoverable, and that fourth constant is
  identical to the third on the wire, for the reason the bullet below gives.
- **Binding.** `readOnlyHint: true` is a claim the implementation must
  satisfy, not a category label. The specification's rule is addressed to
  clients; for a server an annotation is an assertion, and a false assertion is
  a defect rather than a preference.
- **House.** `destructiveHint` describes what the tool does to the ledger, not
  what scope it needs. Those are different questions and conflating them is how a
  staging tool ends up marked destructive. The rule below narrows it: what the
  tool does to the ledger is not the same as what it writes.
  `add_ledger_file` is the case that shows which way an import leans. Almost
  all it does is create — records nothing here is like, and rows for Staged —
  which is additive. But `preferences: "file"` replaces the timezone, default
  currency and theme this copy chose, and the timezone decides what today
  means, so one field overwrites a decision, and that is enough: it is
  destructive. Its description says to confirm that with the person and that
  `set_preferences` puts them back, and the field's own description says to
  confirm it too.
- **House, and the reason must be recorded or somebody will break it.**
  `idempotentHint: true` sits on every mutating tool, and it is true only because
  every one of them takes an idempotency key or an expected version — with one
  exception, which is the shape rather than a gap: `set_active_accounts` states
  the whole set it sets, so a replay lands on the state the first call left,
  which is what makes a PUT a PUT. Measured: 41
  mutating tools, 40 with `idempotencyKey` in the schema. Somebody adding a write
  tool without a key would copy the constant and make the annotation false.
- **House, and the fourth bucket is a wording rule rather than wire data.**
  Three buckets are too coarse at the destructive end: `set_transaction_deleted`
  posts a reversal and the same call restores it, and it wore the same
  annotation as a merge that cannot be undone. `ToolAnnotations` has three
  booleans and no fourth field, so `destructiveHint` is the only thing a client
  reads and it covers both — which are different decisions for whoever is
  approving the call, with nowhere in the specification to put the difference.

  So `unrecoverableAnnotations` buys a class and an obligation, not a field: a
  tool registered under it must say "this cannot be undone" in its own
  description, because the description is the only channel that can carry it. It
  is deliberately identical to `destructiveAnnotations` on the wire; making it
  differ would be inventing a field the specification does not have.

  **Eleven tools: the two merges and every delete that leaves nothing to
  restore.** The first list had four, two of them recoverable:
  `bulk_delete_transactions` reads "deleting posts a reversal rather than
  erasing, so it can be undone with `set_transaction_deleted`", which is
  `AGENTS.md`'s delete invariant working, and `revoke_connected_agent` says the
  agent "has to be authorized again". Correcting it to the two merges then
  took "a delete is a reversal" for a rule about every delete. It is true of a
  transaction and of nothing else, and the server's own instructions said
  otherwise to every agent: a deleted account, category, group, budget,
  single-period amount, template, recurrence or staged row is gone. The merges
  collapse rows into one, the nine deletes remove a row outright, and each of
  the eleven now says there is no undo.

  *Checked by:* `tests/mcp-measurements.test.ts`, which reads the class from the
  registrations rather than from a list, requires every tool in it to say so in
  words and each of the recoverable ones to say how to get back, and requires
  every `delete_` tool to be in the class or be one of the two that can be
  walked back — so a new hard delete cannot join the surface silently.
- **House, and its reason is an absence of evidence.** Only VS Code's use of
  `readOnlyHint` is documented behavior. Whether any major client acts on the
  other three could not be established, so no rule here depends on a client
  acting on one. The annotations are set because they are true, not because
  something is known to read them.

*Checked by:* `tests/mcp-parity.test.ts:392-407`, which derives what a read-only
token may see from `readOnlyHint` rather than from a roster, "because three
recurrence write tools were added to the file in the read block and nobody had to
remember" a list. *Also checked by:* `tests/mcp-parity.test.ts:424-452`, which
closes the other direction: a tool annotated `readOnlyHint: true` whose handler
reaches a service that writes a row. That is the worse failure of the two,
because the annotation is what a client shows the person approving the call, and
VS Code's documented use of it decides what may run without asking. What counts
as a write is `tests/support/mutations.ts`, the same reader
`tests/service-transactions.test.ts` uses for the services guide, so this
repository has one definition of a write rather than two that drift.

*Also checked by:* `tests/mcp-destructive-annotations.test.ts`, for the claim
`destructiveHint` makes rather than the one `readOnlyHint` makes. A tool whose
published input schema asks for an `expectedVersion` anywhere — including one
per row, inside an array, inside an arm of an `anyOf` — is a tool with a row
whose replacement somebody could lose a race over, so it overwrites and must say
so. `set_budget_entry` was the one tool on the surface asking for a version and
calling itself additive: it replaces the amount, writes `budgetEntry.update`,
and leaves the previous figure nowhere but the audit log — so the prompt it
skipped was the only chance to keep that figure, and its own description said so
two lines above the annotation that denied it.

### A one-way door is destructive, whatever it writes

**House, already mechanized by `tests/active-accounts-mcp.test.ts`.** The rule
above — `destructiveHint` describes what the tool does to the ledger — is right
and incomplete, and reading it alone sends you to the additive annotations,
which is where this started.

`set_active_accounts` (`src/server/mcp.ts:1751-1769`) posts nothing and deletes
nothing. It writes one boolean per account. It was registered as additive beside
a comment saying the previous list put everything back, and the choose-once rule
had made that false: the first call freezes every account it leaves out, a
frozen account leaves the set only by being archived or deleted, and resending
the earlier list is refused rather than undone (`activeAccountChange` in
`src/shared/domain.ts`). It is destructive because the first call is the
person's one-time choice.

**Annotating by what is written is the obvious alternative and it is wrong**,
because of who reads the annotation. It is read by a client deciding what may
run without a prompt — VS Code's documented use of `readOnlyHint` is exactly
that — and a tool that writes one boolean and closes a door permanently is a
worse thing to auto-approve than a transaction a reversal undoes. The person
whose choice it is would never see the dialog.

Not `unrecoverableAnnotations` either, and the guide already owns that
distinction: a way back exists. Archiving or deleting an account in use frees a
place, and a spell on the paid plan reopens the choice, so the tool says how to
get back rather than that there is no way back.

This recurs. Every entitlement-shaped or preference-shaped one-way door has the
same shape — small write, permanent consequence — and the plan work produced one
in a single release.

*Checked by:* `tests/active-accounts-mcp.test.ts`, which pins
`readOnlyHint: false` with `destructiveHint: true` on the tool and holds its
description to saying the choice cannot be traded, to asking for confirmation
first, and to saying it is refused while nothing is frozen — so an agent does
not go on sending lists the server has to refuse.

## Scope, and why this surface will not consolidate

Anthropic's guidance is that "a common error we've observed is tools that merely
wrap existing software functionality or API endpoints", that "Claude's ability to
pick the right tool degrades once you exceed 30-50 available tools", and, in the
platform docs, that related operations should be grouped "into a single tool with
an `action` parameter". Eighty-two tools sits above that band and this surface
is not going to consolidate. The reason is mechanical rather than stylistic and
it is the strongest specific argument available.

**House, and it is the property the whole design rests on: every tool has
exactly one scope.** The specification permits the variation rather than
requiring it, so this is a decision and not an obligation; it is argued at
length because it is the one that decides the tool count.

A tool is gated by which of three registration blocks it sits in
(`src/server/mcp.ts:649`, `:1280` and `:1386`), and scope is enforced by
non-registration, so a tool the caller cannot use is **absent from discovery**
rather than present and refusing. Measured: 41 tools at `ledger:read`, 46 at
`ledger:stage`, 82 at `ledger:write`, and a token with no ledger scope gets a
server that does not offer `tools/list` at all (verified live: `-32601 Method not
found`). This is exactly the variation the specification permits: the tool set
"MUST NOT vary per-connection" but "MAY vary by the authorization presented on
the request... since credentials are per-request input, not connection state".

A single `transactions` tool with an `action` enum spanning read, stage and write
cannot be filtered. It would appear in a read-only token's list, cost that agent
its full schema, and then refuse at call time. That is worse for the agent, which
spends a call and its context discovering a capability it never had, and worse
for the audit story, where a scope refusal becomes indistinguishable from a
mistake. Consolidation would trade a property this surface has for a token saving
it can get more cheaply by deleting a redundant regex.

Two supporting reasons. Parity is a product commitment rather than an
implementation habit, so the tool count is not free to choose (next section). And
Anthropic's guidance is not internally consistent on granularity, so deferring to
it means choosing which half to defer to anyway.

- **House, the exception the rule needs.** Three tools take scope as a
  *behavior* switch rather than a gate — `stage_csv`,
  `update_staged_transaction` and `bulk_edit_staged_transactions` — which is how
  `ledger:stage` proposes without deciding. A tool whose
  result differs by scope is still one tool with one scope: the wider scope
  changes what it may create, not whether it may be called.
- **Binding.** `AGENTS.md`: "`ledger:stage` proposes and never decides. Creating
  a category, bringing an archived one back, or widening what kind of entry it
  may carry are changes to the ledger's own records and need `ledger:write`,
  wherever they are reached from, including a CSV import." `stage_csv` is the
  worked case and its description is the model for saying so
  (`src/server/mcp.ts:1366-1371`). `add_ledger_file` is the same line drawn
  the other way. A Simple Balance file brings accounts, categories, templates,
  recurring transactions and budgets, and adding it creates them rather than
  proposing them, so the tool is write-tier whole rather than a third behavior
  switch; its entries still stage. A stage-only agent keeps `stage_csv`, and
  `preview_ledger_file`, which writes nothing, is a read.
- **House. The money guides sit at `ledger:read`, although they read no
  ledger.** `list_learn_articles` and `get_learn_article` take no actor and
  import nothing that reaches the database (`src/server/services/learn.ts`), so
  no scope is about them in the way the three tiers are about the books. Putting
  them outside every tier was the obvious alternative and would cost the one
  property argued above that is asserted rather than only stated: a token with
  no ledger scope gets no `tools/list` at all. Every connection that exists to
  work on somebody's books holds `ledger:read`, so every one that has a use for
  the guides sees them, and the one that would lose them has no reason to be
  connected. `held`, on each tool a guide's step names, is the grant's answer
  and is worked out in the transport adapter from `TOOL_SCOPES`, the same way
  `whoami`'s scopes are, because only the adapter has the grant
  (`src/server/mcp.ts:1261-1276`).
- **House.** Read, propose, write are three tiers answering three questions.
  `dryRun: true` asks "what would this do", synchronously, leaving nothing
  behind; it is on 8 tools. `ledger:stage` says "do this when a person agrees",
  durably. `ledger:write` decides. The propose tier is complete when every write
  has a proposal form, not when the queue has a row type; today `ledger:stage`
  adds five transaction-shaped tools to the read set, so an agent holding it can
  propose new transactions and nothing else. The obvious ask, "suggest
  recategorizing six months of groceries and let me look before it lands", has no
  home, because that is `bulk_edit_transactions` and that is `ledger:write`.
- **House, and original rather than cited.** No published propose-then-confirm
  pattern found is durable. Every one of them (Asana's preview/confirm pairs,
  Slack's message draft, keeping-mcp's dry-run default, the Tasks extension's
  `input_required`) lives in the transcript and dies with it. `ledger:stage` is
  reviewable later, reviewable by somebody who was never in the conversation,
  revalidated on write, and gated by an OAuth scope rather than by a client
  setting or a boolean the agent supplies. This guide is writing that rule
  rather than citing it, and the provenance is recorded so nobody looks for the
  source later.
- **Binding (SHOULD), unmet on a date rather than on the merits.**
  `scopes_supported` "is intended to represent the minimal set of scopes
  necessary for basic functionality", and the security document's Common
  Mistakes list names "Publishing all possible scopes in `scopes_supported`".
  The two documents answer two different questions and give the same answer to
  both: all seven. The authorization-server one is right to
  (`src/server/api.ts:1107-1115`, served at `:1134`), because RFC 8414's field
  is what the server accepts and Better Auth's accept-list at `/authorize` is
  the union of its four defaults with our three
  (`node_modules/better-auth/dist/plugins/oidc-provider/authorize.mjs:23-33`).
  The protected-resource document is the one the Common Mistakes list is about,
  because it is what a client builds its scope request from — the SDK joins
  `scopes_supported` verbatim, ahead of the client's own configured scope, in
  `client/auth.js`'s `resolvedScope` — and it publishes that same array
  (`src/server/api.ts:1116`, served at `:1141`). Four citations in this paragraph
  had drifted and two of them landed on the other document's array, which in the
  one paragraph that exists to keep the two straight is worse than no citation.
  **It was narrowed to `openid profile email offline_access ledger:read`
  earlier in this release and taken back out before the release shipped**, and
  the rule that took it out outranks the SHOULD: `AGENTS.md` has "A capability a
  client had does not narrow", and a client that read the document under 0.1.5,
  asked for `ledger:write` and holds it would find that tier missing from the
  list it rebuilds its request from — coming back read-only, on an upgrade, and
  climbing out only if it implements the RFC 6750 step-up.
  [`writing.md`](writing.md#versioning) has the reasoning. So it waits for a
  release that can deprecate the wider advertisement first, with the step-up
  already in the field.
  The half that did land costs nobody anything and is the next bullet: an
  under-scoped call is refused by naming the tier it needed, so a client that
  asks for less has a way back up. Two things the narrowing will owe when it
  ships, both of them worked out by the draft that was taken out and kept here
  so the next attempt does not have to find them again. It has to reach every
  path the document is reachable from, including
  `/api/auth/.well-known/oauth-protected-resource` (`src/server/api.ts:1077`),
  which is where `withMcpAuth`'s own 401 sends a
  client on first contact, since narrowing only the RFC 9728 paths would leave
  the advertisement everybody reads untouched and the one nobody reads correct.
  And it has to keep `offline_access` whatever else goes, because Better Auth
  issues a refresh token only when that scope was requested, and a long-lived
  client without one re-authorizes by hand.
  Narrowing both documents stays rejected either way: the consent screen offers
  Allow or Deny and no third answer, so a client asking for `ledger:write`
  cannot be trimmed to read at approval, and leaving no machine-readable trace
  of the write tier anywhere would make a three-tier product a one-tier one.
- **Binding (SHOULD), met, and it is the one an agent feels.** An authenticated
  but under-scoped call is a 403 carrying
  `WWW-Authenticate: Bearer error="insufficient_scope"`, the full scope string
  that would have worked, and `resource_metadata`. It used to be
  `MCP error -32602: Tool create_transaction not found`, character for character
  what a misspelled tool name returns; a name that is not a tool at all still
  gets exactly that, so the two answers differ, which was the whole complaint.
  The challenge is raised before dispatch from `TOOL_SCOPES` in
  `src/server/mcp.ts`, so gating stays by non-registration and a read-only
  token's tool list is unchanged. Two details are load-bearing and both
  came close to being wrong. The tier test is `satisfiesToolScope`, not `hasScope`:
  `hasScope` widens only `ledger:read`, so testing the staging tier with it
  refuses a `ledger:write` token a tool it already holds and, on a client
  implementing the step-up, talks it into re-authorizing downward. And the
  `scope` parameter carries the whole string to request, not the missing tier
  alone, because the SDK replaces the entire scope request with it — naming
  `ledger:write` by itself would mint a token with no `openid` and no
  `offline_access`, and so no refresh token, which is the failure the previous
  bullet keeps `offline_access` in the advertisement to avoid. `TOOL_SCOPES` is
  a second copy of the three registration blocks and
  `tests/mcp-measurements.test.ts` holds it to them tier by tier.
  `whoami` reports the scopes on this token, merged in the transport adapter
  because only it holds them; `list_connected_agents` reports the grant, which
  is a wider and older fact, and the person's own view of it is the
  connected-agents list in Settings. Naming the required scope in each gated
  tool's description was considered and rejected: under non-registration the
  only caller who could read it already holds the scope. The three tools where
  scope changes behavior rather than access are the real case and already say
  so in their own words.
- **Binding (MUST), met.** `hasScope` (`src/server/mcp.ts:502-507`) implements
  the scope hierarchy the specification requires servers to account for: stage
  and write both satisfy read.
- **House, and its reason is an absence of evidence.** Whether 82 tightly
  related, consistently named ledger tools behave like 82 unrelated ones could
  not be established: Anthropic's 30-to-50 band describes an aggregated
  multi-server context. So no rule here rests on the band in either direction,
  and the payload is measured rather than argued about.
- **House, the compensations owed.** Publish the count per tier and not the
  total. Track the payload against a ceiling. Keep names, descriptions and
  argument names readable, because that is exactly what a client's tool search
  reads. Toolsets by area remain an available option, following GitHub's
  precedent, with the honest note that the protocol does not standardize how a
  client opts in.

*Checked by:* `tests/mcp-parity.test.ts:399-407` and `:454-486`;
`tests/mcp-output.test.ts:219-228`, which asserts that a token holding no ledger
scope gets no tools at all rather than merely missing the two the test was
written for, "because naming them left the branch accepting any other tool
reaching a token with no ledger scope"; `tests/mcp-scope-challenge.test.ts` for
the 403 and for the write token that must not be challenged at the staging tier;
and `tests/mcp-parity.test.ts` for which descriptions may name a scope at all; and
`tests/mcp-discovery-scopes.test.ts` for what each document advertises — the
resource one naming all seven on every one of the four paths it answers on,
which makes it a guard on the upgrade rather than on a preference, the
authorization-server one naming every tier, and the resource list held to a
subset of the server's, so a client is never told to ask for a scope the
authorization would refuse — plus a source guard on the `/authorize`
accept-list, which no document reports and which an unauthenticated
authorization cannot reach, because Better Auth checks the session first.

## The agent surface never runs ahead of the browser

**Binding.** `AGENTS.md`: "The MCP surface has feature parity with the web app,
and `tests/mcp-parity.test.ts` compares them route by route. A new `/api/v1`
route needs a tool in the same change, or a named exception carrying its reason.
It runs the other way too: the agent surface never gets ahead of the browser, so
a route no page calls needs a named exception of its own, and so does a tool no
route reaches, because every comparison starts from a route and such a tool
passed them all unseen. The money guides are two such tools: no page calls a
route for them, because a person reads the same guides at smpl.money/learn,
and they read nothing of anybody's. A capability a person cannot reach is not
parity, it is a second product."

The second direction is the unusual half and it is worth the sentence it costs.
A surface only agents can reach is a surface nobody watches: no screen shows what
it did, no person can undo it by hand, and its bugs are found by the agent that
hits them. Requiring a page to call the route first means every capability has a
human witness.

- **Binding.** `AGENTS.md`: "Three exceptions, all account management rather than
  bookkeeping: deleting an account, setting a sign-in password, and the billing
  routes are reachable from a session and never from an MCP token."
  `tests/mcp-session-only.test.ts` holds it from the transport: `mcp.ts` may
  name none of the functions those routes call, and each is still named by
  `api.ts`, so a rename empties nothing. It replaced a check asserting four tool
  names were absent, none of which had ever existed.
- **House.** An exception carries a written reason, not a name on a list. Ten
  browser-only exceptions (`tests/mcp-parity.test.ts:27-48`) and five agent-only
  each carry a paragraph. The count went to nine when billing landed, in the
  same change that added four of them, and this sentence stopped one short —
  which is what a count in prose beside a list in a test does. The tenth is the
  Simple Balance file's download, and it is the CSV export's case again rather
  than a capability withheld: `export_ledger_file` returns the same file as
  text, and the route differs in serving it as an attachment and in allowing
  ten times the rows, because a tool's reply is serialized twice and cannot
  stream. Four of the five
  agent-only ones are reads of one record by id — a transaction, a staged row, a
  recurrence, a budget plan — which every page already holds from the list it
  opened the record from, and which had passed the backward check for as long
  as it matched on the path alone, behind the edit form sending a `PUT` to the
  same URL.
- **House, and the register the route-keyed checks needed: a tool no route
  reaches is named, with its reason.** Every check here started from a route — forward
  from each route to its tool, backward from each route to a page — so a tool
  registered with no route of its own passed all of them without anybody writing
  a word. That is the furthest an agent can get ahead of the browser, and it was
  the one nothing saw: four tools had been reached that way for releases, named
  only in passing inside a browser-only reason. `NO_ROUTE`
  (`tests/mcp-parity.test.ts:141`) now names each tool that is no route's target
  and says why. Four stand in for something the browser reads another way:
  `whoami` and `get_preferences` for two parts of the session read, and the two
  exports for the downloads, which stay browser-only because they are
  downloads. The fifth and sixth are the money guides, and they are the one
  exception on this surface that is not bookkeeping or account management.
- **House, and argued rather than asserted, because the rule's own words reach
  it.** `list_learn_articles` and `get_learn_article` carry the guides
  smpl.money publishes at `/learn`, vendored into the image, and no page calls a
  route for them. The reason the backward rule exists is a capability nobody
  witnesses — nothing on a screen shows what it did and no person can undo it by
  hand — and here there is nothing to witness: the text is the same for
  everybody, and the tools read nothing of anybody's and write nothing. The
  capability itself is one a person already has, at smpl.money/learn, so these
  are the site's words reaching an agent rather than a second product. The step
  map is the part that looks like it might run ahead, and does not: every step
  it maps is a heading under the guide's "How to do it in Simple Balance", which
  is the browser's own way of doing it, and the map only names the tools that do
  the same. **The edge, named rather than hidden:** a deployment with no
  internet still serves the guides to an agent, while a person on the same
  network cannot open the site. Drawing the rule narrower instead — "never ahead
  of the browser *on anybody's books*" — would have needed no exception at all,
  and was declined: the broad wording is what caught `categoryKind`, and
  narrowing it invites the next "this is not really the books" argument.
- **House, and the distinction the billing exception rests on.** A plan is not
  withheld from an agent; the *purchase* is. `whoami` carries the plan, its
  ceiling and how much of it is used, which is everything an agent needs to
  explain a refusal it meets — so the capability the agent is affected by has
  parity and the transaction that changes somebody's money does not. Withholding
  the ceiling as well would have been the defect this rule exists to catch: an
  agent that meets a limit it cannot see reports a bug rather than a plan. The
  same reasoning added `activeChoicePending`: the Accounts page shows its
  chooser when the one-time choice of accounts in use is open, and an agent had
  to work that out by listing every account and applying the rule itself.
  `whoami` reports it from the summary the plan's counts come from, which is the
  predicate `set_active_accounts` is held to.
- **House, and the honest limit, now half as wide.** Parity proves coverage and
  wiring. **The filter half no longer blocks**: two listings are compared field
  by field against the page that owns them — the register against
  `GET /api/v1/transactions` and the staged queue against
  `GET /api/v1/staged-transactions` — by reading what the route's schema parses
  and what the page's one named request object sends, with every filter a page
  does not offer carrying a written reason the way a route exception does. That
  closes the defect `AGENTS.md` names: `categoryKind` was documented for the MCP
  and missing from the form, and `?type=transfer` worked for an agent while
  nothing in the browser could ask for its transfers. **Every other read is
  compared the same way now**, found from `tools/list` rather than named: each
  read-only tool with a `GET` route, and each export against the download it
  stands in for (`DOWNLOAD_OF`, `tests/mcp-parity.test.ts:1052`), has every
  field it takes — beyond the record it names and the paging and ordering that
  describe a view — compared with what `src/client` sends to that route,
  thirty-eight fields today. Those reads had been compared with nothing, and
  that is where the last field only an agent could set was:
  `get_financial_summary` took `includeArchived`, its route parsed it, and the
  Overview sent `start` and `end` and never it. The Overview has the box now
  ([`web.md`](web.md#118-where-a-view-choice-lives)). Two fields carry a
  written reason in `READ_UNOFFERED` (`tests/mcp-parity.test.ts:1032`)
  instead of a control. The Payees page never sends `list_payees`' `search`:
  it holds every spelling already and narrows the list as somebody types, with
  the function the service applies (`nameSearch`, `src/shared/names.ts`), so a
  person reaches exactly the spellings an agent's search returns. That was not
  true until the two were one function — the page lower-cased what was typed,
  so "acme co" found "ACME  Co" over MCP and missed it in the browser. And
  `export_transactions_csv`'s `currency` is a filter the Transactions view does
  not offer, for the reason `FILTERED_LISTS` gives on the register's own, so
  the download of that view cannot send it either. **Every write tool but
  one is compared now**, which is the number to keep honest, because it was one
  for most of 0.2.0 and seven for the rest of it. `tests/mcp-parity.test.ts`
  takes its population from `tools/list` — every tool not annotated read-only,
  forty-one today — and compares each against what `src/client` sends to its
  route: forty tools and 172 fields across 43 forms. `revoke_connected_agent` is
  the one not compared, since its only field is the path. A field the browser
  deliberately does not send carries a written reason in `WRITTEN_FORMS` —
  `dryRun` on three bulk tools, `rawData` on a created staged row — and every
  other field must be sent somewhere. When it was a hand-kept register of seven,
  it compared 67 fields. Three of
  those reasons were "declared rather than argued" — a template mass edit's
  description and notes, and a standing budget's funding order — and a fourth,
  that overriding a group is overriding its categories, was false for a group
  holding its own budget; the forms offer all four now, and creating a budget
  offers its end date, which only the tool did. The eighth
  is `tests/staged-draft-contract.test.ts`, which
  holds the published staged draft against the canonical `transactionDraftSchema`
  it is a proposal of, and against the keys the review queue writes onto one —
  which is how `categoryName`, `categoryKind` and `templateId` were found
  travelling through the `.catchall` and published nowhere: the same defect
  `AGENTS.md` names, pointing from the browser at the agent. Only three
  listings are pinned to the schema their service parses. It proves nothing at all
  about whether an agent can use the surface. No published guidance recommends
  interface-parity testing for an MCP server; as far as this project's research
  established, it is an original practice, and it should be described as what it
  is rather than as evidence of quality.
- **House, and argued here because the register cannot reach them.** Three
  request fields only an agent sets, each outside every form the register
  compares. A split leg's own `categoryKind` on a committed entry: the form
  asks one question for every new name in it, and an entry naming an income
  and an expense category is refused whatever asks — but `both` can sit beside
  either, so two new names in one split can need two answers, and that one case
  the form cannot express. It is narrow: the postings come out the same, and a
  category can be made `both` afterwards on the Categories page. What the form
  must never do is replace two answers with one, and since 0.2.1 opening a
  stored split carries each leg's answer back unchanged. A staged row's `rawData`: it is the row an agent
  read its proposal from, and a person entering one has no other row it came
  from — what was missing was showing it, and the staged row's form now shows
  it as it arrived. And `dryRun` on the seven bulk tools: the browser holds the
  rows it is about to write, or previews a filtered set with the selection
  route, and shows the count before it writes; the rehearsal exists for a caller
  with no screen to show one on.

*Checked by:* `tests/mcp-parity.test.ts`, both directions. Forward at `:286-301`
(every route reachable through a named tool) and `:337-366`, which extracts which
service each route and each tool calls and compares them, with a `compared` floor
at `:363` guarding the regex from silently matching nothing. Backward at
`:737-753`, which matches each route's whole path against `src/client`, each
parameter standing in for a template hole rather than only the prefix before the
first one: `/api/v1/accounts` is satisfied the moment anything fetches an
account, which left every parameterized sub-route beneath it unchecked and a
page free to stop calling one. It reads the method too, from the call the path
sits in, and the path's end, so neither a `PUT` to the same URL nor a fetch of a
longer path beneath it satisfies a `GET`. Exceptions are policed at `:305-309`, which fails
an exception naming a route that no longer exists, and at `:755-759`, which
fails any agent-only reason under forty characters. Nothing measures the
browser-only reasons; they stay a reviewer's job. The two forbidden capabilities
are pinned by name at `:380-390`. *Also checked by:* `:977-1005` for the field
level, which reads each listing route's schema and the page's own request object
and fails a filter the route parses that the page cannot send, with a `compared`
floor so a reader that stopped matching cannot pass on nothing; and `:1007-1013`,
which fails a filter named as unoffered without a reason over forty characters,
exactly as the route exceptions are policed. *Also checked by:* `:317-329` for
the tools no route reaches, which fails a tool that is neither a route's target
nor a `NO_ROUTE` key, a key that is not a registered tool, a key some route
does reach, and a reason under forty characters; `:1111-1174` for the reads,
whose population is pinned by name for the six reads the gap was found among
and the two exports, with a floor of thirty fields, and which was shown to fail
when the Overview stopped sending `includeArchived`; `:1176-1181`, which holds
every export it compares to being a `NO_ROUTE` tool and every download to
being a browser-only route; and `:1183-1195`, which polices `READ_UNOFFERED`
the way `:1007-1013` polices the listings' register.

## Idempotency, versions and state handles

- **Binding.** `AGENTS.md`: "Updates/deletes require an expected version.
  Commits, and creates that write postings, require idempotency; a record
  somebody names is protected by its own name being unique, so a second submit
  fails rather than duplicating."
- **House, stricter than the invariant, and it should stay.** Every mutating
  tool on this surface takes an `idempotencyKey`, not only the ones that write
  postings — **with one named exemption**, which this bullet cited as a pinned
  sentence saying the opposite for a release. The annotations section has the
  count and the exemption together: 41 mutating tools, 40 with `idempotencyKey`,
  and `set_active_accounts` is the forty-first, exempt because it states the
  whole set it sets, so a replay lands on the state the first call left.
  Somebody adding a mutating tool reads this bullet, believes a key is mandatory, and
  does not find the exemption, which is the one thing a cross-reference has to
  get right. One schema and one description
  (`src/shared/domain.ts:333-340`), so the convention reads identically on every
  tool that takes it. An agent retrying a timed-out call is the normal case
  here, not the exceptional one.
- **Binding.** Every id an agent holds is a state handle, and the specification's
  rule is the protocol's restatement of `AGENTS.md`'s "Never accept a public
  `userId`": "MCP servers MUST NOT treat possession of a state handle as
  authentication", and a server should "bind handles server-side to the
  authenticated user". Transaction ids, staged row ids, leg ids, import batch
  ids, template ids, recurrence ids, bulk fingerprints and idempotency keys are
  all handles, and every one is re-authorized against the actor on each call.
  Citing the specification for a rule the codebase already keeps is what makes it
  survive a refactor.
- **House.** Where a tool creates state that expires, its retention is stated in
  that tool's description, "so the model can see it when deciding to create
  state", and expiry returns a tool execution error saying so rather than a
  silent empty result. The idempotency record is the case here, and this
  bullet named the wrong one for a while: the bulk selection fingerprint goes
  stale when the rows change, "not after a while", so it is not state that
  expires. The record is, on a deployment that sets
  `IDEMPOTENCY_RETENTION_HOURS`, and the shared `idempotencyKey` description
  now says the replay holds for as long as the deployment keeps the record. A
  retry past the window does not return an error — it does the work again —
  and that is said too, because most writes are then refused by something else
  and a staged create is not.

*Checked by:* the idempotency and version behavior at the service layer, and
`tests/mcp-measurements.test.ts:583-621` on this surface, which is what keeps
`idempotentHint` from becoming a lie: it counts the mutating tools from the
annotations and the keys from the schemas, so a tool added without one moves one
number and not the other rather than moving both and agreeing with itself, and
it fails outright on a mutating tool carrying neither a key nor an expected
version. *Not checked:* that a tool
creating state which expires says so, which is prose in a description.

## Security this server owns

- **House, and honest.** "Sanitize tool outputs" is a specification MUST with no
  definition attached, and this product holds two legs of the lethal trifecta by
  construction: private data, and untrusted content in payee names, descriptions
  and notes arriving from imported bank CSVs. The third leg belongs to the
  client. The server cannot keep an injected instruction from being read. It can bound
  the blast radius, and it does: `ledger:stage` decides nothing, deleting posts a
  reversal, updates carry expected versions, bulk selections carry fingerprints,
  and every write is audited with `actorSource` and `clientId`.
- **House, and the marking that was actually cheap.** The instructions say once
  that payee, description, notes and a staged row's `rawData` are free text this
  person did not necessarily write, that an `externalId` or an `importBatchId`
  means the row came from an imported file — a bank's CSV, or a Simple Balance
  file from another copy, whose text is no more this person's — and that all of
  it is data and never an instruction. Both provenance fields were already on
  the wire and now say in their own output descriptions what they mean,
  `rawData` with them. What was not done, and will not be: a provenance column
  on `ledger_transaction`, which has `external_id` and no `import_batch_id`. It
  would need a forward-only migration, a backfill that can only guess from
  whichever staged rows survived, and a place on the transactions page for a
  person to see it — all to buy a label that still does not keep an injected
  instruction from being read. This is a marking for a model already reading the
  text, not a control, and the control remains the blast radius above it. The
  input side says it too: the shared `externalId` now carries the same warning,
  so an agent reads it on the way in rather than only on the way back. The
  `import_origin` that 0026 added to `ledger_transaction` is not that column: it
  is identity rather than provenance, and is never sent at all
  ([`ledger-file.md`](ledger-file.md#14-entries-staged-rows-and-origins)).
- **House, framing an existing behavior so it is not optimized away.** Routing
  every authorization request through the consent screen, including for
  signed-in users and clients that omit `prompt=consent`, is the confused-deputy
  mitigation, not a UX preference.
- **Binding.** A protected MCP server "MUST validate that access tokens were
  issued specifically for them as the intended audience" and "MUST NOT accept or
  transit any other tokens". This deployment binds the audience to its own `/mcp`
  and replaces anything that is not a JWT it signed, in either header shape
  (`src/server/api.ts:1223-1242`).
- **House.** `x-mcp-header` mirrors a tool argument into an HTTP header for proxy
  routing, and the specification warns against marking sensitive parameters with
  it. Nothing here needs proxy routing and everything here is somebody's
  finances, so the feature stays unused.

*Checked by:* `tests/api-security.test.ts` for the transport half. *Review only:*
whether an output carries text that should have been marked as bank-supplied.

## What is not implemented, and why

One line each, with the condition that would reopen it.

| Not implemented | Why, and what would reopen it |
| --- | --- |
| Roots, Sampling, Logging | Deprecated in 2026-07-28, earliest removal on or after 2027-07-28. Permanently closed. |
| Resources | Nothing here is a thing a person attaches. Reopen if somebody wants to pin a report or a chart of accounts into a conversation. |
| Prompts | No canned opener has been asked for. Reopen for a recurring named workflow such as reconciling last month. |
| Elicitation | The staging queue solves the same problem asynchronously and durably, and form mode may not be used for anything sensitive anyway. |
| Completion | Covers prompt and resource template arguments only. It cannot cover tool arguments, which is what this surface would want it for. |
| Tasks | A second protocol surface with per-client opt-in, against a ten-thousand-row cap that already keeps work inside one request. |
| Progress notifications | The transport answers in a single JSON object (`enableJsonResponse: true`, `src/server/mcp.ts:2440`), so there is no open channel a `notifications/progress` could travel on — which is why the two routes that report progress to the browser do it with `Accept` rather than a request field an agent would see and could not use. Reopen with `Tasks`, above: both need the same change to how every tool call answers. |
| Icons | Nothing renders them here. |
| `x-mcp-header` | Nothing needs proxy routing, and the sensitive-parameter warning points the wrong way for a ledger. |
| `server/discover`, caching hints, `_meta` version negotiation | Wanted, and blocked on the SDK. See the first section. |

Dynamic client registration is implemented and open, "as RFC 7591 intends"
(`docs/mcp.md:44-46`), and it is now on the deprecated path: DCR was deprecated
in 2026-07-28 with earliest removal on or after 2027-07-28. The specification's
priority is pre-registration, then Client ID Metadata Documents where the
authorization server advertises `client_id_metadata_document_supported`, then DCR
as the fallback. **Not unmet, and this label was wrong.** That priority order
is a rule for a *client* choosing how to obtain a client id, and its conditional
clause gives it away: a client uses CIMD *where the authorization server
advertises support*. A server advertising nothing moves the client to the
fallback, which this deployment implements. The only server-side obligation in
that sentence is that a server supporting CIMD must advertise it.

**Declined on cost, separately.** Better Auth resolves `client_id` by looking it
up in `oauthApplication`, so a URL-shaped id fails there; CIMD means forking the
authorize endpoint and adding a server-side fetch of a URL the caller supplies,
to a self-hosted deployment sitting inside somebody's home network. That is an
SSRF surface bought for portability across authorization servers that a
single-tenant personal ledger does not need. Three consequences to plan for: CIMD
needs an SSRF story on the authorization server, CIMD client ids are portable
across authorization servers where DCR credentials are not, and the day-old sweep
of unapproved registrations has no CIMD analog because there is no stored
registration to sweep.

*Not checked mechanically.* Nothing fails if a deprecated feature is adopted, and
nothing fails if one of these documents goes stale on the point.

## Proving it works

Two different things, and only one of them is a test.

- **Binding.** `AGENTS.md`: "Exercise new tools over a real connection rather
  than trusting the schema alone." Both MCP test files do this, connecting a real
  client to a real server over `InMemoryTransport` rather than asserting against
  the registry, which is why they catch schema faults a registry inspection
  cannot show. A new tool is exercised the same way, and that is checked:
  `tests/mcp-exercised.test.ts` lists every registered tool and fails on one no
  integration test calls by name. Thirty-nine of seventy-seven were called by
  none when it was written, and
  `tests/integration/mcp-every-tool.integration.test.ts` calls each of them
  against seeded data, so no list passes its item schema by being empty.
- **House.** The structural tests are the floor, not the ceiling. `mcp-parity`
  proves coverage and wiring; `mcp-output` proves every tool publishes a concrete
  schema and that a scopeless token sees nothing.
- **House, and it does not exist.** The agent evaluation. Anthropic's criterion
  is worth quoting because it is the only definition of quality here that is not
  circular: "The measure of quality of an MCP server is NOT how well or
  comprehensively the server implements tools, but how well these implementations
  (input/output schemas, docstrings/descriptions, functionality) enable LLMs with
  no other context and access ONLY to the MCP servers to answer realistic and
  difficult questions." Ten questions over a seeded ledger, independent, complex,
  not keyword-searchable, each verifiable by direct string comparison, with the
  output format stated in the question. Track tool calls, tokens, runtime and
  errors rather than accuracy alone, and read the transcripts: redundant calls
  point at paging defaults, invalid-parameter errors point at descriptions.
- **House, two extensions the published method does not cover**, because it is
  explicitly read-only and this surface is not. A per-eval PostgreSQL database,
  so write evaluations are safe and the audit log is the checkable outcome. And a
  scoped run of the same tasks with a `ledger:stage` token, asserting that the
  agent proposes and explains rather than failing and retrying. That second one
  is the propose tier's real acceptance test and nothing tests it today.

*Checked by:* `tests/integration/mcp-tools.integration.test.ts`, which calls every
read tool over a real connection, and `tests/mcp-output.test.ts` for the result
envelope. *Not checked:* that a description sends an agent to the right tool,
which is an evaluation rather than a test.

## What is checked, and what is not

| Rule | Checked by |
| --- | --- |
| Every `/api/v1` route is reachable through a named tool, or is a named exception with a reason | `tests/mcp-parity.test.ts:286-301` |
| A tool reaches the same service as its route | `tests/mcp-parity.test.ts:337-366` |
| No route exists that no page calls, without a named exception | `tests/mcp-parity.test.ts:737-753` |
| A listing page sends every filter its route parses, or names the one it does not with a reason | `tests/mcp-parity.test.ts:977-1013`, for the register and the staged queue |
| Every other read tool's fields are sent by a page to its route, or to the download an export stands in for, or are named with a reason | `tests/mcp-parity.test.ts:1111-1195`, derived from `tools/list`, thirty-eight fields against a floor of thirty |
| Every tool is some route's target, or is named in `NO_ROUTE` with its reason | `tests/mcp-parity.test.ts:317-329` |
| A money guide is handed over as the site's exact bytes, and every Simple Balance step it has maps to tools the server registers | `tests/learn-pack.test.ts` on the vendored copy and the step map, `tests/mcp-learn.test.ts` over a connection, and `tests/integration/mcp-learn.integration.test.ts` over a real one with a token |
| A release ships the guides as smpl.money published them, not from a local build | The release workflow's `learn-pack` job, which `publish` needs, running `node scripts/sync-learn.mjs --published`; `tests/learn-sync.test.ts:280` holds the job and the check. Whether the copy is still the site's *current* text needs the network and is `product-kit` §6, not CI |
| Deleting an account and setting a password are absent from the tool list | `tests/mcp-parity.test.ts:380-390` |
| Every registered tool is named in `docs/mcp.md` | `tests/mcp-parity.test.ts:373-378` |
| A read-only token sees nothing that declares itself a write | `tests/mcp-parity.test.ts:399-407` |
| A listing declares the schema its service parses | `tests/mcp-parity.test.ts:576-590` |
| Every tool publishes a concrete two-member output schema | `tests/mcp-output.test.ts:27-53` |
| A token with no ledger scope gets no tools | `tests/mcp-output.test.ts:219-228` |
| A description is longer than thirty characters | `tests/mcp-parity.test.ts:488-506` |
| A tool name is well formed and no title claims another tier's verb | `tests/mcp-parity.test.ts` |
| The `tools/list` payload stays under its ceiling | `tests/mcp-measurements.test.ts`, and more strictly than a ceiling: each of the three tiers' exact character cost is pinned to the number this guide publishes, so a payload that grows fails whether or not it has passed a threshold |
| A destructive tool's description warns | `tests/mcp-measurements.test.ts:180-190` |
| A tool whose behavior changes with scope names it, and no other tool does | `tests/mcp-parity.test.ts` |
| An under-scoped call is a 403 naming the scope, and a misspelled name is not | `tests/mcp-scope-challenge.test.ts` |
| Both discovery documents still advertise every tier a client already had | `tests/mcp-discovery-scopes.test.ts` |
| `TOOL_SCOPES` still agrees with the three registration blocks | `tests/mcp-measurements.test.ts` |
| No output schema declares a `userId`, outside a named exception | `tests/mcp-output.test.ts` |
| Every published copy of a misleading output field carries a description | `tests/mcp-output.test.ts` |
| A tool named in a description exists | `tests/mcp-measurements.test.ts:368-391`, which reads every `snake_case` word in a description as a claim about a tool |
| A tool named in a *field* description exists | `tests/mcp-guide.test.ts`, the same reading one level down, with a word the tool publishes as an enum value read as a value rather than as a tool |
| A refusal a whole tier of tools can return is named in `instructions` | `tests/mcp-guide.test.ts`, which proves the premise from the services before it checks the sentence |
| A tool whose first call is a one-way door is annotated destructive, and says so | `tests/active-accounts-mcp.test.ts` |
| A tool that cannot be undone says so, and a recoverable one says how to get back | `tests/mcp-measurements.test.ts` |
| One spelling per concept across every description | `tests/mcp-measurements.test.ts` |
| A mutating tool takes an idempotency key | `tests/mcp-measurements.test.ts:583-621` |
| `readOnlyHint` is true only where nothing the handler calls writes, and a read-only token sees nothing else | `tests/mcp-parity.test.ts:399-407` and `:424-452`, both substantive directions |
| A tool annotated `readOnlyHint: true` is registered behind a write scope | `tests/mcp-protocol-surface.test.ts`, off `TOOL_SCOPES`. Empty today: all 41 read-only tools are in the read block. It would waste a tier's tool list rather than lie about one, which is why it is the residue rather than the rule — and why the failure that matters is the agent's: a `ledger:read` token asking for a report it is entitled to is told the tool is absent, and `instructions` gives it nothing else to go on |
| Tool order is deterministic | `tests/mcp-protocol-surface.test.ts`, which pins the whole 82-name order and that each tier's list is that order filtered. Registration order is the de facto order and is met by construction; what the check buys is that a silent reorder costs a prompt-cache miss on the write tier's half-million characters and is indistinguishable in a diff from a tool being added |
| CIMD is offered before DCR, and the documents say which is current | **Not a rule.** The priority order is a rule for a *client* choosing how to obtain a client id, and a server that advertises no CIMD support moves the client to the fallback this deployment implements. Concluded in the specification-gaps section below, where this row used to contradict it |
| A convention an agent must obey appears in a description, not only in `docs/mcp.md` | **Not checked.** Review. |
| The server instructions name the grant, the two error envelopes and untrusted text | `tests/mcp-instructions.test.ts`, fourteen rules by substance, the grant per tier, and a 2,400-character ceiling |
| The named revision is the one the SDK negotiates | `tests/mcp-protocol-surface.test.ts` |
| Every parameter carries a description | `tests/mcp-measurements.test.ts`, held at zero |
| Every input schema is closed | `tests/mcp-measurements.test.ts:435-442` |
| A tool whose input schema asks for an `expectedVersion` anywhere is annotated destructive, because a version is asked for only where there is a row to replace | `tests/mcp-destructive-annotations.test.ts`, over a real connection so it reads what an agent is told in `tools/list` rather than what the registration source says. It carries an anti-vacuity guard naming four tools and requiring more than twenty hits, and it caught `set_budget_entry` calling itself additive while overwriting a budget figure |
| No money argument is declared as a `number` or an `integer`, anywhere in any input schema | `tests/mcp-money-arguments.test.ts`, carrying the introducing property name down through `items`, `anyOf`, `oneOf` and `allOf`, with one register entry — `stage_csv.mapping`, which names column headings rather than values |
| Every key a staged draft really carries is declared with a description, rather than riding the catchall | `tests/staged-draft-contract.test.ts`, deriving the population from `transactionDraftSchema` and from the keys `StagingPage` writes. It found `categoryName`, `categoryKind` and then `templateId` undeclared, which is `AGENTS.md`'s parity rule one level down and invisible to any route-by-route comparison |
| Every field a write tool parses is offered somewhere in the browser, or is named with the reason it is not | `tests/mcp-parity.test.ts` — every tool `tools/list` does not annotate read-only, forty compared and 172 fields against a floor of 150, with `revoke_connected_agent` excused because its only field is the path. It was a hand-kept register of six tool/form pairs until it was derived |
| No registration in `src/server` but `registerTool` — no resource, no prompt, no raw request handler, and not the older `tool(…)` that skips the wrapper timing and counting every call | `tests/mcp-protocol-surface.test.ts`, which reads the registration methods off the installed SDK's own type declarations rather than naming two, and holds the `registerTool` calls to exactly the tools a full-scope token is offered |
| Every output field carries a description | **Not checked**, and deliberately not a rule. The misleading ones are checked by name above. |
| Whether a description teaches | **Review only,** and the evaluation above is the nearest thing to a check. |

A rule that appears in neither column is a rule nobody is responsible for, and
that is a defect in this guide rather than in the code.
