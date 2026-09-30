import { cloudInit, databaseCloudInit, ociMetadata } from "../single-common/cloud-init";
import type {
  ApplicationDatabase,
  DatabaseCloudInitArgs,
  MachineSettings,
  Size,
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
 * OCI's smallest block volume. The shared table's `small` asks for 20, which
 * EBS accepts and CreateVolume refuses, so it is raised here rather than in
 * `SIZES`, which the AWS program and `docs/deployment-sizing.md` also read.
 */
export const MIN_VOLUME_GB = 50;

export function dataVolumeGb(size: Size): number {
  return Math.max(size.dataGib, MIN_VOLUME_GB);
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
      "env.local and every backup on it would go with the old one, so neither the machine nor " +
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

/** The instance's metadata, compressed and checked against OCI's ceiling. */
export function instanceMetadata(
  settings: MachineSettings,
  sshPublicKey: string,
  database?: ApplicationDatabase,
): Record<string, string> {
  return ociMetadata(
    cloudInit({
      settings,
      dataDevice: DATA_DEVICE,
      platformCommands: PLATFORM_COMMANDS,
      database,
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
