import { z } from "zod";
import { readSecret, resolveFileBackedSecrets } from "./config-files.js";
import { assertConfiguredLimits } from "./config-limits.js";

/**
 * The four `LOG_LEVEL` accepts, in the order severity increases.
 *
 * Spelled here rather than in `log.ts` because the dependency runs that way:
 * `log.ts` already reads `getConfig().logLevel`, so the level's home is the
 * layer underneath it. It was three hand-written copies — this type, the enum
 * that parses the variable, and `ORDER` in `log.ts` — agreeing by coincidence.
 */
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

const ORIGIN_RULE =
  "APP_BASE_URL must be an exact HTTP(S) origin with no credentials, path, query, or fragment";

const productionBaseUrlSchema = z.string().superRefine((value, context) => {
  // `new URL` throws on a host with no scheme, on an empty string, and on a
  // protocol-relative value, and the throw escaped the parse: the operator got a
  // bare "Invalid URL" stack instead of the rule this schema exists to state.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: ORIGIN_RULE });
    return;
  }
  if (
    !/^https?:\/\/[^\s\\/@?#]+\/?$/i.test(value) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    context.addIssue({ code: "custom", message: ORIGIN_RULE });
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    context.addIssue({
      code: "custom",
      message:
        "APP_BASE_URL must use HTTPS in production (HTTP is allowed only on localhost or a loopback IP)",
    });
  }
});

/**
 * Values that look like a secret, pass the length check, and are printed in
 * public: the string this file falls back to outside production, and whatever
 * `.env.example` last carried. Length alone cannot tell them apart from a real
 * one, and a deployment signing sessions with a documented string is signing
 * them with a key everybody already has.
 */
const publicAuthSecrets = new Set([
  "development-only-secret-change-me-1234567890",
  "replace-with-at-least-32-random-characters",
  "change-me",
]);

const productionAuthSecretSchema = z
  .string()
  .min(32)
  .refine((value) => !publicAuthSecrets.has(value.trim()), {
    message:
      "AUTH_SECRET is a published placeholder. Generate one, for example with `openssl rand -base64 32`.",
  });

const productionSchema = z.object({
  DATABASE_URL: z.string().url(),
  APP_BASE_URL: productionBaseUrlSchema,
  AUTH_SECRET: productionAuthSecretSchema,
});

// ALLOWED_EMAILS is not checked for length here. A minimum of three characters
// made sense when every entry had to be an address; it rejects `*`, which is
// now the documented way to say anybody. Whether the list admits somebody is
// checked below, where the message can say what to do about it.
const googleAuthSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});

/**
 * Refuses to start a development-mode process that has been told where it
 * lives on the internet.
 *
 * Forgetting NODE_ENV is the one misconfiguration with no symptom: the server
 * comes up, serves, and signs in, with the setup code, the rate limiter and
 * secure cookies all quietly off. An APP_BASE_URL that is not loopback is the
 * one piece of configuration only a real deployment has, so it is the signal
 * worth failing on rather than warning about.
 */
function assertNotADeployment(baseUrl: string | undefined) {
  if (!baseUrl) return;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return;
  }
  if (isLoopbackHostname(hostname)) return;
  throw new Error(
    `NODE_ENV is not production but APP_BASE_URL names ${hostname}. ` +
      "The first-run setup code, sign-in rate limiting and secure cookies are " +
      "all off outside production. Either set NODE_ENV=production and give " +
      "APP_BASE_URL the HTTPS origin a proxy in front terminates, or point " +
      "APP_BASE_URL at localhost if this really is a development machine.",
  );
}

// Imported and re-exported rather than only re-exported: this module names
// both below, and `export ... from` puts neither in local scope.
import { authModes, type AuthMode } from "../shared/domain.js";
export { authModes, type AuthMode };

