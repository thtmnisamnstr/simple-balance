# MCP

The agent surface: 76 tools over Streamable HTTP at `/mcp`, authorized by OAuth
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
  request (src/server/mcp.ts:1979-1988`), so there is no connection to carry
  state in.
- **Where the target is not met, say so rather than claiming it.** The installed
  SDK, `@modelcontextprotocol/sdk` 1.30.0, declares
  `LATEST_PROTOCOL_VERSION = "2025-11-25"` and supports nothing newer, so the
  endpoint negotiates 2025-11-25 today. Three 2026-07-28 obligations are
  unreachable from here and none of them is a design decision: `server/discover`,
  the caching hints (`ttlMs` and `cacheScope`) that a `resultType: "complete"`
  result MUST carry, and per-request version negotiation through `_meta`.
- **When the SDK ships the revision, `cacheScope` on `tools/list` is `private`.**
  The tool list varies by scope, so a shared cache holding a `public` list would
  serve a `ledger:write` tool list to a `ledger:read` token. The specification's
  own `tools/list` example ships `public`. Do not copy it.

*Not checked mechanically.* A test comparing the SDK's `LATEST_PROTOCOL_VERSION`
against a constant named here would fail on the day the SDK is upgraded, which
is the day this section needs rereading. It is four lines and it does not exist.

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
- **`list_payee_suggestions` is correctly a tool**, although it looks like an
  argument completion. `completion/complete` covers `ref/prompt` and
  `ref/resource` only; there is no `ref/tool`.

*Not checked mechanically.* Nothing would fail if a resource appeared.

## What the whole server says once

**House, and the largest free win on the surface.** `server/discover` carries an
`instructions` string: "Natural-language guidance describing the server and its
features... should focus on information that helps the model use the server
effectively and should not duplicate information already in tool descriptions."

`new McpServer({ name, version })` at src/server/mcp.ts:499-503` passes none.

`instructions` predates `server/discover` and is carried on the initialize
result, so it is reachable today: the installed SDK accepts it in
`ServerOptions` (`@modelcontextprotocol/sdk`, `dist/esm/server/index.d.ts:15`)
and `McpServer`'s constructor takes those options
(`dist/esm/server/mcp.d.ts:24`). Nothing blocks
`new McpServer({ name, version }, { instructions })`. What is blocked on the SDK
is `server/discover` itself, which is a different question.

- **A rule true of every tool belongs in `instructions` and nowhere else.**
  Money is a decimal string and never a JSON number; dates are `YYYY-MM-DD`;
  what "today" means comes from the person's timezone, so read `get_preferences`
  first; a credit card or loan opens at a negative balance because that is money
  owed; no figure is ever added across currencies; deleting posts a reversal and
  nothing is erased; a staged row affects no balance; the two things no token can
  reach.
- **Nothing about one tool belongs there.** That is what a description is for.
- **The cost of not having it is measurable.** The amount description is 49
  identical copies of the same 169 characters, 8,281 characters of the published
  surface; the idempotency-key description is 36 copies of 214 characters, 7,704
  characters. Both are conventions, not parameters.

*Checked by:* `tests/mcp-instructions.test.ts`. `instructions` is set, and it
carries the six things an agent otherwise learns only by being refused: whose
ledger this is, that money is an exact decimal string, that dates are in the
person's own timezone, that a write needs a key or a version, that staging is
usually the polite option, and that a refund is not income.

## Naming

- **Binding.** A tool name is drawn from `A-Z a-z 0-9 _ - .`, is 1 to 128
  characters, and is unique within the server. All three are the
  specification's, not this product's, and none is available to change.
- **House.** Within that, `verb_noun` in snake_case, following VS Code's MCP
  guide. 70 of 71 tools follow it; `whoami` is the exception and it is a good
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
  straight into the books" (src/server/mcp.ts:1865-1871`), and "Commit" now
  appears in exactly one title on this surface, on the tool that commits.
- **Contested, decided 2026-08-23: no namespace prefix.** The specification puts
  disambiguation on the client: aggregating clients "SHOULD implement a
  disambiguation strategy such as prefixing tool names with a server identifier".
  Anthropic puts it on the server, with the format `{service}_{action}_{resource}`
  and the only evaluation evidence anybody has published. This product picks the
  specification's side, because it is a single-domain server whose user is
  unlikely to be running a second ledger, and because renaming 71 tools breaks
  every configured client while `notifications/tools/list_changed` now reaches
  only clients that opened a `subscriptions/listen` stream. **Reopen it** if this
  deployment ships a second server, or if a collision is observed in the wild. If
  it is reopened, dual-register old and new names for a release and mark the old
  ones deprecated in their descriptions; the notification is not a migration
  plan on its own.

*Checked by:* tests/mcp-parity.test.ts:300-305` fails a registered tool that
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
   (`src/shared/domain.ts:363-370`) refuses it with "Send either a category or
   legs, not both".
5. **What a person must be asked first, and what cannot be undone.** A
   description tells an agent what it cannot perceive. The model sentence on the
   surface is in `set_preferences`: "Set the theme only when asked to: it is what
   their screen looks like, and you cannot see it."

Further rules:

- **House.** A floor of three to four sentences. Measured today: 76
  descriptions, 24,853 characters, median 261, range 33 to 1,890, and **15 under
  100 characters**. The distribution is bimodal and the terse half covers the
  dangerous tools: `list_transactions` is 54 characters and is the entry point to
  the ledger's largest collection, mentioning none of the ordering and cursor
  rules
  `docs/mcp.md` gives a section to; `commit_staged_transactions` is 81 and is
  the tool that puts money in the books; `merge_categories` is 88 and
  `merge_payees` 76, and each rewrites every reference in the ledger.
- **House.** A tool that changes the ledger irreversibly says so and asks for
  confirmation, in the way `archive_account` does: "This moves money in the
  books, so confirm it with the person first." Measured: 29 of the 29 `destructiveHint` tools carry a confirm-or-undo word and 0 do not, having been
  7 and 20. The wording differs by what the operation actually costs, because
  "confirm first" and "this cannot be undone" are different warnings: a merge
  and a payee merge say there is no undo, a bulk write says to show the count
  with `dryRun` first, and a transaction delete says it posts a reversal and can
  be undone.
- **House, narrowed 2026-08-25: only a tool whose behaviour changes with scope
  names one.** Scope is enforced by non-registration, so a tool the caller
  cannot use is absent from discovery: "needs ledger:write" on `create_account`
  is read only by an agent that already holds ledger:write, and never by the one
  that does not. It cannot mitigate the missing `insufficient_scope` challenge,
  because the agent that gets "Tool not found" never sees the description.
  Writing it on all 36 gated tools (31 write-only, 5 stage-tier) would add about
  3,600 characters of one convention repeated per tool, which is the case "What
  the whole server says once" exists to refuse. So the tier is said once, in
  `instructions`, which every connection receives whatever it holds, and which
  names the grant this connection actually has and says that a tool outside it
  is absent rather than refused. What a description owes is the *behaviour*:
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
  literal value an agent sends. Six of 71 descriptions use them and all six fit
  that rule, though only two mark a literal (`set_preferences` on
  `system`/`light`/`dark`, `create_transaction` on `allowDuplicate: true`); the
  other four mark a tool name or a field name (`list_payees`,
  `list_duplicate_payees`, `get_preferences`, `list_recurrences`). The narrower
  "literal only" rule is not the one the surface keeps, and the wider one is the
  useful one, because an identifier set in prose is an identifier a model
  retypes wrong.
- **House.** One person and one spelling, per `common.md`. The surface drifts
  between "this user's" and "this person", and between "normalization" and
  "normalised".
- **House, and this guide owns it for the whole set.** Any convention an agent
  must obey appears in a tool or field description, not only in `docs/mcp.md`.
  An agent never reads the prose. `docs/mcp.md:86` states the principle
  already, "Fields carry descriptions, so an agent reading the schema learns the
  conventions that matter"; what makes it a rule is that a convention written
  only in the guide is a convention that has not shipped.
  [`writing.md`](writing.md#keeping-a-document-true) cites this rather than
  restating it.

*Checked by:* tests/mcp-parity.test.ts:415-433`, which asserts only
`length > 30`. All 71 pass, including the 23 that say almost nothing. The same
file also holds the set of descriptions allowed to name a scope at all
(`:529-541`), which is the narrowed rule above, and pins the naming and title
rules (`:496-517`). *Also checked by:* `tests/mcp-measurements.test.ts:103-113`
for the warning word on a destructive tool, which is the sentence above read
back off the surface: it holds both of that sentence's numbers, so a destructive
tool added without a confirm-or-undo word leaves the first alone, moves the
second off zero, and fails. *Also checked by:*
tests/mcp-measurements.test.ts:134-153`, which reads every `snake_case` word in
a description as a claim about a tool and fails on one that is not registered.
Eleven descriptions point at another tool, and the failure it catches is a
renamed tool leaving the sentences that named it behind: the agent that follows
one gets a protocol error, with nothing in the reply saying the instruction was
stale rather than its own call malformed.
*Review only:* whether a description actually teaches, as opposed to being long
enough. The only real
check for that is the evaluation below, and even that measures the outcome.

## Inputs a model cannot get wrong

**House.** The goal is not to reject an invalid call. It is to make one
unrepresentable, so the model's own sampling cannot produce it.

- **Flat over nested, and enums over free text.** A nested object is a shape a
  model has to hold; an enum is a choice it cannot get wrong. Measured: 64
  enums across the input schemas, and 164 more on the output side, where they
  constrain nothing a model sends but are what
  `tests/mcp-output.test.ts:151-174` exists to guard. Half of that output figure
  is the error code, published once per tool for the reason the errors section
  gives. Nesting exists where the
  domain is nested (`legs`) and nowhere else.
- **Unambiguous names.** `categoryId`, never `category`. This is `common.md`'s
  naming rule with a reason attached: a parameter named for a concept rather
  than for the value it takes is a parameter a model fills with the wrong type.
- **Ids are `format: "uuid"`.** See the budget section for why the pattern
  beside the format is a defect rather than belt and braces.
- **A name beside an id, where the server can resolve it.** `categoryName`
  (`src/shared/domain.ts:448-461` for the entry-level field,
  `:276-281` for the leg-level one, which defers to it) lets an agent send the
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
  now publish along with everything else. Measured: 76 of 76 input schemas are
  closed and 0 are open, having been 14 and 57. An open object accepts a
  hallucinated argument in silence and returns success, which teaches the model
  the argument worked and that whatever it thought the argument did is a thing
  this surface does; the next call leans on it. Tools close their own shape with
  a `toolInput` helper or a `.strict()` at the tool boundary rather than by
  closing the schemas they share with `/api/v1`, because what a browser may send
  and what an agent may invent are different questions.
- **Binding, and now true of every field rather than of every parameter.**
  Measured: **0 of 709 carry none**, having been 146 of 225 at the top level and
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
  (`src/shared/domain.ts:192-197`) ends "An account's currency is fixed once it
  is in use", which is what somebody opening an account needs and is not what
  the parameter does on a listing. `currency` filters entries rather than
  accounts: it matches a row either of whose sides carries that code
  (`src/server/services/transactions.ts:1469-1476`), so a conversion comes back
  under both of its currencies and a filtered page is not a page in one
  currency, which is the thing an agent totalling it has to know. It used to
  read that way at five published positions — on `list_transactions` and
  `export_transactions_csv`, and inside `selection.filter` on
  `preview_bulk_transaction_selection`, `bulk_edit_transactions` and
  `bulk_delete_transactions`. **Done**, and in one edit rather than five:
  `listQuerySchema.currency` now carries a filter sentence of its own
  (src/shared/domain.ts:1891-1895`), and the other four derive from it —
  `bulkTransactionFilterSchema` by `.omit()` at `:1912` and
  `stageListQuerySchema` at `:2186`, which is a sixth position nobody had
  counted. The shared sentence is untouched, because it is right where an
  account is being opened. `set_preferences`'s `defaultCurrency` was the same
  sentence in a third context and now says what a default is
  (`src/server/services/preferences.ts:26-28`).
