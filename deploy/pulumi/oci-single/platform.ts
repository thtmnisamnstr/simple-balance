import { cloudInit, databaseCloudInit, ociMetadata } from "../single-common/cloud-init";
import type {
  ApplicationDatabase,
  DatabaseCloudInitArgs,
  MachineSettings,
  NodeSize,
  SettingsSource,
} from "../single-common/cloud-init";

/**
 * What `./index.ts` decides about Oracle Cloud that is not a resource: the disk
 * floor, which availability domain and when the data volume refuses a new one,
 * the region, the key, and the metadata the instance is launched with.
 *
 * Apart from the program, with no Pulumi import, for the same reason
 * `../single-common/cloud-init.ts` is: the repository's tests render and check
 * these exactly as a `pulumi up` would, and they cannot import the program.
 */

/**
 * OCI's consistent device path, which exists precisely so a guest does not
 * have to guess. The attachment asks for this name and the guest sees this
 * symlink, on every reboot, whatever order the devices enumerate in.
 */
export const DATA_DEVICE = "/dev/oracleoci/oraclevdb";

/**
 * OCI's Ubuntu images ship a netfilter ruleset that accepts 22 and REJECTs the
 * rest, so the security list opens the cloud and the host still refuses.
 * Inserted at the top of the INPUT chain — appending would land after the
 * REJECT that ends it and change nothing — and persisted, because the rules
 * are reloaded from that file on boot. 22 is already accepted, which is what
 * lets a Bastion session in.
 */
export const PLATFORM_COMMANDS = [
  '["/bin/sh", "-c", "iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT && iptables -I INPUT 2 -p tcp --dport 443 -j ACCEPT && iptables -I INPUT 3 -p udp --dport 443 -j ACCEPT && netfilter-persistent save"]',
];

/**
 * The same half of the firewall on the database node, for its one port.
 *
 * Without it the machine comes up, PostgreSQL reports itself healthy, the
 * security list allows 5432 from the application's subnet, and every connection
 * times out — the security list opens the cloud and the host still refuses. The
 * application then fails its migrations with a message about the database being
 * unreachable, which sends an operator to look at the subnet they can see
 * rather than at the ruleset they cannot.
 *
 * Only 5432, and nothing for 80 or 443: this machine serves neither, has no
 * public address, and a rule for a port nothing listens on is an invitation to
 * put something there later.
 */
export const DATABASE_PLATFORM_COMMANDS = [
  '["/bin/sh", "-c", "iptables -I INPUT 1 -p tcp --dport 5432 -j ACCEPT && netfilter-persistent save"]',
];

/**
 * The VCN resolver's name for the database node, which is what the certificate
 * is issued for and what DATABASE_URL dials.
 *
 * OCI composes it from three labels — the VNIC's hostname, the subnet's DNS
 * label and the VCN's — so it is known before the instance exists, which is
 * exactly what the certificate needs. Built from the same constants the
 * resources take rather than written out as a literal, because a subnet
 * relabelled in one place and not the other is a certificate that verifies
 * against nothing, found at the first connection rather than at
 * `pulumi preview`.
 *
 * It needs no private DNS zone, no /etc/hosts and no `extra_hosts`: Docker's
 * embedded resolver forwards what it cannot answer to the host's, which on OCI
 * is the VCN resolver.
 */
export function databaseHost(vcnLabel: string, subnetLabel: string, hostLabel: string): string {
  return `${hostLabel}.${subnetLabel}.${vcnLabel}.oraclevcn.com`;
}

/**
 * OCI's smallest block volume. The shared table's `small` asks for 20 on the
 * application node and 30 on the database node, both of which EBS accepts and
 * CreateVolume refuses, so they are raised here rather than in `SIZES`, which
 * the AWS program and `docs/deployment-sizing.md` also read.
 *
 * It is also why shrinking the application node's disk toward what the backup
 * arithmetic asks for would save nothing on this cloud: everything under 50
 * lands on 50 either way. It saves real money only on AWS.
 */
const MIN_VOLUME_GB = 50;

export function dataVolumeGb(size: NodeSize): number {
  return Math.max(size.diskGib, MIN_VOLUME_GB);
}

/**
 * The availability domain to build in: the one asked for, by its full name or
 * by its place in the list counting from 1, or the first.
 *
 * Asked for at all because Always Free A1 capacity is often missing from one
 * domain and present in the next, and `Out of host capacity` names no
 * alternative. Refused when it matches nothing, with the names that would, so
 * a typo is not quietly the first domain again.
 */
