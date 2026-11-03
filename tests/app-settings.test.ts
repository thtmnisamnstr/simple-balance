import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_SECRET_SETTINGS,
  COLLECTOR_SETTINGS,
  SECRET_SETTINGS,
  SERVER_SETTINGS,
  chartConfig,
  metricsExport,
  readAppSettings,
  settingsEnvFile,
} from "../deploy/pulumi/common/app-settings.js";
import {
  LEFT_OUT,
  parseEnvFile,
  plan,
  settingsLists,
} from "../deploy/pulumi/settings-from-env.mjs";
import { sourceFiles } from "./support/source.js";

/**
 * The stack's own settings — `simple-balance:env` and `simple-balance:secrets`
 * — as every Pulumi program reads them, and the script that fills them from a
 * `.env`.
 *
 * The module under test is the one place a deployment decides which settings a
 * stack may hold and which of them are secrets, and it keeps a copy of two
 * lists the server owns, because the deploy programs are vendored without
 * `src/`. A copy drifts, so the first block holds both copies to the source.
 */

const root = path.resolve(import.meta.dirname, "..");

describe("the two lists the deploy programs keep a copy of", () => {
  /**
   * What the server reads, by every route it reads by — the same derivation
   * `tests/env-example.test.ts` makes for the compose files, with comments
   * blanked so prose cannot add a name.
   */
  const serverReads = () => {
    const code = sourceFiles("src/server")
      .map((file) => file.code)
      .join("\n");
    return new Set(
      [
        /process\.env\.([A-Z][A-Z0-9_]*)\b/g,
        /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
        /readSecret\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
        /boundedEnvironmentInteger\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
      ].flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]!)),
    );
  };

  it("names every setting the server reads, and nothing it does not", () => {
    // A setting added to the server and not here would be refused by every
    // stack that tried to set it; one removed would be accepted and ignored.
    // The secrets come through `config-files.ts`, which reads them through a
    // list rather than by name, so they are added from the list below.
    const reads = new Set([...serverReads(), ...SECRET_SETTINGS]);
    expect([...SERVER_SETTINGS].sort()).toEqual([...reads].sort());
  });

  it("calls a secret exactly what the server calls a secret", () => {
    const source = readFileSync(path.join(root, "src/server/config-files.ts"), "utf8");
    const list = /const FILE_BACKED_SECRETS = \[([^\]]*)\] as const;/.exec(source);
    expect(list, "FILE_BACKED_SECRETS in config-files.ts").not.toBeNull();
    const fileBacked = [...list![1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]!);
    expect([...SECRET_SETTINGS].sort()).toEqual(fileBacked.sort());
  });

  it("is what the .env script reads them as", () => {
    // The script reads the module as text because Node 20 cannot import it, so
    // a refactor that changed the declaration's shape would leave it reading
    // nothing — or, worse, half.
    const lists = settingsLists();
    expect(lists.server).toEqual([...SERVER_SETTINGS]);
    expect(lists.secret).toEqual([...SECRET_SETTINGS]);
    expect(lists.collector).toEqual([...COLLECTOR_SETTINGS]);
    expect(lists.collectorSecret).toEqual([...COLLECTOR_SECRET_SETTINGS]);
  });

  it("keeps the collector's names apart from the server's, and its secret among them", () => {
    // tests/collector-config.test.ts derives the collector's list from the
    // compose files; this is what keeps the two lists from overlapping, which
    // would make the first one stop meaning "what src/server reads".
    const server = new Set<string>(SERVER_SETTINGS);
    expect(COLLECTOR_SETTINGS.filter((name) => server.has(name))).toEqual([]);
    for (const name of COLLECTOR_SECRET_SETTINGS) expect(COLLECTOR_SETTINGS).toContain(name);
  });
});

