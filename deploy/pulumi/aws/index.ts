import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import * as sb from "../common";

const loadBalancerControllerVersion = "3.5.0";
const ingressNginxVersion = "4.15.1";
const clusterAutoscalerVersion = "9.59.0";
const metricsServerVersion = "3.14.0";

const settings = sb.readSettings();

const region = aws.config.region;
if (!region) {
  throw new Error("No AWS region. Set one with `pulumi config set aws:region us-west-2`.");
}

const tags = { Project: "simple-balance", PulumiStack: pulumi.getStack() };

const azNames = aws.getAvailabilityZonesOutput({ state: "available" }).names;
const azCount = 3;
const availabilityZone = (index: number) =>
  azNames.apply((names) => {
    if (names.length < azCount) {
      throw new Error(
        `${region} offers ${names.length} availability zones; this program spreads across ${azCount}.`,
      );
    }
    return names[index];
  });

const vpc = new aws.ec2.Vpc("simple-balance", {
  cidrBlock: "10.0.0.0/16",
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: { ...tags, Name: "simple-balance" },
});

const internetGateway = new aws.ec2.InternetGateway("simple-balance", {
  vpcId: vpc.id,
  tags: { ...tags, Name: "simple-balance" },
});

// The role tags are how the AWS Load Balancer Controller finds somewhere to put
// a load balancer. Untagged subnets mean a Service that stays pending with a
// "couldn't auto-discover subnets" event and nothing else wrong with it.
const publicSubnets = Array.from(
  { length: azCount },
  (_, i) =>
    new aws.ec2.Subnet(`simple-balance-public-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${i}.0/24`,
      availabilityZone: availabilityZone(i),
      mapPublicIpOnLaunch: true,
      tags: { ...tags, Name: `simple-balance-public-${i}`, "kubernetes.io/role/elb": "1" },
    }),
);

// A /20 each: with the VPC CNI every pod takes an address out of these, so the
// subnet size is the pod ceiling.
const privateSubnets = Array.from(
  { length: azCount },
  (_, i) =>
    new aws.ec2.Subnet(`simple-balance-private-${i}`, {
      vpcId: vpc.id,
      cidrBlock: `10.0.${16 * (i + 1)}.0/20`,
      availabilityZone: availabilityZone(i),
      tags: {
        ...tags,
        Name: `simple-balance-private-${i}`,
        "kubernetes.io/role/internal-elb": "1",
      },
    }),
);

const natEip = new aws.ec2.Eip("simple-balance-nat", { domain: "vpc", tags });

const natGateway = new aws.ec2.NatGateway(
  "simple-balance",
  {
    allocationId: natEip.id,
    subnetId: publicSubnets[0].id,
    tags: { ...tags, Name: "simple-balance" },
  },
  { dependsOn: [internetGateway] },
);

const publicRouteTable = new aws.ec2.RouteTable("simple-balance-public", {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }],
  tags: { ...tags, Name: "simple-balance-public" },
});

const privateRouteTable = new aws.ec2.RouteTable("simple-balance-private", {
  vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }],
  tags: { ...tags, Name: "simple-balance-private" },
});

publicSubnets.forEach(
  (subnet, i) =>
    new aws.ec2.RouteTableAssociation(`simple-balance-public-${i}`, {
      subnetId: subnet.id,
      routeTableId: publicRouteTable.id,
    }),
);

privateSubnets.forEach(
  (subnet, i) =>
    new aws.ec2.RouteTableAssociation(`simple-balance-private-${i}`, {
      subnetId: subnet.id,
      routeTableId: privateRouteTable.id,
    }),
);

const nodeRole = new aws.iam.Role("simple-balance-node", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
    ],
  }),
  tags,
});

const nodeRolePolicies = [
  "AmazonEKSWorkerNodePolicy",
  "AmazonEKS_CNI_Policy",
  "AmazonEC2ContainerRegistryReadOnly",
].map(
  (policy) =>
    new aws.iam.RolePolicyAttachment(`simple-balance-node-${policy}`, {
      role: nodeRole.name,
      policyArn: `arn:aws:iam::aws:policy/${policy}`,
    }),
);

