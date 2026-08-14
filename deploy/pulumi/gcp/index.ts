import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import * as sb from "../common";

const settings = sb.readSettings();

const project = gcp.config.project;
if (!project) {
  throw new Error("No GCP project. Set one with `pulumi config set gcp:project my-project`.");
}

const region = gcp.config.region;
if (!region) {
  throw new Error("No GCP region. Set one with `pulumi config set gcp:region us-central1`.");
}

const labels = { project: "simple-balance", "pulumi-stack": pulumi.getStack() };

const network = new gcp.compute.Network("simple-balance", {
  name: "simple-balance",
  autoCreateSubnetworks: false,
});

const subnetwork = new gcp.compute.Subnetwork("simple-balance", {
  name: "simple-balance",
  network: network.id,
  region,
  ipCidrRange: "10.0.0.0/20",
  privateIpGoogleAccess: true,
  secondaryIpRanges: [
    { rangeName: "pods", ipCidrRange: "10.4.0.0/14" },
    { rangeName: "services", ipCidrRange: "10.8.0.0/20" },
  ],
});

const router = new gcp.compute.Router("simple-balance", {
  name: "simple-balance",
  network: network.id,
  region,
});

// Reserved rather than auto-allocated so the database can allow one address
// that stays put, instead of whatever Cloud NAT picked this week.
const natAddress = new gcp.compute.Address("simple-balance-nat", {
  name: "simple-balance-nat",
  region,
  addressType: "EXTERNAL",
});

// The nodes have no external addresses, so without this they cannot pull the
// images from ghcr.io or reach a database that lives outside this VPC.
const nat = new gcp.compute.RouterNat("simple-balance", {
  name: "simple-balance",
  router: router.name,
  region,
  natIpAllocateOption: "MANUAL_ONLY",
  natIps: [natAddress.selfLink],
  sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
});

const nodeServiceAccount = new gcp.serviceaccount.Account("simple-balance-node", {
  accountId: "simple-balance-node",
  displayName: "Simple Balance GKE nodes",
});

const nodeRoles = [
  "roles/logging.logWriter",
  "roles/monitoring.metricWriter",
  "roles/monitoring.viewer",
  "roles/stackdriver.resourceMetadata.writer",
  "roles/artifactregistry.reader",
].map(
  (role) =>
    new gcp.projects.IAMMember(`simple-balance-node-${role.split("/")[1]}`, {
      project,
      role,
      member: pulumi.interpolate`serviceAccount:${nodeServiceAccount.email}`,
    }),
);

