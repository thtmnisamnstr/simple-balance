import * as path from "path";

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { type AppSettings, chartConfig, readAppSettings } from "./app-settings";

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

/**
 * Where the PostgreSQL this deployment writes to lives, which is the one
 * question these programs cannot answer on an operator's behalf.
 *
 * `external` is what every release up to this one did, and is still the
 * default: the connection string is a stack secret, the cluster runs no
 * database, and `pulumi up` on a stack written for 0.1.6 plans exactly what it
 * planned then. `in-cluster` turns on the chart's Citus cluster instead.
 *
 * A closed set rather than a boolean, because these are not two ends of one
 * switch. A third answer is entirely plausible later — a managed PostgreSQL
 * this program provisions, say — and a boolean would have to be retired to
 * admit it, which is the rename a released setting may not have.
 */
export type DatabaseLocation = "external" | "in-cluster";

const databaseLocations: DatabaseLocation[] = ["external", "in-cluster"];

/**
 * `max_connections` as the chart's Patroni configuration sets it.
 *
 * The connection budget below measures a scaled-out deployment against whatever
 * the database allows, and with `database: "in-cluster"` that number is no
 * longer the operator's to know — the chart decides it. Left at the 100 that
 * stands for a default PostgreSQL, the budget would refuse replica ceilings
 * this cluster can serve perfectly well, which is wrong in the direction that
 * looks like caution and costs capacity.
 *
 * Written here rather than read out of the template, because a Pulumi program
 * cannot render Helm. `tests/helm-cluster-database.test.ts` holds the two
 * together, and the direction that matters is this number being the larger:
 * that would let a stack plan a peak the database then refuses at runtime.
 */
export const inClusterMaxConnections = 200;

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
  /**
   * What the frontend's nginx believes X-Forwarded-For from, as the operator
   * wrote it: one address or CIDR, or several separated by commas or spaces,
   * each a proxy's own and nothing wider. Unset leaves the answer to the
   * program, which knows the network it built — see {@link TrustedProxies}.
   */
  trustedProxyCidr?: string;
  /**
   * Whether nginx walks X-Forwarded-For past those addresses. Unset means off
   * beside an operator's own list — one written before recursion existed was
   * written for a header that is replaced — and the program's choice beside
   * the program's list.
   */
  realIpRecursive?: boolean;
  /**
   * Whether the chart runs the database or the operator brings one. See
   * {@link DatabaseLocation}.
   */
  database: DatabaseLocation;
  /**
   * Who may reach the Kubernetes API server over the internet, as the operator
   * wrote it: one address or CIDR, or several separated by commas or spaces.
   *
   * Empty leaves it open, which is what every release so far did and what an
   * existing stack therefore keeps. It is a setting rather than a value this
   * program picks because the program cannot know where its operator is, and
   * the failure mode of guessing is the worst one available: a control plane
   * that refuses the next `pulumi up`, from a stack that can now only be
   * repaired through the cloud console.
   *
   * The endpoint stays reachable at all rather than being closed outright — a
   * private-only control plane means every `pulumi up` and every `kubectl` runs
   * from inside the VPC, which is a bastion this profile does not build.
   */
  controlPlaneCidrs: string[];
  /**
   * The connection string, when the operator brings the database.
   *
   * Absent with `database: "in-cluster"`, and there is nothing a stack secret
   * could usefully hold there: the password is generated inside the render and
   * the host is a Service that does not exist until the release does. The chart
   * derives the whole string, including the `sslmode=verify-full` and the CA
   * path that go with a cluster whose certificate it also issued.
   */
  databaseUrl?: pulumi.Output<string>;
  authSecret: pulumi.Output<string>;
  directDatabaseUrl?: pulumi.Output<string>;
  setupToken?: pulumi.Output<string>;
  /**
   * Every other setting the application reads: `simple-balance:env` and
   * `simple-balance:secrets`, checked by `readAppSettings`. The plain half
   * reaches the chart's values; the secret half joins the Secret this program
   * builds, which the cluster's own key encrypts at rest — a KMS key on EKS
   * and GKE, which those two programs create for exactly that.
   */
  app: AppSettings;
}

/**
 * The settings these programs decide themselves, each with the reason a stack
 * cannot also set it in `simple-balance:env` or `:secrets`.
 */
const CLUSTER_OWNED = {
  APP_BASE_URL: "it is https:// and simple-balance:hostname, so set that",
  ALLOWED_EMAILS: "it is simple-balance:allowedEmails, so set that",
  DATABASE_POOL_SIZE: "it is simple-balance:databasePoolSize, so set that",
  AUTH_SECRET: "it is simple-balance:authSecret, so set that",
  DATABASE_URL:
    "it is simple-balance:databaseUrl, or the chart's own with simple-balance:database in-cluster",
  DIRECT_DATABASE_URL: "it is simple-balance:directDatabaseUrl, so set that",
  SETUP_TOKEN: "it is simple-balance:setupToken, so set that",
  NODE_ENV:
    "the chart sets production, and anything else turns off the setup code, sign-in rate limiting and secure cookies",
  PORT: "the chart's Service and probes are built around the port it sets",
  RECURRENCE_SCHEDULER: "the chart decides it per workload: off in the API, on in the scheduler",
  TRUST_PROXY:
    "the ingress and the frontend are in front of the API, and false there would put every visitor on one sign-in allowance",
} as const;

