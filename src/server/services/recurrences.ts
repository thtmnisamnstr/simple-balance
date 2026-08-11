import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor, RecurrenceShape, ValidationIssue } from "../../shared/domain.js";
import {
  MAX_RECURRENCES,
  recurrenceCreateSchema,
  recurrenceScheduleSchema,
  recurrenceShapeSchema,
  recurrenceUpdateSchema,
} from "../../shared/domain.js";
import {
  addDays,
  laterOf,
  nextOccurrenceAfter,
  occurrencesBetween,
  todayIn,
  type RecurrenceRule,
} from "../../shared/recurrence-dates.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  categories,
  ledgerAccounts,
  recurrences,
  stagedTransactions,
  type RecurrenceRow,
} from "../db/schema.js";
import { conflict, duplicate, notFound, staleVersion } from "./errors.js";
import { lockRecurrenceNamespace, serializeRow, writeAudit } from "./helpers.js";
import { getPreferences } from "./preferences.js";
import { insertRecurringStages } from "./staging.js";

/** The schedule as the date arithmetic wants it. */
export function ruleOf(row: RecurrenceRow): RecurrenceRule {
  return {
    frequency: row.frequency,
    interval: row.interval,
    anchorDate: row.anchorDate,
    monthPolicy: row.monthPolicy,
    weekendPolicy: row.weekendPolicy,
    position:
      row.positionOrdinal === null || row.positionWeekday === null
        ? null
        : {
            ordinal: row.positionOrdinal as 1 | 2 | 3 | 4 | -1,
            weekday: row.positionWeekday,
          },
  };
}

/**
 * The watermark the next occurrence is measured from, exclusive.
 *
 * Two things push it forward and they answer different questions: what has
 * already been decided, and how far back this recurrence may reach at all.
 * Keeping them in separate columns is what lets "has never run" stay a null
 * check while a backfill stays impossible.
 */
export function scheduleCursor(
  row: Pick<RecurrenceRow, "proposesFrom" | "lastOccurrenceDate">,
) {
  const floor = addDays(row.proposesFrom, -1);
  return row.lastOccurrenceDate ? laterOf(row.lastOccurrenceDate, floor) : floor;
}

/** The only expression that ever writes `next_occurrence_date`. */
export function nextOccurrenceDateFor(row: RecurrenceRow) {
  return nextOccurrenceAfter(ruleOf(row), scheduleCursor(row)).occurrenceDate;
}

/**
 * The references this shape names that no longer resolve, as row issues.
 *
 * The queue already flags an unavailable account, so the row is proposed either
 * way. Two things that path cannot do: it flattens the ledger's refusal into
 * one issue against `draft` and loses which field was at fault, and when the
 * recurrence carries no amount the draft fails its schema parse before the
 * ledger is consulted at all, so a dead account would stay invisible behind a
 * missing number. Both matter most here, because nobody was watching when this
 * fired and the row itself has to say what to fix.
 */
