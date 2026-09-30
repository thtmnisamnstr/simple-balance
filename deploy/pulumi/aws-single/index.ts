import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import * as single from "../single-common";
import {
  PLACEHOLDER_CERTIFICATE,
  PLACEHOLDER_KEY,
  PLACEHOLDER_PASSWORD,
  databaseUrl,
} from "../single-common/cloud-init";
import { databaseCertificates } from "../single-common/tls";

import {
  IPV6_APT_REWRITE,
  PLACEHOLDER_VOLUME_ID,
  databaseHost,
  databaseUserDataBase64,
  ipv6SubnetCidr,
  readDatabaseEgress,
  requireNewStackForKmsKey,
  requireRegion,
  requireUsableKmsKey,
  userDataBase64,
} from "./platform";

/**
 * Its own Pulumi project, and that is the point rather than an accident of
 * layout.
 *
 * `../aws/` stands up an EKS cluster. Putting a second, unrelated deployment
 * in that program would put both in one stack, where a mistake in either is a
 * `pulumi up` that can destroy the other — and where `pulumi destroy` on the
 * thing you were finished with takes the thing you were not. Two projects, two
 * stacks, two state files, and nothing shared but the module above.
 *
 * Two machines, not one: an application node with a public address and a
 * database node with none. `../oci-single/` is the same deployment on Oracle
 * Cloud and the two are kept in step deliberately — the shapes below have the
 * same names, in the same order, for the same reasons.
 */

const settings = single.readSingleSettings();
const size = settings.size;

/**
 * The database node, or nothing at all when `simple-balance:databaseNode` is
 * false.
 *
 * False builds no second machine, no private subnet and no NAT gateway, and
 * the application node is then exactly what it was before this profile grew a
 * second one: the operator writes a DATABASE_URL of their own into env.local
 * and firstboot waits for it. That is the escape hatch for somebody who
 * already keeps a PostgreSQL. It is no longer the only way to avoid the NAT
 * gateway's monthly charge, which `docs/deployment-costs.md` prices:
 * `simple-balance:databaseEgress: ipv6` drops the gateway and keeps the
 * database node.
 */
const database = settings.database;

// Read from the stack's own key rather than `aws.config.region`, which falls
// back to the shell's AWS_REGION, so the region checked and exported is the one
// the stack says. Checked before anything is declared, because
// `pulumi up --skip-preview` creates whatever was registered before a program
// throws — and before the size check below, which needs the region to work out
// the name the database node answers to.
const awsRegion = requireRegion(new pulumi.Config("aws").get("region"));

const tags = { Project: "simple-balance", Profile: "single", PulumiStack: pulumi.getStack() };
const name = `simple-balance-${pulumi.getStack()}`;

/**
 * The private addresses, pinned rather than allocated.
 *
 * The database node's has to be a constant, because the certificate it presents
 * is issued at plan time and `databaseHost` turns this address into the name in
 * its subject alternative name. An address AWS chose would not be known until
 * the instance existed, which is after the certificate has to be signed.
 *
 * x.x.x.10 rather than x.x.x.4: AWS reserves the first four addresses of every
 * subnet and the last one, so .1 to .3 are refused and .4 is the first that is
 * not. Ten leaves room for anything an operator adds by hand below it.
 */
const applicationCidr = "10.20.0.0/24";
const databaseCidr = "10.20.1.0/24";
const databasePrivateIp = "10.20.1.10";

/**
 * The name the application dials and the certificate is issued for, as one
 * value read twice.
 *
 * `databaseHost` has the us-east-1 exception in it, which is a real one rather
 * than a tidy-up; getting it wrong produces a certificate whose name resolves
 * nowhere.
 */
const databaseDnsName = databaseHost(databasePrivateIp, awsRegion);

// What it protects and how to lift it is at the data volume. Read up here with
// the other settings, because a value that is not a boolean throws, and thrown
// below the network it would leave `--skip-preview` building the network first.
// It governs both data volumes, the application node's and the database node's.
const protectDataVolume =
  new pulumi.Config("simple-balance").getBoolean("protectDataVolume") ?? true;

// The same key, read again for the settings below rather than threaded through
// the statement above, which `tests/aws-single.test.ts` matches character for
// character as the thing that must be read before the first resource.
const cfg = new pulumi.Config("simple-balance");

/**
 * The key the four encrypted disks are made with, when the stack names one.
 *
 * Accepted and never created, and that is the decision this setting is. A key
 * this program made would have the *stack's* lifetime, and that is the wrong
 * lifetime for the thing that decrypts a ledger: `pulumi destroy
 * --exclude-protected` is this repository's own documented teardown and it
 * deliberately keeps both data volumes, so a created key would be scheduled for
 * deletion beside the disks it was keeping — thirty days, and then AWS says the
 * data is unrecoverable and that the same key material in a new key will not
 * decrypt it. An operator who wants a customer-managed key has one, or has a
 * policy saying where keys come from. Accepting keeps this program's blast
 * radius at "machines and disks" and never at "the key that reads them".
 *
 * Unset passes `undefined` rather than `""`, which matters more than it looks:
 * `kms_key_id` is Optional+Computed on an EBS volume, so an empty string would
 * diff against the `aws/ebs` ARN AWS fills in and plan a replacement on a stack
 * whose operator set nothing at all.
 *
 * One key for all four volumes rather than one each. Four buys no isolation —
 * one program, one operator, one blast radius — and costs four times the dollar
 * a month a key is.
 */
