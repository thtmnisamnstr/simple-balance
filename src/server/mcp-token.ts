import { createHash, generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { decodeProtectedHeader, decodeJwt, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { getConfig } from "./config.js";
import { MCP_SIGNING_KEY_LOCK } from "./db/advisory-locks.js";
import { getDb } from "./db/client.js";
import { mcpSigningKeys, oauthAccessToken } from "./db/schema.js";

const ACTIVE_KEY_ID = "mcp-active-rs256";

type SigningKey = {
  id: string;
  algorithm: string;
  publicJwk: JWK;
  privateJwk: JWK;
};

/**
 * The key is generated once in a deployment's life and never rotated, so it is
 * held for the process after the first read.
 *
 * Reading it used to mean opening a transaction and taking an exclusive
 * advisory lock, which is right for creating it and far too heavy for using it:
 * every MCP request, every token issued, and every unauthenticated fetch of the
 * public JWKS queued behind the same cluster-wide lock, so a stranger could
 * hold up the whole deployment by asking for the public keys in a loop.
 */
let cachedSigningKey: SigningKey | undefined;

const asSigningKey = (row: typeof mcpSigningKeys.$inferSelect): SigningKey => ({
  ...row,
  publicJwk: row.publicJwk as JWK,
  privateJwk: row.privateJwk as JWK,
});

async function getSigningKey(): Promise<SigningKey> {
  if (cachedSigningKey) return cachedSigningKey;

  // Almost always present, and reading it needs no lock at all.
  const [present] = await getDb()
    .select()
    .from(mcpSigningKeys)
    .where(eq(mcpSigningKeys.id, ACTIVE_KEY_ID))
    .limit(1);
  if (present) {
    cachedSigningKey = asSigningKey(present);
    return cachedSigningKey;
  }

  // Only creating one is worth serialising, and only two containers starting
  // together would ever contend for it.
  cachedSigningKey = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MCP_SIGNING_KEY_LOCK})`);
    const [existing] = await tx
      .select()
      .from(mcpSigningKeys)
      .where(eq(mcpSigningKeys.id, ACTIVE_KEY_ID))
      .limit(1);
    if (existing) return asSigningKey(existing);

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" }) as JWK;
    const privateJwk = privateKey.export({ format: "jwk" }) as JWK;
    const [created] = await tx
      .insert(mcpSigningKeys)
      .values({
        id: ACTIVE_KEY_ID,
        algorithm: "RS256",
        publicJwk,
        privateJwk,
      })
      .returning();
    return asSigningKey(created);
  });
  return cachedSigningKey;
}

export async function getMcpJwks() {
  const key = await getSigningKey();
  return {
    keys: [
      {
        ...key.publicJwk,
        kid: key.id,
        alg: key.algorithm,
        use: "sig",
      },
    ],
  };
}

export async function issueMcpAccessToken(opaqueToken: string) {
  const [record] = await getDb()
    .select()
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.accessToken, opaqueToken))
    .limit(1);
  if (!record?.userId) {
    throw new Error("OAuth access token is not associated with a user");
  }
  const config = getConfig();
  const key = await getSigningKey();
  const privateKey = await importJWK(key.privateJwk, key.algorithm);
  // The row's primary key, not the opaque token it holds. A JWT is signed, not
  // encrypted, so any claim in it is readable by whatever handles the token: a
  // proxy, a log, an error report. Carrying the opaque token there meant every
  // one of those saw a credential good for seven days at every endpoint that
  // accepts the bare token. A row id opens nothing on its own.
  return new SignJWT({
    scope: record.scopes,
    client_id: record.clientId,
    grant_id: record.id,
  })
    .setProtectedHeader({ alg: key.algorithm, kid: key.id, typ: "JWT" })
    .setIssuer(config.baseUrl)
    .setAudience(`${config.baseUrl}/mcp`)
    .setSubject(record.userId)
    .setJti(createHash("sha256").update(opaqueToken).digest("base64url"))
    .setIssuedAt()
    .setExpirationTime(Math.floor(record.accessTokenExpiresAt.getTime() / 1_000))
    .sign(privateKey);
}

export async function resignMcpIdToken(idToken: string) {
  const claims = decodeJwt(idToken);
  if (!claims.sub || !claims.aud) {
    throw new Error("OAuth ID token is missing its subject or audience");
  }
  const { aud, exp, iat: _iat, iss: _iss, jti, nbf, sub, ...customClaims } = claims;
  if (typeof customClaims.auth_time === "number" && customClaims.auth_time > 10_000_000_000) {
    customClaims.auth_time = Math.floor(customClaims.auth_time / 1_000);
  }
  const config = getConfig();
  const key = await getSigningKey();
  const privateKey = await importJWK(key.privateJwk, key.algorithm);
  let token = new SignJWT(customClaims)
    .setProtectedHeader({ alg: key.algorithm, kid: key.id, typ: "JWT" })
    .setIssuer(config.baseUrl)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(exp ?? Math.floor(Date.now() / 1_000) + 3_600);
  if (jti) token = token.setJti(jti);
  if (nbf) token = token.setNotBefore(nbf);
  return token.sign(privateKey);
}

export async function unwrapMcpAccessToken(jwt: string) {
  try {
    const header = decodeProtectedHeader(jwt);
    if (header.kid !== ACTIVE_KEY_ID || header.alg !== "RS256") return null;
    const config = getConfig();
    const key = await getSigningKey();
    const publicKey = await importJWK(key.publicJwk, key.algorithm);
    const result = await jwtVerify(jwt, publicKey, {
      algorithms: ["RS256"],
      issuer: config.baseUrl,
      audience: `${config.baseUrl}/mcp`,
    });
    const grantId = result.payload.grant_id;
    if (typeof grantId !== "string" || !grantId) return null;
    const [record] = await getDb()
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.id, grantId))
      .limit(1);
    // A grant that has been revoked is gone from this table, so a JWT naming it
    // stops working the moment somebody takes the access back rather than when
    // it would have expired. The three checks below are the claims agreeing
    // with the row: a signature proves this deployment issued the token, not
    // that the grant it names is still the one it was issued for.
    if (
      !record ||
      record.userId !== result.payload.sub ||
      record.clientId !== result.payload.client_id ||
      record.accessTokenExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return record.accessToken;
  } catch {
    return null;
  }
}
