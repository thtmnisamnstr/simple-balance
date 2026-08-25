import { z } from "zod";
import { readSecret, resolveFileBackedSecrets } from "./config-files.js";

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

export const authModes = ["local", "google", "both"] as const;
export type AuthMode = (typeof authModes)[number];

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
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  trustProxy: boolean;
  /**
   * Whether this process proposes recurring transactions.
   *
   * On by default, so the documented single container keeps working with no
   * extra configuration. Turn it off on web replicas when a separate scheduler
   * container owns the job; leaving it on everywhere is also safe, because a
   * recurrence is claimed with `for update skip locked` and whoever reaches a
   * row first is the only one that works it.
   */
  recurrenceSchedulerEnabled: boolean;
  isProduction: boolean;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  // `readSecret` memoises, so this call buys exactly one thing: an unreadable
  // secret file, or a name set both ways, refuses at startup rather than at the
  // first query. That is what the "Validating at startup" rule in
  // `docs/standards/operations.md` asks of every other setting here.
  resolveFileBackedSecrets();
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
    .enum(["debug", "info", "warn", "error"], {
      error: () => "LOG_LEVEL must be debug, info, warn or error",
    })
    .parse((process.env.LOG_LEVEL ?? "info").toLowerCase());
  const trustProxy = z
    .enum(["true", "false"], { error: () => "TRUST_PROXY must be true or false" })
    .transform((value) => value === "true")
    .parse((process.env.TRUST_PROXY ?? "false").toLowerCase());
  // Parsed strictly rather than treating anything unrecognised as off. A
  // misspelling here has no symptom: the process starts, serves, and quietly
  // proposes nothing until somebody notices a year of missing rent.
  const recurrenceSchedulerEnabled = z
    .enum(["true", "false"], {
      error: () => "RECURRENCE_SCHEDULER must be true or false",
    })
    .transform((value) => value === "true")
    .parse((process.env.RECURRENCE_SCHEDULER ?? "true").toLowerCase());
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
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_REPLY_TO: process.env.MAIL_REPLY_TO,
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
    port,
    logLevel,
    trustProxy,
    recurrenceSchedulerEnabled,
    isProduction,
  };
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
