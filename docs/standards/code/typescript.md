# TypeScript

The language, and what the compiler has been told to refuse.

Two programs, not one. Everything numbered below is about the application —
`src`, `tests` and the root config files — unless it says otherwise, and the
infrastructure programs under `deploy/pulumi` are a second program compiled by a
second compiler under settings that disagree with these on purpose. §3.5 is that
boundary, and four rules here cite it because their scope stops at it.

## 1. Strictness

### 1.1 What is on

**Binding.** `strict` has been on since the beginning. Eight more flags — the
seven rows below, of which the first names two — were measured against this
repository before going on; all but one cost nothing, and the one with a price
(`erasableSyntaxOnly`, five lines, §1.2) was worth it:

| Setting | Refuses |
| --- | --- |
| `noUnusedLocals`, `noUnusedParameters` | Dead bindings. |
| `noImplicitOverride` | A method that overrides without saying so. |
| `noFallthroughCasesInSwitch` | A `case` that runs into the next one. |
| `allowUnreachableCode: false` | Code after a `return`. |
| `allowUnusedLabels: false` | A label nothing jumps to. |
| `verbatimModuleSyntax` | A type imported as though it were a value. |
| `erasableSyntaxOnly` | Syntax that survives type stripping. |

This table is `tsconfig.json`, and `tsconfig.json` is not the whole repository.
The infrastructure programs set `strict` and two of these eight and add one this
guide declines (§3.5), so "what is on" has two answers and this is the one that
covers the product. Which half a rule is checked in is worth saying out loud
rather than leaving to whoever next runs a sweep.

*Checked by:* `npm run typecheck`, which is `tsconfig.json` and
`tsconfig.server.json` (`package.json:25`) and reaches no further. The
infrastructure half is a separate compiler run in a separate CI job
(`.github/workflows/verify.yml:441-445`); `npm run verify` does not include it.

### 1.2 `erasableSyntaxOnly`, and the two classes it changed

**Binding.** Every construct in this repository erases. Nothing here compiles to
runtime behavior that is not visible in the source: no `enum`, no `namespace`,
no constructor parameter properties.

The last of those cost five lines. `AppError` and `ApiClientError` both declared
their fields in the constructor signature, which is TypeScript-only syntax that
emits assignments. They now declare fields and assign them
(`src/server/services/errors.ts:31-61`,
`src/client/api.ts:35-67`).

The gain is not stylistic. It means `node --experimental-strip-types` and every
other type-stripping runtime can run this source directly, and it means reading
a constructor tells you what it assigns.

"Every construct in this repository" was a repository-wide sentence enforced in
half of it. The infrastructure programs do not set the flag and erase anyway,
which is luck rather than enforcement: nothing there would have refused an
`enum`. They are held to the same three refusals by a test now, read off the
source rather than off a compiler, because that compiler cannot be run from this
suite — `deploy/pulumi/node_modules` is a separate install the job running these
tests does not do, which `tests/support/pulumi-source.ts:9-15` already says from
the other end.

*Checked by:* `npm run typecheck` for the application half. TS1294 fires on the
syntax itself, so a constructor parameter property fails the build as readily as
an `enum` does, rather than being caught in review. And
`tests/typescript-guide.test.ts` for the infrastructure half, which reads the
three constructs out of the blanked source. Neither says anything about the
gain: a class that declares its fields and assigns them somewhere unreadable
erases just as well.

### 1.3 `noImplicitReturns` is declined

**Contested.** The flag is good advice in general and wrong here. All three
sites it flags are Hono middleware
(`src/server/api.ts:1352`, `src/server/http-security.ts:480` and `:938`),
where a `MiddlewareHandler` returns a `Response` to answer the request or
nothing at all to let the next handler run. "Returns on some paths and not
others" is the contract, not a mistake.

Adopting it would mean writing `return undefined` three times to mean "carry
on", which is noise that reads as an oversight. Declined, and this paragraph is
the record so nobody re-measures it.

It is declined *for the application*. The infrastructure programs turn it on
(`deploy/pulumi/tsconfig.json:11`) and are right to: there is no middleware
there, so the flag costs nothing and the reason above does not reach them. A
flag this guide declines being on elsewhere in the tree is the shape §3.5 is
about.