const kmsKeyArn = (cfg.get("kmsKeyArn") ?? "").trim();
/**
 * What the operator has to say out loud before a key may be named: that this
 * `up` changes no volume's key — they do not exist yet, or they were already
 * created with this one.
 *
 * `requireNewStackForKmsKey` argues it. The short of it is that `protect` lives
 * in the state snapshot rather than in this config, `pulumi state unprotect`
 * clears it there, and a guard that read `protectDataVolume` would pass in one
 * of the two states where Pulumi goes ahead and replaces a volume holding a
 * ledger. A program cannot tell a first `up` from a hundredth, so this asks.
 */
const kmsKeyArnIsNewStack = cfg.getBoolean("kmsKeyArnIsNewStack") ?? false;
requireNewStackForKmsKey(kmsKeyArn, kmsKeyArnIsNewStack);

/**
 * The key, refused at plan time unless EBS can use it, and `undefined` when the
 * stack names none.
 *
 * An Output rather than a value, and consumed as the volumes' and the root
 * devices' own input, which is what makes the refusal arrive before any of them
 * is created — the same shape `../oci-single/` uses for the availability
 * domain, and for the same `--skip-preview` reason. Nothing the key would
 * encrypt is registered while this is unresolved.
 */
const kmsKeyId = kmsKeyArn
  ? aws.kms.getKeyOutput({ keyId: kmsKeyArn }).apply((key) =>
      requireUsableKmsKey(kmsKeyArn, {
        keyState: key.keyState,
        keyManager: key.keyManager,
        keySpec: key.keySpec,
        keyUsage: key.keyUsage,
      }),
    )
  : undefined;

/**
 * How the database node reaches Ubuntu's archive, the image registry and its
 * shell. `nat` unless the stack says otherwise, which is what every stack built
 * before this setting existed has and what every stack that sets nothing gets.
 *
 * `readDatabaseEgress` carries the argument, including the two free answers
 * that are not offered and why.
 */
const databaseEgress = database
  ? readDatabaseEgress(cfg.get("databaseEgress"), settings.sshPublicKey)
  : "nat";
// Said rather than ignored, the way `../oci-single/` says it of
// `databaseSubnet`. With no database node there is no private subnet, no NAT
// gateway and nothing for this to replace, so the setting is not wrong — it is
// inert, and an operator who set it to save $36.50 has already saved it by
// turning the node off.
if (!database && (cfg.get("databaseEgress") ?? "").trim()) {
  pulumi.log.warn(
    "simple-balance:databaseEgress does nothing while simple-balance:databaseNode is false: this " +
      "stack builds no private subnet and no NAT gateway, so there is no egress to choose. To stop " +
      "this warning: pulumi config rm simple-balance:databaseEgress",
  );
}
if (databaseEgress === "ipv6") {
  pulumi.log.warn(
    "simple-balance:databaseEgress is ipv6: the database node has no IPv4 route out and no NAT " +
      "gateway, which saves about $36.50 a month. Three things are traded for it. Its own Session " +
      "Manager agent can no longer reach AWS, so the shell becomes a port forward through the " +
      "application node — `pulumi stack output databaseShell` prints it. " +
      "Its apt sources are rewritten to Canonical's global archive, because the in-region EC2 " +
      "mirror publishes no AAAA record. And the postgres:18 pull depends on Docker Hub's own " +
      "IPv6, so a first boot that hangs at the image is what a change on their side looks like.",
  );
}

/**
 * What the database node runs before its very first `apt-get`, which under
 * `ipv6` is one rewrite and everywhere else is nothing at all.
 *
 * Here rather than at the render below because the pre-flight measurement a
 * few lines down has to measure the document that will actually be sent: a
 * boot command added after the check is a document that passed a check it was
 * not in, and EC2's 16 KB cap is refused at the launch rather than at
 * `pulumi preview`.
 */
const databaseBootCommands = databaseEgress === "ipv6" ? [IPV6_APT_REWRITE] : [];

// Measured now, against a volume id of the real length and stand-ins the same
// shape and rather more than the size of the password and the certificates
// Pulumi has yet to make, so user data that would not fit EC2's 16 KB refuses
// at `pulumi preview` rather than after the network has been built. The real
// renders below check again, inside their applies, where it is a last resort.
userDataBase64(
  settings,
  PLACEHOLDER_VOLUME_ID,
  database && {
    url: databaseUrl(databaseDnsName, PLACEHOLDER_PASSWORD),
    caCertificate: PLACEHOLDER_CERTIFICATE,
  },
);
if (database) {
  databaseUserDataBase64(
    {
      settings,
      database,
      bindAddress: databasePrivateIp,
      applicationCidr,
      applicationPassword: PLACEHOLDER_PASSWORD,
      serverCertificate: PLACEHOLDER_CERTIFICATE,
      serverKey: PLACEHOLDER_KEY,
      bootCommands: databaseBootCommands,
    },
    PLACEHOLDER_VOLUME_ID,
  );
}

/**
 * Instance types, by what the size table asks for rather than the other way
 * round. Graviton throughout: the images this project runs publish `linux/arm64`
 * and it is the cheaper half of every comparison below.
 *
 * Every family here is Nitro, and that is load-bearing rather than incidental.
 * EBS traffic between a Nitro instance and an encrypted volume is encrypted in
 * transit by the hypervisor, with no property to set and no way to turn it on
 * for anything else — so "the ledger does not cross the machine-to-disk hop in
 * the clear" rests on this table and on `encrypted: true`, together. A
 * pre-Nitro family added here would take that away silently, which is why
 * `tests/single-encryption.test.ts` pins the families rather than trusting the
 * comment.
 */