describe("readAppSettings, which every program runs at plan time", () => {
  const OWNED = { APP_BASE_URL: "it is simple-balance:hostname, so set that" };

  it("accepts the two maps, and writes YAML's numbers and booleans as their text", () => {
    const settings = readAppSettings(
      { SB_BILLING_ENABLED: true, SMTP_PORT: 587, MAIL_FROM: "Simple Balance <b@example.com>" },
      { STRIPE_SECRET_KEY: "rk_live_x" },
      OWNED,
    );
    expect(settings.plain).toEqual({
      SB_BILLING_ENABLED: "true",
      SMTP_PORT: "587",
      MAIL_FROM: "Simple Balance <b@example.com>",
    });
    expect(settings.secret).toEqual({ STRIPE_SECRET_KEY: "rk_live_x" });
    expect(readAppSettings(undefined, undefined, OWNED)).toEqual({ plain: {}, secret: {} });
  });

  it("refuses a name the application does not read, which would be ignored on the machine", () => {
    expect(() => readAppSettings({ STRIPE_PRICE_MONTHLY: "price_x" }, {}, OWNED)).toThrow(
      /STRIPE_PRICE_MONTHLY is not a setting the application or its metrics collector reads/,
    );
  });

  it("refuses a secret in env, which is committed in the clear, and says how to move it", () => {
    expect(() => readAppSettings({ STRIPE_SECRET_KEY: "rk_live_x" }, {}, OWNED)).toThrow(
      /env\.STRIPE_SECRET_KEY is a secret[\s\S]*--secret --path 'simple-balance:secrets\.STRIPE_SECRET_KEY'/,
    );
  });

  it("refuses the same name in both, and a name the program decides itself", () => {
    expect(() => readAppSettings({ SMTP_USERNAME: "a" }, { SMTP_USERNAME: "b" }, OWNED)).toThrow(
      /set in both/,
    );
    expect(() => readAppSettings({ APP_BASE_URL: "https://x" }, {}, OWNED)).toThrow(
      /cannot be set here: it is simple-balance:hostname/,
    );
  });

  it("refuses a value it cannot carry on one line, without printing it", () => {
    let message = "";
    try {
      readAppSettings({}, { SMTP_PASSWORD: "first\nsecond-and-secret" }, OWNED);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SMTP_PASSWORD has a line break/);
    expect(message).not.toContain("second-and-secret");
    expect(() => readAppSettings({ SMTP_PORT: [587] }, {}, OWNED)).toThrow(/is a object/);
    expect(() => readAppSettings("SB_BILLING_ENABLED=true", {}, OWNED)).toThrow(/is a map/);
  });
});