const cluster = new gcp.container.Cluster(
  "simple-balance",
  {
    name: "simple-balance",
    location: region,
    network: network.id,
    subnetwork: subnetwork.id,
    // A cluster is created with a node pool whatever you do, so the way to one
    // this program configures is to remove that one.
    removeDefaultNodePool: true,
    initialNodeCount: 1,
    // The channel decides the version and keeps it current, which is why there
    // is no version pinned here. simple-balance:kubernetesVersion is an EKS
    // setting and is ignored on GKE.
    releaseChannel: { channel: "REGULAR" },
    networkingMode: "VPC_NATIVE",
    ipAllocationPolicy: {
      clusterSecondaryRangeName: "pods",
      servicesSecondaryRangeName: "services",
    },
    privateClusterConfig: {
      enablePrivateNodes: true,
      // The control plane stays reachable from outside, or `pulumi up` would
      // have to run from inside this VPC.
      enablePrivateEndpoint: false,
      masterIpv4CidrBlock: "172.16.0.0/28",
    },
    workloadIdentityConfig: { workloadPool: `${project}.svc.id.goog` },
    addonsConfig: {
      // This addon is the ingress controller on GKE. There is no Helm release
      // to install for it, and turning it off leaves every Ingress unanswered.
      httpLoadBalancing: { disabled: false },
      // The chart's HorizontalPodAutoscalers have no metrics to read without it.
      horizontalPodAutoscaling: { disabled: false },
    },
    // Node auto-provisioning: when a pod cannot fit on the pool below, GKE
    // builds a pool that suits it rather than leaving the pod pending.
    clusterAutoscaling: {
      enabled: true,
      autoscalingProfile: "OPTIMIZE_UTILIZATION",
      resourceLimits: [
        { resourceType: "cpu", minimum: 4, maximum: 64 },
        { resourceType: "memory", minimum: 16, maximum: 256 },
      ],
      autoProvisioningDefaults: {
        serviceAccount: nodeServiceAccount.email,
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    },
    resourceLabels: labels,
    // The provider defaults this on and then refuses to delete the cluster it
    // created. A stack that cannot be destroyed is worse than one that can be
    // destroyed by accident.
    deletionProtection: false,
  },
  { dependsOn: [nat, ...nodeRoles] },
);

const nodePool = new gcp.container.NodePool("simple-balance", {
  name: "default",
  cluster: cluster.name,
  location: region,
  // Both counts are per zone and this is a regional cluster, so the pool runs
  // three to nine nodes across three zones.
  initialNodeCount: 1,
  autoscaling: { minNodeCount: 1, maxNodeCount: 3 },
  management: { autoRepair: true, autoUpgrade: true },
  upgradeSettings: { maxSurge: 1, maxUnavailable: 0 },
  nodeConfig: {
    machineType: "e2-standard-2",
    diskSizeGb: 50,
    diskType: "pd-balanced",
    serviceAccount: nodeServiceAccount.email,
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    // Without this a pod can read the node service account's token out of the
    // metadata server, which is every permission the node has.
    workloadMetadataConfig: { mode: "GKE_METADATA" },
    shieldedInstanceConfig: { enableSecureBoot: true, enableIntegrityMonitoring: true },
    labels,
  },
});

// Reserved rather than assigned, so the DNS record can be created before the
// certificate is asked for. HTTP-01 validation needs the name to already
// resolve to this address.
const ingressAddress = new gcp.compute.GlobalAddress("simple-balance", {
  name: "simple-balance-ingress",
  addressType: "EXTERNAL",
});

const kubeconfig = pulumi.interpolate`apiVersion: v1
kind: Config
clusters:
  - name: simple-balance
    cluster:
      server: https://${cluster.endpoint}
      certificate-authority-data: ${cluster.masterAuth.clusterCaCertificate}
contexts:
  - name: simple-balance
    context:
      cluster: simple-balance
      user: simple-balance
current-context: simple-balance
users:
  - name: simple-balance
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: gke-gcloud-auth-plugin
        installHint: "Install it with: gcloud components install gke-gcloud-auth-plugin"
        provideClusterInfo: true
`;

const k8sProvider = new k8s.Provider("gke", { kubeconfig }, { dependsOn: [nodePool] });

const certManager = sb.certManager({
  provider: k8sProvider,
  settings,
  // Naming the Ingress rather than a class, because the GKE ingress answers on
  // the address of the load balancer it built for that one Ingress. A solver
  // that created its own would get a second load balancer on a second address,
  // which is not the address the DNS record names, and the challenge would go
  // unanswered forever.
  solverIngress: { name: sb.ingressName },
  dependsOn: [nodePool],
});

const app = sb.simpleBalance({
  provider: k8sProvider,
  settings,
  issuerName: certManager.issuerName,
  ingressClassName: "gce",
  ingressAnnotations: {
    "kubernetes.io/ingress.global-static-ip-name": ingressAddress.name,
    // Explicit because the HTTP-01 challenge is answered over plain HTTP, on
    // this Ingress, every time the certificate is renewed.
    "kubernetes.io/ingress.allow-http": "true",
  },
  dependsOn: [certManager.clusterIssuer],
});

export const clusterName = cluster.name;
export { kubeconfig };
export const namespace = app.namespace.metadata.name;
export const ingressIpAddress = ingressAddress.address;
export const egressAddress = natAddress.address;
export const appUrl = `https://${settings.hostname}/`;
export const dnsRecord = pulumi.interpolate`${settings.hostname}. A ${ingressAddress.address}`;