export function chooseAvailabilityDomain(names: string[], requested: string): string {
  if (names.length === 0) {
    throw new Error("No availability domain in this compartment. Check oci:region.");
  }
  const wanted = requested.trim();
  if (!wanted) return names[0]!;
  if (/^\d+$/.test(wanted)) {
    const chosen = names[Number(wanted) - 1];
    if (chosen) return chosen;
  } else if (names.includes(wanted)) {
    return wanted;
  }
  throw new Error(
    `simple-balance:availabilityDomain is "${wanted}", which is none of this region's: ` +
      `${names.map((name, index) => `${index + 1} (${name})`).join(", ")}.`,
  );
}

/** A block volume as ListVolumes reports it, cut to what the check below reads. */
export interface ListedVolume {
  id: string;
  availabilityDomain: string;
  state: string;
}

/**
 * The availability domain to build in, refused while the protected data volume
 * is in another one.
 *
 * Pulumi's own refusal of that move is not enough, because it comes when the
 * volume's step is reached, and the volume is built after the instance. The
 * preview stops there having changed nothing, but `pulumi up --skip-preview`
 * has by then deleted the machine and launched its replacement in the new
 * domain, where the volume cannot follow — a block volume attaches only within
 * its own domain. Refused here, in the availability domain every zoned input
 * waits for, nothing the move would touch is registered, so both paths leave
 * the machine and the volume as they are.
 *
 * Found by name, since a program cannot read its own state, so a live volume
 * of that name left by a removed stack of the same name is refused too, and
 * the message covers it. Compared without case because that is how the
 * provider decides a volume must be replaced. A volume on its way out holds
 * nothing to keep. Not checked while the protection is off: the move is then
 * what the stack asked for, and the volume goes with it.
 */
export function requireDataVolumeDomain(
  chosen: string,
  volumes: readonly ListedVolume[],
  protect: boolean,
): string {
  if (!protect) return chosen;
  const elsewhere = volumes.filter(
    (volume) =>
      volume.state !== "TERMINATING" &&
      volume.state !== "TERMINATED" &&
      volume.availabilityDomain.toLowerCase() !== chosen.toLowerCase(),
  );
  if (elsewhere.length === 0) return chosen;
  const kept = elsewhere[0]!.availabilityDomain;
  throw new Error(
    `simple-balance:availabilityDomain chooses ${chosen}, but this stack's data volume ` +
      `(${elsewhere.map((volume) => volume.id).join(", ")}) is in ${kept}, and a block volume ` +
      "cannot be attached across domains. Moving would replace it, and the generated secret, " +
      "the backups on it would go with the old one, so neither the machine nor " +
      "the volume has been touched. To stay: pulumi config set simple-balance:availabilityDomain " +
      `"${kept}". To move and start again on an empty volume, copy off what is on it first, then ` +
      "set simple-balance:protectDataVolume to false. A volume of that name that belongs to no " +
      "stack any more is found the same way: rename it or delete it in the console.",
  );
}

/**
 * The region, which has to be written in the stack.
 *
 * The provider itself does not insist: with `oci:region` unset it takes
 * TF_VAR_region or OCI_REGION from the environment, or failing both the region
 * of the `~/.oci/config` profile it reads. So the stack would build wherever
 * the shell running `pulumi up` happened to point, and an existing one run from
 * another shell would look for its resources in a region they are not in. Where
 * a machine holding somebody's data runs is a decision — a privacy policy may
 * promise it — and it belongs with the stack's other decisions rather than in a
 * file on one laptop. Set in the stack, it also wins over both fallbacks.
 *
 * Refused rather than defaulted, as `compartmentOcid` is, because no region is
 * right for everybody. Any region is accepted: this program serves operators
 * anywhere, and a promise about a country is one deployment's promise, not the
 * program's. The message names the home region because Always Free A1 exists
 * only there and no setting moves it.
 */
export function requireRegion(region: string | undefined): string {
  if (!region?.trim()) {
    throw new Error(
      "oci:region is required, in this stack: pulumi config set oci:region <region>, for example " +
        "us-ashburn-1. Unset, the provider takes OCI_REGION or the region of whichever ~/.oci/config " +
        "profile runs `pulumi up`, so where the machine and its data volume live would depend on the " +
        "shell rather than the stack. Always Free Ampere A1 capacity exists only in the tenancy's home " +
        "region, which is chosen at sign-up and cannot be changed; the console shows it under Profile " +
        "→ Tenancy, and `oci iam region-subscription list` marks it is-home-region. A stack that was " +
        "built before this was required is in the region its profile named: set that one, never another.",
    );
  }
  return region;
}

/**
 * Required here, where the AWS program lets it be unset.
 *
 * On OCI the key is the only way onto the machine: there is no Session Manager,
 * a Bastion session authenticates to the host with it, and OCI installs it at
 * launch and never again — `metadata` cannot change on a running instance, and
 * this program ignores changes to it for that reason. A stack without one
 * builds a machine that stops at "no DATABASE_URL yet" with no way to give it
 * one short of destroying it, which also changes its address.
 */
