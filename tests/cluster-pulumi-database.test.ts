import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two cluster programs and the module they share, read as text.
 *
 * They cannot be imported: that needs `@pulumi/pulumi` from
 * `deploy/pulumi/node_modules`, which the job running this suite does not
 * install. `tests/aws-single.test.ts` makes the same argument and reads its
 * program the same way.
 *
 * What is held here is the half a render cannot see — that a stack written for
 * the release before this one plans exactly what it planned then, and that the
 * properties the whole encryption story rests on are actually written down.
 * Two lines with no test are one edit from disappearing.
 */

const root = path.resolve(import.meta.dirname, "..");
const readProgram = (file: string) => readFileSync(path.join(root, "deploy/pulumi", file), "utf8");

const common = readProgram("common/index.ts");
const aws = readProgram("aws/index.ts");
const gcp = readProgram("gcp/index.ts");

/** A program with its comment lines taken out, for what it does rather than says. */
const withoutComments = (program: string) =>
  program
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
    .join("\n");

describe("simple-balance:database", () => {
  it("is a closed set, and refuses anything outside it by name", () => {
    expect(common).toContain('export type DatabaseLocation = "external" | "in-cluster";');
    expect(common).toContain("simple-balance:database is one of");
  });

  it("defaults to the bring-your-own database every release so far has had", () => {
    // This is the whole upgrade story for these two programs: an existing stack
    // sets nothing, reads `external`, and plans no change at all.
    expect(common).toContain('cfg.get("database") ?? "external"');
  });

  it("still requires databaseUrl when the operator brings the database", () => {
    // Relaxing this unconditionally would be wrong: with neither a stack secret
    // nor a database in the cluster, the only thing left to refuse is the
    // chart, and it refuses three minutes into a rollout rather than at preview.
    expect(withoutComments(common)).toContain(
      'databaseUrl: database === "external" ? cfg.requireSecret("databaseUrl") : undefined,',
    );
  });

  it("refuses a databaseUrl alongside an in-cluster database, at plan time", () => {
    const code = withoutComments(common);
    const guard = code.indexOf('database === "in-cluster" && cfg.getSecret("databaseUrl")');
    expect(guard).toBeGreaterThan(-1);
    // Before any resource is registered. `pulumi up --skip-preview` creates
    // whatever was registered before a program throws.
    expect(guard).toBeLessThan(code.indexOf("new k8s."));
  });

  it("reads the presence of that secret without printing it", () => {
    // `cfg.get` on a secret value warns into the `pulumi up` output, which is
    // the one place a connection string must not appear.
    expect(common).not.toContain('cfg.get("databaseUrl")');
  });
});

describe("the connection budget", () => {
  it("measures against the number the chart sets, once the chart owns the database", () => {
    // Left at the 100 that stands for a stock PostgreSQL, the budget would
    // refuse replica ceilings this cluster serves perfectly well — wrong in the
    // direction that looks like caution and costs capacity.
    expect(withoutComments(common)).toContain(
      '(database === "in-cluster" ? inClusterMaxConnections : 100)',
    );
  });

  it("uses the same number the chart's Patroni configuration does", () => {
    // A Pulumi program cannot render Helm, so the number is written twice. The
    // direction that matters is this one being the larger: that would let a
    // stack plan a peak the database then refuses at runtime.
    const declared = /export const inClusterMaxConnections = (\d+);/.exec(common);
    expect(declared, "inClusterMaxConnections").not.toBeNull();
    const chartConfig = readFileSync(
      path.join(root, "deploy/helm/simple-balance/templates/database-config.yaml"),
      "utf8",
    );
    const configured = /^\s*max_connections: (\d+)$/m.exec(chartConfig);
    expect(configured, "max_connections").not.toBeNull();
    expect(Number(declared![1])).toBe(Number(configured![1]));
  });
});

describe("what the chart is told", () => {
  const code = withoutComments(common);

  it("keeps DATABASE_URL out of the program's Secret when the chart derives one", () => {
    // That Secret is the *later* envFrom source, so a key in it beats the
    // derived one. Written blank it would not be ignored — it would win.
    expect(code).toContain("if (settings.databaseUrl) {\n    credentialData.DATABASE_URL");
  });

  it("names both Secrets only for an in-cluster database", () => {
    expect(code).toContain(
      "secret: { create: inCluster, existingSecret: credentials.metadata.name },",
    );
  });

  it("turns the policies on with the database and not before", () => {
    const block = code.slice(code.indexOf("...(inCluster"), code.indexOf("server: {"));
    expect(block).toContain("database: {");
    expect(block).toContain("networkPolicy: { enabled: true },");
  });

  it("names a storage class rather than taking the cluster's default", () => {
    // Neither cloud's default StorageClass says `encrypted`, and it is the one
    // place at-rest encryption for the ledger is actually decided.
    expect(code).toContain("persistence: { storageClass: args.databaseStorageClass }");
    expect(withoutComments(aws)).toContain(
      "databaseStorageClass: databaseStorageClass.metadata.name,",
    );
    expect(withoutComments(gcp)).toContain(
      "databaseStorageClass: databaseStorageClass.metadata.name,",
    );
  });
});