- **House.** Where a mutual exclusion cannot be expressed in a schema that stays
  strict-compatible, state it in the parameter description and refuse it with a
  teaching error. The two bulk selection shapes and the leg-versus-category
  exclusivity are the cases.
- **Binding (a MUST NOT and a SHOULD).** Keep schemas bounded. Implementations
  "MUST NOT automatically dereference `$ref` values that resolve to a network
  URI" and SHOULD bound schema depth and subschema count as a denial-of-service
  defence, so heavy `oneOf`/`anyOf` composition is both a strict-sampling risk
  and a thing clients are told to refuse. Measured: 592 `anyOf` and 7 `oneOf`
  across the surface. 507 of the 592 are two-member nullable pairs, 141 of them
  on inputs; 147 of all the `anyOf` are on inputs and 445 on outputs. The 7
  `oneOf` are all on inputs and are the boolean-or-string-literal coercion. So the composition is
  shallow rather than deep, which is the property the bound is about, and it is
  overwhelmingly nullability rather than genuine union.

*Checked by:* tests/mcp-parity.test.ts:503-517`, which pins three listings to
the schema their service actually parses, `list_transactions`,
`list_staged_transactions` and `list_import_batches`, because "a tool declaring
a wider schema than its service parses is worse than a missing filter".
`list_audit_events` is the fourth cursor-taking listing and is not pinned.
*Also checked by:* tests/mcp-measurements.test.ts:172-179` for the closed
objects and `:236-267` for the described fields, both against the counts above,
so an open schema or an undescribed field fails the suite rather than the
sentence. *Not checked:* that no money argument is a number.

