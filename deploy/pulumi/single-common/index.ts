import * as pulumi from "@pulumi/pulumi";

import type { DatabaseSettings, MachineSettings, Size } from "./cloud-init";

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
 * One table, read twice: `simple-balance:size` picks the application node's row
 * and `simple-balance:databaseSize` the database node's, because the two want
 * opposite things — the application is a Node process that is mostly idle, and
 * PostgreSQL would take every byte of memory on the machine. The five
 * PostgreSQL settings in each row are applied by the database node's compose
 * file as `-c` flags. The data disk holds the backups, the generated secret and
 * env.local on the application node and PGDATA on the database node, and OCI
 * raises it to its own 50 GB floor on both.
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
  /**
   * Undefined when `simple-balance:databaseNode` is false, which builds no
   * database node, no private subnet and no NAT gateway: the machine is what
   * it is without them, and the operator writes a DATABASE_URL of their own
   * into env.local, which firstboot waits for. That is the escape hatch for
   * somebody who already keeps a PostgreSQL, and on AWS it is also how to
   * avoid the NAT gateway's monthly charge.
   */
  database?: DatabaseSettings;
}

/**
 * What a password may contain, and it is deliberately narrower than what
 * PostgreSQL would accept.
 *
 * The value travels through a URL, a Compose `.env` file and a shell script
 * before it reaches the server, and each of those has its own escape rules: `@`
 * `:` `/` `?` `#` and `%` end a URL's userinfo, `$` is expanded by Compose and
 * by sh, and a quote ends a string in both. Letters and digits pass all three
 * untouched, which is why `random.RandomPassword` is asked for `special: false`
 * and why an operator's own value is held to the same rule rather than
 * percent-encoded on the way past — an encoding applied in one of those three
 * places and not the others is a password that works until the nightly backup
 * runs.
 */
const PASSWORD_CHARACTERS = /^[A-Za-z0-9]+$/;

/** Short enough to brute-force is short enough to refuse. */
const MIN_PASSWORD_LENGTH = 16;

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

  // On by default, and that is safe because no `single` stack has ever
  // shipped: there is no deployment in the field for a new database node to
  // appear underneath. The default is the shape the profile is for — a person
  // who wants a ledger, not a person who wants to shop for a managed
  // PostgreSQL first — and false is the escape hatch rather than the norm.
  const databaseNode = cfg.getBoolean("databaseNode") ?? true;

  // Defaulted to the application node's size rather than to `small`, so a stack
  // that asked for `medium` and said nothing else gets a database that can keep
  // up with the machine in front of it. Named separately because the two rarely
  // want the same row for long.
  const databaseSizeName = cfg.get("databaseSize") ?? sizeName;
  const databaseSize = SIZES[databaseSizeName];
  if (databaseNode && !databaseSize) {
    throw new Error(
      `simple-balance:databaseSize is "${databaseSizeName}"; it is one of ${Object.keys(SIZES).join(", ")}. ` +
        "Unset it to size the database node the same as the application node.",
    );
  }

  // Ten is the floor rather than one, because DATABASE_POOL_SIZE defaults to 10
  // and a ceiling under the pool is a deployment that starts, serves a few
  // requests and then refuses connections under the first import — a failure
  // that looks like the application rather than like this number.
  const databaseMaxConnections = cfg.getNumber("databaseMaxConnections") ?? 50;
  if (!Number.isInteger(databaseMaxConnections) || databaseMaxConnections < 10) {
    throw new Error(
      `simple-balance:databaseMaxConnections is ${databaseMaxConnections}; it is a whole number ` +
        "and at least 10, which is DATABASE_POOL_SIZE's own default.",
    );
  }

  // Refused here rather than percent-encoded on the way into the URL, for the
  // reason PASSWORD_CHARACTERS gives: the value passes through three escaping
  // rules and an encoding that satisfies one of them breaks the other two.
  const databasePassword = cfg.get("databasePassword") ?? "";
  if (databasePassword && !PASSWORD_CHARACTERS.test(databasePassword)) {
    throw new Error(
      "simple-balance:databasePassword has a character outside A-Z a-z 0-9. It is carried in a " +
        "connection string, a Compose .env file and a shell script, which escape differently, so " +
        "the set is narrowed rather than encoded. Unset it and the program generates one: " +
        "pulumi config rm simple-balance:databasePassword",
    );
  }
  if (databasePassword && databasePassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `simple-balance:databasePassword is ${databasePassword.length} characters; it is at least ` +
        `${MIN_PASSWORD_LENGTH}. Unset it and the program generates 32.`,
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
    database: databaseNode
      ? {
          size: databaseSize!,
          sizeName: databaseSizeName,
          maxConnections: databaseMaxConnections,
          password: databasePassword,
        }
      : undefined,
  };
}
