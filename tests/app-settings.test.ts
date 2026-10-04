import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECRET_SETTINGS,
  SERVER_SETTINGS,
  chartConfig,
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
      /STRIPE_PRICE_MONTHLY is not a setting the application reads/,
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
      OCI_TENANCY_OCID: "not a setting the application reads",
      SMTP_HOST: "empty, which is the same as unset",
    });
  });

  it("leaves out only names the application reads, so each reason is about a real setting", () => {
    const known = new Set<string>(SERVER_SETTINGS);
    expect(Object.keys(LEFT_OUT).filter((name) => !known.has(name))).toEqual([]);
  });
});
