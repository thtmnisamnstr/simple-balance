import { awsUserDataBase64, cloudInit } from "../single-common/cloud-init";
import type { MachineSettings } from "../single-common/cloud-init";

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
export function userDataBase64(settings: MachineSettings, volumeId: string): string {
  return awsUserDataBase64(cloudInit({ settings, dataDevice: dataDevice(volumeId) }));
}