export type AppConfig = {
  databaseUrl: string;
  baseUrl: string;
  authSecret: string;
  authMode: AuthMode;
  localAuthEnabled: boolean;
  googleAuthEnabled: boolean;
  googleClientId?: string;
  googleClientSecret?: string;
  registration: RegistrationRule;
  /**
   * Where to send mail from, when there is anywhere to send it.
   *
   * Undefined is the ordinary case: a deployment with no mail server attached.
   * Everything that would need to send a message is switched off rather than
   * failing, which is what keeps a single-user install and a development
   * machine working with no configuration at all.
   */
  mail?: MailSettings;
  /**
   * How this deployment reaches Stripe, when it charges for anything.
   *
   * Undefined is the default and what every existing deployment upgrades into:
   * no plan, no limit, no outbound connection. See `BillingSettings` for why
   * "configured" and "selling" are two questions rather than one.
   */
  billing?: BillingSettings;
  /**
   * Which AdSense inventory to render, when a deployment shows any.
   *
   * Undefined is the default, and it is the only state in which the browser
   * bundle keeps a `default-src 'self'` content security policy.
   */
  ads?: AdSettings;
  port: number;
  logLevel: LogLevel;
  trustProxy: boolean;
  /**
   * Whether this process proposes recurring transactions.
   *
   * On by default, so the documented single container keeps working with no
   * extra configuration. Turn it off on web replicas when a separate scheduler
   * container owns the job.
   *
   * Leaving it on everywhere is safe for the three jobs that claim their work:
   * a recurrence and a reminder are taken with `for update skip locked` and a
   * retention sweep deletes rows only once. The billing reconciliation sweep
   * claims nothing — it re-reads from Stripe and writes what Stripe says, which
   * is idempotent — so every replica running it re-reads the same rows. That
   * costs Stripe requests rather than correctness, and it is the reason to turn
   * this off on web replicas in a deployment that sells a plan.
   */
  recurrenceSchedulerEnabled: boolean;
  /**
   * Whether this process answers `GET /metrics`, and what it demands first.
   *
   * Off unless asked for. The figures are not somebody's ledger — no label
   * carries a user, an account or an amount — but they do say how many
   * transactions a deployment writes and how deep its queues are, and a
   * self-hosted box is often one port away from the internet. An operator who
   * wants the endpoint says so; nobody gets it by upgrading.
   *
   * `token` is optional because a Kubernetes deployment scraping over a private
   * network with a NetworkPolicy in front is a real setup and a bearer token
   * would be ceremony there. Where it is set, the endpoint is the only thing in
   * this product that authenticates with a static credential, which is why it
   * is compared in constant time and is a file-backed secret like the rest.
   */
  metrics: { enabled: boolean; token?: string };
  /**
   * Whether the content security policy is reported on rather than enforced.
   *
   * A rehearsal for the plan tab alone, for the operator who has just turned
   * billing on and wants to know what their deployment would block before it
   * blocks it. Every other page goes on enforcing, so this is a narrow hole
   * rather than an open door — but it is still a hole, and not a state to leave
   * a deployment in.
   */
  cspReportOnly: boolean;
  isProduction: boolean;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  // `readSecret` memoizes, so this call buys exactly one thing: an unreadable
  // secret file, or a name set both ways, refuses at startup rather than at the
  // first query. That is what the "Validating at startup" rule in
  // `docs/standards/operations.md` asks of every other setting here.
  resolveFileBackedSecrets();
  // The bounded integers are read here rather than left to the code that wants
  // them, for the same reason. `CSV_MAX_ROWS` is otherwise read inside an
  // import and the recurrence limits inside a tick, so a typo in one was found
  // by nobody: it fell back to the default and the deployment ran on a number
  // its operator had not chosen. Both entrypoints call this function first.
  assertConfiguredLimits();
  // Parsed strictly, and against a closed set, because comparing to the string
  // "production" turns every other spelling into development silently: the
  // setup code is not demanded, sign-in attempts are not rate limited, and
  // cookies are not marked secure. `NODE_ENV=Production` had no symptom.
  const nodeEnv = z
    .enum(["production", "development", "test"], {
      error: () => "NODE_ENV must be production, development or test",
    })
    .parse((process.env.NODE_ENV ?? "development").toLowerCase());
  const isProduction = nodeEnv === "production";
  const authMode = z
    .enum(authModes, {
      error: () => `AUTH_MODE must be one of ${authModes.join(", ")}`,
    })
    .parse((process.env.AUTH_MODE ?? "local").toLowerCase());
  const localAuthEnabled = authMode === "local" || authMode === "both";
  const googleAuthEnabled = authMode === "google" || authMode === "both";
  const portRule = "PORT must be a whole number between 1 and 65535";
  const port = z.coerce
    .number({ error: () => portRule })
    .int({ error: () => portRule })
    .min(1, { error: () => portRule })
    .max(65535, { error: () => portRule })
    .parse(process.env.PORT ?? 3000);
  const logLevel = z
    .enum(logLevels, {
      error: () => "LOG_LEVEL must be debug, info, warn or error",
    })
    .parse((process.env.LOG_LEVEL ?? "info").toLowerCase());
  const trustProxy = z
    .enum(["true", "false"], { error: () => "TRUST_PROXY must be true or false" })
    .transform((value) => value === "true")
    .parse((process.env.TRUST_PROXY ?? "false").toLowerCase());
  // Parsed strictly rather than treating anything unrecognized as off. A
  // misspelling here has no symptom: the process starts, serves, and quietly
  // proposes nothing until somebody notices a year of missing rent.
  const recurrenceSchedulerEnabled = z
    .enum(["true", "false"], {
      error: () => "RECURRENCE_SCHEDULER must be true or false",
    })
    .transform((value) => value === "true")
    .parse((process.env.RECURRENCE_SCHEDULER ?? "true").toLowerCase());
  const metricsEnabled = z
    .enum(["true", "false"], {
      error: () => "METRICS_ENABLED must be true or false",
    })
    .transform((value) => value === "true")
    .parse((process.env.METRICS_ENABLED ?? "false").toLowerCase());
  // A rehearsal switch for the plan tab's policy, and off by default. It exists
  // because that policy is Stripe's published list plus four hosts of our own,
  // and nobody has yet watched a live account's payment form to see which of
  // those it contacts: an operator turns this on, opens the page, reads what
  // would have been blocked, and turns it off again.
  //
  // It reaches that one page and no other, and that includes the pages that
  // carry ads, whose widened policy is just as new. Declined there on purpose
  // rather than because there is nothing to learn: every one of those pages
  // renders somebody's balances, and taking the defense off all of them to
  // rehearse an ad is the wrong trade. An ad the policy refuses is read from the
  // browser console on a page that shows one, while that page goes on enforcing.
  const cspReportOnly = z
    .enum(["true", "false"], {
      error: () => "SB_CSP_REPORT_ONLY must be true or false",
    })
    .transform((value) => value === "true")
    .parse((process.env.SB_CSP_REPORT_ONLY ?? "false").toLowerCase());
  // The secrets are read through `readSecret` and the settings beside
  // them straight from the environment. That split is not an oversight: having a
  // `_FILE` form is what makes a name a secret here, so giving one to
  // `SMTP_HOST` or `ALLOWED_EMAILS` would erase the distinction the resolver
  // exists to draw.
  const values = {
    DATABASE_URL: readSecret("DATABASE_URL"),
    APP_BASE_URL: process.env.APP_BASE_URL,
    AUTH_SECRET: readSecret("AUTH_SECRET"),
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: readSecret("GOOGLE_CLIENT_SECRET"),
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SSL: process.env.SMTP_SSL,
    SMTP_USERNAME: process.env.SMTP_USERNAME,
    SMTP_PASSWORD: readSecret("SMTP_PASSWORD"),
    METRICS_TOKEN: readSecret("METRICS_TOKEN"),
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_REPLY_TO: process.env.MAIL_REPLY_TO,
    // Two of these go through `readSecret` and the rest do not, which is the
    // same split the mail block above makes: the key that can charge a card and
    // the secret that authenticates a webhook take a `_FILE` form, and the
    // publishable key, the price ids and the AdSense ids are published to every
    // browser that loads the page, so calling them secrets would mean nothing.
    SB_BILLING_ENABLED: process.env.SB_BILLING_ENABLED,
    STRIPE_SECRET_KEY: readSecret("STRIPE_SECRET_KEY"),
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET: readSecret("STRIPE_WEBHOOK_SECRET"),
    STRIPE_PRICE_MONTHLY_ID: process.env.STRIPE_PRICE_MONTHLY_ID,
    STRIPE_PRICE_YEARLY_ID: process.env.STRIPE_PRICE_YEARLY_ID,
    ADSENSE_CLIENT_ID: process.env.ADSENSE_CLIENT_ID,
    ADSENSE_BANNER_SLOT_ID: process.env.ADSENSE_BANNER_SLOT_ID,
    ADSENSE_FOOTER_SLOT_ID: process.env.ADSENSE_FOOTER_SLOT_ID,
    ADSENSE_CONSENT_MANAGED: process.env.ADSENSE_CONSENT_MANAGED,
    PRIVACY_POLICY_URL: process.env.PRIVACY_POLICY_URL,
  };
  if (isProduction) {
    productionSchema.parse(values);
  } else {
    assertNotADeployment(values.APP_BASE_URL);
  }
  if (googleAuthEnabled) {
    googleAuthSchema.parse(values);
  }
  const mail = parseMailSettings(values);
  const billing = parseBillingSettings(values, isProduction);
  const ads = parseAdSettings(values);
  const registration = parseRegistrationRule(values.ALLOWED_EMAILS);
  if (googleAuthEnabled && registration.kind === "closed") {
    throw new Error(
      "ALLOWED_EMAILS must list who may sign in when Google login is enabled. " +
        "Use email addresses, domains such as example.com, or * for anyone.",
    );
  }
  cached = {
    databaseUrl:
      values.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/simple_balance",
    baseUrl: (
      values.APP_BASE_URL ?? (isProduction ? "http://localhost:3000" : "http://localhost:5173")
    ).replace(/\/$/, ""),
    authSecret: values.AUTH_SECRET ?? "development-only-secret-change-me-1234567890",
    authMode,
    localAuthEnabled,
    googleAuthEnabled,
    googleClientId: values.GOOGLE_CLIENT_ID,
    googleClientSecret: values.GOOGLE_CLIENT_SECRET,
    registration,
    mail,
    billing,
    ads,
    port,
    logLevel,
    trustProxy,
    recurrenceSchedulerEnabled,
    metrics: {
      enabled: metricsEnabled,
      ...(values.METRICS_TOKEN ? { token: values.METRICS_TOKEN } : {}),
    },
    cspReportOnly,
    isProduction,
  };
  // Warned rather than refused. Scraping over a private network with nothing in
  // front of it is a legitimate deployment and demanding a token there would be
  // ceremony; publishing queue depths and write rates to the open internet is
  // not, and the two are indistinguishable from in here. So the one that can be
  // said is said, once, at the moment somebody turns the endpoint on.
  // Said every time, and at `warn` rather than `info`, because this is the one
  // setting that turns a defense off. A rehearsal that was never turned back
  // off looks exactly like a working deployment from the outside.
  if (cspReportOnly && isProduction) {
    console.warn(
      "SB_CSP_REPORT_ONLY is true, so the plan and billing tab reports what its " +
        "content security policy would have blocked and blocks nothing. Every " +
        "other page still enforces. Turn it off once you have read the reports.",
    );
  }
  if (metricsEnabled && !values.METRICS_TOKEN && isProduction) {
    console.warn(
      "METRICS_ENABLED is true and METRICS_TOKEN is not set, so /metrics answers " +
        "anybody who can reach this port. That is fine behind a private network " +
        "and is not fine on a public one. Set METRICS_TOKEN (or METRICS_TOKEN_FILE) " +
        "and give the scraper an Authorization: Bearer header.",
    );
  }
  // Said out loud because the two states are indistinguishable from in here and
  // one of them is a mistake. Setting the five Stripe settings and forgetting
  // the boolean is the likely slip in a two-axis design, and it fails silently:
  // the deployment starts, reaches Stripe, sells nothing and limits nobody,
  // with every page looking exactly as it did. The other reading — a deployment
  // winding down, still honoring what it sold — is legitimate and is why this
  // is not a refusal.
  if (billing && !billing.enforcing && isProduction) {
    console.warn(
      "Stripe is configured and SB_BILLING_ENABLED is not true, so this deployment " +
        "answers webhooks for subscriptions that already exist and offers no plan to " +
        "anybody new. Set SB_BILLING_ENABLED=true to sell one. If you meant to stop " +
        "selling, nothing is wrong and this line is the confirmation.",
    );
  }
  // The same two-axis slip, one setting over. An ad is shown to somebody on a
  // *limited* plan, and nobody is on one unless a plan is for sale — so AdSense
  // ids on a deployment that sells nothing widen the policy on every page and
  // serve `/ads.txt` while showing nobody an ad, which from the outside looks
  // exactly like having no inventory. Warned rather than refused, for the reason
  // the line above is: an operator trying the ads settings before selling
  // anything, or winding a deployment down, is doing something legitimate, and
  // a setting that was accepted stays accepted.
  if (ads && !billing?.enforcing && isProduction) {
    console.warn(
      "AdSense is configured and SB_BILLING_ENABLED is not true, so nobody is on a " +
        "limited plan and nobody is shown an ad. The content security policy is " +
        "still widened for ads on every page and /ads.txt is still served. Set " +
        "SB_BILLING_ENABLED=true, with Stripe configured, to show ads to free accounts.",
    );
  }
  // Publishes the development default to `getPool()`, and only ever that. A
  // value read from `DATABASE_URL_FILE` must not travel this way: putting it
  // into the environment is the one thing the `_FILE` form exists to prevent,
  // and `getPool()` reaches a configured value through `readSecret` without any
  // help from here. `??=` stays because nothing above this line sets the
  // variable, so it is the fallback rather than an overwrite.
  if (values.DATABASE_URL === undefined) {
    process.env.DATABASE_URL ??= cached.databaseUrl;
  }
  return cached;
}

