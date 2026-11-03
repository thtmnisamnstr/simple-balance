import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { COLLECTOR_DEFAULTS } from "../deploy/pulumi/common/app-settings.js";
import { repoFiles } from "./support/source.js";

/**
 * The chart's metrics collector: one pod per release that finds the API and
 * scheduler pods, scrapes them, and sends the result to one backend.
 *
 * Read as text, for the reason `tests/helm-shapes.test.ts` gives: helm is not
 * on this job's PATH, and the workflow renders the collector in a job of its
 * own and puts the configuration that render produces through the pinned
 * collector binary. What this file holds is what that render cannot say — that
 * the default never moved, that the copy of the pipeline is the copy, that the
 * port names the discovery keeps are the port names the Deployments declare.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const values = read("values.yaml");
const schema = JSON.parse(read("values.schema.json")) as {
  properties: Record<string, { properties?: Record<string, unknown> }>;
};
const config = read("templates/collector-config.yaml");
const deployment = read("templates/collector-deployment.yaml");
const rbac = read("templates/collector-rbac.yaml");
const helpers = read("templates/_helpers.tpl");

/** A top-level `key:` block of a values file, up to the next unindented line. */
function block(file: string, key: string): string {
  const start = file.indexOf(`\n${key}:\n`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const end = rest.search(/\n[a-zA-Z]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** A file's lines with whole-line comments, YAML or template, left out. */
const uncommented = (text: string) =>
  text
    .replace(/\{\{-? ?\/\*[\s\S]*?\*\/ ?-?\}\}/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const collectorValues = block(values, "collector");

describe("off unless asked for", () => {
  it("is off in the chart's own values", () => {
    // A default that started a pod, a Role and a token on every upgrade would
    // be the release changing a deployment nobody asked to change.
    expect(collectorValues).toMatch(/^collector:\n {2}enabled: false\n/);
  });

  it("is named by neither shape, which differ only in numbers", () => {
    for (const shape of ["values-ha.yaml", "values-node-per-service.yaml"]) {
      expect(read(shape), shape).not.toMatch(/^collector:/m);
    }
  });

  it("guards every object it renders behind the one switch", () => {
    for (const file of [
      "templates/collector-config.yaml",
      "templates/collector-deployment.yaml",
      "templates/collector-rbac.yaml",
      "templates/collector-secret.yaml",
    ]) {
      expect(read(file).split("\n")[0], file).toMatch(
        /^\{\{- if (and \()?include "simple-balance\.collectorEnabled" \.\)?/,
      );
    }
  });

  it("reads the switch through a helper that survives the block being removed", () => {
    // The ConfigMap every pod reads asks this question, and it rendered before
    // there was a collector to ask about; `collector: null` must not stop it.
    expect(helpers).toContain("{{- if (.Values.collector | default dict).enabled }}true{{ end -}}");
  });
});

describe("one collector, never two", () => {
  it("runs exactly one replica, with no value that could change it", () => {
    // Two collectors send every series twice, and New Relic turns a cumulative
    // counter into a rate from its last value, so two interleaved copies are
    // nonsense rather than redundancy.
    expect(uncommented(deployment)).toMatch(/^ {2}replicas: 1$/m);
    expect(collectorValues).not.toMatch(/replicaCount|autoscaling|podDisruptionBudget/);
    expect(read("templates/hpa.yaml")).not.toContain("collector");
    expect(read("templates/poddisruptionbudget.yaml")).not.toContain("collector");
  });

  it("recreates rather than rolls, so a surge pod is never the second copy", () => {
    expect(uncommented(deployment)).toMatch(/^ {2}strategy:\n {4}type: Recreate$/m);
  });
});

describe("the image", () => {
  /** The compose services' pin, which is what the shared pipeline was validated against. */
  const composePins = repoFiles(
    (file) => file.startsWith("deploy/compose/") && /\.ya?ml$/.test(file),
  ).flatMap(({ text }) =>
    [...text.matchAll(/image: (otel\/opentelemetry-collector:[^\s@]+@sha256:[0-9a-f]{64})/g)].map(
      (match) => match[1]!,
    ),
  );

  it("is pinned by tag and digest, to the same pair the compose recipes run", () => {
    expect(composePins.length).toBeGreaterThan(0);
    const tag = /^ {4}tag: "([^"]+)"$/m.exec(collectorValues)?.[1];
    const digest = /^ {4}digest: (sha256:[0-9a-f]{64})$/m.exec(collectorValues)?.[1];
    const repository = /^ {4}repository: (\S+)$/m.exec(collectorValues)?.[1];
    expect(tag).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(composePins)).toEqual(new Set([`${repository}:${tag}@${digest}`]));
  });

  it("names a registry of its own, so global.imageRegistry is never put in front of it", () => {
    // That setting is where this project's images live; prefixing it here
    // would name an image that does not exist.
    expect(collectorValues).toMatch(/^ {4}registry: docker\.io$/m);
    expect(helpers).toContain(
      'printf "%s/%s:%s@%s" $image.registry $image.repository $image.tag $image.digest',
    );
  });

  it("cannot be unpinned through the schema", () => {
    const image = (
      schema as unknown as {
        definitions: Record<
          string,
          { required: string[]; properties: Record<string, { pattern?: string }> }
        >;
      }
    ).definitions.collectorImage!;
    expect(image.required).toEqual(expect.arrayContaining(["tag", "digest"]));
    expect(image.properties.digest!.pattern).toBe("^sha256:[a-f0-9]{64}$");
  });
});

describe("what it scrapes", () => {
  /** The port name a Deployment declares on its one container. */
  const portName = (file: string) =>
    /ports:\n\s+(?:#[^\n]*\n\s+)*- name: (\w+)\n\s+containerPort: \{\{ \.Values\.config\.port \}\}/.exec(
      read(file),
    )?.[1];

  for (const [job, component, file] of [
    ["simple-balance-api", "server", "templates/server-deployment.yaml"],
    ["simple-balance-scheduler", "scheduler", "templates/scheduler-deployment.yaml"],
  ] as const) {
    it(`finds every ${component} pod of this release, and keeps the port that Deployment declares`, () => {
      const start = config.indexOf(`- job_name: ${job}\n`);
      expect(start, job).toBeGreaterThan(-1);
      const rest = config.slice(start);
      const jobText = rest.slice(0, rest.indexOf("\n\n"));
      // Per pod rather than per Service: both tiers autoscale, and a Service
      // address is a different replica on every scrape.
      expect(jobText).toContain("- role: pod");
      // Its own namespace, which is all the Role grants.
      expect(jobText).toContain("- {{ .Release.Namespace }}");
      expect(jobText).toContain(
        `label: "{{ $selector }},app.kubernetes.io/component=${component}"`,
      );
      const declared = portName(file);
      expect(declared, file).toBeDefined();
      expect(jobText).toContain(
        `- source_labels: [__meta_kubernetes_pod_container_port_name]\n                  regex: ${declared}\n                  action: keep`,
      );
      // The bearer token, from the same variable the compose recipes use.
      expect(jobText).toContain('credentials: "${env:METRICS_TOKEN:-}"');
    });
  }

  it("selects this release by the labels every component carries", () => {
    expect(config).toContain(
      '$selector := printf "app.kubernetes.io/name=%s,app.kubernetes.io/instance=%s" (include "simple-balance.name" .) .Release.Name',
    );
  });

  it("scrapes the frontend, the database and the nodes not at all", () => {
    // Out of scope by decision: nginx has no metrics endpoint, and the nodes
    // and the database are the cloud's to watch.
    expect(uncommented(config)).not.toMatch(/component=(frontend|database)|role: node/);
  });

  it("scrapes under five minutes by default, in the chart and in the pipeline", () => {
    expect(config).toContain(
      `scrape_interval: \${env:SB_METRICS_SCRAPE_INTERVAL:-${COLLECTOR_DEFAULTS.SB_METRICS_SCRAPE_INTERVAL}}`,
    );
    expect(collectorValues).toMatch(
      new RegExp(`^ {2}scrapeInterval: ${COLLECTOR_DEFAULTS.SB_METRICS_SCRAPE_INTERVAL}$`, "m"),
    );
    expect(collectorValues).toMatch(
      new RegExp(`^ {4}protocol: ${COLLECTOR_DEFAULTS.SB_METRICS_EXPORT_PROTOCOL}$`, "m"),
    );
    expect(collectorValues).toMatch(
      new RegExp(`^ {2}environment: ${COLLECTOR_DEFAULTS.SB_METRICS_ENVIRONMENT}$`, "m"),
    );
    // And the render refuses five minutes or more, which the schema's pattern
    // cannot say.
    expect(helpers).toContain("(ge $total 300)");
  });
});

describe("the export pipeline", () => {
  const OPEN = "# ---- the export pipeline, shared ";
  const CLOSE = "# ---- end of the export pipeline ";

  /** The block between the two markers, with the template's indentation taken off. */
  const shared = (text: string) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trimStart().startsWith(OPEN));
    const end = lines.findIndex((line, at) => at > start && line.trimStart().startsWith(CLOSE));
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const margin = lines[start]!.length - lines[start]!.trimStart().length;
    return lines
      .slice(start, end + 1)
      .map((line) => line.slice(Math.min(margin, line.length - line.trimStart().length)))
      .join("\n");
  };

  it("is the compose recipes' block, word for word", () => {
    // tests/collector-config.test.ts holds every copy under deploy/ to the
    // first; this names the chart's copy, so that one dropping out of that
    // set is a failure rather than a smaller population.
    expect(shared(config)).toBe(shared(read("../../compose/single/collector.yaml")));
  });

  it("is the last thing in the ConfigMap, so nothing after it overrides a key", () => {
    expect(config.trimEnd().endsWith(`${CLOSE}${"-".repeat(43)}\n{{- end }}`)).toBe(true);
  });

  it("passes the pod exactly what the configuration reads", () => {
    const reads = new Set(
      [...uncommented(config).matchAll(/\$\{env:([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!),
    );
    const set = new Set(
      [...uncommented(deployment).matchAll(/^ {12}- name: ([A-Z][A-Z0-9_]*)$/gm)].map(
        (match) => match[1]!,
      ),
    );
    // Read by the Go runtime rather than by the configuration.
    set.delete("GOMEMLIMIT");
    expect([...set].sort()).toEqual([...reads].sort());
  });

  it("listens on the pod's address for the probes, and on loopback for its own figures", () => {
    expect(config).toMatch(/health_check:\n {8}endpoint: ":13133"/);
    expect(deployment).toMatch(/- name: health\n {14}containerPort: 13133/);
    expect(shared(config)).toMatch(/prometheus:\n\s+host: 127\.0\.0\.1\n\s+port: 8888/);
  });
});

describe("what it is allowed", () => {
  it("drops every capability, writes nothing, and is not root", () => {
    expect(collectorValues).toMatch(/runAsNonRoot: true/);
    expect(collectorValues).toMatch(/runAsUser: 10001/);
    expect(collectorValues).toMatch(/seccompProfile:\n {6}type: RuntimeDefault/);
    expect(collectorValues).toMatch(/allowPrivilegeEscalation: false/);
    expect(collectorValues).toMatch(/readOnlyRootFilesystem: true/);
    expect(collectorValues).toMatch(/capabilities:\n {6}drop:\n {8}- ALL/);
    expect(uncommented(deployment)).not.toMatch(/emptyDir|hostPath|persistentVolumeClaim/);
  });

  it("gives the Go runtime a ceiling under the container's, and the limiter one under both", () => {
    const limit = /limits:\n {6}cpu: \S+\n {6}memory: (\d+)Mi/.exec(collectorValues)?.[1];
    const runtime = /- name: GOMEMLIMIT\n {14}value: (\d+)MiB/.exec(deployment)?.[1];
    const limiter = /limit_mib: (\d+)/.exec(config)?.[1];
    expect(limit && runtime && limiter).toBeTruthy();
    expect(Number(runtime)).toBeLessThan(Number(limit));
    expect(Number(limiter)).toBeLessThan(Number(limit));
    // The shared block says it is written against 128 MiB and 80MiB.
    expect(Number(limit)).toBe(128);
    expect(Number(runtime)).toBe(80);
  });

  it("reads pods in its own namespace and nothing else", () => {
    const code = uncommented(rbac);
    expect(code).not.toContain("ClusterRole");
    expect([...code.matchAll(/resources: \[([^\]]*)\]/g)].map((match) => match[1])).toEqual([
      '"pods"',
    ]);
    expect(code).toContain('verbs: ["get", "list", "watch"]');
  });

  it("mounts a token, and is the only pod in the release that does", () => {
    expect(uncommented(deployment)).toContain("automountServiceAccountToken: true");
    expect(block(values, "serviceAccount")).toMatch(/automountServiceAccountToken: false/);
  });
});

describe("its credentials", () => {
  it("never puts the export headers in the Secret the API and the scheduler read", () => {
    // Every key of that Secret is in their environment.
    expect(read("templates/secret.yaml")).not.toContain("SB_METRICS_EXPORT_HEADERS");
    const helper = helpers.slice(
      helpers.indexOf('{{- define "simple-balance.collectorHeadersSecret"'),
    );
    const body = helper.slice(0, helper.indexOf("{{- end }}"));
    expect(body).not.toMatch(/ownSecretName|secretRefs/);
  });

  it("reads METRICS_TOKEN from the Secret whose copy the pods check", () => {
    // A later envFrom source wins a duplicate key, so the last one listed is
    // where the pods' token comes from whenever it is there.
    expect(helpers).toContain(
      '{{- last (fromJsonArray (include "simple-balance.secretRefs" .)) -}}',
    );
    expect(deployment).toMatch(
      /- name: METRICS_TOKEN\n {14}valueFrom:\n {16}secretKeyRef:\n {18}name: \{\{ include "simple-balance\.collectorTokenSecret" \. \}\}\n {18}key: METRICS_TOKEN\n {18}optional: true/,
    );
  });

  /**
   * The token is read from the environment as the collector starts, and the
   * API and the scheduler roll when `secret.yaml` changes. A collector that did
   * not roll with them went on sending the old token to pods that now answer
   * it 401, and `up` read 0 until somebody deleted the pod by hand.
   */
  it("rolls when the Secret holding the token changes, on the hash the pods roll on", () => {
    const hash = '{{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}';
    for (const tier of ["server", "scheduler"]) {
      expect(read(`templates/${tier}-deployment.yaml`), tier).toContain(`checksum/secret: ${hash}`);
    }
    expect(uncommented(deployment)).toContain(`checksum/token: ${hash}`);
  });

  it("refuses a collector with nowhere to send", () => {
    expect(helpers).toContain("collector.enabled needs collector.export.endpoint");
  });

  /**
   * The install note is the only place a release with the collector on and no
   * token is told that /metrics is open. The policy closes the scheduler's
   * port only once something names its peers — with none it admits every
   * source in the cluster — so the note treats it as closed on exactly the
   * values the scheduler's peer list is built from, and on no others. The
   * rendered note is checked in the deploy job of .github/workflows/verify.yml.
   */
  it("warns that /metrics is open until the scheduler's peers or a token close it", () => {
    const policy = read("templates/networkpolicy.yaml");
    const notes = read("templates/NOTES.txt");
    expect(policy).toContain("{{- $schedulerPeers := concat $probes $np.schedulerIngressFrom }}");
    expect(policy).toMatch(/\{\{- range \$np\.probeSourceCidrs \}\}\n\{\{- \$probes = append/);
    expect(notes).toContain(
      "{{- $schedulerClosed := and $np.enabled (or $np.probeSourceCidrs $np.schedulerIngressFrom) }}",
    );
    expect(notes).toContain("{{- if not (or $schedulerClosed .Values.secret.metricsToken) }}");
  });
});

describe("the pods it scrapes", () => {
  it("serve /metrics whenever it runs, and exactly as before when it does not", () => {
    // Derived on, never off, and rendered as the literal strings the earlier
    // `| quote` produced, so a release without a collector renders the line it
    // always did.
    expect(helpers).toContain(
      'METRICS_ENABLED: {{ if or $c.metrics.enabled (include "simple-balance.collectorEnabled" .) }}"true"{{ else }}"false"{{ end }}',
    );
  });

  it("has a schema entry for every value it reads", () => {
    const collector = schema.properties.collector!;
    for (const key of [
      "enabled",
      "image",
      "export",
      "scrapeInterval",
      "environment",
      "resources",
      "serviceAccount",
    ]) {
      expect(collector.properties, key).toHaveProperty(key);
    }
    expect(schema.properties.networkPolicy!.properties).toHaveProperty("apiServerPorts");
  });
});
