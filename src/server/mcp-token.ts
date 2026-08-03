import { createHash, generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  decodeProtectedHeader,
  decodeJwt,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";
import { getConfig } from "./config.js";
import { MCP_SIGNING_KEY_LOCK } from "./db/advisory-locks.js";
import { getDb } from "./db/client.js";
import {
  mcpSigningKeys,
  oauthAccessToken,
} from "./db/schema.js";

const ACTIVE_KEY_ID = "mcp-active-rs256";

type SigningKey = {
  id: string;
  algorithm: string;
  publicJwk: JWK;
  privateJwk: JWK;
};

async function getSigningKey(): Promise<SigningKey> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MCP_SIGNING_KEY_LOCK})`);
    const [existing] = await tx
      .select()
      .from(mcpSigningKeys)
      .where(eq(mcpSigningKeys.id, ACTIVE_KEY_ID))
      .limit(1);
    if (existing) {
      return {
        ...existing,
        publicJwk: existing.publicJwk as JWK,
        privateJwk: existing.privateJwk as JWK,
      };
    }

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
    return {
      ...created,
      publicJwk: created.publicJwk as JWK,
      privateJwk: created.privateJwk as JWK,
    };
  });
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
  return new SignJWT({
    scope: record.scopes,
    client_id: record.clientId,
    opaque_token: opaqueToken,
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
  const {
    aud,
    exp,
    iat: _iat,
    iss: _iss,
    jti,
    nbf,
    sub,
    ...customClaims
  } = claims;
  if (
    typeof customClaims.auth_time === "number" &&
    customClaims.auth_time > 10_000_000_000
  ) {
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
    return typeof result.payload.opaque_token === "string"
      ? result.payload.opaque_token
      : null;
  } catch {
    return null;
  }
}
