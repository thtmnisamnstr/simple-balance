import * as oci from "@pulumi/oci";
import * as pulumi from "@pulumi/pulumi";

import * as single from "../single-common";

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
 * a wide margin, and Oracle's Always Free allowance covers a `small` deployment
 * outright — 4 OCPUs and 24 GB of A1 across a tenancy, two block volumes and
 * 200 GB of storage. `docs/deployment-costs.md` has the comparison and its
 * caveats, of which the important one is that free A1 capacity is frequently
 * unavailable in a given region.
 */

const settings = single.readSingleSettings();
const size = settings.size;

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
 */
const availabilityDomain = oci.identity
  .getAvailabilityDomainsOutput({ compartmentId })
  .apply((result) => {
    const domains = result.availabilityDomains;
    if (!domains || domains.length === 0) {
      throw new Error("No availability domain in this compartment. Check oci:region.");
    }
    return domains[0]!.name;
  });

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
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: internetGateway.id },
  ],
  displayName: name,
  freeformTags: tags,
});

/**
 * The firewall's cloud half. The other half is on the instance — see
 * `platformCommands` below, which is not an optimisation but the difference
 * between a machine that serves and one that times out.
 *
 * Nothing opens 5432 or 3000. PostgreSQL and the application reach each other
 * over the Docker network inside the machine.
 */
const securityList = new oci.core.SecurityList(name, {
  compartmentId,
  vcnId: vcn.id,
  displayName: name,
  egressSecurityRules: [
    // Open, and it has to be: images, Let's Encrypt, and whatever SMTP relay or
    // Stripe endpoint an operator configures. Neither vendor publishes a host
    // list that could be narrowed to.
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
  cidrBlock: "10.30.0.0/24",
  displayName: name,
  dnsLabel: "host",
  routeTableId: routeTable.id,
  securityListIds: [securityList.id],
  prohibitPublicIpOnVnic: false,
  freeformTags: tags,
});

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
 * The database's disk, separate from the boot volume and outliving it.
 *
 * Replacing the instance destroys the boot volume and leaves this one, and the
 * first-boot script formats it only when it is not already a filesystem — so a
 * rebuild keeps the ledger and the two secrets stored beside it.
 */
const dataVolume = new oci.core.Volume(name, {
  compartmentId,
  availabilityDomain,
  displayName: `${name}-data`,
  sizeInGbs: String(size.dataGib),
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
    metadata: {
      user_data: pulumi
        .output(
          single.cloudInit({
            settings,
            // OCI's consistent device paths, which exist precisely so a guest
            // does not have to guess. The attachment below asks for this name
            // and the guest sees this symlink, on every reboot, whatever order
            // the devices enumerate in.
            dataDevice: "/dev/oracleoci/oraclevdb",
            platformCommands: [
              // OCI's Ubuntu images ship a netfilter ruleset that accepts 22
              // and REJECTs the rest, so the security list above opens the
              // cloud and the host still refuses. Inserted at the top of the
              // INPUT chain — appending would land after the REJECT that ends
              // it and change nothing — and persisted, because the rules are
              // reloaded from that file on boot.
              '["/bin/sh", "-c", "iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT && iptables -I INPUT 2 -p tcp --dport 443 -j ACCEPT && iptables -I INPUT 3 -p udp --dport 443 -j ACCEPT && netfilter-persistent save"]',
            ],
          }),
        )
        .apply((text) => Buffer.from(text, "utf8").toString("base64")),
    },
    freeformTags: tags,
  },
  // A newer Canonical build every few weeks would otherwise replace the machine
  // on every `pulumi up`. Take one deliberately: remove this line, deploy, put
  // it back.
  { ignoreChanges: ["sourceDetails"] },
);

new oci.core.VolumeAttachment(name, {
  instanceId: instance.id,
  volumeId: dataVolume.id,
  // Paravirtualized rather than iSCSI, which is the difference between a disk
  // the guest simply has and one cloud-init has to run three `iscsiadm`
  // commands to find.
  attachmentType: "paravirtualized",
  device: "/dev/oracleoci/oraclevdb",
});

/**
 * A reserved address, so the DNS record survives the machine.
 *
 * The instance gets an ephemeral public IP at launch and this replaces it; the
 * two data sources in between are how OCI names the private IP a reserved
 * address attaches to, which is not something the instance resource exposes
 * directly.
 */
const vnicId = oci.core
  .getVnicAttachmentsOutput({ compartmentId, instanceId: instance.id })
  .apply((result) => result.vnicAttachments[0]!.vnicId);

const privateIpId = oci.core
  .getPrivateIpsOutput({ vnicId })
  .apply((result) => result.privateIps[0]!.id);

const address = new oci.core.PublicIp(name, {
  compartmentId,
  lifetime: "RESERVED",
  privateIpId,
  displayName: name,
  freeformTags: tags,
});

export const publicIp = address.ipAddress;
export const instanceId = instance.id;
export const url = `https://${settings.hostname}`;
export const machine = `VM.Standard.A1.Flex — ${size.vcpu} OCPU, ${size.memoryGib} GB, ${size.dataGib} GB data`;

export const nextSteps = pulumi.interpolate`
1. Point ${settings.hostname} at ${address.ipAddress} with an A record.
   Caddy cannot obtain a certificate until it resolves, and it retries until it does.
2. Reach the machine. With simple-balance:sshCidr unset there is no open SSH port —
   use the OCI Bastion service, or set sshCidr to your own address and redeploy.
3. Find the setup code:   sudo docker compose -f /opt/simple-balance/compose.yml logs app | grep -i setup
4. Optional settings — SMTP, Stripe, AdSense — go in /opt/simple-balance/env.local,
   which survives a redeploy, and take effect on  sudo systemctl restart simple-balance.
`;
