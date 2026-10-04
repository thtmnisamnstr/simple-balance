import { awsUserDataBase64, cloudInit, databaseCloudInit } from "../single-common/cloud-init";
import type {
  ApplicationDatabase,
  DatabaseCloudInitArgs,
  MachineSettings,
  SettingsSource,
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
function dataDevice(volumeId: string): string {
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace(/-/g, "")}`;
}

/**
 * An id of the length EBS issues, for measuring the user data before the
 * volume exists. The real one is only known once the volume is created, and a
 * size check that waited for it would fail after the network had been built.
 */
export const PLACEHOLDER_VOLUME_ID = "vol-0123456789abcdef0";

/**
 * The AWS CLI the application node reads its settings with, in Amazon's own
 * published image. Pinned for the reason `../oci-single/platform.ts` gives for
 * its own; it publishes linux/arm64, which the Graviton types need.
 */
export const AWS_CLI_IMAGE = "public.ecr.aws/aws-cli/aws-cli:2.37.9";

/** The instance's `userDataBase64`: the cloud-init, gzipped, checked against EC2's cap. */
export function userDataBase64(
  settings: MachineSettings,
  volumeId: string,
  database?: ApplicationDatabase,
  settingsSource?: SettingsSource,
): string {
  return awsUserDataBase64(
    cloudInit({ settings, dataDevice: dataDevice(volumeId), database, settingsSource }),
  );
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
 * region — the data volume included, with the secret and the backups
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
      "volume where the ledger was, taking the generated secret and every backup with " +
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
export type DatabaseEgress = "nat" | "ipv6" | "ssm";

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
 *   away from having no way onto the machine holding the ledger. `ssm` below is
 *   the option that buys the direct shell back.
 *
 *   The mirror. The database node's sources are rewritten to
 *   `archive.ubuntu.com`, away from `<region>.ec2.archive.ubuntu.com`. That is
 *   Canonical's global archive instead of the in-region one: further away, and
 *   outside AWS's network. The rewrite was written because the in-region mirror
 *   published no AAAA record; it publishes one now — checked 2026-09-30 in
 *   us-east-1, us-west-2 and eu-west-1, against three resolvers — so the rewrite
 *   now buys an out-of-region hop for nothing. It is kept anyway, and kept
 *   deliberately: dropping it changes what every existing `ipv6` stack does at
 *   the one moment there is no way to watch it, and the fact that would justify
 *   dropping it is a record in somebody else's DNS that can go back. What is
 *   *not* kept is the sentence claiming the record does not exist.
 *
 *   The registry. Docker Hub publishes AAAA on `registry-1.docker.io` and
 *   Cloudflare's blob host is dual-stack, so the `postgres:18` pull works — but
 *   it works because of somebody else's DNS records, and if they go the failure
 *   is a first boot that hangs with nothing in the log about the network.
 *
 * `ssm` is `ipv6` plus two interface VPC endpoints, and the "plus" is the whole
 * of the design rather than a detail of it. It costs $14.60 a month in
 * us-east-1 and us-west-2 — two endpoints at $0.01 an endpoint-hour, from the
 * `VpcEndpoint-Hours` line of AWS's own published price list — and it keeps
 * `pulumi stack output databaseShell` a plain `aws ssm start-session`, so the
 * machine holding the ledger keeps the shell that needs no key and no open
 * port. That is $21.90 a month less than the NAT gateway.
 *
 *   The endpoints alone would build a machine that cannot finish booting, and
 *   that is why this option is never the endpoints alone. A VPC endpoint
 *   reaches AWS services and nothing else, and neither of the two things this
 *   node fetches at first boot is an AWS service:
 *   `<region>.ec2.archive.ubuntu.com` resolves into AWS's *EC2* prefix rather
 *   than its S3 one, so an S3 gateway endpoint diverts none of apt, and Docker
 *   Hub's blobs are on Cloudflare at an address in no AWS range at all. On
 *   endpoints alone the machine reaches `running`, Session Manager works, apt
 *   times out, `docker.io` never installs, `postgres:18` is never pulled, and
 *   there is no database — the cruellest possible shape of the bug, because the
 *   shell that was paid for is the one thing that answers. So the IPv6 half is
 *   not a companion setting an operator can forget: `./index.ts` builds it from
 *   this one value, and there is no spelling of the stack that asks for one
 *   without the other.
 *
 *   Two endpoints and not three. `com.amazonaws.<region>.ssm` carries the
 *   heartbeat and the registration, without which `start-session` answers
 *   `TargetNotConnected`; `com.amazonaws.<region>.ssmmessages` carries the
 *   session's data channel. `ec2messages` is the third that older documentation
 *   asks for, and it is not needed: from SSM Agent 3.3.40.0 the agent uses
 *   `ssmmessages` whenever it is available, regions launched from 2024 support
 *   only `ssmmessages`, and AWS is retiring the `ec2messages` endpoint on
 *   2026-09-30. Adding it out of caution would be $7.30 a month for a service
 *   being switched off, so the number an operator is told is $14.60 and not
 *   $21.90.
 *
 *   *Both* hours are regional, and that is the trap rather than the endpoint's
 *   being so. The endpoint is $0.0100 in us-east-1 and us-west-2, $0.0110 in
 *   eu-west-1 and ca-central-1, $0.0120 in eu-central-1, $0.0130 in ap-south-1
 *   and ap-southeast-2 and $0.0210 in sa-east-1. But `NatGateway-Hours` moves
 *   further over the same span — $0.045 in the US against $0.093 in sa-east-1 —
 *   so the saving *grows* outside the US instead of shrinking. Two endpoints in
 *   sa-east-1 are $30.66 against a gateway that costs $71.54 there: $40.88 a
 *   month, and priced across all 34 commercial regions it is the largest saving
 *   this setting offers anywhere — while $21.90, the US figure, is the
 *   *smallest*. This comment said the opposite, because it subtracted a
 *   regional endpoint price from the US gateway price;
 *   `docs/deployment-costs.md` now prints both columns region by region. Data
 *   processing is $0.01/GB and rounds to nothing here:
 *   the agent's heartbeat is a few kilobytes every five minutes, which is well
 *   under a gigabyte a month for both machines.
 *
 *   It needs no SSH key, and that is not a convenience. Requiring one is what
 *   makes `ipv6` a two-machine rebuild on a stack that already exists, because
 *   EC2 has no API to give a running instance a key pair. `ssm` keeps the
 *   agent, so it needs no replacement shell, so it needs no key, so it asks for
 *   nothing that plans a replacement.
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
 *
 * A third is not offered *yet*, and it would make `ssm` free rather than
 * cheap. `ssm.<region>.api.aws` and `ssmmessages.<region>.api.aws` are the
 * dual-stack spellings of the same services and both answer AAAA — checked in
 * us-east-1 — and SSM Agent takes `Ssm.Endpoint` and `Mgs.Endpoint` overrides,
 * so plain `ipv6` could keep the direct shell for nothing. It is not shipped
 * because it has not been proven on a real instance: Ubuntu installs the agent
 * as a snap, so the configuration is under `/var/snap/amazon-ssm-agent/current/`
 * rather than `/etc/amazon/ssm/`, and `ec2messages.<region>.api.aws` resolves
 * to nothing at all, so there is no fallback if the override is wrong. An
 * option whose failure is a machine with no shell is one to measure before
 * offering, not after.
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
  if (wanted !== "nat" && wanted !== "ipv6" && wanted !== "ssm") {
    throw new Error(
      `simple-balance:databaseEgress is "${wanted}"; it is nat, ipv6 or ssm. nat is the default ` +
        "and costs about $36.50 a month; ssm costs about $14.60 a month in us-east-1 and keeps " +
        "the Session Manager shell on the database node; ipv6 is free and gives up that shell, " +
        "which SSH from the application node replaces.",
    );
  }
  // Only `ipv6`, and never `ssm`. `ssm` buys the agent's own shell back with
  // the two interface endpoints, so it has no replacement shell to arrange and
  // nothing to refuse for — and demanding a key it does not need is not a
  // harmless extra safeguard on a stack that already has machines: the key can
  // only arrive as `keyName` on a new instance, so it would plan the two
  // rebuilds described below for a setting that never uses it.
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
 * Whether the database node's way out is the IPv6 one, which is both of the
 * options that are not a NAT gateway.
 *
 * One predicate rather than six comparisons, and the reason is what a missed
 * one does. The IPv6 network is six properties spread across four resources —
 * the VPC's generated block, the egress-only gateway, the subnet's /64, the
 * subnet's auto-assign, the instance's address, and the apt rewrite that has to
 * run before the first `apt-get` — and `ssm` needs every one of them, because
 * the interface endpoints reach AWS and nothing else. A site left reading
 * `=== "ipv6"` would not fail a plan or a `pulumi up`: it would build a machine
 * that comes up, answers a shell through the endpoints, and never installs
 * Docker, which is the exact failure this option exists to refuse. So the
 * question is asked in one place and the answer is spent in six.
 *
 * What deliberately does *not* read this: the NAT gateway and its address,
 * which ask `=== "nat"`; the SSH rule on the database node's security group,
 * which exists only to replace a shell `ssm` still has; and the shell command
 * itself. Under `ssm` the agent works, so there is nothing to replace and no
 * port to open.
 */
export const databaseUsesIpv6 = (egress: DatabaseEgress): boolean =>
  egress === "ipv6" || egress === "ssm";

/**
 * The two interface endpoints `ssm` builds, by their short service names.
 *
 * `ssm` is the control plane — `UpdateInstanceInformation` and
 * `RegisterManagedInstance` — without which the node never becomes a managed
 * node and `start-session` answers `TargetNotConnected`. `ssmmessages` is the
 * data channel the session itself runs over.
 *
 * `ec2messages` is deliberately absent and `readDatabaseEgress` carries the
 * argument: the agent stopped calling it at 3.3.40.0, regions launched from
 * 2024 never had it, and AWS retires the endpoint on 2026-09-30. A third entry
 * here is $7.30 a month for a service being switched off.
 *
 * `s3` is absent too, and that one is worth a sentence because it is the free
 * one. A gateway endpoint for S3 costs nothing and would let the agent fetch
 * its own updates from AWS's buckets — but Ubuntu ships the agent as a snap, so
 * snapd updates it from Canonical over the IPv6 route this option already
 * builds, and the endpoint would add a route to a table whose whole point is
 * that it has exactly one. Free is not the same as free of moving parts.
 */
export const SSM_SHELL_ENDPOINTS = ["ssm", "ssmmessages"] as const;

/**
 * An interface endpoint's service name, refused unless the service is offered
 * in the zone this stack's subnets landed in.
 *
 * An interface endpoint is an ENI in a subnet, so it can only be placed in a
 * zone the service is offered in, and AWS does not offer every service in every
 * zone of every region — us-east-1 is the well-known case. This program names
 * no availability zone: it takes whichever one AWS gave the first subnet and
 * pins the second to it. So a stack can be unlucky, and what AWS answers is a
 * raw error at the endpoint naming neither the setting that asked for it nor
 * the ways out of it. This says both.
 *
 * **When it arrives is not the same on both kinds of stack, and the difference
 * is worth stating rather than rounding up to "plan time".** The zone comes
 * from `databaseSubnet.availabilityZone`, so:
 *
 *   On a stack whose subnets already exist — the `nat` stack being switched
 *   over, which is the upgrade path — the zone is in state, both it and the
 *   service's `availabilityZones` resolve during `pulumi preview`, and the
 *   preview itself fails. Nothing is touched.
 *
 *   On a stack with no subnet yet, that Output is *unknown* at preview, and
 *   Pulumi does not run an `apply` callback over an unknown. The preview is
 *   therefore clean and the refusal arrives during `pulumi up`, at the first
 *   endpoint — after the VPC, both subnets, the gateways and the security
 *   groups, and before either instance or either data volume. What is left is
 *   a network to `pulumi destroy`, which is a cheap thing to lose, and the
 *   message still says what to do instead.
 *
 * `requireUsableKmsKey` above really is plan-time on both, and the difference
 * matters before somebody copies this shape: its invoke reads a config string,
 * so nothing about it waits for a resource to exist.
 *
 * **Pinning the zone is the fix that would make this preview-time everywhere,
 * and it is refused for this release.** Giving `subnet` an explicit
 * `availabilityZone` would make the whole chain config-derived — but the zone a
 * program picks is not the one AWS already gave an existing stack, so it would
 * plan a replacement of both subnets, and with them both instances, on every
 * stack built before it. Trading a discarded empty network for a rebuilt live
 * one is the wrong way round.
 *
 * Consumed as the endpoint's own `serviceName`, the way `requireUsableKmsKey`
 * is consumed as the volumes' `kmsKeyId`, so nothing is registered while it is
 * unresolved and `pulumi up --skip-preview` cannot outrun it.
 *
 * An empty list is treated as "AWS did not say" and allowed through rather than
 * refused. The data source documents `availabilityZones` as unavailable for
 * services in other regions, and a check that turned silence into a refusal
 * would make this option unusable somewhere it works. Allowing it through is
 * never worse than having no check: that stack simply fails where it fails
 * today.
 */
export function requireEndpointZone(
  serviceName: string,
  zone: string,
  zones: readonly string[],
): string {
  if (zones.length === 0 || zones.includes(zone)) return serviceName;
  throw new Error(
    `simple-balance:databaseEgress is ssm, which needs an interface endpoint for ${serviceName} ` +
      `in ${zone} — the availability zone this stack's subnets are in. AWS offers that service ` +
      `in ${zones.join(", ")} and not there, so the endpoint cannot be placed and the database ` +
      "node would have no Session Manager shell.\n" +
      "  This program names no availability zone: it takes the one AWS gives the first subnet, " +
      "so there is nothing to move. Either deploy this stack in another region — aws:region, on " +
      "a stack with no resources yet — or choose a way out that needs no endpoint: " +
      "pulumi config rm simple-balance:databaseEgress keeps the NAT gateway at about $36.50 a " +
      "month, and simple-balance:databaseEgress ipv6 is free and replaces the shell with SSH " +
      "from the application node.",
  );
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
 * The one boot command the IPv6 options need, and the reason it is a boot
 * command rather than anything later.
 *
 * It was written against a fact that has since expired.
 * `<region>.ec2.archive.ubuntu.com` published no AAAA record, so on a machine
 * whose only route out is IPv6 the very first `apt-get update` hung — before
 * `runcmd`, before the first-boot script, before anything this program could
 * otherwise run. cloud-init's `bootcmd` is the only stage earlier than
 * `package_update`, which is why the rewrite lives here and not in
 * `platformCommands`.
 *
 * The mirror publishes AAAA now: checked 2026-09-30 in us-east-1, us-west-2 and
 * eu-west-1 against 1.1.1.1, 8.8.8.8 and 9.9.9.9. So this rewrite is no longer
 * load-bearing, and it is kept rather than dropped for two reasons that are
 * about risk rather than correctness. Dropping it changes what every existing
 * `ipv6` stack does at first boot, which is the one moment nobody is watching
 * and the one failure that leaves no log worth reading. And the fact that would
 * justify dropping it is a record in Canonical's DNS, which can go back as
 * easily as it arrived — `archive.ubuntu.com` has answered AAAA since 2013 and
 * is the safer of the two to depend on.
 *
 * What it costs is honest to state: an out-of-region hop to Canonical's global
 * archive instead of the mirror inside AWS's network, once, at first boot. What
 * it is not is a fix for a problem that still exists. Both IPv6 options run it,
 * `ssm` included, because `ssm` is the same IPv6 path with a shell bolted back
 * on and there is no reason for the two to boot differently.
 *
 * Both file layouts are rewritten because Ubuntu 24.04 moved the archive to
 * deb822 at `/etc/apt/sources.list.d/ubuntu.sources` and an image built either
 * side of that move is a machine that boots or does not. `|| true` because an
 * unmatched glob is itself in POSIX sh and sed would fail on it, and a failed
 * bootcmd stops cloud-init before the database exists.
 */
export const IPV6_APT_REWRITE =
  '["/bin/sh", "-c", "sed -i -E \'s#https?://[a-z0-9-]+[.]ec2[.]archive[.]ubuntu[.]com/ubuntu#http://archive.ubuntu.com/ubuntu#g\' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true"]';
