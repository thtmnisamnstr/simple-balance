import * as k8s from "@pulumi/kubernetes";
import * as oci from "@pulumi/oci";
import * as pulumi from "@pulumi/pulumi";

import * as sb from "../common";

/**
 * The `ha` profile on Oracle Cloud, as the `aws/` program is on EKS.
 *
 * Everything above the cluster is shared: `../common` reads the same settings,
 * installs the same cert-manager, and deploys the same chart from
 * `deploy/helm`. What differs is below it, and the differences are OKE's rather
 * than choices — a VCN instead of a VPC, a network load balancer the cloud
 * controller manager provisions from a Service, and a kubeconfig that shells
 * out to the `oci` CLI the way EKS's shells out to `aws`.
 *
 * Two places where this is deliberately simpler than the AWS program, each
 * because OKE supplies something EKS does not:
 *
 * - No CSI driver to install. OKE ships the block-volume CSI and the cloud
 *   controller manager as cluster add-ons, where EKS needs the EBS CSI driver
 *   and the AWS Load Balancer Controller installed as releases of their own.
 * - No proxy protocol. The AWS program carries a long argument for it because
 *   an NLB with IP targets says nothing about who connected to it, so every
 *   visitor would share one sign-in allowance. An OCI network load balancer
 *   passes the packet through, so `externalTrafficPolicy: Local` is enough and
 *   ingress-nginx sees the visitor's own address — the same guarantee by a
 *   cheaper route, and one that cannot half-fail the way a proxy-protocol
 *   mismatch does at both ends.
 */

const ingressNginxVersion = "4.15.1";

const settings = sb.readSettings();

// Read from the key the default provider is configured from, so the region
// checked and exported is the one every resource below is built in. The
// single-machine program states the same reason at more length: unset, the
// provider takes OCI_REGION or whichever ~/.oci/config profile runs
// `pulumi up`, and the cluster would then be built where the shell says rather
// than where the stack does.
const region = new pulumi.Config("oci").get("region");
if (!region) {
  throw new Error(
    "oci:region is required, in this stack: pulumi config set oci:region <region>, " +
      "for example us-ashburn-1.",
  );
}

// OCI has no notion of a default compartment: every resource is created in one,
// and the tenancy's root compartment is a poor choice because its policies
// cannot be scoped. Required rather than defaulted, as in `../oci-single`.
const cfg = new pulumi.Config("simple-balance");
const compartmentId = cfg.require("compartmentOcid");

/*
 * OKE requires a version where EKS defaults to one, so this program cannot do
 * what `../aws/` does and leave it unset. `simple-balance:kubernetesVersion`
 * still wins when an operator sets it; what differs is only that there has to
 * be a fallback for when they have not. Upgrading is that setting, deliberately,
 * rather than this constant moving under a running cluster on the next `up` —
 * which is also why it is not read from the API, tempting as that is: the
 * newest version OKE offers is a different number every few weeks, and a
 * cluster whose version follows it would be upgraded by running `pulumi up`
 * for an unrelated reason.
 *
 * A pinned constant does go stale, and the failure that taught this was ugly:
 * a version OKE no longer offers matched no node image, and the error arrived
 * from the image lookup as "cannot read properties of undefined", which names
 * neither the version nor the cause. `assertVersionOffered` below turns that
 * into a refusal naming what the region actually has.
 */
const kubernetesVersion = settings.kubernetesVersion ?? "v1.35.2";

const tags = { Project: "simple-balance", Profile: "ha", PulumiStack: pulumi.getStack() };
const name = "simple-balance";

// Named rather than repeated, because the API endpoint's security rules are
// written against the worker subnet from above the subnet that defines it. A
// CIDR spelled in two places is a CIDR that gets changed in one.
const vcnCidr = "10.0.0.0/16";
const publicCidr = "10.0.0.0/24";
const privateCidr = "10.0.16.0/20";

// ------------------------------------------------------------------ network ---