The first of those three citations had moved by about forty lines and still
resolved, which is the citation failure that reads as evidence: the line it
named had become a docblock about the authorized-sellers file, with nothing to
do with middleware, and `tests/standards-citations.test.ts` cannot see that
because the file exists and the line is inside it. So the three are no longer
transcribed. They are read back out of the compiler and compared with what this
paragraph says, which makes the citation the measurement.

*Checked by:* `tests/typescript-guide.test.ts`, which runs the flag and holds
the sites it reports against the three cited here — a fourth site, or one of
these three moving, fails the test rather than arriving unargued. It cannot
judge the decision, only keep the evidence for it true.

### 1.4 `noUncheckedIndexedAccess` is declined, for now

**Contested.** 575 errors, **59 of them in `src`** and the rest in `tests`. It
is the setting on this list most worth having, because indexing into an array or
a record is exactly where an `undefined` arrives unannounced.

It is not, as this section used to claim, where the non-null assertions counted
in 2.2 came from. Only a minority of those 167 sit on an index or a lookup at
all, and most of that minority are `.at(-1)`, a `Map.get` or a regular
expression group, all of which hand back `undefined` with the flag off. So it is
the flag that would add to that count rather than the flag that explains it,
which is what 2.2 says from the other end.

It is declined because 575 sites cannot be reviewed carefully in one change, and
mechanically silencing them with `!` would convert a real check into a
formality — the same defect the flag exists to catch, now written down. If it is
ever adopted it should be one directory at a time, and the split above says
which one first: `src` is 59 of the 575 and all of the benefit, since a test
that indexes a fixture it wrote three lines earlier learns nothing from being
told the row might be missing.

The two halves move for different reasons, which is why only one of them is
checked. `src` has sat at 59 across a release that added billing, two cloud
profiles and a plan page; the total went from 441 to 575 because the branch
added tests, and a number that every new test file moves is one a check would
teach people to bump without reading. So **59 is held by a test and 575 is a
reading**, which is the same division `testing.md` makes about its own two
tables and for the same reason.

`exactOptionalPropertyTypes` (110) and `noPropertyAccessFromIndexSignature`
(966) are declined outright. Both readings, both taken the same day as the 575.

Each is the error count from `npx tsc -p tsconfig.json --noEmit --<flag>`, taken
against the whole of `tsconfig.json`. What that is had been stated wrongly here:
not `src`, `tests` and the five root config files, but those **plus whatever
they import**. The compiler follows an import past the include list, and the
suite imports five files out of `deploy/pulumi` — four modules and the
`.d.mts` beside the settings script — and five `.d.mts` declaration files out of
`scripts/`, so all ten are inside every
number in this section and inside every flag in 1.1 — and nothing said so. It is
not academic: two of the 110 above are in `deploy/pulumi/aws-single/platform.ts`
and `deploy/pulumi/oci-single/platform.ts`, files §3.5 describes as belonging to
the other program and which this one typechecks as well.

*Checked by:* `tests/typescript-guide.test.ts` for the `src` half of the first
flag, which runs the compiler and compares what it reports with the number this
section states, and which also holds the ten-file list in the paragraph above
so an eleventh cannot arrive unnoticed. `human` for the three whole-program totals:
a reading goes stale quietly, so read one as the last reading rather than as
today's and take it again before arguing from it.

## 2. Types

### 2.1 `any` does not appear

**Binding.** There is no `: any` in `src`. Zero occurrences, and the number to
hold is zero.

`unknown` is the type for a value that has not been checked yet, and the check
is a Zod parse rather than a cast. `AppError.details` is `unknown`
(`src/server/services/errors.ts:34`) because it
carries whatever the thrower had, and every reader narrows before use.

