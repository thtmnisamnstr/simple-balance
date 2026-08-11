import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { MAX_BULK_SELECTION_ENTRIES, type Actor } from "../../shared/domain.js";
import type { Database, DbTransaction } from "../db/client.js";
import { auditEvents, idempotencyRecords } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { conflict } from "./errors.js";

export type Executor = Database | DbTransaction;

// A stored numeric(44,18) can carry 44 significant digits. Intermediate
// operations need additional headroom: in particular, an FX quotient may have
// up to 44 integer digits before it is rejected as unstoreable and still needs
// 18 fractional digits to be rounded correctly.
Decimal.set({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
});

export const decimal = (value: string | Decimal) => new Decimal(value);

export function canonicalDecimal(value: string | Decimal): string {
  const result = decimal(value).toFixed(18).replace(/\.?0+$/, "");
  return result === "-0" ? "0" : result;
}

export async function writeAudit(
  tx: DbTransaction,
  actor: Actor,
  event: {
    entityType: string;
    entityId: string;
    operation: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.insert(auditEvents).values({
    userId: actor.userId,
    actorSource: actor.source,
    clientId: actor.clientId,
    entityType: event.entityType,
    entityId: event.entityId,
    operation: event.operation,
    before: event.before ?? null,
    after: event.after ?? null,
  });
}

/**
 * Write many audit events in one statement.
 *
 * A CSV import records one event per staged row. Sent one at a time that is a
 * round trip per row on top of the insert it describes, which is half the
 * write cost of an import for no benefit: they all land in the same
 * transaction and either commit together or not at all.
 */
export async function writeAuditMany(
  tx: DbTransaction,
  actor: Actor,
  events: readonly {
    entityType: string;
    entityId: string;
    operation: string;
    before?: unknown;
    after?: unknown;
  }[],
) {
  if (!events.length) return;
  const CHUNK = 500;
  for (let start = 0; start < events.length; start += CHUNK) {
    await tx.insert(auditEvents).values(
      events.slice(start, start + CHUNK).map((event) => ({
        userId: actor.userId,
        actorSource: actor.source,
        clientId: actor.clientId,
        entityType: event.entityType,
        entityId: event.entityId,
        operation: event.operation,
        before: event.before ?? null,
        after: event.after ?? null,
      })),
    );
  }
}

export async function getIdempotent<T>(
  tx: DbTransaction,
  actor: Actor,
  operation: string,
  key: string,
  requestPayload: unknown,
): Promise<T | null> {
  const [record] = await tx
    .select({
      requestHash: idempotencyRecords.requestHash,
      response: idempotencyRecords.response,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.userId, actor.userId),
        eq(idempotencyRecords.operation, operation),
        eq(idempotencyRecords.key, key),
      ),
    )
    .limit(1);
  if (
    record &&
    record.requestHash !== idempotencyRequestHash(requestPayload)
  ) {
    throw conflict(
      "This idempotency key was already used with a different request",
      { operation },
    );
  }
  return (record?.response as T | undefined) ?? null;
}

function canonicalizeRequestPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Idempotency payload numbers must be finite");
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeRequestPayload(item) ?? null);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, item]) => [key, canonicalizeRequestPayload(item)]),
    );
  }
  throw new TypeError(`Unsupported idempotency payload value: ${typeof value}`);
}

export function idempotencyRequestHash(requestPayload: unknown): string {
  const canonicalPayload = JSON.stringify(
    canonicalizeRequestPayload(requestPayload),
  );
  if (canonicalPayload === undefined) {
    throw new TypeError("Idempotency payload must be JSON serializable");
  }
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

/**
 * Serialize an idempotent operation before reading its stored response.
 *
 * The operation name deliberately matches the domain operation used by MCP's
 * outer idempotency record. PostgreSQL transaction advisory locks are
 * reentrant, so an MCP mutation and the service it calls may safely acquire the
 * same key on the same transaction.
 */
export async function lockIdempotencyKey(
  tx: DbTransaction,
  actor: Actor,
  operation: string,
  key: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${operation}:${key}`}, 0))`,
  );
}

