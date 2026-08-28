/**
 * Which service declarations change a row, read off the source.
 *
 * Two tests need the same answer and must not each have their own: the service
 * guide's rule that a mutation composes a caller's transaction
 * (`tests/service-transactions.test.ts`), and the MCP surface's rule that a
 * tool annotated `readOnlyHint` reaches nothing that writes
 * (`tests/mcp-parity.test.ts`). A second copy of "does this write" would drift,
 * and the direction it drifts in is the dangerous one — a writer nobody
 * recognised as a writer.
 */

/** The shape both callers already have: a declaration's name and its body. */
export type NamedBody = { readonly name: string; readonly body: string };

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
export const writesDirectly = (body: string) =>
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
export const mutationNames = (declarations: readonly NamedBody[]): Set<string> => {
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