describe("encryption at rest, written down rather than assumed", () => {
  it("AWS cuts the ledger's volumes encrypted, which is not an account default", () => {
    // EBS encryption-by-default is an account-level setting that is off on a
    // fresh account, so this property is the whole guarantee.
    const code = withoutComments(aws);
    expect(code).toContain('parameters: { type: "gp3", encrypted: "true" }');
    expect(code).toContain('provisioner: "ebs.csi.aws.com"');
  });

  it("AWS installs the driver those volumes need at all", () => {
    // Without it a PersistentVolumeClaim on EKS 1.23 or later sits Pending: the
    // in-tree EBS provisioner was removed from Kubernetes.
    const code = withoutComments(aws);
    expect(code).toContain('addonName: "aws-ebs-csi-driver"');
    expect(code).toContain("serviceAccountRoleArn: ebsCsiRole.arn");
    expect(code).toContain('"arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"');
  });

  it("both clouds encrypt the Secrets in etcd with a key of their own", () => {
    // Those Secrets hold DATABASE_URL, AUTH_SECRET, STRIPE_SECRET_KEY and, with
    // an in-cluster database, four PostgreSQL passwords and the cluster's own
    // private key. Neither cloud offers a managed option for this one.
    expect(withoutComments(aws)).toContain("encryptionConfigKeyArn: secretsKey.arn");
    expect(withoutComments(gcp)).toContain(
      'databaseEncryption: { state: "ENCRYPTED", keyName: secretsKey.id }',
    );
  });

  it("does not reach for a customer key on the volumes themselves", () => {
    // A key policy to get wrong, a monthly charge, and a documented way to lock
    // a deployment permanently out of its own ledger volume. The provider's key
    // is the right default for a profile one person can run.
    expect(withoutComments(aws)).not.toContain("kmsKeyId");
    expect(withoutComments(gcp)).not.toContain("disk-encryption-kms-key");
  });

  it("keeps a released claim from taking the ledger's volume with it", () => {
    for (const [name, program] of [
      ["aws", aws],
      ["gcp", gcp],
    ] as const) {
      expect(withoutComments(program), name).toContain('reclaimPolicy: "Retain"');
      // A volume lives in one zone and the pod that needs it has to be
      // scheduled there, so the scheduler chooses first and the volume follows.
      expect(withoutComments(program), name).toContain('volumeBindingMode: "WaitForFirstConsumer"');
    }
  });
});

describe("a NetworkPolicy that is actually enforced", () => {
  it("AWS turns on the VPC CNI's network policy agent", () => {
    // Out of the box the CNI hands out addresses and ignores the objects
    // entirely, so the chart's policies would install and guard nothing —
    // worse than none, because the cluster then looks guarded.
    const code = withoutComments(aws);
    expect(code).toContain("useDefaultVpcCni: false");
    expect(code).toContain("vpcCniOptions: { enableNetworkPolicy: true }");
  });

  it("GKE asks for Dataplane V2 and never for Calico", () => {
    // `addonsConfig.networkPolicyConfig` is the other way to get enforcement
    // here and is the one this program must not take: it turns off
    // container-native load balancing, which the frontend's whole
    // client-address story depends on.
    const code = withoutComments(gcp);
    expect(code).toContain('datapathProvider: inClusterDatabase ? "ADVANCED_DATAPATH" : undefined');
    expect(code).not.toContain("networkPolicyConfig");
  });
});

describe("who may reach the control plane", () => {
  it("is unset by default on both clouds, so an existing stack plans no change", () => {
    // A wrong guess here locks a stack out of the control plane it would need
    // in order to fix itself.
    expect(common).toContain('cfg.get("controlPlaneCidrs") ?? ""');
    expect(withoutComments(aws)).toContain(
      "settings.controlPlaneCidrs.length > 0 ? settings.controlPlaneCidrs : undefined",
    );
    expect(withoutComments(gcp)).toContain("settings.controlPlaneCidrs.length > 0");
  });
});