export function requireSshPublicKey(sshPublicKey: string): void {
  if (!sshPublicKey) {
    throw new Error(
      "simple-balance:sshPublicKey is required on Oracle Cloud: it is the only way to log in, and OCI " +
        "installs it at launch and never afterward. Set it before the first `pulumi up`: " +
        'pulumi config set simple-balance:sshPublicKey "$(cat ~/.ssh/id_ed25519.pub)"',
    );
  }
}

/**
 * The OCI CLI the application node reads its settings with, in Oracle's own
 * published image.
 *
 * Pinned to a dated tag, the form Oracle publishes, rather than `latest`: the
 * machine pulls it on its first fetch and keeps it, so a floating tag would be
 * whatever happened to be newest the day the machine was built. It publishes
 * linux/arm64, which the A1 shape needs. Moving it is one line here and reaches
 * only machines built afterwards.
 */
export const OCI_CLI_IMAGE = "ghcr.io/oracle/oci-cli:20260930";

/** The instance's metadata, compressed and checked against OCI's ceiling. */
export function instanceMetadata(
  settings: MachineSettings,
  sshPublicKey: string,
  database?: ApplicationDatabase,
  settingsSource?: SettingsSource,
): Record<string, string> {
  return ociMetadata(
    cloudInit({
      settings,
      dataDevice: DATA_DEVICE,
      platformCommands: PLATFORM_COMMANDS,
      database,
      settingsSource,
    }),
    sshPublicKey,
  );
}

/** The database instance's metadata, measured against the same ceiling. */
export function databaseInstanceMetadata(
  args: Omit<DatabaseCloudInitArgs, "dataDevice" | "platformCommands">,
  sshPublicKey: string,
): Record<string, string> {
  return ociMetadata(
    databaseCloudInit({
      ...args,
      dataDevice: DATA_DEVICE,
      platformCommands: DATABASE_PLATFORM_COMMANDS,
    }),
    sshPublicKey,
  );
}

// ------------------------------------------------- the customer-managed key ---

/** The pair a customer-managed key needs on this cloud, once both are given. */
export interface KmsSelection {
  vaultId: string;
  keyId: string;
}

/**
 * The vault and the key, or neither.
 *
 * Two settings rather than one, and that is OCI's shape rather than a second
 * thing to guess: every Key Management call is made against the *vault's* own
 * management endpoint, which is a per-vault hostname, so a key OCID on its own
 * is not enough to look the key up or to check it. Asking for the vault is
 * honest about that; deriving it would mean a search across the compartment
 * that finds the wrong vault in a tenancy with two.
 *
 * Half a configuration refuses, the way `sshCidr` and `sshPublicKey` do. A
 * vault with no key names nothing to encrypt with, and a key with no vault
 * cannot be checked before it is used — and an unchecked key is the whole of
 * what this program is trying not to do.
 */
export function readKmsSelection(vaultOcid: string, keyOcid: string): KmsSelection | undefined {
  const vaultId = vaultOcid.trim();
  const keyId = keyOcid.trim();
  if (!vaultId && !keyId) return undefined;
  if (!vaultId || !keyId) {
    throw new Error(
      (vaultId
        ? "simple-balance:kmsVaultOcid is set but simple-balance:kmsKeyOcid is not"
        : "simple-balance:kmsKeyOcid is set but simple-balance:kmsVaultOcid is not") +
        ". Both are needed: every Key Management call goes to the vault's own management " +
        "endpoint, so the key cannot be looked up — or checked — without it. Set both, or unset " +
        "both and the volumes keep Oracle's own key, which is what every stack that sets nothing " +
        "gets and is already encryption at rest.",
    );
  }
  return { vaultId, keyId };
}

/** What `oci.kms.getKey` answers, cut to what the check below reads. */
export interface OciKeyFacts {
  state: string;
  algorithm: string;
  protectionMode: string;
}

/**
 * The key, refused unless the Block Volume service can use it, at plan time.
 *
 * Oracle's lock-out is the opposite of AWS's and both directions are worth
 * knowing. Here a key in PENDING_DELETION makes everything it encrypted
 * *immediately* inaccessible — loud, at once, and reversible by cancelling the
 * deletion. There is also a permanent way back that AWS has no equivalent of: a
 * volume can be moved off a customer key and onto Oracle's in place, with
 * `oci bv volume-kms-key delete` and `oci bv boot-volume-kms-key delete`. The
 * order is the part that catches people, because a key in PENDING_DELETION
 * "can't be assigned or unassigned to any resources" — so cancel the deletion
 * first, then unassign, then schedule it again. Getting that backwards means
 * waiting out a thirty-day window nobody had to wait out.
 *
 * AES rather than RSA because Oracle says so of the service, not of the key:
 * "the Block Volume service does not support encrypting volumes with keys
 * encrypted using the RSA algorithm... you must use keys encrypted using the
 * AES algorithm". Without this check that is a launch failure with a message
 * about the key, after the network has been built.
 */