describe("the metrics collector's settings, which ride the same two maps", () => {
  const OWNED = { SB_METRICS_DATABASE_TARGET: "this program decides it from the node it built" };
  const NR = "https://otlp.nr-data.net";

  it("accepts them, the headers as a secret, and writes them into the machine's settings file", () => {
    const settings = readAppSettings(
      { SB_METRICS_EXPORT_ENDPOINT: NR, SB_METRICS_SCRAPE_INTERVAL: "15s" },
      { SB_METRICS_EXPORT_HEADERS: '{"api-key":"NRAL-x"}' },
      {},
    );
    expect(settingsEnvFile(settings)).toContain(
      `SB_METRICS_EXPORT_ENDPOINT='${NR}'\nSB_METRICS_EXPORT_HEADERS='{"api-key":"NRAL-x"}'\n` +
        "SB_METRICS_SCRAPE_INTERVAL='15s'\n",
    );
  });

  it("refuses the headers in env, because they carry the backend's credential", () => {
    expect(() =>
      readAppSettings({ SB_METRICS_EXPORT_HEADERS: '{"api-key":"NRAL-x"}' }, {}, {}),
    ).toThrow(/env\.SB_METRICS_EXPORT_HEADERS is a secret/);
  });

  it("refuses at plan time what the collector would refuse at startup", () => {
    expect(() => readAppSettings({ SB_METRICS_EXPORT_PROTOCOL: "otlphttp" }, {}, {})).toThrow(
      /SB_METRICS_EXPORT_PROTOCOL is otlp or prometheus_remote_write\. Got "otlphttp"/,
    );
    expect(() =>
      readAppSettings({ SB_METRICS_EXPORT_ENDPOINT: "otlp.nr-data.net" }, {}, {}),
    ).toThrow(/http:\/\/ or https:\/\/ URL/);
    expect(() => readAppSettings({ SB_METRICS_SCRAPE_INTERVAL: "thirty" }, {}, {})).toThrow(
      /a duration in minutes and seconds, such as 30s/,
    );
    expect(() => readAppSettings({ SB_METRICS_DATABASE_TARGET: "db.internal" }, {}, {})).toThrow(
      /host:port/,
    );
    for (const accepted of ["otlp", "prometheus_remote_write"]) {
      expect(() => readAppSettings({ SB_METRICS_EXPORT_PROTOCOL: accepted }, {}, {})).not.toThrow();
    }
  });

  it("refuses an interval of five minutes or more, which loses every rate rather than resolution", () => {
    // New Relic forgets a cumulative series after five minutes of silence.
    for (const interval of ["5m", "300s", "10m", "4m60s"]) {
      expect(
        () => readAppSettings({ SB_METRICS_SCRAPE_INTERVAL: interval }, {}, {}),
        interval,
      ).toThrow(/has to be under 5m/);
    }
    for (const interval of ["30s", "1m", "4m59s", "1m30s"]) {
      expect(
        () => readAppSettings({ SB_METRICS_SCRAPE_INTERVAL: interval }, {}, {}),
        interval,
      ).not.toThrow();
    }
  });

  it("takes only what the chart's schema takes, so a cluster refuses at the plan and not mid-rollout", () => {
    // Prometheus would read every one of these intervals, and the chart
    // refuses each of them; the endpoints have a space after them, or no host.
    for (const interval of ["500ms", "15s500ms", "0h30s", "1h", "30S"]) {
      expect(
        () => readAppSettings({ SB_METRICS_SCRAPE_INTERVAL: interval }, {}, {}),
        interval,
      ).toThrow(/a duration in minutes and seconds/);
    }
    for (const endpoint of ["https://otlp.nr-data.net ", "https://?x", "https://#x", "https://"]) {
      expect(
        () => readAppSettings({ SB_METRICS_EXPORT_ENDPOINT: endpoint }, {}, {}),
        JSON.stringify(endpoint),
      ).toThrow(/http:\/\/ or https:\/\/ URL/);
    }
  });

  it("refuses headers that are not a map of text, without printing them", () => {
    for (const headers of ["NRAL-secret-value", '["NRAL-secret-value"]', '{"api-key":12345}']) {
      let message = "";
      try {
        readAppSettings({}, { SB_METRICS_EXPORT_HEADERS: headers }, {});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, headers).toMatch(/is a JSON object of header names to text values/);
      expect(message, headers).not.toContain("NRAL-secret-value");
      expect(message, headers).not.toContain("12345");
    }
  });

  it("lets a program own the database target, as the single-machine programs do", () => {
    expect(() => readAppSettings({ SB_METRICS_DATABASE_TARGET: "db:9100" }, {}, OWNED)).toThrow(
      /SB_METRICS_DATABASE_TARGET cannot be set here: this program decides it/,
    );
  });

  it("says export is on exactly when an endpoint is set, with the compose files' defaults", () => {
    expect(metricsExport(readAppSettings({}, {}, {}))).toBeUndefined();
    // A protocol with nowhere to send is a setting for a collector that does
    // not run, which is the same answer simple-balance-env gives on the machine.
    expect(
      metricsExport(readAppSettings({ SB_METRICS_EXPORT_PROTOCOL: "otlp" }, {}, {})),
    ).toBeUndefined();
    expect(metricsExport(readAppSettings({ SB_METRICS_EXPORT_ENDPOINT: NR }, {}, {}))).toEqual({
      endpoint: NR,
      protocol: "otlp",
      scrapeInterval: "30s",
      environment: "production",
    });
    expect(
      metricsExport(
        readAppSettings(
          {
            SB_METRICS_EXPORT_ENDPOINT: "https://metric-api.newrelic.com/prometheus/v1/write",
            SB_METRICS_EXPORT_PROTOCOL: "prometheus_remote_write",
            SB_METRICS_ENVIRONMENT: "staging",
            SB_METRICS_DATABASE_TARGET: "db.internal:9100",
          },
          { SB_METRICS_EXPORT_HEADERS: '{"Authorization":"Bearer NRAL-x"}' },
          {},
        ),
      ),
    ).toEqual({
      endpoint: "https://metric-api.newrelic.com/prometheus/v1/write",
      protocol: "prometheus_remote_write",
      scrapeInterval: "30s",
      environment: "staging",
      headers: '{"Authorization":"Bearer NRAL-x"}',
      databaseTarget: "db.internal:9100",
    });
  });
});

