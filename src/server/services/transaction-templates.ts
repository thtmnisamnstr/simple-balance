import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import {
  MAX_TRANSACTION_TEMPLATES,
  transactionTemplateBulkDeleteSchema,
  transactionTemplateBulkEditSchema,
  transactionTemplateBulkResultSchema,
  transactionTemplateCreateSchema,
  transactionTemplateDraftSchema,
  transactionTemplateUpdateSchema,
  type TransactionTemplateBulkPatch,
  type TransactionTemplateBulkResult,
  type TransactionTemplateBulkSelection,
  type TemplateNotification,
  type TransactionTemplateDraft,
} from "../../shared/domain.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  categories,
  ledgerAccounts,
  stagedTransactions,
  templateNotifications,
  transactionTemplates,
  transactions,
} from "../db/schema.js";
import { conflict, duplicate, notFound, staleVersion, validationError } from "./errors.js";
import {
  firstNotificationDate,
  notificationRuleOf,
  type NotificationRule,
} from "./notifications.js";
import {
  getIdempotent,
  lockIdempotencyKey,
  lockTransactionTemplateNamespace,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import { normalizeHumanName } from "../../shared/names.js";

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
  draft: Pick<TransactionTemplateDraft, "fromAccountId" | "toAccountId" | "categoryId" | "legs">,
) {
  const accountIds = [draft.fromAccountId, draft.toAccountId].filter((value): value is string =>
    Boolean(value),
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
  // A leg's category is as much a reference as the template's own, so it is
  // checked the same way rather than trusted because it arrived inside a list.
  const categoryIds = [
    ...new Set(
      [draft.categoryId, ...(draft.legs ?? []).map((leg) => leg.categoryId)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  if (categoryIds.length) {
    const owned = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(inArray(categories.id, categoryIds), eq(categories.userId, actor.userId)));
    const found = new Set(owned.map((row) => row.id));
    const missing = categoryIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw validationError("That category is not one of yours", {
        categoryId: missing[0],
        categoryIds: missing,
      });
    }
  }
}

type NotificationRow = typeof templateNotifications.$inferSelect;

/**
 * The reminder as a caller sees it: the rule they set, and when it next goes.
 *
 * `nextNotification` is the stored column rather than a recomputed one, unlike a
 * recurrence's, because for a one-off it is the only thing that says whether it
 * has already been sent. Null means nothing further is owed.
 */
const notificationView = (row: NotificationRow) => ({
  frequency: row.frequency,
  interval: row.interval,
  anchorDate: row.anchorDate,
  monthPolicy: row.monthPolicy,
  weekendPolicy: row.weekendPolicy,
  position:
    row.positionOrdinal !== null && row.positionWeekday !== null
      ? { ordinal: row.positionOrdinal, weekday: row.positionWeekday }
      : null,
  time: row.notifyAt,
  repeats: row.frequency !== null,
  lastNotifiedDate: row.lastNotifiedDate,
  nextNotificationDate: row.nextNotificationDate,
});

const templateView = (
  row: typeof transactionTemplates.$inferSelect,
  notification: NotificationRow | null = null,
) => ({
  ...serializeRow(row),
  draft: row.draft as TransactionTemplateDraft,
  notification: notification ? notificationView(notification) : null,
});

/**
 * The reminders these templates have, keyed by template.
 *
 * Read before any write that replaces or removes them, because an audit
 * snapshot built without it says `notification: null`, and null in that record
 * does not read as "nobody asked" — it reads as "this template had no
 * reminder". The bulk paths and the delete paths were writing exactly that
 * about templates that did.
 */
async function readNotifications(tx: DbTransaction, actor: Actor, templateIds: readonly string[]) {
  if (templateIds.length === 0) return new Map<string, NotificationRow>();
  const rows = await tx
    .select()
    .from(templateNotifications)
    .where(
      and(
        eq(templateNotifications.userId, actor.userId),
        inArray(templateNotifications.templateId, [...templateIds]),
      ),
    );
  return new Map(rows.map((row) => [row.templateId, row]));
}

/**
 * Write, replace or remove the one reminder a template may have.
 *
 * `undefined` leaves whatever is stored alone, which is what an update that says
 * nothing about the reminder means; `null` removes it. Replacing rather than
 * patching, because the rule is refused or accepted whole — a stored monthly
 * rule merged with an incoming null frequency would be a one-off still carrying
 * a month policy, which the table refuses and nobody asked for.
 */
async function writeNotification(
  tx: DbTransaction,
  actor: Actor,
  templateId: string,
  notification: TemplateNotification | null | undefined,
) {
  const existing = (await readNotifications(tx, actor, [templateId])).get(templateId);
  if (notification === undefined) return existing ?? null;
  await tx
    .delete(templateNotifications)
    .where(
      and(
        eq(templateNotifications.templateId, templateId),
        eq(templateNotifications.userId, actor.userId),
      ),
    );
  if (notification === null) return null;
  const rule = {
    frequency: notification.frequency,
    interval: notification.interval ?? 1,
    anchorDate: notification.anchorDate,
    monthPolicy: notification.monthPolicy ?? "last_day",
    weekendPolicy: notification.weekendPolicy ?? "allow",
    position: notification.position ?? null,
  } as const;
  // Saving the template again must not re-send what has already gone. The row is
  // replaced whole, so without this the watermark is replaced too and a reminder
  // sent last week is owed again the moment somebody edits the payee.
  //
  // Compared after defaults are applied, never against the incoming object: a
  // one-off legitimately omits the interval and both policies, so the raw shapes
  // differ every time even when nothing changed. A schedule that really did
  // change starts afresh, which is what somebody moving the date is asking for.
  const unchanged =
    existing !== undefined &&
    existing.notifyAt === notification.time &&
    sameRule(notificationRuleOf(existing), rule);
  const [created] = await tx
    .insert(templateNotifications)
    .values({
      userId: actor.userId,
      templateId,
      frequency: rule.frequency,
      interval: rule.interval,
      anchorDate: rule.anchorDate,
      monthPolicy: rule.monthPolicy,
      weekendPolicy: rule.weekendPolicy,
      positionOrdinal: rule.position?.ordinal ?? null,
      positionWeekday: rule.position?.weekday ?? null,
      notifyAt: notification.time,
      // A new schedule is deliberately not floored to today. A reminder anchored
      // in the past is somebody asking to be told about something they have
      // already missed, and the sweep collapses a backlog to one message, so it
      // costs one mail and answers the question they were asking.
      lastNotifiedDate: unchanged ? existing.lastNotifiedDate : null,
      nextNotificationDate: unchanged ? existing.nextNotificationDate : firstNotificationDate(rule),
    })
    .returning();
  return created;
}

/** Two reminder rules, compared field by field with the position flattened. */
function sameRule(left: NotificationRule, right: NotificationRule) {
  return (
    left.frequency === right.frequency &&
    left.interval === right.interval &&
    left.anchorDate === right.anchorDate &&
    left.monthPolicy === right.monthPolicy &&
    left.weekendPolicy === right.weekendPolicy &&
    (left.position?.ordinal ?? null) === (right.position?.ordinal ?? null) &&
    (left.position?.weekday ?? null) === (right.position?.weekday ?? null)
  );
}

/** Which account side a type reads, so the other one is not worth storing. */
const accountSides = {
  deposit: { keep: "toAccountId", drop: "fromAccountId" },
  withdrawal: { keep: "fromAccountId", drop: "toAccountId" },
  transfer: { keep: null, drop: null },
} as const;

/**
 * The patch applied to one draft, re-parsed so what comes back is a draft
 * rather than something draft-shaped.
 *
 * A key the patch leaves out is left alone, a value sets it, and `null` removes
 * it. Changing the type drops whichever side the new type will never read,
 * because a template holding an account nothing looks at is worse than a blank
 * the person fills in on use.
 */
export function applyTemplateBulkPatch(
  draft: TransactionTemplateDraft,
  patch: TransactionTemplateBulkPatch,
): TransactionTemplateDraft {
  const next: Record<string, unknown> = { ...draft };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if (patch.type) {
    const { drop } = accountSides[patch.type];
    if (drop) delete next[drop];
    if (patch.type !== "transfer") delete next.destinationAmount;
  }
  // Legs and a single category cannot both be stored, so asking for legs is
  // also asking for the single category to go. Nothing is lost the other way
  // round: a split is only ever taken away by naming it, with `legs: null`.
  if (patch.legs) {
    delete next.categoryId;
    delete next.categoryName;
  }
  return transactionTemplateDraftSchema.parse(next);
}

/**
 * The refusals a split template shares with a split transaction, raised here
 * with the templates named rather than left to the schema, which would report
 * a shape error about a row the person cannot see.
 */
function assertPatchKeepsSplits(
  rows: { id: string; draft: TransactionTemplateDraft }[],
  patch: TransactionTemplateBulkPatch,
) {
  const setsCategory = (patch.categoryId ?? patch.categoryName) != null && !patch.legs;
  if (!setsCategory && patch.type !== "transfer") return;
  const split = rows.filter((row) => row.draft.legs?.length);
  if (!split.length) return;
  throw validationError(
    setsCategory
      ? "A split template already files its money by leg, so a single category cannot be set here"
      : "A transfer cannot be split by category",
    { templateIds: split.map((row) => row.id) },
  );
}

/**
 * Setting an account side that the row's type will never read is refused rather
 * than dropped. Dropping it would report a template changed in a way it was
 * not, and the person asked for something this row cannot hold.
 */
function assertPatchFitsType(
  rows: { id: string; draft: TransactionTemplateDraft }[],
  patch: TransactionTemplateBulkPatch,
) {
  const effectiveType = (row: { draft: TransactionTemplateDraft }) =>
    patch.type === null ? undefined : (patch.type ?? row.draft.type);
  for (const side of ["fromAccountId", "toAccountId"] as const) {
    if (!patch[side]) continue;
    const stranded = rows.filter((row) => {
      const type = effectiveType(row);
      return type ? accountSides[type].drop === side : false;
    });
    if (stranded.length) {
      throw validationError(
        side === "fromAccountId"
          ? "A deposit has no source account, so it cannot be set here"
          : "A withdrawal has no destination account, so it cannot be set here",
        { templateIds: stranded.map((row) => row.id) },
      );
    }
  }
  if (patch.destinationAmount) {
    const stranded = rows.filter((row) => {
      const type = effectiveType(row);
      return type !== undefined && type !== "transfer";
    });
    if (stranded.length) {
      throw validationError("Only a transfer has a received amount, so it cannot be set here", {
        templateIds: stranded.map((row) => row.id),
      });
    }
  }
}

async function lockSelectedTemplates(
  tx: DbTransaction,
  actor: Actor,
  selection: TransactionTemplateBulkSelection,
) {
  const ids = selection.items.map((item) => item.id);
  const rows = await tx
    .select()
    .from(transactionTemplates)
    .where(
      and(eq(transactionTemplates.userId, actor.userId), inArray(transactionTemplates.id, ids)),
    )
    .orderBy(transactionTemplates.id)
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw notFound("Some of those templates are unavailable", {
      templateIds: missing,
    });
  }
  const stale = selection.items.filter(
    (item) => byId.get(item.id)!.version !== item.expectedVersion,
  );
  if (stale.length) {
    throw staleVersion({
      templateIds: stale.map((item) => item.id),
      currentVersions: stale.map((item) => byId.get(item.id)!.version),
    });
  }
  return selection.items.map((item) => byId.get(item.id)!);
}

export async function bulkEditTransactionTemplates(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<TransactionTemplateBulkResult> {
  const parsed = transactionTemplateBulkEditSchema.parse(input);
  const idempotencyPayload = {
    selection: parsed.selection,
    patch: parsed.patch,
  };
  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(tx, actor, "transaction_template.bulk_edit", parsed.idempotencyKey);
      const existing = await getIdempotent<TransactionTemplateBulkResult>(
        tx,
        actor,
        "transaction_template.bulk_edit",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return transactionTemplateBulkResultSchema.parse(existing);
    }
    await lockTransactionTemplateNamespace(tx, actor);
    const rows = await lockSelectedTemplates(tx, actor, parsed.selection);
    const selected = rows.map((row) => ({
      id: row.id,
      draft: row.draft as TransactionTemplateDraft,
    }));
    assertPatchFitsType(selected, parsed.patch);
    assertPatchKeepsSplits(selected, parsed.patch);

    // Both sides go through the schema before they are compared. Postgres
    // orders jsonb keys by length and Zod returns them in the order the schema
    // declares, so comparing a stored draft against a parsed one reports every
    // row changed however little was asked for.
    const planned = rows.map((row) => {
      const before = transactionTemplateDraftSchema.parse(row.draft);
      return { row, before, draft: applyTemplateBulkPatch(before, parsed.patch) };
    });
    // Only what the patch introduces. A template outlives the account it names,
    // so checking the whole draft would make every old template refuse an edit
    // to its payee over an account nobody was touching.
    await assertReferencesAreOwned(tx, actor, {
      fromAccountId: parsed.patch.fromAccountId ?? undefined,
      toAccountId: parsed.patch.toAccountId ?? undefined,
      categoryId: parsed.patch.categoryId ?? undefined,
      legs: parsed.patch.legs ?? undefined,
    });

    const changed = planned.filter(
      ({ before, draft }) => JSON.stringify(before) !== JSON.stringify(draft),
    );
    if (parsed.dryRun) {
      return {
        dryRun: true,
        changedCount: changed.length,
        items: changed.map(({ row }) => ({
          id: row.id,
          name: row.name,
          version: row.version,
        })),
      };
    }

    // The patch cannot touch a reminder, so the same one stands on both sides
    // of the snapshot. Left out, the record would claim the edit removed it.
    const reminders = await readNotifications(
      tx,
      actor,
      changed.map(({ row }) => row.id),
    );
    const items: TransactionTemplateBulkResult["items"] = [];
    for (const { row, draft } of changed) {
      const [updated] = await tx
        .update(transactionTemplates)
        .set({ draft, version: row.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(transactionTemplates.id, row.id),
            eq(transactionTemplates.userId, actor.userId),
            eq(transactionTemplates.version, row.version),
          ),
        )
        .returning();
      if (!updated) throw staleVersion({ templateIds: [row.id] });
      await writeAudit(tx, actor, {
        entityType: "transaction_template",
        entityId: row.id,
        operation: "bulk_edit",
        before: templateView(row, reminders.get(row.id) ?? null),
        after: templateView(updated, reminders.get(row.id) ?? null),
      });
      items.push({
        id: updated.id,
        name: updated.name,
        version: updated.version,
      });
    }

    const result = { dryRun: false, changedCount: items.length, items };
    await setIdempotent(
      tx,
      actor,
      "transaction_template.bulk_edit",
      parsed.idempotencyKey,
      idempotencyPayload,
      result,
    );
    return result;
  });
}

