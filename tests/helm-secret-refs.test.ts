import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which Secrets the API and the scheduler take their environment from, and in
 * which order.
 *
 * The order is a contract rather than a detail. Kubernetes lets a later
 * `envFrom` source win a duplicate key, so the list decides whose DATABASE_URL
 * the pods actually use — and with an in-cluster database there really are two
 * candidates, because the chart derives one for the cluster it built and the
 * Pulumi programs supply a Secret holding everything else. Reversed, a stack
 * would install cleanly and connect to the wrong database, or to none.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const helpers = read("templates/_helpers.tpl");

/** One `{{- define "name" -}} ... {{- end }}` block of the helpers file. */
function define(name: string): string {
  const start = helpers.indexOf(`{{- define "${name}"`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = helpers.slice(start);
  const end = rest.indexOf("\n{{/*");
  return end === -1 ? rest : rest.slice(0, end);
}

const secretRefs = define("simple-balance.secretRefs");

/**
 * The part of the helper that builds the list, which starts where the list
 * does. Sliced rather than searched whole because `existingSecret` is named
 * twice — once in the guard above that refuses both Secrets together, and once
 * where it is appended — and only the second says anything about order.
 */
const appendSection = secretRefs.slice(secretRefs.indexOf("$names := list"));

describe("the list of Secrets the pods read", () => {
  it("puts the chart's own first and the operator's second", () => {
    // Later wins, so the operator's Secret goes last and what they supplied
    // beats what this render worked out — the precedence every other setting in
    // the chart has. Asserted by position rather than by presence, because both
    // orders contain both names and only one of them is right.
    const own = appendSection.indexOf('include "simple-balance.ownSecretName"');
    const existing = appendSection.indexOf(".Values.secret.existingSecret");
    expect(own).toBeGreaterThan(-1);
    expect(existing).toBeGreaterThan(-1);
    expect(own).toBeLessThan(existing);
  });

  it("appends from exactly those two places and nowhere else", () => {
    // A third `append` would be a third source whose precedence nobody decided,
    // and it would sit silently between two that were argued over.
    expect(appendSection.match(/\$names = append \$names/g)).toHaveLength(2);
  });

  it("refuses both at once unless the chart is running the database", () => {
    // Naming an existingSecret and leaving create on is two sources of
    // DATABASE_URL with no stated precedence, which is a deployment nobody can
    // reason about. The one shape where both are right is the one where each
    // carries a different half, and that is what the condition has to say.
    expect(secretRefs).toContain("(not .Values.database.enabled) }}");
    expect(secretRefs).toContain("{{- fail ");
  });

  it("refuses a deployment with no Secret at all", () => {
    expect(secretRefs).toContain("{{- if not $names }}");
  });
});

describe("the Deployments that read it", () => {
  for (const tier of ["server", "scheduler"] as const) {
    const deployment = read(`templates/${tier}-deployment.yaml`);

    it(`the ${tier} ranges over the list rather than naming one Secret`, () => {
      expect(deployment).toContain(
        '{{- range fromJsonArray (include "simple-balance.secretRefs" .) }}',
      );
      expect(deployment).toContain("- secretRef:\n                name: {{ . }}");
      // The helper this replaced would render one name and silently drop the
      // other half of the credentials.
      expect(deployment).not.toContain('include "simple-balance.secretName"');
    });

    it(`the ${tier} mounts the database CA only when the chart runs the database`, () => {
      // pg-connection-string opens the path in DATABASE_URL's sslrootcert while
      // it parses the string, so a pod without this mount fails at startup
      // rather than connecting to something it cannot verify. Guarded, so a
      // release that brings its own database keeps the pod template it had and
      // gets no rollout it did not ask for.
      expect(deployment).toContain("{{- if .Values.database.enabled }}\n      volumes:");
      expect(deployment).toContain("- name: database-ca");
      expect(deployment).toContain(
        'secretName: {{ include "simple-balance.databaseSecretName" . }}',
      );
      // Projected by key: the same Secret holds the superuser, replication and
      // Patroni passwords, and only what is listed lands in the container.
      expect(deployment).toMatch(/items:\n\s*- key: ca\.crt/);
    });
  }
});

describe("the Secret the chart builds", () => {
  const secret = read("templates/secret.yaml");

  it("is named directly, not through the list", () => {
    // The list answers "what do the pods read", which may be this Secret, an
    // operator's, or both. This template creates an object, so its name cannot
    // be the operator's.
    expect(secret).toContain('name: {{ include "simple-balance.ownSecretName" . }}');
  });

  it("leaves AUTH_SECRET out rather than writing it blank", () => {
    // Blank, it would not be ignored — it would be the earlier source's value
    // for a key the later source also sets, and a key whose value is a promise
    // about another Secret is worse than no key.
    expect(secret).toContain("{{- with .Values.secret.authSecret }}\n  AUTH_SECRET:");
  });

  it("derives DATABASE_URL when the chart runs the database", () => {
    expect(secret).toContain("{{- if .Values.database.enabled }}");
    expect(secret).toContain('DATABASE_URL: {{ include "simple-balance.databaseUrl" . | quote }}');
  });
});