const vcn = new oci.core.Vcn(name, {
  compartmentId,
  cidrBlocks: [vcnCidr],
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

// The workers have no public addresses, so without this they cannot pull the
// images from ghcr.io, reach Let's Encrypt, or reach a database outside this
// VCN. The same sentence as the GCP program's Cloud NAT, for the same reason.
const natGateway = new oci.core.NatGateway(name, {
  compartmentId,
  vcnId: vcn.id,
  displayName: name,
  freeformTags: tags,
});

// Oracle's own services — object storage, the registry, the telemetry the node
// agents write to — reached without going through the NAT gateway. It is free,
// it keeps that traffic off the public internet, and OKE's node agents assume
// it: without one, a private node pool comes up but its agents cannot report.
const services = oci.core.getServicesOutput({});
const serviceGateway = new oci.core.ServiceGateway(name, {
  compartmentId,
  vcnId: vcn.id,
  services: [{ serviceId: services.apply((s) => s.services[0]!.id) }],
  displayName: name,
  freeformTags: tags,
});

const publicRouteTable = new oci.core.RouteTable(`${name}-public`, {
  compartmentId,
  vcnId: vcn.id,
  routeRules: [
    {
      destination: "0.0.0.0/0",
      destinationType: "CIDR_BLOCK",
      networkEntityId: internetGateway.id,
    },
  ],
  displayName: `${name}-public`,
  freeformTags: tags,
});

const privateRouteTable = new oci.core.RouteTable(`${name}-private`, {
  compartmentId,
  vcnId: vcn.id,
  routeRules: [
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: natGateway.id },
    {
      destination: services.apply((s) => s.services[0]!.cidrBlock),
      destinationType: "SERVICE_CIDR_BLOCK",
      networkEntityId: serviceGateway.id,
    },
  ],
  displayName: `${name}-private`,
  freeformTags: tags,
});

// 6 is TCP and 1 is ICMP. OCI takes IANA protocol numbers rather than names,
// and "all" here would be every port rather than every protocol.
const publicSecurityList = new oci.core.SecurityList(`${name}-public`, {
  compartmentId,
  vcnId: vcn.id,
  displayName: `${name}-public`,
  egressSecurityRules: [
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all" },
  ],
  ingressSecurityRules: [
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
      // The Kubernetes API endpoint shares this subnet, and OKE opens nothing
      // on its own behalf. With 80 and 443 the only way in, the cluster builds,
      // reports itself ACTIVE, and then never produces a ready node, because
      // every kubelet's attempt to register is dropped before it arrives.
      // `pulumi preview` cannot see it: the rules and the cluster both plan
      // cleanly, and only a real `pulumi up` meets a node pool that stays empty.
      description: "Kubernetes API, from the workers",
      source: privateCidr,
      sourceType: "CIDR_BLOCK",
      protocol: "6",
      tcpOptions: { min: 6443, max: 6443 },
    },
    {
      // OKE's second control-plane port, which a kubelet uses to collect the
      // credentials it registers with. Closed, it produces nodes that join and
      // then go NotReady rather than no nodes at all — the harder of the two to
      // attribute to a firewall, because the cluster looks half-built.
      description: "OKE worker-to-control-plane, from the workers",
      source: privateCidr,
      sourceType: "CIDR_BLOCK",
      protocol: "6",
      tcpOptions: { min: 12250, max: 12250 },
    },
    {
      description: "Path MTU discovery, from the workers",
      source: privateCidr,
      sourceType: "CIDR_BLOCK",
      protocol: "1",
      icmpOptions: { type: 3, code: 4 },
    },
    // `kubectl`, and Pulumi's own Kubernetes provider, which installs
    // ingress-nginx into this cluster in the same `pulumi up` that creates it —
    // so this rule is not an operator convenience, it is what lets the program
    // finish. Unset leaves it open, which is what `controlPlaneCidrs` means on
    // the other two clouds and what keeps a stack moved from one of them
    // planning the same thing here. Narrowing it stays the operator's to do,
    // for the reason `common/index.ts` gives where the setting is parsed: this
    // program cannot know where its operator is, and a wrong guess locks the
    // stack out of the control plane it would need in order to repair itself.
    ...(settings.controlPlaneCidrs.length > 0 ? settings.controlPlaneCidrs : ["0.0.0.0/0"]).map(
      (source) => ({
        description: "Kubernetes API",
        source,
        sourceType: "CIDR_BLOCK",
        protocol: "6",
        tcpOptions: { min: 6443, max: 6443 },
      }),
    ),
  ],
});

