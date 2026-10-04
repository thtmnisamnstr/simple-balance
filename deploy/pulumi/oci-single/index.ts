import * as oci from "@pulumi/oci";
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
  OCI_CLI_IMAGE,
  chooseAvailabilityDomain,
  dataVolumeGb,
  databaseHost,
  databaseInstanceMetadata,
  hsmKeyWarning,
  instanceMetadata,
  readKmsSelection,
  requireDataVolumeDomain,
  requireRegion,
  requireSshPublicKey,
  requireUsableKmsKey,
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
 * Two machines: an application node with a public address, and a database node
 * with none, running PostgreSQL 18 in a container on its own block volume. The
 * database used to be whatever an operator built by hand and named in
 * DATABASE_URL; it is now part of the stack, and
 * `simple-balance:databaseNode: false` is how to go back to bringing your own.
 *
 * Why this provider at all: Ampere A1 is the cheapest way to run this shape by
 * a wide margin, and Oracle's Always Free allowance covers a `small` pair
 * outright — but only just, and the arithmetic is worth having in front of you.
 * The allowance is 4 OCPUs and 24 GB of A1 across a tenancy and 200 GB of block
 * storage. Two `small` machines are 4 OCPUs and 8 GB, and their four volumes —
 * two 50 GB boot disks and two data volumes raised to OCI's 50 GB floor — are
 * exactly 200 GB. So `small` fits to the byte, `medium` does not fit at all,
 * and there is no room for a second Simple Balance stack in the same tenancy.
 * `docs/deployment-costs.md` has the comparison and its caveats, of which the
 * important one is that free A1 capacity is frequently unavailable.
 */

const settings = single.readSingleSettings();
const size = settings.size;
requireSshPublicKey(settings.sshPublicKey);

/**
 * The database node, or nothing at all when `simple-balance:databaseNode` is
 * false.
 *
 * False builds no second machine, no private subnet and no NAT gateway, and the
 * application node is then exactly what it was before this profile grew a
 * second one: the operator sets a DATABASE_URL of their own in
 * `simple-balance:secrets` and firstboot waits for it. That is the escape hatch for somebody who already
 * keeps a PostgreSQL — an OCI Database with PostgreSQL, say, which is billed
 * and sits outside the allowance above.
 */
const database = settings.database;

// Read from the key the default provider is configured from, so the region
// checked and exported is the one every resource below is built in. Checked
// before anything is declared, because `pulumi up --skip-preview` creates
// whatever was registered before a program throws.
const ociRegion = requireRegion(new pulumi.Config("oci").get("region"));

// OCI has no notion of a default compartment: every resource is created in one,
// and the tenancy's root compartment is a poor choice because its policies
// cannot be scoped. Required rather than defaulted for that reason.
const cfg = new pulumi.Config("simple-balance");
const compartmentId = cfg.require("compartmentOcid");

const name = `simple-balance-${pulumi.getStack()}`;
const tags = { Project: "simple-balance", Profile: "single", PulumiStack: pulumi.getStack() };

// Each volume's name and the name the availability domain looks it up by, as
// one value apiece: renamed in one place only, the lookup would find nothing
// and the refusal it exists for would quietly stop.
const dataVolumeName = `${name}-data`;
const databaseVolumeName = `${name}-db-data`;

// What it protects and how to lift it is at the data volumes. Read up here with
// the other settings, because a value that is not a boolean throws, and thrown
// below the network it would leave `--skip-preview` building the network first.
// The availability domain reads it too. One switch for both volumes: they are
// the same decision — whether this stack may delete somebody's data — and two
// would be a way to protect the backups and not the ledger.
const protectDataVolume = cfg.getBoolean("protectDataVolume") ?? true;

/**
 * The key the two boot volumes and the two block volumes are made with, when
 * the stack names one — and Oracle's own key when it does not, which is already
 * encryption at rest and has always been.
 *
 * Accepted and never created, and the argument is stronger here than on AWS.
 * Creating one would mean creating a vault first, and deleting a vault puts
 * "the vault and all its associated keys" into pending deletion for seven to
 * thirty days — so a `pulumi destroy` that deliberately keeps the protected
 * data volumes would leave the ledger on disk beside a key counting down. An
 * operator who wants a customer-managed key has one.
 *
 * What a customer key buys and costs here is not what it is on AWS, and the
 * asymmetry is worth carrying rather than averaging away. On this cloud a
 * volume can be moved back onto Oracle's key in place, with `oci bv
 * volume-kms-key delete` and `oci bv boot-volume-kms-key delete`, so the
 * decision is reversible; on AWS a volume's key is fixed for the volume's life
 * and the only way off it is a snapshot copy.
 */
const kmsSelection = readKmsSelection(cfg.get("kmsVaultOcid") ?? "", cfg.get("kmsKeyOcid") ?? "");

/**
 * The key, refused at plan time unless the Block Volume service can use it.
 *
 * Two lookups rather than one, because the second needs the first: every Key
 * Management call goes to the vault's own management endpoint, which is what
 * `oci.kms.getVault` is here to supply. An Output rather than a value, consumed
 * as each volume's and each boot volume's own input, so the refusal lands
 * before any of them is created — the same shape as the availability domain
 * above and for the same `--skip-preview` reason.
 */