*Checked by:* `tests/no-explicit-any.test.ts`. `no-explicit-any` is a
`typescript` plugin rule outside `correctness`, so `npm run lint` does not run
it; the test runs oxlint itself over `src` with that one rule denied and reads
the diagnostics back. It deliberately does not grep. A grep for `: any` cannot
see `as any`, `any[]`, `Record<string, any>` or a bare `<any>` type argument,
and it does see the word in prose — "as good a name for the row as any" in
`TemplatesPage.tsx` — so a parser finds all four spellings and neither
comment. A second case points the same rule at a fixture written outside the
tree holding all four, so the zero above is a rule that fires rather than a rule
that never had anything to find.

### 2.2 Assertions are rare and each has a reason

**House.** Four `as unknown as` in the whole of `src`, and **167 non-null
assertions across 37 files**, counted with
`npx oxlint -D typescript/no-non-null-assertion src` for the reason 2.1 gives:
a `!` is punctuation, and a grep meets it in `!==` and in every negation this
codebase writes. Neither number is zero and neither should be: a `!` after a
lookup that a database constraint guarantees is honest, and the alternative is a
branch that cannot be reached and cannot be tested.

The one this section was written about is
`src/server/services/accounts.ts:572`, building the row an archived account
would have had so the caller sees the shape it expects; the alternative was
making every field optional for one call site. The other three are a different
thing wearing the same syntax, and 2.6 is their rule: each is confined to one
property at the boundary with a library, carrying a runtime fact that library's
published types cannot express. All three were unrecorded here for a release,
which is how a count of one survived alongside three casts nobody had argued.

Four is not a count going the wrong way, and the earlier reading of three
falling to one was not a trend. Three of the four arrive on a vendor's release
schedule rather than this repository's, so the number tracks how many libraries
this product talks to. The sentence that stood here said the count was "moving
the right way", in the present tense, two releases before it moved the other
way; a claim about a direction is read as live and cited as one, which is why
this paragraph states the mechanism instead.

167 is higher than it looks like it should be, and 1.4 is why it is not higher
still: without `noUncheckedIndexedAccess`, indexing an array gives a
non-optional type, so most of these were written for some reason other than an
index. Adopting that flag would raise this number a great deal before lowering
it.

The rule is about which of the two you are doing. A `!` standing in for
"I checked this three lines up" is fine. A `!` standing in for "it is probably
fine" is a bug that has not happened yet, and the honest form of it is a
`throw`.

*Checked by:* `tests/typescript-guide.test.ts` for the register of four, which
is the half that went wrong: a fifth `as unknown as` fails until somebody writes
down which of the two kinds it is. `human` for the `!` count and for whether any
given assertion has a reason, neither of which is mechanizable.

### 2.3 A union of literals, not an enum

**Binding**, by way of 1.2. Every closed set is a `readonly` tuple plus a type
derived from it:

```ts
export const categoryKinds = ["income", "expense", "both"] as const;
export type CategoryKind = (typeof categoryKinds)[number];
```

(`src/shared/domain.ts:120-121`.)

The array is the single source: Zod validates from it, the database enum is
generated from it (`src/server/db/schema.ts:199`),
and the UI iterates it (`src/client/pages/CategoriesPage.tsx:135`).
Adding a member is one edit, and every one of those follows.

*Checked by:* `npm run typecheck`, for the half of it that is a refusal:
`erasableSyntaxOnly` rejects an `enum` outright, and because the type is derived
from the array rather than written beside it, a member added in one place cannot
disagree with a reader that already exists. And `tests/closed-sets.test.ts` for
the half nothing asked: a closed set hand-written as a bare union of string
literals used to pass every check here.

`tests/client-closed-sets.test.ts` covers the one position that check cannot
reach. Its `inlineUnions()` anchors on what may precede a *type* — a property, an
annotation, a parameter, a type argument — and a union that follows `as` is
preceded by none of them, so an assertion was invisible to it. That is also the
worse of the two spellings: a stale property type fails to compile at the
assignment, while a stale assertion goes on claiming a value it no longer
covers, so a member added to the tuple leaves it silently wrong at build time. It found three — the recurrence
vocabularies in `src/shared/recurrence-dates.ts`, the client's `AuthMode`
against `src/server/config.ts`, and the client's `BudgetPeriodUnitName` against
`budgetPeriodUnits`, which is the constant section 2.4 below holds up as the
model, hand-copied one directory away.