// Nothing from outside the VCN. The workers are reached through the API server
// and the load balancer, both of which sit in the subnets above, and a node
// that answered the internet directly would be a second way in to the thing
// holding the ledger's volumes.
const privateSecurityList = new oci.core.SecurityList(`${name}-private`, {
  compartmentId,
  vcnId: vcn.id,
  displayName: `${name}-private`,
  egressSecurityRules: [
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", protocol: "all" },
  ],
  ingressSecurityRules: [
    {
      description: "Everything inside this VCN: pod to pod, load balancer to node, API to kubelet",
      source: vcnCidr,
      sourceType: "CIDR_BLOCK",
      protocol: "all",
    },
    {
      // Path-MTU discovery. Without it a large response to a client behind a
      // smaller MTU is dropped silently and the connection hangs rather than
      // failing, which is the shape of bug nobody attributes to a firewall.
      description: "Path MTU discovery",
      source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK",
      protocol: "1",
      icmpOptions: { type: 3, code: 4 },
    },
  ],
});

// The load balancer's subnet, and the API server's. Public because the
// certificate is answered over HTTP-01 on the first and `kubectl` reaches the
// second; the workers are in neither.
const publicSubnet = new oci.core.Subnet(`${name}-public`, {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: publicCidr,
  displayName: `${name}-public`,
  dnsLabel: "pub",
  routeTableId: publicRouteTable.id,
  securityListIds: [publicSecurityList.id],
  prohibitPublicIpOnVnic: false,
  freeformTags: tags,
});

const privateSubnet = new oci.core.Subnet(`${name}-private`, {
  compartmentId,
  vcnId: vcn.id,
  cidrBlock: privateCidr,
  displayName: `${name}-private`,
  dnsLabel: "priv",
  routeTableId: privateRouteTable.id,
  securityListIds: [privateSecurityList.id],
  // The property rather than the convention. A worker subnet that permits a
  // public address is one VNIC away from a node on the internet.
  prohibitPublicIpOnVnic: true,
  freeformTags: tags,
});

// ------------------------------------------------------------------ cluster ---

const inClusterDatabase = settings.database === "in-cluster";

const cluster = new oci.containerengine.Cluster(name, {
  compartmentId,
  vcnId: vcn.id,
  name,
  kubernetesVersion,
  // BASIC rather than ENHANCED, and it is a cost decision stated rather than a
  // default taken: an enhanced cluster bills per cluster per hour for features
  // this deployment does not use — add-on lifecycle management, workload
  // identity, a higher node ceiling. The chart asks for none of them.
  type: "BASIC_CLUSTER",
  endpointConfig: {
    subnetId: publicSubnet.id,
    isPublicIpEnabled: true,
  },
  options: {
    serviceLbSubnetIds: [publicSubnet.id],
    kubernetesNetworkConfig: {
      podsCidr: "10.244.0.0/16",
      servicesCidr: "10.96.0.0/16",
    },
  },
  freeformTags: tags,
});

// The image a node boots is tied to the Kubernetes version, so it is looked up
// rather than pinned: a hard-coded OCID is a value that stops existing when
// Oracle retires the image, and the failure is a node pool that never produces
// a node.
// No `compartmentId`, and the omission is load-bearing rather than tidy. Node
// pool options are tenancy-scoped: asking for them in the deployment's own
// compartment answers "Authorization failed or requested resource not found",
// which this provider turns into an empty result rather than an error. The
// image lookup below then finds nothing and reports a missing image, naming
// neither the compartment nor the permission — so the one wrong argument
// surfaces as a fact about Oracle's image catalogue. Asked without a
// compartment it answers for the tenancy, which is the only scope the option
// set has.
const nodePoolOptions = oci.containerengine.getNodePoolOptionOutput({
  nodePoolOptionId: "all",
});

const availabilityDomains = oci.identity.getAvailabilityDomainsOutput({ compartmentId });