/**
 * How this deployment reaches a mail server, if it has one.
 *
 * `security` is spelled out rather than inferred from a port, because the
 * difference matters and guessing it wrong is silent: `starttls` refuses to
 * carry on unencrypted if the server does not offer the upgrade, which is what
 * stops a password being sent in the clear to a relay that quietly does not
 * support it.
 */
export type MailSettings = {
  host: string;
  port: number;
  /**
   * True for a connection that is encrypted from the first byte, which is what
   * port 465 expects. False starts in the clear on 587 and upgrades with
   * STARTTLS, which is what nearly every provider wants, Gmail included.
   */
  ssl: boolean;
  username?: string;
  password?: string;
  from: string;
  /**
   * Where a reply should go, when that is not the address it came from.
   *
   * Some relays will not let a message claim any sender they like. Google
   * rewrites `From` to the mailbox that authenticated unless the address is a
   * verified alias, so a deployment can end up sending as a mailbox nobody
   * reads. This puts a real address on the reply instead.
   */
  replyTo?: string;
};

// Displayed as-is by mail clients, so it has to be something they will accept:
// either bare, or the "Name <address>" form.
const mailAddress = /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/;

/**
 * Reads the SMTP settings.
 *
 * SMTP_HOST and MAIL_FROM turn mail on, and both are needed: half a mail
 * configuration is a deployment that believes it can send a password reset and
 * cannot, which is only discovered by somebody already locked out.
 */