## Outputs, and what the surface costs

Measure before arguing. Re-counted over a real `tools/list` on 2026-08-25, at
roughly four characters to the token. The previous count was 2026-08-23 and had
gone stale by about a quarter, which is what a measurement nothing pins does:
the tool-level numbers below the table are checked by
`tests/mcp-measurements.test.ts` and the table itself is not.

| Token holds | Tools | `tools/list` characters | Approx tokens |
| --- | --- | --- | --- |
| no ledger scope | 0 | `tools/list` is not offered at all | 0 |
| `ledger:read` | 35 | 161,976 | ~40,000 |
| `ledger:stage` | 40 | 195,024 | ~49,000 |
| `ledger:write` | 71 | 403,381 | ~101,000 |

Composition at the write tier: names 1,353, titles 1,718, descriptions 20,464,
input schemas 150,442, output schemas 214,127. **Descriptions are 5.1% of what
an agent loads; names, titles and descriptions together are 5.8%.** Output
schemas are 53.1%.

Two changes on 2026-08-25 account for most of the rise and both were bought on
purpose: describing the output fields whose names mislead, and publishing the
error-code enum at 151 characters a tool and 10,721 in total, each named in the
rule it belongs to below. Dropping `userId` from every schema and every payload
took some of it back.

The largest single contributor is still not a tool. It is **346 copies of one
178-character UUID pattern, 61,588 characters, 15.3% of the whole surface**, and
the share is the same at every tier (15.2% at read, 15.3% at stage).
`"format":"uuid"` is emitted beside every one of them, so the pattern buys
nothing a client cannot get from the format. Dropping it takes the write tier to
341,793 characters and the read tier to 137,412. That is a sixth of the context
an agent spends on this server, recoverable by changing one shared schema.