export async function bulkDeleteTransactionTemplates(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<TransactionTemplateBulkResult> {
  const parsed = transactionTemplateBulkDeleteSchema.parse(input);
  const idempotencyPayload = { selection: parsed.selection };
  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "transaction_template.bulk_delete",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<TransactionTemplateBulkResult>(
        tx,
        actor,
        "transaction_template.bulk_delete",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return transactionTemplateBulkResultSchema.parse(existing);
    }
    await lockTransactionTemplateNamespace(tx, actor);
    const rows = await lockSelectedTemplates(tx, actor, parsed.selection);
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
    }));
    if (parsed.dryRun) {
      return { dryRun: true, changedCount: items.length, items };
    }

    // Before the delete: the reminders go with the templates, so afterwards
    // there is nothing left to record.
    const reminders = await readNotifications(
      tx,
      actor,
      rows.map((row) => row.id),
    );
    await tx.delete(transactionTemplates).where(
      and(
        eq(transactionTemplates.userId, actor.userId),
        inArray(
          transactionTemplates.id,
          rows.map((row) => row.id),
        ),
      ),
    );
    for (const row of rows) {
      await writeAudit(tx, actor, {
        entityType: "transaction_template",
        entityId: row.id,
        operation: "bulk_delete",
        before: templateView(row, reminders.get(row.id) ?? null),
      });
    }

    const result = { dryRun: false, changedCount: items.length, items };
    await setIdempotent(
      tx,
      actor,
      "transaction_template.bulk_delete",
      parsed.idempotencyKey,
      idempotencyPayload,
      result,
    );
    return result;
  });
}