export function parseMailSettings(env: {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SSL?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
}): MailSettings | undefined {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host && !from) return undefined;
  if (!host || !from) {
    throw new Error(
      "SMTP_HOST and MAIL_FROM must be set together. Set both to send password " +
        "resets and address verification, or neither to send no mail at all.",
    );
  }

  const ssl = z
    .enum(["true", "false"], { error: () => "SMTP_SSL must be true or false" })
    .transform((value) => value === "true")
    .parse((env.SMTP_SSL ?? "false").toLowerCase());
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.SMTP_PORT ?? (ssl ? 465 : 587));

  if (!mailAddress.test(from)) {
    throw new Error(
      'MAIL_FROM must be an email address, optionally with a name: "Simple Balance <balance@example.com>"',
    );
  }

  const replyTo = env.MAIL_REPLY_TO?.trim() || undefined;
  if (replyTo && !mailAddress.test(replyTo)) {
    throw new Error(
      'MAIL_REPLY_TO must be an email address, optionally with a name: "Simple Balance <support@example.com>"',
    );
  }

  const username = env.SMTP_USERNAME?.trim() || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  if (username && !password) {
    throw new Error("SMTP_USERNAME is set without SMTP_PASSWORD");
  }
  if (password && !username) {
    throw new Error("SMTP_PASSWORD is set without SMTP_USERNAME");
  }
  return { host, port, ssl, username, password, from, replyTo };
}

