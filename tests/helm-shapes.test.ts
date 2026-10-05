import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `ha` profile's two shapes, and the default that must stay put underneath
 * them.
 *
 * Read as text rather than rendered. `helm` is not on this job's PATH — the
 * workflow runs it in a job of its own, through a pinned image — so what can be
 * held here is what the chart *says*, and what is held there is what it
 * produces. The two are complementary and neither replaces the other: a render
 * cannot tell you that a default was never supposed to move, and reading cannot
 * tell you that three StatefulSets come out.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const values = read("values.yaml");
const nodePerService = read("values-node-per-service.yaml");
const ha = read("values-ha.yaml");

/** A top-level `key:` block of a values file, up to the next unindented line. */
function block(file: string, key: string): string {
  const start = file.indexOf(`\n${key}:\n`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const end = rest.search(/\n[a-zA-Z]/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the database the chart can run", () => {
  it("is off in the chart's own values, and that is the whole upgrade story", () => {
    // A values file written for 0.1.6 necessarily sets secret.databaseUrl and
    // has no `database` key at all. If this default flipped, `helm upgrade -f
    // their-values.yaml` would meet the guard that refuses those two together
    // and stop with a template error — a configuration that was accepted no
    // longer being accepted, on an upgrade nobody asked to change anything in.
    // Both shapes opt in with `-f`, so no cluster can appear underneath anyone.
    expect(values).toMatch(/^database:\n {2}enabled: false\n/m);
  });

  it("is asked for by both shapes and by neither default", () => {
    for (const [name, file] of [
      ["values-node-per-service.yaml", nodePerService],
      ["values-ha.yaml", ha],
    ] as const) {
      expect(block(file, "database"), name).toMatch(/^\s*enabled: true$/m);
      // Turning on the policies is half of putting a database in the cluster.
      // Without them any pod in the namespace can open 5432 on the coordinator.
      expect(block(file, "networkPolicy"), name).toMatch(/^\s*enabled: true$/m);
    }
  });
});

describe("the one-node-per-service shape", () => {
  const database = block(nodePerService, "database");

  it("runs one of everything, coordinator and worker included", () => {
    // One worker rather than none. A coordinator alone also runs — Citus
    // tolerates it — but then the ledger is not really distributed and the
    // first day a worker is added is the first day a shard has ever moved.
    expect(database).toMatch(/^\s*workers: 1$/m);
    expect(database).toMatch(/^\s*replicasPerGroup: 1$/m);
  });

  it("does not claim a durability a group of one cannot give", () => {
    // The chart refuses these two together, so a file that asked for both would
    // fail to render rather than mislead. Pinned here as well because the
    // refusal is what makes this line load-bearing: drop it and the file stops
    // installing, which is a failure nobody would read as being about honesty.
    expect(database).toMatch(/^\s*synchronousReplication: false$/m);
  });

  it("asks for no disruption budget anywhere", () => {
    // `maxUnavailable: 1` over a workload of one is a budget already at its
    // limit, so `kubectl drain` waits on it forever and the node never empties.
    for (const key of ["database", "server", "frontend"]) {
      expect(block(nodePerService, key), key).toMatch(/podDisruptionBudget:\n\s*enabled: false/);
    }
  });

  it("asks for no autoscaling, on any tier", () => {
    // An HPA whose minReplicas and maxReplicas are both 1 is an object that
    // exists to do nothing, and the metrics-server it reads is one more thing
    // that has to be installed for it.
    for (const key of ["server", "frontend", "scheduler"]) {
      expect(block(nodePerService, key), key).toMatch(/autoscaling:\n\s*enabled: false/);
    }
  });
});

describe("the highly-available shape", () => {
  const database = block(ha, "database");

  it("spreads the ledger over three groups, each with a standby", () => {
    expect(database).toMatch(/^\s*workers: 2$/m);
    expect(database).toMatch(/^\s*replicasPerGroup: 2$/m);
    expect(database).toMatch(/^\s*synchronousReplication: true$/m);
  });

  it("writes down the numbers it shares with the chart's defaults", () => {
    // A file saying only `database.enabled: true` would be a file whose meaning
    // changed every time a default moved, and the two shapes are meant to be
    // read side by side. So the values are repeated on purpose, and this is
    // what keeps the repetition true: the chart's defaults are this shape.
    const defaults = block(values, "database");
    for (const line of ["workers: 2", "replicasPerGroup: 2", "synchronousReplication: true"]) {
      expect(defaults, line).toMatch(new RegExp(`^\\s*${line}$`, "m"));
    }
  });

  it("autoscales every tier", () => {
    for (const key of ["server", "frontend", "scheduler"]) {
      expect(block(ha, key), key).toMatch(/autoscaling:\n\s*enabled: true/);
    }
  });
});

describe("the two shapes as one profile", () => {
  it("differ only in numbers, never in what is installed", () => {
    // The whole claim of decision 4: growing from one shape to the other is a
    // rollout rather than a migration. It holds only while neither file turns a
    // component on or off that the other does not — the moment one of them
    // names a different image, database name or storage class, the move
    // between them stops being a values change.
    const structural = /^\s*(image|databaseName|persistence|repository|tag|digest):/m;
    expect(nodePerService).not.toMatch(structural);
    expect(ha).not.toMatch(structural);
  });
});