After that: `get_staged_duplicate` is 24,207 characters, 23,169 of it output
schema; `update_transaction` 22,520 and `create_transaction` 21,635, mostly
input schema.

The rules:

- **Binding.** `AGENTS.md`: "A tool whose result does not satisfy its declared
  output schema fails the call with an `Output validation error` naming the
  offending path, so a wrong schema breaks the tool rather than trimming its
  reply." This is stricter than the specification, which requires that servers
  "provide structured results that conform to this schema" and puts the checking
  on the other side: "Clients SHOULD validate structured results against this
  schema." Record the strictness as deliberate rather than as framework
  behaviour that happens to be there. The failure it exists to stop is the quiet
  one: an enum pinned to a subset of the actor sources "makes every page of the
  audit log containing a new source come back empty"
  (`tests/mcp-output.test.ts:151-174`).
- **Binding.** One envelope, from `common.md`:
  `{ result: <success> | { error: { code, message, details? } } }`, published as
  a two-member `anyOf` by `mcpOutputSchema`
  (src/server/mcp-output-schemas.ts:99-103`) and returned as both
  `structuredContent` and a JSON text mirror built from one serialisation
  (src/server/mcp.ts:245-259`), which is what the specification
  recommends: a tool returning structured content "SHOULD also return the
  serialized JSON in a TextContent block".
