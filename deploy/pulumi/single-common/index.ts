import * as fs from "fs";
import * as path from "path";

import * as pulumi from "@pulumi/pulumi";

/**
 * The `single` profile on a cloud VM, in the parts both clouds share.
 *
 * What differs between AWS and OCI is the network, the image lookup and the
 * name of the block device. Everything above that — the machine sizes, the
 * PostgreSQL tuning that goes with each, and the cloud-init that turns a bare
 * Linux into this deployment — is the same program twice, so it is here once.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

/**
 * The sizing table, and the single source of the numbers in
 * `docs/deployment-sizing.md`.
 *
 * `tests/deployment-sizing.test.ts` reads this file as text and compares it
 * against that document row by row, because a sizing table that disagrees with
 * the program that implements it is worse than no table: the reader sizes their
 * machine from the document and gets whatever the code says.
 */
export interface Size {
  /** Machine sizes, named by what they are rather than by a provider's SKU. */
  vcpu: number;
  memoryGib: number;
  /** The data disk. The boot disk is 20 GiB everywhere and holds no database. */
  dataGib: number;
  sharedBuffers: string;
  effectiveCacheSize: string;
  workMem: string;
  maintenanceWorkMem: string;
  maxWalSize: string;
}

export const SIZES: Record<string, Size> = {
  // One household, and comfortably more than a ledger of a few thousand
  // transactions needs. The smallest size where PostgreSQL and a Node process
  // are not competing for page cache.
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

export interface SingleSettings {
  size: Size;
  sizeName: string;
  hostname: string;
  acmeEmail: string;
  allowedEmails: string;
  imageTag: string;
  imageRepository: string;
  /** Empty means no SSH ingress at all, which is the default and the right one. */
  sshCidr: string;
  /** The key that opening the port would otherwise be useless without. */
  sshPublicKey: string;
  timezone: string;
  backupKeep: number;
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
  if (sshPublicKey && !/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(sshPublicKey)) {
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
  // machine that publishes no SSH at all.
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
    imageTag: cfg.get("imageTag") ?? "",
    imageRepository: cfg.get("imageRepository") ?? "ghcr.io/thtmnisamnstr/simple-balance",
    sshCidr,
    sshPublicKey,
    timezone: cfg.get("timezone") ?? "Etc/UTC",
    backupKeep,
  };
}

/** Indents a file's contents to sit under a cloud-init `content: |` key. */
function block(contents: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return contents
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : ""))
    .join("\n");
}

/**
 * Reads a file out of the repository, so the compose files, the units and the
 * scripts have one definition rather than a copy in each cloud program.
 *
 * The failure it guards is this module being run from somewhere other than its
 * place in the tree — copied out, vendored, or built to a different depth —
 * where `repoRoot` resolves to a directory that simply does not have these
 * files under it. Node's own error for that names a path three levels from
 * anything recognisable and says nothing about why it was looking there.
 */