// Envelope encryption for the Secrets in etcd, which is where DATABASE_URL,
// AUTH_SECRET, STRIPE_SECRET_KEY and — with an in-cluster database — the four
// PostgreSQL passwords and the cluster's own private key all end up.
//
// A customer-managed key here and nowhere else, and the difference from the EBS
// volumes is worth stating because the surrounding argument is that
// provider-managed keys are the right default. EKS offers no AWS-managed option
// for this: envelope encryption is either a key of your own or nothing at all.
// The lock-yourself-out risk that rules a customer-managed key out for a data
// volume is also much smaller here — every Secret in this cluster is
// reproducible from Pulumi config and from the chart, so losing the key costs a
// reinstall rather than the ledger.
//
// Rotation is on because the cost is nothing: AWS re-wraps with a new key
// version yearly and keeps every earlier one for decryption.
const secretsKey = new aws.kms.Key("simple-balance-secrets", {
  description: "Simple Balance: envelope encryption for Kubernetes Secrets in EKS",
  enableKeyRotation: true,
  // Long enough to notice a `pulumi destroy` nobody meant, which is the only
  // way this key is ever scheduled for deletion.
  deletionWindowInDays: 30,
  tags: { ...tags, Name: "simple-balance-secrets" },
});

const cluster = new eks.Cluster("simple-balance", {
  vpcId: vpc.id,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  privateSubnetIds: privateSubnets.map((s) => s.id),
  // Left unset, EKS creates the version it currently defaults to and never
  // moves it afterward. Pinning a version here ages badly; upgrading is
  // `pulumi config set simple-balance:kubernetesVersion` when you mean it.
  version: settings.kubernetesVersion,
  skipDefaultNodeGroup: true,
  // Access entries rather than the deprecated aws-auth ConfigMap. EKS writes
  // the entry that lets a managed node group's role join the cluster itself, so
  // the node group below needs nothing declared here to be admitted.
  authenticationMode: "API",
  // Every controller below authenticates as a service account rather than as
  // the node, which needs the cluster's OIDC provider registered with IAM.
  createOidcProvider: true,
  endpointPrivateAccess: true,
  endpointPublicAccess: true,
  // Unset leaves EKS's own default, which is 0.0.0.0/0 — what every release so
  // far has had, so an existing stack plans no change here. Narrowing it is the
  // operator's to do, because only they know which address they run `pulumi up`
  // from, and a wrong guess locks the stack out of its own control plane.
  publicAccessCidrs: settings.controlPlaneCidrs.length > 0 ? settings.controlPlaneCidrs : undefined,
  // Adding this to a cluster that already exists is an in-place AWS operation
  // and takes a few minutes; the cluster keeps serving throughout. It cannot be
  // undone afterwards — EKS has no way to turn envelope encryption back off —
  // so it is worth knowing about before the first `pulumi up` on this release
  // rather than after.
  encryptionConfigKeyArn: secretsKey.arn,
  // The VPC CNI is what does or does not enforce a NetworkPolicy on EKS, and
  // out of the box it does not: it hands out addresses and ignores the objects
  // entirely. The chart's four policies would render, install, and protect
  // nothing — which is worse than having none, because the cluster then looks
  // guarded in `kubectl get networkpolicy`.
  //
  // Managing the CNI here rather than leaving EKS's default in place is what
  // `useDefaultVpcCni: false` means, and it is the combination the component
  // documents for passing any CNI option at all. On a cluster that already
  // exists this adopts the aws-node DaemonSet EKS installed and rolls it once;
  // pods keep running through it, and address assignment pauses for the
  // seconds each node's agent takes to come back.
  useDefaultVpcCni: false,
  vpcCniOptions: { enableNetworkPolicy: true },
  enabledClusterLogTypes: ["api", "audit", "authenticator"],
  tags,
});

const nodeGroup = new aws.eks.NodeGroup(
  "simple-balance",
  {
    clusterName: cluster.eksCluster.name,
    nodeRoleArn: nodeRole.arn,
    subnetIds: privateSubnets.map((s) => s.id),
    instanceTypes: ["t3.large"],
    capacityType: "ON_DEMAND",
    amiType: "AL2023_x86_64_STANDARD",
    diskSize: 50,
    scalingConfig: { minSize: 2, maxSize: 6, desiredSize: 2 },
    updateConfig: { maxUnavailable: 1 },
    labels: { "simple-balance/pool": "default" },
    tags,
  },
  {
    dependsOn: [...nodeRolePolicies],
    // The cluster autoscaler owns desiredSize once the cluster is up. Without
    // this every `pulumi up` would hand the count back to whatever was declared
    // here and terminate the nodes the autoscaler added.
    ignoreChanges: ["scalingConfig.desiredSize"],
  },
);