export function requireUsableKmsKey(keyId: string, facts: OciKeyFacts): string {
  if (facts.state !== "ENABLED") {
    throw new Error(
      `simple-balance:kmsKeyOcid names a key whose state is ${facts.state}, not ENABLED. ` +
        "Anything encrypted by a key in PENDING_DELETION is inaccessible from the moment it is " +
        "scheduled, so this would build a deployment that cannot read its own disks. Cancel the " +
        "deletion or re-enable the key in the console, or unset simple-balance:kmsKeyOcid and " +
        "simple-balance:kmsVaultOcid to keep Oracle's own key.",
    );
  }
  if (facts.algorithm !== "AES") {
    throw new Error(
      `simple-balance:kmsKeyOcid names an ${facts.algorithm} key. The Block Volume service ` +
        "encrypts volumes with AES keys only, so an RSA or ECDSA key is refused here rather than " +
        "at the launch that fails after the network has been built.",
    );
  }
  return keyId;
}

/**
 * What to say about a key that is billed, once rather than in a document
 * somebody may not have read.
 *
 * `protectionMode` defaults to HSM when a key is created without naming one, it
 * cannot be changed afterwards, and HSM key versions are billed per version
 * where software ones are free. A stack the allowance otherwise covers — one
 * machine, with `databaseNode: false` — is $0, so this is the first thing in
 * the profile that can take it off $0, and does it silently and permanently.
 * A warning rather than a refusal: an operator may want HSM, and a program that
 * refused it would be making somebody's compliance decision for them.
 */
export function hsmKeyWarning(facts: OciKeyFacts): string | undefined {
  if (facts.protectionMode !== "HSM") return undefined;
  return (
    "simple-balance:kmsKeyOcid names an HSM-protected key. HSM key versions are billed per " +
    "version and software-protected ones are not, and a key's protection mode cannot be changed " +
    "after it is created — so an Always Free stack that was $0 is no longer $0, and the only way " +
    "back is a different key, which means replacing the volumes. If that was not deliberate, make " +
    "a key with protection mode SOFTWARE and point this at that one before the first pulumi up."
  );
}

// ---------------------------------------------- the settings vault's endpoint ---

/** Whether a DNS name exists yet, asked somewhere that will not remember a no. */
export type NameExists = (host: string) => Promise<boolean>;

/**
 * Waits for a new vault's management endpoint to exist in DNS.
 *
 * OCI reports a vault ACTIVE minutes before it publishes the per-vault hostname
 * every Key Management call goes to, so creating the key straight away fails
 * with `dial tcp: lookup …-management.kms…: no such host`. The retry is worse
 * than the failure: the resolver that answered no — the operator's router,
 * then macOS's own cache — keeps that answer for the zone's negative TTL,
 * 300 seconds, after the name exists, so the next `pulumi up` fails the same
 * way. Hence `exists` asks OCI's own nameservers rather than the machine's
 * resolver: the first lookup the provider makes is then one that succeeds, and
 * nothing on the way has a no to remember.
 */
export async function waitForDnsName(
  host: string,
  exists: NameExists,
  {
    timeoutMs = 15 * 60_000,
    intervalMs = 10_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (!(await exists(host))) {
    if (now() >= deadline) {
      throw new Error(
        `${host}, the settings vault's management endpoint, is still not in DNS ` +
          `${Math.round(timeoutMs / 60_000)} minutes after the vault became active. ` +
          "Run pulumi up again once it resolves: the vault is kept, and the key is created then.",
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * A {@link NameExists} that asks the zone's authoritative nameservers.
 *
 * The nameservers are found through the ordinary resolver, which is safe:
 * they are long-lived names it already has, not the new one. The question about
 * the new name goes to them directly, from a resolver of its own that caches
 * nothing. Any failure is a "not yet", and the deadline above is what ends it.
 */
export function authoritativeNameExists(): NameExists {
  return async (host) => {
    const { Resolver, resolveNs, resolve4 } = await import("node:dns/promises");
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const zone = labels.slice(i).join(".");
      let servers: string[];
      try {
        servers = await resolveNs(zone);
      } catch {
        continue;
      }
      const addresses = (
        await Promise.all(servers.map((ns) => resolve4(ns).catch(() => [])))
      ).flat();
      if (addresses.length === 0) return false;
      const resolver = new Resolver({ timeout: 5_000, tries: 2 });
      resolver.setServers(addresses);
      try {
        await resolver.resolveCname(host);
        return true;
      } catch {
        return resolver.resolve4(host).then(
          (found) => found.length > 0,
          () => false,
        );
      }
    }
    return false;
  };
}
