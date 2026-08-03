/**
 * A key that makes retrying a write safe.
 *
 * `crypto.randomUUID` only exists in a secure context, which HTTPS and
 * localhost are and a plain-HTTP address on a home network is not. Reaching a
 * self-hosted deployment at `http://192.168.1.10:3000` is an ordinary thing to
 * do, and there the call is not merely unavailable, it is `undefined`: the
 * expression throws, and because these keys are made while a component renders,
 * the page goes blank with nothing to explain it.
 *
 * `crypto.getRandomValues` carries no such restriction, so it produces the same
 * version 4 UUID by hand when the shortcut is missing. The randomness is the
 * same; only the convenience method is absent.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Version 4, variant 1, exactly as randomUUID would set them.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
