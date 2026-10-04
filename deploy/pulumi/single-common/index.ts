import * as pulumi from "@pulumi/pulumi";

import { readAppSettings, settingsEnvFile } from "../common/app-settings";
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
 * One table, two machines per row. `simple-balance:size` picks the application
 * node's shape out of a row and `simple-balance:databaseSize` the database
 * node's, and each row carries both because the two want opposite things: the
 * application is a Node process that is mostly idle and stores no ledger, and
 * PostgreSQL would take every byte of memory and every block of disk on the
 * machine. One `dataGib` for both was the defect this replaces — it sized the
 * database node's disk as though the application node held the ledger, and the
 * application node's as though it did not hold fourteen dumps of it.
 *
 * The five PostgreSQL settings belong to the `database` half and are applied by
 * the database node's compose file as `-c` flags. They have not moved: each row
 * was already written for a server of the memory its `database` shape now names,
 * which is what makes this a re-shaping of the machines rather than a re-tuning
 * of the server.
 *
 * Every number here is greater than or equal to what it was before the split,
 * and that is a rule rather than a coincidence. Growing a volume is an in-place
 * update on both clouds; shrinking one is refused outright by AWS and would be
 * a replacement on OCI, which with `protectDataVolume` off is a deleted ledger.
 * So the table may be made more generous and never less, and `small`'s
 * application disk stays at 20 GiB although the arithmetic below asks for 10.
 */
export const SIZES: Record<string, Size> = {
  // One household, and comfortably more than a ledger of a few thousand
  // transactions needs. Both machines stay where they were, which is what keeps
  // the pair inside Oracle's Always Free allowance: 4 OCPU and 8 GB of Ampere,
  // and two 50 GB boot volumes beside two data volumes OCI raises to its own
  // 50 GB floor, which is 200 GB to the byte.
  //
  // Sized for 2M transactions. At 4 GiB of memory that whole ledger fits in
  // cache — the crossover is about 2.8M — so there is nothing a larger machine
  // would be buying here.
  small: {
    application: { vcpu: 2, memoryGib: 4, diskGib: 20 },
    database: { vcpu: 2, memoryGib: 4, diskGib: 30 },
    sharedBuffers: "512MB",
    effectiveCacheSize: "1536MB",
    workMem: "8MB",
    maintenanceWorkMem: "256MB",
    maxWalSize: "4GB",
  },
  // A team, and the row the capacity target is measured at: 10,000 people and
  // 30 million transactions, which `docs/capacity.md` served at p95 130 ms with
  // PostgreSQL held to 1.5 cores and 3 GiB.
  //
  // So the application node comes *down* to the small machine. It peaked at
  // 108.6% of half a core and 745 MiB under that run; two cores and 4 GiB is
  // four times its measured peak, and the four cores it used to buy were bought
  // for a machine that stores no ledger and whose memory does nothing for the
  // database's cache.
  //
  // The database node keeps them, and the memory is where the step is. The two
  // big tables' indexes alone come to 18.2 GiB at this target, so 16 GiB of
  // memory holds 84% of them against 8 GiB's 40% — which is the one place a
  // bigger machine buys something measurable. The step that matters after that
  // is maintenance_work_mem: it decides how long a migration that rewrites an
  // index takes, and it is claimed only while such work runs.
  medium: {
    application: { vcpu: 2, memoryGib: 4, diskGib: 110 },
    database: { vcpu: 4, memoryGib: 16, diskGib: 100 },
    sharedBuffers: "4GB",
    effectiveCacheSize: "11GB",
    workMem: "16MB",
    maintenanceWorkMem: "1GB",
    maxWalSize: "8GB",
  },
  // Past this the answer is the `ha` profile rather than a larger machine: one
  // host is still one restart, one disk and one upgrade window, however much
  // of it there is.
  //
  // The application node's disk is the larger of the two here, and it is not a
  // mistake. It holds fifteen dumps of a 100M-transaction ledger — fourteen
  // kept plus the one being written, which is the peak `simple-balance-backup`
  // documents at its prune — and nothing else. `simple-balance:backupKeep` is
  // the lever: at 3 it is a quarter of this.
  large: {
    application: { vcpu: 2, memoryGib: 8, diskGib: 340 },
    database: { vcpu: 8, memoryGib: 32, diskGib: 300 },
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
   * it is without them, and the operator sets a DATABASE_URL of their own in
   * `simple-balance:secrets`, which firstboot waits for. That is the escape hatch for
   * somebody who already keeps a PostgreSQL. It is no longer the only way to
   * avoid AWS's NAT gateway charge — `simple-balance:databaseEgress: ipv6`
   * keeps the database node and drops the gateway — so it is the answer to
   * "I have a database", not to "this is expensive".
   */
  database?: DatabaseSettings;
  /**
   * The stack's own settings — `simple-balance:env` and `simple-balance:secrets`
   * — as the lines the machine's Compose `.env` takes, and a Pulumi secret,
   * because it holds the secrets. Each program writes it into its cloud's
   * secret store and the machine fetches it from there; it never travels in
   * user data.
   */
  appSettingsFile: pulumi.Output<string>;
}

/**
 * The application settings these programs decide themselves, so a stack
 * cannot also set them in `simple-balance:env` or `:secrets`. Each is a reason
 * that finishes "cannot be set here: ...".
 *
 * DATABASE_URL and AUTH_SECRET are deliberately not in it. Both are generated,
 * and both are worth overriding on purpose: a DATABASE_URL of the operator's
 * own is how `simple-balance:databaseNode: false` is used at all, and the fold
 * on the machine lets the stack's settings win for exactly that reason.
 */
const SINGLE_OWNED = {
  APP_BASE_URL: "it is https:// and simple-balance:hostname, so set that",
  ALLOWED_EMAILS: "it is simple-balance:allowedEmails, so set that",
  NODE_ENV:
    "the image sets production, and anything else turns off the setup code, sign-in rate limiting and secure cookies",
  PORT: "Caddy proxies to the port the compose file names, and a different one is a site that answers nothing",
  TRUST_PROXY:
    "compose.caddy.yml sets it true, because Caddy is in front and writes X-Forwarded-For itself",
} as const;

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

  // Checked here, at plan time and before anything is declared, for the reason
  // every refusal in this function is: under `--skip-preview` a throw after the
  // first resource leaves that resource built. The secret map is read as the
  // runtime hands it over, already decrypted, so its names can be checked
  // without a value ever being printed.
  const rawSecrets = pulumi.runtime.getConfig("simple-balance:secrets");
  const app = readAppSettings(
    cfg.getObject<unknown>("env"),
    rawSecrets === undefined ? undefined : JSON.parse(rawSecrets),
    SINGLE_OWNED,
  );

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
    appSettingsFile: pulumi.secret(settingsEnvFile(app)),
  };
}
