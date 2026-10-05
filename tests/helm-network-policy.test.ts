import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fourth NetworkPolicy — the database's — and the two derived egress rules
 * that let the tiers in front of it still reach it.
 *
 * Two ports reach a database pod and they are not the same kind of thing. 5432
 * is the ledger; the Patroni port is the cluster's control plane, where
 * /switchover, /failover, /restart and /reinitialize live. Before this policy
 * existed the first was open to every pod in the namespace and the second to
 * every pod in the cluster.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const template = read("templates/networkpolicy.yaml");

/**
 * One `---`-separated document of the template. Split on text rather than
 * parsed: the file is Go templating, not YAML, until helm has run.
 */
const documents = template.split(/\n---\n/);

/** The document whose metadata names a component. */
function policyFor(component: string): string {
  const found = documents.filter((doc) =>
    doc.includes(`"simple-balance.componentName" (dict "root" . "component" "${component}")`),
  );
  expect(found, component).toHaveLength(1);
  return found[0];
}

describe("the database's own policy", () => {
  const database = policyFor("database");

  /**
   * The two `- from:` rules of its ingress, kept apart because the whole point
   * of the policy is that they admit different peers: everything that may open
   * the ledger, and the much shorter list that may reach the control plane.
   * Read together they would pass while saying the opposite.
   */
  const ingressRules = database
    .slice(database.indexOf("\n  ingress:"), database.indexOf("\n  egress:"))
    .split(/\n {4}- from:/)
    .slice(1);

  it("exists only when there is a database in the cluster to guard", () => {
    // Rendering it without one would be an object selecting no pods, which
    // reads in `kubectl get networkpolicy` as a guard that is working. The
    // condition sits before the document separator rather than inside the
    // document, because a `---` emitted on its own is a parse error.
    expect(template).toContain("{{- if .Values.database.enabled }}\n---\n");
  });

  it("closes both directions rather than only the one being argued about", () => {
    expect(database).toMatch(/policyTypes:\n\s*- Ingress\n\s*- Egress/);
  });

  it("opens the ledger port to the API, the scheduler and the other database pods", () => {
    const ledger = ingressRules[0];
    for (const component of ["server", "scheduler", "database"]) {
      expect(ledger, component).toContain(
        `"simple-balance.componentSelectorLabels" (dict "root" . "component" "${component}")`,
      );
    }
    // A standby streaming from its primary and a coordinator running a
    // distributed query both arrive on 5432 from another database pod, which is
    // why the component selects itself.
    expect(ledger).toMatch(/port: 5432/);
    // The frontend is nginx and never holds a connection; naming it here would
    // be a door opened for nothing.
    expect(ledger).not.toContain('"component" "frontend"');
  });

  it("opens Patroni's port to the database itself and to the probes, and nothing else", () => {
    const control = ingressRules[1];
    // The kubelet's startup, liveness and readiness probes are HTTP requests to
    // this port, and they arrive from a node address rather than from a pod, so
    // a pod selector alone would fail every probe the moment the policy exists.
    expect(control).toContain("{{- with $probes }}");
    expect(control).not.toContain('"component" "server"');
    expect(control).not.toContain('"component" "scheduler"');
  });

  it("selects peers by label and never by address", () => {
    // A pod's address is whatever the CNI handed it this morning. The only
    // ipBlock entries in this policy are the probe CIDRs, which are the
    // operator's to name because a node's address is not a pod's.
    const addresses = database.match(/ipBlock/g) ?? [];
    expect(addresses).toHaveLength(0);
  });

  it("leaves egress open by default, because Patroni's state is in the API server", () => {
    // Patroni keeps its cluster state in the Kubernetes API rather than in a
    // separate etcd, so every member must reach the API server — an address
    // this chart cannot know, since it depends on the cluster's service CIDR.
    // A restricted cluster that loses that rule stops failing over.
    expect(database).toContain("{{- else }}");
    expect(database).toMatch(/- \{\}\n\s*\{\{- end \}\}/);
  });
});

describe("the tiers in front of it", () => {
  for (const tier of ["server", "scheduler"] as const) {
    it(`the ${tier}'s egress to the database is derived, not left to egressRules`, () => {
      const policy = policyFor(tier);
      const egress = policy.slice(policy.indexOf("egress:"));
      expect(egress).toContain("{{- if .Values.database.enabled }}");
      expect(egress).toContain(
        '"simple-balance.componentSelectorLabels" (dict "root" . "component" "database")',
      );
      // An operator writing this rule by hand would be writing down a pod
      // selector this render already holds, and getting it wrong means a
      // restricted deployment that installs cleanly and cannot reach its own
      // ledger.
      expect(egress).toMatch(/port: 5432/);
    });
  }

  it("the frontend gets no rule to the database, because it never opens one", () => {
    const frontend = policyFor("frontend");
    expect(frontend).not.toContain('"component" "database"');
  });
});
