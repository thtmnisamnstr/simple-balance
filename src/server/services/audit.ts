import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { cursorInstant, decodeCursor, encodeCursor } from "./cursor.js";

export async function listAuditEvents(
  actor: Actor,
  options: { cursor?: string; limit?: number } = {},
) {
  // `?? 50` does not catch a limit that parsed to NaN, and Math.min/max carry
  // NaN straight through to the query, where it becomes a 500 rather than the
  // default the caller expected.
  const requested = Number.isFinite(options.limit) ? options.limit! : 50;
  const limit = Math.min(Math.max(Math.trunc(requested), 1), 200);
  const cursor = options.cursor
    ? decodeCursor(options.cursor, { key: "created", direction: "desc" })
    : null;
  const resumeFrom = cursor ? cursorInstant(cursor) : null;
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, actor.userId),
        cursor
          ? or(
              lt(auditEvents.createdAt, resumeFrom!),
              and(eq(auditEvents.createdAt, resumeFrom!), lt(auditEvents.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor({
          key: "created",
          direction: "desc",
          sort: items.at(-1)!.createdAt.toISOString(),
          id: items.at(-1)!.id,
        })
      : null,
  };
}