export async function listTransactionTemplates(actor: Actor) {
  const db = getDb();
  // Aggregated before the join rather than counted across it: `count(*)` over a
  // left join reports 1 for a template nothing references, and the product of
  // the two sides when both match.
  const committedUse = db
    .select({
      templateId: transactions.templateId,
      total: sql<number>`count(*)::int`.as("committed_count"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        sql`${transactions.deletedAt} is null`,
        sql`${transactions.templateId} is not null`,
      ),
    )
    .groupBy(transactions.templateId)
    .as("committed_use");
  const stagedUse = db
    .select({
      templateId: sql<string>`${stagedTransactions.draft} ->> 'templateId'`.as(
        "staged_template_id",
      ),
      total: sql<number>`count(*)::int`.as("staged_count"),
    })
    .from(stagedTransactions)
    .where(
      and(
        // A draft names its template as free JSON that nothing constrains, so
        // without this somebody else's staged row could be counted here.
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        sql`jsonb_typeof(${stagedTransactions.draft} -> 'templateId') = 'string'`,
      ),
    )
    .groupBy(sql`${stagedTransactions.draft} ->> 'templateId'`)
    .as("staged_use");

  const rows = await db
    .select({
      ...getTableColumns(transactionTemplates),
      transactionCount: sql<number>`coalesce(${committedUse.total}, 0)::int`,
      stagedTransactionCount: sql<number>`coalesce(${stagedUse.total}, 0)::int`,
    })
    .from(transactionTemplates)
    .leftJoin(committedUse, eq(committedUse.templateId, transactionTemplates.id))
    // The id is cast to text rather than the draft to uuid. Casting the other
    // way raises on the first draft holding something that is not a uuid, and
    // staging accepts those on purpose.
    .leftJoin(stagedUse, sql`${stagedUse.templateId} = ${transactionTemplates.id}::text`)
    .where(eq(transactionTemplates.userId, actor.userId))
    .orderBy(transactionTemplates.name);

  // A second query rather than a third join. Templates are capped per person, so
  // this reads a bounded handful of rows once, where joining a fourth table onto
  // two aggregates for a value most templates do not have costs every list.
  const notifications = await db
    .select()
    .from(templateNotifications)
    .where(eq(templateNotifications.userId, actor.userId));
  const byTemplate = new Map(notifications.map((row) => [row.templateId, row]));

  return rows.map((row) => {
    const transactionCount = Number(row.transactionCount);
    const stagedTransactionCount = Number(row.stagedTransactionCount);
    return {
      ...templateView(row, byTemplate.get(row.id) ?? null),
      transactionCount,
      stagedTransactionCount,
      totalTransactionCount: transactionCount + stagedTransactionCount,
    };
  });
}

export async function getTransactionTemplate(actor: Actor, id: string) {
  const [row] = await getDb()
    .select()
    .from(transactionTemplates)
    .where(and(eq(transactionTemplates.id, id), eq(transactionTemplates.userId, actor.userId)))
    .limit(1);
  if (!row) throw notFound("Template not found");
  const [notification] = await getDb()
    .select()
    .from(templateNotifications)
    .where(eq(templateNotifications.templateId, row.id))
    .limit(1);
  return templateView(row, notification ?? null);
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
    const notification = await writeNotification(
      tx,
      actor,
      created.id,
      parsed.notification ?? null,
    );
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: created.id,
      operation: "create",
      after: templateView(created, notification),
    });
    return templateView(created, notification);
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
      .where(and(eq(transactionTemplates.id, id), eq(transactionTemplates.userId, actor.userId)))
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
    const beforeNotification = (await readNotifications(tx, actor, [id])).get(id) ?? null;
    const notification = await writeNotification(tx, actor, id, changes.notification);
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
      before: templateView(before, beforeNotification),
      after: templateView(updated, notification),
    });
    return templateView(updated, notification);
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
      .where(and(eq(transactionTemplates.id, id), eq(transactionTemplates.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Template not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    const reminder = (await readNotifications(tx, actor, [id])).get(id) ?? null;
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
      before: templateView(before, reminder),
    });
    return { id, deleted: true };
  });
}
