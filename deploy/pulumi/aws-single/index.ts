import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as single from "../single-common";

import { PLACEHOLDER_VOLUME_ID, userDataBase64 } from "./platform";

/**
 * Its own Pulumi project, and that is the point rather than an accident of
 * layout.
 *
 * `../aws/` stands up an EKS cluster. Putting a second, unrelated deployment
 * in that program would put both in one stack, where a mistake in either is a
 * `pulumi up` that can destroy the other — and where `pulumi destroy` on the
 * thing you were finished with takes the thing you were not. Two projects, two
 * stacks, two state files, and nothing shared but the module above.
 */

const settings = single.readSingleSettings();
const size = settings.size;

// Measured now, against a volume id of the real length, so user data that
// would not fit EC2's 16 KB refuses at `pulumi preview` rather than after the
// network has been built. The real render below checks again.
userDataBase64(settings, PLACEHOLDER_VOLUME_ID);

const region = aws.config.region;
if (!region) {
  throw new Error("No AWS region. Set one with `pulumi config set aws:region us-west-2`.");
}

const tags = { Project: "simple-balance", Profile: "single", PulumiStack: pulumi.getStack() };
const name = `simple-balance-${pulumi.getStack()}`;

/**
 * Instance types, by what the size table asks for rather than the other way
 * round. Graviton throughout: the images this project runs publish `linux/arm64`
 * and it is the cheaper half of every comparison below.
 */
const instanceTypes: Record<string, string> = {
  // Burstable, and the right answer for a household ledger: the load is a few
  // page views a day with an occasional import, which is precisely the shape
  // a credit balance covers.
  small: "t4g.medium",
  // Not burstable from here up. A deployment busy enough to want four cores is
  // busy enough that running out of credits is a real failure mode.
  medium: "m7g.xlarge",
  large: "m7g.2xlarge",
};
const instanceType = instanceTypes[settings.sizeName]!;

// ---------------------------------------------------------------- network ---

// 10.20.0.0/16 rather than the 10.0.0.0/16 `../aws/` uses, so the two can be
// peered or can coexist in one account without an overlap nobody planned.
const vpc = new aws.ec2.Vpc(name, {
  cidrBlock: "10.20.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: { ...tags, Name: name },
});

const internetGateway = new aws.ec2.InternetGateway(name, {
  vpcId: vpc.id,
  tags: { ...tags, Name: name },
});

// One subnet, one availability zone. Spreading across three would be a claim
// this profile does not make: the machine and its disk are one thing, and a
// second zone with nothing in it costs money and buys nothing. Surviving the
// loss of a zone is what the `ha` profile is for, and the database's own
// resilience is whoever runs it.
const subnet = new aws.ec2.Subnet(name, {
  vpcId: vpc.id,
  cidrBlock: "10.20.0.0/24",
  mapPublicIpOnLaunch: false,
  tags: { ...tags, Name: name },
});

const routeTable = new aws.ec2.RouteTable(name, {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
  tags: { ...tags, Name: name },
});

new aws.ec2.RouteTableAssociation(name, {
  subnetId: subnet.id,
  routeTableId: routeTable.id,
});

/**
 * The firewall, and the whole of it. `docs/deployment-profiles.md` has the same
 * table in prose.
 *
 * Nothing opens 3000. Caddy reaches the application over the Docker network
 * inside the machine, so it has no reason to be reachable from outside, and a
 * rule that opened it would be a second way in that the application's own
 * origin checks do not cover. Nothing opens 5432 either: there is no database
 * here, and the machine connects out to the one DATABASE_URL names.
 */
const securityGroup = new aws.ec2.SecurityGroup(name, {
  vpcId: vpc.id,
  description: "Simple Balance single-profile host",
  ingress: [
    {
      description: "HTTP, for the redirect to HTTPS and the ACME challenge",
      protocol: "tcp",
      fromPort: 80,
      toPort: 80,
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    },
    {
      description: "HTTPS",
      protocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    },
    {
      description: "HTTP/3, which Caddy serves by default and which is UDP",
      protocol: "udp",
      fromPort: 443,
      toPort: 443,
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    },
    // Only when asked for, and `readSingleSettings` refuses 0.0.0.0/0. The
    // default is no SSH at all: the instance role below grants a shell through
    // Session Manager, which needs no open port and no key to lose.
    ...(settings.sshCidr
      ? [
          {
            description: "SSH, from one address",
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: [settings.sshCidr],
          },
        ]
      : []),
  ],
  egress: [
    // Outbound is open, and it has to be: the machine pulls images, reaches
    // Let's Encrypt and its database, and — where an operator configures them —
    // an SMTP relay and Stripe. Narrowing this to a host list would break on the
    // first CDN address change, and the list is not published by either vendor.
    {
      description: "Everything: images, ACME, the database, and any SMTP or Stripe host",
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    },
  ],
  tags: { ...tags, Name: name },
});

