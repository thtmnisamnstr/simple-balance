import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  Actor,
  PayeeMergeResult,
  PayeeSummary,
} from "../../shared/domain.js";
import {
  payeeDuplicateGroupSchema,
  payeeListQuerySchema,
  payeeMergeResultSchema,
  payeeMergeSchema,
  payeeNameSchema,
  payeeSummarySchema,
} from "../../shared/domain.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  stagedTransactions,
  transactions,
} from "../db/schema.js";
import { notFound, validationError } from "./errors.js";
import {
  getIdempotent,
  lockIdempotencyKey,
  lockPayeeNamespace,
  serializeRow,
  setIdempotent,
  writeAudit,
  type Executor,
} from "./helpers.js";
import { cleanHumanName, normalizeHumanName } from "../../shared/names.js";

type PayeeCountRow = {
  name: unknown;
  transaction_count: unknown;
  staged_transaction_count: unknown;
};

const canonicalPayeeCache = new WeakMap<object, Map<string, string>>();

/** Preload canonical names for a bulk operation sharing one transaction. */
export function seedCanonicalPayeeCache(
  tx: DbTransaction,
  canonicalByNormalized: ReadonlyMap<string, string>,
) {
  canonicalPayeeCache.set(tx, new Map(canonicalByNormalized));
}

function count(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Database returned an invalid payee reference count");
  }
  return parsed;
}

/**
 * List exact stored spellings. Logical duplicate grouping is deliberately done
 * in JavaScript so Unicode NFKC normalization is identical to browser/import
 * canonicalization rather than dependent on database collation behavior.
 */
export async function payeeSummaries(executor: Executor, actor: Actor) {
  const result = await executor.execute(sql`
    select
      payee_name as name,
      sum(transaction_count)::int as transaction_count,
      sum(staged_transaction_count)::int as staged_transaction_count
    from (
      select
        payee as payee_name,
        count(*)::int as transaction_count,
        0::int as staged_transaction_count
      from ledger_transaction
      where user_id = ${actor.userId}
        and deleted_at is null
        and char_length(trim(payee)) between 1 and 160
      group by payee

      union all

      select
        draft ->> 'payee' as payee_name,
        0::int as transaction_count,
        count(*)::int as staged_transaction_count
      from staged_transaction
      where user_id = ${actor.userId}
        and status = 'staged'
        and jsonb_typeof(draft -> 'payee') = 'string'
        and char_length(trim(draft ->> 'payee')) between 1 and 160
      group by draft ->> 'payee'
    ) as payee_references
    group by payee_name
    order by payee_name
  `);

  return payeeSummarySchema.array().parse(
    (result.rows as PayeeCountRow[])
      .map((row): PayeeSummary => {
        const name = String(row.name);
        const transactionCount = count(row.transaction_count);
        const stagedTransactionCount = count(row.staged_transaction_count);
        return {
          name,
          normalizedName: normalizeHumanName(name),
          transactionCount,
          stagedTransactionCount,
          totalCount: transactionCount + stagedTransactionCount,
        };
      })
      .sort(
        (left, right) =>
          left.normalizedName.localeCompare(right.normalizedName) ||
          left.name.localeCompare(right.name),
      ),
  );
}

export async function listPayees(actor: Actor, input: unknown = {}) {
  const query = payeeListQuerySchema.parse(input ?? {});
  const search = query.search ? normalizeHumanName(query.search) : "";
  const summaries = await payeeSummaries(getDb(), actor);
  return search
    ? summaries.filter((payee) => payee.normalizedName.includes(search))
    : summaries;
}

