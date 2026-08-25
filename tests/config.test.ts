import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keys = [
  "NODE_ENV",
  "DATABASE_URL",
  "APP_BASE_URL",
  "AUTH_SECRET",
  "AUTH_MODE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  // Anything not named here is dropped by setEnvironment rather than set, so a
  // test for it passes for the wrong reason.
  "RECURRENCE_SCHEDULER",
  "TRUST_PROXY",
  "LOG_LEVEL",
  // The bounded integers. getConfig() reads all six, so one left over from
  // another file's case would refuse to start here and say nothing about why.
  "CSV_MAX_BYTES",
  "CSV_MAX_ROWS",
  "DATABASE_POOL_SIZE",
  "RECURRENCE_TICK_SECONDS",
  "RECURRENCE_CATCH_UP_LIMIT",
  "RECURRENCE_CLAIM_LIMIT",
  // The rest of what a file-backed secret touches. `vitest.config.ts` sets
  // `fileParallelism: false`, so a `_FILE` variable left behind by one case
  // follows every later test file in the run and points it at a temporary
  // directory that has already been deleted.
  "DIRECT_DATABASE_URL",
  "SETUP_TOKEN",
  "SMTP_HOST",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "MAIL_FROM",
  "AUTH_SECRET_FILE",
  "DATABASE_URL_FILE",
  "DIRECT_DATABASE_URL_FILE",
  "SMTP_PASSWORD_FILE",
  "GOOGLE_CLIENT_SECRET_FILE",
  "SETUP_TOKEN_FILE",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("authentication configuration", () => {
  it("defaults development to local auth without external identity settings", async () => {
    setEnvironment({ NODE_ENV: "development" });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    const config = getConfig();
    expect(config).toMatchObject({
      authMode: "local",
      localAuthEnabled: true,
      googleAuthEnabled: false,
      baseUrl: "http://localhost:5173",
    });
  });

  it("accepts production local mode without Google settings or an allowlist", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig()).toMatchObject({
      authMode: "local",
      localAuthEnabled: true,
      googleAuthEnabled: false,
    });
    // Nothing configured means nobody new registers, which is what an existing
    // deployment expects an upgrade to do.
    expect(getConfig().registration).toEqual({ kind: "closed" });
  });

  it.each([
    "http://simple-balance.example.com",
    "http://localhost.attacker.example",
    "ftp://localhost:3000",
  ])("rejects the insecure production APP_BASE_URL %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/APP_BASE_URL must use HTTPS/);
  });

  it.each([
    "https://simple-balance.example.com/app",
    "https://simple-balance.example.com/app/",
    "https://simple-balance.example.com/.",
    "https://simple-balance.example.com\\app",
    "https://simple-balance.example.com?tenant=owner",
    "https://simple-balance.example.com#callback",
    "https://@simple-balance.example.com",
    "https://owner@simple-balance.example.com",
    "https://owner:secret@simple-balance.example.com",
    // Values the URL constructor itself refuses. These used to escape the
    // schema as a bare "Invalid URL", so the operator got a stack trace instead
    // of the rule the schema exists to state.
    "simple-balance.example.com",
    "//simple-balance.example.com",
    "",
    "https://",
  ])("rejects a production APP_BASE_URL that is not an exact origin: %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/exact HTTP\(S\) origin/);
  });

  it.each([
    ["RECURRENCE_SCHEDULER", "yes", /RECURRENCE_SCHEDULER must be true or false/],
    ["TRUST_PROXY", "yes", /TRUST_PROXY must be true or false/],
    ["LOG_LEVEL", "loud", /LOG_LEVEL must be debug, info, warn or error/],
    ["AUTH_MODE", "sso", /AUTH_MODE must be one of/],
    ["NODE_ENV", "Prod", /NODE_ENV must be production, development or test/],
  ])(
    "says which variable was wrong when %s is not a value it takes",
    async (name, value, expected) => {
      setEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
        APP_BASE_URL: "https://simple-balance.example.com",
        AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
        AUTH_MODE: "local",
        [name]: value,
      });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      expect(() => getConfig()).toThrow(expected);
    },
  );

  /**
   * The bounded integers used to fall back to their defaults, and were read at
   * the moment they were wanted: `CSV_MAX_ROWS` inside an import, the
   * recurrence limits inside a tick. A typo therefore had no symptom at all,
   * and the operator's number was silently not the one in force. Startup is
   * where an orchestrator is still watching, so this asserts the refusal
   * happens there rather than at the first import.
   */
  it.each([
    ["CSV_MAX_ROWS", "1O000", /CSV_MAX_ROWS must be an integer between 1 and 10000/],
    ["CSV_MAX_BYTES", "10 MB", /CSV_MAX_BYTES must be an integer between 1 and 104857600/],
    ["RECURRENCE_TICK_SECONDS", "0", /RECURRENCE_TICK_SECONDS must be an integer/],
    ["RECURRENCE_CATCH_UP_LIMIT", "5000", /RECURRENCE_CATCH_UP_LIMIT must be an integer/],
    ["RECURRENCE_CLAIM_LIMIT", "-1", /RECURRENCE_CLAIM_LIMIT must be an integer/],
    ["DATABASE_POOL_SIZE", "many", /DATABASE_POOL_SIZE must be an integer/],
  ])("refuses to start when %s is not a whole number in range", async (name, value, expected) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
      [name]: value,
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(expected);
  });

  it("accepts and normalizes an optional trailing slash on the production origin", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com/",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig().baseUrl).toBe("https://simple-balance.example.com");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.42.0.8:3000",
    "http://[::1]:3000",
  ])("allows the production loopback URL %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig().baseUrl).toBe(baseUrl);
  });

  it.each(["Production", "prod", "produciton", ""])(
    "refuses NODE_ENV=%s rather than reading it as development",
    async (nodeEnv) => {
      setEnvironment({ NODE_ENV: nodeEnv });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      expect(() => getConfig()).toThrow();
    },
  );

  it("refuses to run outside production once APP_BASE_URL names a real host", async () => {
    setEnvironment({
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/NODE_ENV is not production/);
  });

  it.each(["http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "still starts outside production on the loopback URL %s",
    async (baseUrl) => {
      setEnvironment({ APP_BASE_URL: baseUrl });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      expect(getConfig().isProduction).toBe(false);
    },
  );

  it.each([
    "development-only-secret-change-me-1234567890",
    "replace-with-at-least-32-random-characters",
  ])("refuses the published placeholder secret %s in production", async (secret) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: secret,
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/published placeholder/);
  });

  it("fails closed when Google mode is missing provider settings", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "google",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow();
  });

  it("normalizes an allowlist when both methods are configured", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "both",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      ALLOWED_EMAILS: " Owner@Example.com, second@example.com ",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    const config = getConfig();
    expect(config.authMode).toBe("both");
    expect(config.registration).toMatchObject({ kind: "list" });
    const rule = config.registration as {
      kind: "list";
      emails: Set<string>;
      domains: Set<string>;
    };
    expect([...rule.emails]).toEqual(["owner@example.com", "second@example.com"]);
    expect([...rule.domains]).toEqual([]);
  });
});

