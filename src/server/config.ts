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

const googleAuthSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  ALLOWED_EMAILS: z.string().min(3),
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
  allowedEmails: Set<string>;
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
  };
  if (isProduction) {
    productionSchema.parse(values);
  }
  if (googleAuthEnabled) {
    googleAuthSchema.parse(values);
  }
  const allowedEmails = new Set(
    (values.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (googleAuthEnabled && allowedEmails.size === 0) {
    throw new Error(
      "ALLOWED_EMAILS must contain at least one email address when Google login is enabled",
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
    allowedEmails,
    port,
    logLevel,
    trustProxy,
    isProduction,
  };
  process.env.DATABASE_URL ??= cached.databaseUrl;
  return cached;
}

export function isEmailAllowed(email: string) {
  return getConfig().allowedEmails.has(email.trim().toLowerCase());
}
