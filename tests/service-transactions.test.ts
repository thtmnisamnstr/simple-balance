import { describe, expect, it } from "vitest";
import { type SourceFile, sourceFiles, topLevelDeclarations } from "./support/source.js";

/**
 * `docs/standards/code/services.md` 2.1, which was marked `human` with the
 * reason "grep-able and not grepped".
 *
 * The rule has two halves and this checks both:
 *
 * - A mutation taking `transaction?: DbTransaction` runs through
 *   `withTransaction`, which joins the caller's transaction when there is one
 *   and opens its own when there is not. `getDb().transaction` directly is the
 *   form that cannot be composed, and the MCP transport composes: it passes its
 *   transaction in so the idempotency record, the mutation and the audit events
 *   commit together. Take that away and an agent's write can record a key that
 *   answers for a transaction which does not exist.
 * - A helper taking a required `tx: DbTransaction` never reaches for the pool.
 *   One that opens its own transaction commits independently of the caller that
 *   is about to fail, which is the bug this shape exists to prevent.
 *
 * What the first half is careful about is reads. `listConnectedApps` takes the
 * optional parameter and joins it with `transaction ?? getDb()`, which is right:
 * it runs two selects and wrapping them in a transaction of their own would buy
 * nothing. So `withTransaction` is asked of mutations only, and a declaration
 * that writes nothing is left alone rather than exempted by name — with one
 * thing still asked of every declaration that advertises the parameter,
 * mutation or not: it may not open `getDb().transaction` while holding the
 * caller's, which is ignoring the parameter rather than composing it.
 */
type Declaration = {
  readonly name: string;
  readonly where: string;
  readonly parameters: string;
  readonly body: string;
};

/** The text between the first bracket of a declaration and its match. */
const parameterList = (body: string): string => {
  const open = body.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < body.length; index++) {
    const character = body[index]!;
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      while (index < body.length && body[index] !== character) {
        index += body[index] === "\\" ? 2 : 1;
      }
    } else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return body.slice(open + 1, index);
    }
  }
  return "";
};

/**
 * Whether a declaration writes a row itself.
 *
 * Drizzle's builders and the audit call between them cover everything in this
 * directory that changes a row; raw `insert`/`update`/`delete` in a `sql`
 * template is here because the import path and the payee merge both use one.
 *
 * Each builder is matched with the call that follows it rather than on its own
 * name, because none of the three names belongs to Drizzle alone.
 * `createHash("sha256").update(payload)` is not a write and neither is
 * `canonicalPayeeCache.delete(tx)`; a Drizzle `update` is always followed by
 * `set`, and a `delete` by `where` or `returning`. Reading the bare name
 * counted `idempotencyRequestHash` and `selectionFingerprint` as writers, which
 * mattered once the reader started following calls: every mutation here reaches
 * one of those two, so a read that did as well would have been told to compose.
 */