describe("settingsEnvFile, which is what the machine's Compose reads", () => {
  it("single-quotes every value so Compose takes $ and # literally, in a stable order", () => {
    const text = settingsEnvFile({
      plain: { SB_BILLING_ENABLED: "true" },
      secret: { SMTP_PASSWORD: "p@ss $word #1" },
    });
    expect(text).toBe(
      "# Written by Pulumi from simple-balance:env and simple-balance:secrets.\n" +
        "SB_BILLING_ENABLED='true'\nSMTP_PASSWORD='p@ss $word #1'\n",
    );
    // What the machine's fetch accepts as settings, line for line.
    for (const line of text.trimEnd().split("\n")) {
      expect(line).toMatch(/^(#.*|[A-Z][A-Z0-9_]*='[^']*')$/);
    }
  });

  it("refuses a single quote, which no quoting Compose reads literally can carry", () => {
    expect(() => settingsEnvFile({ plain: {}, secret: { SMTP_PASSWORD: "it's" } })).toThrow(
      /SMTP_PASSWORD has a single quote/,
    );
  });

  it("is never empty, because OCI Vault refuses a secret with no content", () => {
    expect(settingsEnvFile({ plain: {}, secret: {} }).length).toBeGreaterThan(0);
  });
});

describe("chartConfig, which is what the Kubernetes programs hand the chart", () => {
  it("sends the chart's own settings to its own values, typed, and the rest to extraEnv", () => {
    expect(
      chartConfig({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "b@example.com",
        SMTP_PORT: "465",
        SMTP_SSL: "true",
        CSV_MAX_ROWS: "5000",
        RECURRENCE_TICK_SECONDS: "60",
        SB_BILLING_ENABLED: "true",
        STRIPE_PUBLISHABLE_KEY: "pk_live_x",
      }),
    ).toEqual({
      mail: { host: "smtp.example.com", from: "b@example.com", port: 465, ssl: true },
      csvMaxRows: 5000,
      recurrence: { tickSeconds: 60 },
      // STRIPE_PUBLISHABLE_KEY in extraEnv is also what tells the chart's
      // frontend that Stripe is configured.
      extraEnv: { SB_BILLING_ENABLED: "true", STRIPE_PUBLISHABLE_KEY: "pk_live_x" },
    });
  });

  it("keeps the collector's settings out of the application's ConfigMap, and turns /metrics on for it", () => {
    // An endpoint with METRICS_ENABLED unsaid is a collector scraping a route
    // that is not registered, so the chart is told to register it.
    expect(
      chartConfig({ SB_METRICS_EXPORT_ENDPOINT: "https://otlp.nr-data.net", LOG_LEVEL: "info" }),
    ).toEqual({ logLevel: "info", metrics: { enabled: true }, extraEnv: {} });
    // A METRICS_ENABLED the stack did set is passed through as it is, either
    // way; the chart decides what a false beside its own collector means, and
    // turns /metrics on regardless.
    expect(
      chartConfig({
        SB_METRICS_EXPORT_ENDPOINT: "https://otlp.nr-data.net",
        METRICS_ENABLED: "false",
      }),
    ).toEqual({ metrics: { enabled: false }, extraEnv: {} });
    expect(chartConfig({ SB_METRICS_EXPORT_PROTOCOL: "otlp" })).toEqual({ extraEnv: {} });
  });

  it("refuses a value the chart's schema would refuse halfway through a rollout", () => {
    expect(() => chartConfig({ SMTP_PORT: "five-eight-seven" })).toThrow(/whole number/);
    expect(() => chartConfig({ METRICS_ENABLED: "yes" })).toThrow(/true or false/);
  });
});

describe("settings-from-env.mjs, which fills a stack from a .env", () => {
  it("reads the file literally, the way Compose does and a shell would not", () => {
    expect(
      parseEnvFile(
        [
          "# a comment",
          "MAIL_FROM=Simple Balance <balance@example.com>",
          "SMTP_PASSWORD='p@ss $word'",
          'SB_BILLING_ENABLED="true"',
          "export LOG_LEVEL=info",
          "",
          "not a setting line",
        ].join("\n"),
      ),
    ).toEqual([
      ["MAIL_FROM", "Simple Balance <balance@example.com>"],
      ["SMTP_PASSWORD", "p@ss $word"],
      ["SB_BILLING_ENABLED", "true"],
      ["LOG_LEVEL", "info"],
    ]);
  });

  it("copies settings, secrets as secrets, and leaves out where a development .env points", () => {
    const { set, skipped } = plan([
      ["STRIPE_SECRET_KEY", "rk_live_x"],
      ["SB_BILLING_ENABLED", "true"],
      ["DATABASE_URL", "postgresql://localhost/dev"],
      ["APP_BASE_URL", "http://localhost:5173"],
      ["TRUST_PROXY", "false"],
      ["OCI_TENANCY_OCID", "ocid1.tenancy.oc1..x"],
      ["SMTP_HOST", ""],
    ]);
    expect(set).toEqual([
      { name: "STRIPE_SECRET_KEY", value: "rk_live_x", secret: true },
      { name: "SB_BILLING_ENABLED", value: "true", secret: false },
    ]);
    expect(Object.fromEntries(skipped)).toEqual({
      DATABASE_URL: LEFT_OUT.DATABASE_URL,
      APP_BASE_URL: LEFT_OUT.APP_BASE_URL,
      TRUST_PROXY: LEFT_OUT.TRUST_PROXY,
      OCI_TENANCY_OCID: "not a setting the application or its metrics collector reads",
      SMTP_HOST: "empty, which is the same as unset",
    });
  });

  it("leaves out only names the application reads, so each reason is about a real setting", () => {
    const known = new Set<string>([...SERVER_SETTINGS, ...COLLECTOR_SETTINGS]);
    expect(Object.keys(LEFT_OUT).filter((name) => !known.has(name))).toEqual([]);
  });
});
