/**
 * The application's own settings, as a stack states them: two maps in the
 * `simple-balance:` namespace, `env` for what may be read in the clear and
 * `secrets` for what may not.
 *
 * ```sh
 * pulumi config set --path 'simple-balance:env.SB_BILLING_ENABLED' true
 * pulumi config set --secret --path 'simple-balance:secrets.STRIPE_SECRET_KEY' 'rk_live_...'
 * ```
 *
 * The stack is the one place a setting lives, and that is the whole point of
 * the module. The single-machine programs used to leave every setting the
 * stack did not have a key for to a file on the machine, edited over SSH —
 * which made a Stripe key the one thing about a deployment that was in nobody's
 * version control and nobody's secret store, and a rebuilt machine the moment
 * somebody found out whether they had kept a copy. Now the stack holds it,
 * encrypted where it is a secret, and each program hands it to the cloud's own
 * store: OCI Vault, AWS Secrets Manager, or a Kubernetes Secret on a cluster
 * whose Secrets that cloud's key service encrypts.
 *
 * Pulumi-free, so the test suite at the repository root can hold these rules
 * without the programs' `node_modules`, the way it holds the cloud-init render.
 */

/**
 * Every name the server reads.
 *
 * Copied rather than imported, because this directory is vendored into
 * deployment repositories that do not carry `src/`. A copied list drifts, so
 * `tests/app-settings.test.ts` derives the same set from the server's source
 * and fails when the two disagree — a setting added to the server without
 * being added here would otherwise be refused by every stack that tried to set
 * it, and one removed would be accepted and ignored.
 */
export const SERVER_SETTINGS = [
  "ADSENSE_BANNER_SLOT_ID",
  "ADSENSE_CLIENT_ID",
  "ADSENSE_CONSENT_MANAGED",
  "ADSENSE_FOOTER_SLOT_ID",
  "ALLOWED_EMAILS",
  "APP_BASE_URL",
  "AUTH_MODE",
  "AUTH_SECRET",
  "CSV_MAX_BYTES",
  "CSV_MAX_ROWS",
  "DATABASE_POOL_SIZE",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "IDEMPOTENCY_RETENTION_HOURS",
  "LOG_LEVEL",
  "MAIL_FROM",
  "MAIL_REPLY_TO",
  "METRICS_ENABLED",
  "METRICS_TOKEN",
  "NODE_ENV",
  "PORT",
  "PRIVACY_POLICY_URL",
  "RECURRENCE_CATCH_UP_LIMIT",
  "RECURRENCE_CLAIM_LIMIT",
  "RECURRENCE_SCHEDULER",
  "RECURRENCE_TICK_SECONDS",
  "SB_BILLING_ENABLED",
  "SB_CSP_REPORT_ONLY",
  "SETUP_TOKEN",
  "SMTP_HOST",
  "SMTP_PASSWORD",
  "SMTP_PORT",
  "SMTP_SSL",
  "SMTP_USERNAME",
  "STRIPE_PRICE_MONTHLY_ID",
  "STRIPE_PRICE_YEARLY_ID",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "TERMS_OF_USE_URL",
  "TRUST_PROXY",
] as const;

/**
 * The names the server treats as secrets: the ones with a `_FILE` form.
 *
 * `src/server/config-files.ts` is the definition and argues it — having a
 * `_FILE` form is what makes a name a secret — and this is its copy, held to
 * it by the same test. These may only be set in `secrets`. Set in `env`, a
 * Stripe key would sit in plain text in `Pulumi.<stack>.yaml`, which is
 * committed, and in the program's state.
 */
export const SECRET_SETTINGS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "SMTP_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "SETUP_TOKEN",
  "METRICS_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

/**
 * A name a program decides itself, and why — written to finish the sentence
 * "cannot be set here: ...".
 */
export type OwnedSettings = Readonly<Record<string, string>>;

