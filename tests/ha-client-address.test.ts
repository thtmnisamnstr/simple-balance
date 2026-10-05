import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * What the `ha` Pulumi programs tell the frontend about whose word to take for
 * a visitor's address, and what each builds in front of it so that word is the
 * visitor's.
 *
 * Neither program can be run here: they are a separate npm project, their
 * dependencies are not installed where this suite runs, and a real run needs a
 * cloud account. Pulumi's mock runtime can run them, and that is where the
 * values these checks expect were read from. What is held here on every commit
 * is the part that cannot drift quietly — the precedence between the
 * operator's settings and the program's, run as code, and each program's
 * choice read from its source.
 */
const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const common = read("deploy/pulumi/common/index.ts");
const aws = read("deploy/pulumi/aws/index.ts");
const gcp = read("deploy/pulumi/gcp/index.ts");

/**
 * One statement of a program, from its first line to the `);`, `});` or `}`
 * that closes it at the same indentation it opened at. Enough to ask what one
 * Helm release or one call is given without the rest of the file answering
 * for it.
 */
function statement(source: string, opening: string) {
  const start = source.indexOf(opening);
  expect(start, `no ${JSON.stringify(opening)}`).toBeGreaterThan(-1);
  const indent = /[ ]*$/.exec(source.slice(0, start))![0];
  const end = new RegExp(`\\n${indent}(\\}\\);|\\);|\\})\\n`).exec(source.slice(start));
  expect(end, `no end to ${JSON.stringify(opening)}`).not.toBeNull();
  return source.slice(start, start + end!.index + end![0].length);
}

type Trust = (
  settings: { trustedProxyCidr?: string; realIpRecursive?: boolean },
  cloud?: { addresses: unknown[]; recursive: boolean },
) => Record<string, unknown>;

/**
 * `frontendTrust` out of common/index.ts, types stripped by Node itself and
 * run. Read out of the file rather than imported, because importing it would
 * import @pulumi/pulumi, which is not installed where this suite runs.
 */
const frontendTrust = (() => {
  const source = statement(common, "function frontendTrust(");
  return new Function(`${stripTypeScriptTypes(source)}\nreturn frontendTrust;`)() as Trust;
})();

describe("the settings both programs read", () => {
  it("reads the list and the recursion switch from the one namespace", () => {
    expect(common).toContain('trustedProxyCidr: cfg.get("trustedProxyCidr"),');
    expect(common).toContain('realIpRecursive: cfg.getBoolean("realIpRecursive"),');
  });

  it("hands the chart whatever frontendTrust decides", () => {
    const release = statement(
      common,
      'const release = new k8s.helm.v3.Release(\n    "simple-balance",',
    );
    expect(release).toContain("...frontendTrust(settings, args.trustedProxies),");
  });
});

describe("whose choice wins", () => {
  const cloud = { addresses: ["10.0.0.0/16"], recursive: true };

  it("takes the operator's list over the program's, with recursion off unless asked", () => {
    // A list written for a header that is replaced must not start being walked
    // because the program it is set on happens to walk its own.
    expect(frontendTrust({ trustedProxyCidr: "10.4.0.0/14" }, cloud)).toEqual({
      trustedProxyCidr: "10.4.0.0/14",
      realIpRecursive: false,
    });
    expect(
      frontendTrust({ trustedProxyCidr: "10.4.0.0/14", realIpRecursive: true }, cloud),
    ).toEqual({ trustedProxyCidr: "10.4.0.0/14", realIpRecursive: true });
  });

  it("uses the program's list and recursion when the operator named nothing", () => {
    expect(frontendTrust({}, cloud)).toEqual({
      trustedProxyCidr: ["10.0.0.0/16"],
      realIpRecursive: true,
    });
  });

  it("lets an explicit recursion setting overrule the program's", () => {
    expect(frontendTrust({ realIpRecursive: false }, cloud)).toEqual({
      trustedProxyCidr: ["10.0.0.0/16"],
      realIpRecursive: false,
    });
  });

  it("leaves the chart's own defaults alone where a program offers nothing", () => {
    expect(frontendTrust({})).toEqual({});
    expect(frontendTrust({ realIpRecursive: true })).toEqual({ realIpRecursive: true });
  });
});

