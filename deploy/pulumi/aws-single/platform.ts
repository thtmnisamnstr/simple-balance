import { awsUserDataBase64, cloudInit, databaseCloudInit } from "../single-common/cloud-init";
import type {
  ApplicationDatabase,
  DatabaseCloudInitArgs,
  MachineSettings,
} from "../single-common/cloud-init";

/**
 * What `./index.ts` sends the EC2 instance, apart from the program and with no
 * Pulumi import, so the repository's tests can render it exactly as a
 * `pulumi up` would. `../oci-single/platform.ts` is the same split.
 */

/**
 * The data volume's device, built from the volume's own id.
 *
 * Not /dev/sdf, and not /dev/nvme1n1. Nitro instances present every EBS volume
 * as an NVMe device numbered in attachment order, so the name the attachment
 * asks for is not the name the kernel uses, and the number depends on what
 * happened to be attached first. A boot that guesses would eventually guess
 * wrong and format the root disk. Ubuntu's AMI ships udev rules that create
 * this by-id symlink, which names the volume itself and cannot be confused with
 * another one.
 */
export function dataDevice(volumeId: string): string {
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace(/-/g, "")}`;
}

/**
 * An id of the length EBS issues, for measuring the user data before the
 * volume exists. The real one is only known once the volume is created, and a
 * size check that waited for it would fail after the network had been built.
 */
export const PLACEHOLDER_VOLUME_ID = "vol-0123456789abcdef0";

/** The instance's `userDataBase64`: the cloud-init, gzipped, checked against EC2's cap. */
export function userDataBase64(
  settings: MachineSettings,
  volumeId: string,
  database?: ApplicationDatabase,
): string {
  return awsUserDataBase64(cloudInit({ settings, dataDevice: dataDevice(volumeId), database }));
}

/** The database instance's `userDataBase64`, measured against the same cap. */
export function databaseUserDataBase64(
  args: Omit<DatabaseCloudInitArgs, "dataDevice">,
  volumeId: string,
): string {
  return awsUserDataBase64(databaseCloudInit({ ...args, dataDevice: dataDevice(volumeId) }));
}

/**
 * Amazon's own internal DNS name for an instance at a given private address,
 * which is what the database node's certificate is issued for.
 *
 * Known before the instance exists, because the program pins the address — and
 * that is the whole reason the address is pinned. The VPC has
 * `enableDnsSupport` and `enableDnsHostnames`, so the Amazon-provided resolver
 * answers this name for an instance in the VPC, and Docker's embedded resolver
 * forwards to it. No Route 53 private zone is needed and none is created.
 *
 * us-east-1 is a real exception rather than a tidy-up: every other region spells
 * it `ip-10-20-1-10.<region>.compute.internal`, and us-east-1 alone spells it
 * `ip-10-20-1-10.ec2.internal`. Getting it wrong there produces a certificate
 * whose SAN is a name that resolves nowhere, and the symptom is
 * `ENOTFOUND` at the first connection rather than a verification error, which
 * reads like a network fault.
 */
export function databaseHost(privateIp: string, region: string): string {
  const label = `ip-${privateIp.replace(/\./g, "-")}`;
  return region === "us-east-1" ? `${label}.ec2.internal` : `${label}.${region}.compute.internal`;
}

/**
 * The region, which has to be written in the stack.
 *
 * `aws.config.region` does not insist: with `aws:region` unset it takes
 * AWS_REGION or AWS_DEFAULT_REGION from the shell, and the provider records
 * that value as if the stack had said it. So the stack would build wherever
 * the shell running `pulumi up` happened to point, and version 7 of the
 * provider records a region on every resource, so an existing stack run from a
 * shell pointed elsewhere plans to replace every one of them in the other
 * region — the data volume included, with the secret, env.local and the backups
 * on it. Where a machine holding somebody's data runs is a decision, and it
 * belongs with the stack's other decisions rather than in one laptop's
 * environment. Set in the stack, it also wins over both variables.
 *
 * Refused rather than defaulted, because no region is right for everybody, and
 * any region is accepted for the same reason. The message says what a stack
 * built before this was required should set: the region the provider recorded
 * then, which set again in the stack changes nothing.
 */
export function requireRegion(region: string | undefined): string {
  if (!region?.trim()) {
    throw new Error(
      "aws:region is required, in this stack: pulumi config set aws:region <region>, for example " +
        "us-west-2. Unset, the provider takes AWS_REGION or AWS_DEFAULT_REGION from the shell running " +
        "`pulumi up`, so where the machine and its data volume live would depend on the shell rather " +
        "than the stack, and a shell pointed at another region would plan to replace every resource " +
        "there. A stack that was built before this was required is in the region it was built in, " +
        "which `pulumi stack output shell` names after --region: set that one, never another.",
    );
  }
  return region;
}