/**
 * What this deployment needs to charge for a plan, if it sells one.
 *
 * Undefined is the ordinary case and the default: a deployment nobody pays for.
 * Every entitlement then reads as unrestricted, no plan UI renders, and this
 * process opens no connection to Stripe — which is how the promise in
 * `docs/standards/operations.md` that nothing reaches out unasked stays true by
 * construction rather than by intent.
 *
 * `enforcing` is a second axis rather than a second name for the same thing.
 * Credentials being present means Stripe can be reached, which is what keeps
 * webhook ingestion and reconciliation working for subscriptions that already
 * exist. `SB_BILLING_ENABLED` decides whether anybody may start a new one and
 * whether the free tier's limit binds. An operator winding a deployment down
 * stops selling long before they stop listening, and a single flag cannot say
 * that: turning one off would either abandon paying subscribers or keep selling
 * to new ones.
 */
export type BillingSettings = {
  readonly enforcing: boolean;
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly webhookSecret: string;
  readonly monthlyPriceId: string;
  readonly yearlyPriceId: string;
};

/** The five Stripe names, with the prefix each one's value is known to carry. */
const stripeInputs = [
  // Restricted keys start `rk_` and are a supported way to hand this process
  // less than the whole account, so both forms are accepted.
  ["STRIPE_SECRET_KEY", /^(sk|rk)_/, "sk_live_… or sk_test_…"],
  ["STRIPE_PUBLISHABLE_KEY", /^pk_/, "pk_live_… or pk_test_…"],
  ["STRIPE_WEBHOOK_SECRET", /^whsec_/, "whsec_…"],
  ["STRIPE_PRICE_MONTHLY_ID", /^price_/, "price_…"],
  ["STRIPE_PRICE_YEARLY_ID", /^price_/, "price_…"],
] as const;

/**
 * Which half of Stripe a key belongs to, when the key says so.
 *
 * Undefined rather than a guess for anything unrecognized, because this is used
 * to refuse a mismatch and a wrong refusal is worse than a missed one: Stripe
 * has added key forms before and a deployment holding a shape this file has not
 * heard of should start, not stop.
 *
 * Exported for `stripe.ts`, which holds the configured prices to the same mode:
 * a Price says which half it lives in, and a test price behind a live key is a
 * checkout that fails for every customer rather than a startup that fails once.
 */
export function stripeMode(key: string): "live" | "test" | undefined {
  if (/^(sk|rk|pk)_live_/.test(key)) return "live";
  if (/^(sk|rk|pk)_test_/.test(key)) return "test";
  return undefined;
}