function repoFile(relative: string): string {
  const file = path.join(repoRoot, relative);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Cannot read ${relative}: it is not under ${repoRoot}. These programs read the deployment ` +
        "material out of the repository rather than repeating it, so they have to be run from " +
        "their own directory inside a checkout.",
    );
  }
  return fs.readFileSync(file, "utf8");
}

export interface CloudInitArgs {
  settings: SingleSettings;
  /**
   * The block device the data volume appears as. AWS NVMe presents an EBS
   * volume under a name the kernel chooses, so that program passes a
   * by-id path; OCI presents a stable `/dev/oracleoci/...` symlink.
   */
  dataDevice: string;
  /**
   * Shell commands run before the first-boot script, for whatever the platform
   * gets wrong on its own.
   *
   * It exists for OCI, whose Ubuntu images ship a netfilter ruleset that
   * accepts 22 and drops everything else — so opening 80 and 443 in the cloud's
   * own security list is necessary and not sufficient, and the symptom is a
   * machine that answers SSH and times out on the web. AWS needs nothing here.
   */
  platformCommands?: string[];
}

/**
 * The whole of the machine's configuration, as cloud-init.
 *
 * The compose files, the Caddyfile, the units and the two scripts are read from
 * this repository rather than repeated here, so there is one description of the
 * deployment and a change to it reaches the cloud programs without anybody
 * remembering to copy it.
 *
 * No secret appears in this text, and that is a deliberate design rather than
 * an omission. AUTH_SECRET is generated on the machine at first boot and kept on
 * the data volume, so it never enters user data — which is readable by anyone
 * who can describe the instance — and never enters Pulumi's state file either.
 * Nothing outside the machine needs to know it. The settings that genuinely come
 * from outside — DATABASE_URL, an SMTP password, a Stripe key — are added to
 * /var/lib/simple-balance/env.local afterwards;
 * the README says so, because putting them here would undo the whole point.
 */
export function cloudInit(args: CloudInitArgs): string {
  const { settings, dataDevice } = args;
  const image = `${settings.imageRepository}:${settings.imageTag || DEFAULT_TAG}`;

  // The compose file pins the released tag. Where the stack asks for a
  // different one, it is substituted rather than the file being duplicated.
  const composeYml = repoFile("deploy/compose/single/compose.yml").replace(
    /image: ghcr\.io\/thtmnisamnstr\/simple-balance:\S+/,
    `image: ${image}`,
  );

  return `#cloud-config
# Generated by deploy/pulumi/single-common and applied once, when this machine
# first booted.
#
# A later \`pulumi up\` does not re-run it. Cloud-init's runcmd is per-instance,
# and neither program replaces the instance when this text changes — which is
# deliberate: an instance replacement on every edit would be several minutes of
# downtime, and on Oracle Cloud it would change the address the DNS record
# points at. These programs provision the machine; they do not keep managing it.
#
# So apply a change here, not there:
#   an application upgrade   edit /opt/simple-balance/compose.yml, then
#                            sudo docker compose -f /opt/simple-balance/compose.yml pull
#                            sudo systemctl restart simple-balance
#   a setting                edit /var/lib/simple-balance/env.local, then
#                            sudo systemctl restart simple-balance
#
# env.local is on the data volume, so it is the one of those two that survives
# the machine being rebuilt.
timezone: ${settings.timezone}

package_update: true
packages:
  # Ubuntu's own packages rather than Docker's apt repository. One less
  # third-party key to trust at first boot, and docker-compose-v2 is the same
  # plugin under a different maintainer.
  - docker.io
  - docker-compose-v2
  - unattended-upgrades

write_files:
  - path: /opt/simple-balance/compose.yml
    permissions: "0644"
    content: |
${block(composeYml, 6)}

  - path: /opt/simple-balance/compose.caddy.yml
    permissions: "0644"
    content: |
${block(repoFile("deploy/compose/single/compose.caddy.yml"), 6)}

  - path: /opt/simple-balance/Caddyfile
    permissions: "0644"
    content: |
${block(repoFile("deploy/compose/single/Caddyfile"), 6)}

  - path: /etc/systemd/system/simple-balance.service
    permissions: "0644"
    content: |
${block(repoFile("deploy/systemd/simple-balance.service"), 6)}

  - path: /etc/systemd/system/simple-balance-backup.service
    permissions: "0644"
    content: |
${block(repoFile("deploy/systemd/simple-balance-backup.service"), 6)}

  - path: /etc/systemd/system/simple-balance-backup.timer
    permissions: "0644"
    content: |
${block(repoFile("deploy/systemd/simple-balance-backup.timer"), 6)}

  - path: /usr/local/bin/simple-balance-backup
    permissions: "0755"
    content: |
${block(repoFile("deploy/systemd/simple-balance-backup"), 6)}

  - path: /usr/local/bin/simple-balance-restore
    permissions: "0755"
    content: |
${block(repoFile("deploy/systemd/simple-balance-restore"), 6)}

  - path: /etc/default/simple-balance
    permissions: "0644"
    content: |
      COMPOSE_FILE=compose.yml:compose.caddy.yml
      SB_BACKUP_DIR=/var/lib/simple-balance/backups
      SB_BACKUP_KEEP=${settings.backupKeep}
      SB_DATA_DEVICE=${dataDevice}
      SB_PG_CLIENT_IMAGE=postgres:18

  # Everything the deployment needs that is not a secret. The secrets are
  # appended to this file on first boot by the script below, from values
  # generated on the machine.
  - path: /opt/simple-balance/env.base
    permissions: "0644"
    content: |
      APP_BASE_URL=https://${settings.hostname}
      SITE_ADDRESS=${settings.hostname}
      ACME_EMAIL=${settings.acmeEmail}
      AUTH_MODE=local
      ALLOWED_EMAILS=${settings.allowedEmails}
      LOG_LEVEL=info

      # No DATABASE_URL here, and its absence is the design rather than an
      # omission. This profile's database is somebody else's, so the connection
      # string carries a password — and everything in this file arrives on the
      # machine as cloud-init user data, which anyone who can describe the
      # instance can read. It goes in /var/lib/simple-balance/env.local instead,
      # by hand, the way an SMTP password or a Stripe key does; the firstboot
      # script leaves the deployment enabled-but-stopped and says so until it is
      # there.
      #
      # Nor are there any POSTGRES_* tuning settings. They were written here
      # while this profile bundled a database, and nothing on the machine has
      # read them since it stopped. The numbers still matter — they are what to
      # set on whichever PostgreSQL you point this at — and
      # docs/deployment-sizing.md is where they are, per machine size.

  - path: /usr/local/sbin/simple-balance-firstboot
    permissions: "0700"
    content: |
${block(repoFile("deploy/systemd/simple-balance-firstboot"), 6)}

runcmd:
${(args.platformCommands ?? []).map((command) => `  - ${command}`).join("\n")}
  - [/usr/local/sbin/simple-balance-firstboot]
`;
}
