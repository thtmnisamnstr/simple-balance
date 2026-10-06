import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { auditListQuerySchema, type Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { cursorInstant, decodeCursor, encodeCursor, instantMarker } from "./cursor.js";

export async function listAuditEvents(actor: Actor, input: unknown = {}) {
  // Parsed here rather than at each transport, which is where the bound used to
  // live twice: HTTP handed this a hand-read `Number(...)` that could be NaN and
  // the tool declared its own inline shape, so the clamp below was a second
  // defense for a value the other caller had already bounded.
  const options = auditListQuerySchema.parse(input);
  const limit = options.limit;
  // No filter fingerprint: the audit log takes `cursor` and `limit` and nothing
  // that narrows what it walks. A filter added to `auditListQuerySchema` needs
  // `collectionFingerprint(options)` passed here and to `encodeCursor` below.
  const cursor = options.cursor
    ? decodeCursor(options.cursor, { key: "created", direction: "desc" })
    : null;
  // Read for the refusal a marker that is not a date earns, and no further: the
  // comparison below takes the marker's own text, to the microsecond.
  if (cursor) cursorInstant(cursor);
  const rows = await getDb()
    .select({
      ...getTableColumns(auditEvents),
      // The instant to the microsecond, as the column holds it. Every event a
      // transaction writes takes its `now()`, one instant for the lot, and a
      // CSV import writes one per row; a marker written from a JavaScript date
      // kept only the millisecond, so the next page asked for rows earlier than
      // a moment the whole group was later than, and a page boundary inside an
      // import skipped the rest of it.
      cursorSort: instantMarker(auditEvents.createdAt),
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, actor.userId),
        // A row comparison, which `audit_user_created_idx` can start a scan
        // at. The OR it replaces read every newer row and discarded it, so the
        // hundredth page cost a hundred pages. A marker issued before this was
        // a millisecond date, which still reads as a timestamp here.
        cursor
          ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((row) => {
    const { cursorSort: _cursorSort, ...event } = row;
    return event;
  });
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor({
          key: "created",
          direction: "desc",
          sort: page.at(-1)!.cursorSort,
          id: page.at(-1)!.id,
        })
      : null,
  };
}
