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

const inClusterDatabase = settings.database === "in-cluster";

// Envelope encryption for the Secrets in etcd — GKE calls it application-layer
// secrets encryption — which is where DATABASE_URL, AUTH_SECRET,
// STRIPE_SECRET_KEY and, with an in-cluster database, the four PostgreSQL
// passwords and the cluster's own private key all end up.
//
// A key of this project's own, because GKE offers no Google-managed option for
// this one: it is a Cloud KMS key or nothing. Everything else here — node boot
// disks, persistent disks, the etcd volume itself — is already encrypted at
// rest with Google-managed keys and needs no property to say so.
const keyRing = new gcp.kms.KeyRing("simple-balance", {
  name: "simple-balance",
  location: region,
});

const secretsKey = new gcp.kms.CryptoKey("simple-balance-secrets", {
  name: "secrets",
  keyRing: keyRing.id,
  rotationPeriod: "7776000s",
  // A KeyRing and a CryptoKey cannot be deleted in Cloud KMS at all — only
  // their versions can be destroyed — so the provider's default of refusing to
  // remove one from state would leave `pulumi destroy` permanently stuck on an
  // object no API can remove.
  destroyScheduledDuration: "86400s",
});

// GKE encrypts with this key as its own service agent, not as the operator, so
// without this grant the cluster update fails with a permission error naming an
// account nobody created. The agent's address is derived from the project
// number rather than the project id, which is why the lookup is here.
const projectDetails = gcp.organizations.getProjectOutput({ projectId: project });

