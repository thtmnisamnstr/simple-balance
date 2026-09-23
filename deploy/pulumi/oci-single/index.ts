import * as oci from "@pulumi/oci";
import * as pulumi from "@pulumi/pulumi";

import * as single from "../single-common";

import {
  chooseAvailabilityDomain,
  dataVolumeGb,
  instanceMetadata,
  requireSshPublicKey,
} from "./platform";

/**
 * The `single` profile on Oracle Cloud.
 *
 * The same deployment as `../aws-single/`, from the same module, and the
 * differences are all below the application: a VCN instead of a VPC, a security
 * list instead of a security group, a flexible Ampere shape instead of a fixed
 * instance type, and a host firewall that has to be opened as well as the
 * cloud's.
 *
 * Why this provider at all: Ampere A1 is the cheapest way to run this shape by
 * a wide margin, and Oracle's Always Free allowance covers a `small` machine
 * outright — 4 OCPUs and 24 GB of A1 across a tenancy, two block volumes and
 * 200 GB of storage. The database is not in this program: it is whatever
 * DATABASE_URL names, set on the machine afterward, and the README's "A
 * database for Oracle Cloud" is how to get one. OCI's managed PostgreSQL is not
 * in that allowance; one run by hand on what is left of it can be.
 * `docs/deployment-costs.md` has the comparison and its caveats, of which the
 * important one is that free A1 capacity is frequently unavailable.
 */

const settings = single.readSingleSettings();
const size = settings.size;
requireSshPublicKey(settings.sshPublicKey);

// OCI has no notion of a default compartment: every resource is created in one,
// and the tenancy's root compartment is a poor choice because its policies
// cannot be scoped. Required rather than defaulted for that reason.
const cfg = new pulumi.Config("simple-balance");
const compartmentId = cfg.require("compartmentOcid");

const name = `simple-balance-${pulumi.getStack()}`;
const tags = { Project: "simple-balance", Profile: "single", PulumiStack: pulumi.getStack() };

/**
 * One availability domain, chosen rather than spread across.
 *
 * The same reasoning as the AWS program: this profile is one machine with one
 * disk, and a block volume cannot be attached across domains anyway. Several
 * OCI regions have exactly one.
 *
 * The first, unless `simple-balance:availabilityDomain` names another, by name
 * or by number. Set it before the first successful `pulumi up` and leave it: the
 * data volume lives in the domain, so changing it afterward replaces the
 * volume, and the secret, env.local and the backups on it go with the old one.
 */
const requestedDomain = cfg.get("availabilityDomain") ?? "";
const availabilityDomain = oci.identity
  .getAvailabilityDomainsOutput({ compartmentId })
  .apply((result) =>
    chooseAvailabilityDomain(
      (result.availabilityDomains ?? []).map((domain) => domain.name),
      requestedDomain,
    ),
  );

// Optional, and off by default: a private subnet for an OCI Database with
// PostgreSQL to be created in by hand. The database itself is not built here,
// for the reason DATABASE_URL is not a stack setting — its admin password would
// be in Pulumi's state — and because it is billed, where everything else this
// program makes can sit inside Always Free.
const databaseSubnetWanted = cfg.getBoolean("databaseSubnet") ?? false;

const instanceCidr = "10.30.0.0/24";
const databaseCidr = "10.30.1.0/24";

// --------------------------------------------------------------- network ---

const vcn = new oci.core.Vcn(name, {
  compartmentId,
  cidrBlocks: ["10.30.0.0/16"],
  displayName: name,
  dnsLabel: "simplebalance",
  freeformTags: tags,
});

const internetGateway = new oci.core.InternetGateway(name, {
  compartmentId,
  vcnId: vcn.id,
  enabled: true,
  displayName: name,
  freeformTags: tags,
});

const routeTable = new oci.core.RouteTable(name, {
  compartmentId,
  vcnId: vcn.id,
  routeRules: [
    {
      destination: "0.0.0.0/0",
      destinationType: "CIDR_BLOCK",
      networkEntityId: internetGateway.id,
    },
  ],
  displayName: name,
  freeformTags: tags,
});

/**
 * The firewall's cloud half. The other half is on the instance — see
 * `PLATFORM_COMMANDS` in `./platform.ts`, which is not an optimization but the
 * difference between a machine that serves and one that times out.
 *
 * Nothing opens 3000: Caddy reaches the application over the Docker network
 * inside the machine. Nothing opens 5432 either, because there is no database
 * here to reach; the machine connects out to the one DATABASE_URL names.
 */