// ------------------------------------------------------------------ shell ---

// Session Manager rather than SSH. No port is opened, no key exists to be lost
// or shared, and every session is recorded in CloudTrail against the identity
// that opened it. `aws ssm start-session --target <id>` is the whole of it.
const role = new aws.iam.Role(name, {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
  tags,
});

new aws.iam.RolePolicyAttachment(`${name}-ssm`, {
  role: role.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

const instanceProfile = new aws.iam.InstanceProfile(name, { role: role.name, tags });

// Only where a key was given. Without one, `simple-balance:sshCidr` is refused
// by `readSingleSettings`, so there is never an open port with nothing behind
// it — and with neither set, Session Manager above is the whole answer and this
// resource does not exist.
const keyPair = settings.sshPublicKey
  ? new aws.ec2.KeyPair(name, { publicKey: settings.sshPublicKey, tags })
  : undefined;

// ------------------------------------------------------------- the machine ---

// Canonical's own account. Pinned to 24.04 and arm64; the wildcard is the build
// date, which moves every few weeks and which pinning would turn into a manual
// chore with no security benefit — a newer build is the same release with its
// patches applied.
const ami = aws.ec2.getAmiOutput({
  owners: ["099720109477"],
  mostRecent: true,
  filters: [
    { name: "name", values: ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-arm64-server-*"] },
    { name: "state", values: ["available"] },
  ],
});

const availabilityZone = subnet.availabilityZone;

/**
 * The data disk, separate from the machine's.
 *
 * It holds the generated secret, env.local and the nightly dumps — not the
 * ledger, which is in the database DATABASE_URL names. Separate because the two
 * disks have different lifetimes. A new `size` is not a replacement: EC2 stops
 * the instance, changes its type and starts it again, and this volume grows in
 * place. Replacing the instance — a new image taken by lifting
 * `ignoreChanges`, or `pulumi up --replace` after the machine went wrong —
 * destroys the root volume and leaves this one, and cloud-init formats it only
 * when it is not already a filesystem. So a rebuild keeps all three.
 */
const dataVolume = new aws.ebs.Volume(name, {
  availabilityZone,
  size: size.dataGib,
  // gp3 rather than gp2: the baseline 3,000 IOPS comes with the volume instead
  // of being earned by making it bigger, which on a 20 GiB disk is the
  // difference between 3,000 and 60.
  type: "gp3",
  encrypted: true,
  tags: { ...tags, Name: `${name}-data` },
});

// The device path is built from the volume's own id, which is why this is an
// apply rather than a plain string; `dataDevice` in ./platform.ts says why it
// is that path. Gzipped, which cloud-init undoes on its own, because the text
// is past EC2's 16 KB limit on user data before it is compressed.
const userData = dataVolume.id.apply((volumeId) => userDataBase64(settings, volumeId));

const instance = new aws.ec2.Instance(
  name,
  {
    ami: ami.id,
    instanceType,
    subnetId: subnet.id,
    vpcSecurityGroupIds: [securityGroup.id],
    iamInstanceProfile: instanceProfile.name,
    keyName: keyPair?.keyName,
    availabilityZone,
    rootBlockDevice: {
      // The boot disk holds the operating system, the images, and the container
      // logs — which the compose file caps at 10 MiB x 5 per container for
      // exactly this reason. No database, so it does not grow.
      volumeSize: 20,
      volumeType: "gp3",
      encrypted: true,
      deleteOnTermination: true,
    },
    userDataBase64: userData,
    // Instance metadata v2 only. v1 answers an unauthenticated GET, which is
    // what turns a server-side request forgery in any process on the box into
    // the instance's credentials.
    metadataOptions: {
      httpTokens: "required",
      httpEndpoint: "enabled",
      httpPutResponseHopLimit: 1,
    },
    tags: { ...tags, Name: name },
  },
  {
    // ami: Canonical publishes a new build every few weeks, and `mostRecent`
    // above would otherwise make every `pulumi up` replace the machine —
    // destroying the root volume, rebooting the deployment, and doing it again
    // next month. The data volume survives that, but the outage is real and
    // nobody asked for it. Take a new image deliberately: remove it here,
    // deploy, put it back.
    //
    // userDataBase64: the user data embeds this repository's compose files and
    // scripts, so it differs after every release and every edit to one of them,
    // and EC2 applies a change to it by stopping and starting the instance.
    // Cloud-init runs once per instance, so the restarted machine would run
    // none of the new text: an outage that changes nothing. A release or a
    // setting is applied on the machine instead, as the README says.
    ignoreChanges: ["ami", "userDataBase64"],
  },
);

const attachment = new aws.ec2.VolumeAttachment(
  name,
  {
    deviceName: "/dev/sdf",
    volumeId: dataVolume.id,
    instanceId: instance.id,
    // The default detaches on destroy and can hang on a busy filesystem. The
    // instance is stopped first in any orderly teardown.
    stopInstanceBeforeDetaching: true,
  },
  {
    // A new instance means a new attachment, and Pulumi's default builds the
    // replacement before removing the old one. EC2 refuses to attach a volume
    // that is still attached elsewhere, so that order fails the update with
    // two machines and the volume on the old one. Removing first detaches it,
    // stopping the old instance as the line above asks, and then attaches it to
    // the new one. That can take longer than the two minutes firstboot waits
    // for the volume, and the README says what to do when it does.
    deleteBeforeReplace: true,
  },
);

// A fixed address, because the DNS record points at it and an instance stop
// otherwise returns the address to the pool. This is also what lets the machine
// be replaced without a DNS change propagating first.
const address = new aws.ec2.Eip(name, { domain: "vpc", tags: { ...tags, Name: name } });

new aws.ec2.EipAssociation(
  name,
  { instanceId: instance.id, allocationId: address.id },
  {
    // In a VPC, associating an address that is already associated moves it,
    // so on a replacement a new association made as soon as the new machine
    // exists takes the name there while its data volume is still on the old
    // one. So the old association goes first, and the new one waits for the
    // attachment: the address reaches the new machine after its disk does.
    deleteBeforeReplace: true,
    dependsOn: [attachment],
  },
);

export const publicIp = address.publicIp;
export const instanceId = instance.id;
export const url = `https://${settings.hostname}`;
export const machine = `${instanceType} — ${size.vcpu} vCPU, ${size.memoryGib} GiB, ${size.dataGib} GiB data`;
export const shell = pulumi.interpolate`aws ssm start-session --target ${instance.id} --region ${region}`;

/** What is left for a person to do, printed where they will read it. */
export const nextSteps = pulumi.interpolate`
1. Point ${settings.hostname} at ${address.publicIp} with an A record.
   Caddy cannot obtain a certificate until it resolves, and it retries until it does.
2. Reach the machine:  ${shell}
   then wait for the first boot to finish:  sudo cloud-init status --wait
3. Give it a database. None was created: put the connection string in env.local,
     sudo nano /var/lib/simple-balance/env.local
         DATABASE_URL='postgresql://user:password@host:5432/simple_balance?sslmode=no-verify'
   and, if that URL goes through a transaction pooler, DIRECT_DATABASE_URL beside it,
   the same database past the pooler, for the migrations and the first-account claim.
   Then run
     sudo /usr/local/sbin/simple-balance-firstboot
   which starts the deployment and its nightly backup. Until then it is installed and
   stopped, and /etc/motd says so. journalctl -u simple-balance -f follows it from here.
4. Find the setup code:   sudo docker compose -f /opt/simple-balance/compose.yml logs app | grep -i setup
5. Optional settings — SMTP, Stripe, AdSense and the PRIVACY_POLICY_URL it requires —
   go in /var/lib/simple-balance/env.local, which is on the data volume and survives
   a rebuild. Once the deployment has started, a setting is an edit to it, then
   sudo systemctl restart simple-balance.
6. A later 'pulumi up' does not re-run the machine's setup. How to apply a change
   is at the top of what it ran:   sudo cloud-init query userdata | head -16
`;
