import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * Two rows from `operations.md` §What is checked, items 1 and 3.
 *
 * The guide ranks them first and third by how cheap the check would be, and
 * item 3 is the one worth having first: its code half is already done — both
 * scheduled senders pass the notification's id — and nothing keeps it done.
 * That is exactly how the outbound-connection row ended up denied in two places
 * while a third cited the test that held it, which the guide calls "the worst
 * state of all".
 */

/**
 * Every environment variable either half of this file touches.
 *
 * Named exhaustively and cleared between cases rather than merely set, for the
 * reason `code/testing.md` 5.4 gives: file parallelism is off, so a variable
 * one case leaves behind is still set for whatever runs next, and a default
 * read with another case's value still in the environment is not a default.
 */
const KEYS = [
  "NODE_ENV",
  "AUTH_MODE",
  "PORT",
  "LOG_LEVEL",
  "TRUST_PROXY",
  "METRICS_ENABLED",
  "METRICS_TOKEN",
  "SB_CSP_REPORT_ONLY",
  "RECURRENCE_SCHEDULER",
  "CSV_MAX_BYTES",
  "CSV_MAX_ROWS",
  "DATABASE_POOL_SIZE",
  "RECURRENCE_TICK_SECONDS",
  "RECURRENCE_CATCH_UP_LIMIT",
  "RECURRENCE_CLAIM_LIMIT",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SSL",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "MAIL_FROM",
  "ADSENSE_CLIENT_ID",
  "ADSENSE_BANNER_SLOT_ID",
  "ADSENSE_CONSENT_MANAGED",
  "PRIVACY_POLICY_URL",
  "SB_BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY_ID",
  "STRIPE_PRICE_YEARLY_ID",
  "ALLOWED_EMAILS",
  "DATABASE_URL",
  "APP_BASE_URL",
  "AUTH_SECRET",
] as const;

const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

/** What a deployment has to set before a given setting is reachable at all. */
type Reachable = Partial<Record<(typeof KEYS)[number], string>>;

/** A row of the deployment table, and how to ask the server what it does. */
type Row =
  /** Read it back from the running configuration, with whatever else it needs set. */
  | { readonly read: () => Promise<unknown>; readonly needs?: Reachable }
  /** Nothing in `src/` answers for it, and here is who does. */
  | { readonly elsewhere: string };

/** Ads are only parsed once an account is configured, and then a policy is required. */
const ADS_CONFIGURED: Reachable = {
  ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
  ADSENSE_BANNER_SLOT_ID: "1234567890",
  PRIVACY_POLICY_URL: "https://example.com/privacy",
};

/** Billing is only parsed once the five Stripe settings are there. */
const STRIPE_CONFIGURED: Reachable = {
  STRIPE_SECRET_KEY: "sk_test_configured",
  STRIPE_PUBLISHABLE_KEY: "pk_test_configured",
  STRIPE_WEBHOOK_SECRET: "whsec_configured",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
};

const config = async () => {
  vi.resetModules();
  const { getConfig } = await import("../src/server/config.js");
  return getConfig();
};

const limits = async () => {
  vi.resetModules();
  return import("../src/server/config-limits.js");
};

const ROWS: Readonly<Record<string, Row>> = {
  AUTH_MODE: { read: async () => (await config()).authMode },
  PORT: { read: async () => (await config()).port },
  LOG_LEVEL: { read: async () => (await config()).logLevel },
  TRUST_PROXY: { read: async () => (await config()).trustProxy },
  METRICS_ENABLED: { read: async () => (await config()).metrics.enabled },
  SB_CSP_REPORT_ONLY: { read: async () => (await config()).cspReportOnly },
  RECURRENCE_SCHEDULER: { read: async () => (await config()).recurrenceSchedulerEnabled },
  CSV_MAX_BYTES: { read: async () => (await limits()).configuredCsvMaxBytes() },
  CSV_MAX_ROWS: { read: async () => (await limits()).configuredCsvMaxRows() },
  DATABASE_POOL_SIZE: { read: async () => (await limits()).configuredDatabasePoolSize() },
  RECURRENCE_TICK_SECONDS: {
    read: async () => (await limits()).configuredRecurrenceTickSeconds(),
  },
  RECURRENCE_CATCH_UP_LIMIT: {
    read: async () => (await limits()).configuredRecurrenceCatchUpLimit(),
  },
  RECURRENCE_CLAIM_LIMIT: { read: async () => (await limits()).configuredRecurrenceClaimLimit() },
  SMTP_SSL: {
    needs: { SMTP_HOST: "smtp.example.com", MAIL_FROM: "ledger@example.com" },
    read: async () => (await config()).mail?.ssl,
  },
  ADSENSE_CONSENT_MANAGED: {
    needs: ADS_CONFIGURED,
    read: async () => (await config()).ads?.consentManaged,
  },
  SB_BILLING_ENABLED: {
    needs: STRIPE_CONFIGURED,
    read: async () => (await config()).billing?.enforcing,
  },
  DIRECT_DATABASE_URL: {
    elsewhere:
      "The documented default is the name of another variable rather than a value, which is what the row says: it falls back to `DATABASE_URL`. There is no literal for this to compare.",
  },
  SB_API_ORIGIN: { elsewhere: "nginx's, set on the frontend service in `deploy/`." },
  SB_FRONTEND_PORT: { elsewhere: "nginx's, and the readiness probe and Service follow it." },
  SB_MAX_UPLOAD_SIZE: { elsewhere: "nginx's `client_max_body_size`, in `deploy/`." },
  SB_BILLING_CONFIGURED: {
    elsewhere:
      "nginx's, derived by the compose recipe from `STRIPE_PUBLISHABLE_KEY` and by the chart from its own values, so the two cannot disagree.",
  },
  SB_ADS_CONFIGURED: { elsewhere: "nginx's, derived the same way from `ADSENSE_CLIENT_ID`." },
  SB_TRUSTED_PROXY_CIDR: {
    elsewhere: "nginx's `set_real_ip_from`, validated by the frontend container's own entrypoint.",
  },
  SB_REAL_IP_RECURSIVE: { elsewhere: "nginx's `real_ip_recursive`, beside it." },
};

