import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the auth library writes to the log, and what it may no longer.
 *
 * Better Auth logged on its own, to `console`, outside the gate every other
 * line goes through. At the default `LOG_LEVEL=info` it wrote
 * `Sign-up attempt for existing email: <the address>` for every sign-up that
 * named an account already here — somebody's address, in a log read by whoever
 * operates the deployment, beside the one fact the sign-up response is careful
 * never to disclose. `docs/standards/code/observability.md` 2.4 rules out an
 * email address in any line, and this is the line that had one.
 */
const environment = { ...process.env };

afterEach(() => {
  process.env = { ...environment };
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * Every console method silenced and recorded, `log` included, because the
 * library's own fallback writes an info line with `console.log` — a spy on
 * `info` alone would watch the gate and miss the line going round it.
 */
function captureConsole() {
  const lines: string[] = [];
  for (const method of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      // Inspected whole rather than stringified, because `String(error)` hides
      // a stack and a nested object is where an address would be carried.
      const shown = parts.map((part) =>
        typeof part === "string" ? part : inspect(part, { depth: Infinity }),
      );
      lines.push(`${method}: ${shown.join(" ")}`);
    });
  }
  return lines;
}

async function freshLog(level: string) {
  process.env.LOG_LEVEL = level;
  vi.resetModules();
  const module = await import("../src/server/log.js");
  module.resetLogLevel();
  return module.log;
}

describe("a line the auth library writes", () => {
  it("keeps the sentence and loses the address", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();

    log.fromLibrary(
      "Better Auth",
      "info",
      "Sign-up attempt for existing email: Someone.Else+ledger@Mail.Example.co.uk",
    );

    expect(lines).toEqual([
      "info: [Better Auth] Sign-up attempt for existing email: [email address]",
    ]);
  });

  it("leaves the punctuation around an address where it was", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();

    log.fromLibrary("Better Auth", "warn", "No account for <a@b.example>, or for 'c.d@e.example'.");

    expect(lines).toEqual([
      "warn: [Better Auth] No account for <[email address]>, or for '[email address]'.",
    ]);
  });

  /**
   * Beside the line as well as in it. The generic OAuth route logs the whole
   * profile a provider returned, and a failed insert's error carries the
   * values it was given — an address among them, a name beside it.
   */
  it("takes the address out of everything passed beside the line", async () => {
    const log = await freshLog("debug");
    const lines = captureConsole();
    const profile: Record<string, unknown> = {
      provider: "google",
      user: { email: "profile@example.com", aliases: ["alias@example.org"] },
      seenAt: { "keyed@example.com": "2026-09-24" },
    };
    profile.self = profile;
    const insert = Object.assign(
      new Error("Failed query: insert into auth_user params: insert@example.com,Somebody Real"),
      {
        query: 'insert into "auth_user" ("email", "name") values ($1, $2)',
        params: ["insert@example.com", "Somebody Real"],
      },
    );

    log.fromLibrary(
      "Better Auth",
      "error",
      "Could not update user info",
      profile,
      new Error("User error@example.com not found", {
        cause: new Error("cause@example.com"),
      }),
      insert,
      42,
    );

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).not.toMatch(/@example\.(com|org)/);
    expect(line).toContain("provider: 'google'");
    expect(line).toContain("User [email address] not found");
    expect(line).toContain('insert into "auth_user" ("email", "name") values ($1, $2)');
    // The statement and not its values: the name was never an address, and
    // it is gone as surely as the address is.
    expect(line).not.toContain("Somebody Real");
    expect(line).toContain("42");
  });

  /**
   * The library's type says the message is a string and its OAuth sign-up
   * path's catch hands over the error itself. Read as a string, that threw
   * from inside the catch, and a refused Google sign-up answered an empty 500.
   */
  it("reports an error handed over in place of a line", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();

    expect(() =>
      log.fromLibrary("Better Auth", "error", new TypeError("No row for turned.away@example.com")),
    ).not.toThrow();

    expect(lines).toHaveLength(1);
    // Node's own mark for an error whose name is not its class's: the copy is
    // an `Error` carrying the original's name, and its stack.
    expect(lines[0]).toMatch(
      /^error: \[Better Auth\] Error \[TypeError\]: No row for \[email address\]\n\s+at /,
    );
  });

  it("says a line could not be logged, rather than throwing", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();
    const hostile = {
      get email(): string {
        throw new Error("a getter that throws");
      },
    };

    expect(() => log.fromLibrary("Better Auth", "warn", "Linking failed", hostile)).not.toThrow();

    expect(lines).toEqual([
      "warn: [Better Auth] A line could not be logged without the risk of an address in it.",
    ]);
  });

  /**
   * The social sign-in route logs the provider name it was sent, and that can
   * be any string the 64 KiB auth body limit lets through. Unanchored, the
   * pattern was quadratic in a run with no `@`, and this took 2.4 seconds.
   */
  it("reads a request-sized string without stalling", async () => {
    const log = await freshLog("info");
    captureConsole();
    const provider = "a".repeat(64 * 1024);

    const started = performance.now();
    log.fromLibrary("Better Auth", "error", "Provider not found", { provider });
    const took = performance.now() - started;

    expect(took).toBeLessThan(100);
  });

  it("cuts a long string after redacting it, never before", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();
    // The address starts four characters short of the cut, so cutting first
    // would keep `jo` and lose the `@` that marks it as an address.
    const message = `${"x".repeat(4093)} jo@example.com ${"y".repeat(60_000)}`;

    log.fromLibrary("Better Auth", "info", message);

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).not.toContain(" jo");
    expect(line!.length).toBeLessThan(4096 + 100);
    expect(line).toMatch(/ \[\d+ more characters\]$/);
  });

  it("keeps a path through a scoped package whole", async () => {
    const log = await freshLog("info");
    const lines = captureConsole();
    const frame =
      "    at LogFunc (file:///app/node_modules/@better-auth/core/dist/env/logger.mjs:68:11)";

    log.fromLibrary("Better Auth", "error", `Something failed\n${frame}`);

    expect(lines).toEqual([`error: [Better Auth] Something failed\n${frame}`]);
  });

  it("is held to LOG_LEVEL like every other line", async () => {
    const log = await freshLog("warn");
    const lines = captureConsole();

    log.fromLibrary("Better Auth", "info", "Sign-up attempt for existing email: x@example.com");
    log.fromLibrary("Better Auth", "warn", "Password is too short");

    expect(lines).toEqual(["warn: [Better Auth] Password is too short"]);
  });
});