async function recurrenceReferenceIssues(
  tx: DbTransaction,
  actor: Actor,
  shape: RecurrenceShape,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const sides = (["fromAccountId", "toAccountId"] as const)
    .map((field) => ({ field, id: (shape as Record<string, unknown>)[field] }))
    .filter(
      (side): side is { field: "fromAccountId" | "toAccountId"; id: string } =>
        typeof side.id === "string",
    );
  if (sides.length) {
    const rows = await tx
      .select({ id: ledgerAccounts.id, archivedAt: ledgerAccounts.archivedAt })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.userId, actor.userId),
          inArray(
            ledgerAccounts.id,
            sides.map((side) => side.id),
          ),
          sql`${ledgerAccounts.systemKind} is null`,
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const side of sides) {
      const account = byId.get(side.id);
      if (!account) {
        issues.push({
          field: side.field,
          message: "This recurrence names an account that no longer exists",
        });
      } else if (account.archivedAt) {
        issues.push({
          field: side.field,
          message: "This recurrence names an archived account",
        });
      }
    }
  }

  const named = [
    { field: "categoryId", id: shape.categoryId },
    ...(shape.legs ?? []).map((leg, index) => ({
      field: `legs.${index}.categoryId`,
      id: leg.categoryId,
    })),
  ].filter((one): one is { field: string; id: string } => typeof one.id === "string");
  if (named.length) {
    const rows = await tx
      .select({ id: categories.id, archivedAt: categories.archivedAt })
      .from(categories)
      .where(
        and(
          eq(categories.userId, actor.userId),
          inArray(
            categories.id,
            named.map((one) => one.id),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const one of named) {
      const category = byId.get(one.id);
      if (!category) {
        issues.push({
          field: one.field,
          message: "This recurrence names a category that no longer exists",
        });
      } else if (category.archivedAt) {
        issues.push({
          field: one.field,
          message: "This recurrence names an archived category",
        });
      }
    }
  }
  return issues;
}

/**
 * The stale id stays in the draft. Rewriting it out would hide from the person
 * what their rule actually says, which is the thing they have to correct.
 */
function draftFor(shape: RecurrenceShape, postedDate: string) {
  const { amount, ...rest } = shape as RecurrenceShape & { amount?: string };
  const draft: Record<string, unknown> =
    shape.type === "transfer"
      ? { ...rest, date: postedDate, sourceAmount: amount }
      : { ...rest, date: postedDate, amount };
  // A key present and undefined is a key the JSON column keeps as null, which
  // reads as "saved as nothing" rather than "not saved".
  for (const [key, value] of Object.entries(draft)) {
    if (value === undefined) delete draft[key];
  }
  return draft;
}

const MISSING_AMOUNT_ISSUE: ValidationIssue = {
  field: "amount",
  message: "This recurrence does not set an amount. Fill one in before committing.",
};

export type RecurrenceTickOutcome = "proposed" | "nothing_due" | "gone" | "capped";

/**
 * Decide everything this recurrence owes up to `today`, in one transaction.
 *
 * One transaction per recurrence, never one for a whole tick. It keeps the
 * write set bounded on a one-connection deployment, it lets somebody's edit
 * land between two recurrences rather than behind all of them, and it keeps one
 * transaction to one tenant, which the payee canonicalisation cache requires
 * because it is keyed by transaction and normalised name with no user in it.
 */
export async function proposeDueOccurrences(
  actor: Actor,
  recurrenceId: string,
  today: string,
  limit: number,
): Promise<RecurrenceTickOutcome> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(recurrences)
      .where(
        and(eq(recurrences.id, recurrenceId), eq(recurrences.userId, actor.userId)),
      )
      .for("update");
    if (!row) return "gone";

    const occurrences = occurrencesBetween(
      ruleOf(row),
      scheduleCursor(row),
      today,
      limit,
    );
    if (!occurrences.length) return "nothing_due";

    const shape = recurrenceShapeSchema.parse(row.shape);
    const proposable = occurrences.filter((one) => one.postedDate !== null);
    if (proposable.length) {
      const referenceIssues = await recurrenceReferenceIssues(tx, actor, shape);
      const initialIssues =
        (shape as { amount?: string }).amount === undefined
          ? [MISSING_AMOUNT_ISSUE, ...referenceIssues]
          : referenceIssues;
      await insertRecurringStages(
        tx,
        actor,
        proposable.map((one) => ({
          draft: draftFor(shape, one.postedDate!),
          // The name is the only thing here the columns cannot keep, and it is
          // what a proposed row still knows after its recurrence is deleted.
          rawData: {
            recurrence: {
              recurrenceId: row.id,
              recurrenceName: row.name,
              occurrenceDate: one.occurrenceDate,
            },
          },
          recurrenceId: row.id,
          occurrenceDate: one.occurrenceDate,
          initialIssues: initialIssues.length ? initialIssues : undefined,
        })),
      );
    }

    const lastOccurrenceDate = occurrences.at(-1)!.occurrenceDate;
    await tx
      .update(recurrences)
      .set({
        lastOccurrenceDate,
        nextOccurrenceDate: nextOccurrenceDateFor({ ...row, lastOccurrenceDate }),
        // The version is the token somebody's edit is checked against. A tick
        // advancing a watermark is not a change to what they configured, and
        // bumping it would make every open form stale for a reason nobody can
        // see. The row lock above is what keeps the two apart.
        updatedAt: new Date(),
      })
      .where(and(eq(recurrences.id, row.id), eq(recurrences.userId, actor.userId)));

    return occurrences.length >= limit ? "capped" : "proposed";
  });
}

