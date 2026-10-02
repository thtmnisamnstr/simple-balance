import { describe, expect, it } from "vitest";

import {
  AWS_CLUSTER,
  GCP_CLUSTER,
  OCI_CLUSTER,
  programCode,
  readProgram,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * Who may reach the Kubernetes API server in each `ha` program, and — on the
 * one cloud where it is the deployment's own job — whether anything may reach
 * it at all.
 *
 * The three clouds divide this differently, and the difference is why the gap
 * below went unnoticed. EKS and GKE manage the API endpoint themselves and take
 * the allowed sources as a property of the cluster, so the question is only how
 * wide. OKE puts the endpoint in a subnet of the deployment's own and applies
 * that subnet's security list to it, so there the deployment decides whether the
 * port is open *at all* — and the first OCI program opened 80 and 443 and
 * stopped, which is correct for the load balancer sharing that subnet and
 * leaves the control plane unreachable.
 *
 * What that costs is worth stating, because it is not an outage anybody would
 * read as a firewall. The cluster builds. It reports ACTIVE. The node pool
 * reports its requested size. And no node ever becomes ready, because every
 * kubelet's registration is dropped before it arrives — so the failure reads as
 * a broken image or a bad Kubernetes version, which is where the first day of
 * debugging goes.
 *
 * `pulumi preview` cannot see any of it: the security list and the cluster both
 * plan cleanly against a real tenancy, which is exactly how far that program was
 * exercised. Only a real `pulumi up` meets the empty node pool. So this is the
 * check that stands in for the `pulumi up` nobody has run.
 */

const programs = {
  aws: readProgram(AWS_CLUSTER),
  gcp: readProgram(GCP_CLUSTER),
  oci: readProgram(OCI_CLUSTER),
};

/** Every `{...}` entry of one array property of a resource call. */
function rules(call: string, property: string): string[] {
  const at = call.indexOf(`${property}: [`);
  if (at === -1) return [];
  const body = call.slice(at + property.length + 3);
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) entries.push(body.slice(start, index + 1));
    } else if (character === "]" && depth === 0) break;
  }
  return entries;
}

/** The OKE API endpoint's subnet is the public one; its list is `-public`. */
const publicList = () => {
  const list = resourceCallsCode(programs.oci, "oci.core.SecurityList").find((call) =>
    call.includes(`${"$"}{name}-public`),
  );
  expect(list, "the OCI cluster program declares a public security list").toBeDefined();
  return list!;
};

describe("the OKE control plane is reachable", () => {
  it("admits 6443 from the worker subnet, without which no node ever joins", () => {
    const ingress = rules(publicList(), "ingressSecurityRules");
    const fromWorkers = ingress.filter(
      (rule) => rule.includes("source: privateCidr") && rule.includes("min: 6443"),
    );
    expect(fromWorkers).toHaveLength(1);
    expect(fromWorkers[0]).toContain('protocol: "6"');
  });

  it("admits 12250 from the worker subnet, without which nodes join and go NotReady", () => {
    const ingress = rules(publicList(), "ingressSecurityRules");
    const credentials = ingress.filter(
      (rule) => rule.includes("source: privateCidr") && rule.includes("min: 12250"),
    );
    expect(credentials).toHaveLength(1);
  });

  it("admits 6443 from the operator, so the program can finish installing ingress-nginx", () => {
    // Not an operator convenience: Pulumi's own Kubernetes provider installs the
    // ingress controller into this cluster in the `pulumi up` that creates it,
    // and it reaches the API over the public endpoint like any other client.
    const list = publicList();
    expect(list).toContain("settings.controlPlaneCidrs");
    expect(list).toContain('["0.0.0.0/0"]');
  });

  it("opens nothing else to the internet", () => {
    const ingress = rules(publicList(), "ingressSecurityRules");
    const open = ingress
      .filter((rule) => rule.includes('source: "0.0.0.0/0"'))
      .flatMap((rule) => [...rule.matchAll(/min: (\d+)/g)].map((match) => match[1]!));
    // 80 for the ACME challenge and the redirect, 443 for the site. The worker
    // rules are sourced from the worker subnet and the operator rule from
    // `controlPlaneCidrs`, so neither appears here.
    expect(open.sort()).toEqual(["443", "80"]);
    // ICMP 3,4 is the one non-TCP rule the private list carries; the public one
    // sources path-MTU from the workers, so nothing unsourced slips in as ICMP.
    const icmpFromAnywhere = ingress.filter(
      (rule) => rule.includes('source: "0.0.0.0/0"') && rule.includes("icmpOptions"),
    );
    expect(icmpFromAnywhere).toHaveLength(0);
  });
});

describe("every cluster program spends the setting it is handed", () => {
  // `controlPlaneCidrs` is parsed once in `deploy/pulumi/common/index.ts` and
  // reaches all three programs, so a program that reads nothing accepts the
  // setting, validates it, documents it and ignores it — which is worse than
  // not offering it, because an operator who narrows the control plane believes
  // they have. OCI did exactly that until this test was written.
  it.each(Object.entries(programs))("%s narrows the API endpoint", (_cloud, program) => {
    expect(programCode(program)).toContain("settings.controlPlaneCidrs");
  });
});