const securityList = new oci.core.SecurityList(name, {
  compartmentId,
  vcnId: vcn.id,
  displayName: name,
  egressSecurityRules: [
    // Open, and it has to be: images, Let's Encrypt, the database, and whatever
    // SMTP relay or Stripe endpoint an operator configures. Neither vendor
    // publishes a host list that could be narrowed to.
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all" },
  ],
  ingressSecurityRules: [
    // 6 is TCP and 17 is UDP. OCI takes IANA protocol numbers rather than
    // names, and "all" here would be every port rather than every protocol.
    {
      description: "HTTP, for the redirect to HTTPS and the ACME challenge",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      protocol: "6",
      tcpOptions: { min: 80, max: 80 },
    },
    {
      description: "HTTPS",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      protocol: "6",
      tcpOptions: { min: 443, max: 443 },
    },
    {
      description: "HTTP/3, which Caddy serves by default and which is UDP",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      protocol: "17",
      udpOptions: { min: 443, max: 443 },
    },
    // From this subnet only, which is where an OCI Bastion's private endpoint
    // sits. Both kinds of Bastion session connect to port 22 from there, so
    // without this rule the service has nothing it can reach, and SSH is still
    // published to nobody outside the VCN.
    {
      description: "SSH, from a Bastion in this subnet",
      source: instanceCidr,
      sourceType: "CIDR_BLOCK",
      protocol: "6",
      tcpOptions: { min: 22, max: 22 },
    },
    ...(settings.sshCidr
      ? [
          {
            description: "SSH, from one address",
            source: settings.sshCidr,
            sourceType: "CIDR_BLOCK",
            protocol: "6",
            tcpOptions: { min: 22, max: 22 },
          },
        ]
      : []),
  ],
});

const subnet = new oci.core.Subnet(name, {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: instanceCidr,
  displayName: name,
  dnsLabel: "host",
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
  prohibitPublicIpOnVnic: false,
  freeformTags: tags,
});

/**
 * Where an OCI Database with PostgreSQL can go, when asked for.
 *
 * Private, with no route anywhere, and answering on 5432 to the instance's
 * subnet and nothing else. OCI's managed PostgreSQL goes in a private subnet,
 * which the instance's is not; the instance already reaches this one, because
 * its own egress is open and security lists are stateful.
 */
const databaseSubnet = databaseSubnetWanted
  ? new oci.core.Subnet(`${name}-db`, {
      compartmentId,
      vcnId: vcn.id,
      cidrBlock: databaseCidr,
      displayName: `${name}-db`,
      dnsLabel: "db",
      prohibitPublicIpOnVnic: true,
      securityListIds: [
        new oci.core.SecurityList(`${name}-db`, {
          compartmentId,
          vcnId: vcn.id,
          displayName: `${name}-db`,
          ingressSecurityRules: [
            {
              description: "PostgreSQL, from the instance's subnet",
              source: instanceCidr,
              sourceType: "CIDR_BLOCK",
              protocol: "6",
              tcpOptions: { min: 5432, max: 5432 },
            },
          ],
          freeformTags: tags,
        }).id,
      ],
      freeformTags: tags,
    })
  : undefined;

// --------------------------------------------------------------- machine ---

/**
 * Canonical's Ubuntu 24.04 for aarch64, most recent first.
 *
 * Filtered by shape as well as by operating system, because OCI publishes
 * separate images per architecture and asking for the wrong one fails at launch
 * with a message about shape compatibility rather than about architecture.
 */
const image = oci.core
  .getImagesOutput({
    compartmentId,
    operatingSystem: "Canonical Ubuntu",
    operatingSystemVersion: "24.04",
    shape: "VM.Standard.A1.Flex",
    sortBy: "TIMECREATED",
    sortOrder: "DESC",
  })
  .apply((result) => {
    const images = result.images;
    if (!images || images.length === 0) {
      throw new Error(
        "No Canonical Ubuntu 24.04 image for VM.Standard.A1.Flex in this region. " +
          "Ampere capacity is not offered everywhere; check oci:region.",
      );
    }
    return images[0]!.id;
  });

