import { z } from "zod";
import { sortDirections } from "../../shared/domain.js";
import { validationError } from "./errors.js";

/**
 * A cursor walks one specific ordering. It carries the column and direction it
 * was issued for so that changing the sort cannot silently resume from a
 * boundary that means something else in the new order.
 */
const cursorSchema = z.object({
  /** Which column the ordering is on: "date", "payee", "amount". */
  key: z.string().min(1),
  direction: z.enum(sortDirections),
  /**
   * The boundary VALUE in that column — the last row's date, payee or amount —
   * not the column's name. The two live one line apart and read alike, so they
   * are named apart here: `key` is what is being ordered by, `sort` is where the
   * walk got to.
   */
  sort: z.string(),
  id: z.string().uuid(),
});

export type CursorValue = z.infer<typeof cursorSchema>;

export function encodeCursor(value: CursorValue) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string,
  expected: { key: string; direction: string },
): CursorValue {
  let parsed: CursorValue;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw validationError("Cursor is invalid");
  }
  if (parsed.key !== expected.key || parsed.direction !== expected.direction) {
    throw validationError(
      "This cursor belongs to a different sort order. Start again from the first page.",
      { cursorSort: parsed.key, cursorDirection: parsed.direction },
    );
  }
  return parsed;
}

/**
 * The moment a cursor is resuming from.
 *
 * A cursor is a value the caller hands back, so its contents are as untrusted
 * as anything else they send. Passing an unparseable one straight to a Date or
 * to a PostgreSQL cast turns a typo into a 500 that says nothing; this makes it
 * the same "start again from the first page" answer as any other bad cursor.
 */
export function cursorInstant(cursor: CursorValue) {
  const instant = new Date(cursor.sort);
  if (Number.isNaN(instant.getTime())) {
    throw validationError("Cursor is invalid");
  }
  return instant;
}