/** The two maps, checked. Plain values and secret values, both by name. */
export interface AppSettings {
  readonly plain: Readonly<Record<string, string>>;
  readonly secret: Readonly<Record<string, string>>;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The two maps as a stack wrote them, refused at plan time where they cannot
 * mean what they say.
 *
 * Each refusal is a setting that would otherwise be accepted and then do
 * something other than what the operator believes:
 *
 * - **A name the server does not read** — a typo, `STRIPE_PRICE_MONTHLY`, is
 *   carried to the machine and ignored there, and the plan tab goes on not
 *   selling with nothing saying why.
 * - **A secret in `env`** is written in the clear into a file that is
 *   committed. It is refused rather than quietly moved, because the plain copy
 *   is already in the file by the time this runs and only the operator can
 *   take it out.
 * - **The same name in both** has no answer to which one wins.
 * - **A name the program decides itself** — `APP_BASE_URL` from
 *   `simple-balance:hostname`, say — would be two places for one fact, and the
 *   map would silently override the key that the stack's own documentation
 *   says decides it.
 *
 * Values are strings; a YAML number or boolean is accepted and written as its
 * text, because `pulumi config set --path` stores `true` as a boolean and
 * nobody setting `SB_BILLING_ENABLED` should have to know that.
 */
export function readAppSettings(env: unknown, secrets: unknown, owned: OwnedSettings): AppSettings {
  const plain = asMap(env, "simple-balance:env");
  const secret = asMap(secrets, "simple-balance:secrets");
  const known = new Set<string>(SERVER_SETTINGS);
  const secretNames = new Set<string>(SECRET_SETTINGS);

  for (const [map, where] of [
    [plain, "env"],
    [secret, "secrets"],
  ] as const) {
    for (const name of Object.keys(map)) {
      if (!NAME.test(name)) {
        throw new Error(
          `simple-balance:${where}.${name} is not a setting name; names are upper case, digits and underscores.`,
        );
      }
      if (!known.has(name)) {
        throw new Error(
          `simple-balance:${where}.${name} is not a setting the application reads, so it would reach ` +
            "the machine and be ignored there. Check the spelling against docs/deployment.md, or remove " +
            `it: pulumi config rm --path 'simple-balance:${where}.${name}'`,
        );
      }
      const reason = owned[name];
      if (reason !== undefined) {
        throw new Error(
          `simple-balance:${where}.${name} cannot be set here: ${reason}. Remove it: ` +
            `pulumi config rm --path 'simple-balance:${where}.${name}'`,
        );
      }
    }
  }

  for (const name of Object.keys(plain)) {
    if (secretNames.has(name)) {
      throw new Error(
        `simple-balance:env.${name} is a secret, and env is stored in the clear in Pulumi.<stack>.yaml. ` +
          `Move it: pulumi config rm --path 'simple-balance:env.${name}' && ` +
          `pulumi config set --secret --path 'simple-balance:secrets.${name}' '<value>'`,
      );
    }
    if (name in secret) {
      throw new Error(
        `${name} is set in both simple-balance:env and simple-balance:secrets, and neither is the one ` +
          "that wins. Keep it in one of them.",
      );
    }
  }

  return { plain, secret };
}

function asMap(value: unknown, key: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${key} is a map of setting names to values. Set one entry at a time with ` +
        `pulumi config set --path '${key}.NAME' value.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new Error(`${key}.${name} is a ${typeof raw}; a setting's value is text.`);
    }
    // Never echoed: the value may be a secret, and this message is printed.
    const text = String(raw);
    if (/[\r\n]/.test(text)) {
      throw new Error(
        `${key}.${name} has a line break in it. Every setting is one line; a certificate or a key that ` +
          "spans lines is not a setting this application reads.",
      );
    }
    out[name] = text;
  }
  return out;
}

/**
 * The settings as the machine's Compose `.env` reads them, one per line.
 *
 * Single-quoted, which is the one form Compose takes literally: no `$`
 * interpolation and no escapes, so a password with a `$` or a `#` in it arrives
 * as it was typed. The cost is that a single quote cannot be written at all,
 * and that is refused here rather than mangled — a Compose file whose quoting
 * was guessed is a password that works until somebody rotates it.
 *
 * Sorted, so the same settings produce the same text and a `pulumi up` that
 * changed nothing writes no new secret version.
 */
