import { z } from "zod";

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/.test(octet) &&
        Number(octet) >= 0 &&
        Number(octet) <= 255,
    )
  );
}

const productionBaseUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    !/^https?:\/\/[^\s\\/@?#]+\/?$/i.test(value) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    context.addIssue({
      code: "custom",
      message:
        "APP_BASE_URL must be an exact HTTP(S) origin with no credentials, path, query, or fragment",
    });
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

const productionSchema = z.object({
  DATABASE_URL: z.string().url(),
  APP_BASE_URL: productionBaseUrlSchema,
  AUTH_SECRET: z.string().min(32),
});

// ALLOWED_EMAILS is not checked for length here. A minimum of three characters
// made sense when every entry had to be an address; it rejects `*`, which is
// now the documented way to say anybody. Whether the list admits somebody is
// checked below, where the message can say what to do about it.
const googleAuthSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
});

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
  isProduction: boolean;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const isProduction = process.env.NODE_ENV === "production";
  const authMode = z
    .enum(authModes)
    .parse((process.env.AUTH_MODE ?? "local").toLowerCase());
  const localAuthEnabled = authMode === "local" || authMode === "both";
  const googleAuthEnabled = authMode === "google" || authMode === "both";
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 3000);
  const logLevel = z
    .enum(["debug", "info", "warn", "error"])
    .parse((process.env.LOG_LEVEL ?? "info").toLowerCase());
  const trustProxy = z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .parse((process.env.TRUST_PROXY ?? "false").toLowerCase());
  const values = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_BASE_URL: process.env.APP_BASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURITY: process.env.SMTP_SECURITY,
    SMTP_USERNAME: process.env.SMTP_USERNAME,
    SMTP_PASSWORD: process.env.SMTP_PASSWORD,
    MAIL_FROM: process.env.MAIL_FROM,
    MAIL_REPLY_TO: process.env.MAIL_REPLY_TO,
  };
  if (isProduction) {
    productionSchema.parse(values);
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
      values.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/simple_balance",
    baseUrl: (
      values.APP_BASE_URL ??
      (isProduction ? "http://localhost:3000" : "http://localhost:5173")
    ).replace(/\/$/, ""),
    authSecret:
      values.AUTH_SECRET ?? "development-only-secret-change-me-1234567890",
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
    isProduction,
  };
  process.env.DATABASE_URL ??= cached.databaseUrl;
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
  security: "starttls" | "tls" | "none";
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
const mailAddress =
  /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/;

const mailSecurities = ["starttls", "tls", "none"] as const;

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
  SMTP_SECURITY?: string;
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

  const security = z
    .enum(mailSecurities)
    .parse((env.SMTP_SECURITY ?? "starttls").toLowerCase());
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.SMTP_PORT ?? (security === "tls" ? 465 : 587));

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
  if (password && security === "none") {
    throw new Error(
      "SMTP_SECURITY=none sends the password in the clear. Use starttls or " +
        "tls, or drop SMTP_USERNAME and SMTP_PASSWORD if the relay does not " +
        "want them.",
    );
  }

  return { host, port, security, username, password, from, replyTo };
}

/**
 * Who may hold an account on this deployment.
 *
 * `closed` is what an unset list means: whoever already has an account keeps it,
 * and nobody new can register. That is the safe reading of "nothing was
 * configured", and it is what an existing single-owner deployment expects to
 * happen when it takes an upgrade.
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
    throw new Error(
      `ALLOWED_EMAILS entry "${entry}" is not a usable email address.`,
    );
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
