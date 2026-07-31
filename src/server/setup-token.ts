import { randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config.js";

let generatedToken: string | undefined;

/**
 * Production owner setup is intentionally protected even when the container is
 * already reachable. The token is either operator-supplied or generated once
 * for this process and printed at startup while bootstrap remains open.
 */
export function getOwnerSetupToken() {
  if (!getConfig().isProduction) return undefined;
  const configured = process.env.SETUP_TOKEN?.trim();
  if (configured && configured.length < 16) {
    throw new Error("SETUP_TOKEN must contain at least 16 characters");
  }
  generatedToken ??= configured || randomBytes(18).toString("base64url");
  return generatedToken;
}

export function isOwnerSetupTokenValid(candidate: unknown) {
  const expected = getOwnerSetupToken();
  if (!expected) return true;
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
