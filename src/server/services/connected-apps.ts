import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import { oauthAccessToken, oauthApplication, oauthConsent } from "../db/schema.js";
import { notFound } from "./errors.js";
import { writeAudit } from "./helpers.js";

/**
 * The agents a person has let into their books, and taking that back.
 *
 * Authorizing an MCP client used to be a one-way door from the browser: the
 * only way back out was deleting rows from auth_oauth_access_token by hand,
 * which is not a remedy anyone signed in to a web app can reach. A token that
 * leaked therefore kept working until it expired, and its refresh token kept
 * minting new ones for as long as it lasted.
 *
 * Everything here is scoped to the signed-in person. Two people may have
 * authorized the same client, and revoking is about this person's grant, not
 * about the client itself, so revoking never disables or deletes a
 * registration another account may still be relying on. The sweep at the end
 * of this file does delete registrations, but only ones nobody has ever
 * approved and that have never held a token, which is a different thing.
 */

export type ConnectedApp = {
  clientId: string;
  name: string;
  scopes: string[];
  authorizedAt: string | null;
  lastIssuedAt: string | null;
  expiresAt: string | null;
  activeTokenCount: number;
  hasLiveAccess: boolean;
};

const scopeList = (scopes: string | null) => (scopes ?? "").split(/\s+/).filter(Boolean);

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export async function listConnectedApps(
  actor: Actor,
  transaction?: DbTransaction,
): Promise<ConnectedApp[]> {
  const runner = transaction ?? getDb();
  const now = new Date();

  // A grant shows up here once consent was given, even if no token is live
  // right now, because "this agent may come back without asking again" is
  // exactly the thing a person needs to be able to withdraw.
  const consents = await runner
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      authorizedAt: oauthConsent.createdAt,
      name: oauthApplication.name,
    })
    .from(oauthConsent)
    .leftJoin(oauthApplication, eq(oauthApplication.clientId, oauthConsent.clientId))
    .where(and(eq(oauthConsent.userId, actor.userId), eq(oauthConsent.consentGiven, true)))
    .orderBy(desc(oauthConsent.createdAt));

  const tokens = await runner
    .select({
      clientId: oauthAccessToken.clientId,
      scopes: oauthAccessToken.scopes,
      issuedAt: oauthAccessToken.createdAt,
      accessTokenExpiresAt: oauthAccessToken.accessTokenExpiresAt,
      refreshTokenExpiresAt: oauthAccessToken.refreshTokenExpiresAt,
    })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, actor.userId));

  const byClient = new Map<string, ConnectedApp>();
  for (const consent of consents) {
    if (byClient.has(consent.clientId)) continue;
    byClient.set(consent.clientId, {
      clientId: consent.clientId,
      name: consent.name ?? "Unnamed MCP client",
      scopes: scopeList(consent.scopes),
      authorizedAt: iso(consent.authorizedAt),
      lastIssuedAt: null,
      expiresAt: null,
      activeTokenCount: 0,
      hasLiveAccess: false,
    });
  }

  for (const token of tokens) {
    // A token whose client has no consent row still represents real access, so
    // it is listed rather than hidden behind the grant it outlived.
    const app = byClient.get(token.clientId) ?? {
      clientId: token.clientId,
      name: "Unnamed MCP client",
      scopes: scopeList(token.scopes),
      authorizedAt: null,
      lastIssuedAt: null,
      expiresAt: null,
      activeTokenCount: 0,
      hasLiveAccess: false,
    };
    byClient.set(token.clientId, app);

    const live = token.accessTokenExpiresAt > now || token.refreshTokenExpiresAt > now;
    if (!live) continue;
    app.activeTokenCount += 1;
    app.hasLiveAccess = true;
    if (!app.lastIssuedAt || iso(token.issuedAt)! > app.lastIssuedAt) {
      app.lastIssuedAt = iso(token.issuedAt);
    }
    const furthest =
      token.refreshTokenExpiresAt > token.accessTokenExpiresAt
        ? token.refreshTokenExpiresAt
        : token.accessTokenExpiresAt;
    if (!app.expiresAt || iso(furthest)! > app.expiresAt) {
      app.expiresAt = iso(furthest);
    }
    for (const scope of scopeList(token.scopes)) {
      if (!app.scopes.includes(scope)) app.scopes.push(scope);
    }
  }

  return [...byClient.values()].sort(
    (left, right) =>
      (right.authorizedAt ?? "").localeCompare(left.authorizedAt ?? "") ||
      left.name.localeCompare(right.name),
  );
}

