import { describe, expect, it } from "vitest";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * `services.md` 2.6: the reference counter and the merge agree table for table.
 *
 * Binding, and broken twice the same way, one door apart. The category merge
 * rewrote transactions, staged rows, recurrences and budgets, then hard-deleted
 * the sources out from under template drafts. The payee merge missed both
 * standing references, and a recurrence re-created the merged-away spelling on
 * its next occurrence — "the merge quietly undid itself on a schedule".
 *
 * The instance tests cover the tables somebody has already thought about. What
 * is left, and what the guide says is unchecked, is the next table nobody wires
 * up: "a new reference table needs both by hand". So this derives the
 * population from the schema rather than listing it, and every table that is
 * deliberately outside is named with the argument for it.
 */

const schema = sourceFiles("src/server/db").find((file) => file.path.endsWith("/schema.ts"))!;
const categoriesService = sourceFiles("src/server/services").find((file) =>
  file.path.endsWith("/categories.ts"),
)!;
const payeesService = sourceFiles("src/server/services").find((file) =>
  file.path.endsWith("/payees.ts"),
)!;

type Table = {
  /** The drizzle export, which is how a service names it. */
  readonly object: string;
  /** The PostgreSQL name, which is how raw SQL in a service names it. */
  readonly sql: string;
  readonly categoryId: boolean;
  readonly payee: boolean;
  readonly jsonb: readonly string[];
};

/**
 * Every table, with the three ways one can end up naming a category or a payee.
 *
 * A `category_id` column and a `payee` column are the obvious two. The third is
 * a `jsonb` column, because this product keeps three transaction-shaped
 * payloads that way — a staged draft, a template draft and a recurrence shape —
 * and each holds `categoryId` and `payee` as fields rather than as columns. A
 * merge that rewrites columns and not payloads is exactly the defect 2.6
 * records, so the payload tables have to be in the population and argued out
 * one at a time rather than filtered out by a pattern.
 */