const k8sProvider = new k8s.Provider("eks", { kubeconfig: cluster.kubeconfigJson });

function serviceAccountRole(
  name: string,
  namespace: string,
  serviceAccount: string,
  policy?: pulumi.Input<string>,
  // Only the EBS CSI driver uses this. Its permissions are a long list that
  // grows a new condition key whenever EBS learns one, and AWS maintains that
  // list as a managed policy; the inline documents above are hand-written
  // because no managed policy says what they say.
  managedPolicyArns: string[] = [],
): aws.iam.Role {
  const role = new aws.iam.Role(name, {
    assumeRolePolicy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: cluster.oidcProviderArn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: cluster.oidcIssuer.apply((issuer: string) => ({
              [`${issuer}:aud`]: "sts.amazonaws.com",
              [`${issuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
            })),
          },
        },
      ],
    }),
    tags,
  });

  if (policy) {
    new aws.iam.RolePolicy(`${name}-policy`, { role: role.id, policy });
  }

  for (const policyArn of managedPolicyArns) {
    new aws.iam.RolePolicyAttachment(`${name}-${policyArn.split("/").pop()}`, {
      role: role.name,
      policyArn,
    });
  }

  return role;
}

// Without this addon a PersistentVolumeClaim on EKS 1.23 or later simply sits
// Pending: the in-tree EBS provisioner was removed from Kubernetes and nothing
// replaces it unless it is installed. Nothing else in this deployment claims a
// volume, so the gap shows only once the chart runs its own database.
//
// Installed whether or not the database is in this cluster, and deliberately: a
// Kubernetes cluster that cannot attach a disk is broken for anything anybody
// puts on it, not only for this chart, and the StorageClass below is where
// `encrypted` stops being an account-wide setting somebody forgot to turn on.
const ebsCsiRole = serviceAccountRole(
  "simple-balance-ebs-csi",
  "kube-system",
  "ebs-csi-controller-sa",
  undefined,
  // The managed policy carries the KMS grants the driver needs to cut an
  // encrypted volume, conditioned on the grant being for EBS. Spelled out by
  // hand those conditions are the part that goes wrong, and AWS keeps this one
  // current.
  ["arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"],
);

const ebsCsiDriver = new aws.eks.Addon("simple-balance-ebs-csi", {
  clusterName: cluster.eksCluster.name,
  addonName: "aws-ebs-csi-driver",
  // No addonVersion: EKS picks the default for the cluster's Kubernetes
  // version, which is the one pairing AWS tests. A pinned version here would
  // have to be raised by hand at every control-plane upgrade or the addon would
  // fall out of support quietly.
  serviceAccountRoleArn: ebsCsiRole.arn,
  resolveConflictsOnCreate: "OVERWRITE",
  resolveConflictsOnUpdate: "PRESERVE",
  tags,
});

// The class the ledger's volumes are cut from, and the only place at-rest
// encryption for them is decided.
//
// `encrypted: "true"` is the whole guarantee on AWS and is not a default:
// EBS encryption-by-default is an account-level setting that is off on a fresh
// account, so a volume cut without this is a plaintext volume. That is the
// difference between this and the boot disks, and it is why the property is
// written even though the surrounding clouds encrypt much of this anyway.
//
// gp3 rather than gp2: baseline throughput comes with the volume rather than
// scaling with its size, which for a database of a few tens of gigabytes is the
// difference between 125 MB/s and 16.
const databaseStorageClass = new k8s.storage.v1.StorageClass(
  "simple-balance-gp3-encrypted",
  {
    metadata: { name: "simple-balance-gp3-encrypted" },
    provisioner: "ebs.csi.aws.com",
    parameters: { type: "gp3", encrypted: "true" },
    // A volume lives in one availability zone and a pod that needs it has to be
    // scheduled there. Binding immediately would cut the volume in whichever
    // zone the provisioner happened to pick and then hope a node was free in
    // it; waiting means the scheduler chooses first and the volume follows.
    volumeBindingMode: "WaitForFirstConsumer",
    // Growing a PersistentVolumeClaim is the only way to give a StatefulSet's
    // pod more disk without rebuilding it, and it is off unless asked for.
    allowVolumeExpansion: true,
    // Retain rather than Delete. A released claim taking the ledger's volume
    // with it is not a risk worth the tidiness — `kubectl delete pvc` by
    // mistake is one keystroke, and an orphaned EBS volume costs a few dollars
    // a month until somebody removes it on purpose.
    reclaimPolicy: "Retain",
  },
  { provider: k8sProvider, dependsOn: [ebsCsiDriver] },
);

// AWS publishes this as a statement-by-statement document that grows a new
// action whenever the controller learns one. This says the same thing by
// service instead, which is broader and cannot fall behind. Swap in the
// upstream JSON if a tighter policy is worth maintaining:
// https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/main/docs/install/iam_policy.json
const loadBalancerControllerPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource: "*",
      Condition: { StringEquals: { "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com" } },
    },
    {
      Effect: "Allow",
      Action: [
        "acm:DescribeCertificate",
        "acm:ListCertificates",
        "cognito-idp:DescribeUserPoolClient",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateSecurityGroup",
        "ec2:CreateTags",
        "ec2:DeleteSecurityGroup",
        "ec2:DeleteTags",
        "ec2:Describe*",
        "ec2:Get*",
        "ec2:RevokeSecurityGroupIngress",
        "elasticloadbalancing:*",
        "iam:GetServerCertificate",
        "iam:ListServerCertificates",
        "shield:CreateProtection",
        "shield:DeleteProtection",
        "shield:DescribeProtection",
        "shield:GetSubscriptionState",
        "tag:GetResources",
        "tag:TagResources",
        "waf-regional:AssociateWebACL",
        "waf-regional:DisassociateWebACL",
        "waf-regional:GetWebACL",
        "waf-regional:GetWebACLForResource",
        "wafv2:AssociateWebACL",
        "wafv2:DisassociateWebACL",
        "wafv2:GetWebACL",
        "wafv2:GetWebACLForResource",
      ],
      Resource: "*",
    },
  ],
});

const loadBalancerControllerRole = serviceAccountRole(
  "simple-balance-lbc",
  "kube-system",
  "aws-load-balancer-controller",
  loadBalancerControllerPolicy,
);

const loadBalancerController = new k8s.helm.v3.Release(
  "aws-load-balancer-controller",
  {
    name: "aws-load-balancer-controller",
    chart: "aws-load-balancer-controller",
    version: loadBalancerControllerVersion,
    repositoryOpts: { repo: "https://aws.github.io/eks-charts" },
    namespace: "kube-system",
    values: {
      clusterName: cluster.eksCluster.name,
      region,
      vpcId: vpc.id,
      serviceAccount: {
        create: true,
        name: "aws-load-balancer-controller",
        annotations: { "eks.amazonaws.com/role-arn": loadBalancerControllerRole.arn },
      },
      // The mutating webhook exists to rewrite LoadBalancer Services that did
      // not ask for this controller. The one Service here asks for it by
      // annotation, so the webhook would only add an admission path that can
      // fail while every Service in the cluster waits on it.
      enableServiceMutatorWebhook: false,
      replicaCount: 2,
    },
    timeout: 600,
  },
  { provider: k8sProvider, dependsOn: [nodeGroup] },
);

const clusterAutoscalerPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeScalingActivities",
        "autoscaling:DescribeTags",
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeImages",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "eks:DescribeNodegroup",
      ],
      Resource: "*",
    },
  ],
});

const clusterAutoscalerRole = serviceAccountRole(
  "simple-balance-cluster-autoscaler",
  "kube-system",
  "cluster-autoscaler",
  clusterAutoscalerPolicy,
);

// EKS tags a managed node group's autoscaling group with
// k8s.io/cluster-autoscaler/enabled and k8s.io/cluster-autoscaler/<cluster>,
// which is exactly what autoDiscovery looks for. Nothing here has to tag it.
const clusterAutoscaler = new k8s.helm.v3.Release(
  "cluster-autoscaler",
  {
    name: "cluster-autoscaler",
    chart: "cluster-autoscaler",
    version: clusterAutoscalerVersion,
    repositoryOpts: { repo: "https://kubernetes.github.io/autoscaler" },
    namespace: "kube-system",
    values: {
      autoDiscovery: { clusterName: cluster.eksCluster.name },
      awsRegion: region,
      rbac: {
        serviceAccount: {
          create: true,
          name: "cluster-autoscaler",
          annotations: { "eks.amazonaws.com/role-arn": clusterAutoscalerRole.arn },
        },
      },
      extraArgs: {
        "balance-similar-node-groups": true,
        // A node holding nothing but DaemonSet pods is still a node worth
        // removing, and every node here holds kube-proxy and the CNI.
        "skip-nodes-with-system-pods": false,
      },
      resources: {
        requests: { cpu: "100m", memory: "300Mi" },
        limits: { cpu: "200m", memory: "500Mi" },
      },
    },
    timeout: 600,
  },
  { provider: k8sProvider, dependsOn: [nodeGroup] },
);

// The chart's HorizontalPodAutoscalers read CPU and memory through the metrics
// API, and a stock EKS cluster does not serve it — GKE ships this as an addon,
// EKS leaves it to be installed. Without it all three HPAs the common program
// enables sit at "unknown" and nothing ever scales, silently.
const metricsServer = new k8s.helm.v3.Release(
  "metrics-server",
  {
    name: "metrics-server",
    chart: "metrics-server",
    version: metricsServerVersion,
    repositoryOpts: { repo: "https://kubernetes-sigs.github.io/metrics-server/" },
    namespace: "kube-system",
    values: {
      resources: {
        requests: { cpu: "50m", memory: "100Mi" },
        limits: { cpu: "100m", memory: "200Mi" },
      },
    },
    timeout: 600,
  },
  { provider: k8sProvider, dependsOn: [nodeGroup] },
);

// An ALB can only serve a certificate that lives in ACM, and cert-manager
// issues into a Kubernetes Secret. So the load balancer controller does what it
// is good at here, which is putting a network load balancer in front of a
// Service, and ingress-nginx terminates TLS with the Let's Encrypt certificate
// behind it.
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
        // The visitor's address, carried across the load balancer. An NLB with
        // IP targets connects from its own private address and says nothing
        // about who connected to it — AWS leaves client IP preservation off
        // for IP targets over TCP — so without this ingress-nginx sees the load
        // balancer, sets X-Forwarded-For to it, and every visitor shares one
        // sign-in allowance however the frontend is configured behind it.
        //
        // Proxy protocol v2 rather than client IP preservation. Preserved
        // addresses arrive from the whole internet, which the node security
        // group would then have to admit on 80 and 443; proxy protocol keeps
        // the load balancer as the only peer and carries the visitor in a
        // header ingress-nginx parses. Both ends are switched in this one
        // release because each is a hard failure without the other: nginx
        // expecting the header refuses a connection that lacks one, and nginx
        // not expecting it reads the binary header as a request line. The
        // trap proxy protocol usually sets — kube-proxy routing a pod's
        // request for the load balancer's address straight to ingress-nginx,
        // with no header, which breaks cert-manager's HTTP-01 self-check — is
        // not set here: this controller reports the NLB by hostname only, and
        // kube-proxy short-circuits addresses, not names.
        //
        // `proxy-real-ip-cidr` narrows whose header is believed from
        // ingress-nginx's default of 0.0.0.0/0 to the public subnets, because
        // that is where the load balancer's nodes take their addresses: the
        // controller puts an internet-facing NLB in the subnets tagged
        // kubernetes.io/role/elb, which are those three and nothing else, and
        // with client IP preservation off each node connects from its own
        // address there. Not the whole VPC, although that reads as the same
        // fence: every pod takes its address from the private subnets inside
        // it, and a pod that opens a connection to ingress-nginx with a PROXY
        // header naming any address it likes is then believed, so the cluster
        // could pick its own sign-in addresses through the ingress, where no
        // NetworkPolicy on the chart reaches. Narrowed to the load balancer, a
        // header from anywhere else is ignored and the connection is counted
        // as the pod it came from. ingress-nginx splits this on commas.
        //
        // X-Forwarded-For toward the frontend is then `$remote_addr`, the
        // visitor, *replacing* anything the visitor sent — ingress-nginx
        // replaces unless use-forwarded-headers and compute-full-forwarded-for
        // are both on, and neither is on here — so the frontend's recursion
        // stays off below.
        config: {
          "use-proxy-protocol": "true",
          "proxy-real-ip-cidr": pulumi
            .all(publicSubnets.map((subnet) => subnet.cidrBlock))
            .apply((cidrs) => cidrs.join(",")),
        },
        service: {
          annotations: {
            "service.beta.kubernetes.io/aws-load-balancer-type": "external",
            "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
            "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled":
              "true",
            // `*` is the only value the controller accepts, and it means
            // version 2 on every target group this Service gets.
            "service.beta.kubernetes.io/aws-load-balancer-proxy-protocol": "*",
            // A TCP health check calls a controller healthy the moment nginx
            // has the socket open, which is before it has any configuration.
            //
            // Port 80 rather than the controller's own 10254. AWS sends the
            // proxy protocol header on health check connections too, and says
            // a target that cannot parse it fails them with a 400
            // (docs.aws.amazon.com/elasticloadbalancing/latest/network/
            // edit-target-group-attributes.html#health-check-connections). The
            // controller's Go server on 10254 does not parse it, so every
            // target would go unhealthy the moment proxy protocol came on —
            // kubernetes/ingress-nginx#10982 is exactly that. On 80 nginx
            // parses the header and answers /healthz from the default server
            // the controller renders, whose template says it is there for
            // cloud health checks. That default server exists only once the
            // controller has written a configuration — the image's own
            // nginx.conf listens on nothing — so this still cannot pass early,
            // and the pod's readiness probe stays on 10254 and still decides
            // which pods are registered at all.
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol": "http",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-path": "/healthz",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-port": "80",
          },
        },
        resources: {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
      },
    },
    timeout: 900,
  },
  { provider: k8sProvider, dependsOn: [loadBalancerController] },
);

const certManager = sb.certManager({
  provider: k8sProvider,
  settings,
  solverIngress: { class: "nginx" },
  dependsOn: [nodeGroup],
});

const app = sb.simpleBalance({
  provider: k8sProvider,
  settings,
  issuerName: certManager.issuerName,
  ingressClassName: "nginx",
  // What connects to the frontend is an ingress-nginx pod, and under the VPC
  // CNI a pod's address is an address in this VPC — the private subnets carved
  // out of it above. The whole VPC rather than the three subnets because
  // ingress-nginx's pods and every other pod draw from the same subnets, so the
  // narrower list would trust exactly the same pods and break the day a subnet
  // is added.
  //
  // What that trusts beyond ingress-nginx is any pod in the cluster that
  // connects to the frontend and writes its own X-Forwarded-For. It is not a
  // new reach: the chart's NetworkPolicy is off unless asked for, and with
  // TRUST_PROXY on the API believes X-Forwarded-For from anything that can
  // reach its Service — which, with the policy off, is every pod here. Turning
  // networkPolicy on with frontendIngressFrom naming ingress-nginx's namespace
  // narrows both, on a cluster whose CNI enforces policies; the VPC CNI does so
  // only with its network policy agent enabled. It narrows them only because
  // ingress-nginx itself believes a PROXY header from the load balancer's
  // subnets alone, above: a pod the policy sends round through the ingress is
  // counted as itself there.
  //
  // Recursion off: ingress-nginx replaces the header, so its last entry is the
  // visitor already.
  trustedProxies: { addresses: [vpc.cidrBlock], recursive: false },
  databaseStorageClass: databaseStorageClass.metadata.name,
  dependsOn: [
    certManager.clusterIssuer,
    ingressNginx,
    clusterAutoscaler,
    metricsServer,
    // Named even with an external database, where nothing claims a volume: the
    // dependency costs an ordering edge and removing it would make the
    // in-cluster case depend on a setting the graph cannot see.
    databaseStorageClass,
  ],
});

// Read back rather than exported from the release, because the address is the
// NLB's and AWS assigns it. The Helm release above does not finish until the
// Service has one, so this resolves on the first `pulumi up` rather than the
// second.
const ingressNginxService = k8s.core.v1.Service.get(
  "ingress-nginx-controller",
  "ingress-nginx/ingress-nginx-controller",
  { provider: k8sProvider, dependsOn: [ingressNginx] },
);

export const clusterName = cluster.eksCluster.name;
export const kubeconfig = cluster.kubeconfigJson;
export const namespace = app.namespace.metadata.name;
export const egressAddress = natEip.publicIp;
export const ingressAddress = ingressNginxService.status.apply(
  (status) => status.loadBalancer?.ingress?.[0]?.hostname ?? "",
);
export const appUrl = `https://${settings.hostname}/`;
export const dnsRecord = pulumi.interpolate`${settings.hostname}. CNAME ${ingressAddress}`;