export type RevokedConnectedApp = {
  clientId: string;
  name: string;
  revokedTokenCount: number;
};

/**
 * Cut one client off from this person's ledger, now rather than at expiry.
 *
 * Deleting the access-token row is what makes it immediate: an MCP request
 * presents a signed JWT, and the JWT is only honored while it still resolves
 * to a live row, so a token already in an agent's hands stops working on the
 * next call. The refresh token lives on that same row, so it goes with it and
 * cannot mint a replacement.
 *
 * The consent goes too. Leaving it would let the client walk back in without
 * the person being asked, which is not what revoking means to anyone.
 */
export async function revokeConnectedApp(
  actor: Actor,
  clientId: string,
  transaction?: DbTransaction,
): Promise<RevokedConnectedApp> {
  return withTransaction(transaction, async (tx) => {
    const [application] = await tx
      .select({ name: oauthApplication.name })
      .from(oauthApplication)
      .where(eq(oauthApplication.clientId, clientId))
      .limit(1);

    const revokedTokens = await tx
      .delete(oauthAccessToken)
      .where(
        and(eq(oauthAccessToken.userId, actor.userId), eq(oauthAccessToken.clientId, clientId)),
      )
      .returning({ id: oauthAccessToken.id });

    const revokedConsents = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, actor.userId), eq(oauthConsent.clientId, clientId)))
      .returning({ id: oauthConsent.id });

    // Nothing of this person's was attached to that client. Saying so is a
    // different answer from silently succeeding, and it keeps a client id
    // belonging to somebody else from looking like it was ever theirs.
    if (!revokedTokens.length && !revokedConsents.length) {
      throw notFound("No access for that application was found");
    }

    const name = application?.name ?? "Unnamed MCP client";
    await writeAudit(tx, actor, {
      entityType: "connected_app",
      entityId: clientId,
      operation: "revoke",
      before: {
        clientId,
        name,
        revokedTokenCount: revokedTokens.length,
        revokedConsentCount: revokedConsents.length,
      },
    });
    return { clientId, name, revokedTokenCount: revokedTokens.length };
  });
}

/**
 * Take every agent's access back, for a person who may not be reading a screen.
 *
 * Changing a password because somebody else has it signs every session out.
 * An MCP grant is not a session, so without this a token an agent already held
 * would keep full access to the ledger, and its refresh token would keep
 * minting replacements for seven days. Recovering an account has to mean
 * recovering all of it.
 *
 * Takes a user id rather than an Actor because the reset path runs from an
 * emailed link with no session behind it.
 */
export async function revokeAllConnectedApps(userId: string, transaction?: DbTransaction) {
  return withTransaction(transaction, async (tx) => {
    const revokedTokens = await tx
      .delete(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, userId))
      .returning({ clientId: oauthAccessToken.clientId });
    const revokedConsents = await tx
      .delete(oauthConsent)
      .where(eq(oauthConsent.userId, userId))
      .returning({ clientId: oauthConsent.clientId });
    if (!revokedTokens.length && !revokedConsents.length) {
      return { revokedTokenCount: 0, revokedConsentCount: 0 };
    }
    const clientIds = [
      ...new Set([
        ...revokedTokens.map((row) => row.clientId),
        ...revokedConsents.map((row) => row.clientId),
      ]),
    ];
    await writeAudit(
      tx,
      { userId, source: "web" },
      {
        entityType: "connected_app",
        entityId: userId,
        operation: "revoke",
        before: {
          reason: "password_changed",
          clientIds,
          revokedTokenCount: revokedTokens.length,
          revokedConsentCount: revokedConsents.length,
        },
      },
    );
    return {
      revokedTokenCount: revokedTokens.length,
      revokedConsentCount: revokedConsents.length,
    };
  });
}

/**
 * Record that a client has been authorized, once, and keep it from the sweep.
 *
 * Called when a consent is approved and when a token is issued. Revoking
 * deletes the consent and token rows, so without this a client that was used
 * and disconnected looked to `pruneAbandonedClients` exactly like one nobody
 * finished registering, and was deleted. ChatGPT registers once per connection
 * and keeps the client, so its next sign-in failed with `invalid_client`.
 * Writes only where the column is still empty, so the first time stays the
 * first time.
 */
