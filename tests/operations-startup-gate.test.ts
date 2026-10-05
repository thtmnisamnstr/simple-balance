import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gate in front of every process that runs migrations, and what it proves.
 *
 * `docs/standards/operations.md` §A startup gate proves the database's shape,
 * not that it answers carries the argument; this file holds the five properties
 * it rests on. None of them is visible from a rendered manifest alone, because
 * what matters is which *credential* the query is made with and what the
 * condition counts — both of which read as ordinary YAML once helm has run.
 *
 * Read as text rather than rendered: `helm` is not on this job's PATH, the same
 * decision `tests/helm-shapes.test.ts` documents.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const helpers = read("templates/_helpers.tpl");

/** The `{{- define "simple-balance.waitForDatabase" -}}` block, body only. */
const gate = (() => {
  const start = helpers.indexOf(`{{- define "simple-balance.waitForDatabase"`);
  expect(start, "simple-balance.waitForDatabase is defined").toBeGreaterThan(-1);
  const rest = helpers.slice(start);
  const end = rest.indexOf(`\n{{- define "`, 1);
  return end === -1 ? rest : rest.slice(0, end);
})();

/**
 * The same block with its `#` comment lines dropped.
 *
 * Needed for one assertion only, and the reason is worth knowing before
 * somebody simplifies it away: the comment explaining why this container must
 * *not* ask for `superuser-password` names that key, so a check reading the
 * block whole would fail on the sentence arguing for the thing it is checking.
 */
const manifest = gate
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** The workloads that run migrations, which is both of them. */
const workloads = ["templates/server-deployment.yaml", "templates/scheduler-deployment.yaml"];

describe("the gate in front of a database with a topology", () => {
  it.each(workloads)("stands in front of %s", (file) => {
    // Both, not only the API. The scheduler runs `runMigrations()` too, so a
    // gate on one of them leaves the other able to be the process that meets a
    // coordinator with no workers.
    expect(read(file)).toContain(`include "simple-balance.waitForDatabase"`);
  });

  it("renders the container its own pod's security context, not one component's", () => {
    // Hard-coded as the server's, the scheduler's init container silently took
    // the server's seccomp profile and runAsUser: either a rejected pod, or a
    // container an operator believed was constrained by the block they set.
    expect(gate).toContain("$.component.containerSecurityContext");
    expect(gate).not.toContain(".Values.server.containerSecurityContext");
  });

  it("runs only where this chart runs the database", () => {
    // A deployment bringing its own `databaseUrl` gets no init container. One
    // that waited on somebody else's database would turn a wrong hostname into
    // a hang instead of an error.
    expect(gate).toContain("if .Values.database.enabled");
  });
});

describe("what the gate asks, and who it asks as", () => {
  it("asks with the application's connection string and names no superuser secret", () => {
    // The pod projects exactly one key out of the database Secret — `ca.crt` —
    // and the comment on that projection says naming the one item is what keeps
    // the superuser, replication and Patroni passwords out of a container with
    // no use for them. An init container asking for `superuser-password` would
    // undo that two files along, for a query any role can make.
    expect(manifest).toContain(`include "simple-balance.ownSecretName"`);
    expect(manifest).toContain("key: DATABASE_URL");
    for (const forbidden of ["superuser-password", "replication-password", "patroni-password"]) {
      expect(manifest, forbidden).not.toContain(forbidden);
    }
  });

  it("mounts the CA the connection string names, because libpq reads it while parsing", () => {
    // Without the mount the wait fails to connect for a reason that has nothing
    // to do with whether the cluster is ready, which is the worst shape a gate
    // can fail in: it reports the precondition as unmet when it was never
    // asked.
    expect(gate).toContain("name: database-ca");
    expect(gate).toContain(`include "simple-balance.databaseCaPath"`);
  });

  it("counts registered worker groups rather than probing a port", () => {
    // The whole rule. Patroni opens 5432 seconds before it registers the worker
    // groups, so a TCP check passes and `0023` then runs into a coordinator
    // with no workers: `replication_factor (1) exceeds number of worker nodes
    // (0)`. `pg_dist_node` is the actual precondition and nothing weaker is
    // worth checking.
    expect(gate).toContain("pg_dist_node");
    expect(gate).toContain("groupid <> 0");
    expect(gate).toContain("isactive");
    expect(gate).toContain("SB_EXPECTED_WORKERS");
    expect(gate).toContain(".Values.database.workers");
    // A readiness or startup probe cannot stand in for this: migrations are
    // awaited before the server listens, so by the time anything can probe the
    // process the failure has already happened.
    expect(gate).toContain("initContainers:");
  });
});

describe("what the gate does when the cluster is never coming", () => {
  it("is bounded rather than waiting forever", () => {
    // Ten minutes at five-second intervals. A pod that waits forever is a
    // cluster nobody is told about.
    expect(gate).toMatch(/\[ "\$i" -ge \d+ \]/);
    expect(gate).toContain("sleep 5");
    expect(gate).toContain("exit 1");
  });

  it("names how many groups did register, so slow and wrong read differently", () => {
    // The count is the whole difference between "this cluster is still coming
    // up" and "this cluster has two groups and wants three".
    expect(gate).toContain("pg_dist_node where groupid <> 0' 2>/dev/null || echo 0)");
    expect(gate).toMatch(/of \$SB_EXPECTED_WORKERS worker groups registered/);
    // To stderr, so it is a failure line rather than part of the wait's own
    // chatter.
    expect(gate).toMatch(/worker groups registered within \d+ minutes\." >&2/);
  });
});
