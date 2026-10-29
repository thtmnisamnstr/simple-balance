import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readAppSettings } from "../deploy/pulumi/common/app-settings.js";
import { programCode } from "./support/pulumi-source.js";

/**
 * How the cluster programs hand a stack's metrics settings to the chart's
 * collector, read as text for the reason `tests/cluster-pulumi-database.test.ts`
 * gives: the programs cannot be imported without `deploy/pulumi/node_modules`.
 *
 * Three things are held. A stack that sets nothing plans exactly what it
 * planned before. The backend's credential never reaches the Secret every
 * application pod reads. And every value the program hands the chart is one
 * the chart's schema has, because the schema's refusal arrives in the middle
 * of a Helm rollout rather than at preview.
 */

const root = path.resolve(import.meta.dirname, "..");
const common = readFileSync(path.join(root, "deploy/pulumi/common/index.ts"), "utf8");
const code = programCode(common);
const schema = JSON.parse(
  readFileSync(path.join(root, "deploy/helm/simple-balance/values.schema.json"), "utf8"),
) as {
  properties: {
    collector: {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
  };
};

/**
 * The values block the program hands the chart's collector, from its spread to
 * the `ingress` key after it — not to the first `: {})`, which closes the
 * optional `existingSecret` inside it.
 */
const collectorValues = (() => {
  const start = code.indexOf("...(metrics\n");
  expect(start, "the collector values are spread in only when metrics is set").toBeGreaterThan(-1);
  const end = code.indexOf("ingress: {", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
})();

describe("a stack that sets nothing", () => {
  it("decides on an endpoint and nothing else, through the rule the single machines share", () => {
    expect(code).toContain("const metrics = metricsExport(settings.app);");
  });

  it("hands the chart no collector values and builds no Secret", () => {
    // Spread in only when an endpoint is set, so an existing stack's release
    // values diff empty and `pulumi up` plans no change.
    expect(collectorValues).toMatch(/^\.\.\.\(metrics\n\s+\? \{\n\s+collector: \{/);
    expect(code).toMatch(
      /const collectorCredentials = metrics\?\.headers\n\s+\? new k8s\.core\.v1\.Secret\(/,
    );
  });
});

describe("the backend's credential", () => {
  it("stays out of the Secret every API and scheduler pod reads", () => {
    const loop = code.slice(code.indexOf("const collectorSecretNames"));
    expect(loop).toMatch(
      /^const collectorSecretNames = new Set<string>\(COLLECTOR_SECRET_SETTINGS\);\n\s+for \(const \[name, value\] of Object\.entries\(settings\.app\.secret\)\) \{\n\s+if \(collectorSecretNames\.has\(name\)\) continue;\n\s+credentialData\[name\] = pulumi\.secret\(value\);/,
    );
  });

  it("goes into a Secret of the collector's own, which the chart is told to read", () => {
    expect(code).toContain(
      "stringData: { SB_METRICS_EXPORT_HEADERS: pulumi.secret(metrics.headers) },",
    );
    expect(collectorValues).toContain("existingSecret: collectorCredentials.metadata.name");
    // Created before the release that names it, or the collector's first pod
    // fails on a Secret that does not exist yet.
    expect(code).toMatch(/\.\.\.\(collectorCredentials \? \[collectorCredentials\] : \[\]\)/);
  });

  it("never travels through chart values, which land in Helm's history", () => {
    expect(collectorValues).not.toContain("headers:");
  });
});

describe("what the chart is told", () => {
  it("turns it on with every value spelled out, from metricsExport", () => {
    for (const line of [
      "enabled: true",
      "endpoint: metrics.endpoint",
      "protocol: metrics.protocol",
      "scrapeInterval: metrics.scrapeInterval",
      "environment: metrics.environment",
    ]) {
      expect(collectorValues, line).toContain(line);
    }
  });

  it("names only values the chart's schema has", () => {
    // The root schema refuses an unknown key, and refuses it mid-rollout.
    const collector = schema.properties.collector.properties;
    for (const key of ["enabled", "export", "scrapeInterval", "environment"]) {
      expect(collector, key).toHaveProperty(key);
    }
    for (const key of ["endpoint", "protocol", "existingSecret"]) {
      expect(collector.export!.properties, `export.${key}`).toHaveProperty(key);
    }
  });

  /**
   * The program hands the interval and the endpoint to the chart as the stack
   * wrote them, so a value the settings check took and the schema refuses
   * reaches Helm, which refuses it mid-rollout and names a chart value nobody
   * set. Every candidate either side might take, put to both.
   */
  it("takes no interval or endpoint the chart's schema would refuse", () => {
    const pattern = (property: { pattern?: string } | undefined) => {
      expect(property?.pattern).toBeDefined();
      return new RegExp(property!.pattern!);
    };
    const collector = schema.properties.collector.properties;
    const interval = pattern(collector.scrapeInterval as { pattern?: string });
    const endpoint = pattern(
      (collector.export!.properties as Record<string, { pattern?: string }>).endpoint,
    );
    const takes = (env: Record<string, string>) => {
      try {
        readAppSettings(env, {}, {});
        return true;
      } catch {
        return false;
      }
    };
    // Not vacuous: the ordinary values are taken, so each is put to the schema.
    expect(takes({ SB_METRICS_SCRAPE_INTERVAL: "30s" })).toBe(true);
    expect(takes({ SB_METRICS_EXPORT_ENDPOINT: "https://otlp.nr-data.net" })).toBe(true);
    for (const value of ["30s", "1m", "1m30s", "4m59s", "500ms", "15s500ms", "0h30s", "1h", "90"]) {
      if (takes({ SB_METRICS_SCRAPE_INTERVAL: value })) expect(value, value).toMatch(interval);
    }
    for (const value of [
      "https://otlp.nr-data.net",
      "https://otlp.eu01.nr-data.net/",
      "https://metric-api.newrelic.com/prometheus/v1/write?prometheus_server=simple-balance",
      "http://collector.internal:4318",
      "https://otlp.nr-data.net ",
      "https://?x",
      "https://#x",
      "https:// x",
    ]) {
      if (takes({ SB_METRICS_EXPORT_ENDPOINT: value })) {
        expect(value, JSON.stringify(value)).toMatch(endpoint);
      }
    }
  });

  it("refuses a database target a cluster has no machine for", () => {
    expect(code).toMatch(/SB_METRICS_DATABASE_TARGET:\n\s+"a cluster has no database machine/);
  });
});