const secretsKeyGrant = new gcp.kms.CryptoKeyIAMMember("simple-balance-secrets", {
  cryptoKeyId: secretsKey.id,
  role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
  member: pulumi.interpolate`serviceAccount:service-${projectDetails.number}@container-engine-robot.iam.gserviceaccount.com`,
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
    databaseEncryption: { state: "ENCRYPTED", keyName: secretsKey.id },
    // Dataplane V2 is what enforces a NetworkPolicy on GKE. The legacy datapath
    // enforces none, so the chart's four policies would install and guard
    // nothing — which is worse than having none, because the cluster then looks
    // guarded in `kubectl get networkpolicy`.
    //
    // Not Calico, which is the other way to get enforcement here and is the one
    // this program must not take: `addonsConfig.networkPolicyConfig` turns off
    // container-native load balancing, and the frontend's whole
    // client-address story below depends on the load balancer reaching pods
    // through network endpoint groups rather than through a node port.
    //
    // Tied to the in-cluster database rather than turned on for everybody,
    // which is the opposite of the choice the AWS program makes about its CNI,
    // and the reason is what each costs. Adopting the VPC CNI addon is an
    // in-place change; GKE has no way to swap a running cluster's datapath, so
    // the provider replaces the cluster instead. `pulumi preview` says
    // "replace" plainly, and an operator who wants this on a cluster that
    // already exists should migrate it with `gcloud container clusters update
    // --enable-dataplane-v2` first and then set this, so that the plan is a
    // no-op rather than a rebuild.
    datapathProvider: inClusterDatabase ? "ADVANCED_DATAPATH" : undefined,
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
    // Unset leaves the endpoint open to the internet, which is what every
    // release so far has had, so an existing stack plans no change. Narrowing
    // it is the operator's to do: this program cannot know which address they
    // run `pulumi up` from, and a wrong guess locks the stack out of the
    // control plane it would need in order to fix itself.
    masterAuthorizedNetworksConfig:
      settings.controlPlaneCidrs.length > 0
        ? {
            cidrBlocks: settings.controlPlaneCidrs.map((cidrBlock) => ({
              cidrBlock,
              displayName: "simple-balance:controlPlaneCidrs",
            })),
          }
        : undefined,
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
  // The KMS grant has to be in place before the cluster asks to encrypt with
  // the key, or creation fails on a permission the operator cannot see.
  { dependsOn: [nat, secretsKeyGrant, ...nodeRoles] },
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

// The class the ledger's volumes are cut from.
//
// No `disk-encryption-kms-key`, and that is the decision rather than an
// omission: Google encrypts every persistent disk at rest with keys it manages,
// and a key of our own here would buy a key policy to get wrong and a way to
// lock a deployment permanently out of its own ledger volume. The etcd Secrets
// above are the one place that trade comes out the other way, because GKE
// offers no managed option there and a lost Secret is reproducible.
//
// What this class is for, then, is the three properties GKE's own `standard-rwo`
// does not set the way a database wants them.
const databaseStorageClass = new k8s.storage.v1.StorageClass(
  "simple-balance-pd-balanced",
  {
    metadata: { name: "simple-balance-pd-balanced" },
    provisioner: "pd.csi.storage.gke.io",
    parameters: { type: "pd-balanced" },
    // A disk lives in one zone and a pod that needs it has to be scheduled
    // there. On a regional cluster, binding immediately would cut the disk in
    // whichever zone the provisioner picked and then hope a node was free in
    // it.
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
    // Retain rather than Delete, because `kubectl delete pvc` by mistake is one
    // keystroke and a stray disk costs a few dollars a month until somebody
    // removes it on purpose.
    reclaimPolicy: "Retain",
  },
  { provider: k8sProvider },
);

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
  ingressAnnotations: {
    // The legacy annotation, not spec.ingressClassName: GKE's built-in
    // controller ignores the field, so a class set only there provisions no
    // load balancer and the deployment never gets an address.
    "kubernetes.io/ingress.class": "gce",
    "kubernetes.io/ingress.global-static-ip-name": ingressAddress.name,
    // Explicit because the HTTP-01 challenge is answered over plain HTTP, on
    // this Ingress, every time the certificate is renewed.
    "kubernetes.io/ingress.allow-http": "true",
  },
  // Container-native load balancing, named rather than inherited, because the
  // address a frontend pod sees depends entirely on which path the load
  // balancer takes. Through network endpoint groups Google's front ends connect
  // to the pod itself; through instance groups they connect to a node port and
  // kube-proxy hands the pod the node's own address instead. GKE picks the
  // first by default only while the cluster is VPC-native, off Shared VPC,
  // without GKE Network Policy and with HttpLoadBalancing on
  // (docs.cloud.google.com/kubernetes-engine/docs/concepts/
  // container-native-load-balancing) — all true of the cluster above, and one
  // policy switch away from false. The Service is ClusterIP, which the GKE
  // Ingress serves only through endpoint groups, so this is also what makes
  // the Ingress work at all rather than a second way of saying so.
  frontendServiceAnnotations: { "cloud.google.com/neg": '{"ingress": true}' },
  // Google's external Application Load Balancer, which the GKE Ingress is,
  // connects to endpoint-group backends from 130.211.0.0/22 and 35.191.0.0/16
  // and appends `<client-ip>,<load-balancer-ip>` to whatever X-Forwarded-For
  // the client sent, `<load-balancer-ip>` being the forwarding rule's address
  // — the reserved one above (docs.cloud.google.com/load-balancing/docs/https,
  // "Firewall rules" and "X-Forwarded-For header"). So the rightmost entry is
  // that address for every visitor, and only recursion past it reaches the
  // visitor. All three are trusted and recursion is on: nginx then stops at
  // `<client-ip>`, the first untrusted address from the right, which the load
  // balancer wrote from its own socket, and never reads the entries to its
  // left, which are the only ones a client can write. Health checks come from
  // 35.191.0.0/16 with no header at all and are left as they arrive.
  trustedProxies: {
    addresses: ["130.211.0.0/22", "35.191.0.0/16", ingressAddress.address],
    recursive: true,
  },
  databaseStorageClass: databaseStorageClass.metadata.name,
  dependsOn: [certManager.clusterIssuer, databaseStorageClass],
});

export const clusterName = cluster.name;
export { kubeconfig };
export const namespace = app.namespace.metadata.name;
export const ingressIpAddress = ingressAddress.address;
export const egressAddress = natAddress.address;
export const appUrl = `https://${settings.hostname}/`;
export const dnsRecord = pulumi.interpolate`${settings.hostname}. A ${ingressAddress.address}`;
