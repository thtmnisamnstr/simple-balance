import { randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config.js";

let generatedToken: string | undefined;

/**
 * A reachable production container should not be claimable by whoever finds it
 * first. The token is either operator-supplied or generated once for this
 * process, and it is printed at startup only while no account exists.
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
  // Never read "there is no token" as "anybody may claim this". Outside
  // production there is deliberately no token; inside it, a missing one is a
  // bug, and returning true would hand the first account to whoever asked.
  if (!expected) return !getConfig().isProduction;
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