- **House, and worth stating because a client author will assume otherwise.**
  Because the published schema legitimises the error member, a strictly
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
  across 34 of the 71 tools, `required` at every one, and every one carrying the
  same constant: the id of the actor that authorised the connection. No agent
  could do anything with it. `AGENTS.md` says "Never accept a public `userId`",
  which is an input rule and does not by itself forbid publishing one; what it
  means here is that nothing on this surface will ever read one back, so the
  field failed this section's own rule rather than an invariant. It is gone from
  both halves. The four declarations that carried it no longer publish it
  (`src/server/mcp-output-schemas.ts`, the versioned entity block and the audit,
  preferences and identity results), and `toolResult` drops the key from the
  payload on the way out (`src/server/mcp.ts`), so the schema and the reply say
  the same thing. The strip is one walk rather than 71 per-tool mappings, and it
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
  only those. Measured: **1,731 output properties, 452 with a description**,
  having been 52, and having gone up by forty-eight when the input fields were
  described — a schema shared between a draft and the row it becomes carries its
  sentences both ways. `decimalSchema` and `timestampSchema` were bare `z.string()`,
  so an agent reading `list_accounts` learned that `balance` is "a string": one
  undescribed primitive repeated across more than a thousand properties. Both
  now say what they are, and most of the described count comes from those two
  plus `versionSchema` (src/server/mcp-output-schemas.ts:41-56`). The rest of
  the surface is deliberately bare: nearly every undescribed name is `id`,
  `name`, `currency`, `date`, `payee` or `notes`, which already give their
  meaning, and where a sentence would buy nothing and cost the payload budget
  three bullets down — one 110-character sentence on `version` costs about 4,700
  characters, because it is emitted 42 times. What was missing was the closed
  list of fields whose names mislead, and the file already explained most of
  them in TypeScript comments an agent cannot read. Those are now `.describe()`:
  `deletedAt` (voided by reversal, still in every balance), `archivedAt` (posted
  out to equity, and a different sentence on a category), `legs` and `legCount`,
  `effectiveRate` (audit only, never applied), `templateId` (provenance, no
  foreign key), `externalId`, `status`, `repeatsStagedRow` (null is "not worked
  out", not "no"), and `chosen`. `tests/mcp-output.test.ts` holds every
  published copy of that list to carrying one, so a new result schema spreading
  an undescribed copy fails rather than passing a total nobody remembers to
  raise.
- **House.** "Nothing found" is never an error and never an empty content block.
  It is the empty collection with the shape intact and the filters echoed back.
- **House, against the vendor skill's advice.** JSON only, with the
  `structuredContent` mirror. No Markdown response format and no prose rendering
  of a figure. A decimal string rendered into a sentence is a decimal string a
  model may reformat, round, or add across currencies, and `common.md` rules that
  no cross-currency total exists.
- **House.** The payload is a tracked number with a ceiling, the way the
  ten-thousand-row cap is. The ceiling is the measured figure above; a change
  that raises it names why in the same commit.

*Checked by:* `tests/mcp-output.test.ts:26-52` for the two-member envelope,
which requires every tool to publish an `anyOf` whose success member is concrete
rather than `{}`, and `:54-84`, which pins eight output schemas and one input
schema to a distinguishing substring. The same file walks every published schema
for the two output rules above: that no schema declares a `userId` outside a
named exception, and that every copy of the closed list of misleading field
names carries a description. *Not checked:* the payload budget. That test is one
`JSON.stringify` and a comparison, and it is the highest-value MCP test not yet
written — the table above went stale by a quarter in two days for want of it.

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
- **House.** `nextCursor: null` currently means two things, end of list and
  ordering not keyset-resumable, and nothing in the result says which. An agent
  walking a ledger under `sort: "account"` gets one page and has to infer the
  fallback from `totalPages`, which the result does carry beside `page`,
  `pageSize` and `totalCount` (`src/server/services/transactions.ts:1416-1419`).
  That is the fallback the `AGENTS.md` sentence above prescribes. The page
  envelope now says which world a caller is in: `cursorAvailable` is on every
  page of both listings, and `nextCursor`'s own description says that null means
  either "last page" or "this ordering cannot be resumed" and points at the
  flag. Before it, an agent walking under `sort: "account"` got one page, a null
  cursor, and no way to tell a finished walk from an unresumable one.
- **House.** A default page size and a maximum are stated in the parameter
  description, because the specification's rule that "clients MUST NOT assume a
  fixed page size" is about the protocol's own lists and gives an agent no help
  here.
- **Binding (SHOULD).** `tools/list` returns tools in a deterministic order, so
  a client can cache the list and a prompt cache can hit. Registration order in
  `src/server/mcp.ts` is that order today and nothing pins it. At 307,855
  characters the cache is worth more here than on most servers.

*Checked by:* nothing on the MCP side. The ordering and cursor rules are tested
at the service layer.

## Errors as a teaching surface

**Binding** for the split, **House** for the sentence, and `common.md` owns the
envelope and the worked sentences.

- **Binding.** A tool fault is a result with `isError: true`, not a protocol
  error, because "otherwise, the LLM would not be able to see that an error
  occurred and self-correct". Unknown tool and malformed request are protocol
  errors. `runTool` (src/server/mcp.ts:261-295`) does this and its comment says
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
  (src/shared/domain.ts:2469-2479`) is a `const` array rather than a bare
  TypeScript union precisely so `toolErrorSchema` can publish it as an enum
  (src/server/mcp-output-schemas.ts:91-97`): a closed list exists so a caller
  can branch — `STALE_VERSION` means read it again, `DUPLICATE` may mean it
  already saved, `VALIDATION_ERROR` means fix the arguments — and it cannot
  branch on a type it cannot see. It is the service half of `apiErrorCodes` and
  not the whole of it, because the five transport codes refuse before any tool
  runs and can never reach a tool result. It costs 151 characters per tool,
  10,721 across the write tier, which is the ceiling above being spent on
  purpose. It gates nothing: the SDK skips output validation whenever `isError`
  is set, and every error path sets it, so a published enum can never drop a
  reply.
- **House.** A message names what was wrong and the next call, by name. The
  specification's own worked example is a sentence, not a code: "Invalid
  departure date: must be in the future. Current date is 08/08/2025."
  `staleVersion` (`src/server/services/errors.ts:72-85`) used to say "This
  record changed since it was loaded. Refresh and try again", which is browser
  copy: an
  agent has nothing to refresh. It now carries both of `common.md`'s worked
  sentences — the diagnosis is the same for everyone and only the advice differs
  — as `message` and an optional `agentMessage` that only the MCP transport
  reads (src/server/mcp.ts:280`), so the browser keeps its own words and
  neither caller is told to do something it cannot. The agent sentence names
  `details.currentVersion` only where the throw site actually carried it;
  thirteen of the fifty do not, and a refusal pointing at a field that is not
  there is the same defect one level down. `notFound`
  (`src/server/services/errors.ts:42`) no longer has a
  default message at all: all forty call sites name what was not found, and
  removing the default makes the compiler keep it that way.
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
field arriving together over a real connection. *Not checked:* that a message
names the next call, which is prose and stays a reviewer's job.

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

- **House.** Three shared constants, so a tool's class is one word at the call
  site: `readAnnotations`, `additiveAnnotations`, `destructiveAnnotations`
  (src/server/mcp.ts:320-337`). Measured: 37 read, 10 additive, 29 destructive.
- **Binding.** `readOnlyHint: true` is a claim the implementation must
  satisfy, not a category label. The specification's rule is addressed to
  clients; for a server an annotation is an assertion, and a false assertion is
  a defect rather than a preference.
- **House.** `destructiveHint` describes what the tool does to the ledger, not
  what scope it needs. Those are different questions and conflating them is how a
  staging tool ends up marked destructive.