/**
 * Reads the Stripe settings.
 *
 * All five together or none of them. Half a billing configuration is the shape
 * that fails at the worst moment: a deployment that renders an upgrade button,
 * takes a card, and then cannot tell whether the payment succeeded because it
 * has no webhook secret to verify the answer with.
 */
export function parseBillingSettings(
  env: {
    SB_BILLING_ENABLED?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_PUBLISHABLE_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRICE_MONTHLY_ID?: string;
    STRIPE_PRICE_YEARLY_ID?: string;
  },
  isProduction: boolean,
): BillingSettings | undefined {
  const enforcing = z
    .enum(["true", "false"], {
      error: () => "SB_BILLING_ENABLED must be true or false",
    })
    .transform((value) => value === "true")
    .parse((env.SB_BILLING_ENABLED ?? "false").toLowerCase());

  const present = new Map(
    stripeInputs.flatMap(([name]) => {
      const value = env[name]?.trim();
      return value ? [[name, value] as const] : [];
    }),
  );
  if (present.size === 0) {
    if (enforcing) {
      throw new Error(
        "SB_BILLING_ENABLED is true and no Stripe settings are set, so this " +
          "deployment would offer a plan it cannot charge for. Set " +
          `${stripeInputs.map(([name]) => name).join(", ")}, or leave ` +
          "SB_BILLING_ENABLED unset to sell nothing.",
      );
    }
    return undefined;
  }
  const missing = stripeInputs.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Stripe is half configured: ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } missing. Set all five of ` +
        `${stripeInputs.map(([name]) => name).join(", ")} to sell a plan, or none of them.`,
    );
  }

  for (const [name, prefix, shape] of stripeInputs) {
    const value = present.get(name)!;
    if (!prefix.test(value)) {
      throw new Error(
        `${name} does not look like a Stripe value: it should start ${shape}. ` +
          "A product id where a price id belongs is the usual cause, and it fails " +
          "at the first checkout rather than at startup.",
      );
    }
  }

  const secretKey = present.get("STRIPE_SECRET_KEY")!;
  const publishableKey = present.get("STRIPE_PUBLISHABLE_KEY")!;
  // Refused rather than warned, and only when both keys say which half they
  // belong to. A live secret key beside a test publishable key takes real money
  // from a card the browser thought was a test one, and nothing about it looks
  // wrong until somebody reads a statement.
  const secretMode = stripeMode(secretKey);
  const publishableMode = stripeMode(publishableKey);
  if (secretMode && publishableMode && secretMode !== publishableMode) {
    throw new Error(
      `STRIPE_SECRET_KEY is a ${secretMode} key and STRIPE_PUBLISHABLE_KEY is a ` +
        `${publishableMode} key. Use both from the same mode, or payments succeed ` +
        "in one half of Stripe and are invisible in the other.",
    );
  }
  // The same argument as `assertNotADeployment` makes about APP_BASE_URL: a
  // development process pointed at something real is a mistake with no symptom
  // until it has done something that cannot be undone. Here that is charging a
  // card while running the test suite.
  if (secretMode === "live" && !isProduction) {
    throw new Error(
      "STRIPE_SECRET_KEY is a live key and NODE_ENV is not production, so this " +
        "process would charge real cards. Use a test key outside production.",
    );
  }

  return {
    enforcing,
    secretKey,
    publishableKey,
    webhookSecret: present.get("STRIPE_WEBHOOK_SECRET")!,
    monthlyPriceId: present.get("STRIPE_PRICE_MONTHLY_ID")!,
    yearlyPriceId: present.get("STRIPE_PRICE_YEARLY_ID")!,
  };
}

/**
 * Where the advertising slots get their inventory, if a deployment shows any.
 *
 * Undefined is the default and the ordinary case. It is also the only state in
 * which the browser bundle keeps the `default-src 'self'` policy this product
 * advertises: AdSense publishes no host list, so serving it means widening the
 * policy on every page that renders somebody's balances. That widening is the
 * real cost of this setting and it belongs beside the setting itself.
 *
 * Presence is the switch, exactly as `SMTP_HOST` and `MAIL_FROM` are for mail.
 * There is no separate on/off flag because there is nothing an operator would
 * want to keep configured while switched off — unlike billing, where existing
 * subscriptions outlive the decision to stop selling.
 */
export type AdSettings = {
  readonly clientId: string;
  readonly bannerSlotId: string;
  /**
   * Where this deployment's privacy policy lives. Required whenever ads are
   * configured, because Google's program policies require one on any site
   * serving their ads — see `parseAdSettings`.
   *
   * It sits on the ad settings rather than beside them, so that "ads are on"
   * and "there is a policy to link to" cannot become two facts that disagree.
   */
  readonly privacyPolicyUrl: string;
  /** Off unless asked for: one banner is the whole placement by default. */
  readonly footerSlotId?: string;
  /**
   * Whether a certified consent platform is collecting consent for this
   * deployment. Off unless an operator says so.
   *
   * It decides one thing: whether the ad request forces
   * `requestNonPersonalizedAds`. Off, it does, and every visitor gets
   * non-personalized ads — the conservative default for a page showing somebody
   * their own money, and the setting under which Google will serve without a
   * certified platform at all.
   *
   * On, the flag is *not* forced, and that is the point rather than an
   * omission: a consent platform's whole job is to ask and then tell Google the
   * answer. Forcing the flag on top of it would override a person who consented
   * just as surely as it protects one who did not, which makes the platform
   * ornamental.
   *
   * Turning it on is an operator asserting the platform exists. Nothing here
   * can check that — a consent message is served by Google's tag from Google's
   * account, and this process never sees it — so the default is the safe answer
   * rather than the profitable one.
   */
  readonly consentManaged: boolean;
};

// `ca-pub-` and then the publisher's sixteen digits. Checked because pasting the
// bare `pub-…` from the AdSense dashboard is the common mistake and it fails by
// rendering nothing at all, which looks exactly like having no inventory.
//
// The length is checked as well as the shape, and that is the half that earns
// its keep: a prefix check passes `ca-pub-1`, and every truncated, doubled or
// short-by-one publisher id starts the process cleanly and then earns nobody
// anything. A slot id is ten digits for the same reason. Both are Google's
// formats rather than ours, so a deployment whose ids are refused here has ids
// that would have been refused by AdSense.
const adsenseClientId = /^ca-pub-\d{16}$/;
const adsenseSlotId = /^\d{10}$/;

/** Reads the AdSense settings. A client id and a banner slot, or neither. */
export function parseAdSettings(env: {
  ADSENSE_CLIENT_ID?: string;
  ADSENSE_BANNER_SLOT_ID?: string;
  ADSENSE_FOOTER_SLOT_ID?: string;
  ADSENSE_CONSENT_MANAGED?: string;
  PRIVACY_POLICY_URL?: string;
}): AdSettings | undefined {
  const clientId = env.ADSENSE_CLIENT_ID?.trim();
  const bannerSlotId = env.ADSENSE_BANNER_SLOT_ID?.trim();
  const footerSlotId = env.ADSENSE_FOOTER_SLOT_ID?.trim() || undefined;
  if (!clientId && !bannerSlotId) {
    if (footerSlotId) {
      throw new Error(
        "ADSENSE_FOOTER_SLOT_ID is set without ADSENSE_CLIENT_ID and " +
          "ADSENSE_BANNER_SLOT_ID. The footer unit is an addition to the banner, " +
          "not a replacement for it.",
      );
    }
    return undefined;
  }
  if (!clientId || !bannerSlotId) {
    throw new Error(
      "ADSENSE_CLIENT_ID and ADSENSE_BANNER_SLOT_ID must be set together. Set " +
        "both to show ads, or neither to show none.",
    );
  }
  if (!adsenseClientId.test(clientId)) {
    throw new Error(
      'ADSENSE_CLIENT_ID must be a publisher id of the form "ca-pub-" followed ' +
        'by sixteen digits. The AdSense dashboard shows it as "pub-…"; the "ca-" ' +
        "prefix belongs in front of it.",
    );
  }
  for (const [name, value] of [
    ["ADSENSE_BANNER_SLOT_ID", bannerSlotId],
    ["ADSENSE_FOOTER_SLOT_ID", footerSlotId],
  ] as const) {
    if (value && !adsenseSlotId.test(value)) {
      throw new Error(`${name} must be an ad unit's slot id, which is ten digits.`);
    }
  }
  /*
   * A privacy policy is not optional once ads are served.
   *
   * Google's program policies require one on any site showing their ads,
   * naming third-party cookies and the vendors that set them. An operator who
   * turns ads on without it is in breach from the first impression, and the
   * failure is the expensive kind: the account is suspended rather than the
   * ads simply not rendering.
   *
   * So it is refused at startup, in the same place and the same shape as the
   * half-configured refusals above. This is the one setting in this product
   * that exists because somebody else's terms demand it, which is why the
   * message says whose terms they are.
   */
  const privacyPolicyUrl = env.PRIVACY_POLICY_URL?.trim();
  if (!privacyPolicyUrl) {
    throw new Error(
      "PRIVACY_POLICY_URL must be set when AdSense is configured. Google's " +
        "program policies require a privacy policy on any site serving their " +
        "ads, naming third-party cookies and the vendors that set them. Point " +
        "this at yours.",
    );
  }
  let parsedPrivacyUrl: URL;
  try {
    parsedPrivacyUrl = new URL(privacyPolicyUrl);
  } catch {
    throw new Error(`PRIVACY_POLICY_URL must be an absolute URL, not "${privacyPolicyUrl}".`);
  }
  if (parsedPrivacyUrl.protocol !== "https:") {
    // A policy served over plain http is one a reader cannot trust arrived
    // unmodified, on a page that is about what happens to their data.
    throw new Error("PRIVACY_POLICY_URL must be https.");
  }

  const consentManaged = z
    .enum(["true", "false"], { error: () => "ADSENSE_CONSENT_MANAGED must be true or false" })
    .transform((value) => value === "true")
    .parse((env.ADSENSE_CONSENT_MANAGED ?? "false").toLowerCase());

  return {
    clientId,
    bannerSlotId,
    privacyPolicyUrl,
    ...(footerSlotId ? { footerSlotId } : {}),
    consentManaged,
  };
}

