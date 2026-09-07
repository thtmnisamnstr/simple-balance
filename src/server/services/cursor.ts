import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sortDirections } from "../../shared/domain.js";
import { getConfig } from "../config.js";
import { validationError } from "./errors.js";
import { idempotencyRequestHash } from "./helpers.js";

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
  /**
   * A fingerprint of the filters the walk was issued under.
   *
   * A cursor bound its ordering and nothing else, so changing the *sort*
   * between pages was caught and changing a *filter* was not: `accountId`,
   * `payee`, `search`, `start`, `end` and the rest could all move and the
   * keyset resumed silently into a different collection, handing back rows from
   * a query nobody asked for with the count still reporting the truth.
   *
   * A cursor binds the collection it walks, the way a bulk selection binds the
   * rows it changes. Both refuse rather than quietly covering something else.
   *
   * Optional, because a cursor issued before this existed does not carry one
   * and `AGENTS.md` does not let a release narrow a working client. Absent
   * means unbound and is accepted; present and different is refused.
   */
  filters: z.string().optional(),
});

/**
 * Which query keys describe the collection rather than the view of it.
 *
 * Derived by exclusion rather than enumerated, so a filter added to a list
 * schema is bound without anybody remembering to add it here — which is the
 * failure this whole member exists to prevent, one level up. The five excluded
 * are the ones `AGENTS.md` calls presentation: "Order is presentation, so it
 * stays out of the fingerprinted bulk selection filter."
 */
const PRESENTATION = new Set(["sort", "direction", "cursor", "page", "limit"]);

/**
 * The fingerprint of one collection, from the parsed query that defines it.
 *
 * `idempotencyRequestHash` is the canonicaliser this product already has: keys
 * sorted, `undefined` dropped, dates as ISO strings, so two spellings of one
 * query hash alike. Reused rather than reimplemented, because two canonical
 * forms is a way for one of them to drift.
 *
 * Truncated to sixteen hex characters. The payload is signed, so nobody can
 * construct a cursor whose hash matches a collection it did not come from;
 * what is left is accidental collision between two of one person's own filter
 * combinations, and 64 bits is far past enough for that. The rest would be 48
 * characters on every cursor for nothing.
 */
export function collectionFingerprint(query: Record<string, unknown>) {
  const scope = Object.fromEntries(Object.entries(query).filter(([key]) => !PRESENTATION.has(key)));
  return idempotencyRequestHash(scope).slice(0, 16);
}

export type CursorValue = z.infer<typeof cursorSchema>;

/**
 * A key for signing cursors, derived from the deployment's own secret.
 *
 * Derived rather than used directly: `AUTH_SECRET` signs sessions, and a second
 * purpose sharing one key means a weakness in either reaches both. This is the
 * standard subkey construction — HMAC the secret with a label naming what the
 * subkey is for — so the two are independent while there is still only one
 * secret for an operator to set and rotate.
 *
 * Keyed to the deployment and not to the process, which is what makes a cursor
 * issued by one replica readable by another. Rotating `AUTH_SECRET` invalidates
 * every cursor along with every session, and that is the right pairing: a
 * rotation already sends everybody back to a sign-in screen.
 *
 * Computed per call. It is one HMAC over a short string and the cost is
 * invisible beside the database round-trip a page already costs; caching it
 * would mean holding a key derived from configuration that a test may restub.
 */
const signingKey = () =>
  createHmac("sha256", getConfig().authSecret).update("simple-balance/cursor/v1").digest();

const CURSOR_VERSION = "1";

/** The MAC over one encoded payload, as base64url. */
const sign = (payload: string) =>
  createHmac("sha256", signingKey()).update(`${CURSOR_VERSION}.${payload}`).digest("base64url");

/**
 * `<payload>.<mac>`, where the payload is what it has always been.
 *
 * AIP-158 says a page token "must be opaque (but URL-safe) strings, and must not
 * be user-parseable", and names base64-encoding an otherwise-transparent token
 * as insufficient obfuscation — which is exactly what this was. `http.md`
 * records the disagreement and the two acceptable resolutions; this is the
 * first of them.
 *
 * Signed rather than encrypted, deliberately. The contents are a boundary value
 * and a row id the caller already holds, so there is nothing here to keep from
 * them; what mattered was that they could *build* one and would then be building
 * against an encoding no invariant protects. A signed cursor is refusable rather
 * than merely validated, and the reasoning is one thing a reader can check
 * rather than a scheme they have to trust.
 *
 * Costs about seven microseconds to sign and seven to verify, against a page
 * read that costs milliseconds, and adds 44 characters to a cursor whose
 * declared ceiling is 500.
 */
export function encodeCursor(value: CursorValue) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeCursor(
  value: string,
  expected: { key: string; direction: string; filters?: string },
): CursorValue {
  // Unsigned cursors are still read, for this release only.
  //
  // A cursor is not stored anywhere, but it is held: a browser tab keeps one in
  // component state and an agent may send one back minutes later, so a rolling
  // deploy has a window in which a caller legitimately holds a cursor the
  // previous build issued. `AGENTS.md` requires that "every client that worked
  // against it still works", and refusing that cursor would narrow a working
  // client's pagination to "start from page 1". So the older form is accepted
  // here and never issued, the same way a renamed route stays registered under
  // its old spelling.
  //
  // The cost of the window is small and worth stating rather than implying: an
  // unsigned cursor can be hand-built, and what that buys is a different
  // starting boundary inside a query already scoped to the caller's own
  // `userId`. It is not an authorisation boundary — no cursor has ever been one
  // — so the window costs opacity for one release and nothing else.
  //
  // It goes on **1 March 2027**, which is the sunset this release already
  // publishes on the four renamed paths (`RENAMED_PATH_SUNSET` in
  // `src/server/api.ts`). One date for everything deprecated in one release, so
  // an operator has one thing to remember; `http.md`'s deprecation policy asks
  // for one minor release *and* ninety days, and that date clears both.
  const separator = value.lastIndexOf(".");
  let body = value;
  if (separator > 0) {
    body = value.slice(0, separator);
    const mac = value.slice(separator + 1);
    const expectedMac = Buffer.from(sign(body), "utf8");
    const presented = Buffer.from(mac, "utf8");
    // Length first: `timingSafeEqual` throws on a mismatch rather than
    // returning false, and a forged cursor must be refused the same way a
    // mistyped one is.
    if (presented.length !== expectedMac.length || !timingSafeEqual(presented, expectedMac)) {
      throw validationError("This page marker cannot be read. Start again from the first page.");
    }
  }
  let parsed: CursorValue;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    throw validationError("This page marker cannot be read. Start again from the first page.");
  }
  if (parsed.key !== expected.key || parsed.direction !== expected.direction) {
    throw validationError(
      "This cursor belongs to a different sort order. Start again from the first page.",
      { cursorSort: parsed.key, cursorDirection: parsed.direction },
    );
  }
  // A filter that moved, said as its own sentence rather than folded into the
  // sort one: the caller changed a different thing and the move that works is
  // the same either way, but a message naming the sort when the sort is
  // unchanged is the kind of advice that sends somebody looking in the wrong
  // place.
  if (
    expected.filters !== undefined &&
    parsed.filters !== undefined &&
    parsed.filters !== expected.filters
  ) {
    throw validationError(
      "This cursor was issued for a different set of filters. Start again from the first page.",
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
    throw validationError("This page marker cannot be read. Start again from the first page.");
  }
  return instant;
}