const kmsKeyId = kmsSelection
  ? oci.kms.getVaultOutput({ vaultId: kmsSelection.vaultId }).apply((vault) =>
      oci.kms
        .getKeyOutput({
          keyId: kmsSelection.keyId,
          managementEndpoint: vault.managementEndpoint,
        })
        .apply((key) => {
          const facts = {
            state: key.state,
            algorithm: key.keyShapes[0]?.algorithm ?? "",
            protectionMode: key.protectionMode,
          };
          const warning = hsmKeyWarning(facts);
          if (warning) pulumi.log.warn(warning);
          return requireUsableKmsKey(kmsSelection.keyId, facts);
        }),
    )
  : undefined;

/**
 * One availability domain, chosen rather than spread across, and both machines
 * in it.
 *
 * The same reasoning as the AWS program: each machine is one machine with one
 * disk, and a block volume cannot be attached across domains anyway. Several
 * OCI regions have exactly one.
 *
 * The first, unless `simple-balance:availabilityDomain` names another, by name
 * or by number. Set it before the first successful `pulumi up` and leave it: the
 * data volumes live in the domain, so changing it afterward would replace them,
 * and the ledger, the secret and the backups on them would go with
 * the old ones. While they are protected, below, that change is refused here, by
 * `requireDataVolumeDomain` finding a volume in its old domain, and nothing is
 * touched, with or without a preview.
 * Until a launch succeeds it is free to change, which is the point of asking:
 * the volumes are built only after their machines, so a launch refused for
 * capacity leaves nothing in the domain to replace, and nothing for the lookup
 * to find.
 *
 * Both volumes are looked up, not just the application node's. The ledger is on
 * the other one, and a check that guarded the backups and not the database it
 * backs up would be the wrong half.
 */
const requestedDomain = cfg.get("availabilityDomain") ?? "";
const availabilityDomain = pulumi
  .all([
    oci.identity.getAvailabilityDomainsOutput({ compartmentId }),
    oci.core.getVolumesOutput({ compartmentId, displayName: dataVolumeName }),
    oci.core.getVolumesOutput({ compartmentId, displayName: databaseVolumeName }),
  ])
  .apply(([domains, existing, existingDatabase]) =>
    requireDataVolumeDomain(
      chooseAvailabilityDomain(
        (domains.availabilityDomains ?? []).map((domain) => domain.name),
        requestedDomain,
      ),
      [...(existing.volumes ?? []), ...(existingDatabase.volumes ?? [])],
      protectDataVolume,
    ),
  );

/**
 * The setting that makes an empty private subnet for a managed OCI PostgreSQL
 * an operator then builds by hand.
 *
 * Accepted and still honoured, not merely tolerated, and the distinction is the
 * whole of the bug this once had. `databaseNode` was called its replacement and
 * the subnet was then gated on `databaseNode` alone — so the one combination
 * the old setting exists for, `databaseNode false` with `databaseSubnet true`,
 * built nothing at all and left `databaseSubnetId` undefined, which is the
 * output the README's own Oracle walkthrough tells the operator to read. A
 * superseding setting that removes what it supersedes is a narrowing wearing a
 * deprecation notice.
 *
 * So the network below is built when either asks for it, and only the machine
 * inside it belongs to `databaseNode`. The warning says which of the two cases
 * this deployment is in rather than one sentence that is half wrong in both.
 */
const databaseSubnetWanted = cfg.getBoolean("databaseSubnet") === true;
if (databaseSubnetWanted) {
  pulumi.log.warn(
    database
      ? "simple-balance:databaseSubnet adds nothing here: simple-balance:databaseNode already builds " +
          "the private subnet, and a PostgreSQL 18 machine inside it. To stop this warning: " +
          "pulumi config rm simple-balance:databaseSubnet"
      : "simple-balance:databaseSubnet is deprecated in favour of simple-balance:databaseNode, which " +
          "builds a PostgreSQL 18 machine in the same private subnet instead of leaving it empty. It " +
          "is still honoured: this stack gets the subnet, its route to the NAT gateway and its " +
          "security list, and exports databaseSubnetId for a database you build by hand.",
  );
}

/**
 * Whether the private half of the network is built at all.
 *
 * `databaseNode` wants it for the machine it puts in it; `databaseSubnet` wants
 * it empty. Either is enough, and neither reads the other.
 */
const databaseNetwork = database !== undefined || databaseSubnetWanted;

const instanceCidr = "10.30.0.0/24";
const databaseCidr = "10.30.1.0/24";

/**
 * The database node's private address, pinned rather than allocated.
 *
 * It has to be a constant, because the certificate the node presents is issued
 * at plan time and this address is one of its two subject alternative names. It
 * is also the address the compose file binds PostgreSQL to and nothing else, so
 * a machine that came up on another one would publish nothing.
 */