- **House, and the reason must be recorded or somebody will break it.**
  `idempotentHint: true` sits on every mutating tool, and it is true only because
  every one of them takes an idempotency key or an expected version. Measured: 39
  mutating tools, 39 with `idempotencyKey` in the schema. Somebody adding a write
  tool without a key would copy the constant and make the annotation false.
- **House.** Three buckets is too coarse at the destructive end.
  `set_transaction_deleted` posts a reversal and the same call restores it;
  `merge_payees`, `merge_categories`, `bulk_delete_transactions` and
  `revoke_connected_agent` sit in the same bucket with nothing like the same
  recoverability. Add a fourth constant for the genuinely unrecoverable. **Work
  to do.**
- **House, and its reason is an absence of evidence.** Only VS Code's use of
  `readOnlyHint` is documented behaviour. Whether any major client acts on the
  other three could not be established, so no rule here depends on a client
  acting on one. The annotations are set because they are true, not because
  something is known to read them.

*Checked by:* tests/mcp-parity.test.ts:326-334`, which derives what a read-only
token may see from `readOnlyHint` rather than from a roster, "because three
recurrence write tools were added to the file in the read block and nobody had to
remember" a list. *Also checked by:* tests/mcp-parity.test.ts:351-379`, which
closes the other direction: a tool annotated `readOnlyHint: true` whose handler
reaches a service that writes a row. That is the worse failure of the two,
because the annotation is what a client shows the person approving the call, and
VS Code's documented use of it decides what may run without asking. What counts
as a write is `tests/support/mutations.ts`, the same reader
`tests/service-transactions.test.ts` uses for the services guide, so this
repository has one definition of a write rather than two that drift.

## Scope, and why this surface will not consolidate

Anthropic's guidance is that "a common error we've observed is tools that merely
wrap existing software functionality or API endpoints", that "Claude's ability to
pick the right tool degrades once you exceed 30-50 available tools", and, in the
platform docs, that related operations should be grouped "into a single tool with
an `action` parameter". Seventy-one tools sits above that band and this surface
is not going to consolidate. The reason is mechanical rather than stylistic and
it is the strongest specific argument available.

**House, and it is the property the whole design rests on: every tool has
exactly one scope.** The specification permits the variation rather than
requiring it, so this is a decision and not an obligation; it is argued at
length because it is the one that decides the tool count.

A tool is gated by which of three registration blocks it sits in
(src/server/mcp.ts:593`, `:1123` and `:1226`), and scope is enforced by
non-registration, so a tool the caller cannot use is **absent from discovery**
rather than present and refusing. Measured: 37 tools at `ledger:read`, 42 at
`ledger:stage`, 76 at `ledger:write`, and a token with no ledger scope gets a
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
  *behaviour* switch rather than a gate — `stage_csv`,
  `update_staged_transaction` and `bulk_edit_staged_transactions` — which is how
  `ledger:stage` proposes without deciding. A tool whose
  result differs by scope is still one tool with one scope: the wider scope
  changes what it may create, not whether it may be called.
- **Binding.** `AGENTS.md`: "`ledger:stage` proposes and never decides. Creating
  a category, bringing an archived one back, or widening what kind of entry it
  may carry are changes to the ledger's own records and need `ledger:write`,
  wherever they are reached from, including a CSV import." `stage_csv` is the
  worked case and its description is the model for saying so
  (src/server/mcp.ts:1207-1215`).
- **House.** Read, propose, write are three tiers answering three questions.
  `dryRun: true` asks "what would this do", synchronously, leaving nothing
  behind; it is on 7 tools. `ledger:stage` says "do this when a person agrees",
  durably. `ledger:write` decides. The propose tier is complete when every write
  has a proposal form, not when the queue has a row type; today `ledger:stage`
  adds five transaction-shaped tools to the read set, so an agent holding it can
  propose new transactions and nothing else. The obvious ask, "suggest
  recategorising six months of groceries and let me look before it lands", has no
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
  (src/server/api.ts:829-837`, served at `:856`), because RFC 8414's field is
  what the server accepts and Better Auth's accept-list at `/authorize` is the
  union of its four defaults with our three
  (`node_modules/better-auth/dist/plugins/oidc-provider/authorize.mjs:23-33`).
  The protected-resource document is the one the Common Mistakes list is about,
  because it is what a client builds its scope request from — the SDK joins
  `scopes_supported` verbatim, ahead of the client's own configured scope, in
  `client/auth.js`'s `resolvedScope` — and it publishes that same array
  (src/server/api.ts:838`, served at `:863`).
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
  `/api/auth/.well-known/oauth-protected-resource` (src/server/api.ts:799`),
  which is where `withMcpAuth`'s own 401 sends a
  client on first contact, since narrowing only the RFC 9728 paths would leave
  the advertisement everybody reads untouched and the one nobody reads correct.
  And it has to keep `offline_access` whatever else goes, because Better Auth
  issues a refresh token only when that scope was requested, and a long-lived
  client without one re-authorises by hand.
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
  token's tool list is unchanged. Two details are load-bearing and both were
  nearly got wrong. The tier test is `satisfiesToolScope`, not `hasScope`:
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
  scope changes behaviour rather than access are the real case and already say
  so in their own words.
- **Binding (MUST), met.** `hasScope` (src/server/mcp.ts:453-458`) implements
  the scope hierarchy the specification requires servers to account for: stage
  and write both satisfy read.