const applicationInstanceTypes: Record<string, string> = {
  // Burstable, and the right answer for a household ledger: the load is a few
  // page views a day with an occasional import, which is precisely the shape
  // a credit balance covers.
  small: "t4g.medium",
  // Still burstable, and still `t4g.medium`, at the row the capacity target is
  // measured at. This machine peaked at 108.6% of half a core and 745 MiB
  // serving 10,000 people and 30 million transactions, so two cores and 4 GiB
  // is four times its measured peak. It used to buy an `m7g.xlarge` here, which
  // is $119 a month for cores nothing asked for on a machine that stores no
  // ledger.
  medium: "t4g.medium",
  // The one step this node takes, and it is memory rather than cores: a ledger
  // this size is imported in larger pieces and Node's heap is what feels it.
  large: "t4g.large",
};

/**
 * And the database node's, which is where the money belongs.
 *
 * A table of its own rather than the same one read twice, because the two
 * machines stopped wanting the same shape: this one is PostgreSQL, whose memory
 * decides how much of the index stays in cache. Not burstable above `small`,
 * because a deployment busy enough to want four cores is busy enough that
 * running out of credits is a real failure mode.
 *
 * Every family here is Nitro, for the reason the paragraph above gives, and
 * every one of them was already in this program before the split — so the
 * guarantee that the disk hop is encrypted is exactly as strong as it was.
 */
const databaseInstanceTypes: Record<string, string> = {
  small: "t4g.medium",
  medium: "m7g.xlarge",
  large: "m7g.2xlarge",
};
const instanceType = applicationInstanceTypes[settings.sizeName]!;

// ---------------------------------------------------------------- network ---

// 10.20.0.0/16 rather than the 10.0.0.0/16 `../aws/` uses, so the two can be
// peered or can coexist in one account without an overlap nobody planned.
const vpc = new aws.ec2.Vpc(name, {
  cidrBlock: "10.20.0.0/16",
  // Both, because the database node's certificate names it by the
  // Amazon-provided internal DNS name and nothing else resolves that.
  enableDnsHostnames: true,
  enableDnsSupport: true,
  // Only where the database node's way out is IPv6, and free when it is: an
  // Amazon-provided /56 carries no charge. Added in place on an existing VPC
  // rather than replacing it — which matters, because both subnets and both
  // machines hang off this resource. The IPv4 block is untouched, so the
  // database node stays dual-stack and its certificate goes on naming
  // `ip-10-20-1-10.<region>.compute.internal`.
  assignGeneratedIpv6CidrBlock: databaseEgress === "ipv6" ? true : undefined,
  tags: { ...tags, Name: name },
});

/**
 * The free way out, and the whole of it.
 *
 * An egress-only internet gateway is the IPv6 analogue of a NAT gateway and
 * carries neither an hourly charge nor a per-gigabyte one, which is the entire
 * saving: $32.85 of the NAT gateway's $36.50 is the hour rather than the bytes,
 * so nothing that only moves less data saves anything. It is stateful in the
 * same way a NAT gateway is — replies come back, unsolicited packets do not —
 * so the database node is no more reachable from outside than it was.
 */
const egressOnlyGateway =
  database && databaseEgress === "ipv6"
    ? new aws.ec2.EgressOnlyInternetGateway(name, { vpcId: vpc.id, tags: { ...tags, Name: name } })
    : undefined;

const internetGateway = new aws.ec2.InternetGateway(name, {
  vpcId: vpc.id,
  tags: { ...tags, Name: name },
});

// One availability zone, and both machines in it. Spreading across three would
// be a claim this profile does not make: each machine and its disk are one
// thing, and a block volume cannot be attached across zones anyway. Surviving
// the loss of a zone is what the `ha` profile is for.
const subnet = new aws.ec2.Subnet(name, {
  vpcId: vpc.id,
  cidrBlock: applicationCidr,
  mapPublicIpOnLaunch: false,
  tags: { ...tags, Name: name },
});

const routeTable = new aws.ec2.RouteTable(name, {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
  tags: { ...tags, Name: name },
});

/**
 * Kept rather than discarded, because both instances name it in `dependsOn`.
 *
 * On this cloud a subnet does not carry its route table: the association is a
 * separate resource, and an instance that names only the subnet and the
 * security group has both of those in seconds while the route is still being
 * built. Until the association exists the subnet falls back to the VPC's main
 * route table, which has nothing but the local route — and cloud-init's very
 * first act on either machine is `apt-get update`. The symptom is a stack that
 * comes up reporting success with a machine that installed nothing.
 *
 * `../oci-single/` does not have this problem and shows the shape that avoids
 * it: there a subnet takes `routeTableId` directly, so the ordering is the
 * graph's rather than something to remember.
 */
const routeTableAssociation = new aws.ec2.RouteTableAssociation(name, {
  subnetId: subnet.id,
  routeTableId: routeTable.id,
});

/**
 * The database node's subnet: private, and in the same zone the application
 * node landed in.
 *
 * Read off the application subnet rather than chosen again. This program names
 * no availability zone — it takes whichever one AWS picked for the first
 * subnet — so asking for one here would be asking a second time and getting a
 * different answer on some fraction of stacks, which surfaces as an EBS volume
 * that cannot attach to the instance beside it.
 */
