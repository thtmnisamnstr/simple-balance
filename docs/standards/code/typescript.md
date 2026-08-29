# TypeScript

The language, and what the compiler has been told to refuse.

## 1. Strictness

### 1.1 What is on

**Binding.** `strict` has been on since the beginning. Six more settings were
measured against this repository and cost nothing, so they are on too:

| Setting | Refuses |
| --- | --- |
| `noUnusedLocals`, `noUnusedParameters` | Dead bindings. |
| `noImplicitOverride` | A method that overrides without saying so. |
| `noFallthroughCasesInSwitch` | A `case` that runs into the next one. |
| `allowUnreachableCode: false` | Code after a `return`. |
| `allowUnusedLabels: false` | A label nothing jumps to. |
| `verbatimModuleSyntax` | A type imported as though it were a value. |
| `erasableSyntaxOnly` | Syntax that survives type stripping. |

*Checked by:* `npm run typecheck`.

### 1.2 `erasableSyntaxOnly`, and the two classes it changed

**Binding.** Every construct in this repository erases. Nothing here compiles to
runtime behaviour that is not visible in the source: no `enum`, no `namespace`,
no constructor parameter properties.

The last of those cost five lines. `AppError` and `ApiClientError` both declared
their fields in the constructor signature, which is TypeScript-only syntax that
emits assignments. They now declare fields and assign them
(src/server/services/errors.ts:4-25,
src/client/api.ts:18-25).

The gain is not stylistic. It means `node --experimental-strip-types` and every
other type-stripping runtime can run this source directly, and it means reading
a constructor tells you what it assigns.

*Checked by:* `npm run typecheck`. TS1294 fires on the syntax itself, so a
constructor parameter property fails the build as readily as an `enum` does,
rather than being caught in review. It says nothing about the gain: a class that
declares its fields and assigns them somewhere unreadable erases just as well.

### 1.3 `noImplicitReturns` is declined

