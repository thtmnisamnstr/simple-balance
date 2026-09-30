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

// ------------------------------------------------- the customer-managed key ---

/**
 * What `aws.kms.getKey` answers about a key, cut to what the check below reads.
 *
 * A shape of its own rather than the provider's result type, so the rule can be
 * run without `@pulumi/pulumi`: the same split as `requireDataVolumeDomain` in
 * `../oci-single/platform.ts`, and for the same reason — the repository's tests
 * exercise the refusal itself rather than a paraphrase of it.
 */
export interface KmsKeyFacts {
  keyState: string;
  keyManager: string;
  keySpec: string;
  keyUsage: string;
}

/**
 * The key, refused unless it is one EBS can actually use, at plan time.
 *
 * This one lookup is the whole of the lock-out guard that a program can offer,
 * and it is worth the API call because of what the alternative looks like. A
 * disabled or pending-deletion key has *no immediate effect* on a running
 * instance: EBS encrypts disk I/O with the data key, which lives in the Nitro
 * card for as long as the volume stays attached. The failure lands on the next
 * detach and reattach — a stop/start, a resize, an instance replacement — which
 * may be weeks later and may be after the deletion window has closed, at which
 * point AWS says plainly that the data is unrecoverable and that a new key with
 * the same key material will not decrypt it either. So a key that is on its way
 * out has to be refused now, while refusing still costs nothing.
 *
 * Each condition is one EBS states rather than one invented here. Symmetric
 * because "Amazon EBS supports only symmetric KMS keys"; ENCRYPT_DECRYPT
 * because a SIGN_VERIFY key is symmetric-shaped and useless for a volume;
 * CUSTOMER because an AWS-managed key cannot be named in `kmsKeyId` for
 * somebody else's volume and the operator who typed `alias/aws/ebs` here meant
 * to leave the setting unset.
 */
export function requireUsableKmsKey(keyArn: string, facts: KmsKeyFacts): string {
  const how =
    "aws kms describe-key --key-id " +
    keyArn +
    " shows it. To leave the key to AWS instead, which is what every stack that " +
    "sets nothing gets: pulumi config rm simple-balance:kmsKeyArn";
  if (facts.keyState !== "Enabled") {
    throw new Error(
      `simple-balance:kmsKeyArn names a key whose state is ${facts.keyState}, not Enabled. ` +
        "A volume encrypted with a disabled key goes on serving until it is next detached and " +
        "then refuses to attach at all, and a key whose deletion window closes takes the volume " +
        "with it for good — so it is refused here rather than at the reboot. " +
        "aws kms enable-key, or aws kms cancel-key-deletion, brings it back while the window is " +
        `open. ${how}`,
    );
  }
  if (facts.keyManager !== "CUSTOMER") {
    throw new Error(
      `simple-balance:kmsKeyArn names an ${facts.keyManager}-managed key. AWS-managed keys ` +
        "(alias/aws/ebs and the rest) cannot be given to a volume by name — AWS chooses them " +
        `itself when no key is named, which is what unsetting this does. ${how}`,
    );
  }
  if (facts.keySpec !== "SYMMETRIC_DEFAULT" || facts.keyUsage !== "ENCRYPT_DECRYPT") {
    throw new Error(
      `simple-balance:kmsKeyArn names a ${facts.keySpec} key for ${facts.keyUsage}. EBS supports ` +
        "only symmetric encryption keys — SYMMETRIC_DEFAULT with ENCRYPT_DECRYPT — and an " +
        "asymmetric one fails at the volume's creation rather than here without this check. " +
        `${how}`,
    );
  }
  return keyArn;
}

/**
 * The one line of configuration that can turn into a deleted ledger, refused
 * until the operator has said in the stack that there is nothing there to
 * delete.
 *
 * `kms_key_id` is ForceNew on an EBS volume: a key added to a stack whose
 * volumes already exist is a *replacement*, an empty volume where the ledger
 * was. Pulumi's `protect` refuses that, which is why it is the default — and
 * why the guard cannot be built on it. **`protect` is a flag in the state
 * snapshot, not in the stack config**, and this repository documents a
 * supported way to clear the one while leaving the other saying `true`:
 * `pulumi state unprotect <urn>`, which `deploy/pulumi/README.md` gives as the
 * way to let a single destroy through. A guard that read
 * `simple-balance:protectDataVolume` would return happily in exactly that
 * state, the volume would diff on a ForceNew property against a snapshot that
 * says unprotected, and Pulumi would go ahead. `protectDataVolume: false` was
 * never the only dangerous state; it was one of two, and the other one is
 * invisible from the config.
 *
 * So the question this asks is the one that actually decides the outcome — are
 * these volumes about to be *created*, or do they exist? — and it asks the
 * operator, because the program cannot find out. `aws.ebs.getVolume` errors
 * when it matches nothing, which is every first `pulumi up`, so a lookup would
 * refuse the case it was added to allow; and a lookup that found volumes could
 * not tell a stack setting the key for the first time from the every-day `up`
 * of a stack that has had it since it was built.
 *
 * `simple-balance:kmsKeyArnIsNewStack` is therefore a statement about *when*
 * the key was set rather than a switch, and it stays true for the life of the
 * stack: the volumes do not exist yet, or they were already created with this
 * key. Both are the same claim — that this `up` changes no volume's key — which
 * is why a stack already built with one sets it and plans nothing. It costs a
 * first-time operator one extra line and it costs an existing deployment a
 * refusal it can read, which is the trade: the message carries the
 * migration, which is a snapshot copy and not a `pulumi up` at all — AWS is
 * explicit that the key on an existing volume cannot be changed, only carried
 * into a copy.
 *
 * Additive, and nothing that exists is affected: every stack with no
 * `kmsKeyArn` returns on the first line, which is every stack built before this
 * setting existed.
 */