describe("the AWS program", () => {
  const ingressNginx = statement(
    aws,
    'const ingressNginx = new k8s.helm.v3.Release(\n  "ingress-nginx",',
  );
  const app = statement(aws, "const app = sb.simpleBalance({");

  it("switches proxy protocol on at both ends in the one release", () => {
    // Either half alone is an outage: nginx expecting the header refuses
    // connections without one, and nginx not expecting it reads the header
    // as a request line.
    expect(ingressNginx).toContain('"use-proxy-protocol": "true"');
    expect(ingressNginx).toContain(
      '"service.beta.kubernetes.io/aws-load-balancer-proxy-protocol": "*"',
    );
  });

  it("health checks where nginx parses the header, not the controller's own port", () => {
    // AWS sends the proxy protocol header on health checks too, and the
    // controller's server on 10254 cannot parse it, so every target would go
    // unhealthy the moment proxy protocol came on.
    const port =
      /"service\.beta\.kubernetes\.io\/aws-load-balancer-healthcheck-port": "([^"]+)"/.exec(
        ingressNginx,
      )?.[1];
    expect(port).toBe("80");
    expect(ingressNginx).toContain(
      '"service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol": "http"',
    );
    expect(ingressNginx).toContain(
      '"service.beta.kubernetes.io/aws-load-balancer-healthcheck-path": "/healthz"',
    );
  });

  it("believes a PROXY header from the load balancer's subnets and no pod's", () => {
    // The VPC would read as the same fence and is not: every pod's address is
    // in it, so any pod could write a header naming whatever visitor it liked
    // and ingress-nginx would pass that on as the client.
    const value = /"proxy-real-ip-cidr":\s*([^]*?),\n\s*\},\n/.exec(ingressNginx)?.[1];
    expect(value, "proxy-real-ip-cidr in the ingress-nginx release").toBeDefined();
    expect(value).not.toContain("vpc.cidrBlock");
    expect(value!.replaceAll(/\s+/g, "")).toBe(
      'pulumi.all(publicSubnets.map((subnet)=>subnet.cidrBlock)).apply((cidrs)=>cidrs.join(","))',
    );
    // Those are the subnets the controller puts an internet-facing NLB in,
    // and the nodes, so every pod, are in the others.
    const publicSubnets = statement(aws, "const publicSubnets = Array.from(");
    const privateSubnets = statement(aws, "const privateSubnets = Array.from(");
    const nodeGroup = statement(aws, "const nodeGroup = new aws.eks.NodeGroup(");
    expect(publicSubnets).toContain('"kubernetes.io/role/elb": "1"');
    expect(privateSubnets).not.toContain('"kubernetes.io/role/elb"');
    expect(nodeGroup).toContain("subnetIds: privateSubnets.map((s) => s.id),");
  });

  it("trusts the VPC the pods take their addresses from, without recursion", () => {
    // ingress-nginx sets X-Forwarded-For to its own $remote_addr, so the last
    // entry is the visitor and there is no chain to walk.
    expect(app).toContain("trustedProxies: { addresses: [vpc.cidrBlock], recursive: false },");
  });
});

describe("the GCP program", () => {
  const app = statement(gcp, "const app = sb.simpleBalance({");

  it("names container-native load balancing on the frontend Service", () => {
    // What the pod sees depends on it: Google's front ends through endpoint
    // groups, a node's address through instance groups. The trusted list below
    // is right only for the first.
    expect(app).toContain(
      `frontendServiceAnnotations: { "cloud.google.com/neg": '{"ingress": true}' },`,
    );
    expect(common).toContain("{ service: { annotations: args.frontendServiceAnnotations } }");
    // And the Service is one the GKE Ingress can only reach that way.
    const service = read("deploy/helm/simple-balance/templates/service.yaml");
    const frontend = service.slice(service.indexOf('"component" "frontend"'));
    expect(/^\s+type: (\w+)$/m.exec(frontend)?.[1]).toBe("ClusterIP");
  });

  it("trusts Google's front ends and the load balancer's own address, walking past both", () => {
    const trusted = /trustedProxies: \{\s*addresses: \[([^\]]*)\],\s*recursive: (\w+),\s*\}/.exec(
      app,
    );
    expect(trusted, "trustedProxies in the GCP program").not.toBeNull();
    expect(trusted![1]!.split(",").map((entry) => entry.trim())).toEqual([
      '"130.211.0.0/22"',
      '"35.191.0.0/16"',
      "ingressAddress.address",
    ]);
    // The address it appends last is its own, the same for every visitor, so
    // off would count everybody as the load balancer.
    expect(trusted![2]).toBe("true");
    // The address the Ingress answers on is the one it appends.
    expect(app).toContain('"kubernetes.io/ingress.global-static-ip-name": ingressAddress.name,');
  });
});
