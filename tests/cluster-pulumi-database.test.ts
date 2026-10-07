import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { programCode, resourceCallsCode } from "./support/pulumi-source.js";
import { repoFiles } from "./support/source.js";

/**
 * The cluster programs and the module they share, read as text.
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

/**
 * Every program that drives a Kubernetes cluster, found by what makes it one:
 * it constructs a `k8s.Provider`.
 *
 * `aws` and `gcp` above stay named for the facts that belong to one cloud —
 * an addon, a datapath — and the claims about every cluster program are made
 * over this instead. They used to be made over those two, so the OCI program
 * was never asked whether its StorageClass says its volumes are encrypted,
 * keeps them on a released claim, or hands its name to the chart; a fourth
 * cloud would have been asked nothing either.
 */
const clusterPrograms = repoFiles((file) => /^deploy\/pulumi\/[^/]+\/index\.ts$/.test(file))
  .filter((file) => programCode(file.text).includes("new k8s.Provider("))
  .map((file) => ({
    path: file.path,
    text: file.text,
    storageClasses: resourceCallsCode(file.text, "k8s.storage.v1.StorageClass"),
  }));

/**
 * Drivers whose provider encrypts every volume at rest and offers no way not
 * to, each with what the provider says.
 *
 * `AGENTS.md` asks a volume to say it is encrypted wherever the provider makes
 * that optional, because there the property is the whole guarantee and a plan
 * shows it. On these two there is nothing to say short of a customer key,
 * which every class here declines (below). This used to be a register of two
 * programs in violation; the owner settled it by saying where the rule applies
 * rather than by excepting the programs it did not fit, so a third cloud is
 * asked the same question and answers it by its driver.
 */
const ENCRYPTED_WITHOUT_ASKING = new Map([
  [
    "pd.csi.storage.gke.io",
    "Google encrypts every persistent disk at rest with Google-managed keys and has no setting that turns it off; the driver's only encryption parameter is `disk-encryption-kms-key`, a customer key",
  ],
  [
    "blockvolume.csi.oraclecloud.com",
    "Oracle encrypts every block volume at rest with Oracle-managed keys and has no setting that turns it off; the driver's only encryption parameter is `kms-key-id`, a customer key",
  ],
]);

/** The driver a StorageClass names. */
const provisionerOf = (storageClass: string) =>
  /provisioner:\s*"([^"]+)"/.exec(storageClass)?.[1] ?? "";

/** The `parameters` object a StorageClass hands its driver, or nothing. */
const parametersOf = (storageClass: string) =>
  /parameters:\s*\{([^}]*)\}/.exec(storageClass)?.[1] ?? "";

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
    // No cloud's default StorageClass says `encrypted`, and it is the one
    // place at-rest encryption for the ledger is actually decided.
    expect(code).toContain("persistence: { storageClass: args.databaseStorageClass }");
    for (const program of clusterPrograms) {
      expect(program.storageClasses, `${program.path} declares one class`).toHaveLength(1);
      // OCI hands it over only with an in-cluster database, and the other two
      // unconditionally; either way it is the class this program made.
      expect(programCode(program.text), program.path).toMatch(
        /databaseStorageClass: [^,\n]*databaseStorageClass\.metadata\.name/,
      );
    }
  });
});

describe("encryption at rest, written down rather than assumed", () => {
  /**
   * Found what it was meant to find, because an empty population passes every
   * claim made over it: three clouds today, AWS among them.
   */
  it("finds every cluster program", () => {
    expect(clusterPrograms.length).toBeGreaterThanOrEqual(3);
    expect(clusterPrograms.map((program) => program.path)).toContain("deploy/pulumi/aws/index.ts");
  });

  /**
   * The rule itself, over every cluster program rather than the one where it
   * was first written. The old check asserted `encrypted: "true"` on AWS and
   * asked GCP only that it held no customer key, and never read OCI at all.
   */
  it("says on every StorageClass that its volumes are encrypted, wherever that is optional", () => {
    const silent = clusterPrograms.flatMap((program) =>
      program.storageClasses
        .filter((storageClass) => !ENCRYPTED_WITHOUT_ASKING.has(provisionerOf(storageClass)))
        .filter((storageClass) => !/\bencrypt\w*\s*:\s*"true"/i.test(parametersOf(storageClass)))
        .map((storageClass) => `${program.path}: ${provisionerOf(storageClass)}`),
    );
    expect(silent, "set the driver's encryption parameter").toEqual([]);
    const used = clusterPrograms.flatMap((program) => program.storageClasses.map(provisionerOf));
    expect(
      [...ENCRYPTED_WITHOUT_ASKING.keys()].filter((provisioner) => !used.includes(provisioner)),
      "no class names these drivers any more — take them out",
    ).toEqual([]);
  });

  /**
   * The Oracle class's half of in-transit encryption, and the bug that kept it
   * from ever applying. The class asked for `attachmentType`, which the driver
   * does not read and ignores without a word, so every volume it made was
   * attached over iSCSI, which OCI never encrypts in transit. The other half is
   * the node pool's launch option, which the driver consults at attach time.
   */
  it("attaches Oracle's volumes paravirtualized, on nodes that encrypt the hop", () => {
    const oci = clusterPrograms.find((program) => program.path === "deploy/pulumi/oci/index.ts")!;
    expect(oci, "the OCI cluster program").toBeDefined();
    for (const storageClass of oci.storageClasses) {
      expect(parametersOf(storageClass)).toContain('"attachment-type": "paravirtualized"');
    }
    for (const program of clusterPrograms) {
      for (const storageClass of program.storageClasses) {
        expect(parametersOf(storageClass), program.path).not.toMatch(/\battachmentType\b/);
      }
    }
    const pools = resourceCallsCode(oci.text, "oci.containerengine.NodePool");
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) expect(pool).toContain("isPvEncryptionInTransitEnabled: true");
  });

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
    // is the right default for a profile one person can run. Every driver's
    // spelling has `kms` in it — `kmsKeyId`, `disk-encryption-kms-key`,
    // `kms-key-id` — and it is asked of the class, not the program, because a
    // key for the cluster's Secrets is a different decision.
    for (const program of clusterPrograms) {
      for (const storageClass of program.storageClasses) {
        expect(storageClass, program.path).not.toMatch(/kms/i);
      }
    }
  });

  it("keeps a released claim from taking the ledger's volume with it", () => {
    for (const program of clusterPrograms) {
      for (const storageClass of program.storageClasses) {
        expect(storageClass, program.path).toContain('reclaimPolicy: "Retain"');
        // A volume lives in one zone and the pod that needs it has to be
        // scheduled there, so the scheduler chooses first and the volume follows.
        expect(storageClass, program.path).toContain('volumeBindingMode: "WaitForFirstConsumer"');
      }
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