The rule it enforces is deliberately narrow: not "every closed set must be a
tuple", which would fire on correct inline unions used once, but "no union whose
member set equals a tuple that already exists". That is one set spelled twice,
and the two can come apart.

A `type X = "a" | "b";` alias is only where such a union is easiest to see, not
where it stops. The same set restated as a property or a parameter type reads as
part of a shape rather than as a declaration, and nine had accumulated there:
four response shapes in `src/client/api.ts` (`accumulation`, `policy` twice,
`amountRule` and `basis`), `initialType` in `TransactionBrowser.tsx`, `kind` in
`ImportPage.tsx`, `mode` in `src/server/auth-policy.ts`, and `LOG_LEVEL`, which
was the worst of them: the four levels were spelled three times over — the
`logLevel` field's type, the `z.enum` that parses the variable, and `ORDER` in
`log.ts` — agreeing only by coincidence. Every one of the nine had the shared
type already imported into the same file, or one line away from being.

`LOG_LEVEL` is also where the fix had a direction to get right. The tuple went
into `src/server/config.ts:13` rather than `log.ts`, because `log.ts` already
reads `getConfig().logLevel`: a closed set belongs to the layer underneath
everything that reads it, and putting it in `log.ts` would have made the
configuration layer import the logger to describe its own field.

Both halves of the check share one index of tuples, and the inline half carries
a `COINCIDENCE` register for a union whose members equal a tuple's by accident
rather than by meaning. It is empty.

### 2.4 `satisfies` where a value must stay inside a type without losing its own

**House.** Three uses, and all three earn the keyword by the same test. The
clearest one:

```ts
export const budgetPeriodUnits = [
  "week",
  "month",
  "quarter",
  "year",
] as const satisfies readonly ReportBucket[];
```

(`src/shared/domain.ts:1410`.)

`as const` keeps the four literals; `satisfies` checks that every one of them is
a bucket the report engine can group by. Annotating the constant
`readonly ReportBucket[]` instead would have done the check and thrown the
literals away, and the budget code needs them.

Calling that the only use in `src`, as this section did, told a reviewer meeting
either of the other two that the rule working was a deviation from it. Both pass
the test the `securityHeaderOptions` paragraph below sets, and one of them is
load-bearing by `AGENTS.md`:

- `PLAN_LABELS` (`src/shared/domain.ts:3364-3367`) is, in `AGENTS.md`'s words,
  "the one place a plan's name is written". `satisfies Record<Plan, string>` is
  what makes a plan added without a label fail to compile; `as const` is what
  keeps `PLAN_LABELS.plus` the literal `"Premium"` rather than `string`, which
  is what `tests/product-facts.test.ts:61` asserts and what the marketing site
  reads through `docs/product/facts.json`. Annotating `Record<Plan, string>`
  would do the first and lose the second.
- `authReporting` (`src/server/auth.ts:75-98`) returns the logger and error
  handler Better Auth is configured with, checked against
  `Pick<BetterAuthOptions, "logger" | "onAPIError">` without being flattened
  into it. `src/server/auth.ts:121` spreads the result and
  `tests/auth-log.test.ts:379` destructures `.onAPIError` off it — which the
  library's own type makes optional, so an annotation would stop that
  compiling.

The second use is worth recording as it went. `securityHeaderOptions` used
`satisfies` on a literal until it grew a second shape — a report-only policy has
a different key from an enforcing one — and a `satisfies` on a value that is one
of two shapes narrows to whichever branch was written, so reading the other one
stopped compiling for callers. It carries an explicit return type now
(`src/server/http-security.ts:210`). That is the line where `satisfies` stops
being the better tool: it is for checking a literal without widening it, not for
describing a value that has more than one shape.

*Checked by:* `tsc` for what each `satisfies` asserts. Nothing counts them, and
a count was exactly what went stale, so the three above are named rather than
totalled: a fourth arriving does not falsify a sentence here.

### 2.5 Discriminated unions carry the discriminant in the name

**House.** A transaction draft is a union on `type`, and each member declares it
as a literal (`src/shared/domain.ts:558`). Every
function that takes one either handles all three or narrows first. This is why
`noFallthroughCasesInSwitch` was free: there was nothing to find.

