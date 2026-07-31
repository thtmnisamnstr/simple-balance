import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

export async function listAuditEvents(
  actor: Actor,
  options: { cursor?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, actor.userId),
        cursor
          ? or(
              lt(auditEvents.createdAt, new Date(cursor.sort)),
              and(
                eq(auditEvents.createdAt, new Date(cursor.sort)),
                lt(auditEvents.id, cursor.id),
              ),
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
          sort: items.at(-1)!.createdAt.toISOString(),
          id: items.at(-1)!.id,
        })
      : null,
  };
}