export async function listDuplicatePayees(actor: Actor) {
  const summaries = await payeeSummaries(getDb(), actor);
  const grouped = new Map<string, PayeeSummary[]>();
  for (const summary of summaries) {
    const group = grouped.get(summary.normalizedName);
    if (group) group.push(summary);
    else grouped.set(summary.normalizedName, [summary]);
  }

  return payeeDuplicateGroupSchema.array().parse(
    [...grouped.entries()]
      .filter(([, payees]) => payees.length > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([normalizedName, payees]) => ({
        normalizedName,
        count: payees.length,
        payees: payees.sort(
          (left, right) =>
            right.totalCount - left.totalCount ||
            left.name.localeCompare(right.name),
        ),
      })),
  );
}

export function preferredPayee(payees: readonly PayeeSummary[]) {
  return [...payees].sort((left, right) => {
    const leftClean = left.name === cleanHumanName(left.name) ? 1 : 0;
    const rightClean = right.name === cleanHumanName(right.name) ? 1 : 0;
    return (
      right.totalCount - left.totalCount ||
      rightClean - leftClean ||
      left.name.localeCompare(right.name)
    );
  })[0];
}

export async function listPayeeSuggestions(
  actor: Actor,
  searchInput: unknown,
) {
  const { search = "" } = payeeListQuerySchema.parse({ search: searchInput });
  const normalizedSearch = normalizeHumanName(search);
  const grouped = new Map<string, PayeeSummary[]>();
  for (const summary of await payeeSummaries(getDb(), actor)) {
    if (
      normalizedSearch &&
      !summary.normalizedName.includes(normalizedSearch)
    ) {
      continue;
    }
    const group = grouped.get(summary.normalizedName);
    if (group) group.push(summary);
    else grouped.set(summary.normalizedName, [summary]);
  }

  return [...grouped.values()]
    .map((payees) => preferredPayee(payees)!)
    .sort(
      (left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 100)
    .map((summary) => cleanHumanName(summary.name));
}

/**
 * Reuse the preferred spelling of an existing logical payee. The caller must
 * hold the tenant payee namespace lock before using the returned value in a
 * mutation.
 */
export async function resolveCanonicalPayee(
  tx: DbTransaction,
  actor: Actor,
  input: string,
) {
  const cleaned = payeeNameSchema.parse(cleanHumanName(input));
  const normalizedName = normalizeHumanName(cleaned);
  let cache = canonicalPayeeCache.get(tx);
  if (!cache) {
    cache = new Map<string, string>();
    const grouped = new Map<string, PayeeSummary[]>();
    for (const summary of await payeeSummaries(tx, actor)) {
      const group = grouped.get(summary.normalizedName);
      if (group) group.push(summary);
      else grouped.set(summary.normalizedName, [summary]);
    }
    for (const [normalized, payees] of grouped) {
      cache.set(normalized, cleanHumanName(preferredPayee(payees)!.name));
    }
    canonicalPayeeCache.set(tx, cache);
  }
  const cached = cache.get(normalizedName);
  if (cached) return cached;
  cache.set(normalizedName, cleaned);
  return cleaned;
}

export async function canonicalizeStagedDraftPayee(
  tx: DbTransaction,
  actor: Actor,
  input: unknown,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const draft = input as Record<string, unknown>;
  if (typeof draft.payee !== "string") return input;
  const cleaned = cleanHumanName(draft.payee);
  if (!payeeNameSchema.safeParse(cleaned).success) return input;
  return {
    ...draft,
    payee: await resolveCanonicalPayee(tx, actor, cleaned),
  };
}

export async function mergePayees(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = payeeMergeSchema.parse(input);
  const sourcePayees = [...new Set(parsed.sourcePayees)];
  if (sourcePayees.length !== parsed.sourcePayees.length) {
    throw validationError("Source payees must be unique");
  }
  if (sourcePayees.includes(parsed.targetPayee)) {
    throw validationError("The target payee cannot also be a source payee");
  }
  const idempotencyPayload = {
    sourcePayees,
    targetPayee: parsed.targetPayee,
  };

  return withTransaction(transaction, async (tx) => {
    await lockIdempotencyKey(
      tx,
      actor,
      "payee.merge",
      parsed.idempotencyKey,
    );
    const existing = await getIdempotent<PayeeMergeResult>(
      tx,
      actor,
      "payee.merge",
      parsed.idempotencyKey,
      idempotencyPayload,
    );
    if (existing) return existing;

    await lockPayeeNamespace(tx, actor);
    canonicalPayeeCache.delete(tx);
    const requestedPayees = [parsed.targetPayee, ...sourcePayees];
    const transactionRows = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          inArray(transactions.payee, requestedPayees),
        ),
      )
      .orderBy(transactions.id)
      .for("update");
    const stagedRows = await tx
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          sql`jsonb_typeof(${stagedTransactions.draft} -> 'payee') = 'string'`,
          inArray(
            sql<string>`${stagedTransactions.draft} ->> 'payee'`,
            requestedPayees,
          ),
        ),
      )
      .orderBy(stagedTransactions.id)
      .for("update");

    const referencedNames = new Set<string>([
      ...transactionRows.map((row) => row.payee),
      ...stagedRows.map((row) =>
        String((row.draft as Record<string, unknown>).payee),
      ),
    ]);
    if (requestedPayees.some((payee) => !referencedNames.has(payee))) {
      throw notFound("One or more payees were not found");
    }

    const transactionRowsBefore = transactionRows.filter((row) =>
      sourcePayees.includes(row.payee),
    );
    const stagedRowsBefore = stagedRows.filter((row) =>
      sourcePayees.includes(
        String((row.draft as Record<string, unknown>).payee),
      ),
    );
    const now = new Date();
    const updatedTransactions = transactionRowsBefore.length
      ? await tx
          .update(transactions)
          .set({
            payee: parsed.targetPayee,
            version: sql`${transactions.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(transactions.userId, actor.userId),
              inArray(transactions.payee, sourcePayees),
            ),
          )
          .returning()
      : [];
    const updatedStages = stagedRowsBefore.length
      ? await tx
          .update(stagedTransactions)
          .set({
            draft: sql`jsonb_set(
              ${stagedTransactions.draft},
              '{payee}',
              to_jsonb(${parsed.targetPayee}::text),
              true
            )`,
            version: sql`${stagedTransactions.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(stagedTransactions.userId, actor.userId),
              sql`jsonb_typeof(${stagedTransactions.draft} -> 'payee') = 'string'`,
              inArray(
                sql<string>`${stagedTransactions.draft} ->> 'payee'`,
                sourcePayees,
              ),
            ),
          )
          .returning()
      : [];

    const transactionBeforeById = new Map(
      transactionRowsBefore.map((row) => [row.id, row]),
    );
    for (const updated of updatedTransactions) {
      await writeAudit(tx, actor, {
        entityType: "transaction",
        entityId: updated.id,
        operation: "payee_merge",
        before: serializeRow(transactionBeforeById.get(updated.id)),
        after: serializeRow(updated),
      });
    }
    const stagedBeforeById = new Map(
      stagedRowsBefore.map((row) => [row.id, row]),
    );
    for (const updated of updatedStages) {
      await writeAudit(tx, actor, {
        entityType: "staged_transaction",
        entityId: updated.id,
        operation: "payee_merge",
        before: serializeRow(stagedBeforeById.get(updated.id)),
        after: serializeRow(updated),
      });
    }

    const response = payeeMergeResultSchema.parse({
      targetPayee: parsed.targetPayee,
      mergedSourcePayees: sourcePayees,
      updatedTransactionCount: updatedTransactions.length,
      updatedStagedTransactionCount: updatedStages.length,
    });
    await writeAudit(tx, actor, {
      entityType: "payee",
      entityId: parsed.targetPayee,
      operation: "merge",
      before: { sourcePayees },
      after: response,
    });
    await setIdempotent(
      tx,
      actor,
      "payee.merge",
      parsed.idempotencyKey,
      idempotencyPayload,
      response,
    );
    return response;
  });
}
