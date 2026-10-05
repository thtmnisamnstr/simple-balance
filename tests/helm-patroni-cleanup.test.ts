import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hook that removes Patroni's own Kubernetes objects when the release is
 * uninstalled, and the narrow authority it runs with.
 *
 * This is a hook that deletes database cluster state, so what is held here is
 * the blast radius rather than the feature. Patroni creates its endpoints at
 * runtime and Helm therefore never deletes them; left behind, the `-config`
 * endpoint's `initialize` annotation deadlocks the next install under the same
 * release name with no signal at all. Everything below is a way that fix could
 * turn into the thing it was meant to prevent.
 *
 * Read as text rather than rendered, like the other helm tests here: helm is
 * not on this job's PATH, it runs in a job of its own through a pinned image.
 * So what is held here is what the chart *says*, and the other half — that four
 * hook objects come out under `database.enabled`, that every one of them is
 * `post-delete`, and that the default render carries no hook at all — is beside
 * the `helm template` checks in `.github/workflows/verify.yml`, where there is
 * a helm to run. Neither half is sufficient alone: this file can be satisfied
 * by a template that renders nothing, and that one by a template whose program
 * deletes in the wrong order.
 */

const root = path.resolve(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/simple-balance");
const read = (file: string) => readFileSync(path.join(chart, file), "utf8");

const template = read("templates/database-patroni-cleanup.yaml");
const values = read("values.yaml");
const schema = JSON.parse(read("values.schema.json")) as {
  properties: { database: { properties: Record<string, unknown> } };
};

/**
 * One `---`-separated document. Split on text rather than parsed: the file is
 * Go templating, not YAML, until helm has run.
 */
const documents = template.split(/\n---\n/);

/** Every `"helm.sh/hook": <event>` the file actually sets, comments excluded. */
const events = [...template.matchAll(/^\s*"helm\.sh\/hook":\s*(\S+)\s*$/gm)].map((m) => m[1]);

describe("when the hook runs", () => {
  it("runs on uninstall alone, and never on install, upgrade or rollback", () => {
    // The requirement that makes this safe to ship at all. Helm fires
    // `post-delete` from `Uninstall.Run` and from nowhere else — install.go,
    // upgrade.go and rollback.go contain no reference to it, and
    // `uninstall --dry-run` returns before any hook. A second event here would
    // point this Job at a cluster that is still serving and delete the state
    // out from under it.
    //
    // Asserted on the annotation rather than the file, because the template's
    // comment discusses `pre-delete` at length in order to explain why it is
    // wrong, and a test that searched the whole text would be reading prose.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).toBe("post-delete");
    }
  });

  it("is post-delete rather than pre-delete, which is what makes a failure survivable", () => {
    // Not a preference. Helm's pre-delete runs before anything is deleted
    // (`uninstall.go:203` precedes `deleteRelease` at `:216`), so every Patroni
    // pod is still alive and the leader rewrites `initialize` and the config
    // object inside one 10s `loop_wait` — a pre-delete hook deletes four
    // objects and is handed them straight back. And `:203` *returns* the
    // hook's error, refusing the whole uninstall, where post-delete at `:230`
    // appends it and lets the uninstall finish.
    //
    // So this is also the answer to "a failing hook must not strand the
    // release undeletable": with post-delete it cannot, by construction.
    expect(events).not.toContain("pre-delete");
    expect(template).toMatch(/post-delete, and never pre-delete/);
  });

  it("renders nothing unless the database and the flag are both on", () => {
    // The upgrade rule. `database.enabled` is false in the chart's own values,
    // so an operator who sets nothing gets exactly what the release before
    // this one built — no hook, no Role, no ServiceAccount.
    expect(template.split("\n")[0]).toBe(
      "{{- if and .Values.database.enabled .Values.database.patroniCleanup.enabled }}",
    );
  });
});