- **House, and its reason is an absence of evidence.** Whether 71 tightly
  related, consistently named ledger tools behave like 71 unrelated ones could
  not be established: Anthropic's 30-to-50 band describes an aggregated
  multi-server context. So no rule here rests on the band in either direction,
  and the payload is measured rather than argued about.
- **House, the compensations owed.** Publish the count per tier and not the
  total. Track the payload against a ceiling. Keep names, descriptions and
  argument names readable, because that is exactly what a client's tool search
  reads. Toolsets by area remain an available option, following GitHub's
  precedent, with the honest note that the protocol does not standardise how a
  client opts in.

*Checked by:* tests/mcp-parity.test.ts:326-334` and `:381-413`;
`tests/mcp-output.test.ts:118-127`, which asserts that a token holding no ledger
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
a route no page calls needs a named exception of its own. A capability a person
cannot reach is not parity, it is a second product."

The second direction is the unusual half and it is worth the sentence it costs.
A surface only agents can reach is a surface nobody watches: no screen shows what
it did, no person can undo it by hand, and its bugs are found by the agent that
hits them. Requiring a page to call the route first means every capability has a
human witness.

- **Binding.** `AGENTS.md`: "Two exceptions, both account management rather than
  bookkeeping: deleting an account and setting a sign-in password are reachable
  from a session and never from an MCP token."
- **House.** An exception carries a written reason, not a name on a list. Four
  browser-only exceptions (`tests/mcp-parity.test.ts:19-28`) and one agent-only
  (`:580-583`) each carry a paragraph.
- **House, and the honest limit.** Parity proves coverage and wiring. It does not
  prove that a tool accepts the same filters or writes the same fields, and only
  three listings are pinned to their service's schema. It proves nothing at all
  about whether an agent can use the surface. No published guidance recommends
  interface-parity testing for an MCP server; as far as this project's research
  established, it is an original practice, and it should be described as what it
  is rather than as evidence of quality.

*Checked by:* `tests/mcp-parity.test.ts`, both directions. Forward at `:235-250`
(every route reachable through a named tool) and `:266-295`, which extracts which
service each route and each tool calls and compares them, with a `compared` floor
at `:290` guarding the regex from silently matching nothing. Backward at
`:556-583`, which matches each route's whole path against `src/client`, each
parameter standing in for a template hole rather than only the prefix before the
first one: `/api/v1/accounts` is satisfied the moment anything fetches an
account, which left every parameterised sub-route beneath it unchecked and a
page free to stop calling one. Exceptions are policed at `:254-258`, which fails
an exception naming a route that no longer exists, and at `:586-590`, which
fails any agent-only reason under forty characters. Nothing measures the
browser-only reasons; they stay a reviewer's job. The two forbidden capabilities
are pinned by name at `:309-319`.

## Idempotency, versions and state handles

- **Binding.** `AGENTS.md`: "Updates/deletes require an expected version.
  Commits, and creates that write postings, require idempotency; a record
  somebody names is protected by its own name being unique, so a second submit
  fails rather than duplicating."
- **House, stricter than the invariant, and it should stay.** Every mutating
  tool on this surface takes an `idempotencyKey`, not only the ones that write
  postings. Measured: 36 of 36. One schema and one description
  (`src/shared/domain.ts:218-242`), so the convention reads identically on every
  tool. An agent retrying a timed-out call is the normal case here, not the
  exceptional one.
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
  silent empty result. The bulk selection fingerprint is the case here.

*Checked by:* the idempotency and version behaviour at the service layer, and
tests/mcp-measurements.test.ts:312-334` on this surface, which is what stops
`idempotentHint` becoming a lie: it counts the mutating tools from the
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
  client. The server cannot stop an injected instruction being read. It can bound
  the blast radius, and it does: `ledger:stage` decides nothing, deleting posts a
  reversal, updates carry expected versions, bulk selections carry fingerprints,
  and every write is audited with `actorSource` and `clientId`.
- **House, and the marking that was actually cheap.** The instructions say once
  that payee, description, notes and a staged row's `rawData` are free text this
  person did not necessarily write, that an `externalId` or an `importBatchId`
  means the row came from a bank's CSV, and that all of it is data and never an
  instruction. Both provenance fields were already on the wire and now say in
  their own output descriptions what they mean, `rawData` with them. What was
  not done, and will not be: a provenance column on `ledger_transaction`, which
  has `external_id` and no `import_batch_id`. It would need a forward-only
  migration, a backfill that can only guess from whichever staged rows survived,
  and a place on the transactions page for a person to see it — all to buy a
  label that still does not stop an injected instruction being read. This is a
  marking for a model already reading the text, not a control, and the control
  remains the blast radius above it. The input side says it too: the shared
  `externalId` now carries the same warning, so an agent reads it on the way in
  rather than only on the way back.