/**
 * The `_FILE` form, over its six names.
 *
 * Every case reads the value back through whatever actually consumes it rather
 * than through the resolver, because the defect worth catching is a secret that
 * resolved and then did not arrive: `getPool` and `directConnectionString` read
 * the connection string for themselves, and `npm run db:migrate` never calls
 * `getConfig` at all.
 */
describe("a secret held in a file", () => {
  const production = {
    NODE_ENV: "production",
    APP_BASE_URL: "https://simple-balance.example.com",
    DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
    AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
    AUTH_MODE: "local",
  } as const;

  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "simple-balance-secret-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const secretFile = (name: string, contents: string) => {
    const path = join(directory, name);
    writeFileSync(path, contents, "utf8");
    return path;
  };

  const configFor = async () => (await import("../src/server/config.js")).getConfig();

  /**
   * One row per file-backed name, each naming the environment that name needs
   * around it and the consumer that has to end up holding the value.
   */
  const consumers = [
    {
      name: "AUTH_SECRET",
      value: "a-file-backed-secret-that-is-at-least-32-characters",
      around: { ...production, AUTH_SECRET: undefined },
      read: async () => (await configFor()).authSecret,
    },
    {
      name: "DATABASE_URL",
      value: "postgresql://simple_balance:from-a-file@database.example/simple_balance",
      around: { ...production, DATABASE_URL: undefined },
      read: async () => (await configFor()).databaseUrl,
    },
    {
      name: "DIRECT_DATABASE_URL",
      value: "postgresql://simple_balance:direct@database-direct.example/simple_balance",
      around: production,
      read: async () => (await import("../src/server/db/client.js")).directConnectionString(),
    },
    {
      name: "SMTP_PASSWORD",
      value: "an-app-password-from-a-file",
      around: {
        ...production,
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "Simple Balance <balance@example.com>",
        SMTP_USERNAME: "balance@example.com",
      },
      read: async () => (await configFor()).mail?.password,
    },
    {
      name: "GOOGLE_CLIENT_SECRET",
      value: "a-google-secret-from-a-file",
      around: {
        ...production,
        AUTH_MODE: "both",
        GOOGLE_CLIENT_ID: "google-client",
        ALLOWED_EMAILS: "owner@example.com",
      },
      read: async () => (await configFor()).googleClientSecret,
    },
    {
      name: "SETUP_TOKEN",
      value: "a-setup-code-from-a-file",
      around: production,
      read: async () => (await import("../src/server/setup-token.js")).getOwnerSetupToken(),
    },
  ] as const;

  it.each(consumers)("reaches whatever reads $name", async ({ name, value, around, read }) => {
    setEnvironment({ ...around, [`${name}_FILE`]: secretFile(name, `${value}\n`) });
    vi.resetModules();

    await expect(read()).resolves.toBe(value);
  });

  it("strips one trailing newline and leaves anything else alone", async () => {
    // Asserted through the signing key rather than through the resolver: a
    // `trim()` here and a file written by `echo` would sign sessions with a
    // different key than the same secret typed into the environment, and
    // nothing about the running deployment would say so.
    const secret = "a-file-backed-secret-that-ends-in-a-space ";
    setEnvironment({
      ...production,
      AUTH_SECRET: undefined,
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", `${secret}\r\n`),
    });
    vi.resetModules();

    expect((await configFor()).authSecret).toBe(secret);
  });

  it("refuses to start when a name is set both ways", async () => {
    setEnvironment({
      ...production,
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", "a-second-secret-that-is-at-least-32-characters"),
    });
    vi.resetModules();

    await expect(configFor()).rejects.toThrow(/AUTH_SECRET and AUTH_SECRET_FILE are both set/);
  });

  it("does not count an empty assignment as the name being set", async () => {
    // `.env.example` ships `AUTH_SECRET=` and the compose file ships
    // `SETUP_TOKEN: ${SETUP_TOKEN:-}`, so a truthiness check on the other half
    // of this rule would refuse a deployment that is working today.
    const secret = "a-file-backed-secret-that-is-at-least-32-characters";
    setEnvironment({
      ...production,
      AUTH_SECRET: "",
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", secret),
    });
    vi.resetModules();

    expect((await configFor()).authSecret).toBe(secret);
  });

  it("refuses to start when the file is not there, and names it", async () => {
    const path = join(directory, "absent");
    setEnvironment({ ...production, AUTH_SECRET: undefined, AUTH_SECRET_FILE: path });
    vi.resetModules();

    await expect(configFor()).rejects.toThrow(
      `AUTH_SECRET_FILE names ${path}, which could not be read.`,
    );
  });

  it("refuses to start on a file holding nothing but a newline", async () => {
    setEnvironment({
      ...production,
      AUTH_SECRET: undefined,
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", "\n"),
    });
    vi.resetModules();

    await expect(configFor()).rejects.toThrow(/which is empty/);
  });

  it("keeps a resolved connection string out of the environment", async () => {
    const url = "postgresql://simple_balance:from-a-file@database.example/simple_balance";
    setEnvironment({
      ...production,
      DATABASE_URL: undefined,
      DATABASE_URL_FILE: secretFile("DATABASE_URL", `${url}\n`),
    });
    vi.resetModules();
    const { directConnectionString } = await import("../src/server/db/client.js");

    expect((await configFor()).databaseUrl).toBe(url);
    // The point of the whole form. A Node diagnostic report serialises
    // `process.env`, so the one thing that must not happen is the resolved
    // value being handed back to the environment on the way past.
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(directConnectionString()).toBe(url);
  });

  it("resolves for a process that never reads the configuration at all", async () => {
    // `npm run db:migrate` calls `runMigrations`, which reaches
    // `directConnectionString` and never calls `getConfig`. Resolving on first
    // read is what lets that script work with a `_FILE` value without knowing
    // the resolver exists.
    const url = "postgresql://simple_balance:from-a-file@database.example/simple_balance";
    setEnvironment({ DATABASE_URL_FILE: secretFile("DATABASE_URL", `${url}\n`) });
    vi.resetModules();
    const { directConnectionString } = await import("../src/server/db/client.js");

    expect(directConnectionString()).toBe(url);
  });

  it("still refuses a setup code that is too short once the file is read", async () => {
    setEnvironment({ ...production, SETUP_TOKEN_FILE: secretFile("SETUP_TOKEN", "  short  \n") });
    vi.resetModules();
    const { getOwnerSetupToken } = await import("../src/server/setup-token.js");

    await expect(getOwnerSetupToken()).rejects.toThrow(/at least 16 characters/);
  });
});