async function assertNameAvailable(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const rows = await tx
    .select({ id: recurrences.id, name: recurrences.name })
    .from(recurrences)
    .where(eq(recurrences.userId, actor.userId));
  const clash = rows.find(
    (row) =>
      row.id !== excludeId &&
      row.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (clash) {
    throw duplicate("A recurrence with this name already exists", {
      recurrenceId: clash.id,
    });
  }
}

/**
 * A recurrence may keep an account that was archived after it was made, but it
 * may never be created naming one that is not this person's.
 */
async function assertReferencesAreOwned(
  tx: DbTransaction,
  actor: Actor,
  shape: RecurrenceShape,
) {
  const accountIds = (["fromAccountId", "toAccountId"] as const)
    .map((field) => (shape as Record<string, unknown>)[field])
    .filter((id): id is string => typeof id === "string");
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
    if (accountIds.some((id) => !found.has(id))) {
      throw notFound("That account is not one of yours");
    }
  }
  const categoryIds = [
    shape.categoryId,
    ...(shape.legs ?? []).map((leg) => leg.categoryId),
  ].filter((id): id is string => typeof id === "string");
  if (categoryIds.length) {
    const owned = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.userId, actor.userId), inArray(categories.id, categoryIds)),
      );
    const found = new Set(owned.map((row) => row.id));
    if (categoryIds.some((id) => !found.has(id))) {
      throw notFound("That category is not one of yours");
    }
  }
}

const scheduleColumns = (schedule: {
  frequency: RecurrenceRow["frequency"];
  interval: number;
  anchorDate: string;
  monthPolicy: RecurrenceRow["monthPolicy"];
  weekendPolicy: RecurrenceRow["weekendPolicy"];
  position?: { ordinal: number; weekday: number } | null;
}) => ({
  frequency: schedule.frequency,
  interval: schedule.interval,
  anchorDate: schedule.anchorDate,
  monthPolicy: schedule.monthPolicy,
  weekendPolicy: schedule.weekendPolicy,
  positionOrdinal: schedule.position?.ordinal ?? null,
  positionWeekday: schedule.position?.weekday ?? null,
});

function recurrenceRowView(row: RecurrenceRow) {
  return { ...serializeRow(row), shape: row.shape as RecurrenceShape };
}

export async function createRecurrence(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = recurrenceCreateSchema.parse(input);
  const { timezone } = await getPreferences(actor);
  const proposesFrom = todayIn(timezone);
  return withTransaction(transaction, async (tx) => {
    await lockRecurrenceNamespace(tx, actor);
    await assertNameAvailable(tx, actor, parsed.name);
    await assertReferencesAreOwned(tx, actor, parsed.shape);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(recurrences)
      .where(eq(recurrences.userId, actor.userId));
    if (count >= MAX_RECURRENCES) {
      throw conflict(
        `You can keep ${MAX_RECURRENCES} recurrences. Delete one you no longer use to make room.`,
        { limit: MAX_RECURRENCES, current: count },
      );
    }
    const columns = scheduleColumns(parsed.schedule);
    const seed = { ...columns, proposesFrom, lastOccurrenceDate: null } as RecurrenceRow;
    const [created] = await tx
      .insert(recurrences)
      .values({
        userId: actor.userId,
        name: parsed.name,
        shape: parsed.shape,
        ...columns,
        proposesFrom,
        lastOccurrenceDate: null,
        nextOccurrenceDate: nextOccurrenceDateFor(seed),
      })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "recurrence",
      entityId: created.id,
      operation: "create",
      after: recurrenceRowView(created),
    });
    return recurrenceRowView(created);
  });
}

export async function updateRecurrence(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const changes = recurrenceUpdateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockRecurrenceNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(recurrences)
      .where(and(eq(recurrences.id, id), eq(recurrences.userId, actor.userId)))
      .for("update");
    if (!before) throw notFound("Recurrence not found");
    if (before.version !== changes.expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    if (changes.name !== undefined) {
      await assertNameAvailable(tx, actor, changes.name, id);
    }
    if (changes.shape !== undefined) {
      await assertReferencesAreOwned(tx, actor, changes.shape);
    }
    // Merged onto what is stored and re-parsed, so leaving a field out keeps
    // it and every refusal the full schema makes still applies to the result.
    const schedule = recurrenceScheduleSchema.parse({
      frequency: changes.schedule?.frequency ?? before.frequency,
      interval: changes.schedule?.interval ?? before.interval,
      anchorDate: changes.schedule?.anchorDate ?? before.anchorDate,
      monthPolicy: changes.schedule?.monthPolicy ?? before.monthPolicy,
      weekendPolicy: changes.schedule?.weekendPolicy ?? before.weekendPolicy,
      position:
        changes.schedule?.position !== undefined
          ? changes.schedule.position
          : before.positionOrdinal === null || before.positionWeekday === null
            ? null
            : { ordinal: before.positionOrdinal, weekday: before.positionWeekday },
    });
    const columns = scheduleColumns(schedule);
    // proposes_from is deliberately untouched. It is how far back this was ever
    // allowed to reach, and an edit today must not conjure rows for months
    // already dealt with.
    const [updated] = await tx
      .update(recurrences)
      .set({
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.shape !== undefined ? { shape: changes.shape } : {}),
        ...columns,
        nextOccurrenceDate: nextOccurrenceDateFor({
          ...before,
          ...columns,
        } as RecurrenceRow),
        version: changes.expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recurrences.id, id),
          eq(recurrences.userId, actor.userId),
          eq(recurrences.version, changes.expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "recurrence",
      entityId: id,
      operation: "update",
      before: recurrenceRowView(before),
      after: recurrenceRowView(updated),
    });
    return recurrenceRowView(updated);
  });
}