/**
 * Both programs read the same `simple-balance:` config namespace, so the
 * instructions for one stack are the instructions for the other.
 */
export function readSettings(): Settings {
  const cfg = new pulumi.Config("simple-balance");

  const database = (cfg.get("database") ?? "external") as DatabaseLocation;
  if (!databaseLocations.includes(database)) {
    throw new Error(
      `simple-balance:database is one of ${databaseLocations.join(" or ")}. Got "${database}". ` +
        "Leave it unset for the bring-your-own database every release so far has had.",
    );
  }

  // Refused here rather than left to the chart's own guard, which says the same
  // thing but says it once Helm is already rolling — three minutes into an
  // install, with a namespace and a Secret already created. Every other
  // contradiction in this file refuses at plan time and this one is no
  // different for being about two settings instead of one.
  if (database === "in-cluster" && cfg.getSecret("databaseUrl") !== undefined) {
    throw new Error(
      "simple-balance:database is in-cluster and simple-balance:databaseUrl names a database as well. " +
        "The chart derives the connection string for the cluster it runs, so the secret would be ignored " +
        "rather than honored. Remove it with `pulumi config rm --secret simple-balance:databaseUrl`, or " +
        "set simple-balance:database to external to go on using it.",
    );
  }

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
    // The operator's number wins either way; what changes with an in-cluster
    // database is only what "unset" means. 100 stands for a stock PostgreSQL
    // nobody here configured, and is the wrong floor for one this chart
    // configured itself.
    maxConnections:
      cfg.getNumber("maxConnections") ??
      (database === "in-cluster" ? inClusterMaxConnections : 100),
    kubernetesVersion: cfg.get("kubernetesVersion"),
    trustedProxyCidr: cfg.get("trustedProxyCidr"),
    realIpRecursive: cfg.getBoolean("realIpRecursive"),
    database,
    // Split the way the chart splits trustedProxyCidr, so an operator who has
    // written one of these lists has written both.
    controlPlaneCidrs: (cfg.get("controlPlaneCidrs") ?? "")
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    // Still required when the operator brings the database, which is the
    // default, so an existing stack meets the same demand it always has. It is
    // `require` rather than `get` for the reason it always was: with neither a
    // secret here nor a cluster to derive one from, the only thing left to
    // refuse is the chart, and it refuses in the middle of a rollout.
    databaseUrl: database === "external" ? cfg.requireSecret("databaseUrl") : undefined,
    authSecret: cfg.requireSecret("authSecret"),
    directDatabaseUrl: cfg.getSecret("directDatabaseUrl"),
    setupToken: cfg.getSecret("setupToken"),
    // Read as the runtime hands it over, already decrypted, so the names are
    // checked here at plan time; the values only ever travel inside the
    // Secret below, as secrets.
    app: readAppSettings(
      cfg.getObject<unknown>("env"),
      (() => {
        const raw = pulumi.runtime.getConfig("simple-balance:secrets");
        return raw === undefined ? undefined : JSON.parse(raw);
      })(),
      CLUSTER_OWNED,
    ),
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

/**
 * Who the frontend's nginx should believe on the network one program built,
 * used when the operator set no `simple-balance:trustedProxyCidr`.
 *
 * A default rather than a requirement, because the program is the one party
 * that knows the answer. Left to the chart's 127.0.0.1 — which is what these
 * programs did before — every visitor's sign-in attempts counted against one
 * allowance, and one stranger could spend it for everybody, on every stack
 * whose operator had not read far enough to find the setting.
 */
export interface TrustedProxies {
  /** Every hop's own address or range. Outputs are fine: the chart takes a list. */
  addresses: pulumi.Input<string>[];
  /** Whether those hops append to X-Forwarded-For rather than replacing it. */
  recursive: boolean;
}

/**
 * The two chart values that decide whose word the frontend takes for an
 * address. The operator's list wins whenever there is one, with recursion off
 * unless they asked for it; otherwise the program's. An explicit
 * `simple-balance:realIpRecursive` wins over the program's choice either way,
 * because it is a decision and the program's is a default.
 */
function frontendTrust(settings: Settings, cloud?: TrustedProxies): Record<string, unknown> {
  if (settings.trustedProxyCidr) {
    return {
      trustedProxyCidr: settings.trustedProxyCidr,
      realIpRecursive: settings.realIpRecursive ?? false,
    };
  }
  if (cloud) {
    return {
      trustedProxyCidr: cloud.addresses,
      realIpRecursive: settings.realIpRecursive ?? cloud.recursive,
    };
  }
  return settings.realIpRecursive === undefined
    ? {}
    : { realIpRecursive: settings.realIpRecursive };
}

export interface AppArgs {
  provider: k8s.Provider;
  settings: Settings;
  issuerName: string;
  /** What to trust when the operator named nothing. See {@link TrustedProxies}. */
  trustedProxies?: TrustedProxies;
  /**
   * On the frontend Service, which is what the ingress points at. The GCP
   * program names container-native load balancing here rather than relying on
   * GKE's default, because what the frontend trusts depends on which of the two
   * paths the load balancer takes.
   */
  frontendServiceAnnotations?: Record<string, pulumi.Input<string>>;
  /**
   * Left out for a controller that does not read `spec.ingressClassName`.
   * GKE's built-in controller is one: it honors only the legacy
   * `kubernetes.io/ingress.class` annotation, so the GCP program passes the
   * annotation instead and omits this — a class name here selected nothing,
   * and no load balancer was ever provisioned.
   */
  ingressClassName?: string;
  ingressAnnotations?: Record<string, pulumi.Input<string>>;
  /**
   * The StorageClass the database's volumes are cut from, with
   * `database: "in-cluster"`. Named by the program rather than left to the
   * cluster's default, because the default StorageClass is where a provider
   * writes its own idea of a volume and neither cloud's says `encrypted`. This
   * is the one place at-rest encryption for the ledger is actually decided, so
   * the class has to be one of these programs' own.
   */
  databaseStorageClass?: pulumi.Input<string>;
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

  const inCluster = settings.database === "in-cluster";

  const credentialData: Record<string, pulumi.Input<string>> = {
    AUTH_SECRET: settings.authSecret,
  };
  // Left out entirely with an in-cluster database rather than written blank.
  // This Secret is the *later* of the two envFrom sources the chart gives the
  // pods, so a key here beats the one the chart derived — an empty DATABASE_URL
  // would not be ignored, it would win, and the API would start against nothing.
  if (settings.databaseUrl) {
    credentialData.DATABASE_URL = settings.databaseUrl;
  }
  if (settings.directDatabaseUrl) {
    credentialData.DIRECT_DATABASE_URL = settings.directDatabaseUrl;
  }
  if (settings.setupToken) {
    credentialData.SETUP_TOKEN = settings.setupToken;
  }
  for (const [name, value] of Object.entries(settings.app.secret)) {
    credentialData[name] = pulumi.secret(value);
  }

  // The chart hands every key of this Secret to the API and the scheduler as an
  // environment variable, so it carries the credentials and nothing else — the
  // four this program has keys for, and whatever the stack put in
  // `simple-balance:secrets`. It is
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
          // The stack's plain settings first, so the three this program
          // decides itself are written last; `readAppSettings` has already
          // refused a map that named any of them.
          ...chartConfig(settings.app.plain),
          appBaseUrl: `https://${settings.hostname}`,
          allowedEmails: settings.allowedEmails,
          databasePoolSize: settings.databasePoolSize,
        },
        // `create` turns on only for an in-cluster database, and then both are
        // set at once — which the chart permits in that one case and refuses in
        // every other. The split is the point: the chart's own Secret is the
        // only place a connection string for a cluster it built can be written,
        // because it generated the password; the Secret above is the only place
        // AUTH_SECRET may go, because chart values land in the release Secret
        // and in Helm's history. Neither could carry both.
        secret: { create: inCluster, existingSecret: credentials.metadata.name },
        ...(inCluster
          ? {
              // The chart's own defaults for shape — two worker groups at two
              // replicas each — which is the redundant one of the profile's two
              // shapes and the one a three-zone autoscaling cluster is for. The
              // smaller shape is a values file laid over a `helm upgrade
              // --install`, not a stack setting: it turns off the autoscaling
              // and the disruption budgets these programs exist to set up, so
              // offering it here would be offering a cluster at odds with
              // itself.
              database: {
                enabled: true,
                ...(args.databaseStorageClass
                  ? { persistence: { storageClass: args.databaseStorageClass } }
                  : {}),
              },
              // Worth having only now. Until the database was in the cluster,
              // the policies guarded an API and a frontend that talk to each
              // other and to the internet; now there is a ledger behind them
              // that nothing outside those two should ever open a socket to.
              // Both programs make their CNI enforce it — this object is inert
              // on a cluster whose CNI ignores NetworkPolicy, and inert is the
              // most dangerous thing a security control can be.
              networkPolicy: { enabled: true },
            }
          : {}),
        server: {
          image: image("server"),
          autoscaling: { enabled: true, maxReplicas: settings.serverMaxReplicas },
        },
        frontend: {
          image: image("frontend"),
          autoscaling: { enabled: true, maxReplicas: settings.frontendMaxReplicas },
          // The operator's list, or else the one the program worked out for the
          // network it built. The chart's schema refuses an entry that is not an
          // address or a CIDR, and the image refuses it again at startup. Behind
          // the ingress every request arrives from a proxy, so until this names
          // it the API counts every visitor's sign-in attempts against one
          // allowance.
          ...frontendTrust(settings, args.trustedProxies),
          // Annotations only: Helm merges this into the chart's own
          // frontend.service, so the port stays the chart's to decide.
          ...(args.frontendServiceAnnotations
            ? { service: { annotations: args.frontendServiceAnnotations } }
            : {}),
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
