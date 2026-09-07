import { and, desc, eq, lt, or } from "drizzle-orm";
import { auditListQuerySchema, type Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { cursorInstant, decodeCursor, encodeCursor } from "./cursor.js";

export async function listAuditEvents(actor: Actor, input: unknown = {}) {
  // Parsed here rather than at each transport, which is where the bound used to
  // live twice: HTTP handed this a hand-read `Number(...)` that could be NaN and
  // the tool declared its own inline shape, so the clamp below was a second
  // defence for a value the other caller had already bounded.
  const options = auditListQuerySchema.parse(input);
  const limit = options.limit;
  // No filter fingerprint: the audit log takes `cursor` and `limit` and nothing
  // that narrows what it walks. A filter added to `auditListQuerySchema` needs
  // `collectionFingerprint(options)` passed here and to `encodeCursor` below.
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