describe("what it is allowed to delete", () => {
  it("finds its objects by this release's own labels, never by a prefix", () => {
    // Patroni stamps its label set on every object it creates, and the chart
    // is the only reason it can be matched: `kubernetes.labels` in
    // database-config.yaml is copied verbatim, and Patroni adds `cluster-name`
    // (its scope) itself. Two releases in one namespace differ in
    // `app.kubernetes.io/instance` and again inside `cluster-name`, which
    // contains the release name.
    //
    // A name prefix would be the obvious alternative and is forbidden:
    // `<scope>-0*` also matches a release called `<scope>-0-archive`.
    const selector = /- name: SB_SELECTOR\n\s+value: \{\{ printf "([^"]+)"/.exec(template);
    expect(selector, "SB_SELECTOR").not.toBeNull();
    const pattern = selector![1];
    expect(pattern).toContain("app.kubernetes.io/instance=%s");
    expect(pattern).toContain("app.kubernetes.io/component=database");
    expect(pattern).toContain("cluster-name=%s");
    expect(pattern).not.toContain("*");
  });

  it("checks the labels again itself before deleting anything", () => {
    // Defence in depth against this file's own future. The API server already
    // applied the selector, so this check is redundant today — and that is the
    // point: an edit that loosened the selector would have to loosen this too,
    // rather than silently widening what a delete can reach.
    expect(template).toMatch(/labels\.get\("cluster-name"\) != SCOPE/);
    expect(template).toMatch(/labels\.get\("app\.kubernetes\.io\/instance"\) != INSTANCE/);
  });

  it("leaves anything Helm owns alone rather than finishing Helm's job", () => {
    // Nine chart-owned Services match the selector too, every one of them
    // labelled `managed-by: Helm`, and Patroni labels nothing that way. By the
    // time this hook runs Helm has deleted them; one still present means the
    // uninstall did not finish, and quietly tidying it away here would hide a
    // broken uninstall instead of reporting it.
    expect(template).toMatch(/labels\.get\("app\.kubernetes\.io\/managed-by"\) == "Helm"/);
  });

  it("treats an object that is already gone as success", () => {
    // Harmless when there is nothing to do, which is the ordinary case for
    // `-sync` and `-failover` and the whole case for a cluster that never
    // started. A 404 is the state this Job exists to produce.
    expect(template).toMatch(/if error\.code == 404:/);
    expect(template).toMatch(/return "already gone"/);
  });

  it("waits for the database pods before deleting, and refuses rather than racing", () => {
    // Nothing else waits. Helm's default uninstall wait strategy is `hookOnly`
    // and its WaitForDelete is a literal `return nil`, while the pods hold a
    // 60s termination grace period. Deleting while a leader is alive would be
    // undone within one `loop_wait`, so a timeout here has to fail rather than
    // proceed — the one case where doing nothing is the correct outcome.
    expect(template).toMatch(/SB_POD_SELECTOR/);
    expect(template).toMatch(/Database pods were still running after %ds/);
    expect(template).toMatch(/Nothing was deleted\./);
  });

  /**
   * The same property as the test above, asserted as ordering rather than as
   * vocabulary.
   *
   * Every string that test looks for survives the edit that breaks the
   * property: move the wait below the delete loop, or soften the timeout to a
   * `break` so the hook "at least tries", and the words are all still there.
   * What the safety argument rests on is that no DELETE is issued until the
   * pod list has come back empty, so that is pinned by position in the
   * rendered program instead.
   */
  const script = template.slice(
    template.indexOf("              import json"),
    template.lastIndexOf("{{- end }}"),
  );
  const at = (needle: string) => {
    const index = script.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it("issues no delete until the wait loop has exited", () => {
    const listPods = at('listing("pods", POD_SELECTOR');
    const deadline = at("if waited >= DEADLINE:");
    const deleteLoop = at('for kind in ("endpoints", "services"):');
    expect(deadline, "the deadline is checked against the listing above it").toBeGreaterThan(
      listPods,
    );
    expect(deleteLoop, "and the whole wait sits above the delete loop").toBeGreaterThan(deadline);
    // `remove` is defined above the wait and must be *called* only below it.
    // One call site, and it is inside the loop the line above places last.
    const calls = [...script.matchAll(/(?<!def )\bremove\(/g)].map((match) => match.index!);
    expect(calls, "one call of remove()").toHaveLength(1);
    expect(calls[0]!).toBeGreaterThan(deleteLoop);
  });

  it("gives up rather than proceeding when the pods outlast the deadline", () => {
    // A `break` here is the tempting edit and the dangerous one: the Job would
    // delete the leader endpoint out from under a live Patroni, forcing an
    // election on a cluster being uninstalled, and `initialize` would be
    // rewritten within one `loop_wait` — the deadlock this file exists to
    // prevent, reported as success.
    const branch = script.slice(at("if waited >= DEADLINE:"), at('for kind in ("endpoints"'));
    expect(branch).toContain("sys.exit(1)");
    expect(branch, "not a break").not.toMatch(/^\s*break\s*$/m);
    expect(branch, "not a pass").not.toMatch(/^\s*pass\s*$/m);
    expect(branch, "not a bare continue").not.toMatch(/^\s*continue\s*$/m);
  });

  it("cannot wait on the authinfo Job's pod, which is not a database pod", () => {
    // `database-authinfo-job.yaml` labels its pod template with exactly the
    // three `componentLabels` for `database` and no `cluster-name`. A wait
    // selector of those three therefore matches a workload that is not a
    // Patroni member and that Helm's uninstall does not wait for either. One
    // that is wedged — Evicted, or Terminating on a node that has gone away —
    // holds this Job to its deadline, which then reports "database pods were
    // still running" about a pod that never was one and exits 1 having deleted
    // nothing. The endpoints outlive the uninstall: the deadlock this file
    // exists to prevent, reached through the file that prevents it.
    //
    // Two independent narrowings, because either alone closes that and they
    // answer different questions: `cluster-name` is "is this a member of this
    // cluster", the phase filter is "is anything of it still running".
    const authinfo = read("templates/database-authinfo-job.yaml");
    expect(authinfo, "the Job this must not match").toContain(
      '(dict "root" . "component" "database")',
    );
    expect(authinfo, "and it carries no cluster-name to be told apart by").not.toContain(
      "cluster-name:",
    );
    const podSelector = /- name: SB_POD_SELECTOR\n\s+value: \{\{ printf "([^"]+)"/.exec(template);
    expect(podSelector, "SB_POD_SELECTOR").not.toBeNull();
    expect(podSelector![1]).toContain("cluster-name=%s");
    // The StatefulSet is where that label comes from, so no member is lost.
    expect(read("templates/database-statefulset.yaml")).toContain("cluster-name: {{ include");
    expect(script).toContain('LIVE_PHASES = "status.phase!=Succeeded,status.phase!=Failed"');
    expect(script).toContain('listing("pods", POD_SELECTOR, LIVE_PHASES)');
    // The delete side takes no field selector, because an Endpoints object has
    // no phase and asking for one would match nothing at all.
    expect(script).toMatch(/listing\(kind, SELECTOR\)/);
  });
});

describe("the authority it is given", () => {
  const role = documents.find((doc) => doc.includes("kind: Role\n"));

  it("is namespaced, never cluster-scoped", () => {
    // A ClusterRole would let this reach every namespace on the cluster, and
    // nothing it does needs to leave the release's own.
    expect(template).not.toMatch(/kind: ClusterRole/);
    expect(template).not.toMatch(/kind: ClusterRoleBinding/);
    expect(role, "Role document").toBeDefined();
  });

  it("grants three resources and no verb wider than they need", () => {
    const rules = role!.slice(role!.indexOf("rules:"));
    expect(rules).toMatch(/resources: \["endpoints"\]\n\s+verbs: \["list", "delete"\]/);
    expect(rules).toMatch(/resources: \["services"\]\n\s+verbs: \["list", "delete"\]/);
    // Pods are read only, and only to answer "are they gone yet".
    expect(rules).toMatch(/resources: \["pods"\]\n\s+verbs: \["list"\]/);
    // No `get`: it never reads one object by name. No `deletecollection`: that
    // is the verb that could take out a neighbour in a bad moment. No
    // wildcard, and no write verb of any kind.
    for (const forbidden of ["deletecollection", '"*"', '"create"', '"patch"', '"update"']) {
      expect(rules, forbidden).not.toContain(forbidden);
    }
  });

  it("carries its own credentials as hook resources, not release resources", () => {
    // `deleteRelease` runs before the post-delete hook, so a templated
    // ServiceAccount, Role and RoleBinding would already be gone when the Job
    // needed them. As hooks they exist for the seconds the Job runs and are
    // then removed — tighter than "deleted with the release", not looser.
    for (const kind of ["ServiceAccount", "Role", "RoleBinding", "Job"]) {
      const doc = documents.find((d) => d.includes(`kind: ${kind}\n`));
      expect(doc, kind).toBeDefined();
      expect(doc, kind).toMatch(/"helm\.sh\/hook": post-delete/);
    }
  });

  it("deletes its own objects whether it succeeded or failed", () => {
    // A hook resource is not in the release manifest, so with no policy Helm
    // keeps it — and once the history is purged there is no release left to
    // delete it. Without `hook-failed` as well as `hook-succeeded`, a failed
    // run orphans a Role and a RoleBinding in a namespace with nothing to
    // clean them up.
    const policies = [...template.matchAll(/"helm\.sh\/hook-delete-policy":\s*(\S+)/g)].map(
      (m) => m[1],
    );
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(policy).toContain("hook-succeeded");
      expect(policy).toContain("hook-failed");
      expect(policy).toContain("before-hook-creation");
    }
  });

  it("runs its credentials before the Job and lets them outlive it", () => {
    // Helm applies hooks in weight order and deletes the successful ones only
    // after the whole phase has run, walking them backwards — so -5 before 0
    // means created first and removed last.
    // Per document rather than one sweep of the file: a `roleRef` names a
    // `kind: Role` of its own, and a regex spanning documents reads that as
    // the RoleBinding's weight belonging to a second Role.
    const weights = documents.map((doc) => [
      /^kind: (\w+)$/m.exec(doc)![1],
      /"helm\.sh\/hook-weight": "(-?\d+)"/.exec(doc)![1],
    ]);
    expect(weights).toEqual([
      ["ServiceAccount", "-5"],
      ["Role", "-5"],
      ["RoleBinding", "-5"],
      ["Job", "0"],
    ]);
  });
});

describe("failing legibly", () => {
  it("prints the container's logs when the hook fails", () => {
    // The delete policy above removes the Job, and would take the only account
    // of why it failed with it. Helm fetches the logs before running the
    // deletion, so both happen in the right order.
    expect(template).toMatch(/"helm\.sh\/hook-output-log-policy": hook-failed/);
  });

  it("nests its three deadlines inside Helm's, smallest first", () => {
    // Each catches only what the one inside it cannot: the script explains a
    // cluster that would not terminate, the Job catches a container that never
    // started at all, and Helm's 300s hook watch is left as the outermost
    // backstop rather than the usual outcome. Out of order, the legible
    // failure never gets to happen.
    const script = Number(/- name: SB_POD_DEADLINE\n\s+value: "(\d+)"/.exec(template)![1]);
    const job = Number(/activeDeadlineSeconds: (\d+)/.exec(template)![1]);
    expect(script).toBeLessThan(job);
    expect(job).toBeLessThan(300);
  });

  it("does not label its pod as a database pod", () => {
    // Two traps in one line. A pod labelled `component: database` matches this
    // Job's own pod-wait selector, so it would wait for itself until the
    // deadline and then fail; and it would be selected by the database
    // NetworkPolicy, whose egress under `restrictEgress` is DNS and the
    // database pods — no route to the API server at all.
    expect(template).toMatch(/"component" "database-cleanup"/);
    expect(template).not.toMatch(/"component" "database"\)/);
  });
});

describe("the switch an operator gets", () => {
  it("is on by default, so the defect is fixed for anyone who reads nothing", () => {
    expect(values).toMatch(/^ {2}patroniCleanup:\n {4}enabled: true$/m);
  });

  it("is declared in the schema, which would otherwise refuse to render", () => {
    // `database` is `additionalProperties: false`, so an undeclared key is not
    // a default that quietly does nothing — it is a chart that will not
    // install.
    const database = schema.properties.database;
    expect(database.properties).toHaveProperty("patroniCleanup");
    expect(database.properties.patroniCleanup).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" } },
    });
  });

  it("says what turning it off costs, in both directions", () => {
    // The switch exists because the hook changes a flow the runbook calls a
    // normal restart: a reinstall over intact claims rebuilds the dynamic
    // configuration from `bootstrap.dcs`, reverting `patronictl edit-config`.
    // An operator choosing between two failures has to be able to see both,
    // and `--no-hooks` is not the alternative — it disables every hook this
    // chart has or ever grows.
    const block = values.slice(values.indexOf("patroniCleanup:") - 1800);
    expect(block).toContain("patronictl edit-config");
    expect(block).toContain("--no-hooks");
  });
});