/**
 * A hard delete. Nothing points at this table, so nothing cascades, and every
 * row it already proposed keeps its recurrence id, its occurrence date and the
 * recurrence's name in `rawData`.
 */
export async function deleteRecurrence(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(recurrences)
      .where(and(eq(recurrences.id, id), eq(recurrences.userId, actor.userId)))
      .for("update");
    if (!before) throw notFound("Recurrence not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    await tx
      .delete(recurrences)
      .where(and(eq(recurrences.id, id), eq(recurrences.userId, actor.userId)));
    await writeAudit(tx, actor, {
      entityType: "recurrence",
      entityId: id,
      operation: "delete",
      before: recurrenceRowView(before),
    });
    return { id };
  });
}

type RecurrenceCounts = { proposed: number; committed: number; discarded: number };
const NO_COUNTS: RecurrenceCounts = { proposed: 0, committed: 0, discarded: 0 };

/**
 * What a recurrence has done, and what it will do next.
 *
 * `nextOccurrence` is recomputed from the rule rather than read from the cached
 * column, so a cache that drifted shows up as a recurrence overdue with nothing
 * proposed, which is visible, rather than as a wrong date on a page, which is
 * not. `overdue` is built on the occurrence date and never the posted one, so a
 * recurrence whose next instance a policy will skip still reports overdue when
 * the scheduler has stopped.
 */
function recurrenceView(row: RecurrenceRow, counts: RecurrenceCounts, today: string) {
  const next = nextOccurrenceAfter(ruleOf(row), scheduleCursor(row));
  return {
    ...recurrenceRowView(row),
    nextOccurrence: next,
    overdue: next.occurrenceDate < today,
    proposedCount: counts.proposed,
    committedCount: counts.committed,
    discardedCount: counts.discarded,
  };
}

/** Aggregated before any join, so a recurrence nothing references reports zero. */
async function countsByRecurrence(actor: Actor) {
  const rows = await getDb()
    .select({
      recurrenceId: stagedTransactions.recurrenceId,
      proposed: sql<number>`count(*) filter (where ${stagedTransactions.status} = 'staged')::int`,
      committed: sql<number>`count(*) filter (where ${stagedTransactions.status} = 'committed')::int`,
      discarded: sql<number>`count(*) filter (where ${stagedTransactions.status} = 'deleted')::int`,
    })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        sql`${stagedTransactions.recurrenceId} is not null`,
      ),
    )
    .groupBy(stagedTransactions.recurrenceId);
  return new Map(
    rows.map((row) => [
      row.recurrenceId!,
      { proposed: row.proposed, committed: row.committed, discarded: row.discarded },
    ]),
  );
}

export async function listRecurrences(actor: Actor) {
  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  const [rows, counts] = await Promise.all([
    getDb()
      .select()
      .from(recurrences)
      .where(eq(recurrences.userId, actor.userId))
      .orderBy(recurrences.name),
    countsByRecurrence(actor),
  ]);
  return {
    today,
    items: rows.map((row) =>
      recurrenceView(row, counts.get(row.id) ?? NO_COUNTS, today),
    ),
  };
}

export async function getRecurrence(actor: Actor, id: string) {
  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  const [row] = await getDb()
    .select()
    .from(recurrences)
    .where(and(eq(recurrences.id, id), eq(recurrences.userId, actor.userId)))
    .limit(1);
  if (!row) throw notFound("Recurrence not found");
  const counts = await countsByRecurrence(actor);
  return recurrenceView(row, counts.get(row.id) ?? NO_COUNTS, today);
}

export type RecurrenceView = Awaited<ReturnType<typeof getRecurrence>>;
