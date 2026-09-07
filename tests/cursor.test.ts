import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/server/services/cursor.js";

const ordering = { key: "date", direction: "desc" } as const;

const value = {
  ...ordering,
  sort: "2026-07-30T12:34:56.000Z",
  id: "11111111-1111-4111-8111-111111111111",
};

/** The encoding as it was before signing: base64url of plain JSON, no MAC. */
const unsigned = (cursor: Record<string, string>) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

describe("opaque pagination cursors", () => {
  it("round-trips the composite sort key", () => {
    expect(decodeCursor(encodeCursor(value), ordering)).toEqual(value);
  });

  it("rejects malformed client input", () => {
    expect(() => decodeCursor("not-a-cursor", ordering)).toThrow(/page marker cannot be read/);
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

/**
 * The signature, which is what makes a cursor refusable rather than validated.
 *
 * AIP-158 wants a page token a client cannot build, and this was base64url of
 * plain JSON — the case that document names as insufficient obfuscation. Signing
 * it does not hide the contents and is not meant to: they are a boundary value
 * and a row id the caller already holds. What it stops is a caller building one,
 * and therefore building against an encoding no invariant protects.
 */
describe("a signed cursor", () => {
  it("carries a MAC that a hand-built cursor cannot forge", () => {
    const cursor = encodeCursor(value);
    expect(cursor).toContain(".");
    const [payload, mac] = cursor.split(".");
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A payload that decodes to a different place, re-signed with nothing.
    const forged = Buffer.from(
      JSON.stringify({ ...value, sort: "2020-01-01T00:00:00.000Z" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(`${forged}.${mac}`, ordering)).toThrow(/page marker cannot be read/);
    // And the real payload with somebody else's MAC.
    expect(() => decodeCursor(`${payload}.${"A".repeat(43)}`, ordering)).toThrow(
      /page marker cannot be read/,
    );
  });

  it("refuses a MAC of the wrong length rather than throwing from the comparison", () => {
    // `timingSafeEqual` throws on a length mismatch instead of returning false,
    // so a truncated MAC has to be refused before it is compared or a forged
    // cursor becomes a 500 rather than a 422.
    const [payload] = encodeCursor(value).split(".");
    for (const mac of ["", "A", "A".repeat(42), "A".repeat(200)]) {
      expect(() => decodeCursor(`${payload}.${mac}`, ordering), JSON.stringify(mac)).toThrow(
        /page marker cannot be read/,
      );
    }
  });

  /**
   * And the previous encoding is still read, for this release only.
   *
   * A cursor is held rather than stored — a browser tab keeps one in component
   * state, an agent may send one back minutes later — so a rolling deploy has a
   * window in which a caller legitimately holds one the previous build issued.
   * Refusing it would narrow a working client's pagination, which is what
   * `AGENTS.md` forbids a release from doing. `docs/upgrades.md` records when
   * this branch goes.
   */
  it("still reads a cursor the previous release issued", () => {
    expect(decodeCursor(unsigned(value), ordering)).toEqual(value);
    // The ordering check still applies to it: being old does not make it
    // resumable under a different sort.
    expect(() => decodeCursor(unsigned({ ...value, key: "payee" }), ordering)).toThrow(
      /different sort order/,
    );
  });

  it("issues only the signed form", () => {
    // Nothing this release hands out is unsigned, which is what makes dropping
    // the branch above a one-release wait rather than an open-ended one.
    expect(encodeCursor(value)).not.toBe(unsigned(value));
    expect(encodeCursor(value).startsWith(`${unsigned(value)}.`)).toBe(true);
  });
});

/**
 * One release, one sunset date.
 *
 * This release deprecates two things — four renamed paths and the unsigned
 * cursor encoding — and an operator should have one date to hold rather than
 * two. The paths publish theirs in a `Sunset` header; the encoding cannot,
 * because the old form arrives inside a request rather than being addressed by
 * one, so its date lives in a comment. A comment and a constant are exactly the
 * pair that comes apart, so this is what holds them together.
 */
describe("what this release deprecates", () => {
  it("names one sunset date across the route header and the cursor comment", async () => {
    const { readFile } = await import("node:fs/promises");
    const api = await readFile("src/server/api.ts", "utf8");
    const cursor = await readFile("src/server/services/cursor.ts", "utf8");
    const sunset = /const RENAMED_PATH_SUNSET = "([^"]+)"/.exec(api);
    expect(sunset, "api.ts should publish a sunset date").not.toBeNull();
    const day = new Date(sunset![1]!);
    expect(Number.isNaN(day.getTime())).toBe(false);
    // The comment writes it the way prose does — "1 March 2027" — rather than
    // as an HTTP date, so the day, month and year are compared rather than the
    // string.
    const spelled = `${day.getUTCDate()} ${day.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${day.getUTCFullYear()}`;
    expect(cursor, `the cursor's window should end on ${spelled}`).toContain(spelled);
  });
});
