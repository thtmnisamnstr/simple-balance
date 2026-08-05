import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import {
  MAX_TRANSACTION_TEMPLATES,
  transactionTemplateCreateSchema,
  transactionTemplateUpdateSchema,
  type TransactionTemplateDraft,
} from "../../shared/domain.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  categories,
  ledgerAccounts,
  transactionTemplates,
} from "../db/schema.js";
import { conflict, duplicate, notFound, staleVersion, validationError } from "./errors.js";
import {
  lockTransactionTemplateNamespace,
  serializeRow,
  writeAudit,
} from "./helpers.js";
import { normalizeHumanName } from "./names.js";

/**
 * A template is a saved starting point for the transaction form. Nothing here
 * posts, reverses, or reads a balance: creating one records an intention, and
 * using one only fills in a form the person then submits themselves.
 */

async function assertNameAvailable(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const rows = await tx
    .select({ id: transactionTemplates.id, name: transactionTemplates.name })
    .from(transactionTemplates)
    .where(eq(transactionTemplates.userId, actor.userId));
  const normalized = normalizeHumanName(name);
  // Compared the way category names are, ignoring case and spacing. The picker
  // is a list of names, and two templates called Rent is a list nobody can use.
  const existing = rows.find(
    (row) => row.id !== excludeId && normalizeHumanName(row.name) === normalized,
  );
  if (existing) {
    throw duplicate("A template with this name already exists", {
      duplicateTemplateId: existing.id,
    });
  }
}

/**
 * The ids inside a draft carry no foreign key, so ownership is checked here
 * instead. Without it a template could hold somebody else's account and quietly
 * offer it back on the form.
 */
async function assertReferencesAreOwned(
  tx: DbTransaction,
  actor: Actor,
  draft: TransactionTemplateDraft,
) {
  const accountIds = [draft.fromAccountId, draft.toAccountId].filter(
    (value): value is string => Boolean(value),
  );
  if (accountIds.length) {
    const owned = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.userId, actor.userId),
          inArray(ledgerAccounts.id, accountIds),
          sql`${ledgerAccounts.systemKind} is null`,
        ),
      );
    const found = new Set(owned.map((row) => row.id));
    const missing = accountIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw validationError("That account is not one of yours", {
        accountIds: missing,
      });
    }
  }
  if (draft.categoryId) {
    const [owned] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, draft.categoryId),
          eq(categories.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!owned) {
      throw validationError("That category is not one of yours", {
        categoryId: draft.categoryId,
      });
    }
  }
}

const templateView = (row: typeof transactionTemplates.$inferSelect) => ({
  ...serializeRow(row),
  draft: row.draft as TransactionTemplateDraft,
});

export async function listTransactionTemplates(actor: Actor) {
  const rows = await getDb()
    .select()
    .from(transactionTemplates)
    .where(eq(transactionTemplates.userId, actor.userId))
    .orderBy(transactionTemplates.name);
  return rows.map(templateView);
}

export async function getTransactionTemplate(actor: Actor, id: string) {
  const [row] = await getDb()
    .select()
    .from(transactionTemplates)
    .where(
      and(
        eq(transactionTemplates.id, id),
        eq(transactionTemplates.userId, actor.userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Template not found");
  return templateView(row);
}

export async function createTransactionTemplate(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = transactionTemplateCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    await assertNameAvailable(tx, actor, parsed.name);
    await assertReferencesAreOwned(tx, actor, parsed.draft);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionTemplates)
      .where(eq(transactionTemplates.userId, actor.userId));
    if (count >= MAX_TRANSACTION_TEMPLATES) {
      throw conflict(
        `You can keep ${MAX_TRANSACTION_TEMPLATES} templates. Delete one you no longer use to make room.`,
        { limit: MAX_TRANSACTION_TEMPLATES, current: count },
      );
    }
    const [created] = await tx
      .insert(transactionTemplates)
      .values({ userId: actor.userId, name: parsed.name, draft: parsed.draft })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: created.id,
      operation: "create",
      after: templateView(created),
    });
    return templateView(created);
  });
}

export async function updateTransactionTemplate(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = transactionTemplateUpdateSchema.parse(input);
  const { expectedVersion, ...changes } = parsed;
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!before) throw notFound("Template not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    if (changes.name !== undefined) {
      await assertNameAvailable(tx, actor, changes.name, id);
    }
    if (changes.draft !== undefined) {
      await assertReferencesAreOwned(tx, actor, changes.draft);
    }
    const [updated] = await tx
      .update(transactionTemplates)
      .set({
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.draft !== undefined ? { draft: changes.draft } : {}),
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
          eq(transactionTemplates.version, before.version),
        ),
      )
      .returning();
    if (!updated) throw staleVersion({ currentVersion: before.version });
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: id,
      operation: "update",
      before: templateView(before),
      after: templateView(updated),
    });
    return templateView(updated);
  });
}

export async function deleteTransactionTemplate(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!before) throw notFound("Template not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    // Deleted outright rather than archived. A template records nothing that
    // happened, so there is no history to keep, and the transactions made from
    // it are unaffected.
    await tx
      .delete(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
          eq(transactionTemplates.version, expectedVersion),
        ),
      );
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: id,
      operation: "delete",
      before: templateView(before),
    });
    return { id, deleted: true };
  });
}