const databasePrivateIp = "10.30.1.10";

/**
 * The name the application dials and the certificate is issued for.
 *
 * The VCN resolver composes it from three labels, so it is known before the
 * instance exists — which is exactly what the certificate needs. Built from the
 * same constants the resources below take, so a subnet relabelled in one place
 * and not the other fails at `pulumi preview` rather than at the first
 * connection.
 */
const vcnDnsLabel = "simplebalance";
const databaseSubnetDnsLabel = "db";
const databaseHostLabel = "db";
const databaseDnsName = databaseHost(vcnDnsLabel, databaseSubnetDnsLabel, databaseHostLabel);

// Measured now, against stand-ins the same shape and rather more than the size
// of the password and the certificates Pulumi has yet to make, so metadata that
// would not fit OCI's 32,000 bytes refuses at `pulumi preview` rather than as a
// LaunchInstance 400 after the network and the volumes have been built. Each
// machine is measured on its own, because each carries its own document.
instanceMetadata(
  settings,
  settings.sshPublicKey,
  database && {
    url: databaseUrl(databaseDnsName, PLACEHOLDER_PASSWORD),
    caCertificate: PLACEHOLDER_CERTIFICATE,
  },
);
if (database) {
  databaseInstanceMetadata(
    {
      settings,
      database,
      bindAddress: databasePrivateIp,
      applicationCidr: instanceCidr,
      applicationPassword: PLACEHOLDER_PASSWORD,
      serverCertificate: PLACEHOLDER_CERTIFICATE,
      serverKey: PLACEHOLDER_KEY,
    },
    settings.sshPublicKey,
  );
}

// --------------------------------------------------------------- network ---