/** Every row of every table in `docs/deployment.md` that states a literal default. */
function documented(): { variable: string; value: string }[] {
  const guide = readFileSync("docs/deployment.md", "utf8");
  const rows = [...guide.matchAll(/^\| `([A-Z_]+)` \| `([^`]+)` \|/gm)].map((match) => ({
    variable: match[1]!,
    value: match[2]!,
  }));
  // Deduplicated, because `SB_CSP_REPORT_ONLY` is documented twice — once for
  // the server that registers the report route and once for the nginx
  // container that serves the page. Two rows, one setting, one default; a
  // disagreement between the two copies is caught here as a duplicate.
  const seen = new Map<string, string>();
  for (const row of rows) {
    const already = seen.get(row.variable);
    if (already !== undefined && already !== row.value) {
      throw new Error(
        `docs/deployment.md gives ${row.variable} two defaults: ${already}, ${row.value}`,
      );
    }
    seen.set(row.variable, row.value);
  }
  return [...seen].map(([variable, value]) => ({ variable, value }));
}

describe("the deployment table's defaults", () => {
  it("name every variable this knows how to ask about, and no others", () => {
    const rows = documented();
    // A table that stopped parsing would compare nothing and pass.
    expect(rows.length, "the deployment tables parsed").toBeGreaterThan(15);
    expect(
      rows.map((row) => row.variable).sort(),
      "a documented default needs a reader, or the argument for not having one",
    ).toEqual(Object.keys(ROWS).sort());
  });

  it.each(documented().filter(({ variable }) => "read" in (ROWS[variable] ?? { elsewhere: "" })))(
    "are what the server does with nothing set: $variable",
    async ({ variable, value }) => {
      const row = ROWS[variable]!;
      if (!("read" in row)) throw new Error(`${variable} has no reader`);
      // `NODE_ENV` is the one thing deliberately set: production demands a
      // database URL, a base URL and a secret, and asking for a default in that
      // state would be asking a question about those three instead.
      setEnvironment({ NODE_ENV: "development", ...row.needs });
      expect(String(await row.read()), `${variable} is documented as ${value}`).toBe(value);
    },
  );
});

/**
 * Item 3: a failed send names the notification row.
 *
 * `mail.ts` logs `Could not send ${message.about}`, and the generic `about` a
 * message carries is its kind — "a template reminder" — which on a deployment
 * with forty templates says nothing about which one. Both scheduled senders
 * override it after the spread with the row's own id, and the override being
 * after the spread is the load-bearing half: moved above it, the message's own
 * kind wins and the line goes back to saying nothing.
 */
describe("a failed scheduled send", () => {
  const notifications = sourceFiles("src/server/services").find((file) =>
    file.path.endsWith("/notifications.ts"),
  )!;

  it("names the row rather than the kind of message it was", () => {
    const calls = [...notifications.code.matchAll(/sendMail\(\{([\s\S]*?)\n  \}\);/g)].map(
      (match) => match[1]!,
    );
    expect(calls.length, "both scheduled senders were found").toBe(2);
    for (const call of calls) {
      const about = /about:\s*`([^`]*)`/.exec(call);
      expect(
        about,
        `a sendMail in notifications.ts states no about: ${call.slice(0, 80)}`,
      ).not.toBe(null);
      // A template literal interpolating an id, not a sentence. The two the
      // product has are `recurrence proposal ${id}` and `template reminder
      // ${id}`.
      expect(about![1], "the about carries an id").toMatch(/\$\{[^}]*[Ii]d\}/);
      // After the spread, or the message's own kind overwrites it.
      expect(call.indexOf("...message"), "the message is spread in").toBeGreaterThan(-1);
      expect(call.indexOf("about:"), "and the about comes after it").toBeGreaterThan(
        call.indexOf("...message"),
      );
    }
  });

  it("carries that name into the log line", async () => {
    vi.doMock("nodemailer", () => ({
      createTransport: () => ({
        sendMail: async () => {
          throw Object.assign(new Error("Relay refused"), { responseCode: 550 });
        },
      }),
    }));
    setEnvironment({
      NODE_ENV: "development",
      SMTP_HOST: "smtp.example.com",
      MAIL_FROM: "ledger@example.com",
    });
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendMail } = await import("../src/server/mail.js");

    const delivered = await sendMail({
      to: "person@example.com",
      subject: "Reminder: Rent",
      body: "body",
      about: "template reminder 11111111-2222-3333-4444-555555555555",
    });

    expect(delivered, "the send failed").toBe(false);
    const lines = logged.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines, "the id a sender passed reaches the log").toContain(
      "11111111-2222-3333-4444-555555555555",
    );
    vi.doUnmock("nodemailer");
  });
});