const nodePool = new oci.containerengine.NodePool(name, {
  compartmentId,
  clusterId: cluster.id,
  name,
  kubernetesVersion: cluster.kubernetesVersion,
  // Ampere, as `../oci-single` runs, and the node images bear it out: every
  // current OKE source in this tenancy is aarch64. All four application images
  // and the Citus image are published for linux/arm64 as well as linux/amd64,
  // so the chart runs here unchanged, and the shape is materially cheaper per
  // core than the x86 flexible shapes.
  nodeShape: "VM.Standard.A1.Flex",
  nodeShapeConfig: {
    ocpus: 2,
    memoryInGbs: 16,
  },
  nodeSourceDetails: {
    sourceType: "IMAGE",
    imageId: nodePoolOptions.apply((options) => {
      // The version is checked before the image is looked for, so a version the
      // region does not offer is a refusal naming the ones it does rather than
      // a failure inside this lookup.
      const offered = options.kubernetesVersions ?? [];
      if (offered.length > 0 && !offered.includes(kubernetesVersion)) {
        throw new Error(
          `OKE in this region does not offer Kubernetes ${kubernetesVersion}. ` +
            `It offers: ${offered.slice(-6).join(", ")}. ` +
            "Set simple-balance:kubernetesVersion to one of those.",
        );
      }
      // Both halves matter. The minor has to agree because OKE refuses a node
      // image built for another one; the architecture has to agree because the
      // sources list carries both and an aarch64 image on an x86 shape fails
      // at the node rather than at the pool, which reads as a capacity problem.
      const minor = kubernetesVersion.replace(/^v/, "").split(".").slice(0, 2).join(".");
      const source = (options.sources ?? []).find(
        (candidate) =>
          candidate.sourceName.includes(`OKE-${minor}`) && candidate.sourceName.includes("aarch64"),
      );
      if (!source) {
        throw new Error(
          `No aarch64 OKE node image for Kubernetes ${minor} in this region. ` +
            "`oci ce node-pool-options get --node-pool-option-id all` lists what there is.",
        );
      }
      return source.imageId;
    }),
  },
  nodeConfigDetails: {
    size: settings.database === "in-cluster" ? 4 : 3,
    // Encrypts the hop between a node and its disks: the boot volume, and every
    // paravirtualized volume the CSI driver attaches, which decides from this
    // node's own launch options. Off unless asked for, and it is a launch
    // property, so a pool that turns it on gives it to the nodes it makes from
    // then on and not to the ones already running.
    isPvEncryptionInTransitEnabled: true,
    placementConfigs: availabilityDomains.apply((domains) =>
      // Every domain the region has. A region with one — several have — gets
      // one entry and the pool is spread across fault domains inside it
      // instead, which is what OKE does with a single placement config anyway.
      (domains.availabilityDomains ?? []).map((domain) => ({
        availabilityDomain: domain.name,
        subnetId: privateSubnet.id,
      })),
    ),
  },
  freeformTags: tags,
});

// OKE generates this rather than it being assembled by hand, which is the
// difference from the GCP program: the token command, its arguments and the
// API server's certificate all come from the service. It shells out to the
// `oci` CLI the way the EKS kubeconfig shells out to `aws`, so an operator
// needs that CLI installed to reach the cluster even though `pulumi up` does
// not.
const kubeconfig = oci.containerengine
  .getClusterKubeConfigOutput({ clusterId: cluster.id })
  .apply((config) => config.content);

const k8sProvider = new k8s.Provider("oke", { kubeconfig }, { dependsOn: [nodePool] });

// The class the ledger's volumes are cut from.
//
// No `kms-key-id`, and that is the decision rather than an omission, for the
// reason `../oci-single` gives at more length: Oracle encrypts every block
// volume at rest with keys it manages and offers no way to turn that off, so
// there is nothing to say here short of a key of our own, and that buys a key
// policy to get wrong and a way to lock a deployment permanently out of its own
// ledger volume.
//
// What the class is for is the three properties OKE's own default does not set
// the way a database wants them.
const databaseStorageClass = new k8s.storage.v1.StorageClass(
  `${name}-block`,
  {
    metadata: { name: `${name}-block` },
    provisioner: "blockvolume.csi.oraclecloud.com",
    parameters: {
      // Paravirtualized rather than iSCSI: the CSI driver attaches it without
      // the node running an iscsiadm login, which is one fewer thing to fail on
      // a node that was replaced while a volume was attached, and it is the
      // only attachment OCI encrypts in transit. Hyphenated, because that is
      // the key the driver reads. This was `attachmentType` until 0.2.1, which
      // the driver ignores without a word, so every volume this class made
      // before then is attached over iSCSI and keeps that attachment for life.
      "attachment-type": "paravirtualized",
      // 10 VPUs per GB is Oracle's "balanced" tier. Said although it is also
      // the driver's default today, because 0 is the lowest-cost tier and the
      // wrong one for a database's WAL, and a default can move.
      vpusPerGB: "10",
    },
    // A volume lives in one availability domain and a pod that needs it has to
    // be scheduled there. Binding immediately would cut the volume wherever the
    // provisioner chose and then hope a node was free in it.
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
    // Retain rather than Delete, because `kubectl delete pvc` by mistake is one
    // keystroke and a stray volume costs a few dollars a month until somebody
    // removes it on purpose.
    reclaimPolicy: "Retain",
  },
  {
    provider: k8sProvider,
    // A class's parameters cannot be changed in place, so changing one
    // replaces it, and the replacement has to keep this name because the
    // chart's claims ask for it by name. Removing the old one first is the only
    // order that can work, and it touches nothing a claim already holds: a
    // bound volume carries its own copy of what it was provisioned with.
    deleteBeforeReplace: true,
  },
);

