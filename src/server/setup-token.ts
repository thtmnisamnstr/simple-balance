import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getConfig } from "./config.js";
import { OWNER_SETUP_TOKEN_LOCK } from "./db/advisory-locks.js";
import { getDb } from "./db/client.js";
import { ownerSetupTokens } from "./db/schema.js";

const ACTIVE_TOKEN_ID = "owner-setup";

/**
 * Generated once in a deployment's life and never rotated, so it is held for the
 * process after the first read — the same reasoning as the MCP signing key.
 */
let cachedToken: string | undefined;

/**
 * A reachable production container should not be claimable by whoever finds it
 * first. The token is either operator-supplied or generated once for the
 * deployment, and it is printed at startup only while no account exists.
 *
 * Generated once for the *deployment*, not for the process. Held in a module
 * variable it belonged to whichever pod made it, so on a web tier running more
 * than one replica the code printed in the log was rejected by every other pod,
 * and the operator saw "The setup code is missing or invalid." for a code they
 * had just copied out of it. Every other piece of state that has to agree across
 * replicas already lives in PostgreSQL for exactly this reason.
 *
 * Deriving it from AUTH_SECRET would have avoided the table and cost more than
 * it saved: rotating the code would mean rotating AUTH_SECRET, which signs
 * everybody out, and it would collapse the one proof of ownership that does not
 * follow from holding AUTH_SECRET, at the only moment that independence means
 * anything — an unclaimed deployment has no session to forge.
 *
 * A stored code does outlive a restart, where a per-process one did not. That
 * costs nothing here: the code is only ever read while no account exists, so it
 * is spent by the thing it exists to do, and until then it is the only
 * credential there is. What storing it widens is the proof of ownership, from
 * "can read the log" to "can read the log or the database" — and database access
 * already implies everything.
 */
export async function getOwnerSetupToken() {
  if (!getConfig().isProduction) return undefined;
  const configured = process.env.SETUP_TOKEN?.trim();
  if (configured && configured.length < 16) {
    throw new Error("SETUP_TOKEN must contain at least 16 characters");
  }
  // An operator-chosen code never touches the database.
  if (configured) return configured;
  if (cachedToken) return cachedToken;

  const [present] = await getDb()
    .select()
    .from(ownerSetupTokens)
    .where(eq(ownerSetupTokens.id, ACTIVE_TOKEN_ID))
    .limit(1);
  if (present) {
    cachedToken = present.token;
    return cachedToken;
  }

  // Only creating one is worth serialising, and only containers starting
  // together would ever contend for it.
  cachedToken = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${OWNER_SETUP_TOKEN_LOCK})`);
    const [existing] = await tx
      .select()
      .from(ownerSetupTokens)
      .where(eq(ownerSetupTokens.id, ACTIVE_TOKEN_ID))
      .limit(1);
    if (existing) return existing.token;
    const [created] = await tx
      .insert(ownerSetupTokens)
      .values({ id: ACTIVE_TOKEN_ID, token: randomBytes(18).toString("base64url") })
      .returning();
    return created.token;
  });
  return cachedToken;
}

export async function isOwnerSetupTokenValid(candidate: unknown) {
  const expected = await getOwnerSetupToken();
  // Never read "there is no token" as "anybody may claim this". Outside
  // production there is deliberately no token; inside it, a missing one is a
  // bug, and returning true would hand the first account to whoever asked.
  if (!expected) return !getConfig().isProduction;
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}