export async function markClientAuthorized(clientId: string) {
  // Read first, because this runs on every token issued and the column is
  // set once: on a Citus cluster the OAuth tables are reference tables, so an
  // UPDATE — even one matching nothing — is a write to every node.
  const [client] = await getDb()
    .select({ firstAuthorizedAt: oauthApplication.firstAuthorizedAt })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, clientId))
    .limit(1);
  if (!client || client.firstAuthorizedAt) return;
  await getDb()
    .update(oauthApplication)
    .set({ firstAuthorizedAt: new Date() })
    .where(
      and(eq(oauthApplication.clientId, clientId), isNull(oauthApplication.firstAuthorizedAt)),
    );
}

/**
 * The client an access token was issued to, for the token endpoint, which is
 * handed the token rather than a client id it could trust.
 */
export async function clientIdForAccessToken(accessToken: string) {
  const [row] = await getDb()
    .select({ clientId: oauthAccessToken.clientId })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.accessToken, accessToken))
    .limit(1);
  return row?.clientId ?? null;
}

/**
 * Revoke the refresh token a successful refresh was made with.
 *
 * Better Auth 1.6's refresh grant writes a new row and leaves the presented
 * one valid until its own expiry, so every refresh left one more live refresh
 * token behind, each good for seven days from when it was issued. Rotation is
 * only worth anything if the old token stops working in the same response that
 * hands out the new one, which is what Claude's connector guidance asks of a
 * server rotating a public client's tokens. The old row carries the old access
 * token too, and that goes with it: the client has just been given a
 * replacement.
 *
 * Scoped to the person and the client the replacement was issued to, so a
 * presented value can only ever retire a row of the same grant, and never the
 * replacement itself, should a library ever hand the same token back.
 *
 * Returns whether this rotation stands. The library takes no lock on the
 * refresh grant, so two refreshes presenting one token each mint a
 * replacement; the delete is where they meet, and the one that finds the old
 * row already gone lost. Its replacement is deleted here and false returned,
 * so the caller refuses it as it would a replayed token and one chain
 * survives rather than two.
 */
export async function retireRefreshToken(presented: string, replacement: string) {
  if (presented === replacement) return true;
  const [issued] = await getDb()
    .select({ clientId: oauthAccessToken.clientId, userId: oauthAccessToken.userId })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.refreshToken, replacement))
    .limit(1);
  if (!issued?.userId) return false;
  const retired = await getDb()
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.refreshToken, presented),
        eq(oauthAccessToken.clientId, issued.clientId),
        eq(oauthAccessToken.userId, issued.userId),
      ),
    )
    .returning({ id: oauthAccessToken.id });
  if (retired.length) return true;
  await getDb()
    .delete(oauthAccessToken)
    .where(
      and(
        eq(oauthAccessToken.refreshToken, replacement),
        eq(oauthAccessToken.clientId, issued.clientId),
        eq(oauthAccessToken.userId, issued.userId),
      ),
    );
  return false;
}

/**
 * How long an unclaimed dynamic registration is kept.
 *
 * Registration is open and unauthenticated, which RFC 7591 intends, but the
 * rows it creates had no expiry and nothing ever deleted them. A caller could
 * therefore leave permanent rows behind at the rate limiter's pace, and each
 * one could carry as much free text as the request body allowed.
 *
 * An authorization takes a person seconds to approve. A registration that after
 * a day has never been approved by anybody and has never been issued a token is
 * one nobody completed, so it is swept. "Never" is `firstAuthorizedAt`, not the
 * consent and token rows alone, because revoking deletes those.
 */
const ABANDONED_CLIENT_AGE_MS = 24 * 60 * 60 * 1000;

export async function pruneAbandonedClients(now = new Date()) {
  const cutoff = new Date(now.getTime() - ABANDONED_CLIENT_AGE_MS);
  const removed = await getDb()
    .delete(oauthApplication)
    .where(
      and(
        // Only the anonymous ones. A registration tied to an account was made
        // deliberately and is not this sweep's business.
        isNull(oauthApplication.userId),
        lt(oauthApplication.createdAt, cutoff),
        // Never one that was ever authorized: revoking deletes the consent and
        // token rows the two checks below look for, so only this can tell a
        // disconnected client from an abandoned registration.
        isNull(oauthApplication.firstAuthorizedAt),
        sql`not exists (
          select 1 from ${oauthConsent}
          where ${oauthConsent.clientId} = ${oauthApplication.clientId}
        )`,
        sql`not exists (
          select 1 from ${oauthAccessToken}
          where ${oauthAccessToken.clientId} = ${oauthApplication.clientId}
        )`,
      ),
    )
    .returning({ clientId: oauthApplication.clientId });
  return removed.length;
}
