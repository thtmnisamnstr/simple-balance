import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/server/services/cursor.js";

describe("opaque pagination cursors", () => {
  it("round-trips the composite sort key", () => {
    const value = {
      sort: "2026-07-30T12:34:56.000Z",
      id: "11111111-1111-4111-8111-111111111111",
    };
    expect(decodeCursor(encodeCursor(value))).toEqual(value);
  });

  it("rejects malformed client input", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(/Cursor is invalid/);
  });
});
