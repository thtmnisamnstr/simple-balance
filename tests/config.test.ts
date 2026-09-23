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
  // Monetization. Both halves default to off, so every case that does not name
  // one of these is also a case proving an unconfigured deployment sells
  // nothing and shows nothing.
  "SB_BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY_ID",
  "STRIPE_PRICE_YEARLY_ID",
  "ADSENSE_CLIENT_ID",
  "ADSENSE_BANNER_SLOT_ID",
  "ADSENSE_FOOTER_SLOT_ID",
  "ADSENSE_CONSENT_MANAGED",
  // Required whenever AdSense is configured, so every ad case has to name it.
  "PRIVACY_POLICY_URL",
  "STRIPE_SECRET_KEY_FILE",
  "STRIPE_WEBHOOK_SECRET_FILE",
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
   * A typo in a tuning knob warns and falls back; it does not stop the ledger.
   *
   * The bounded integers used to fall back silently, and were read at the moment
   * they were wanted: `CSV_MAX_ROWS` inside an import, the recurrence limits
   * inside a tick. A typo therefore had no symptom at all, and the operator's
   * number was silently not the one in force.
   *
   * They are read at startup now, where an orchestrator is still watching, and
   * each one that cannot be used says so by name. What they do not do is refuse:
   * a mistyped cap would stop a ledger from starting, on a value the previous
   * release accepted, which is an outage bought for a tuning knob. The warning
   * is what the operator was missing.
   */
  it.each([
    ["CSV_MAX_ROWS", "1O000", 10_000],
    ["CSV_MAX_BYTES", "10 MB", 10_485_760],
    ["RECURRENCE_TICK_SECONDS", "0", 300],
    ["RECURRENCE_CATCH_UP_LIMIT", "5000", 50],
    ["RECURRENCE_CLAIM_LIMIT", "-1", 500],
    ["DATABASE_POOL_SIZE", "many", 10],
  ])("warns and falls back when %s is not a whole number in range", async (name, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(() => getConfig()).not.toThrow();
    // Named, with the value it could not use and the one it fell back to, so an
    // operator scanning a startup log can act without reading the source.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(value)));
    warn.mockRestore();
  });

  /**
   * The half that matters for an upgrade: 0.1.5 started on every one of these
   * and 0.1.6 has to as well. `DATABASE_POOL_SIZE` is in the list because it is
   * the one that used to throw — it now falls back with the rest, which is
   * strictly more permissive and so cannot break a deployment that worked.
   */
  it.each([
    "CSV_MAX_ROWS",
    "CSV_MAX_BYTES",
    "RECURRENCE_TICK_SECONDS",
    "RECURRENCE_CATCH_UP_LIMIT",
    "RECURRENCE_CLAIM_LIMIT",
    "DATABASE_POOL_SIZE",
  ])("starts with %s set to nonsense, as the release before it did", async (name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
      [name]: "not-a-number",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).not.toThrow();
    warn.mockRestore();
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
 * The `_FILE` form, over all nine of its names.
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

  /** Billing refuses half a configuration, so a Stripe row needs the other four. */
  const stripeAround = {
    STRIPE_SECRET_KEY: "sk_test_around",
    STRIPE_PUBLISHABLE_KEY: "pk_test_around",
    STRIPE_WEBHOOK_SECRET: "whsec_around",
    STRIPE_PRICE_MONTHLY_ID: "price_monthly",
    STRIPE_PRICE_YEARLY_ID: "price_yearly",
  } as const;

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
    {
      name: "STRIPE_SECRET_KEY",
      value: "sk_test_from_a_file",
      around: { ...production, ...stripeAround, STRIPE_SECRET_KEY: undefined },
      read: async () => (await configFor()).billing?.secretKey,
    },
    {
      name: "STRIPE_WEBHOOK_SECRET",
      value: "whsec_from_a_file",
      around: { ...production, ...stripeAround, STRIPE_WEBHOOK_SECRET: undefined },
      read: async () => (await configFor()).billing?.webhookSecret,
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

  /**
   * Both set: the environment wins and the file is ignored, loudly.
   *
   * This refused for a while, which reads better and would have stopped a
   * deployment on upgrade over a variable that had never once been read — these
   * `_FILE` names did nothing at all in 0.1.5, so anybody who set one out of
   * habit from the PostgreSQL official image has been running on the
   * environment variable all along. Keeping that precedence is what makes the
   * upgrade clean; the warning is what stops it being a silent rule.
   */
  it("uses the environment and warns when a name is set both ways", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnvironment({
      ...production,
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", "a-second-secret-that-is-at-least-32-characters"),
    });
    vi.resetModules();

    // `production` sets AUTH_SECRET, and that is the one in force.
    expect((await configFor()).authSecret).toBe(production.AUTH_SECRET);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("AUTH_SECRET and AUTH_SECRET_FILE are both set"),
    );
    warn.mockRestore();
  });

  /**
   * The upgrade case stated on its own, because it is the one somebody actually
   * has: 0.1.5 ignored `NAME_FILE` entirely, so a deployment carrying both
   * started. It still starts.
   */
  it("starts with both set, as the release before it did", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnvironment({
      ...production,
      AUTH_SECRET_FILE: secretFile("AUTH_SECRET", "a-second-secret-that-is-at-least-32-characters"),
      DATABASE_URL_FILE: secretFile("DATABASE_URL", "postgresql://other@example/other"),
    });
    vi.resetModules();

    await expect(configFor()).resolves.toBeDefined();
    warn.mockRestore();
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
    // The point of the whole form. A Node diagnostic report serializes
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

/**
 * The gate every monetization feature asks about, as a table rather than as
 * prose in three places.
 *
 * Two settings make three states rather than four, and the middle one is the
 * reason they are two settings: a deployment that has stopped selling still
 * reaches Stripe, because the subscriptions people are already paying for go on
 * emitting webhooks and refusing to listen would leave this ledger's idea of
 * who has paid drifting away from Stripe's. `docs/monetization.md` carries the
 * same table for an operator; this is the copy that fails when the code stops
 * agreeing with it.
 */
describe("what a deployment sells and shows", () => {
  const production = {
    NODE_ENV: "production",
    APP_BASE_URL: "https://simple-balance.example.com",
    DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
    AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
    AUTH_MODE: "local",
  } as const;
  const stripe = {
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_PUBLISHABLE_KEY: "pk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_PRICE_MONTHLY_ID: "price_monthly",
    STRIPE_PRICE_YEARLY_ID: "price_yearly",
  } as const;
  const adsense = {
    ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
    ADSENSE_BANNER_SLOT_ID: "9876543210",
    PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
  } as const;

  const cases = [
    ["nothing configured", {}, { stripe: false, billing: false, ads: false }],
    ["Stripe present, not selling", stripe, { stripe: true, billing: false, ads: false }],
    [
      "Stripe present and selling",
      { ...stripe, SB_BILLING_ENABLED: "true" },
      { stripe: true, billing: true, ads: false },
    ],
    ["ads alone", adsense, { stripe: false, billing: false, ads: true }],
    // The wind-down state, and the row the table was missing. Stripe is still
    // configured and subscribers are still being charged, but nothing is for
    // sale — so nobody is held to a limit, and the ad gate has to read this as
    // "not a free plan" rather than as "not on Plus". Written the second way,
    // every paying subscriber on a paused deployment would be shown ads.
    ["both, wound down", { ...stripe, ...adsense }, { stripe: true, billing: false, ads: true }],
    [
      "both, selling",
      { ...stripe, ...adsense, SB_BILLING_ENABLED: "true" },
      { stripe: true, billing: true, ads: true },
    ],
  ] as const;

  it.each(cases)("%s", async (_name, environment, expected) => {
    setEnvironment({ ...production, ...environment });
    vi.resetModules();
    const { stripeConfigured, billingEnabled, adsEnabled } =
      await import("../src/server/config.js");

    expect({
      stripe: stripeConfigured(),
      billing: billingEnabled(),
      ads: adsEnabled(),
    }).toEqual(expected);
  });

  it("says so when Stripe is configured and nothing is for sale", async () => {
    // The likely slip in a two-axis design, and otherwise completely silent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setEnvironment({ ...production, ...stripe });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      getConfig();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SB_BILLING_ENABLED"));
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when the deployment is actually selling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setEnvironment({ ...production, ...stripe, SB_BILLING_ENABLED: "true" });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      getConfig();

      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("SB_BILLING_ENABLED"));
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * An ad goes to somebody on a limited plan, and nobody is on one unless a
   * plan is for sale — so AdSense ids alone widen the policy and serve ads.txt
   * while showing nobody an ad, which looks exactly like having no inventory.
   * Warned, never refused: trying the ads settings before selling is legitimate.
   */
  it("says so when AdSense is configured and nothing is for sale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const environment of [adsense, { ...stripe, ...adsense }]) {
        warn.mockClear();
        setEnvironment({ ...production, ...environment });
        vi.resetModules();
        const { getConfig } = await import("../src/server/config.js");
        expect(() => getConfig()).not.toThrow();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("nobody is shown an ad"));
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing about ads where a plan is for sale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setEnvironment({ ...production, ...stripe, ...adsense, SB_BILLING_ENABLED: "true" });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      getConfig();

      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("nobody is shown an ad"));
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a live key outside production even when it arrives through a file", async () => {
    // The `_FILE` form must not be a way around a refusal. Pointing a
    // development machine at a live key is the mistake with no symptom until it
    // has charged somebody, and the indirection must not launder it.
    const directory = mkdtempSync(join(tmpdir(), "simple-balance-live-"));
    try {
      const file = join(directory, "secret");
      writeFileSync(file, "sk_live_through_a_file");
      setEnvironment({
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:5173",
        STRIPE_PUBLISHABLE_KEY: "pk_live_example",
        STRIPE_WEBHOOK_SECRET: "whsec_example",
        STRIPE_PRICE_MONTHLY_ID: "price_monthly",
        STRIPE_PRICE_YEARLY_ID: "price_yearly",
        STRIPE_SECRET_KEY_FILE: file,
      });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");

      expect(() => getConfig()).toThrow(/live key and NODE_ENV/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The three rows of the same table that end in a refusal rather than a state.
  const refusals = [
    ["selling with no way to charge", { SB_BILLING_ENABLED: "true" }, /no Stripe settings/],
    ["half the Stripe settings", { STRIPE_SECRET_KEY: "sk_test_x" }, /half configured/],
    [
      "half the AdSense settings",
      { ADSENSE_CLIENT_ID: "ca-pub-1", PRIVACY_POLICY_URL: "https://smpl.money/privacy/" },
      /must be set together/,
    ],
    [
      "AdSense with no privacy policy",
      { ADSENSE_CLIENT_ID: "ca-pub-1234567890123456", ADSENSE_BANNER_SLOT_ID: "9876543210" },
      /PRIVACY_POLICY_URL must be set/,
    ],
  ] as const;

  it.each(refusals)("refuses to start on %s", async (_name, environment, message) => {
    setEnvironment({ ...production, ...environment });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");

    expect(() => getConfig()).toThrow(message);
  });

  it("leaves an unconfigured deployment with no billing and no ads on the config", async () => {
    // The upgrade case, and the one every existing installation lands in: a
    // release that added two paid features must not change what an untouched
    // .env does.
    setEnvironment(production);
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    const config = getConfig();

    expect(config.billing).toBeUndefined();
    expect(config.ads).toBeUndefined();
  });
});
