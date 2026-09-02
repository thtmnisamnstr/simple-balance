import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/server/services/cursor.js";

const ordering = { key: "date", direction: "desc" } as const;

describe("opaque pagination cursors", () => {
  it("round-trips the composite sort key", () => {
    const value = {
      ...ordering,
      sort: "2026-07-30T12:34:56.000Z",
      id: "11111111-1111-4111-8111-111111111111",
    };
    expect(decodeCursor(encodeCursor(value), ordering)).toEqual(value);
  });

  it("rejects malformed client input", () => {
    expect(() => decodeCursor("not-a-cursor", ordering)).toThrow(/Cursor is invalid/);
  });

  // A cursor marks a place in one particular order. Resuming it under another
  // order would silently skip or repeat rows, so it is refused instead.
  it("refuses a cursor issued for a different column", () => {
    const cursor = encodeCursor({
      key: "payee",
      direction: "desc",
      sort: "acme",
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(() => decodeCursor(cursor, ordering)).toThrow(/different sort order/);
  });

  it("refuses a cursor issued for the opposite direction", () => {
    const cursor = encodeCursor({
      key: "date",
      direction: "asc",
      sort: "2026-07-30",
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(() => decodeCursor(cursor, ordering)).toThrow(/different sort order/);
  });
});