- **House, framing an existing behaviour so it is not optimised away.** Routing
  every authorization request through the consent screen, including for
  signed-in users and clients that omit `prompt=consent`, is the confused-deputy
  mitigation, not a UX preference.
- **Binding.** A protected MCP server "MUST validate that access tokens were
  issued specifically for them as the intended audience" and "MUST NOT accept or
  transit any other tokens". This deployment binds the audience to its own `/mcp`
  and replaces anything that is not a JWT it signed, in either header shape
  (src/server/api.ts:930-943`).
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
| Icons | Nothing renders them here. |
| `x-mcp-header` | Nothing needs proxy routing, and the sensitive-parameter warning points the wrong way for a ledger. |
| `server/discover`, caching hints, `_meta` version negotiation | Wanted, and blocked on the SDK. See the first section. |

Dynamic client registration is implemented and open, "as RFC 7591 intends"
(`docs/mcp.md:36-38`), and it is now on the deprecated path: DCR was deprecated
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
of unapproved registrations has no CIMD analogue because there is no stored
registration to sweep.

*Not checked mechanically.* Nothing fails if a deprecated feature is adopted, and
nothing fails if one of these documents goes stale on the point.

## Proving it works

Two different things, and only one of them is a test.

- **Binding.** `AGENTS.md`: "Exercise new tools over a real connection rather
  than trusting the schema alone." Both MCP test files do this, connecting a real
  client to a real server over `InMemoryTransport` rather than asserting against
  the registry, which is why they catch schema faults a registry inspection
  cannot show. A new tool is exercised the same way.
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
| Every `/api/v1` route is reachable through a named tool, or is a named exception with a reason | tests/mcp-parity.test.ts:233-248` |
| A tool reaches the same service as its route | tests/mcp-parity.test.ts:264-293` |
| No route exists that no page calls, without a named exception | tests/mcp-parity.test.ts:556-584` |
| Deleting an account and setting a password are absent from the tool list | tests/mcp-parity.test.ts:307-317` |
| Every registered tool is named in `docs/mcp.md` | tests/mcp-parity.test.ts:300-305` |
| A read-only token sees nothing that declares itself a write | tests/mcp-parity.test.ts:326-334` |
| A listing declares the schema its service parses | tests/mcp-parity.test.ts:503-517` |
| Every tool publishes a concrete two-member output schema | `tests/mcp-output.test.ts:26-52` |
| A token with no ledger scope gets no tools | `tests/mcp-output.test.ts:118-127` |
| A description is longer than thirty characters | tests/mcp-parity.test.ts:415-433` |
| A tool name is well formed and no title claims another tier's verb | `tests/mcp-parity.test.ts` |
| The `tools/list` payload stays under its ceiling | **Not checked.** Highest value of the unwritten tests. |
| A destructive tool's description warns | `tests/mcp-measurements.test.ts:103-113` |
| A tool whose behaviour changes with scope names it, and no other tool does | `tests/mcp-parity.test.ts` |
| An under-scoped call is a 403 naming the scope, and a misspelled name is not | `tests/mcp-scope-challenge.test.ts` |
| Both discovery documents still advertise every tier a client already had | `tests/mcp-discovery-scopes.test.ts` |
| `TOOL_SCOPES` still agrees with the three registration blocks | `tests/mcp-measurements.test.ts` |
| No output schema declares a `userId`, outside a named exception | `tests/mcp-output.test.ts` |
| Every published copy of a misleading output field carries a description | `tests/mcp-output.test.ts` |
| A tool named in a description exists | **Not checked.** Green today. |
| A mutating tool takes an idempotency key | tests/mcp-measurements.test.ts:312-334` |
| `readOnlyHint` matches where the tool is registered | **Not checked.** |
| Tool order is deterministic | **Not checked.** Registration order is the de facto order. |
| CIMD is offered before DCR, and the documents say which is current | **Not checked.** |
| A convention an agent must obey appears in a description, not only in `docs/mcp.md` | **Not checked.** Review. |
| The server instructions name the grant, the two error envelopes and untrusted text | `tests/mcp-instructions.test.ts` |
| The named revision is the one the SDK negotiates | **Not checked.** |
| Every parameter carries a description | `tests/mcp-measurements.test.ts`, held at zero |
| Every input schema is closed | tests/mcp-measurements.test.ts:172-179` |
| Every output field carries a description | **Not checked**, and deliberately not a rule. The misleading ones are checked by name above. |
| Whether a description teaches | **Review only,** and the evaluation above is the nearest thing to a check. |

A rule that appears in neither column is a rule nobody is responsible for, and
that is a defect in this guide rather than in the code.
