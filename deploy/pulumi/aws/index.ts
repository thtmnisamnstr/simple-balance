import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import * as sb from "../common";

const loadBalancerControllerVersion = "3.5.0";
const ingressNginxVersion = "4.15.1";
const clusterAutoscalerVersion = "9.59.0";

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
      throw new Error(`${region} offers ${names.length} availability zones; this program spreads across ${azCount}.`);
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
const publicSubnets = Array.from({ length: azCount }, (_, i) =>
  new aws.ec2.Subnet(`simple-balance-public-${i}`, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${i}.0/24`,
    availabilityZone: availabilityZone(i),
    mapPublicIpOnLaunch: true,
    tags: { ...tags, Name: `simple-balance-public-${i}`, "kubernetes.io/role/elb": "1" },
  }));

// A /20 each: with the VPC CNI every pod takes an address out of these, so the
// subnet size is the pod ceiling.
const privateSubnets = Array.from({ length: azCount }, (_, i) =>
  new aws.ec2.Subnet(`simple-balance-private-${i}`, {
    vpcId: vpc.id,
    cidrBlock: `10.0.${16 * (i + 1)}.0/20`,
    availabilityZone: availabilityZone(i),
    tags: { ...tags, Name: `simple-balance-private-${i}`, "kubernetes.io/role/internal-elb": "1" },
  }));

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

publicSubnets.forEach((subnet, i) =>
  new aws.ec2.RouteTableAssociation(`simple-balance-public-${i}`, {
    subnetId: subnet.id,
    routeTableId: publicRouteTable.id,
  }));

privateSubnets.forEach((subnet, i) =>
  new aws.ec2.RouteTableAssociation(`simple-balance-private-${i}`, {
    subnetId: subnet.id,
    routeTableId: privateRouteTable.id,
  }));

const nodeRole = new aws.iam.Role("simple-balance-node", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
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

const cluster = new eks.Cluster("simple-balance", {
  vpcId: vpc.id,
  publicSubnetIds: publicSubnets.map((s) => s.id),
  privateSubnetIds: privateSubnets.map((s) => s.id),
  // Left unset, EKS creates the version it currently defaults to and never
  // moves it afterwards. Pinning a version here ages badly; upgrading is
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
  policy: pulumi.Input<string>,
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

  new aws.iam.RolePolicy(`${name}-policy`, { role: role.id, policy });

  return role;
}

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
        service: {
          annotations: {
            "service.beta.kubernetes.io/aws-load-balancer-type": "external",
            "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
            "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
            "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled": "true",
            // A TCP health check calls a controller healthy the moment nginx
            // has the socket open, which is before it has any configuration.
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol": "http",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-path": "/healthz",
            "service.beta.kubernetes.io/aws-load-balancer-healthcheck-port": "10254",
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
  dependsOn: [certManager.clusterIssuer, ingressNginx, clusterAutoscaler],
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