/**
 * Whether this process can reach Stripe at all.
 *
 * True whenever the credentials are present, including on a deployment that has
 * stopped selling: a subscription somebody is still paying for goes on emitting
 * webhooks, and refusing to listen would leave this ledger's idea of who has
 * paid drifting away from Stripe's.
 */
export function stripeConfigured(): boolean {
  return Boolean(getConfig().billing);
}

/**
 * Whether this deployment sells plans and holds people to their limits.
 *
 * Everything that gates a feature asks this one question, so that turning
 * billing off cannot half-apply: no plan is offered, no limit binds, and every
 * existing account keeps every account it already has.
 */
export function billingEnabled(): boolean {
  return getConfig().billing?.enforcing === true;
}

/** Whether this deployment shows ads. */
export function adsEnabled(): boolean {
  return Boolean(getConfig().ads);
}

/**
 * Who may hold an account on this deployment.
 *
 * `closed` is what an unset list means: whoever already has an account keeps it,
 * and nobody new can register. That is the safe reading of "nothing was
 * configured", and it keeps a deployment that never set the variable private to
 * the person who claimed it.
 */
export type RegistrationRule =
  | { kind: "closed" }
  | { kind: "anyone" }
  | { kind: "list"; emails: ReadonlySet<string>; domains: ReadonlySet<string> };

