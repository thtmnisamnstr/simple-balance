import { eq } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { user } from "../db/schema.js";
import { mailEnabled } from "../mail.js";
import { notFound } from "./errors.js";

/**
 * Who the books belong to, for a caller that has a token rather than a session.
 *
 * Deliberately only identity and the calling client's own grant. Whether this
 * person signs in with a password, with Google, or both is deployment plumbing
 * rather than ledger data, and an agent has no use for knowing which credential
 * doors exist.
 */
export async function getIdentity(actor: Actor) {
  const [row] = await getDb()
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, actor.userId))
    .limit(1);
  if (!row) throw notFound("User not found");
  return {
    userId: row.id,
    name: row.name,
    email: row.email,
    clientId: actor.clientId ?? null,
    source: actor.source,
    // Whether anything this deployment is asked to send can actually go. An
    // agent can set a recurrence to email on proposal, or give a template a
    // reminder, and this is the one fact deciding whether either means anything —
    // and the only one it cannot work out from the ledger it can read. The
    // browser has had it all along, on the form beside the checkbox.
    notificationsAvailable: mailEnabled(),
  };
}
