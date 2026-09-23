import { cloudInit, ociMetadata } from "../single-common/cloud-init";
import type { MachineSettings, Size } from "../single-common/cloud-init";

/**
 * What `./index.ts` decides about Oracle Cloud that is not a resource: the disk
 * floor, which availability domain, the key, and the metadata the instance is
 * launched with.
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
): Record<string, string> {
  return ociMetadata(
    cloudInit({ settings, dataDevice: DATA_DEVICE, platformCommands: PLATFORM_COMMANDS }),
    sshPublicKey,
  );
}