*Checked by:* `tsc`, which refuses a member's own field before the union has
been narrowed, and `tests/domain.test.ts` by way of importing the module at all:
Zod builds these unions at load and throws "Invalid discriminated union option
at index" on an option carrying no literal discriminant, so a member that lost
its `type` fails at import rather than at a parse. Neither can ask for a
discriminant on a union that never had one.

### 2.6 A cast at a library's type boundary names the one property it adds

**House.** Three of the four `as unknown as` in `src` are one pattern across
three unrelated vendors, two of them new in 0.2.0. Each is confined to a single
property, asserts nothing about the rest of the value, and carries the runtime
fact the published types are missing:

| Where | The one property | The fact the types are missing |
| --- | --- | --- |
| `src/server/stripe.ts:352` | `current_period_end` | Stripe moved the period boundary onto the subscription's items; an account on an older API version still sends it on the subscription. |
| `src/client/ads.tsx:115` | `requestNonPersonalizedAds` | Google's tag takes the flag on the queue array itself, which is typed as an array. |
| `src/shared/domain.ts:24` | `pattern` | Zod's registry types the value as a string, and `undefined` is what *removes* the key from the emitted JSON Schema. |

The single property is in the asserted type for the first two — `subscription`
and `queue` are the library's own values, and the cast adds a field to each. It
is in the *value* for the third: Zod's published type is already
`Record<string, string>`, so the fact it cannot express is not a missing key but
one key's value being `undefined`, and the literal `{ pattern: undefined }`
names it. Both spellings confine the cast to one name, which is what the rule
asks; neither widens anything else.

That discipline is the rule, and it is what separates these from the fourth —
`src/server/services/accounts.ts:572`, which assembles an internal row shape and
which 2.2 already records. A cast confined to one property can be read, checked
against the vendor's changelog, and deleted when the vendor catches up. A cast
that asserts a whole shape cannot.

Two alternatives, both worse. The explicit escape hatch — `as any`, or a
parameter typed `any` — is forbidden outright by 2.1, and it is also strictly
less safe here: it discards every *other* field's type to recover one. Widening
the value's own declared type, by re-declaring the vendor's interface through
module augmentation or by keeping a local `StripeSubscription` that adds the
field, makes a library's lag permanent in this repository and silently survives
the upgrade that fixes it — the augmentation keeps compiling, so nobody ever
learns the cast could go. A one-property cast with a comment above it is
something a reader can delete.

The shape is not optional. Each of the three carries, in the comment beside it,
what the vendor does and why reading the typed path alone is wrong; the Stripe
one says what a missing boundary silently becomes ("no grace" on a failed
renewal), which is the sentence that makes it reviewable rather than tolerated.

This recurs on the vendors' schedule rather than this repository's, which is why
it is a rule and not a note on three lines: a product that talks to a payment
processor, an ad network and a schema library will meet the next one without
being asked.

*Checked by:* `tests/typescript-guide.test.ts`, which holds the register of four
and refuses a fifth. It checks the shape it can see — that a boundary cast is
confined to exactly the one property named in the table above, counting braces
rather than stopping at the first `}` so a second property cannot hide in a
nested one — and not the comment, which stays a reviewer's job.

## 3. Modules

### 3.1 Every relative import in `src` and `tests` ends in `.js`

**Binding in `src` and `tests`.** Source says `.ts`; imports say `.js`, because
that is what Node resolves at runtime under `"module": "NodeNext"` in
`tsconfig.server.json`. Every relative import in `src` and `tests` carries one,
with no exceptions to argue.

This looks wrong the first time and is not. `import { decimal } from "./helpers.js"`
in a `.ts` file is correct, and dropping the extension breaks the server build
and nothing else, which is the worst kind of break: the client bundler forgives
it, so it passes locally.

**The infrastructure programs invert it, and are correct.** All eighteen relative
imports under `deploy/pulumi` drop the extension —
`import * as sb from "../common"` at `deploy/pulumi/aws/index.ts:6` is the
shape — because that project sets `"moduleResolution": "node"`
(`deploy/pulumi/tsconfig.json:5`) and emits CommonJS, where an extension-less
specifier is what resolves. The rationale above reaches NodeNext and Bundler and
stops there, so a mechanical sweep that "fixed" those eighteen would break five
programs that compile today. §3.5 is why there are two answers at all.

