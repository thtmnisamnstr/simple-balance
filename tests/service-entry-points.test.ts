import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A service function takes an actor first, and the ones that cannot say why.
 *
 * `services.md` 1.1 is where this rule lives, and `AGENTS.md` is the authority:
 * "Never accept a public `userId`. Derive it from the authenticated `Actor`, and
 * scope every finance read/write by that ID." The second half is the half that
 * does the work — a rule about a parameter would be satisfied by a function that
 * takes an actor and then queries without it.
 *
 * A handful of entry points have no actor to take, because no request made them
 * run. The guide named two of them in prose and there are five, which is how a
 * list in a paragraph goes: it was right when it was written and nothing asked
 * it again. `pruneIdempotencyRecords` is the fifth and arrived after the
 * sentence. So the list is here, one line of reason each, and the value is the
 * sixth. Billing's webhook path then added seven more, which is why the count
 * is not written down anywhere below: the list is the count.
 */
const SERVICES = globSync("src/server/services/*.ts").sort();

/**
 * Entry points with no actor, and why each one has none.
 *
 * Every one of these is either a scheduled sweep — nobody's request started it,
 * so there is nobody to derive an actor from — or the account-deletion
 * exception `services.md` 1.1 already names.
 */
const NO_ACTOR_TO_TAKE = new Map([
  [
    "reconcileArchivedAccountClosings",
    "A repair of somebody's postings, run at startup rather than by a request",
  ],
  ["pruneAbandonedClients", "A scheduled sweep of OAuth clients nobody completed"],
  ["pruneIdempotencyRecords", "The retention sweep, on the scheduler's tick"],
  ["runDueNotifications", "The reminder sweep, on the scheduler's tick"],
  ["runDueRecurrences", "The proposal sweep, on the scheduler's tick"],
  [
    "applyStripeDelivery",
    "Stripe's delivery names a customer, not a person, so there is no request naming an actor — the exception services.md 1.1 names",
  ],
  [
    "userForStripeCustomer",
    "A lookup from a Stripe customer id to the person it belongs to, which is how the webhook finds an actor in the first place",
  ],
  [
    "reconcileSubscription",
    "Stripe's delivery names a customer, not a person, so there is no request naming an actor — the exception services.md 1.1 names",
  ],
  [
    "claimWebhookEvent",
    "The deployment's record of which deliveries Stripe has been answered for, which belongs to nobody",
  ],
  ["applyCustomerDeletion", "The same delivery, claimed and applied in one transaction"],
  [
    "applySetupIntentSucceeded",
    "Stripe's delivery names a customer; the person was resolved from it by userForStripeCustomer before this was called",
  ],
  [
    "runBillingReconciliation",
    "The subscription re-read sweep, on the scheduler's tick — its subject is every stale row in the deployment, so there is no one person it is about",
  ],
  [
    "revokeAllConnectedApps",
    "Takes a userId, and is reached from a session or a password reset rather than from a request naming one — the exception services.md 1.1 names",
  ],
]);

/**
 * One function's body, brace-balanced from the `{` that opens it.
 *
 * `at` is the index of the function's `export` keyword, and everything ahead of
 * the body is stepped over rather than searched, because the first `{` after a
 * signature is very often not the body at all. This searched from the end of
 * the *first parameter* for a release, and so read an inline object type as a
 * body: `applySetupIntentSucceeded(userId: string, event: { readonly id: ... })`
 * handed back the type literal, which contains no `getDb()`, so the function
 * dropped out of the sweep entirely. Four did, and three of the excuses above
 * were therefore decorative — deletable with this suite still green. The shape
 * is not rare: every Stripe handler has it, because a Stripe event *is*
 * `{ id, type, data }`.
 *
 * Two passes ahead of the brace match, and both are load-bearing:
 *
 *  - Balance `(`…`)` from the parameter list's own `(`, so nothing a parameter
 *    opens — a brace, a default value, a nested call — is mistaken for the body.
 *  - Then walk to the first `{` at angle depth zero, because the return type
 *    may open one first. `pruneIdempotencyRecords` ends
 *    `): Promise<{ swept: number; capped: boolean }> {`, on which "the first `{`
 *    after the closing `)`" hands back the result type and loses the function.
 *    A `>` preceded by `=` closes nothing — that is `=>` or `>=`, not a generic.
 */
function bodyOfFunctionAt(source: string, at: number) {
  const open = source.indexOf("(", at);
  if (open === -1) return "";
  let index = open;
  let parens = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") parens += 1;
    else if (source[index] === ")") {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let angle = 0;
  for (index += 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "<") angle += 1;
    else if (char === ">" && source[index - 1] !== "=") angle -= 1;
    else if (char === "{" && angle <= 0) break;
  }
  if (index >= source.length) return "";
  let depth = 0;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) break;
  }
  return source.slice(start, index + 1);
}

/**
 * The sweep itself, run once and read by two tests.
 *
 * `reached` is the half that was missing: the names the sweep actually decided
 * are actor-less *and* reach the database. Without it the suite can only say
 * "nothing unexplained", which a sweep that has gone blind says just as loudly
 * as a sweep that is working.
 */
