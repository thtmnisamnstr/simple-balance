import { describe, expect, it } from "vitest";
import { type SourceFile, sourceFiles, topLevelDeclarations } from "./support/source.js";

/**
 * The three rules `docs/standards/code/services.md` gained in 0.2.0.
 *
 * 2.8 an entitlement is read inside the transaction that enforces it, 2.9 a
 * write that leaves `version` alone is named with its reason, and 2.10 a side
 * effect waits for the commit. Each is argued in the guide and in the source
 * beside the code it is about; nothing is restated here, because a copied rule
 * drifts and the drift is invisible — which is the defect this whole guide set
 * exists against.
 *
 * All three read the source rather than running anything. They are properties
 * of the text: a call that must not appear inside a body, a statement that must
 * name a column, a counter that must sit inside a callback. The behavior each
 * one protects is held by integration suites the guide names underneath it.
 */
const SERVICES = sourceFiles("src/server/services");

type Declaration = {
  readonly name: string;
  readonly where: string;
  readonly parameters: string;
  /** The declaration's text with every comment blanked. */
  readonly body: string;
};

/** The text between a declaration's first bracket and its match. */
function parameterList(body: string): string {
  const open = body.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(open + 1, index);
    }
  }
  return "";
}

const read = (files: readonly SourceFile[]): Declaration[] =>
  files.flatMap((file) =>
    topLevelDeclarations(file).map((declaration) => ({
      name: declaration.name,
      where: `${file.path}:${declaration.line} ${declaration.name}`,
      parameters: parameterList(declaration.body),
      body: declaration.body,
    })),
  );

const declarations = read(SERVICES);

/** A fixture file, so a case can state a shape this directory does not have. */
const fixture = (lines: string[]): Declaration[] => {
  const text = lines.join("\n");
  return read([{ path: "sample.ts", text, code: text }]);
};

/**
 * The span of every call to `name(` in a body, as `[start, end]` index pairs.
 *
 * Parenthesis-balanced from the opening bracket, so a call nested in the
 * arguments does not end the span early. A deferred count and an immediate one
 * are the same statement, and the only difference is what encloses it, so the
 * span is the whole of what separates them.
 */
function callSpans(body: string, name: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const match of body.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < body.length; index += 1) {
      const character = body[index]!;
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          spans.push([open, index]);
          break;
        }
      }
    }
  }
  return spans;
}