/**
 * The data disk, separate from the boot volume and outliving it.
 *
 * It holds the generated secret, env.local and the nightly dumps — not the
 * ledger, which is in the database DATABASE_URL names. Replacing the instance
 * destroys the boot volume and leaves this one, and the first-boot script
 * formats it only when it is not already a filesystem, so a rebuild keeps all
 * three. Never smaller than OCI's 50 GB floor, which the shared table's
 * `small` is under.
 */
const dataGb = dataVolumeGb(size);
const dataVolume = new oci.core.Volume(name, {
  compartmentId,
  availabilityDomain,
  displayName: `${name}-data`,
  sizeInGbs: String(dataGb),
  freeformTags: tags,
});

const instance = new oci.core.Instance(
  name,
  {
    compartmentId,
    availabilityDomain,
    displayName: name,
    // Flexible, so the size table's numbers are used exactly rather than
    // rounded up to the next fixed shape the way the AWS program has to.
    shape: "VM.Standard.A1.Flex",
    shapeConfig: {
      ocpus: size.vcpu,
      memoryInGbs: size.memoryGib,
    },
    sourceDetails: {
      sourceType: "image",
      sourceId: image,
      // The boot volume holds the operating system, the images and the
      // container logs, which the compose file caps. No database, so it does
      // not grow. 50 is OCI's minimum.
      bootVolumeSizeInGbs: "50",
    },
    createVnicDetails: {
      subnetId: subnet.id,
      assignPublicIp: "true",
      hostnameLabel: "app",
    },
    // Managed SSH sessions go through the Bastion plugin of Oracle Cloud Agent,
    // which is off unless asked for. A port-forwarding session needs no plugin,
    // only the key and the rule above, which is why nextSteps leads with it.
    agentConfig: {
      pluginsConfigs: [{ name: "Bastion", desiredState: "ENABLED" }],
    },
    // The key and the cloud-init, gzipped and base64'd, and refused at preview
    // if together they would pass OCI's 32,000-byte ceiling on metadata.
    metadata: instanceMetadata(settings, settings.sshPublicKey),
    freeformTags: tags,
  },
  {
    // sourceDetails: a newer Canonical build every few weeks would otherwise
    // replace the machine on every `pulumi up`. Take one deliberately: remove
    // it here, deploy, put it back.
    //
    // metadata: OCI cannot change user_data or the key on a running instance,
    // so the provider replaces the instance whenever either differs — which,
    // since the user data embeds this repository's compose files and scripts,
    // would be every release and every edit to one of them, each a new machine
    // on a new address. Cloud-init runs once per instance anyway, so the new
    // text would change nothing on the old one. Ignoring it makes the rule the
    // README states true: this program provisions the machine once, and a
    // release, a setting or a new key is applied on the machine.
    ignoreChanges: ["sourceDetails", "metadata"],
    // Deleted before its replacement is made, not after, which is the reverse
    // of Pulumi's default. Building the new machine first cannot work here: its
    // VNIC's hostname label has to be unique in the subnet and the old one is
    // still holding "app", and the Always Free A1 allowance has no room for two
    // machines anyway. The address is ephemeral and changes on a replacement
    // either way, so building first would buy nothing.
    deleteBeforeReplace: true,
  },
);

new oci.core.VolumeAttachment(
  name,
  {
    instanceId: instance.id,
    volumeId: dataVolume.id,
    // Paravirtualized rather than iSCSI, which is the difference between a disk
    // the guest simply has and one cloud-init has to run three `iscsiadm`
    // commands to find.
    attachmentType: "paravirtualized",
    device: "/dev/oracleoci/oraclevdb",
  },
  {
    // A new instance means a new attachment, and Pulumi's default builds the
    // replacement before removing the old one. OCI refuses to attach a volume
    // that is still attached elsewhere, so that order fails the update with
    // two machines and the volume on the old one. Removing first detaches it
    // and then attaches it to the new one. That can take longer than the two
    // minutes firstboot waits for the volume, and the README says what to do
    // when it does.
    deleteBeforeReplace: true,
  },
);