const writesDirectly = (body: string) =>
  /\.insert\s*\([^()]*\)\s*\.values\s*\(/.test(body) ||
  /\.update\s*\([^()]*\)\s*\.set\s*\(/.test(body) ||
  /\.delete\s*\([^()]*\)\s*\.(where|returning)\s*\(/.test(body) ||
  /\bwriteAudit\s*\(/.test(body) ||
  /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(body);

/**
 * Every declaration that changes a row, whether it does the writing itself or
 * hands it to something here that does.
 *
 * The step past "does this body say `.insert(`" is what makes the rule reach
 * the mutation it matters most for. `createTransaction` writes nothing in its
 * own body: it locks the idempotency key, calls `createTransactionWithinTx` and
 * saves the result. A check that read only its own text called the entry point
 * for every transaction in the ledger a read and stopped looking at it, which
 * is the exemption nobody would have written down on purpose.
 *
 * Called names are read off the text rather than resolved, so this is a
 * one-directory approximation: a name that is not declared here reaches
 * nothing, and a name shadowed by a local is followed anyway. Both err towards
 * calling something a mutation, which is the safe direction — the cost is a
 * declaration asked to compose when it need not, and there are none today.
 */
const mutationNames = (declarations: readonly Declaration[]): Set<string> => {
  const mutations = new Set(
    declarations.filter((declaration) => writesDirectly(declaration.body)).map((it) => it.name),
  );
  const callsIn = new Map(
    declarations.map((declaration) => [
      declaration.name,
      new Set(
        [...declaration.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]!),
      ),
    ]),
  );
  // Repeated until a pass adds nothing, because the delegation runs four hops:
  // `prepareGeneratedStage` → `validateDraft` → `prepareTransaction` →
  // `ensureSystemAccount` → `ensureSystemAccountUncached`, which is the one
  // that writes the row.
  for (let settled = false; !settled;) {
    settled = true;
    for (const declaration of declarations) {
      if (mutations.has(declaration.name)) continue;
      for (const called of callsIn.get(declaration.name) ?? []) {
        if (called === declaration.name || !mutations.has(called)) continue;
        mutations.add(declaration.name);
        settled = false;
        break;
      }
    }
  }
  return mutations;
};

/**
 * A declaration that advertises the parameter and cannot be composed anyway.
 *
 * Two shapes, because they fail differently. A mutation that never hands the
 * parameter to `withTransaction` runs outside the caller's transaction; and
 * anything that opens `getDb().transaction` while holding the caller's is
 * ignoring it outright, which is worth refusing whether it writes or not.
 */
const opensItsOwn = (declaration: Declaration, mutations: ReadonlySet<string>) =>
  /\bgetDb\s*\(\s*\)\s*\.transaction\b/.test(declaration.body) ||
  (mutations.has(declaration.name) &&
    !/\bwithTransaction\s*\(\s*transaction\b/.test(declaration.body));

const read = (files: readonly SourceFile[]): Declaration[] =>
  files.flatMap((file) =>
    topLevelDeclarations(file).map((declaration) => ({
      name: declaration.name,
      where: `${file.path}:${declaration.line} ${declaration.name}`,
      parameters: parameterList(declaration.body),
      body: declaration.body,
    })),
  );

const declarations = read(sourceFiles("src/server/services"));
const mutations = mutationNames(declarations);

const composable = declarations.filter((declaration) =>
  /\btransaction\?\s*:\s*DbTransaction\b/.test(declaration.parameters),
);
const helpers = declarations.filter((declaration) =>
  /\btx\s*:\s*DbTransaction\b/.test(declaration.parameters),
);

/** A fixture file, so a case can state a shape this directory does not have. */
const fixture = (lines: string[]): Declaration[] => {
  const text = lines.join("\n");
  return read([{ path: "sample.ts", text, code: text }]);
};

describe("reading the service layer", () => {
  it("finds both shapes the guide counts", () => {
    // 60 take the required parameter, which is the one number `services.md` 2.1
    // states; 38 take the optional one, which it does not. Both are held as a
    // floor rather than an equality, because the point is that the reader is
    // finding them, not that the directory has stopped growing.
    expect(composable.length).toBeGreaterThanOrEqual(30);
    expect(helpers.length).toBeGreaterThanOrEqual(50);
  });

  it("tells a parameter list from the body under it", () => {
    const [declaration] = fixture([
      "export async function createThing(actor: Actor, input: unknown, transaction?: DbTransaction) {",
      "  return withTransaction(transaction, async (tx) => {",
      "    await tx.insert(things).values({});",
      "  });",
      "}",
    ]);
    expect(declaration!.parameters).toBe(
      "actor: Actor, input: unknown, transaction?: DbTransaction",
    );
    expect(writesDirectly(declaration!.body)).toBe(true);
  });

  it("does not read a select as a write", () => {
    expect(writesDirectly("return runner.select().from(things);")).toBe(false);
  });

  // The one that matters most in this directory, because `createTransaction`
  // has exactly this shape: the entry point writes nothing itself.
  it("counts a mutation that delegates every write to a helper", () => {
    const declared = fixture([
      "async function saveThing(tx: DbTransaction, input: unknown) {",
      "  await tx.insert(things).values(input);",
      "}",
      "export async function createThing(actor: Actor, transaction?: DbTransaction) {",
      "  return withTransaction(transaction, async (tx) => saveThing(tx, {}));",
      "}",
    ]);
    const named = mutationNames(declared);
    expect([...named].sort()).toEqual(["createThing", "saveThing"]);
    expect(declared.map((it) => writesDirectly(it.body))).toEqual([true, false]);
  });
});

describe("a service mutation", () => {
  // Every real declaration passes, so the shapes that matter are stated here
  // instead. All four delegate their writing, which is the case the reader used
  // to miss entirely: the composable one, the one that opens its own
  // transaction while holding the caller's, the one that writes through the
  // pool without opening one at all, and the read that is allowed to join a
  // transaction rather than open one.
  it("separates one that composes from one that does not", () => {
    const declared = fixture([
      "async function saveThing(tx: DbTransaction) {",
      "  await tx.insert(things).values({});",
      "}",
      "export async function joins(transaction?: DbTransaction) {",
      "  return withTransaction(transaction, async (tx) => saveThing(tx));",
      "}",
      "export async function owns(transaction?: DbTransaction) {",
      "  return getDb().transaction(async (tx) => saveThing(tx));",
      "}",
      "export async function escapes(transaction?: DbTransaction) {",
      "  return saveThing(transaction ?? getDb());",
      "}",
      "export async function reads(transaction?: DbTransaction) {",
      "  const runner = transaction ?? getDb();",
      "  return runner.select().from(things);",
      "}",
    ]);
    const named = mutationNames(declared);
    const verdict = Object.fromEntries(
      declared
        .filter((it) => /\btransaction\?\s*:\s*DbTransaction\b/.test(it.parameters))
        .map((it) => [it.name, opensItsOwn(it, named)]),
    );
    expect(verdict).toEqual({ joins: false, owns: true, escapes: true, reads: false });
  });

  it("joins the caller's transaction rather than opening its own", () => {
    const wrong = composable
      .filter((declaration) => opensItsOwn(declaration, mutations))
      .map((declaration) => declaration.where);
    expect(
      wrong,
      "wrap the body in `withTransaction(transaction, async (tx) => …)` so a caller can compose it",
    ).toEqual([]);
  });
});

describe("a service helper", () => {
  it("is caught reaching for the pool", () => {
    const declared = fixture([
      "async function honest(tx: DbTransaction) {",
      "  return tx.select().from(things);",
      "}",
      "async function reaches(tx: DbTransaction) {",
      "  return getDb().select().from(things);",
      "}",
    ]);
    expect(declared.filter((it) => /\bgetDb\s*\(/.test(it.body)).map((it) => it.name)).toEqual([
      "reaches",
    ]);
  });

  it("uses the transaction it was handed and never the pool", () => {
    const wrong = helpers
      .filter((declaration) => /\bgetDb\s*\(/.test(declaration.body))
      .map((declaration) => declaration.where);
    expect(
      wrong,
      "a helper that opens its own connection commits independently of the caller that is about to fail",
    ).toEqual([]);
  });
});
