import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Actor } from "../../shared/domain.js";
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
    const lockKey = `account-reference:${actor.userId}:${accountId}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
  }
}

export async function lockCategoryNamespace(
  tx: DbTransaction,
  actor: Actor,
) {
  const lockKey = `categories:${actor.userId}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
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
  const lockKey = `payees:${actor.userId}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
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