**Contested.** The flag is good advice in general and wrong here. All three
sites it flags are Hono middleware
(src/server/api.ts:967`, `src/server/http-security.ts:160` and `:551`),
where a `MiddlewareHandler` returns a `Response` to answer the request or
nothing at all to let the next handler run. "Returns on some paths and not
others" is the contract, not a mistake.

Adopting it would mean writing `return undefined` three times to mean "carry
on", which is noise that reads as an oversight. Declined, and this paragraph is
the record so nobody re-measures it.

*Checked by:* `human`.

### 1.4 `noUncheckedIndexedAccess` is declined, for now

**Contested.** 441 errors, 59 of them in `src` and the rest in `tests`. It is
the setting on this list most worth having, because indexing into an array or a
record is exactly where an `undefined` arrives unannounced.

It is not, as this section used to claim, where the non-null assertions counted
in 2.2 came from. Twenty of those 146 sit on an index or a lookup, and most of
the twenty are `.at(-1)`, a `Map.get` or a regular expression group, all of
which hand back `undefined` with the flag off. So it is the flag that would add
to that count rather than the flag that explains it, which is what 2.2 says from
the other end.

It is declined because 441 sites cannot be reviewed carefully in one change, and
mechanically silencing them with `!` would convert a real check into a
formality — the same defect the flag exists to catch, now written down. If it is
ever adopted it should be one directory at a time, and the split above says
which one first: `src` is 59 of the 441 and all of the benefit, since a test
that indexes a fixture it wrote three lines earlier learns nothing from being
told the row might be missing.

`exactOptionalPropertyTypes` (73) and `noPropertyAccessFromIndexSignature` (687)
are declined outright.

All three numbers are a measurement and not a check. Each is the error count
from `npx tsc -p tsconfig.json --noEmit --<flag>`, taken by hand against the
whole of `tsconfig.json`, which is `src` and `tests` together because that is
what `npm run typecheck` reads. Nothing re-runs them, so read one as the last
reading rather than as today's, and take it again before arguing from it.

*Checked by:* `human`.

## 2. Types

### 2.1 `any` does not appear

**Binding.** There is no `: any` in `src`. Zero occurrences, and the number to
hold is zero.

`unknown` is the type for a value that has not been checked yet, and the check
is a Zod parse rather than a cast. `AppError.details` is `unknown`
(`src/server/services/errors.ts:13`) because it
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

**House.** One `as unknown as` in the whole of `src`, and **146 non-null
assertions across 33 files**, counted with
`npx oxlint -D typescript/no-non-null-assertion src` for the reason 2.1 gives:
a `!` is punctuation, and a grep meets it in `!==` and in every negation this
codebase writes. Neither number is zero and neither should be: a `!` after a
lookup that a database constraint guarantees is honest, and the alternative is a
branch that cannot be reached and cannot be tested.

The single `as unknown as` is at accounts.ts:513`, building the row an
archived account would have had so the caller sees the shape it expects; the
alternative was making every field optional for one call site. It was three when
this was written and two of the three went while the code was being brought to
this guide, which is the number moving the right way.

146 is higher than it looks like it should be, and 1.4 is why it is not higher
still: without `noUncheckedIndexedAccess`, indexing an array gives a
non-optional type, so all but twenty of these were written for some reason other
than an index. Adopting that flag would raise this number a great deal before
lowering it.

The rule is about which of the two you are doing. A `!` standing in for
"I checked this three lines up" is fine. A `!` standing in for "it is probably
fine" is a bug that has not happened yet, and the honest form of it is a
`throw`.

*Checked by:* `human`.

### 2.3 A union of literals, not an enum

**Binding**, by way of 1.2. Every closed set is a `readonly` tuple plus a type
derived from it:

```ts
export const categoryKinds = ["income", "expense", "both"] as const;
export type CategoryKind = (typeof categoryKinds)[number];
```

(src/shared/domain.ts:97-98.)

The array is the single source: Zod validates from it, the database enum is
generated from it (src/server/db/schema.ts:196),
and the UI iterates it (src/client/pages/CategoriesPage.tsx:126`).
Adding a member is one edit, and every one of those follows.

*Checked by:* `npm run typecheck`, for the half of it that is a refusal:
`erasableSyntaxOnly` rejects an `enum` outright, and because the type is derived
from the array rather than written beside it, a member added in one place cannot
disagree with a reader that already exists. Nothing asks for the array in the
first place, so a closed set hand-written as a bare union of string literals
passes every check this repository has.

### 2.4 `satisfies` where a value must stay inside a type without losing its own

**House.** Two uses, and both earn the keyword. The clearer one:

```ts
export const budgetPeriodUnits = [
  "week",
  "month",
  "quarter",
  "year",
] as const satisfies readonly ReportBucket[];
```

(src/shared/domain.ts:1289`.)

`as const` keeps the four literals; `satisfies` checks that every one of them is
a bucket the report engine can group by. Annotating the constant
`readonly ReportBucket[]` instead would have done the check and thrown the
literals away, and the budget code needs them. The other use is the security
header options (src/server/http-security.ts:58),
which checks a literal against a library's parameter type without freezing it
into that type.

*Checked by:* `tsc`.

### 2.5 Discriminated unions carry the discriminant in the name

**House.** A transaction draft is a union on `type`, and each member declares it
as a literal (`src/shared/domain.ts:452`). Every
function that takes one either handles all three or narrows first. This is why
`noFallthroughCasesInSwitch` was free: there was nothing to find.

*Checked by:* `tsc`, which refuses a member's own field before the union has
been narrowed, and `tests/domain.test.ts` by way of importing the module at all:
Zod builds these unions at load and throws "Invalid discriminated union option
at index" on an option carrying no literal discriminant, so a member that lost
its `type` fails at import rather than at a parse. Neither can ask for a
discriminant on a union that never had one.

## 3. Modules

### 3.1 Every relative import ends in `.js`

**Binding.** Source says `.ts`; imports say `.js`, because that is what Node
resolves at runtime under `"module": "NodeNext"` in `tsconfig.server.json`.

This looks wrong the first time and is not. `import { decimal } from "./helpers.js"`
in a `.ts` file is correct, and dropping the extension breaks the server build
and nothing else, which is the worst kind of break: the client bundler forgives
it, so it passes locally.

*Checked by:* `tsc`, via `npm run build:server`.

### 3.2 A type import says `type`

**Binding**, by `verbatimModuleSyntax`. `import type { Actor } from ...`, or
`import { type CategoryKind, categoryKinds } from ...` when a module gives you
both. The flag was free, which means the codebase already did this everywhere.

*Checked by:* `npm run typecheck`. TS1484 names the binding that needs the
keyword, which is why both spellings above are fine and only the missing keyword
fails; nothing here prefers one of the two.

### 3.3 `src/shared` may not import from `src/server` or `src/client`

**Binding.** `src/shared` is the code both sides run: the domain schemas, the
CSV grammar, the name normalisation, the recurrence arithmetic. It is imported
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
(src/server/services/helpers.ts:21).
The client uses scaled `bigint` (src/client/money.ts:160,
src/client/money.ts:175),
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
refuses a `Number(amount)` written somewhere else, so the paragraph above is the
half a reader carries.

## 4. Functions

### 4.1 Arguments in the order the reader needs them

**House.** Actor first, the thing acted on second, then what the operation
needs, then optionals with defaults, and `transaction?: DbTransaction` last:

```ts
createTransaction(actor, draft, idempotencyKey, allowDuplicate?, transaction?)
updateTransaction(actor, id, input, transaction?)
setTransactionDeleted(actor, id, expectedVersion, deleted, allowDuplicate?, transaction?)
```

(`src/server/services/transactions.ts:1035`, `:2267` and `:2356`.)

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
  (src/shared/domain.ts:127) precisely so the
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
| 1.3 `noImplicitReturns` is declined | Nothing re-measures it, so a fourth site would arrive unargued. |
| 1.4 `noUncheckedIndexedAccess` is declined | A count taken once is a measurement, not a check, and 441 goes stale quietly. |
| 2.2 Assertions carry a reason | Not mechanisable. |
| 4.1 Argument order | A signature is read, not called, and nothing reads one. |
| 4.2 Throw or return a result | Which of the two a caller needs is a judgement about the caller. |

Five `human` rules in this guide, and the number went up rather than down. Four
of the five had carried no `*Checked by:*` line at all, which is `human` whether
or not the word appears; counting them is the whole of the change. The two that
really went are tests: `tests/no-explicit-any.test.ts` holds the zero in 2.1,
and `tests/module-boundaries.test.ts` walks the import graph for 3.3.