/**
 * Which advisory locks a transaction has already taken.
 *
 * These are xact locks: PostgreSQL holds them until commit and taking one twice
 * in the same transaction does nothing. Asking again was therefore a round trip
 * that could only ever return immediately, which is invisible on one row and
 * expensive on twelve thousand: a CSV import re-took the same account, category
 * and payee locks for every row it staged.
 *
 * Keyed on the transaction object itself, so the memo cannot outlive it or leak
 * into another one.
 */
const locksHeld = new WeakMap<object, Set<string>>();

async function takeTransactionLock(tx: DbTransaction, lockKey: string) {
  let held = locksHeld.get(tx as object);
  if (!held) {
    held = new Set();
    locksHeld.set(tx as object, held);
  }
  if (held.has(lockKey)) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
  held.add(lockKey);
}

/**
 * A search box's text as a LIKE pattern that means what was typed.
 *
 * `%` and `_` are wildcards to PostgreSQL and ordinary characters to whoever
 * typed them. Interpolating raw text turns a search for "50% off" into one that
 * matches every row with "50" then anything then " off", and a search for a
 * single `%` into a full scan that matches the whole table. Backslash is
 * escaped first because it is the escape character itself.
 */
export function likePattern(search: string) {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * The one sentence every path that refuses an oversized set says.
 *
 * The cap is the same everywhere on purpose. A person who has met it on a mass
 * edit should not have to discover a different number on an import or a mass
 * delete, and a caller that has to split its work should be able to split it
 * the same way each time.
 */
export function exceedsBulkSelectionCap(noun: string) {
  return (
    `That covers more than ${MAX_BULK_SELECTION_ENTRIES.toLocaleString("en-US")} ${noun}, ` +
    "which is the most one request may change at a time. Narrow it and repeat."
  );
}

/**
 * One `id:version` fingerprint for a selected set, whatever kind of row it is.
 *
 * The fingerprint is what a mass change describes its set with, and the
 * transaction and staged paths have to agree on it byte for byte: two spellings
 * of the same hash is a way for one of them to drift and start accepting a set
 * the other would refuse.
 */
export function selectionFingerprint(
  rows: readonly { id: string; version: number }[],
) {
  const payload = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => `${row.id}:${row.version}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Serialize mutations involving account references that cannot all be
 * represented by foreign keys (notably staged JSON drafts). Always acquire all
 * account locks in sorted order before acquiring the category namespace lock,
 * then the payee namespace lock.
 */
export async function lockAccountReferences(
  tx: DbTransaction,
  actor: Actor,
  accountIds: readonly string[],
) {
  const sortedIds = [...new Set(accountIds)].sort();
  for (const accountId of sortedIds) {
    await takeTransactionLock(tx, `account-reference:${actor.userId}:${accountId}`);
  }
}

export async function lockCategoryNamespace(
  tx: DbTransaction,
  actor: Actor,
) {
  await takeTransactionLock(tx, `categories:${actor.userId}`);
}

/**
 * Serialize changes to the tenant's template names, which are compared the way
 * category names are and so need the same protection against two requests each
 * finding the name free. Taken last of all the namespace locks, because nothing
 * else ever takes it.
 */
export async function lockTransactionTemplateNamespace(
  tx: DbTransaction,
  actor: Actor,
) {
  await takeTransactionLock(tx, `transaction-templates:${actor.userId}`);
}

/** Serialize changes to the tenant's recurrence names, which are unique. */
export async function lockRecurrenceNamespace(tx: DbTransaction, actor: Actor) {
  await takeTransactionLock(tx, `recurrences:${actor.userId}`);
}

/**
 * Serialize changes to the tenant's derived payee namespace. This lock is
 * distinct from category and account locks because payees have no backing
 * table row that PostgreSQL could lock for us.
 */
export async function lockPayeeNamespace(
  tx: DbTransaction,
  actor: Actor,
) {
  await takeTransactionLock(tx, `payees:${actor.userId}`);
}

export async function setIdempotent(
  tx: DbTransaction,
  actor: Actor,
  operation: string,
  key: string,
  requestPayload: unknown,
  response: unknown,
) {
  await tx.insert(idempotencyRecords).values({
    userId: actor.userId,
    operation,
    key,
    requestHash: idempotencyRequestHash(requestPayload),
    response,
  });
}

export function serializeRow<T>(row: T): T {
  return JSON.parse(
    JSON.stringify(row, (_key, value) => (value instanceof Date ? value.toISOString() : value)),
  ) as T;
}
