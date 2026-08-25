import * as path from "path";

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const chartPath = path.resolve(__dirname, "..", "..", "helm", "simple-balance");

export const releaseName = "simple-balance";

/**
 * The chart's fullname reduces to the release name whenever that name already
 * contains the chart name, so every object it creates is named from this one
 * string. Knowing it up front is what lets the GKE ACME solver name the Ingress
 * before Helm has rendered it.
 */
export const ingressName = releaseName;

export const certManagerVersion = "v1.21.1";

export interface Settings {
  namespace: string;
  hostname: string;
  acmeEmail: string;
  acmeStaging: boolean;
  allowedEmails: string;
  imageRegistry: string;
  imageRepositoryPrefix: string;
  imageTag: string;
  databasePoolSize: number;
  serverMaxReplicas: number;
  frontendMaxReplicas: number;
  schedulerMaxReplicas: number;
  maxConnections: number;
  kubernetesVersion?: string;
  databaseUrl: pulumi.Output<string>;
  authSecret: pulumi.Output<string>;
  directDatabaseUrl?: pulumi.Output<string>;
  setupToken?: pulumi.Output<string>;
}

/**
 * Both programs read the same `simple-balance:` config namespace, so the
 * instructions for one stack are the instructions for the other.
 */
export function readSettings(): Settings {
  const cfg = new pulumi.Config("simple-balance");

  const settings: Settings = {
    namespace: cfg.get("namespace") ?? "simple-balance",
    hostname: cfg.require("hostname"),
    acmeEmail: cfg.require("acmeEmail"),
    acmeStaging: cfg.getBoolean("acmeStaging") ?? false,
    allowedEmails: cfg.get("allowedEmails") ?? "",
    imageRegistry: cfg.get("imageRegistry") ?? "ghcr.io",
    imageRepositoryPrefix: cfg.get("imageRepositoryPrefix") ?? "thtmnisamnstr",
    imageTag: cfg.get("imageTag") ?? "",
    databasePoolSize: cfg.getNumber("databasePoolSize") ?? 10,
    serverMaxReplicas: cfg.getNumber("serverMaxReplicas") ?? 4,
    frontendMaxReplicas: cfg.getNumber("frontendMaxReplicas") ?? 4,
    schedulerMaxReplicas: cfg.getNumber("schedulerMaxReplicas") ?? 2,
    maxConnections: cfg.getNumber("maxConnections") ?? 100,
    kubernetesVersion: cfg.get("kubernetesVersion"),
    databaseUrl: cfg.requireSecret("databaseUrl"),
    authSecret: cfg.requireSecret("authSecret"),
    directDatabaseUrl: cfg.getSecret("directDatabaseUrl"),
    setupToken: cfg.getSecret("setupToken"),
  };

  // Checked here rather than left to the server, which refuses a short one by
  // crashlooping every pod in the tier. The chart's own guard cannot see this
  // path: the value goes into a Secret this program builds, not into chart
  // values.
  const setupToken = cfg.get("setupToken")?.trim();
  if (setupToken && setupToken.length < 16) {
    throw new Error(
      "simple-balance:setupToken must contain at least 16 characters. Startup refuses a shorter one.",
    );
  }

  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(settings.hostname)
  ) {
    throw new Error(
      `simple-balance:hostname is a DNS name and nothing else: no scheme, no port, no path. Got "${settings.hostname}".`,
    );
  }

  // The chart's own minimums. An HPA whose maxReplicas sits under its
  // minReplicas is rejected by the API server, so catch it here rather than
  // three minutes into a rollout.
  const floors: [string, number, number][] = [
    ["serverMaxReplicas", settings.serverMaxReplicas, 2],
    ["frontendMaxReplicas", settings.frontendMaxReplicas, 2],
    ["schedulerMaxReplicas", settings.schedulerMaxReplicas, 1],
  ];
  for (const [key, value, floor] of floors) {
    if (value < floor) {
      throw new Error(
        `simple-balance:${key} is ${value}; the chart's minReplicas for that workload is ${floor}.`,
      );
    }
  }

  // Each API and scheduler process holds databasePoolSize connections and takes
  // one more while it starts. The frontend is nginx and holds none. Refusing
  // here beats a replica that scales up and cannot connect.
  const peak =
    (settings.serverMaxReplicas + settings.schedulerMaxReplicas) * (settings.databasePoolSize + 1);
  if (peak > settings.maxConnections) {
    throw new Error(
      `Scaled all the way out this deployment opens (${settings.serverMaxReplicas} + ${settings.schedulerMaxReplicas}) x ` +
        `(${settings.databasePoolSize} + 1) = ${peak} PostgreSQL connections, past the ${settings.maxConnections} ` +
        "simple-balance:maxConnections says the server allows. Lower simple-balance:databasePoolSize, lower a replica " +
        "ceiling, or raise max_connections on the database and say so with simple-balance:maxConnections.",
    );
  }

  return settings;
}

