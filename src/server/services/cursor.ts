import { z } from "zod";
import { sortDirections } from "../../shared/domain.js";
import { validationError } from "./errors.js";

/**
 * A cursor walks one specific ordering. It carries the column and direction it
 * was issued for so that changing the sort cannot silently resume from a
 * boundary that means something else in the new order.
 */
const cursorSchema = z.object({
  key: z.string().min(1),
  direction: z.enum(sortDirections),
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
    parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
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