/**
 * The address, read off the VNIC the instance was given.
 *
 * Ephemeral rather than reserved, and that is a constraint rather than a
 * preference. OCI maps at most one public IP to a private IP at a time, so
 * attaching a RESERVED address to a VNIC created with `assignPublicIp: true`
 * is refused — and creating it with `false` instead leaves the machine with no
 * route to the internet while cloud-init is running `apt-get`, because a public
 * subnet reaches the internet gateway through the instance's own public IP.
 * There is no ordering that gives both, and a machine that cannot install
 * Docker is worse than an address that is stable only for the life of the
 * instance.
 *
 * In practice it is stable: a routine `pulumi up` replaces nothing — a new
 * `size` reshapes the instance and grows its volume in place — so the address
 * lasts until the instance itself is replaced: by a destroy, a new
 * `availabilityDomain`, a new image taken by lifting `ignoreChanges`, or
 * `pulumi up --replace`. An
 * operator who needs one that outlives the machine can promote this address to
 * reserved in the console, which OCI supports for an existing ephemeral IP, but
 * promoting it does not make it follow: the replacement comes up on a fresh
 * ephemeral address, for the same one-per-private-IP reason, and the reserved
 * one has to be moved onto it by hand. `../aws-single/` has no such constraint
 * and uses an Elastic IP.
 */
const vnic = oci.core
  .getVnicAttachmentsOutput({ compartmentId, instanceId: instance.id })
  .apply((result) => oci.core.getVnicOutput({ vnicId: result.vnicAttachments[0]!.vnicId }));

const publicIpAddress = vnic.apply((details) => details.publicIpAddress);
const privateIpAddress = vnic.apply((details) => details.privateIpAddress);

export const publicIp = publicIpAddress;
export const privateIp = privateIpAddress;
export const instanceId = instance.id;
export const subnetId = subnet.id;
export const databaseSubnetId = databaseSubnet?.id;
export const url = `https://${settings.hostname}`;
export const machine = `VM.Standard.A1.Flex — ${size.vcpu} OCPU, ${size.memoryGib} GB, ${dataGb} GB data`;

const reach = settings.sshCidr
  ? pulumi.interpolate`2. Reach the machine:   ssh ubuntu@${publicIpAddress}
   (simple-balance:sshCidr opens 22 to ${settings.sshCidr}. A Bastion session works too:
   "Reaching the Oracle Cloud machine" in deploy/pulumi/README.md has the commands.)`
  : pulumi.interpolate`2. Reach the machine. SSH is not published; the OCI Bastion service reaches it from
   inside its subnet. Create a bastion once (it is free), allowing your own address:
     oci bastion bastion create --bastion-type STANDARD --compartment-id ${compartmentId} \\
       --target-subnet-id ${subnet.id} --client-cidr-list '["<your address>/32"]'
   then a session, which prints the ssh command to run once it is ACTIVE:
     oci bastion session create-port-forwarding --bastion-id <bastion OCID> \\
       --target-private-ip ${privateIpAddress} --target-port 22 \\
       --ssh-public-key-file ~/.ssh/id_ed25519.pub
     oci bastion session get --session-id <session OCID>    (under ssh-metadata)
   That command forwards a local port; ssh -p <that port> ubuntu@localhost in another
   terminal. The console's Bastion page does the same with a Copy SSH command button.
   Or set simple-balance:sshCidr to your own address, run 'pulumi up', and ssh ubuntu@${publicIpAddress}.`;

export const nextSteps = pulumi.interpolate`
1. Point ${settings.hostname} at ${publicIpAddress} with an A record.
   Caddy cannot obtain a certificate until it resolves, and it retries until it does.
   The address is ephemeral: promote it to reserved in the OCI console if the record
   has to outlive this instance.
${reach}
3. Give it a database. None was created: put the connection string in env.local,
     sudo nano /var/lib/simple-balance/env.local
         DATABASE_URL='postgresql://user:password@host:5432/simple_balance?sslmode=no-verify'
   and, if that URL goes through a transaction pooler, DIRECT_DATABASE_URL beside it,
   the same database past the pooler, for the migrations and the first-account claim.
   Then run
     sudo /usr/local/sbin/simple-balance-firstboot
   which starts the deployment and its nightly backup. Until then it is installed and
   stopped, and /etc/motd says so. The README's "A database for Oracle Cloud" has the
   steps for one, and simple-balance:databaseSubnet the subnet.
4. Find the setup code:   sudo docker compose -f /opt/simple-balance/compose.yml logs app | grep -i setup
5. Optional settings — SMTP, Stripe, AdSense and the PRIVACY_POLICY_URL it requires —
   go in /var/lib/simple-balance/env.local, which is on the data volume and survives
   a rebuild. Once the deployment has started, a setting is an edit to it, then
   sudo systemctl restart simple-balance.
6. A later 'pulumi up' does not re-run the machine's setup. How to apply a change
   is at the top of what it ran:   sudo cloud-init query userdata | head -16
`;
