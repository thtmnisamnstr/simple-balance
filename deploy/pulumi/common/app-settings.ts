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
  "SB_HOUSE_AD",
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
 * Every name the metrics collector reads, which the application does not.
 *
 * A third list rather than more names in the first, because the first is held
 * to exactly what `src/server` reads and these are read by a different
 * program: `deploy/compose/single/collector.yaml` and its two siblings, through
 * the `collector` service in each compose file. They ride the same two maps and
 * the same settings file because they are the same kind of thing to an
 * operator — a deployment's setting, some of them secret — and a fourth stack
 * key would be one more place to look. `tests/collector-config.test.ts` derives
 * this list from the compose files the way `tests/app-settings.test.ts` derives
 * the first one from the server, so a setting the collector gains is refused by
 * every stack until it is named here, and one it loses is not quietly accepted.
 *
 * Setting SB_METRICS_EXPORT_ENDPOINT is the whole of turning export on; the
 * rest have defaults, which `COLLECTOR_DEFAULTS` copies from the compose files.
 * SB_METRICS_DATABASE_TARGET is the single-machine programs' to decide, from
 * the database node they built, and a cluster has no such node: both kinds of
 * program name it in their `OwnedSettings`.
 */
export const COLLECTOR_SETTINGS = [
  "SB_METRICS_DATABASE_TARGET",
  "SB_METRICS_ENVIRONMENT",
  "SB_METRICS_EXPORT_ENDPOINT",
  "SB_METRICS_EXPORT_HEADERS",
  "SB_METRICS_EXPORT_PROTOCOL",
  "SB_METRICS_SCRAPE_INTERVAL",
] as const;

/**
 * The collector's secret: the headers, which carry the backend's credential —
 * a New Relic license key is the whole of what it takes to write into that
 * account. Secret in the same sense as `SECRET_SETTINGS`, and refused in `env`
 * for the same reason.
 */
export const COLLECTOR_SECRET_SETTINGS = ["SB_METRICS_EXPORT_HEADERS"] as const;

/** What SB_METRICS_EXPORT_PROTOCOL may say: the collector's pipeline has these two. */
export const METRICS_EXPORT_PROTOCOLS = ["otlp", "prometheus_remote_write"] as const;

/**
 * The defaults the compose files give the collector, for a program that has
 * to hand the chart a value rather than leave a name unset. Copied, so
 * `tests/collector-config.test.ts` holds each to the `${NAME:-default}` it
 * copies.
 */
export const COLLECTOR_DEFAULTS = {
  SB_METRICS_EXPORT_PROTOCOL: "otlp",
  SB_METRICS_SCRAPE_INTERVAL: "30s",
  SB_METRICS_ENVIRONMENT: "production",
} as const;

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
 * - **A collector setting the collector would refuse** — a protocol it has no
 *   pipeline for, an interval of five minutes or more, headers that are not a
 *   map. On the machine each one is a collector that will not start, found in
 *   its own log; here it is a plan that names the setting.
 *
 * Values are strings; a YAML number or boolean is accepted and written as its
 * text, because `pulumi config set --path` stores `true` as a boolean and
 * nobody setting `SB_BILLING_ENABLED` should have to know that.
 */
export function readAppSettings(env: unknown, secrets: unknown, owned: OwnedSettings): AppSettings {
  const plain = asMap(env, "simple-balance:env");
  const secret = asMap(secrets, "simple-balance:secrets");
  const known = new Set<string>([...SERVER_SETTINGS, ...COLLECTOR_SETTINGS]);
  const secretNames = new Set<string>([...SECRET_SETTINGS, ...COLLECTOR_SECRET_SETTINGS]);

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
          `simple-balance:${where}.${name} is not a setting the application or its metrics collector ` +
            "reads, so it would reach the machine and be ignored there. Check the spelling against " +
            `docs/deployment.md, or remove it: pulumi config rm --path 'simple-balance:${where}.${name}'`,
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

  checkCollectorSettings({ ...plain, ...secret });
  return { plain, secret };
}

/**
 * The collector's values, refused here where the collector would refuse them.
 *
 * Only the shapes the collector cannot start with, and the one interval it
 * would start with and be wrong at: an empty value is the same as unset, and
 * the endpoint is checked for a scheme and a host and nothing more, because
 * what a backend answers at it is the backend's business. The interval and
 * the endpoint are held to the chart's own patterns, in `values.schema.json`,
 * on every profile: a cluster program hands both to the chart unchanged, and
 * a value the schema refuses is refused there in the middle of a Helm rollout
 * and named as a chart value rather than as the stack's setting.
 */