export interface CertManagerArgs {
  provider: k8s.Provider;
  settings: Settings;
  /**
   * The `http01.ingress` block of the ACME solver. On a controller that serves
   * every Ingress from one address this is `{ class: "nginx" }` and cert-manager
   * creates a throwaway Ingress; on GKE, where a new Ingress means a new load
   * balancer on a new address the DNS record does not point at, it names the
   * Ingress that already exists instead.
   */
  solverIngress: pulumi.Input<Record<string, pulumi.Input<string>>>;
  dependsOn?: pulumi.Resource[];
}

export interface CertManager {
  release: k8s.helm.v3.Release;
  clusterIssuer: k8s.apiextensions.CustomResource;
  issuerName: string;
}

export function certManager(args: CertManagerArgs): CertManager {
  const { provider, settings } = args;

  const release = new k8s.helm.v3.Release(
    "cert-manager",
    {
      name: "cert-manager",
      chart: "cert-manager",
      version: certManagerVersion,
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      namespace: "cert-manager",
      createNamespace: true,
      values: { crds: { enabled: true } },
      timeout: 600,
    },
    { provider, dependsOn: args.dependsOn },
  );

  const issuerName = settings.acmeStaging ? "letsencrypt-staging" : "letsencrypt-production";
  const acmeServer = settings.acmeStaging
    ? "https://acme-staging-v02.api.letsencrypt.org/directory"
    : "https://acme-v02.api.letsencrypt.org/directory";

  // The chart's startupapicheck is a Helm hook, and Helm waits for hooks, so a
  // completed release already means the webhook is answering. Without that this
  // would need a sleep: cert-manager's webhook rejects a ClusterIssuer for a few
  // seconds after its Deployment reports ready.
  const clusterIssuer = new k8s.apiextensions.CustomResource(
    "letsencrypt",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: { name: issuerName },
      spec: {
        acme: {
          server: acmeServer,
          email: settings.acmeEmail,
          privateKeySecretRef: { name: `${issuerName}-account-key` },
          solvers: [{ http01: { ingress: args.solverIngress } }],
        },
      },
    },
    { provider, dependsOn: [release] },
  );

  return { release, clusterIssuer, issuerName };
}

export interface AppArgs {
  provider: k8s.Provider;
  settings: Settings;
  issuerName: string;
  ingressClassName: string;
  ingressAnnotations?: Record<string, pulumi.Input<string>>;
  dependsOn?: pulumi.Resource[];
}

export interface App {
  namespace: k8s.core.v1.Namespace;
  credentials: k8s.core.v1.Secret;
  release: k8s.helm.v3.Release;
  ingressName: string;
}

export function simpleBalance(args: AppArgs): App {
  const { provider, settings } = args;

  const namespace = new k8s.core.v1.Namespace(
    "simple-balance",
    { metadata: { name: settings.namespace } },
    { provider },
  );

  const credentialData: Record<string, pulumi.Input<string>> = {
    DATABASE_URL: settings.databaseUrl,
    AUTH_SECRET: settings.authSecret,
  };
  if (settings.directDatabaseUrl) {
    credentialData.DIRECT_DATABASE_URL = settings.directDatabaseUrl;
  }
  if (settings.setupToken) {
    credentialData.SETUP_TOKEN = settings.setupToken;
  }

  // The chart hands every key of this Secret to the API and the scheduler as an
  // environment variable, so it carries the credentials and nothing else. It is
  // built here rather than by the chart because chart values end up in the
  // release's own Secret and in its history; these two never leave the Pulumi
  // config, which holds them encrypted.
  const credentials = new k8s.core.v1.Secret(
    "simple-balance-env",
    {
      metadata: { name: `${releaseName}-env`, namespace: namespace.metadata.name },
      stringData: credentialData,
    },
    { provider, parent: namespace },
  );

  const image = (component: string) => ({
    repository: `${settings.imageRepositoryPrefix}/simple-balance-${component}`,
    tag: settings.imageTag,
  });

  const release = new k8s.helm.v3.Release(
    "simple-balance",
    {
      name: releaseName,
      chart: chartPath,
      namespace: namespace.metadata.name,
      // The first start against an empty database runs every migration under an
      // advisory lock before readiness opens, and Helm is waiting on readiness.
      // The 300s default is a rollout that fails while it is still working.
      timeout: 900,
      values: {
        global: { imageRegistry: settings.imageRegistry },
        config: {
          appBaseUrl: `https://${settings.hostname}`,
          allowedEmails: settings.allowedEmails,
          databasePoolSize: settings.databasePoolSize,
        },
        secret: { create: false, existingSecret: credentials.metadata.name },
        server: {
          image: image("server"),
          autoscaling: { enabled: true, maxReplicas: settings.serverMaxReplicas },
        },
        frontend: {
          image: image("frontend"),
          autoscaling: { enabled: true, maxReplicas: settings.frontendMaxReplicas },
        },
        scheduler: {
          image: image("scheduler"),
          autoscaling: { enabled: true, maxReplicas: settings.schedulerMaxReplicas },
        },
        ingress: {
          enabled: true,
          className: args.ingressClassName,
          annotations: args.ingressAnnotations ?? {},
          host: settings.hostname,
          tls: { enabled: true, clusterIssuer: args.issuerName },
        },
      },
    },
    { provider, parent: namespace, dependsOn: [credentials, ...(args.dependsOn ?? [])] },
  );

  return { namespace, credentials, release, ingressName };
}