export function requireNewStackForKmsKey(keyArn: string, isNewStack: boolean): void {
  // Trimmed here as well as at the call, because "unset" and "a space" have to
  // mean the same thing in the one function whose answer decides whether a
  // ledger can be replaced.
  if (!keyArn.trim() || isNewStack) return;
  throw new Error(
    "simple-balance:kmsKeyArn is set. A volume's key is fixed when the volume is created, so " +
      "naming one on a stack whose volumes already exist asks AWS to replace them — an empty " +
      "volume where the ledger was, taking the generated secret, env.local and every backup with " +
      "it. Pulumi's protection usually refuses that, but it is a flag in the state snapshot " +
      "rather than in this config: `pulumi state unprotect` clears it for one destroy, and " +
      "simple-balance:protectDataVolume false clears it outright. Neither is visible from here, " +
      "so this asks instead.\n" +
      "  On a stack whose volumes have not been created yet, and on one whose volumes were " +
      "already created with this same key: pulumi config set " +
      "simple-balance:kmsKeyArnIsNewStack true, then pulumi up. Either way nothing is " +
      "replaced, and `pulumi preview` proves it: check it says create, or no change, and " +
      "never replace, for both aws:ebs/volume resources before you run it.\n" +
      "  On a stack that already holds data: the key cannot be changed in place on either volume. " +
      "Stop the deployment, ec2 create-snapshot each volume, ec2 copy-snapshot --kms-key-id <the " +
      "new key>, ec2 create-volume from each copy, attach them at /dev/sdf, and import them into " +
      "the stack. Nothing is destroyed in that order, and none of it is a pulumi up.\n" +
      "  To stay on the AWS-managed key, which is already encryption at rest: " +
      "pulumi config rm simple-balance:kmsKeyArn",
  );
}

// ------------------------------------------- the database node's way out ---

/** How the database node reaches the internet. `./index.ts` builds each one. */
export type DatabaseEgress = "nat" | "ipv6";

/**
 * Which way out the stack asked for, refused unless it is one that works.
 *
 * `nat` is the default and is what every existing stack has: a NAT gateway at
 * roughly $36.50 a month on this cloud, which is 38% of a `small` bill and the
 * single largest line in it. It is the default because it is the only one that
 * covers all three things this machine reaches — Ubuntu's archive, the image
 * registry, and Session Manager — with no trade at all.
 *
 * `ipv6` is free, genuinely and not nearly: an Amazon-provided IPv6 block costs
 * nothing, and an egress-only internet gateway has neither an hourly charge nor
 * a per-gigabyte one. It is not a saving without a cost, and the cost is paid
 * in three places rather than in dollars.
 *
 *   The shell. Session Manager resolves `ssm.<region>.amazonaws.com`, which is
 *   A-only, and this subnet has no IPv4 route once the gateway is gone, so the
 *   database node's own agent reaches nothing. What replaces it is a port
 *   forward through the *application* node's agent to 22 on the database node,
 *   which keeps the operator's private key on their laptop where it belongs and
 *   needs no open port anywhere — but it is ssh, and ssh needs a key, which is
 *   why this refuses without one rather than leaving somebody one `pulumi up`
 *   away from having no way onto the machine holding the ledger. Two SSM
 *   interface endpoints would keep the direct shell, at $14.60 a month, which
 *   is a smaller bill and not a free one.
 *
 *   The mirror. `<region>.ec2.archive.ubuntu.com` publishes no AAAA record, so
 *   the database node's sources are rewritten to `archive.ubuntu.com`, which
 *   has had one since 2013. That is Canonical's global archive instead of the
 *   in-region one: further away, and outside AWS's network.
 *
 *   The registry. Docker Hub publishes AAAA on `registry-1.docker.io` and
 *   Cloudflare's blob host is dual-stack, so the `postgres:18` pull works — but
 *   it works because of somebody else's DNS records, and if they go the failure
 *   is a first boot that hangs with nothing in the log about the network.
 *
 * Two other free answers are not offered, and it is worth saying why rather
 * than leaving them to be rediscovered. An **S3 gateway endpoint** is free and
 * does nothing here: it diverts traffic to S3's own prefix list, and Canonical
 * retired its S3-backed mirrors in favour of the EC2 ones while Docker Hub's
 * blobs are on Cloudflare R2. It is the first thing anybody suggests and it
 * helps neither apt nor the image. A **NAT instance on the application node**
 * is free and covers everything, and it makes the internet-facing machine the
 * router for the machine holding the ledger — and it carries a first-boot race
 * that no `dependsOn` can close, because `dependsOn` proves the application
 * instance reached `running` and not that its cloud-init installed the
 * forwarding rule, while the database node's first act is `apt-get update`.
 * Selling a race condition as a saving is worse than the $36.50.
 */
