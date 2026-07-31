import { z } from "zod";
import { validationError } from "./errors.js";

const cursorSchema = z.object({
  sort: z.string().min(1),
  id: z.string().uuid(),
});

export type CursorValue = z.infer<typeof cursorSchema>;

export function encodeCursor(value: CursorValue) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value: string): CursorValue {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw validationError("Cursor is invalid");
  }
}