Four of the eighteen are inside files the application's own compiler reads
(1.4), so one program typechecks both conventions at once. That is not a
problem — Bundler resolution accepts an extension-less relative specifier — but
it is why this rule was stated repository-wide for a release without failing
anything, and why it now says where it applies.

*Checked by:* `tsc`, via `npm run build:server`, for the half that would break
the build. And `tests/typescript-guide.test.ts` for both halves as populations:
every relative import under `src` and `tests` carries a runtime extension, every
one under `deploy/pulumi` carries none. Stated as two populations rather than
one rule plus an exception list, because an exception list is a claim about what
exists made by somebody who could not see the next program.

### 3.2 A type import says `type`

**Binding**, by `verbatimModuleSyntax`. `import type { Actor } from ...`, or
`import { type CategoryKind, categoryKinds } from ...` when a module gives you
both. The flag was free, which means the codebase already did this everywhere.

*Checked by:* `npm run typecheck`. TS1484 names the binding that needs the
keyword, which is why both spellings above are fine and only the missing keyword
fails; nothing here prefers one of the two.

### 3.3 `src/shared` may not import from `src/server` or `src/client`

**Binding.** `src/shared` is the code both sides run: the domain schemas, the
CSV grammar, the name normalization, the recurrence arithmetic. It is imported
by a browser bundle, so a stray `node:` import there ends up in the client or
fails the build.

The direction is `shared ← server` and `shared ← client`, never the reverse and
never `server ↔ client`.

*Checked by:* `tests/module-boundaries.test.ts`, which walks the import graph
rather than grepping for a path, resolving every specifier to a real file before
judging it, so an import that reaches `src/server` through a re-export is caught
and `src/server/db/client.ts` is not mistaken for the browser. It holds the
`node:` half as well: a built-in imported from `src/shared` or `src/client`
fails there rather than at the next person's build.

### 3.4 Money is exact on both sides, by two different means

**Binding.** `AGENTS.md`: "Never represent money with JavaScript/JSON
floating-point numbers."

The server uses `decimal.js` through one wrapper
(`src/server/services/helpers.ts:22`).
The client uses scaled `bigint` (`src/client/money.ts:186`,
`src/client/money.ts:201`),
because the browser bundle should not carry a decimal library to render a table.

Two implementations of one rule is a risk worth naming: they must agree. What
keeps them agreeing is that both take and return the same canonical decimal
strings, and `tests/client-money.test.ts` pins the client half against cases the
server half decides.

The rule for a reader: never `Number(amount)`, on either side, for anything that
is compared, summed, or shown. `Number` appears in this codebase only where the
result is a pixel or a percentage that is already approximate.

*Checked by:* `tests/ledger.test.ts`, which "keeps all numeric(44,18) digits
during arithmetic" on the server half, and `tests/client-money.test.ts`, which
"keeps every integer digit exact without converting through Number" on the
client half at twenty-six integer digits. Both pin an implementation at cases a
float loses, which is what makes them evidence that the two agree. Neither
refuses a `Number(amount)` written somewhere else;
`tests/money-never-floated.test.ts` does, over all of `src` with the comments
blanked, flagging any money-named identifier inside a `Number()` or a
`parseFloat`. Its register is empty, because nothing in `src` floats a
money-named value today, and it is pinned at more than thirty call sites so a
scanner that has stopped matching fails rather than reporting the tree clean.

**It is keyed on names, and so it cannot see money under a different one.**
`fillPercent(limit, actual)` in `src/client/budget-display.ts` takes two decimal
strings and calls them `limit` and `actual`; a `Number(actual)` added there
passes. That is inherent to the shape, `client.md` §4 predicted it, and the
check says so in its own docstring rather than leaving this guide to claim
otherwise. The paragraph above is still the half a reader carries.