function checkCollectorSettings(all: Readonly<Record<string, string>>): void {
  const protocol = all.SB_METRICS_EXPORT_PROTOCOL;
  if (protocol && !(METRICS_EXPORT_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new Error(
      `simple-balance:env.SB_METRICS_EXPORT_PROTOCOL is ${METRICS_EXPORT_PROTOCOLS.join(" or ")}. ` +
        `Got "${protocol}", which the collector has no pipeline for and would refuse at startup.`,
    );
  }

  const interval = all.SB_METRICS_SCRAPE_INTERVAL;
  if (interval) {
    const seconds = durationSeconds(interval);
    if (seconds === undefined || seconds <= 0) {
      throw new Error(
        `simple-balance:env.SB_METRICS_SCRAPE_INTERVAL is a duration in minutes and seconds, such as 30s or 1m30s. Got "${interval}".`,
      );
    }
    // New Relic converts a cumulative counter to a rate by remembering its
    // last value, and forgets a series that has been silent for five minutes.
    // An interval that long is a collector that starts, sends, and loses every
    // rate, which is worse than one that refuses.
    if (seconds >= 300) {
      throw new Error(
        `simple-balance:env.SB_METRICS_SCRAPE_INTERVAL is "${interval}", and it has to be under 5m: ` +
          "New Relic forgets a series silent for five minutes, and every rate built on it.",
      );
    }
  }

  const endpoint = all.SB_METRICS_EXPORT_ENDPOINT;
  if (endpoint && !/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(endpoint)) {
    throw new Error(
      "simple-balance:env.SB_METRICS_EXPORT_ENDPOINT is an http:// or https:// URL, such as " +
        `https://otlp.nr-data.net. Got "${endpoint}".`,
    );
  }

  // Never echoed: it carries the backend's credential.
  const headers = all.SB_METRICS_EXPORT_HEADERS;
  if (headers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(headers);
    } catch {
      parsed = undefined;
    }
    const isMap =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string");
    if (!isMap) {
      throw new Error(
        "simple-balance:secrets.SB_METRICS_EXPORT_HEADERS is a JSON object of header names to text " +
          `values, such as {"api-key":"<license key>"}. The value is not one, and is not printed here.`,
      );
    }
  }

  const target = all.SB_METRICS_DATABASE_TARGET;
  if (target && !/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/.test(target)) {
    throw new Error(
      `simple-balance:env.SB_METRICS_DATABASE_TARGET is host:port, such as db.internal:9100. Got "${target}".`,
    );
  }
}

/**
 * A duration in minutes and seconds — `30s`, `1m`, `1m30s` — in seconds, or
 * undefined when it is not one.
 *
 * The chart's grammar, `collector.scrapeInterval` in `values.schema.json`,
 * rather than the whole of Prometheus' — whose `ms`, `h`, `d`, `w` and `y` the
 * chart refuses — and for every profile rather than the cluster's alone, so a
 * stack's settings mean the same thing on either kind of program. What it
 * leaves out is nothing an interval under five minutes needs.
 */
function durationSeconds(text: string): number | undefined {
  const match = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!match || text === "") return undefined;
  const [, m, s] = match.map((part) => Number(part ?? 0));
  return m! * 60 + s!;
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

/** Metrics export as a stack configured it, with the compose files' defaults filled in. */
export interface MetricsExport {
  readonly endpoint: string;
  readonly protocol: (typeof METRICS_EXPORT_PROTOCOLS)[number];
  readonly scrapeInterval: string;
  readonly environment: string;
  /** The JSON header map, from `secrets`; absent for a backend that needs none. */
  readonly headers?: string;
  /** `host:port`, when the stack names one; the single programs decide it instead. */
  readonly databaseTarget?: string;
}

/**
 * Whether a stack exports metrics, and how — undefined when it does not.
 *
 * The one question every program asks of these settings: the single-machine
 * programs to decide whether to open the database node's exporter port and own
 * SB_METRICS_DATABASE_TARGET, the cluster programs to decide whether the chart
 * runs a collector at all. An endpoint is what turns it on, and nothing else
 * does, which is the same rule `simple-balance-env` applies on the machine; a
 * protocol or a header map with no endpoint is a setting for a collector that
 * does not run.
 */
export function metricsExport(settings: AppSettings): MetricsExport | undefined {
  const all: Readonly<Record<string, string>> = { ...settings.plain, ...settings.secret };
  const endpoint = all.SB_METRICS_EXPORT_ENDPOINT ?? "";
  if (endpoint === "") return undefined;
  const or = (name: keyof typeof COLLECTOR_DEFAULTS) => all[name] || COLLECTOR_DEFAULTS[name];
  return {
    endpoint,
    protocol: or("SB_METRICS_EXPORT_PROTOCOL") as MetricsExport["protocol"],
    scrapeInterval: or("SB_METRICS_SCRAPE_INTERVAL"),
    environment: or("SB_METRICS_ENVIRONMENT"),
    ...(all.SB_METRICS_EXPORT_HEADERS ? { headers: all.SB_METRICS_EXPORT_HEADERS } : {}),
    ...(all.SB_METRICS_DATABASE_TARGET ? { databaseTarget: all.SB_METRICS_DATABASE_TARGET } : {}),
  };
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
 *
 * The collector's settings go nowhere from here. They are not the
 * application's, and `extraEnv` is the application's ConfigMap; a program
 * hands them to the chart's collector from `metricsExport` instead. What they
 * do decide here is `metrics.enabled`, in the one case the stack left it
 * unsaid: an export endpoint with no METRICS_ENABLED means a collector scraping
 * a /metrics that is not there, so it is written as true, and the values say
 * what the pods will run with. That is belt and braces, because the chart
 * turns /metrics on whenever its collector runs and never derives it off
 * (`_helpers.tpl`). So a METRICS_ENABLED=false the stack set beside an
 * endpoint is passed to the chart as it is, and the chart overrides it. A
 * single machine is the one place it holds: `simple-balance-env` keeps the
 * false there and says so at every start.
 */
export function chartConfig(plain: Readonly<Record<string, string>>): ChartConfig {
  const out: ChartConfig = { extraEnv: {} };
  const collector = new Set<string>(COLLECTOR_SETTINGS);
  if (plain.SB_METRICS_EXPORT_ENDPOINT && plain.METRICS_ENABLED === undefined) {
    out.metrics = { enabled: true };
  }
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
    if (collector.has(name)) continue;
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