function tables(file: SourceFile): Table[] {
  const declarations = [...file.code.matchAll(/export const (\w+) = pgTable\(\s*"([a-z_]+)"/g)];
  return declarations.map((declaration, index) => {
    const from = declaration.index;
    const to = declarations[index + 1]?.index ?? file.code.length;
    const body = file.code.slice(from, to);
    const columns = [
      ...body.matchAll(
        /(\w+):\s*(uuid|text|jsonb|numeric|timestamp|boolean|integer|date)\("([a-z_0-9]+)"/g,
      ),
    ];
    return {
      object: declaration[1]!,
      sql: declaration[2]!,
      categoryId: columns.some((column) => column[3] === "category_id"),
      payee: columns.some((column) => column[3] === "payee"),
      jsonb: columns.filter((column) => column[2] === "jsonb").map((column) => column[3]!),
    };
  });
}

/**
 * Tables in the population that name neither a category nor a payee, and why.
 *
 * Every one is here because it has a `jsonb` column rather than because of
 * anything it references. Keyed by the drizzle export, which is the name a
 * service would have to use to rewrite it.
 */
const NOT_A_REFERENCE: Readonly<Record<string, string>> = {
  auditEvents:
    "The one that must never be rewritten. `before` and `after` are what a row looked like at a moment that has passed, and a merge that updated them would be changing the record of what somebody did — the opposite of what 2.6 asks for everywhere else. Preserving audit history is an AGENTS.md invariant in its own right.",
  idempotencyRecords:
    "A stored response, replayed verbatim so a second submit of the same request returns what the first one did. Rewriting it would make a replay answer differently from the call it is a replay of, which is the whole property.",
  importBatches:
    "`mapping` is the column headings of somebody's bank file — which heading held the date, which held the amount. It names columns in a file, never a row in this ledger.",
  mcpSigningKeys: "Two JWKs. Cryptographic material, with no ledger reference in it.",
  billingOperations:
    "`result` is what Stripe answered. It belongs to the vendor's side of the conversation and carries nothing of this ledger's.",
};

/**
 * Reference tables a category merge must reach and a payee merge must not, and
 * why the asymmetry is correct rather than an oversight.
 */
const CATEGORY_WITHOUT_PAYEE: Readonly<Record<string, string>> = {
  transactionLegs:
    "A leg is the counter-account side of one entry cut up. It carries a category per leg and no payee at all: the payee is the entry's, named once on the parent, so a payee merge has nothing here to rewrite.",
  budgetPlans: "A budget is about a category or a group. Nothing in budgeting knows about a payee.",
  budgetEntries: "The same, one period at a time.",
};

/** The body of a named function, by brace depth from its opening brace. */
function body(file: SourceFile, name: string): string {
  const at = file.code.indexOf(`function ${name}(`);
  expect(at, `${file.path} declares ${name}`).toBeGreaterThan(-1);
  const start = file.code.indexOf("{", at);
  let depth = 0;
  let end = start;
  do {
    const character = file.code[end]!;
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    end += 1;
  } while (depth > 0 && end < file.code.length);
  const found = file.code.slice(start, end);
  expect(found.length, `${name} has a body`).toBeGreaterThan(200);
  return found;
}

/**
 * Which of these tables a function reaches, by either of its two names.
 *
 * The SQL name matters and is not decoration: `countCategoryUses` reaches the
 * legs through a raw `exists (select 1 from transaction_leg l ...)` rather than
 * through the drizzle export, because the question it asks of them is one the
 * query builder would answer with a second round trip. A check that looked only
 * for the export would call that correct code a missing table.
 */
function reached(source: string, population: readonly Table[]): Set<string> {
  return new Set(
    population
      .filter(
        (table) =>
          new RegExp(`\\b${table.object}\\b`).test(source) ||
          new RegExp(`\\b${table.sql}\\b`).test(source),
      )
      .map((table) => table.object),
  );
}

describe("the tables that name a category or a payee", () => {
  const all = tables(schema);
  // A parser that stopped parsing would report an empty population and a
  // perfectly clean surface.
  const population = all.filter((table) => table.categoryId || table.payee || table.jsonb.length);

  it("are derived from the schema, with every exception argued", () => {
    expect(all.length, "the schema parsed").toBeGreaterThan(20);
    expect(population.length, "the population is not empty").toBeGreaterThan(8);
    // Both directions. An entry for a table that no longer carries a payload is
    // a licence nobody is using, and it is the shape a stale register takes
    // just before it starts excusing something it was never written for.
    const unknown = Object.keys(NOT_A_REFERENCE).filter(
      (name) => !population.some((table) => table.object === name),
    );
    expect(unknown, "a register entry outlived its table").toEqual([]);
  });

  it("are every one reached by the counter and by the category merge", () => {
    const references = population.filter((table) => !(table.object in NOT_A_REFERENCE));
    const counter = reached(body(categoriesService, "countCategoryUses"), references);
    const merge = reached(body(categoriesService, "mergeCategories"), references);
    const expected = references.map((table) => table.object).sort();

    expect([...counter].sort(), "the guard counts every reference").toEqual(expected);
    expect([...merge].sort(), "the merge rewrites every reference").toEqual(expected);
    // The guide's own sentence, asserted as itself rather than inferred from
    // the two above: "the counter and the merge must agree about what a
    // reference is; when the counter learns a new table, the merge learns it in
    // the same change."
    expect([...counter].sort(), "table for table").toEqual([...merge].sort());
  });

  it("are every one reached by the payee merge, less the ones with no payee", () => {
    const references = population.filter(
      (table) => !(table.object in NOT_A_REFERENCE) && !(table.object in CATEGORY_WITHOUT_PAYEE),
    );
    expect(references.length, "something is left to check").toBeGreaterThan(2);
    expect(
      [...reached(body(payeesService, "mergePayees"), references)].sort(),
      "a spelling left behind is a merge that undoes itself",
    ).toEqual(references.map((table) => table.object).sort());
  });
});
