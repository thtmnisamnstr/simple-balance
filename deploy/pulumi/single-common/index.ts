import * as pulumi from "@pulumi/pulumi";

import type { MachineSettings, Size } from "./cloud-init";

/**
 * The `single` profile on a cloud VM, in the parts both clouds share.
 *
 * What differs between AWS and OCI is the network, the image lookup and the
 * name of the block device. Everything above that — the machine sizes, the
 * PostgreSQL settings that go with each, and the cloud-init that turns a bare
 * Linux into this deployment — is the same program twice, so it is here once.
 * The cloud-init is in `./cloud-init.ts`, apart from the Pulumi half, so the
 * repository's own tests can render it.
 */

/**
 * The sizing table, and the single source of the numbers in
 * `docs/deployment-sizing.md`.
 *
 * `tests/deployment-sizing.test.ts` reads this file as text and compares it
 * against that document row by row, because a sizing table that disagrees with
 * the program that implements it is worse than no table: the reader sizes their
 * machine from the document and gets whatever the code says.
 *
 * The PostgreSQL settings are for the server DATABASE_URL names, which is not
 * on this machine; nothing here applies them. The data disk holds the backups,
 * the generated secret and env.local, and OCI raises it to its own 50 GB floor.
 */
export const SIZES: Record<string, Size> = {
  // One household, and comfortably more than a ledger of a few thousand
  // transactions needs. Its PostgreSQL settings are for a database server of
  // the same shape, which is what a small managed instance usually is.
  small: {
    vcpu: 2,
    memoryGib: 4,
    dataGib: 20,
    sharedBuffers: "512MB",
    effectiveCacheSize: "1536MB",
    workMem: "8MB",
    maintenanceWorkMem: "256MB",
    maxWalSize: "4GB",
  },
  // A team. The step that matters here is maintenance_work_mem: it decides how
  // long a migration that rewrites an index takes, and it is claimed only while
  // such work runs.
  medium: {
    vcpu: 4,
    memoryGib: 16,
    dataGib: 50,
    sharedBuffers: "4GB",
    effectiveCacheSize: "11GB",
    workMem: "16MB",
    maintenanceWorkMem: "1GB",
    maxWalSize: "8GB",
  },
  // Past this the answer is the `ha` profile rather than a larger machine: one
  // host is still one restart, one disk and one upgrade window, however much
  // of it there is.
  large: {
    vcpu: 8,
    memoryGib: 32,
    dataGib: 100,
    sharedBuffers: "8GB",
    effectiveCacheSize: "22GB",
    workMem: "32MB",
    maintenanceWorkMem: "2GB",
    maxWalSize: "16GB",
  },
};

/**
 * The release these programs pin when a stack does not ask for another.
 *
 * Written as a whole image reference rather than as a bare version string, and
 * that is the point: `scripts/set-version.mjs` rewrites a pinned tag by matching
 * the reference, and `tests/version.test.ts` finds every one of them the same
 * way. A lone "0.1.6" here would be invisible to both, and the programs would go
 * on deploying whatever release this file was written during.
 */
export const DEFAULT_IMAGE = "ghcr.io/thtmnisamnstr/simple-balance:0.1.6";
const DEFAULT_TAG = DEFAULT_IMAGE.split(":")[1]!;

export interface SingleSettings extends MachineSettings {
  /** Empty means no SSH ingress at all, which is the default and the right one. */
  sshCidr: string;
  /** The key that opening the port would otherwise be useless without. */
  sshPublicKey: string;
}

export function readSingleSettings(): SingleSettings {
  const cfg = new pulumi.Config("simple-balance");

  const sizeName = cfg.get("size") ?? "small";
  const size = SIZES[sizeName];
  if (!size) {
    throw new Error(
      `simple-balance:size is "${sizeName}"; it is one of ${Object.keys(SIZES).join(", ")}.`,
    );
  }

  const hostname = cfg.require("hostname");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname)) {
    throw new Error(
      `simple-balance:hostname is a DNS name and nothing else: no scheme, no port, no path. Got "${hostname}".`,
    );
  }

  // Refused here rather than left to Caddy, which would accept it, fail the
  // ACME challenge, and serve nothing with a certificate error rather than an
  // explanation. The name has to resolve to this machine before Let's Encrypt
  // will issue for it, which is a DNS record the operator makes.
  const sshCidr = cfg.get("sshCidr") ?? "";
  if (sshCidr && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(sshCidr)) {
    throw new Error(`simple-balance:sshCidr is an IPv4 CIDR. Got "${sshCidr}".`);
  }
  if (sshCidr === "0.0.0.0/0") {
    throw new Error(
      "simple-balance:sshCidr is 0.0.0.0/0, which opens SSH to the internet. " +
        "Name your own address, or leave it unset and use the provider's agent-based shell.",
    );
  }

  // At least one, because the pruning keeps the newest N and zero would delete
  // the dump it has just taken — leaving a timer that runs nightly, reports
  // success, and retains nothing.
  const backupKeep = cfg.getNumber("backupKeep") ?? 14;
  if (!Number.isInteger(backupKeep) || backupKeep < 1) {
    throw new Error(
      `simple-balance:backupKeep is ${backupKeep}; it is a whole number of dumps to keep, and at least 1.`,
    );
  }

  const sshPublicKey = (cfg.get("sshPublicKey") ?? "").trim();
  if (
    sshPublicKey &&
    !/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(sshPublicKey)
  ) {
    throw new Error(
      "simple-balance:sshPublicKey is the contents of a .pub file — an algorithm, a space, and the " +
        `key. Got "${sshPublicKey.slice(0, 24)}...". A private key here would be a private key in your stack config.`,
    );
  }
  // Half a configuration refuses, the way the mail settings do. A port opened
  // with no key on the machine is a rule in a security group and nothing to
  // reach: the login fails, and the operator debugs their network rather than
  // the setting they forgot. The other direction is fine and deliberately
  // allowed — a key with no open port is how the OCI Bastion service reaches a
  // machine that publishes no SSH at all, from inside its subnet.
  if (sshCidr && !sshPublicKey) {
    throw new Error(
      "simple-balance:sshCidr opens port 22 but simple-balance:sshPublicKey is unset, so nothing " +
        "could log in. Set the key, or unset the CIDR and use the provider's agent-based shell.",
    );
  }

  return {
    size,
    sizeName,
    hostname,
    acmeEmail: cfg.get("acmeEmail") ?? "",
    allowedEmails: cfg.get("allowedEmails") ?? "",
    // The release when unset, filled in here so the render has one answer to
    // put in the compose file rather than two places deciding it.
    imageTag: cfg.get("imageTag") || DEFAULT_TAG,
    imageRepository: cfg.get("imageRepository") ?? "ghcr.io/thtmnisamnstr/simple-balance",
    sshCidr,
    sshPublicKey,
    timezone: cfg.get("timezone") ?? "Etc/UTC",
    backupKeep,
  };
}