**One live reading is declared rather than flagged, because settling it is a
rule decision and not a sweep's.** `src/shared/domain.ts` floats
`percentOfIncome` and `percentOfPrevious` to bound them between 0 and 1000. A
float round-trip decides a refusal there, so under the strictest reading of the
sentence above — "compared, summed, or shown" — it is in scope. It is not
flagged, and percent names are deliberately outside the check's set, because
both this section and `client.md` §2.1 carve percentages out in the same words:
`Number` is allowed "where the result is a pixel or a percentage that is already
approximate". Including it would make the check red on arrival against code the
guide sanctions. The pathological case is real and tiny — `"1000.0000000000000001"`
floats to exactly 1000, passes Zod and dies on the database check constraint as
a 500, which is the failure the comment above that refinement says it exists to
prevent. Worth a decision here; not worth a check written against the guide's
own carve-out.

### 3.5 The Pulumi programs are a second TypeScript program

**House**, and mechanized. `deploy/pulumi` is 8,112 lines of first-party
TypeScript that this guide did not know existed. It is not a corner: 0.2.0 took
it from two stacks to five — `aws`, `gcp`, `oci`, `aws-single`, `oci-single` —
and
every rule added here from now on will be asked which of the two programs it is
about.

The divergences are forced rather than stylistic, which is the whole argument
for keeping them:

| | Application | Infrastructure |
| --- | --- | --- |
| Compiler | `typescript@^7.0.2` (`package.json:81`) | `typescript@5.9.3` (`deploy/pulumi/package.json:25`) |
| Module resolution | `Bundler` (`tsconfig.json:21`), `NodeNext` for the server build | `node` (`deploy/pulumi/tsconfig.json:5`) |
| Relative imports | end in `.js` (§3.1) | carry no extension (§3.1) |
| Declined here, on there | — | `noImplicitReturns` (§1.3) |
| On here, absent there | `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false` | — |
| Typecheck | `npm run typecheck`, two projects | `npm run typecheck` inside `deploy/pulumi`, five projects |
| In `npm run verify` | yes | no — a separate CI job (`.github/workflows/verify.yml:441-445`) |
| `oxlint` | yes | yes, same config |
| `oxfmt` | yes | **no**: `npm run format` is `oxfmt src tests *.ts` (`package.json:28`) |

The compiler version is the one that cannot be negotiated. TypeScript 7 removed
`moduleResolution: node`, and says so rather than degrading —
`error TS5108: Option 'moduleResolution=node10' has been removed` is what the
root compiler answers when pointed at `deploy/pulumi/aws/tsconfig.json`. So the
separation is the compiler's demand and not a preference.

**The sharp edge** is that the application's test suite imports those programs
to check what Pulumi's types cannot say — `tests/cloud-init.test.ts:9-10` and
five other suites — and an import drags the file into the application's own
program. Three files are in both:
`deploy/pulumi/single-common/cloud-init.ts`,
`deploy/pulumi/aws-single/platform.ts` and
`deploy/pulumi/oci-single/platform.ts`. They are typechecked twice, by two
compilers, under two module resolutions, with two extension conventions —
imported as `"../deploy/pulumi/aws-single/platform.js"` from a test and
importing `"../single-common/cloud-init"` themselves. Both resolve; neither
compiler can see the other's answer. 1.4 is where that stops being a curiosity:
the flag measurements in this guide silently include those three files, and two
of the `exactOptionalPropertyTypes` errors counted there are in them.

**The obvious alternative is folding `deploy/pulumi` into the root
configuration, and it is wrong.** Those programs resolve eight vendor SDKs —
`@pulumi/aws`, `eks`, `gcp`, `kubernetes`, `oci`, `pulumi`, `random`, `tls`
(`deploy/pulumi/package.json:14-21`) — that the application never ships, so one
program means the browser bundle's dependency graph contains three cloud
providers, and `npm ci` at the root pays for them on every run. And one program
would force the root onto a module resolution the newer compiler no longer
accepts, which is the error above. The cost of two programs is that a rule has
to say which one it is about; the cost of one is a build that cannot exist.

What follows for anyone writing here: a rule stated "in this repository" is a
claim about both, and most of this guide's rules are about one. Say which. The
refusals in 1.2 and the import conventions in 3.1 now hold in both, by different
mechanisms, and the rest of 1.1 holds in the application alone.