// --------------------------------------------------------------- ingress ---

const ingressNginx = new k8s.helm.v3.Release(
  "ingress-nginx",
  {
    name: "ingress-nginx",
    chart: "ingress-nginx",
    version: ingressNginxVersion,
    repositoryOpts: { repo: "https://kubernetes.github.io/ingress-nginx" },
    namespace: "ingress-nginx",
    createNamespace: true,
    values: {
      controller: {
        replicaCount: 2,
        service: {
          annotations: {
            // A network load balancer rather than the classic one. It is the
            // closest thing OCI has to the NLB the AWS program asks for: layer
            // four, pass-through, and it preserves the source address, which is
            // what makes the line below sufficient.
            "oci.oraclecloud.com/load-balancer-type": "nlb",
            "oci-network-load-balancer.oraclecloud.com/security-list-management-mode": "None",
          },
          // The visitor's address, and the whole of what the AWS program needs
          // proxy protocol for. `Local` keeps kube-proxy from forwarding the
          // connection to another node and rewriting the source on the way, so
          // the address ingress-nginx sees is the one that connected. It costs
          // a hop of load balancing — a node with no controller pod fails its
          // health check and takes no traffic — which is why the replica count
          // above is two rather than one.
          externalTrafficPolicy: "Local",
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [nodePool] },
);

// Read off the Service rather than reserved in advance, which is what the AWS
// program does and for the same reason: the cloud controller manager creates
// the load balancer when it sees the Service, and the address it is given is
// the one the DNS record has to name.
const ingressAddress = k8s.core.v1.Service.get(
  "ingress-nginx-controller",
  pulumi.interpolate`ingress-nginx/ingress-nginx-controller`,
  { provider: k8sProvider, dependsOn: [ingressNginx] },
).status.apply((status) => status?.loadBalancer?.ingress?.[0]?.ip ?? "");

// ------------------------------------------------------------ application ---

const certManager = sb.certManager({
  provider: k8sProvider,
  settings,
  solverIngress: { class: "nginx" },
  dependsOn: [nodePool],
});

const app = sb.simpleBalance({
  provider: k8sProvider,
  settings,
  issuerName: certManager.issuerName,
  ingressClassName: "nginx",
  // What connects to the frontend is an ingress-nginx pod, and its address is
  // an address in this VCN. The whole VCN rather than the private subnet,
  // because every pod draws from the same subnet and the narrower list would
  // trust exactly the same pods while breaking the day a subnet is added —
  // the AWS program's reasoning, which holds here unchanged.
  //
  // Recursion off: ingress-nginx replaces X-Forwarded-For with `$remote_addr`
  // unless use-forwarded-headers is on, and it is not on here. With the load
  // balancer preserving the source address, that value is the visitor.
  trustedProxies: { addresses: [vcn.cidrBlocks.apply((blocks) => blocks[0]!)], recursive: false },
  databaseStorageClass: inClusterDatabase ? databaseStorageClass.metadata.name : undefined,
  dependsOn: [certManager.clusterIssuer, ingressNginx, databaseStorageClass],
});

export const clusterName = cluster.name;
export { kubeconfig };
export const namespace = app.namespace.metadata.name;
export const ingressIpAddress = ingressAddress;
export const appUrl = `https://${settings.hostname}/`;
export const dnsRecord = pulumi.interpolate`${settings.hostname}. A ${ingressAddress}`;