export function readDatabaseEgress(
  value: string | undefined,
  sshPublicKey: string,
): DatabaseEgress {
  // Blank is unset, not a third value. `pulumi config set ... ""` and a key
  // left empty in a stack file both arrive here as "", and refusing them would
  // be refusing a stack that asked for nothing — which is the one case that has
  // to keep building exactly what it built before this setting existed.
  const wanted = (value ?? "").trim() || "nat";
  if (wanted !== "nat" && wanted !== "ipv6") {
    throw new Error(
      `simple-balance:databaseEgress is "${wanted}"; it is nat or ipv6. nat is the default and ` +
        "costs about $36.50 a month; ipv6 is free and gives up the Session Manager shell on the " +
        "database node, which SSH from the application node replaces.",
    );
  }
  if (wanted === "ipv6" && !sshPublicKey) {
    throw new Error(
      "simple-balance:databaseEgress is ipv6, which takes Session Manager away from the database " +
        "node: its agent resolves an IPv4-only endpoint and this subnet would have no IPv4 route. " +
        "A port forward through the application node's agent to ssh on the database node replaces " +
        "it, and ssh needs a key, so set one first — " +
        'pulumi config set simple-balance:sshPublicKey "$(cat ~/.ssh/id_ed25519.pub)" — or leave ' +
        "simple-balance:databaseEgress unset and keep the NAT gateway. Without a key this setting " +
        "would leave no way at all onto the machine holding the ledger.\n" +
        "  On a stack whose machines already exist, set the key on its own and run `pulumi up` " +
        "before you set this. EC2 has no API to give a running instance a key pair, so the key " +
        "arrives as `keyName` on a *new* machine: both instances plan a replacement, and the " +
        "database node is deleted before its replacement is made because its private address is " +
        "pinned. The data volumes are separate protected resources and first boot reformats " +
        "nothing it finds a filesystem on, so the ledger survives — but it is two rebuilds of " +
        "downtime, and it should not arrive as a surprise inside a change about routing.",
    );
  }
  return wanted;
}

/**
 * A /64 out of the /56 AWS hands a VPC, by index.
 *
 * Written here rather than taken from a library because there is no `cidrsubnet`
 * in this program's world and the arithmetic is small: a /56 fixes the first
 * three hextets and the high byte of the fourth, so a /64 inside it is that
 * prefix with the fourth hextet's low byte set to the index. Indices run 0-255.
 *
 * Parsed rather than string-spliced, because AWS returns the compressed form —
 * `2600:1f18:2d35:d500::/56` — and a stack whose block happens to compress
 * differently would otherwise get a subnet in somebody else's range.
 */
export function ipv6SubnetCidr(vpcCidr: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`An IPv6 subnet index is 0-255. Got ${index}.`);
  }
  const [block, prefix] = vpcCidr.split("/");
  if (prefix !== "56" || !block) {
    throw new Error(
      `A VPC's Amazon-provided IPv6 block is a /56. Got "${vpcCidr}", which this program cannot ` +
        "cut a /64 out of.",
    );
  }
  const [head = "", tail = ""] = block.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [
    ...headGroups,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...tailGroups,
  ];
  if (groups.length !== 8) {
    throw new Error(`"${vpcCidr}" is not an IPv6 block this program can read.`);
  }
  const fourth = Number.parseInt(groups[3]!, 16);
  if (!Number.isFinite(fourth)) {
    throw new Error(`"${vpcCidr}" is not an IPv6 block this program can read.`);
  }
  const subnetGroup = ((fourth & 0xff00) | index).toString(16).padStart(4, "0");
  return `${groups[0]}:${groups[1]}:${groups[2]}:${subnetGroup}::/64`;
}

/**
 * The one boot command the `ipv6` option needs, and the reason it is a boot
 * command rather than anything later.
 *
 * `<region>.ec2.archive.ubuntu.com` has no AAAA record, so on a machine whose
 * only route out is IPv6 the very first `apt-get update` hangs — before
 * `runcmd`, before the first-boot script, before anything this program could
 * otherwise run. cloud-init's `bootcmd` is the only stage earlier than
 * `package_update`.
 *
 * Both file layouts are rewritten because Ubuntu 24.04 moved the archive to
 * deb822 at `/etc/apt/sources.list.d/ubuntu.sources` and an image built either
 * side of that move is a machine that boots or does not. `|| true` because an
 * unmatched glob is itself in POSIX sh and sed would fail on it, and a failed
 * bootcmd stops cloud-init before the database exists.
 */
export const IPV6_APT_REWRITE =
  '["/bin/sh", "-c", "sed -i -E \'s#https?://[a-z0-9-]+[.]ec2[.]archive[.]ubuntu[.]com/ubuntu#http://archive.ubuntu.com/ubuntu#g\' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true"]';