*Checked by:* `tests/typescript-guide.test.ts`. It holds the boundary rather
than the table: the root `tsconfig.json` does not include `deploy`; the
infrastructure projects pin their own compiler and keep `moduleResolution: node`;
`deploy/pulumi`'s typecheck script names every directory holding a
`Pulumi.yaml`, so a fifth stack that nothing typechecks fails here; and the
register of first-party files the root program reads from outside `src` and
`tests` is held at the ten 1.4 names. The flag rows, the project count, the
SDK count and the size are read out of the configuration files and the tree, so
a divergence that closes stops being described as open.

## 4. Functions

### 4.1 Arguments in the order the reader needs them

**House.** Actor first, the thing acted on second, then what the operation
needs, then optionals with defaults, and `transaction?: DbTransaction` last:

```ts
createTransaction(actor, draft, idempotencyKey, allowDuplicate?, transaction?)
updateTransaction(actor, id, input, transaction?)
setTransactionDeleted(actor, id, expectedVersion, deleted, allowDuplicate?, transaction?)
```

(`src/server/services/transactions.ts:1118`, `:2337` and `:2430`.)

Note that `updateTransaction` takes `input: unknown` and parses it, rather than
a typed object: the version and the draft arrive together inside it. An update
therefore does **not** have the same shape as a create, which is worth knowing
before writing the call from memory.

This is written down because guessing it wrong is the most common mistake made
against this codebase — including in an earlier draft of this very section,
which stated two of these three signatures incorrectly. Read the function.

*Checked by:* `human`. The compiler reads a call against the signature and has
nothing to say about the signature, which is the side this rule is about.

### 4.2 A function that can fail says how in its type

**House.** Two shapes, and the choice is about who decides what to do next:

- **Throw an `AppError`** when there is one right answer and the caller cannot
  improve on it. Everything in `src/server/services` does this.
- **Return a result** when the caller is going to render the failure rather than
  propagate it. `resolveEntrySide` returns `{ ok: false, message }`
  (`src/shared/domain.ts:162`) precisely so the
  browser can preview the refusal without provoking it.

That second shape exists because of a real defect: the form used to let somebody
build a split the server would reject with a 422 the screen had not predicted.
One function, two callers, one sentence. See `errors.md`.

*Checked by:* `human`. The compiler holds every caller to whichever of the two
shapes it finds; which one the function should have offered is the part nothing
reads.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.4 The three whole-program totals | 575, 110 and 966 move with every test anyone adds, and a check somebody has to bump to go green teaches them to bump it without reading it. The `src` half is checked. |
| 2.2 Assertions carry a reason | Not mechanizable. The count of them is not checked either, for the reason in the row above. |
| 2.4 `satisfies` earns the keyword | `tsc` checks what each one asserts; whether a value has one shape or two, which is where the keyword stops being the right tool, is a judgement. The three are named rather than counted, so there is no total to go stale. |
| 2.6 The comment beside a boundary cast | The test sees that a cast is confined to one property. Whether the sentence above it says what the vendor does is a reviewer's. |
| 4.1 Argument order | A signature is read, not called, and nothing reads one. |
| 4.2 Throw or return a result | Which of the two a caller needs is a judgement about the caller. |

Six rows, where there were five, and the direction is the opposite of the
count's. 1.3 left the table outright: its three sites are now read back out of
the compiler and compared with the citations in the section, which is what
caught the first of them pointing forty lines away at a docblock about
`/ads.txt`. 1.4 and 2.2 went from whole rules to the halves of them a machine
cannot have. 2.4 and 2.6 are new rows for new rules, and both say which half is
covered rather than claiming the rule is loose.

What the two previous rounds added is still here:
`tests/no-explicit-any.test.ts` holds the zero in 2.1, and
`tests/module-boundaries.test.ts` walks the import graph for 3.3.
`tests/typescript-guide.test.ts` is this round's, and holds 1.2's infrastructure
half, 1.3, the `src` half of 1.4, 2.2's register, 2.6, 3.1's two populations and
3.5.