const databaseSubnet = database
  ? new aws.ec2.Subnet(`${name}-db`, {
      vpcId: vpc.id,
      cidrBlock: databaseCidr,
      availabilityZone: subnet.availabilityZone,
      // Said rather than left to the default, because it is the property that
      // makes "no machine in here has a public address" a thing a reader and a
      // test can both see.
      mapPublicIpOnLaunch: false,
      // One /64 out of the VPC's /56, at index 1 so it lines up with this
      // subnet's 10.20.1.0/24 and nothing has to be remembered about which is
      // which. An IPv6 address on a subnet is not a public address in the sense
      // the line above is about: there is no route from the internet to it, only
      // the egress-only gateway's one way out.
      //
      // The index is a constant and never a setting, and that is the reason:
      // the provider recreates a subnet whose IPv6 block *changes* once
      // addresses are assigned from it, and this subnet is where the database
      // node's network interface lives. Adding a block for the first time is an
      // in-place update; moving one would be a rebuild of the machine.
      ipv6CidrBlock:
        databaseEgress === "ipv6"
          ? vpc.ipv6CidrBlock.apply((block) => ipv6SubnetCidr(block, 1))
          : undefined,
      assignIpv6AddressOnCreation: databaseEgress === "ipv6" ? true : undefined,
      tags: { ...tags, Name: `${name}-db` },
    })
  : undefined;

/**
 * The way out for a subnet with no route to the internet gateway.
 *
 * The default rather than the only way, and it is worth saying why a database
 * node needs egress at all: at first boot it installs `docker.io` and
 * `docker-compose-v2` from Ubuntu's archive and pulls `postgres:18`, afterwards
 * `unattended-upgrades` fetches security updates, and throughout Session
 * Manager's agent long-polls three AWS endpoints for the shell. That third
 * consumer is the one that makes "just go without egress" wrong, and it is why
 * the alternative below had to bring a replacement shell with it.
 *
 * It costs roughly $36.50 a month on this cloud — $32.85 of it the hour rather
 * than the bytes — which is the largest single line in an AWS `small`
 * deployment, 38% of the bill. `simple-balance:databaseEgress: ipv6` is the free
 * alternative and `readDatabaseEgress` in `./platform.ts` carries its argument;
 * `simple-balance:databaseNode: false` removes the machine along with the
 * gateway. Oracle Cloud charges nothing for the equivalent, which is most of
 * why `../oci-single/` is the cheaper program.
 */
const natAddress =
  database && databaseEgress === "nat"
    ? new aws.ec2.Eip(`${name}-nat`, { domain: "vpc", tags: { ...tags, Name: `${name}-nat` } })
    : undefined;

const natGateway =
  database && natAddress
    ? new aws.ec2.NatGateway(
        name,
        {
          // In the *public* subnet, which is the application node's. A NAT
          // gateway placed in the subnet it serves has no route out and the
          // symptom is every connection timing out rather than an error.
          subnetId: subnet.id,
          allocationId: natAddress.id,
          tags: { ...tags, Name: name },
        },
        { dependsOn: [internetGateway] },
      )
    : undefined;

const databaseRouteTable = database
  ? new aws.ec2.RouteTable(`${name}-db`, {
      vpcId: vpc.id,
      // One or the other and never both. Under `ipv6` there is deliberately no
      // 0.0.0.0/0 route at all: every IPv4 destination is a blackhole, which is
      // what takes Session Manager away and what `readDatabaseEgress` refuses
      // to do without an SSH key to replace it.
      routes: natGateway
        ? [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }]
        : egressOnlyGateway
          ? [{ ipv6CidrBlock: "::/0", egressOnlyGatewayId: egressOnlyGateway.id }]
          : [],
      tags: { ...tags, Name: `${name}-db` },
    })
  : undefined;

/** The same, for the private subnet, and it is the one that matters more. */
const databaseRouteTableAssociation =
  databaseSubnet && databaseRouteTable
    ? new aws.ec2.RouteTableAssociation(`${name}-db`, {
        subnetId: databaseSubnet.id,
        routeTableId: databaseRouteTable.id,
      })
    : undefined;

/**
 * The application node's firewall, and the whole of it.
 * `docs/deployment-profiles.md` has the same table in prose.
 *
 * This is the one machine in the profile with a public address, and the reason
 * is Caddy: it terminates TLS here and gets its certificate by the ACME HTTP-01
 * challenge, which needs Let's Encrypt to reach this machine on port 80 at the
 * name in the certificate. There is no load balancer in this profile — adding
 * one is what the `ha` profile is — so this machine is the edge, and an edge
 * that cannot be reached from the internet serves nobody. DNS-01 would avoid
 * the open port and would need this program to hold an API token for the
 * operator's registrar: a credential to a third system in Pulumi's state, and a
 * different integration per registrar.
 *
 * Nothing opens 3000. Caddy reaches the application over the Docker network
 * inside the machine, so it has no reason to be reachable from outside, and a
 * rule that opened it would be a second way in that the application's own
 * origin checks do not cover. Nothing opens 5432 here either: the database is
 * on the other machine and this one connects out to it.
 */