/**
 * Reads ALLOWED_EMAILS. Entries are comma separated and may be:
 *
 *   *                  anyone at all
 *   you@example.com    that address
 *   example.com        any address at that domain
 *   @example.com       the same, written the way people often expect
 *
 * A domain matches only itself: example.com does not admit
 * someone@mail.example.com, because that is a different domain and a
 * subdomain someone else may control.
 */
export function parseRegistrationRule(raw: string | undefined): RegistrationRule {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return { kind: "closed" };
  if (entries.includes("*")) return { kind: "anyone" };

  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const entry of entries) {
    if (entry.includes("@")) {
      // A leading @ means the whole domain; an @ in the middle means one person.
      const bare = entry.startsWith("@") ? entry.slice(1) : null;
      if (bare !== null) {
        assertDomain(bare, entry);
        domains.add(bare);
      } else {
        assertEmail(entry);
        emails.add(entry);
      }
      continue;
    }
    assertDomain(entry, entry);
    domains.add(entry);
  }
  return { kind: "list", emails, domains };
}

function assertDomain(candidate: string, entry: string) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(candidate)) {
    throw new Error(
      `ALLOWED_EMAILS entry "${entry}" is not a usable domain. ` +
        "Write a domain as example.com, an address as you@example.com, or * for anyone.",
    );
  }
}

function assertEmail(entry: string) {
  const [local, ...rest] = entry.split("@");
  if (!local || rest.length !== 1) {
    throw new Error(`ALLOWED_EMAILS entry "${entry}" is not a usable email address.`);
  }
  assertDomain(rest[0]!, entry);
}

/**
 * Whether this address may hold an account here.
 *
 * The address is compared as written apart from case. A plus tag is part of the
 * address, so admitting you@example.com does not admit you+other@example.com;
 * admit the domain if that is what you meant.
 */
export function isEmailAllowed(email: string) {
  const rule = getConfig().registration;
  if (rule.kind === "closed") return false;
  if (rule.kind === "anyone") return true;
  const normalized = email.trim().toLowerCase();
  if (rule.emails.has(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  if (at < 0) return false;
  return rule.domains.has(normalized.slice(at + 1));
}

/** True when nobody new may register, whatever the sign-in mode. */
export function isRegistrationClosed() {
  return getConfig().registration.kind === "closed";
}

/**
 * True when the rule admits every address there is.
 *
 * The setup code is checked only after the rule has turned an address away, so
 * a rule that turns nobody away makes the code unreachable. Worth naming,
 * because "is the code any use here" is not the same question as "is it
 * required", and the startup log needs the first one.
 */
export function isRegistrationOpenToAnyone() {
  return getConfig().registration.kind === "anyone";
}
