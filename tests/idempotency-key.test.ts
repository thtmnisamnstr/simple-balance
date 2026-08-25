import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdempotencyKey } from "../src/client/idempotency.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * These keys are what stops a retried request writing a transaction twice, and
 * they are made while a component renders. `crypto.randomUUID` exists only in a
 * secure context, so reaching a self-hosted deployment over plain HTTP at a
 * address on a home network leaves it undefined, and calling it there does not
 * degrade: it throws where React cannot recover, and the page goes blank.
 */
describe("making an idempotency key", () => {
  it("uses randomUUID when the browser offers it", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });
    expect(newIdempotencyKey()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("still produces a version 4 UUID where randomUUID does not exist", () => {
    const { getRandomValues } = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: getRandomValues.bind(globalThis.crypto),
    });
    expect("randomUUID" in globalThis.crypto).toBe(false);

    const key = newIdempotencyKey();
    expect(key).toMatch(uuid);
  });

  it("does not repeat itself", () => {
    const { getRandomValues } = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: getRandomValues.bind(globalThis.crypto),
    });
    const keys = new Set(Array.from({ length: 500 }, newIdempotencyKey));
    expect(keys.size).toBe(500);
  });

  it("meets the length the server requires of a key", () => {
    // idempotencyKeySchema asks for at least 8 characters.
    expect(newIdempotencyKey().length).toBeGreaterThanOrEqual(8);
  });
});