const securityGroup = new aws.ec2.SecurityGroup(name, {
  vpcId: vpc.id,
  description: "Simple Balance single-profile application node",
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

/**
 * The database node's firewall: one inbound rule, and it is the whole of the
 * machine's exposure.
 *
 * The source is the application node's security group rather than its CIDR,
 * which is the difference between a rule that stays true and one that has to be
 * remembered: the application node can be replaced, re-addressed or moved
 * within its subnet and this rule still names exactly it, while a CIDR names
 * whatever else is ever put in that range.
 *
 * Nothing from 0.0.0.0/0 on any port, and no inbound rule for a shell at all.
 * Session Manager reaches this machine through its own egress, so a shell here
 * needs no open port — which is why the role below grants
 * AmazonSSMManagedInstanceCore exactly as the application node's does. An SSH
 * rule would be a port published to a subnet nobody can reach anyway, and it
 * would read as an exposure that is not one.
 */
const databaseSecurityGroup = database
  ? new aws.ec2.SecurityGroup(`${name}-db`, {
      vpcId: vpc.id,
      description: "Simple Balance single-profile database node",
      ingress: [
        {
          description: "PostgreSQL, from the application node and nothing else",
          protocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          securityGroups: [securityGroup.id],
        },
        // Only under `simple-balance:databaseEgress: ipv6`, which takes Session
        // Manager away: the agent resolves an IPv4-only endpoint and that
        // subnet then has no IPv4 route. This is the replacement shell and it
        // costs nothing — the operator's own key is already installed on both
        // machines, so the rule is the only piece that was missing.
        //
        // Sourced from the application node's security group, never from a
        // CIDR, for the same reason 5432 is: the rule names exactly that
        // machine however it is replaced or re-addressed, where a CIDR names
        // whatever else is ever put in the range. Nothing from the internet
        // either way, because there is no route from it to this subnet.
        ...(databaseEgress === "ipv6"
          ? [
              {
                description: "SSH, from the application node, which replaces Session Manager here",
                protocol: "tcp",
                fromPort: 22,
                toPort: 22,
                securityGroups: [securityGroup.id],
              },
            ]
          : []),
      ],
      egress: [
        // Through the NAT gateway: Ubuntu's archive at first boot, the image
        // registry, and security updates afterwards. There is no inbound path
        // that this opens, because a security group is stateful and an
        // unsolicited packet from outside still matches no ingress rule.
        {
          description: "Everything: the package archive, the image registry, and Session Manager",
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
      tags: { ...tags, Name: `${name}-db` },
    })
  : undefined;

// ------------------------------------------------------------------ shell ---

/**
 * Session Manager rather than SSH, on both machines. No port is opened, no key
 * exists to be lost or shared, and every session is recorded in CloudTrail
 * against the identity that opened it. `aws ssm start-session --target <id>` is
 * the whole of it.
 *
 * A role each rather than one shared, so that the database node's credentials
 * grant nothing the application node's do and the reverse. Neither holds any
 * permission beyond the Session Manager agent's today, and that is exactly why
 * they are separate: the first permission either one needs will be one the
 * other should not have.
 */
function shellRole(roleName: string) {
  const role = new aws.iam.Role(roleName, {
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

  new aws.iam.RolePolicyAttachment(`${roleName}-ssm`, {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  });

  return new aws.iam.InstanceProfile(roleName, { role: role.name, tags });
}

const instanceProfile = shellRole(name);
const databaseInstanceProfile = database ? shellRole(`${name}-db`) : undefined;

// Only where a key was given. Without one, `simple-balance:sshCidr` is refused
// by `readSingleSettings`, so there is never an open port with nothing behind
// it — and with neither set, Session Manager above is the whole answer and this
// resource does not exist. One key pair for both machines: it is the operator's
// own key, and a second copy of it under another name would be a second thing
// to rotate.
const keyPair = settings.sshPublicKey
  ? new aws.ec2.KeyPair(name, { publicKey: settings.sshPublicKey, tags })
  : undefined;

// ------------------------------------------------------ what is generated ---

/**
 * The application role's password: the stack's own when it set one, or 32
 * alphanumerics generated here.
 *
 * `special: false` because the value travels through a URL, a Compose `.env`
 * and a shell script before it reaches the server, and each escapes
 * differently; `readSingleSettings` holds an operator's own value to the same
 * alphabet rather than percent-encoding it, and says why.
 *
 * This is the one credential that has to exist in Pulumi's state, because two
 * machines have to agree about it and only the program that builds both can
 * decide it. The database's *superuser* password is not here: that one is
 * generated on the database node at first boot and never leaves it.
 */
const databasePassword = database
  ? database.password
    ? pulumi.secret(database.password)
    : new random.RandomPassword(`${name}-db`, { length: 32, special: false }).result
  : undefined;

/**
 * The private CA for this stack, the database node's certificate, and its key.
 *
 * Issued at plan time because the name in the certificate has to be the name
 * the application dials, and the application's cloud-init is written before
 * either machine boots. `../single-common/tls.ts` has the rest of the argument,
 * including why the CA's private key is the one value here that reaches neither
 * machine.
 */
const certificates = database
  ? databaseCertificates({
      name,
      stack: pulumi.getStack(),
      dnsName: databaseDnsName,
      ipAddress: databasePrivateIp,
    })
  : undefined;

// ----------------------------------------------------------- the machines ---

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
 * The application node's data disk, separate from the machine's.
 *
 * It holds the generated secret, env.local, the database's CA certificate and
 * the nightly dumps — not the ledger itself, which is on the database node.
 * Separate because the two disks have different lifetimes. A new `size` is not
 * a replacement: EC2 stops the instance, changes its type and starts it again,
 * and this volume grows in place. Replacing the instance — a new image taken by
 * lifting `ignoreChanges`, or `pulumi up --replace` after the machine went
 * wrong — destroys the root volume and leaves this one, and cloud-init formats
 * it only when it is not already a filesystem. So a rebuild keeps all of it.
 *
 * And so it is one of the two resources here the next `pulumi up` cannot
 * rebuild, and one of the two with Pulumi's `protect` unless
 * `simple-balance:protectDataVolume` is false. While it is set, `pulumi destroy`
 * fails at its preview and deletes nothing, and so does any `up` that would
 * replace the volume — a new `aws:region` is the one setting that does, since
 * the provider records a region on every resource. A resize is an update rather
 * than a replacement and goes through, and so does replacing the machine, which
 * the volume was built before and does not depend on. The console and the `aws`
 * CLI are outside it.
 *
 * `pulumi destroy --exclude-protected` and `--skip-preview` keep both volumes
 * and the subnets and VPC they were built in, because Pulumi keeps what a
 * protected resource depends on, and delete everything else, the machines and
 * the Elastic IPs included; the next `up` builds those again and attaches the
 * volumes, on a new address. A new region under `--skip-preview` is worse: the
 * network is rebuilt there before Pulumi reaches the volume and refuses, and
 * what is left is a stack no `up` sets right, which is why the region is
 * required in the stack rather than read from a shell.
 *
 * A switch in the stack rather than a constant, so tearing down on purpose is
 * a decision recorded where the stack's others are rather than an edit to the
 * program, which is what Pulumi's refusal suggests: set it to false and run
 * `pulumi up`, which changes no resource and only the flag in Pulumi's state,
 * then `pulumi destroy`. `pulumi state unprotect` clears the flag for one
 * destroy instead, and the next `up` sets it again while the setting is true.
 */
const dataVolume = new aws.ebs.Volume(
  name,
  {
    availabilityZone,
    // The application node's own column of the size table, which is a different
    // number from the database node's below. This disk holds fifteen dumps at
    // `backupKeep`'s default — fourteen kept plus the one being written — and
    // about a gigabyte of everything else, so it is sized by the *backups* and
    // the ledger only through them. `simple-balance:backupKeep` is the lever.
    size: size.application.diskGib,
    // gp3 rather than gp2: the baseline 3,000 IOPS comes with the volume instead
    // of being earned by making it bigger, which on a 20 GiB disk is the
    // difference between 3,000 and 60.
    type: "gp3",
    // Said here, although AWS can be made to do it by default, because
    // encryption by default is an *account* setting that is off on a fresh
    // account: on this cloud the property is the whole guarantee rather than a
    // restatement of one. It is also what makes the Nitro hypervisor encrypt
    // the traffic between the instance and this volume, which has no property
    // of its own to set. Which key does it is the line below.
    encrypted: true,
    // The stack's own key where it named one, and `undefined` — never `""` —
    // where it did not, so a stack that sets nothing plans no change at all
    // against the computed `aws/ebs` ARN AWS filled in. This property is
    // ForceNew: it decides the key when the volume is created and can never
    // change it, which is why `requireNewStackForKmsKey` refuses a key that
    // was not declared to be going onto volumes this `up` is about to create.
    kmsKeyId,
    tags: { ...tags, Name: `${name}-data` },
  },
  { protect: protectDataVolume },
);

/**
 * The database node's data disk, which holds the ledger.
 *
 * The same protection and the same reasoning as the volume above, and rather
 * more at stake: the cluster is here, and so is the superuser password that
 * exists nowhere else — not in Pulumi's state, not in user data, and in no
 * answer any provider API gives. Losing this volume is losing the deployment,
 * where losing the other one is losing its backups.
 *
 * Sized by `simple-balance:databaseSize`, which defaults to the application
 * node's size and is named separately because the two machines rarely want the
 * same row for long: the application is a Node process that is mostly idle and
 * PostgreSQL would take every byte on the machine.
 */
const databaseVolume =
  database && databaseSubnet
    ? new aws.ebs.Volume(
        `${name}-db`,
        {
          availabilityZone,
          // PGDATA, so the cluster plus `pg_wal` plus the room a REINDEX needs
          // — the compose file binds the volume at `/var/lib/postgresql`, the
          // parent, so the write-ahead log is on this filesystem and counts
          // against it. `max_wal_size` is a soft target the checkpointer drains
          // toward, so the table leaves twice it here; a full `pg_wal` is a
          // PANIC and a cluster that will not restart.
          size: database.size.database.diskGib,
          type: "gp3",
          encrypted: true,
          kmsKeyId,
          tags: { ...tags, Name: `${name}-db-data` },
        },
        { protect: protectDataVolume },
      )
    : undefined;

// The device path is built from the volume's own id, which is why this is an
// apply rather than a plain string; `dataDevice` in ./platform.ts says why it
// is that path. Gzipped, which cloud-init undoes on its own, because the text
// is past EC2's 16 KB limit on user data before it is compressed.
//
// The password and the CA certificate join it here, and nowhere earlier: both
// are Pulumi outputs, and the render is a plain function over strings so that
// the test suite can produce exactly this document without Pulumi.
const userData = pulumi
  .all([
    dataVolume.id,
    databasePassword ?? pulumi.output(""),
    certificates?.caCertificate ?? pulumi.output(""),
  ])
  .apply(([volumeId, password, caCertificate]) =>
    userDataBase64(
      settings,
      volumeId,
      database ? { url: databaseUrl(databaseDnsName, password), caCertificate } : undefined,
    ),
  );

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
      // env.local reaches this disk only by way of the data volume's mount, but
      // the boot disk still holds the database's CA certificate as cloud-init
      // staged it and every log line the deployment has written. Encrypted for
      // the same reason the data volume is, and on the same key — AWS's own
      // when the stack names none.
      encrypted: true,
      // The provider says in as many words that changing this replaces the
      // instance, and `ignoreChanges` below does not cover `rootBlockDevice`.
      // So naming a key on a stack whose machines exist is an unasked-for
      // rebuild of both of them; the data volumes survive it, because they are
      // separate resources and firstboot formats nothing it finds a filesystem
      // on, but the outage is real. It is a decision to make before the first
      // `pulumi up`, and `docs/deployment-profiles.md` says so.
      kmsKeyId,
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
    // setting is applied on the machine instead, as the README says. It is also
    // what makes the database certificate long-lived rather than renewable: a
    // re-issued one would sit in Pulumi's state and never reach either machine,
    // so rotation is the by-hand procedure the README writes down.
    ignoreChanges: ["ami", "userDataBase64"],
    // The route out, which nothing else in this resource's inputs waits for.
    // See the association itself for what boots without one.
    dependsOn: [routeTableAssociation],
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
    // the new one. firstboot waits for the device as long as this provider
    // gives the stop, the detach and the attach together, and the README says
    // what to do when a move fails outright.
    deleteBeforeReplace: true,
  },
);

/**
 * The database node.
 *
 * No public address at all — the subnet does not hand one out and this asks for
 * none, so there are two independent reasons rather than one — and one inbound
 * rule, for 5432 from the application node's security group. It is reached for
 * a shell through Session Manager, which needs neither.
 *
 * Its user data carries the server certificate, the server's private key and
 * the application role's password, and none of the three is the dangerous one:
 * the superuser password is generated on the machine itself, and the CA's
 * private key is in Pulumi's state and in neither machine's user data. So
 * nobody who can read this instance's user data can mint a certificate for this
 * database or sign in as the cluster's owner.
 */
const databaseUserData =
  database && databaseVolume && certificates && databasePassword
    ? pulumi
        .all([
          databaseVolume.id,
          databasePassword,
          certificates.serverCertificate,
          certificates.serverKey,
        ])
        .apply(([volumeId, applicationPassword, serverCertificate, serverKey]) =>
          databaseUserDataBase64(
            {
              settings,
              database,
              bindAddress: databasePrivateIp,
              applicationCidr,
              applicationPassword,
              serverCertificate,
              serverKey,
              bootCommands: databaseBootCommands,
            },
            volumeId,
          ),
        )
    : undefined;

const databaseInstance =
  database && databaseSubnet && databaseSecurityGroup && databaseInstanceProfile && databaseUserData
    ? new aws.ec2.Instance(
        `${name}-db`,
        {
          ami: ami.id,
          instanceType: databaseInstanceTypes[database.sizeName]!,
          subnetId: databaseSubnet.id,
          vpcSecurityGroupIds: [databaseSecurityGroup.id],
          iamInstanceProfile: databaseInstanceProfile.name,
          keyName: keyPair?.keyName,
          availabilityZone,
          // Pinned, because the certificate's subject alternative name was
          // decided from it before this instance existed. AWS accepts any free
          // address in the subnet's range; .10 is past the four AWS reserves.
          privateIp: databasePrivateIp,
          // Said although the subnet already refuses one, so that "this machine
          // is not on the internet" is two properties rather than one, and so
          // that a subnet edited later cannot quietly give it an address.
          associatePublicIpAddress: false,
          // The address the egress-only gateway carries out, and the only
          // reason this machine has one. An IPv6 address is not a public
          // address in the sense the line above is about: there is no inbound
          // route to this subnet, and the gateway is one-way by definition.
          ipv6AddressCount: databaseEgress === "ipv6" ? 1 : undefined,
          rootBlockDevice: {
            // The operating system, the postgres image, and the certificate and
            // key cloud-init wrote. Not the cluster, which is on the data
            // volume, and not the superuser password, which is there too.
            volumeSize: 20,
            volumeType: "gp3",
            encrypted: true,
            kmsKeyId,
            deleteOnTermination: true,
          },
          userDataBase64: databaseUserData,
          metadataOptions: {
            httpTokens: "required",
            httpEndpoint: "enabled",
            httpPutResponseHopLimit: 1,
          },
          tags: { ...tags, Name: `${name}-db` },
        },
        {
          // The same two, for the same reasons, as the application node's.
          ignoreChanges: ["ami", "userDataBase64"],
          // Deleted before its replacement is made, which the application node
          // does not need and this one does: its private address is pinned, and
          // two instances cannot hold one address. Pulumi's default order would
          // ask EC2 for a second machine at 10.20.1.10 while the first still
          // has it, and the run would fail having built nothing — with the
          // database down for as long as it takes somebody to read why.
          deleteBeforeReplace: true,
          // The route to the NAT gateway. Nothing in this resource's inputs
          // waits for it: the subnet and the security group both resolve in
          // seconds while the gateway is still reporting `pending`, so without
          // this edge the machine boots into a subnet with no default route
          // and `apt-get update` times out against archive.ubuntu.com. What an
          // operator sees is `pulumi up` succeeding, no PostgreSQL, and the
          // application node's simple-balance-waitdb failing five minutes
          // later on the other machine.
          dependsOn: databaseRouteTableAssociation ? [databaseRouteTableAssociation] : [],
        },
      )
    : undefined;

if (databaseInstance && databaseVolume) {
  new aws.ec2.VolumeAttachment(
    `${name}-db`,
    {
      deviceName: "/dev/sdf",
      volumeId: databaseVolume.id,
      instanceId: databaseInstance.id,
      stopInstanceBeforeDetaching: true,
    },
    { deleteBeforeReplace: true },
  );
}

// A fixed address, because the DNS record points at it and an instance stop
// otherwise returns the address to the pool. This is also what lets the machine
// be replaced without a DNS change propagating first. Only the application node
// has one; the database node has no public address of any kind.
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

export const region = awsRegion;
export const publicIp = address.publicIp;
export const instanceId = instance.id;
export const dataVolumeId = dataVolume.id;
export const databaseInstanceId = databaseInstance?.id;
export const databaseVolumeId = databaseVolume?.id;
/** The name in the certificate and in DATABASE_URL, for an operator debugging either. */
export const databaseHostName = database ? databaseDnsName : undefined;
export const url = `https://${settings.hostname}`;
export const machine = `${instanceType} — ${size.application.vcpu} vCPU, ${size.application.memoryGib} GiB, ${size.application.diskGib} GiB data`;
export const databaseMachine = database
  ? `${databaseInstanceTypes[database.sizeName]!} — ${database.size.database.vcpu} vCPU, ${database.size.database.memoryGib} GiB, ${database.size.database.diskGib} GiB data, PostgreSQL 18`
  : undefined;
export const shell = pulumi.interpolate`aws ssm start-session --target ${instance.id} --region ${awsRegion}`;
/**
 * And the database node's, which the egress choice decides rather than the
 * machine.
 *
 * Under `ipv6` that subnet has no IPv4 route, so the database node's own
 * Session Manager agent reaches nothing and the command that used to be printed
 * here would hang rather than fail. What replaces it is a port forward through
 * the *application* node's agent, which is still reachable, to 22 on the
 * database node — which the security group opens from the application node's
 * group under exactly this setting.
 *
 * A forward rather than `ssh` run on the application node, and the difference
 * is where the private key is. The operator's key is installed on both machines
 * as an *authorized* key; the private half is on their laptop and has to stay
 * there. A forward keeps the ssh client, and so the key, on the laptop and
 * leaves the application node carrying nothing but the packets. It needs no
 * open port anywhere and no agent forwarding.
 *
 * This is the replacement `readDatabaseEgress` refuses the setting without a
 * key for, so the two have to stay true together.
 */
export const databaseShell = databaseInstance
  ? databaseEgress === "ipv6"
    ? pulumi.interpolate`aws ssm start-session --target ${instance.id} --region ${awsRegion} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host="${databasePrivateIp}",portNumber="22",localPortNumber="2222"   # then, in another terminal: ssh -p 2222 ubuntu@localhost`
    : pulumi.interpolate`aws ssm start-session --target ${databaseInstance.id} --region ${awsRegion}`
  : undefined;

/**
 * Step three, which is the only step the database node changes.
 *
 * With one, there is nothing to do: the connection string was generated, the
 * CA is installed and firstboot has already started the deployment. Without
 * one, this is the step that was always here — and the gate in firstboot that
 * holds the deployment stopped until a DATABASE_URL appears is the same gate,
 * untouched.
 */
const databaseStep = database
  ? `3. The database is already running, on its own machine with no public address.
   Nothing to do: the connection string is in /opt/simple-balance/env.db, it verifies
   the server against a CA this stack issued, and firstboot has started the deployment.
   To look at the database, take a shell on it — 'pulumi stack output databaseShell',
   which is a Session Manager session unless simple-balance:databaseEgress is ipv6,
   in which case it is a hop through this machine — and then
     sudo docker compose -f /opt/simple-balance/compose.postgres.yml exec postgres \\
       psql -U postgres simple_balance
   To point this machine at a database of your own instead, put your own DATABASE_URL
   in /var/lib/simple-balance/env.local: it is folded last and wins over the generated
   one, with nothing to turn off first.`
  : `3. Give it a database. None was created, because simple-balance:databaseNode is false:
   install the certificate of the CA that signed the database's, then put the
   connection string in env.local,
     sudo install -m 0644 ca.pem /var/lib/simple-balance/tls/db-ca.pem
         (Amazon RDS: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem;
         for a public CA, skip this and leave &sslrootcert=... off the URL)
     sudo nano /var/lib/simple-balance/env.local
         DATABASE_URL='postgresql://user:password@<FQDN>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
   and, if that URL goes through a transaction pooler, DIRECT_DATABASE_URL beside it,
   the same database past the pooler, for the migrations and the first-account claim.
   Then run
     sudo /usr/local/sbin/simple-balance-firstboot
   which starts the deployment and its nightly backup. Until then it is installed and
   stopped, and /etc/motd says so. journalctl -u simple-balance -f follows it from here.`;

/** What is left for a person to do, printed where they will read it. */
export const nextSteps = pulumi.interpolate`
1. Point ${settings.hostname} at ${address.publicIp} with an A record.
   Caddy cannot obtain a certificate until it resolves, and it retries until it does.
2. Reach the machine:  ${shell}
   then wait for the first boot to finish:  sudo cloud-init status --wait
${databaseStep}
4. Find the setup code:   sudo docker compose -f /opt/simple-balance/compose.yml logs app | grep -i setup
5. Optional settings — SMTP, Stripe, AdSense and the PRIVACY_POLICY_URL it requires,
   TERMS_OF_USE_URL — go in /var/lib/simple-balance/env.local, which is on the data
   volume and survives a rebuild. Once the deployment has started,
   a setting is an edit to it, then
   sudo systemctl restart simple-balance.
6. A later 'pulumi up' does not re-run either machine's setup. How to apply a change
   is at the top of what it ran:   sudo cloud-init query userdata | head -16
`;
