import { describe, expect, it } from "vitest";
import {
  conflict,
  duplicate,
  notFound,
  staleVersion,
  validationError,
} from "../src/server/services/errors.js";

/**
 * What each caller is told to do next.
 *
 * `common.md` rules that where the browser and an agent need different advice
 * it is the advice that differs and never the diagnosis. One `AppError` message
 * cannot say both, so the diagnosis stays single-sourced and the agent's half
 * of the sentence rides along as `agentMessage`, which only the MCP transport
 * reads.
 */
describe("a version conflict tells each caller something it can act on", () => {
  it("tells the browser to reload", () => {
    expect(staleVersion({ currentVersion: 3 }).message).toMatch(
      /Reload to see the current version/,
    );
    expect(staleVersion({ currentVersion: 3 }).message).not.toMatch(/details/);
  });

  it("tells an agent where the version it needs is, when the throw site sent one", () => {
    const error = staleVersion({ id: "a", currentVersion: 3 });
    expect(error.agentMessage).toMatch(/Read it again/);
    expect(error.agentMessage).toMatch(/details\.currentVersion/);
  });

  /**
   * Thirteen of the fifty throw sites carry no details. Naming a field that is
   * not in the payload is the same fault as telling an agent to refresh: advice
   * it cannot follow.
   */
  it("does not name a field the refusal is not carrying", () => {
    for (const error of [staleVersion(), staleVersion({ id: "a" }), staleVersion("odd")]) {
      expect(error.agentMessage).toMatch(/Read it again/);
      expect(error.agentMessage).not.toMatch(/details\.currentVersion/);
    }
  });

  // Same fault, same code, same details either way. Only the next move differs.
  it("keeps the diagnosis and the wire fields the same for both", () => {
    const withVersion = staleVersion({ currentVersion: 3 });
    const without = staleVersion();
    expect(withVersion.code).toBe(without.code);
    expect(withVersion.status).toBe(409);
    expect(without.status).toBe(409);
    expect(withVersion.details).toEqual({ currentVersion: 3 });
  });
});

describe("every refusal a caller can act on says what it is about", () => {
  /**
   * `notFound` used to default to "The requested record was not found", which
   * names nothing and teaches nothing. All forty call sites already passed
   * their own sentence, so the default was only ever a trap for the forty-first.
   * The compiler is what keeps it that way now; this pins the arity that makes
   * the compiler able to.
   */
  it("makes a not-found refusal name what was not found", () => {
    // A default value on `message` would sit before every other parameter, and
    // the reported arity would fall to zero. It is 2 while both are required of
    // the compiler and merely optional to JavaScript.
    expect(notFound.length).toBeGreaterThan(0);
    expect(notFound("That account is not one of yours").message).toBe(
      "That account is not one of yours",
    );
  });

  it("carries a non-empty message from every constructor", () => {
    const errors = [
      notFound("Transaction not found"),
      conflict("That import batch has already been reverted"),
      staleVersion(),
      duplicate("A category with that name already exists"),
      validationError("Every selected staged transaction needs a version"),
    ];
    for (const error of errors) {
      expect(error.message.length, error.code).toBeGreaterThan(0);
      expect(error.message, error.code).not.toMatch(/unexpected|sorry/i);
    }
  });

  // Only the conflict a caller can resolve automatically has a second audience.
  it("leaves the agent sentence unset where the advice is the same for everyone", () => {
    expect(notFound("Transaction not found").agentMessage).toBeUndefined();
    expect(validationError("Choose at least one field to change").agentMessage).toBeUndefined();
  });
});
