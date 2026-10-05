import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Encryption in transit for the cluster the chart runs, which is four separate
 * connections and not one: the application to the coordinator, Citus to a
 * worker, a standby to its primary, and the Job that writes Citus's authinfo
 * row. Each is verified, and two of them are verified differently on purpose.
 *
 * The asymmetry is the part worth holding. A connection addressed by name can
 * be checked against the name in the certificate; a connection addressed by pod
 * IP cannot, because no certificate can promise an address that is handed out
 * when the pod starts. Reaching for `verify-full` everywhere would break a
 * cluster that is working perfectly, and reaching for `require` everywhere
 * would accept any certificate at all, including one minted a minute ago.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const helpers = read("templates/_helpers.tpl");
const config = read("templates/database-config.yaml");
const statefulset = read("templates/database-statefulset.yaml");
const secret = read("templates/database-secret.yaml");
const authinfo = read("templates/database-authinfo-job.yaml");

describe("what the server requires", () => {
  it("turns TLS on, which PostgreSQL does not do by itself", () => {
    // The base image ships no certificate and PostgreSQL defaults `ssl` off, so
    // this was not merely unset before: with ssl off, Citus's own default of
    // `sslmode=require` between nodes cannot connect at all.
    expect(config).toMatch(/^\s*ssl: "on"$/m);
    expect(config).toMatch(/^\s*ssl_cert_file: /m);
    expect(config).toMatch(/^\s*ssl_key_file: /m);
  });

  it("lives where a running cluster will read it, not in bootstrap.dcs", () => {
    // `bootstrap.dcs` is applied once and then owned by the cluster, so a
    // certificate named there would never reach a cluster that already exists —
    // which is every cluster after the first `helm upgrade`.
    const bootstrap = config.indexOf("bootstrap:");
    const ssl = config.indexOf('ssl: "on"');
    const postgresql = config.lastIndexOf("\n    postgresql:", ssl);
    expect(postgresql).toBeGreaterThan(bootstrap);
  });

  it("refuses a plaintext connection rather than serving it", () => {
    // This is the enforcement half. The application asking for verify-full is
    // the other half, and on its own it would protect only the clients that
    // already meant to be protected.
    const hba = config.slice(config.indexOf("pg_hba:"), config.indexOf("restapi:"));
    const rules = hba.split("\n").filter((line) => /^\s*- (host|local)/.test(line));
    expect(rules.length).toBeGreaterThan(4);
    for (const rule of rules) {
      const crossesPods = !/(127\.0\.0\.1\/32|::1\/128|- local )/.test(rule);
      if (crossesPods) {
        expect(rule.trim(), rule.trim()).toMatch(/^- hostssl /);
      }
    }
  });

  it("exempts loopback, and only loopback", () => {
    // Patroni's own connection to the PostgreSQL it supervises goes over TCP to
    // the listen address, and so does anything run with `kubectl exec`. Both
    // stay inside this pod's network namespace, where there is no wire.
    expect(config).toMatch(/^\s*- host all all 127\.0\.0\.1\/32 scram-sha-256$/m);
    expect(config).toMatch(/^\s*- host all all ::1\/128 scram-sha-256$/m);
    expect(config).not.toMatch(/^\s*- host all all 0\.0\.0\.0\/0/m);
    expect(config).not.toMatch(/^\s*- host replication /m);
  });
});