const vcn = new oci.core.Vcn(name, {
  compartmentId,
  cidrBlocks: ["10.30.0.0/16"],
  displayName: name,
  dnsLabel: vcnDnsLabel,
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
 * The application node's firewall, cloud half. The other half is on the
 * instance — see `PLATFORM_COMMANDS` in `./platform.ts`, which is not an
 * optimization but the difference between a machine that serves and one that
 * times out.
 *
 * This is the one machine in the profile with a public address, and the reason
 * is Caddy: it terminates TLS here and obtains its certificate by the ACME
 * HTTP-01 challenge, which needs Let's Encrypt to reach this machine on port 80
 * at the name in the certificate. There is no load balancer in this profile —
 * adding one is what the `ha` profile is — so this machine is the edge, and an
 * edge that cannot be reached from the internet serves nobody.
 *
 * Nothing opens 3000: Caddy reaches the application over the Docker network
 * inside the machine. Nothing opens 5432 either, because the database is on the
 * other machine and this one connects out to it.
 */
const securityList = new oci.core.SecurityList(name, {
  compartmentId,
  vcnId: vcn.id,
  displayName: name,
  egressSecurityRules: [
    // Open, and it has to be: images, Let's Encrypt, the database node, and
    // whatever SMTP relay or Stripe endpoint an operator configures. Neither
    // vendor publishes a host list that could be narrowed to.
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
 * The way out for a subnet with no route to the internet gateway.
 *
 * Built whenever the private subnet is, because a subnet with no route out is
 * not a safer subnet — it is one nothing in it can be installed into, and the
 * failure arrives as a first boot that hangs rather than as a refusal.
 *
 * A database node needs egress even though nothing may reach it: at first boot
 * it installs `docker.io` and `docker-compose-v2` from Ubuntu's archive and
 * pulls `postgres:18`, and afterwards `unattended-upgrades` fetches security
 * updates. Without this the machine comes up, cloud-init fails at the first
 * `apt-get`, and there is no database and nothing in the logs about the network.
 *
 * A NAT gateway carries no hourly charge on this cloud, which is one of the
 * places Oracle Cloud is markedly cheaper than AWS for this shape — the
 * equivalent there is the largest single line in a `small` deployment.
 */
const natGateway = databaseNetwork
  ? new oci.core.NatGateway(name, {
      compartmentId,
      vcnId: vcn.id,
      blockTraffic: false,
      displayName: name,
      freeformTags: tags,
    })
  : undefined;

const databaseRouteTable =
  databaseNetwork && natGateway
    ? new oci.core.RouteTable(`${name}-db`, {
        compartmentId,
        vcnId: vcn.id,
        routeRules: [
          {
            destination: "0.0.0.0/0",
            destinationType: "CIDR_BLOCK",
            networkEntityId: natGateway.id,
          },
        ],
        displayName: `${name}-db`,
        freeformTags: tags,
      })
    : undefined;

/**
 * The private subnet's firewall: two inbound rules, and they are the whole of
 * whatever is put in there.
 *
 * 5432 from the application node's subnet, which holds exactly one machine. A
 * security list takes CIDRs rather than the source-group reference the AWS
 * program uses, so the subnet is the tightest source available here.
 *
 * 22 from this subnet itself, because an OCI Bastion's private endpoint has to
 * sit in the subnet it serves and nothing in here has a public address to reach
 * any other way. No `sshCidr` rule: there is no public address for such a rule
 * to admit anybody to, so it would read as an exposure that is not one.
 *
 * The same two rules whether `databaseNode` put a machine in the subnet or
 * `databaseSubnet` left it empty for a managed database. A managed one answers
 * on 5432 and nothing reaches it for a shell, so the second rule admits nobody
 * rather than admitting somebody unintended.
 *
 * Nothing from 0.0.0.0/0, on any port. `tests/single-ingress.test.ts` asserts
 * that by reading every rule rather than by trusting this paragraph.
 */
const databaseSecurityList = databaseNetwork
  ? new oci.core.SecurityList(`${name}-db`, {
      compartmentId,
      vcnId: vcn.id,
      displayName: `${name}-db`,
      egressSecurityRules: [
        // Through the NAT gateway: the package archive at first boot, the image
        // registry, and security updates afterwards. It opens no way in —
        // security list rules are stateful, so a reply is allowed and an
        // unsolicited packet from outside still matches no ingress rule.
        { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all" },
      ],
      ingressSecurityRules: [
        {
          description: "PostgreSQL, from the application node's subnet and nothing else",
          source: instanceCidr,
          sourceType: "CIDR_BLOCK",
          protocol: "6",
          tcpOptions: { min: 5432, max: 5432 },
        },
        {
          description: "SSH, from a Bastion in this subnet",
          source: databaseCidr,
          sourceType: "CIDR_BLOCK",
          protocol: "6",
          tcpOptions: { min: 22, max: 22 },
        },
      ],
      freeformTags: tags,
    })
  : undefined;

/**
 * Where the database node lives: private, with its only route to the internet
 * through the NAT gateway.
 *
 * `prohibitPublicIpOnVnic` is what makes "no machine in here is on the
 * internet" a property of the subnet rather than of every instance put in it,
 * and the instance below asks for no public address either, so it is two
 * independent reasons rather than one. It is also the property that carries the
 * guarantee when `databaseSubnet` leaves the subnet empty and an operator puts
 * a managed database in it by hand, where there is no instance of ours to ask.
 */
const databaseSubnet =
  databaseNetwork && databaseRouteTable && databaseSecurityList
    ? new oci.core.Subnet(`${name}-db`, {
        compartmentId,
        vcnId: vcn.id,
        cidrBlock: databaseCidr,
        displayName: `${name}-db`,
        dnsLabel: databaseSubnetDnsLabel,
        routeTableId: databaseRouteTable.id,
        securityListIds: [databaseSecurityList.id],
        prohibitPublicIpOnVnic: true,
        freeformTags: tags,
      })
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

// --------------------------------------------------------------- settings ---

/**
 * The stack's own settings, in OCI Vault — every SMTP password, Stripe key and
 * AdSense id given to `simple-balance:env` and `simple-balance:secrets`.
 *
 * One secret holding the whole file rather than one per setting, because the
 * machine wants all of them at once and a single read is a single grant: the
 * policy below names this secret and nothing else. Its content changes with the
 * stack, in place, as a new secret version, and the machine's timer picks the
 * new version up within five minutes.
 *
 * The vault is the stack's own unless `simple-balance:kmsVaultOcid` and
 * `kmsKeyOcid` already name one, in which case the secret lives there under
 * the same key the volumes use. Creating a vault here runs against what the
 * volume-key comment above argues, and the difference is what the vault holds.
 * That argument is about a key the *ledger's volumes* depend on, which a
 * `pulumi destroy` would leave counting down to deletion beside the data it
 * encrypts. Nothing on disk depends on this one: a destroyed stack's settings
 * vault goes into its seven-to-thirty-day pending deletion with only the
 * settings in it, and the next stack makes a new one. A DEFAULT vault and a
 * software-protected key are both free, inside Always Free.
 */
const settingsVault = kmsSelection
  ? undefined
  : new oci.kms.Vault(`${name}-settings`, {
      compartmentId,
      displayName: `${name}-settings`,
      vaultType: "DEFAULT",
      freeformTags: tags,
    });

const settingsKey = settingsVault
  ? new oci.kms.Key(`${name}-settings`, {
      compartmentId,
      displayName: `${name}-settings`,
      keyShape: { algorithm: "AES", length: 32 },
      protectionMode: "SOFTWARE",
      managementEndpoint: settingsVault.managementEndpoint,
      freeformTags: tags,
    })
  : undefined;

// A secret's name is unique within its vault for as long as the secret is
// pending deletion as well, so a destroy and a fresh `up` against the same
// customer vault would collide on a fixed name. The suffix is decided once and
// kept in state.
const settingsSuffix = new random.RandomId(`${name}-settings`, { byteLength: 3 });

const settingsSecret = new oci.vault.Secret(`${name}-settings`, {
  compartmentId,
  vaultId: settingsVault ? settingsVault.id : kmsSelection!.vaultId,
  keyId: settingsKey ? settingsKey.id : kmsKeyId!,
  secretName: pulumi.interpolate`${name}-settings-${settingsSuffix.hex}`,
  description:
    "Simple Balance: the stack's settings, fetched by the application node at every start",
  // Vault stores content as base64 of the bytes. Secret because the settings
  // file is, so the value is encrypted in Pulumi's state like the config it
  // came from.
  secretContent: {
    contentType: "BASE64",
    content: settings.appSettingsFile.apply((text) => Buffer.from(text, "utf8").toString("base64")),
  },
  freeformTags: tags,
});

// --------------------------------------------------------------- machines ---

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
      ocpus: size.application.vcpu,
      memoryInGbs: size.application.memoryGib,
    },
    sourceDetails: {
      sourceType: "image",
      sourceId: image,
      // The boot volume holds the operating system, the images and the
      // container logs, which the compose file caps. No database, so it does
      // not grow. 50 is OCI's minimum.
      bootVolumeSizeInGbs: "50",
      // Oracle's own key when the stack names none, which is what it has always
      // been and is already encryption at rest. Updatable in place on this
      // cloud, unlike AWS's, so adding one later re-wraps the data key rather
      // than replacing the machine — provided `ignoreChanges` below lets the
      // change through, which is why that list names properties rather than
      // this whole object.
      kmsKeyId,
    },
    // The hop between the hypervisor and block storage, which OCI leaves off
    // unless asked. At rest OCI encrypts boot and block volumes with
    // Oracle-managed keys and there is no property to set; in transit there is
    // one, and this is it. Set on the launch rather than under `launchOptions`
    // because that is the only place the provider accepts it at create, and
    // these machines are created once — `ignoreChanges` below means a change to
    // it would never reach a running instance anyway.
    isPvEncryptionInTransitEnabled: true,
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
    // if together they would pass OCI's 32,000-byte ceiling on metadata. An
    // apply, because the connection string carries a generated password.
    metadata: pulumi
      .all([
        databasePassword ?? pulumi.output(""),
        certificates?.caCertificate ?? pulumi.output(""),
        settingsSecret.id,
      ])
      .apply(([password, caCertificate, settingsSecretId]) =>
        instanceMetadata(
          settings,
          settings.sshPublicKey,
          database ? { url: databaseUrl(databaseDnsName, password), caCertificate } : undefined,
          { kind: "oci-vault", id: settingsSecretId, region: ociRegion, image: OCI_CLI_IMAGE },
        ),
      ),
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
    // release, a setting or a new key is applied on the machine. It is also
    // what makes the database certificate long-lived rather than renewable: a
    // re-issued one would sit in Pulumi's state and never reach either machine,
    // so rotation is the by-hand procedure the README writes down.
    //
    // Named properties rather than the whole of `sourceDetails`, and that is
    // the difference between a customer key that reaches this boot volume and
    // one that silently does not. `ignoreChanges` on a parent ignores
    // everything under it, so a `kmsKeyId` added later would be swallowed on
    // every stack that already exists while a fresh stack took it — the same
    // configuration, different encryption, and nothing said. The two named here
    // are exactly the two that used to move on their own, so a stack that sets
    // no key still plans nothing.
    ignoreChanges: ["sourceDetails.sourceId", "sourceDetails.bootVolumeSizeInGbs", "metadata"],
    // Deleted before its replacement is made, not after, which is the reverse
    // of Pulumi's default. Building the new machine first cannot work here: its
    // VNIC's hostname label has to be unique in the subnet and the old one is
    // still holding "app", and the Always Free A1 allowance has no room for a
    // third machine anyway. The address is ephemeral and changes on a
    // replacement either way, so building first would buy nothing.
    deleteBeforeReplace: true,
  },
);

/**
 * The tenancy this compartment is in, found by walking up from it.
 *
 * A dynamic group lives in the tenancy's root compartment and nowhere else, and
 * asking the stack for the tenancy's OCID as well as the compartment's would
 * be a second setting that could disagree with the first. Compartments nest at
 * most six deep, so the walk is short, and the root is the one whose OCID says
 * `tenancy`.
 */
async function tenancyOf(compartment: string): Promise<string> {
  let id = compartment;
  for (let depth = 0; depth < 8 && !id.startsWith("ocid1.tenancy."); depth += 1) {
    id = (await oci.identity.getCompartment({ id })).compartmentId;
  }
  if (!id.startsWith("ocid1.tenancy.")) {
    throw new Error(
      `Could not find the tenancy above simple-balance:compartmentOcid ${compartment}.`,
    );
  }
  return id;
}

/**
 * The application node, and only it, may read the settings secret.
 *
 * An instance principal — the machine's own identity, which OCI rotates and
 * nobody holds — rather than an API key on the machine, which would be a
 * credential to the whole tenancy sitting on a disk. The dynamic group matches
 * this one instance by OCID; the policy lets that group read the bundles of
 * this one secret and do nothing else. A replaced machine has a new OCID, and
 * the next `pulumi up` moves the rule to it.
 *
 * The grant names the instance, so it can only exist after the instance does,
 * and OCI takes a minute or two to honour a new one. The machine's fetch waits
 * up to ten minutes on a first boot for that reason.
 *
 * Creating a dynamic group needs permission in the tenancy's root compartment,
 * which the API key running `pulumi up` usually has and a tightly scoped one may
 * not. On a tenancy with identity domains this is the Default domain's group,
 * which the policy names without a domain prefix.
 */
const settingsReaders = new oci.identity.DynamicGroup(`${name}-settings`, {
  compartmentId: pulumi.output(tenancyOf(compartmentId)),
  name: `${name}-settings`,
  description: "Simple Balance: the application node that reads this stack's settings",
  matchingRule: pulumi.interpolate`ALL {instance.id = '${instance.id}'}`,
  freeformTags: tags,
});

new oci.identity.Policy(`${name}-settings`, {
  compartmentId,
  name: `${name}-settings`,
  description: "Simple Balance: the application node reads this stack's settings secret",
  statements: [
    pulumi.interpolate`Allow dynamic-group ${settingsReaders.name} to read secret-bundles in compartment id ${compartmentId} where target.secret.id = '${settingsSecret.id}'`,
  ],
  freeformTags: tags,
});

/**
 * The application node's data disk, separate from the boot volume and
 * outliving it.
 *
 * It holds the generated secret, the database's CA certificate and
 * the nightly dumps — not the ledger, which is on the database node's volume.
 * Replacing the instance destroys the boot volume and leaves this one, and the
 * first-boot script formats it only when it is not already a filesystem, so a
 * rebuild keeps all of it. Never smaller than OCI's 50 GB floor, which the
 * shared table's `small` is under.
 */
const dataGb = dataVolumeGb(size.application);
const databaseDataGb = database ? dataVolumeGb(database.size.database) : 0;

/**
 * Protected unless the stack says otherwise, because the two data volumes are
 * the resources here that the next `pulumi up` cannot rebuild. A destroyed
 * network or machine comes back from configuration; the ledger, the secret
 * and the dumps exist nowhere else unless somebody copied them.
 *
 * `protect` makes Pulumi refuse any deployment that would delete a volume:
 * `pulumi destroy`, which fails at its preview and deletes nothing, and a
 * replacement, which is what a new availabilityDomain asks for. Pulumi refuses
 * that one only on reaching the volume, after the instance, which under
 * `--skip-preview` is too late for the machine, so the program refuses it
 * first, at the availability domain. A resize is an update rather than a
 * delete and goes through. The console and the `oci` CLI are outside it.
 *
 * Built after its instance, which it has no other use for, so that it exists
 * only once a machine has launched. `Out of host capacity` is how an Always
 * Free launch usually fails, and the answer `docs/deployment-costs.md` gives is
 * another availabilityDomain. Built alongside the network, the volume would
 * already be there when the launch failed, empty and protected, and that retry
 * would be refused for guarding nothing — on every domain tried, since each
 * attempt leaves a new one. Built after, a failed launch leaves no volume
 * anywhere, and the protection starts when there is first something on the
 * disk to protect.
 *
 * The cost is at teardown. Pulumi keeps everything a protected resource was
 * built after, so `pulumi destroy --exclude-protected` deletes only the
 * attachments, and so does `--skip-preview` before it stops at the first
 * volume. The machines and the network stay, and each machine goes on running
 * without its disk until the next `up` attaches it again and a reboot mounts
 * it. Neither flag is a way to keep the volumes and drop the rest.
 *
 * A switch in the stack rather than a constant, so tearing down on purpose is
 * a decision recorded where the stack's others are rather than an edit to the
 * program, which is what Pulumi's refusal suggests: set
 * `simple-balance:protectDataVolume` to false and run `pulumi up`, which
 * changes no resource and only the flag in Pulumi's state, then `pulumi
 * destroy`. `pulumi state unprotect` clears the flag for one destroy instead,
 * and the next `up` sets it again while the setting is true.
 */
const dataVolume = new oci.core.Volume(
  name,
  {
    compartmentId,
    availabilityDomain,
    displayName: dataVolumeName,
    sizeInGbs: String(dataGb),
    // Oracle's own key unless the stack named one, and unset is still the
    // default rather than an omission. OCI
    // encrypts every boot and block volume at rest
    // with an Oracle-managed key and offers no way to turn that off, so a stack
    // that sets nothing is already encrypted and has no vault, no key policy to
    // get wrong, no monthly charge and no way to lock itself out of its own
    // ledger. `simple-balance:kmsKeyOcid` is for a deployment whose key policy
    // says where keys come from, and it is checked before it is used.
    kmsKeyId,
    freeformTags: tags,
  },
  {
    protect: protectDataVolume,
    // An ordering and nothing more. Taking it from a property of the instance
    // instead, its availabilityDomain say, would make the volume a dependent
    // replacement of the instance: every `pulumi up --replace` of the machine
    // would then refuse while the volume is protected, and delete it while it
    // is not.
    dependsOn: [instance],
  },
);

new oci.core.VolumeAttachment(
  name,
  {
    instanceId: instance.id,
    volumeId: dataVolume.id,
    // Paravirtualized rather than iSCSI, which is the difference between a disk
    // the guest simply has and one cloud-init has to run three `iscsiadm`
    // commands to find. It is also what makes the flag below available: OCI
    // offers in-transit encryption on paravirtualized attachments only.
    attachmentType: "paravirtualized",
    // The instance's own flag covers its boot volume; this one covers the
    // attached volume, and both are needed for the whole of the machine's disk
    // traffic to be encrypted. Two flags because they are two hops, not because
    // either is a restatement of the other.
    isPvEncryptionInTransitEnabled: true,
    device: "/dev/oracleoci/oraclevdb",
  },
  {
    // A new instance means a new attachment, and Pulumi's default builds the
    // replacement before removing the old one. OCI refuses to attach a volume
    // that is still attached elsewhere, so that order fails the update with
    // two machines and the volume on the old one. Removing first detaches it
    // and then attaches it to the new one. firstboot waits for the device as
    // long as this provider gives the attachment, and the volume's creation
    // before it on a first launch, and the README says what to do when a move
    // fails outright.
    deleteBeforeReplace: true,
  },
);

/**
 * The database node.
 *
 * No public address at all — the subnet refuses one and this asks for none, so
 * there are two independent reasons rather than one — and two inbound rules,
 * for 5432 from the application node's subnet and 22 from a Bastion in its own.
 *
 * Its user data carries the server certificate, the server's private key and
 * the application role's password, and none of the three is the dangerous one:
 * the superuser password is generated on the machine itself, and the CA's
 * private key is in Pulumi's state and in neither machine's user data. So
 * nobody who can read this instance's metadata can mint a certificate for this
 * database or sign in as the cluster's owner.
 */
const databaseInstance =
  database && databaseSubnet && certificates && databasePassword
    ? new oci.core.Instance(
        `${name}-db`,
        {
          compartmentId,
          availabilityDomain,
          displayName: `${name}-db`,
          shape: "VM.Standard.A1.Flex",
          shapeConfig: {
            ocpus: database.size.database.vcpu,
            memoryInGbs: database.size.database.memoryGib,
          },
          sourceDetails: {
            sourceType: "image",
            sourceId: image,
            // The operating system, the postgres image, and the certificate and
            // key cloud-init wrote. Not the cluster, which is on the data
            // volume, and not the superuser password, which is there too.
            bootVolumeSizeInGbs: "50",
            kmsKeyId,
          },
          isPvEncryptionInTransitEnabled: true,
          createVnicDetails: {
            subnetId: databaseSubnet.id,
            // Said although the subnet already refuses one, so that "this
            // machine is not on the internet" is two properties rather than
            // one, and so that a subnet edited later cannot quietly give it an
            // address.
            assignPublicIp: "false",
            hostnameLabel: databaseHostLabel,
            // Said rather than left to the provider's default, because the
            // whole connection depends on it. DATABASE_URL names this machine
            // by `db.db.simplebalance.oraclevcn.com` and nothing else: node's
            // TLS client sends no SNI for a literal address — `pg` sets
            // `servername` only when `net.isIP(host)` is 0 — so Node compares
            // the certificate against the string `localhost` and verification
            // fails however many IP SANs the certificate carries. The name is
            // therefore load-bearing, and a VNIC with no private DNS record
            // yields no record rather than an error: the symptom would be
            // ENOTFOUND at the first connection, long after `pulumi up` said
            // it was done.
            assignPrivateDnsRecord: true,
            // Pinned, because the certificate's subject alternative names were
            // decided from it before this instance existed. The IP SAN is for
            // libpq — `psql`, `pg_dump`, `simple-balance-restore` — which does
            // verify one, and which is how the backups and any debugging by
            // hand reach this machine.
            privateIp: databasePrivateIp,
          },
          // The only way onto a machine with no public address, and it is free.
          agentConfig: {
            pluginsConfigs: [{ name: "Bastion", desiredState: "ENABLED" }],
          },
          metadata: pulumi
            .all([databasePassword, certificates.serverCertificate, certificates.serverKey])
            .apply(([applicationPassword, serverCertificate, serverKey]) =>
              databaseInstanceMetadata(
                {
                  settings,
                  database,
                  bindAddress: databasePrivateIp,
                  applicationCidr: instanceCidr,
                  applicationPassword,
                  serverCertificate,
                  serverKey,
                },
                settings.sshPublicKey,
              ),
            ),
          freeformTags: tags,
        },
        // The same three, for the same reasons, as the application node's.
        {
          ignoreChanges: [
            "sourceDetails.sourceId",
            "sourceDetails.bootVolumeSizeInGbs",
            "metadata",
          ],
          deleteBeforeReplace: true,
        },
      )
    : undefined;

/**
 * The database node's data disk, which holds the ledger.
 *
 * The same protection and the same reasoning as the volume above, and rather
 * more at stake: the cluster is here, and so is the superuser password that
 * exists nowhere else — not in Pulumi's state, not in instance metadata, and in
 * no answer any provider API gives. Losing this volume is losing the
 * deployment, where losing the other one is losing its backups.
 */
const databaseVolume = databaseInstance
  ? new oci.core.Volume(
      `${name}-db`,
      {
        compartmentId,
        availabilityDomain,
        displayName: databaseVolumeName,
        sizeInGbs: String(databaseDataGb),
        kmsKeyId,
        freeformTags: tags,
      },
      {
        protect: protectDataVolume,
        dependsOn: [databaseInstance],
      },
    )
  : undefined;

if (databaseInstance && databaseVolume) {
  new oci.core.VolumeAttachment(
    `${name}-db`,
    {
      instanceId: databaseInstance.id,
      volumeId: databaseVolume.id,
      attachmentType: "paravirtualized",
      isPvEncryptionInTransitEnabled: true,
      device: "/dev/oracleoci/oraclevdb",
    },
    { deleteBeforeReplace: true },
  );
}

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
 *
 * Only the application node is looked up this way. The database node's address
 * is a constant this program chose, so there is nothing to read back.
 */
const vnic = oci.core
  .getVnicAttachmentsOutput({ compartmentId, instanceId: instance.id })
  .apply((result) => oci.core.getVnicOutput({ vnicId: result.vnicAttachments[0]!.vnicId }));

const publicIpAddress = vnic.apply((details) => details.publicIpAddress);
const privateIpAddress = vnic.apply((details) => details.privateIpAddress);

export const region = ociRegion;
export const publicIp = publicIpAddress;
export const privateIp = privateIpAddress;
export const instanceId = instance.id;
export const dataVolumeId = dataVolume.id;
export const settingsSecretId = settingsSecret.id;
export const subnetId = subnet.id;
export const databaseSubnetId = databaseSubnet?.id;
export const databaseInstanceId = databaseInstance?.id;
export const databaseVolumeId = databaseVolume?.id;
export const databasePrivateIpAddress = database ? databasePrivateIp : undefined;
/** The name in the certificate and in DATABASE_URL, for an operator debugging either. */
export const databaseHostName = database ? databaseDnsName : undefined;
export const url = `https://${settings.hostname}`;
export const machine = `VM.Standard.A1.Flex — ${size.application.vcpu} OCPU, ${size.application.memoryGib} GB, ${dataGb} GB data`;
export const databaseMachine = database
  ? `VM.Standard.A1.Flex — ${database.size.database.vcpu} OCPU, ${database.size.database.memoryGib} GB, ${databaseDataGb} GB data, PostgreSQL 18`
  : undefined;

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
   ${databaseDnsName} against a CA this stack issued, and firstboot has started
   the deployment. That machine is reached by a Bastion in its own subnet, the same way
   as this one but with --target-subnet-id 'pulumi stack output databaseSubnetId' and
   --target-private-ip ${databasePrivateIp}; on it,
     sudo docker compose -f /opt/simple-balance/compose.postgres.yml exec postgres \\
       psql -U postgres simple_balance
   To point this machine at a database of your own instead, set your own DATABASE_URL
   in simple-balance:secrets: the stack's settings win over the generated one, with
   nothing to turn off first.`
  : `3. Give it a database. None was created, because simple-balance:databaseNode is false.
   On the machine, install the certificate of the CA that signed the database's:
     sudo install -m 0644 ca.pem /var/lib/simple-balance/tls/db-ca.pem
         (the DB system's CA certificate: its Connection details, or oci psql connection-details get)
   Where you run Pulumi, give the stack the connection string and apply it:
     pulumi config set --secret --path 'simple-balance:secrets.DATABASE_URL' \\
       'postgresql://user:password@<FQDN>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
     pulumi up
   and, if that URL goes through a transaction pooler, secrets.DIRECT_DATABASE_URL beside
   it, the same database past the pooler, for the migrations and the first-account claim.
   Then, on the machine, run
     sudo /usr/local/sbin/simple-balance-firstboot
   which starts the deployment and its nightly backup. Until then it is installed and
   stopped, and /etc/motd says so.`;

export const nextSteps = pulumi.interpolate`
1. Point ${settings.hostname} at ${publicIpAddress} with an A record.
   Caddy cannot obtain a certificate until it resolves, and it retries until it does.
   The address is ephemeral: promote it to reserved in the OCI console if the record
   has to outlive this instance.
${reach}
   Once in, wait for the first boot to finish:  sudo cloud-init status --wait
${databaseStep}
4. Find the setup code:   sudo docker compose -f /opt/simple-balance/compose.yml logs app | grep -i setup
5. Optional settings — SMTP, Stripe, AdSense and the PRIVACY_POLICY_URL it requires,
   TERMS_OF_USE_URL — are the stack's: simple-balance:env, and simple-balance:secrets
   with --secret for the secret ones, then 'pulumi up'. They are kept in OCI Vault
   (secret ${settingsSecret.id}), and the machine applies a change within five minutes.
   deploy/pulumi/README.md, "The application's settings", has both ways to set them.
6. A later 'pulumi up' does not re-run either machine's setup. How to apply a change
   is at the top of what it ran:   sudo cloud-init query userdata | head -16
`;