function sweepServices() {
  const unexplained: string[] = [];
  const reached = new Set<string>();
  let checked = 0;
  for (const file of SERVICES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/export (?:async )?function (\w+)\s*\(\s*([^),]*)/gs)) {
      const first = match[2].replace(/\s+/g, " ").trim();
      if (/^actor\s*:/.test(first)) {
        checked += 1;
        continue;
      }
      // The second sanctioned shape: a helper whose first parameter is spelled
      // to admit the pool as well as a transaction. `services.md` 1.1 calls
      // these "the second row under another name".
      if (/^(?:tx|db|executor)\s*:/.test(first) || /Database|DbTransaction/.test(first)) continue;
      const body = bodyOfFunctionAt(source, match.index).replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      );
      // Its own reach for the database rather than a mention anywhere inside:
      // `balanceStatement` builds a `sql` fragment and takes a `userId`, and a
      // query builder is not an entry point. Both `getDb()` and
      // `withTransaction`, because the second is how a function that may be
      // handed a transaction opens its own.
      if (!/\bgetDb\(\)|\bwithTransaction\(/.test(body)) continue;
      checked += 1;
      reached.add(match[1]!);
      if (!NO_ACTOR_TO_TAKE.has(match[1]!)) {
        unexplained.push(`${file}: ${match[1]}(${first.slice(0, 40)})`);
      }
    }
  }
  return { unexplained, reached, checked };
}

const sweep = sweepServices();

describe("a service function", () => {
  it("takes an actor first, or is on the list of the ones with none to take", () => {
    // The great majority take an actor, so this is not passing by examining
    // nothing.
    expect(sweep.checked).toBeGreaterThan(60);
    expect(
      sweep.unexplained,
      "take an actor first, or say in NO_ACTOR_TO_TAKE why there is none",
    ).toEqual([]);
  });

  it("keeps that list to the functions that still exist", () => {
    // A name left behind after the sweep it excused was renamed is the list
    // drifting the way the paragraph it replaced did.
    const everything = SERVICES.map((file) => readFileSync(file, "utf8")).join("\n");
    const stale = [...NO_ACTOR_TO_TAKE.keys()].filter(
      (name) => !new RegExp(`export (?:async )?function ${name}\\b`).test(everything),
    );
    expect(stale, "these are excused and gone").toEqual([]);
  });

  /**
   * The other direction, and the one that makes the sweep unfoolable.
   *
   * "Nothing unexplained" is equally true of a sweep that has stopped seeing
   * anything, which is the state this file shipped in: the body reader mistook
   * a parameter's object type for a function body, `applyStripeDelivery`,
   * `applyCustomerDeletion` and `pruneIdempotencyRecords` fell out of the
   * classification, and their three excuses sat here meaning nothing while a
   * fourth entry point — `applySetupIntentSucceeded`, which takes a bare
   * `userId` and reaches `getDb()` — was excused by nobody and reported by
   * nothing.
   *
   * So every excuse has to be spent. An excuse the sweep never needed is either
   * a function that stopped reaching the database, or a sweep that has gone
   * blind, and both want a person to look.
   */
  it("has seen every function it excuses", () => {
    const decorative = [...NO_ACTOR_TO_TAKE.keys()].filter((name) => !sweep.reached.has(name));
    expect(
      decorative,
      "excused, but the sweep never classified them — the excuse is decorative and could be deleted with this suite still green",
    ).toEqual([]);
  });

  /**
   * The body reader, against the two signatures that fooled it.
   *
   * Held on a fixture rather than on `billing.ts`, so it keeps meaning
   * something after the file it was written about is rewritten — and so the
   * failure names the parser rather than a function that happens to be shaped
   * like the bug.
   */
  it("reads the body past a parameter list and a return type that open braces", () => {
    const inlineParameterType = [
      "export async function example(",
      "  userId: string,",
      "  event: { readonly id: string; readonly data: { readonly object: unknown } },",
      "): Promise<void> {",
      "  await getDb().select();",
      "}",
    ].join("\n");
    const body = bodyOfFunctionAt(inlineParameterType, 0);
    // Written in terms of what a body has and a type literal cannot: a call.
    // Asserting on the braces instead would be satisfied by the wrong one.
    expect(body).toContain("getDb()");
    // And not by handing back the whole file, which would contain both.
    expect(body).not.toContain("readonly id: string");

    // `pruneIdempotencyRecords`' real shape. "The first `{` after the closing
    // `)`" — the obvious fix, and the wrong one — stops on the result type.
    const bracedReturnType = [
      "export async function sweep(",
      "  before: Date,",
      "): Promise<{ swept: number; capped: boolean }> {",
      "  return withTransaction(async () => ({ swept: 0, capped: false }));",
      "}",
    ].join("\n");
    const swept = bodyOfFunctionAt(bracedReturnType, 0);
    expect(swept).toContain("withTransaction(");
    expect(swept).not.toContain("capped: boolean");
  });

  it("is the list the guide names", () => {
    // `services.md` 1.1 names them in prose as well, because a reader meets the
    // paragraph before the test. The two came apart once already.
    const guide = readFileSync("docs/standards/code/services.md", "utf8");
    // The table, not the page. The paragraph above it names one of these by way
    // of explaining how the list fell behind, so a page-wide search is
    // satisfied by the story rather than by the list — which is the same class
    // of mistake this check exists to catch.
    const rows = [...guide.matchAll(/^\| `(\w+)` \| [^|]+\|$/gm)].map((row) => row[1]!);
    const missing = [...NO_ACTOR_TO_TAKE.keys()].filter((name) => !rows.includes(name));
    expect(
      missing,
      "name these in services.md 1.1's table too, one row each, and correct the count in the prose above it",
    ).toEqual([]);
  });
});
