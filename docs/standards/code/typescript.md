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

### 1.3 `noImplicitReturns` is declined

**Contested.** The flag is good advice in general and wrong here. All three
sites it flags are Hono middleware
(`src/server/api.ts:950`, `src/server/http-security.ts:160` and `:551`),
where a `MiddlewareHandler` returns a `Response` to answer the request or
nothing at all to let the next handler run. "Returns on some paths and not
others" is the contract, not a mistake.

Adopting it would mean writing `return undefined` three times to mean "carry
on", which is noise that reads as an oversight. Declined, and this paragraph is
the record so nobody re-measures it.

### 1.4 `noUncheckedIndexedAccess` is declined, for now

**Contested.** 440 errors. It is the setting on this list most worth having,
because indexing into an array or a record is exactly where an `undefined`
arrives unannounced, and it is the single largest source of the non-null
assertions counted in 2.2.

It is declined because 440 sites cannot be reviewed carefully in one change, and
mechanically silencing them with `!` would convert a real check into a
formality — the same defect the flag exists to catch, now written down. If it is
ever adopted it should be one directory at a time.

`exactOptionalPropertyTypes` (71) and `noPropertyAccessFromIndexSignature` (666)
are declined outright.

## 2. Types

### 2.1 `any` does not appear

**Binding.** There is no `: any` in `src`. Zero occurrences, and the number to
hold is zero.

`unknown` is the type for a value that has not been checked yet, and the check
is a Zod parse rather than a cast. `AppError.details` is `unknown`
(`src/server/services/errors.ts:13`) because it
carries whatever the thrower had, and every reader narrows before use.

*Checked by:* `tests/no-explicit-any.test.ts`. `no-explicit-any` is a
`typescript` plugin rule outside `correctness`, so the linter does not run it;
the test greps for the type instead, in code with the comments blanked, so the
several comments that discuss `any` do not read as uses of it.

### 2.2 Assertions are rare and each has a reason

**House.** One `as unknown as` in the whole of `src`, and **136 non-null
assertions across 33 files**. Neither number is zero and neither should be: a
`!` after a lookup that a database constraint guarantees is honest, and the
alternative is a branch that cannot be reached and cannot be tested.

The single `as unknown as` is at `accounts.ts:512`, building the row an
archived account would have had so the caller sees the shape it expects; the
alternative was making every field optional for one call site. It was three when
this was written and two of the three went while the code was being brought to
this guide, which is the number moving the right way.

136 is higher than it looks like it should be, and 1.4 explains most of it —
without `noUncheckedIndexedAccess`, indexing an array gives a non-optional type,
so the assertions that exist are the ones somebody added anyway. Adopting that
flag would raise this number a great deal before lowering it.

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
generated from it (src/server/db/schema.ts:194),
and the UI iterates it (`src/client/pages/CategoriesPage.tsx:111`).
Adding a member is one edit, and every one of those follows.

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

(`src/shared/domain.ts:1275`.)

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

### 3.3 `src/shared` may not import from `src/server` or `src/client`

**Binding by convention, checked by nothing yet.** `src/shared` is the code both
sides run: the domain schemas, the CSV grammar, the name normalisation, the
recurrence arithmetic. It is imported by a browser bundle, so a stray `node:`
import there ends up in the client or fails the build.

The direction is `shared ← server` and `shared ← client`, never the reverse and
never `server ↔ client`.

*Checked by:* `tests/module-boundaries.test.ts`, which walks the import graph
rather than grepping for a path, so an import that reaches `src/server` through
a re-export is caught too.

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

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 2.2 Assertions carry a reason | Not mechanisable. |

One `human` rule in this guide, down from three. Both that went are now
tests: `tests/no-explicit-any.test.ts` holds the zero in 2.1, and
`tests/module-boundaries.test.ts` walks the import graph for 3.3.