describe("services.md 2.8, an entitlement is read on the transaction that enforces it", () => {
  /**
   * The split that makes 2.1's second half obeyable.
   *
   * `accountFreeze(tx, actor)` and `readAccountFreeze(actor)` answer the same
   * question on a transaction and on the pool, and they are two functions
   * rather than one with an optional parameter precisely so that the
   * transaction-taking one cannot fall back. A pool connection commits
   * independently of the caller that is about to fail, which is the bug the
   * shape exists to prevent — and here it would be worse than usual, because
   * what falls back is the guard rather than the write.
   */
  it("keeps the transaction-taking reader off the pool", () => {
    const onTransaction = declarations.find((it) => it.name === "accountFreeze");
    expect(onTransaction, "accountFreeze has been renamed; this rule follows it").toBeDefined();
    expect(onTransaction!.parameters).toMatch(/^\s*tx\s*:\s*DbTransaction\b/);
    expect(
      /\bgetDb\s*\(\s*\)/.test(onTransaction!.body),
      "accountFreeze reached the pool; the whole point of readAccountFreeze is that it does not",
    ).toBe(false);
  });

  /**
   * And nothing holding a transaction reaches for the pool-side one either,
   * which is the same failure one call deeper. On `DATABASE_POOL_SIZE=1` it
   * does not even fail: it waits for the connection the caller is holding, and
   * that wait never ends.
   */
  it("never reads the freeze off the pool from inside a transaction", () => {
    const holdingOne = declarations.filter(
      (it) => /\btx\s*:\s*DbTransaction\b/.test(it.parameters) && it.name !== "readAccountFreeze",
    );
    const reaching = holdingOne
      .filter((it) => /\breadAccountFreeze\s*\(/.test(it.body))
      .map((it) => it.where);
    expect(
      reaching,
      "these hold a transaction and read the entitlement off the pool; call accountFreeze(tx, actor)",
    ).toEqual([]);
    // Not passing by examining nothing: the directory is full of this shape.
    expect(holdingOne.length).toBeGreaterThan(50);
  });

  /**
   * The refusal is a `validationError`, and two layers away that is the whole
   * behavior: `validateDraft` catches a validation error and files it as an
   * issue on the staged row, so one frozen account makes an import row
   * repairable instead of ending the batch it arrived in. A `conflict` would
   * end the batch, silently and correctly by its own lights.
   */
  it("refuses with a validation error rather than a conflict", () => {
    const assertion = declarations.find((it) => it.name === "assertAccountsWritable");
    expect(assertion, "assertAccountsWritable has been renamed").toBeDefined();
    expect(/\bvalidationError\s*\(/.test(assertion!.body)).toBe(true);
    expect(
      /\bconflict\s*\(/.test(assertion!.body),
      "a conflict here ends the import batch a validation error would only flag",
    ).toBe(false);
  });

  /**
   * And the entitlement is nowhere in the schema.
   *
   * `AGENTS.md` argues why at length: entitlements change with nobody present,
   * so a column written on the way down goes on saying what it said then. The
   * obvious implementation is `ledger_account.frozen`, which is why that exact
   * spelling is what this looks for — `active` is the person's own choice and
   * stays.
   */
  it("stores no column that would answer the question a plan answers", () => {
    const schema = sourceFiles("src/server/db").find((file) => file.path.endsWith("schema.ts"));
    expect(schema, "src/server/db/schema.ts has moved").toBeDefined();
    const stored = [...schema!.code.matchAll(/\b\w+\("(\w+)"\)/g)]
      .map((match) => match[1]!)
      .filter((column) => /^(is_)?(frozen|entitled|entitlement)$/.test(column));
    expect(
      stored,
      "the freeze is worked out from the entitlement and `active`, never stored — AGENTS.md says why",
    ).toEqual([]);
  });
});

/**
 * Every write to a versioned table that does not bump `version`, and its reason.
 *
 * Named rather than derived, for the reason `NO_ACTOR_TO_TAKE` in
 * `tests/service-entry-points.test.ts` is: a derived list says only that the
 * directory is self-consistent. The claim worth holding is that each of these
 * was *decided*, and the decision is argued in a comment beside the statement.
 *
 * The key is the declaration and the table, because two statements in one
 * declaration against one table are one decision — `setActiveAccounts` writes
 * `active: true` and `active: false` separately so neither set touches a row it
 * is not changing.
 */
const VERSION_LEFT_ALONE = new Map([
  [
    "accounts.ts markFittingAccountsActive ledgerAccounts",
    "`active` is not reachable through accountUpdateSchema, so a bump is a refusal nobody earned",
  ],
  [
    "accounts.ts setActiveAccounts ledgerAccounts",
    "The same column and the same argument, which its docstring states and markFittingAccountsActive cites",
  ],
  [
    "categories.ts mergeCategories recurrences",
    "A merge relabels what a recurrence points at without changing what somebody configured",
  ],
  [
    "categories.ts mergeCategories transactionTemplates",
    "The same standing reference one door along, for the recurrence's reason",
  ],
  [
    "category-groups.ts deleteCategoryGroup categories",
    "The foreign key never bumped it, and bumping it would make a Citus cluster refuse an edit a single node accepts — AGENTS.md",
  ],
  [
    "payees.ts mergePayees recurrences",
    "The category merge's reason, cited there: a merge relabels what the row points at",
  ],
  ["payees.ts mergePayees transactionTemplates", "The same, for the template's standing reference"],
  [
    "recurrences.ts proposeDueOccurrences recurrences",
    "A tick advancing a watermark is not a change to what they configured",
  ],
]);

/** The tables that carry a `version` column, read off the schema. */
function versionedTables(): Set<string> {
  const schema = sourceFiles("src/server/db").find((file) => file.path.endsWith("schema.ts"))!;
  const found = new Set<string>();
  for (const match of schema.code.matchAll(/^export const (\w+) = pgTable\(/gm)) {
    const next = schema.code.slice(match.index + 1).search(/^export const /m);
    const body = schema.code.slice(
      match.index,
      next === -1 ? schema.code.length : match.index + 1 + next,
    );
    if (/\bversion: integer\("version"\)/.test(body)) found.add(match[1]!);
  }
  return found;
}

/**
 * Every `.update(table).set({…})` in a body, with the table and whether the set
 * names `version`.
 *
 * The set object is balanced rather than matched, because these are long and
 * several hold a `sql` template with braces of its own.
 */
function updateSets(body: string): { table: string; bumps: boolean }[] {
  const found: { table: string; bumps: boolean }[] = [];
  for (const match of body.matchAll(/\.update\(\s*(\w+)\s*\)\s*\n?\s*\.set\(/g)) {
    const from = match.index + match[0].length;
    let depth = 0;
    let end = from;
    for (let index = from; index < body.length; index += 1) {
      const character = body[index]!;
      if (character === "(" || character === "{") depth += 1;
      else if (character === ")" || character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    found.push({ table: match[1]!, bumps: /\bversion\s*:/.test(body.slice(from, end + 1)) });
  }
  return found;
}

describe("services.md 2.9, every write that leaves `version` alone is named with its reason", () => {
  const versioned = versionedTables();
  const silent = new Set<string>();
  for (const file of SERVICES) {
    const basename = file.path.split("/").at(-1)!;
    for (const declaration of topLevelDeclarations(file)) {
      for (const { table, bumps } of updateSets(declaration.body)) {
        if (!versioned.has(table) || bumps) continue;
        silent.add(`${basename} ${declaration.name} ${table}`);
      }
    }
  }

  it("finds the versioned tables it is about", () => {
    // If the schema reader stops seeing them, the sweep below finds nothing and
    // passes while meaning nothing — the failure that made the entry-point
    // sweep's excuses decorative for a release.
    expect(versioned.has("ledgerAccounts")).toBe(true);
    expect(versioned.size).toBeGreaterThanOrEqual(9);
    expect(silent.size).toBeGreaterThanOrEqual(VERSION_LEFT_ALONE.size);
  });

  it("names every one of them", () => {
    const unexplained = [...silent].filter((key) => !VERSION_LEFT_ALONE.has(key));
    expect(
      unexplained,
      "bump `version`, or add the write to VERSION_LEFT_ALONE with the reason it does not — services.md 2.9",
    ).toEqual([]);
  });

  it("keeps the list to the writes that still exist", () => {
    // The other direction. An excuse the sweep never needed is either a write
    // that started bumping or a sweep that has gone blind, and both want
    // somebody to look.
    const decorative = [...VERSION_LEFT_ALONE.keys()].filter((key) => !silent.has(key));
    expect(
      decorative,
      "named here but not found; the write bumps `version` now, or moved, or the sweep stopped seeing it",
    ).toEqual([]);
  });

  it("reads a set that holds a sql template with braces in it", () => {
    // The shape of the merges' rewrites, which is what the balanced scan is
    // for: a naive scan to the first `}` reads this set as empty and reports a
    // bump that is not there.
    const [declaration] = fixture([
      "export async function rewrite(tx: DbTransaction) {",
      "  await tx",
      "    .update(recurrences)",
      "    .set({",
      "      shape: sql`jsonb_set(${recurrences.shape}, '{payee}', to_jsonb('x'::text), true)`,",
      "      updatedAt: new Date(),",
      "    })",
      "    .where(eq(recurrences.id, id));",
      "}",
    ]);
    expect(updateSets(declaration!.body)).toEqual([{ table: "recurrences", bumps: false }]);
  });
});

describe("services.md 2.10, a side effect waits for the commit", () => {
  /**
   * `ledger_writes_total` names the books rather than the traffic, so a count
   * standing for a write that rolled back is a lie about the books. Every MCP
   * write hands the service a transaction the transport opened, so "after the
   * service returns" is several statements before the commit.
   */
  it("counts every ledger write through countAfterCommit", () => {
    const immediate: string[] = [];
    let counted = 0;
    for (const file of SERVICES) {
      for (const declaration of topLevelDeclarations(file)) {
        const spans = callSpans(declaration.body, "countAfterCommit");
        for (const match of declaration.body.matchAll(/\bledgerWrites\s*\.\s*inc\s*\(/g)) {
          counted += 1;
          const inside = spans.some(([from, to]) => match.index > from && match.index < to);
          if (!inside) immediate.push(`${file.path}:${declaration.line} ${declaration.name}`);
        }
      }
    }
    expect(
      immediate,
      "count through countAfterCommit, so an MCP write that rolls back after the service returns counts nothing",
    ).toEqual([]);
    // The counter exists and is being found, so this is not passing on zero.
    expect(counted).toBeGreaterThanOrEqual(6);
  });

  /**
   * And the queue is keyed on the transaction.
   *
   * The obvious shape is a module-level array that the opener drains, and it is
   * the worse bug in place of the one being fixed: two concurrent requests
   * share it, and one flushes the other's counts. Two requests hold two
   * transaction objects, so a `WeakMap` keyed on one has nothing to share — and
   * the entry goes when the transaction is collected whether anybody flushed it
   * or not.
   */
  it("keys the deferred counts on the transaction and nothing else", () => {
    const helpers = SERVICES.find((file) => file.path.endsWith("/helpers.ts"))!;
    expect(helpers.code).toMatch(/const deferredCounts = new WeakMap<\s*DbTransaction\s*,/);
    const flush = read([helpers]).find((it) => it.name === "flushDeferredCounts");
    expect(flush, "flushDeferredCounts has been renamed; 2.10 follows it").toBeDefined();
    // It reads and clears one transaction's entry, which is what makes the
    // opener the only thing that can release it.
    expect(flush!.parameters).toMatch(/\btransaction\s*:\s*DbTransaction\b/);
    expect(/deferredCounts\.delete\(\s*transaction\s*\)/.test(flush!.body)).toBe(true);
  });

  /**
   * The span reader, against the shape it exists for: the same statement
   * deferred and not deferred, in one body.
   */
  it("tells a deferred count from an immediate one", () => {
    const body = [
      "countAfterCommit(transaction, () => ledgerWrites.inc({ operation: 'create' }));",
      "ledgerWrites.inc({ operation: 'create' });",
    ].join("\n");
    const spans = callSpans(body, "countAfterCommit");
    const sites = [...body.matchAll(/\bledgerWrites\s*\.\s*inc\s*\(/g)].map((match) =>
      spans.some(([from, to]) => match.index > from && match.index < to),
    );
    expect(sites).toEqual([true, false]);
  });
});