export function settingsEnvFile(settings: AppSettings): string {
  const all = { ...settings.plain, ...settings.secret };
  const lines = Object.keys(all)
    .sort()
    .map((name) => {
      const value = all[name]!;
      if (value.includes("'")) {
        throw new Error(
          `${name} has a single quote in its value, which the machine's Compose file cannot carry. ` +
            "Choose a value without one.",
        );
      }
      return `${name}='${value}'`;
    });
  // Never empty: OCI Vault refuses a secret with no content, and a stack with
  // no settings still needs the secret to exist so that adding the first one
  // is a `pulumi up` rather than a new machine.
  return `# Written by Pulumi from simple-balance:env and simple-balance:secrets.\n${lines.join("\n")}\n`;
}

/** The chart's `config` values a stack's plain settings become. */
export interface ChartConfig {
  authMode?: string;
  logLevel?: string;
  csvMaxBytes?: number;
  csvMaxRows?: number;
  recurrence?: { tickSeconds?: number; catchUpLimit?: number; claimLimit?: number };
  google?: { clientId?: string };
  mail?: { host?: string; from?: string; replyTo?: string; port?: number; ssl?: boolean };
  metrics?: { enabled?: boolean };
  extraEnv: Record<string, string>;
}

/**
 * The plain settings as the Helm chart takes them.
 *
 * Most go to `config.extraEnv`. The ones the chart already writes into the
 * same ConfigMap from values of its own go to those values instead, because
 * the ConfigMap is one YAML mapping and a name in it twice is a render that
 * fails — or, under a parser that allows it, a setting whose winner depends on
 * the order the chart happens to emit. Each is converted to the type the
 * chart's schema declares, and refused here when it is not one, because the
 * schema's own refusal arrives in the middle of a Helm rollout.
 */
export function chartConfig(plain: Readonly<Record<string, string>>): ChartConfig {
  const out: ChartConfig = { extraEnv: {} };
  const whole = (name: string, value: string) => {
    if (!/^\d+$/.test(value)) {
      throw new Error(`simple-balance:env.${name} is a whole number. Got "${value}".`);
    }
    return Number(value);
  };
  const flag = (name: string, value: string) => {
    if (value !== "true" && value !== "false") {
      throw new Error(`simple-balance:env.${name} is true or false. Got "${value}".`);
    }
    return value === "true";
  };
  for (const [name, value] of Object.entries(plain)) {
    switch (name) {
      case "AUTH_MODE":
        out.authMode = value;
        break;
      case "LOG_LEVEL":
        out.logLevel = value;
        break;
      case "CSV_MAX_BYTES":
        out.csvMaxBytes = whole(name, value);
        break;
      case "CSV_MAX_ROWS":
        out.csvMaxRows = whole(name, value);
        break;
      case "RECURRENCE_TICK_SECONDS":
        out.recurrence = { ...out.recurrence, tickSeconds: whole(name, value) };
        break;
      case "RECURRENCE_CATCH_UP_LIMIT":
        out.recurrence = { ...out.recurrence, catchUpLimit: whole(name, value) };
        break;
      case "RECURRENCE_CLAIM_LIMIT":
        out.recurrence = { ...out.recurrence, claimLimit: whole(name, value) };
        break;
      case "GOOGLE_CLIENT_ID":
        out.google = { clientId: value };
        break;
      case "SMTP_HOST":
        out.mail = { ...out.mail, host: value };
        break;
      case "MAIL_FROM":
        out.mail = { ...out.mail, from: value };
        break;
      case "MAIL_REPLY_TO":
        out.mail = { ...out.mail, replyTo: value };
        break;
      case "SMTP_PORT":
        out.mail = { ...out.mail, port: whole(name, value) };
        break;
      case "SMTP_SSL":
        out.mail = { ...out.mail, ssl: flag(name, value) };
        break;
      case "METRICS_ENABLED":
        out.metrics = { enabled: flag(name, value) };
        break;
      default:
        out.extraEnv[name] = value;
    }
  }
  return out;
}