/**
 * The wiring rather than the function: the logger Better Auth builds from
 * `src/server/auth.ts`'s options, driven with the sentence its sign-up route
 * writes. Nothing here reaches a database — the address points at a port that
 * refuses — because building the instance and its context connects to nothing.
 */
describe("the auth library's own logger", () => {
  it("writes through the gate, with the address gone", async () => {
    process.env.LOG_LEVEL = "info";
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_SECRET = "auth-log-test-secret-at-least-32-characters";
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none";
    vi.resetModules();
    const lines = captureConsole();
    const { getAuth } = await import("../src/server/auth.js");
    const context = await getAuth().$context;

    context.logger.info("Sign-up attempt for existing email: someone@example.com");

    expect(lines).toEqual([
      "info: [Better Auth] Sign-up attempt for existing email: [email address]",
    ]);
  });
});

/**
 * The library's own routes, driven with the reporting options
 * `src/server/auth.ts` gives it, over an in-memory adapter. A refused Google
 * sign-up happens only after a database read, which the instance above cannot
 * make, and these options are the part of the instance that decides what the
 * library logs and what it answers.
 */
describe("what the auth library answers, reporting through here", () => {
  const origin = "http://localhost:3000";

  async function libraryWith(level: string, extra: Record<string, unknown>) {
    process.env.LOG_LEVEL = level;
    process.env.NODE_ENV = "test";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = origin;
    process.env.AUTH_SECRET = "auth-log-test-secret-at-least-32-characters";
    process.env.DATABASE_URL = "postgresql://nobody:nothing@127.0.0.1:1/none";
    vi.resetModules();
    const { betterAuth } = await import("better-auth");
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    const { authReporting } = await import("../src/server/auth.js");
    return betterAuth({
      baseURL: origin,
      secret: "auth-log-test-secret-at-least-32-characters",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      ...authReporting(level as "info"),
      ...extra,
    });
  }

  const post = (
    auth: { handler: (request: Request) => Promise<Response> },
    path: string,
    body: unknown,
  ) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      }),
    );

  /**
   * What `mayCreateAuthUser` does for an address `ALLOWED_EMAILS` turns away:
   * the user hook answers false, the library's `createOAuthUser` then reads
   * `.id` off nothing, and its catch logs the TypeError itself. The sign-in
   * screen turns that 401 into its "could not sign you in with Google" alert;
   * an empty 500 it can do nothing with.
   */
  it("answers a Google sign-up the rule refuses with the library's 401", async () => {
    const auth = await libraryWith("info", {
      socialProviders: {
        google: {
          clientId: "auth-log-test-client",
          clientSecret: "auth-log-test-secret",
          verifyIdToken: async () => true,
          getUserInfo: async () => ({
            user: {
              id: "g-1",
              email: "turned.away@example.com",
              emailVerified: true,
              name: "T",
            },
            data: {},
          }),
        },
      },
      databaseHooks: { user: { create: { before: async () => false } } },
    });
    const lines = captureConsole();

    const response = await post(auth, "/sign-in/social", {
      provider: "google",
      idToken: { token: "an-id-token" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "OAUTH_LINK_ERROR" });
    expect(lines.join("\n")).not.toContain("turned.away@example.com");
    expect(lines).toContainEqual(
      expect.stringMatching(/^error: \[Better Auth\] Error \[TypeError\]: Cannot read/),
    );
  });

  /**
   * Anything that is not the library's own error fell through to its router's
   * last resort, which wrote `# SERVER_ERROR:` and the error whole to
   * `console`, bound parameters and all. Thrown on, it reaches the Hono
   * handler that narrows it through `log.failure`.
   */
  it("hands an error that is not its own to the application, and writes none of it", async () => {
    let failing = false;
    const failure = new Error("Failed query: select ... params: pat.private@example.com");
    const auth = await libraryWith("debug", {
      emailAndPassword: { enabled: true },
      databaseHooks: {
        session: {
          create: {
            before: async () => {
              if (failing) throw failure;
              return true;
            },
          },
        },
      },
    });
    const credentials = {
      email: "pat.private@example.com",
      password: "a-long-enough-password",
    };
    await post(auth, "/sign-up/email", { name: "Pat", ...credentials });
    const lines = captureConsole();
    failing = true;

    await expect(post(auth, "/sign-in/email", credentials)).rejects.toBe(failure);

    expect(lines.join("\n")).not.toMatch(/SERVER_ERROR|pat\.private@example\.com/);
  });

  /**
   * The library answers its own errors, so what they log is all that is left
   * to choose, and few arrive: one a route throws, a wrong password included,
   * becomes its response inside the route. A 500 is written at error, as the
   * library's default did; anything else it wrote through a logger of its own
   * that `LOG_LEVEL` does not reach, and it is `debug` here.
   */
  it("writes a failure of its own at error, and a refusal at debug", async () => {
    await libraryWith("debug", {});
    const { authReporting } = await import("../src/server/auth.js");
    const { APIError } = await import("better-auth/api");
    const { onError } = authReporting("debug").onAPIError;
    const lines = captureConsole();

    await onError(
      new APIError("INTERNAL_SERVER_ERROR", { message: "No session for pat.private@example.com" }),
    );
    await onError(new APIError("FORBIDDEN", { message: "Not for pat.private@example.com" }));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^error: \[Better Auth\] INTERNAL_SERVER_ERROR /);
    expect(lines[0]).toContain("No session for [email address]");
    expect(lines[1]).toBe("debug: [Better Auth] Not for [email address]");
  });
});