describe("what each client asks for", () => {
  it("the application verifies the coordinator by name", () => {
    const url = helpers.slice(helpers.indexOf('{{- define "simple-balance.databaseUrl"'));
    // `verify-full` rather than `require`: node-postgres reads both as "use TLS
    // and check the certificate", so `require` would read as a weaker guarantee
    // than the one actually in force.
    expect(url).toContain("sslmode=verify-full");
    expect(url).toContain("sslrootcert=");
  });

  it("the CA path in that string is one a volumeMount actually provides", () => {
    // pg-connection-string opens the file while it parses the string. A path
    // nothing mounts is a pod that fails at startup — which is the right
    // direction, but only if somebody notices before a release.
    const caPath = /{{- define "simple-balance.databaseCaPath" -}}(\S+?){{- end }}/.exec(helpers);
    expect(caPath, "databaseCaPath").not.toBeNull();
    const directory = path.dirname(caPath![1]);
    for (const tier of ["server", "scheduler"] as const) {
      const deployment = read(`templates/${tier}-deployment.yaml`);
      expect(deployment, tier).toContain(
        'mountPath: {{ dir (include "simple-balance.databaseCaPath" .) }}',
      );
      expect(deployment, tier).toContain(
        'path: {{ base (include "simple-balance.databaseCaPath" .) }}',
      );
    }
    expect(directory.startsWith("/")).toBe(true);
  });

  it("Citus and replication verify the CA rather than a name they cannot know", () => {
    // Patroni registers each member with the coordinator by pod IP, so a name
    // check would fail on a healthy cluster. What is checkable is that the peer
    // holds a certificate this cluster's own CA signed.
    expect(config).toMatch(/citus\.node_conninfo: "sslmode=verify-ca sslrootcert=/);
    const replication = config.slice(config.indexOf("      authentication:"));
    expect(replication).toMatch(/^\s*sslmode: verify-ca$/m);
    expect(replication).toMatch(/^\s*sslrootcert: /m);
  });

  it("the authinfo Job names its sslmode rather than leaving libpq to prefer", () => {
    // libpq's default would fall back to plaintext if TLS were ever turned off,
    // and write a superuser password onto the wire without saying so.
    expect(authinfo).toContain("- name: PGSSLMODE\n              value: verify-full");
    expect(authinfo).toContain("- name: PGSSLROOTCERT");
  });

  it("does not put an sslmode into pg_dist_authinfo", () => {
    // `citus.node_conninfo` already decides node-to-node TLS, and an sslmode
    // here would override it for this one role — with `verify-full`, against a
    // worker addressed by pod IP, which fails every distributed query. The row
    // carries the password and nothing else.
    const row = authinfo.slice(authinfo.indexOf("insert into pg_dist_authinfo"));
    expect(row).toContain("'password=' || :'app_password'");
    expect(row).not.toContain("sslmode");
  });
});

describe("the material itself", () => {
  it("is kept across upgrades rather than minted again", () => {
    // `genCA` and `genSignedCert` answer differently every call. Regenerated on
    // an upgrade, a healthy cluster would roll every database pod onto a new
    // identity and every API pod onto a new CA, and they would not match.
    const certificates = helpers.slice(
      helpers.indexOf('{{- define "simple-balance.databaseCertificates"'),
    );
    expect(certificates).toContain('lookup "v1" "Secret"');
    expect(certificates).toContain('hasKey .Values.database "resolvedTls"');
  });

  it("takes an operator's own three parts together or not at all", () => {
    // Half a certificate is a database that starts without TLS while the
    // application insists on it.
    expect(helpers).toContain("database.tls takes ca, cert and key together or not at all");
  });

  it("does not keep the CA's private key", () => {
    // Nothing reads it after the render signs with it, so storing it would be a
    // credential with no consumer sitting beside the superuser password.
    expect(secret).toContain("ca.crt:");
    expect(secret).toContain("tls.crt:");
    expect(secret).toContain("tls.key:");
    expect(secret).not.toContain("ca.key");
  });

  it("mounts the key at a mode PostgreSQL will actually start on", () => {
    // PostgreSQL refuses a private key it considers readable by anyone else.
    // Root-owned it wants 0640 or tighter; 0644 is the Kubernetes default and
    // fails, and 0400 fails too because the database user cannot read it.
    expect(statefulset).toContain("defaultMode: 0o640");
  });
});

describe("Patroni's control plane", () => {
  it("demands a credential for the methods that change something", () => {
    // Without this, any pod that can open a socket in the namespace can POST
    // /switchover, /failover, /restart or /reinitialize at a live primary.
    expect(statefulset).toContain("- name: PATRONI_RESTAPI_USERNAME");
    expect(statefulset).toContain("- name: PATRONI_RESTAPI_PASSWORD");
    expect(secret).toContain("restapi-password:");
  });

  it("keeps the password out of the ConfigMap that configures it", () => {
    // A ConfigMap is readable by anything that can read ConfigMaps.
    const restapi = config.slice(config.indexOf("restapi:"));
    expect(restapi).not.toMatch(/^\s*password:/m);
    expect(restapi).toContain("PATRONI_RESTAPI_PASSWORD");
  });
});

describe("synchronous replication", () => {
  it("is derived from the replica count rather than read straight off the setting", () => {
    // `synchronous_mode_strict` is off, so a group with no standby falls back to
    // asynchronous and says nothing. At one replica there is never a standby,
    // so the setting alone would claim a durability nothing gives.
    expect(helpers).toContain('{{- define "simple-balance.databaseSynchronous" -}}');
    expect(helpers).toContain(
      "and .Values.database.synchronousReplication (gt (int .Values.database.replicasPerGroup) 1)",
    );
    expect(config).toContain('{{- if include "simple-balance.databaseSynchronous" . }}');
    expect(config).not.toContain("{{- if .Values.database.synchronousReplication }}");
  });

  it("is refused outright at one replica, rather than quietly turned off", () => {
    // The operator asked for something and would otherwise be told nothing.
    expect(helpers).toContain(
      "and .Values.database.synchronousReplication (le (int .Values.database.replicasPerGroup) 1)",
    );
  });
});
