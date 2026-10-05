import { describe, expect, it } from "vitest";

import {
  AWS_SINGLE,
  OCI_SINGLE,
  programCode,
  readProgram,
  resourceCalls,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * Every inbound rule the `single` profile opens, on both machines and both
 * clouds, asserted exhaustively rather than by sampling.
 *
 * Exhaustively is the point. A test that checked "5432 is open to the
 * application node" would pass just as happily on a security group that also
 * opened it to the world, and a rule added in a hurry is exactly the shape of
 * mistake nothing else here would catch: `pulumi up` does not complain, the
 * deployment works, and the ledger is reachable. So each rule is counted and
 * each source named, and an unexpected one fails.
 *
 * The two shapes that carry the guarantee are different on each cloud and the
 * difference matters. AWS takes a source *security group*, which stays correct
 * when the application node is replaced or re-addressed. OCI's security lists
 * take CIDRs only, so the application node's subnet — which holds exactly one
 * machine — is the tightest source available there.
 */

const aws = readProgram(AWS_SINGLE);
const oci = readProgram(OCI_SINGLE);

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
    } else if (character === "]" && depth === 0) {
      break;
    }
  }
  return entries;
}

const securityGroup = (name: string) =>
  programCode(resourceCalls(aws, "aws.ec2.SecurityGroup").find((call) => call.includes(name))!);

const securityList = (name: string) =>
  programCode(resourceCalls(oci, "oci.core.SecurityList").find((call) => call.includes(name))!);

describe("what may reach the AWS application node", () => {
  const group = () => securityGroup("Simple Balance single-profile application node");

  it("opens 80, 443/tcp and 443/udp to everybody, and conditionally 22 to one address", () => {
    const ingress = rules(group(), "ingress");
    // Four entries and the fourth is inside a spread that is empty unless
    // `simple-balance:sshCidr` is set — and `readSingleSettings` refuses
    // 0.0.0.0/0 for it, so there is no spelling of the stack that opens SSH to
    // the internet.
    expect(ingress, "three always and one when asked for").toHaveLength(4);
    expect(ingress.map((rule) => /fromPort: (\d+)/.exec(rule)?.[1])).toEqual([
      "80",
      "443",
      "443",
      "22",
    ]);
    expect(group()).toContain("...(settings.sshCidr");
    expect(ingress[3]).toContain("cidrBlocks: [settings.sshCidr]");
  });

  it("is the only machine in the profile the internet may reach, and only because of ACME", () => {
    // Caddy terminates TLS here and gets its certificate by the HTTP-01
    // challenge, which needs Let's Encrypt to reach this name on port 80. There
    // is no load balancer in this profile, so this machine is the edge.
    const [http, https, quic, ssh] = rules(group(), "ingress");
    for (const rule of [http, https, quic]) {
      expect(rule, rule).toContain('cidrBlocks: ["0.0.0.0/0"]');
    }
    // The one exception, and it names one address rather than the internet.
    expect(ssh).not.toContain("0.0.0.0/0");
    expect(aws).toContain("this machine is the edge");
  });

  it("opens neither 3000 nor 5432 on it", () => {
    // 3000 is the application, which Caddy reaches over the Docker network
    // inside the machine; a rule for it would be a second way in that the
    // application's own origin checks do not cover. 5432 is on the other
    // machine, and this one connects out to it.
    for (const port of ["3000", "5432"]) {
      expect(group(), port).not.toContain(`fromPort: ${port}`);
    }
  });
});

describe("what may reach the AWS database node", () => {
  const group = () => securityGroup("Simple Balance single-profile database node");

  it("has one unconditional inbound rule, for 5432 from the application node's security group", () => {
    const ingress = rules(group(), "ingress");
    // Two literals in the source: 5432 always, and 22 inside the spread that
    // only `simple-balance:databaseEgress: ipv6` unfolds. The count is asserted
    // rather than left open, so a third rule is a failing test rather than a
    // line nobody reviews.
    expect(ingress, "5432, and the conditional shell").toHaveLength(2);
    expect(ingress[0]).toContain("fromPort: 5432");
    expect(ingress[0]).toContain("toPort: 5432");
    // A source security group rather than a CIDR, so the rule stays correct
    // when the application node is replaced or moved within its subnet.
    expect(ingress[0]).toContain("securityGroups: [securityGroup.id]");
    expect(ingress[0]).not.toContain("cidrBlocks");
  });

  it("admits nothing from the internet, on any port", () => {
    for (const rule of rules(group(), "ingress")) {
      expect(rule, rule).not.toContain("0.0.0.0/0");
      expect(rule, rule).not.toContain("::/0");
    }
  });

  it("opens a port for a shell only where the setting takes Session Manager away", () => {
    // By default there is none, and the machine still has a shell: the same
    // managed policy the application node's role gets, reached through egress
    // alone.
    expect(programCode(aws)).toContain("AmazonSSMManagedInstanceCore");
    expect(programCode(aws)).toContain(
      "const databaseInstanceProfile = database ? shellRole(`${name}-db`).profile : undefined;",
    );
    // Under `databaseEgress: ipv6` there is no IPv4 route out of this subnet,
    // the agent's endpoint is A-only, and the replacement is ssh from the
    // application node — so 22 exists, and it exists *only* inside that
    // condition. A rule that escaped the spread would be a shell port on the
    // machine holding the ledger on every stack, which is what this pins.
    const rule = rules(group(), "ingress")[1]!;
    expect(rule, "the conditional shell rule").toContain("fromPort: 22");
    expect(group()).toMatch(/\.\.\.\(databaseEgress === "ipv6"[\s\S]*?fromPort: 22/);
    // From the application node's own security group, never a CIDR, for the
    // reason 5432 is: it names that machine however it is re-addressed.
    expect(rule).toContain("securityGroups: [securityGroup.id]");
    expect(rule).not.toContain("cidrBlocks");
  });

  it("puts the machine in a subnet that hands out no public address, and asks for none", () => {
    const subnet = resourceCalls(aws, "aws.ec2.Subnet").find((call) => call.includes("-db"))!;
    expect(programCode(subnet)).toContain("mapPublicIpOnLaunch: false");
    const instance = resourceCalls(aws, "aws.ec2.Instance").find((call) =>
      call.includes("`${name}-db`"),
    )!;
    // Two independent reasons rather than one, so a subnet edited later cannot
    // quietly give the database node an address.
    expect(programCode(instance)).toContain("associatePublicIpAddress: false");
    expect(programCode(instance)).toContain("privateIp: databasePrivateIp");
  });
});

/**
 * The third security group in the profile, in front of the two Session Manager
 * interface endpoints `simple-balance:databaseEgress: ssm` builds.
 *
 * Audited here for the reason the file exists: it is a group nothing else
 * counts, and the rule that is easy to leave out of it takes a shell away from
 * a machine that was working. `privateDnsEnabled` on an interface endpoint is
 * VPC-wide rather than subnet-wide — it is a private hosted zone associated
 * with the VPC — so the *application* node, which has a real route out and a
 * working shell today, resolves `ssm.<region>.amazonaws.com` to these private
 * addresses too. Admit only the database node, which is the machine the option
 * was bought for, and the other one silently loses its shell.
 */
describe("what may reach the AWS Session Manager endpoints", () => {
  const group = () => securityGroup("Simple Balance single-profile Session Manager endpoints");

  it("admits 443 from both nodes' security groups, and from nothing else", () => {
    const ingress = rules(group(), "ingress");
    expect(ingress, "one rule per node, and no third").toHaveLength(2);
    expect(ingress.map((rule) => /fromPort: (\d+)/.exec(rule)?.[1])).toEqual(["443", "443"]);
    // The database node, which is why the endpoints exist, and the application
    // node, whose own shell private DNS redirects here.
    expect(ingress[0]).toContain("securityGroups: [databaseSecurityGroup.id]");
    expect(ingress[1]).toContain("securityGroups: [securityGroup.id]");
    for (const rule of ingress) {
      // Source security groups rather than CIDRs, for the reason 5432 is: the
      // rule names exactly those machines however they are re-addressed.
      expect(rule, rule).not.toContain("cidrBlocks");
      expect(rule, rule).not.toContain("0.0.0.0/0");
      expect(rule, rule).not.toContain("::/0");
    }
  });

  it("carries no egress rule at all, which is the tightest an endpoint ENI can be", () => {
    // The provider strips AWS's default allow-all on create, so an absent
    // `egress` leaves this group with none. That is correct rather than merely
    // tolerable: a security group is stateful, so replies to an allowed inbound
    // flow go back regardless, and an endpoint ENI never opens a connection of
    // its own.
    expect(rules(group(), "egress"), "nothing outbound to grant").toHaveLength(0);
  });

  it("has a description no other group's audit can match", () => {
    // These suites find a group by a substring of its description. A name
    // containing either node's would make this group answer for that machine
    // and quietly retire the check that counts its rules.
    const description = /description: "([^"]+)"/.exec(group())?.[1] ?? "";
    expect(description).not.toContain("application node");
    expect(description).not.toContain("database node");
  });
});

describe("what may reach the Oracle Cloud application node", () => {
  const list = () => securityList("displayName: name");

  it("opens 80, 443/tcp and 443/udp to everybody, 22 to a Bastion in its own subnet", () => {
    const ingress = rules(list(), "ingressSecurityRules");
    // Five entries and the fifth is inside a spread that is empty unless
    // `simple-balance:sshCidr` is set.
    expect(ingress, "four always and one when asked for").toHaveLength(5);
    expect(ingress[4]).toContain("source: settings.sshCidr");
    // 6 is TCP and 17 is UDP; OCI takes IANA numbers rather than names.
    expect(ingress[0]).toContain("tcpOptions: { min: 80, max: 80 }");
    expect(ingress[1]).toContain("tcpOptions: { min: 443, max: 443 }");
    expect(ingress[2]).toContain('protocol: "17"');
    // A Bastion's private endpoint sits in the subnet it serves, so without
    // this rule the service has nothing to reach — and SSH is still published
    // to nobody outside the VCN.
    expect(ingress[3]).toContain("source: instanceCidr");
    expect(ingress[3]).toContain("tcpOptions: { min: 22, max: 22 }");
  });

  it("opens neither 3000 nor 5432 on it", () => {
    for (const port of ["3000", "5432"]) {
      expect(list(), port).not.toContain(`min: ${port}`);
    }
  });
});

describe("what may reach the Oracle Cloud database node", () => {
  const list = () => securityList("${name}-db");

  it("admits 5432 from the application node's subnet and 22 from a Bastion in its own", () => {
    const ingress = rules(list(), "ingressSecurityRules");
    expect(ingress, "two rules and no more").toHaveLength(2);
    // A security list takes CIDRs, so the application node's subnet — which
    // holds exactly one machine — is the tightest source available here.
    expect(ingress[0]).toContain("source: instanceCidr");
    expect(ingress[0]).toContain("tcpOptions: { min: 5432, max: 5432 }");
    // The only way onto a machine with no public address. Its own subnet,
    // because that is where a Bastion's private endpoint has to sit.
    expect(ingress[1]).toContain("source: databaseCidr");
    expect(ingress[1]).toContain("tcpOptions: { min: 22, max: 22 }");
    // No sshCidr rule: there is no public address for such a rule to admit
    // anybody to, so it would read as an exposure that is not one.
    expect(list()).not.toContain("settings.sshCidr");
  });

  it("admits nothing from the internet, on any port", () => {
    for (const rule of rules(list(), "ingressSecurityRules")) {
      expect(rule, rule).not.toContain("0.0.0.0/0");
    }
  });

  it("puts the machine in a subnet that forbids a public address, and asks for none", () => {
    const subnet = resourceCalls(oci, "oci.core.Subnet").find((call) => call.includes("-db"))!;
    expect(programCode(subnet)).toContain("prohibitPublicIpOnVnic: true");
    expect(programCode(subnet)).toContain("dnsLabel: databaseSubnetDnsLabel");
    const instance = resourceCalls(oci, "oci.core.Instance").find((call) =>
      call.includes("`${name}-db`"),
    )!;
    expect(programCode(instance)).toContain('assignPublicIp: "false"');
    // The private DNS record the connection string depends on. Without it there
    // is no name, and `sslmode=verify-full` cannot be satisfied by an address.
    expect(programCode(instance)).toContain("assignPrivateDnsRecord: true");
    expect(programCode(instance)).toContain("hostnameLabel: databaseHostLabel");
  });

  it("gives that subnet a way out, which a machine that cannot apt-get does not have", () => {
    // The route to a NAT gateway and the egress rule are what let the node
    // install Docker and pull postgres:18 at first boot. Without either it
    // comes up, cloud-init fails at the first apt-get, and there is nothing in
    // the logs about the network.
    const route = resourceCalls(oci, "oci.core.RouteTable").find((call) => call.includes("-db"))!;
    expect(programCode(route)).toContain("networkEntityId: natGateway.id");
    expect(rules(list(), "egressSecurityRules")).toHaveLength(1);
    expect(list()).toContain('destination: "0.0.0.0/0"');
  });
});

describe("the host firewall, which is the half the cloud's does not cover", () => {
  it("opens 5432 on the database node and nothing else", () => {
    // OCI's Ubuntu images ship a netfilter ruleset that accepts 22 and REJECTs
    // the rest, so the security list opens the cloud and the host still
    // refuses: the machine comes up healthy and every connection times out.
    const platform = readProgram("deploy/pulumi/oci-single/platform.ts");
    const commands = /export const DATABASE_PLATFORM_COMMANDS = \[[\s\S]*?\n\];/.exec(platform);
    expect(commands, "the database node's platform commands").not.toBeNull();
    expect(commands![0]).toContain("--dport 5432 -j ACCEPT");
    expect(commands![0]).toContain("netfilter-persistent save");
    // Nothing for 80 or 443: this machine serves neither, and a rule for a port
    // nothing listens on is an invitation to put something there later.
    expect(commands![0]).not.toContain("--dport 80");
    expect(commands![0]).not.toContain("--dport 443");
  });

  it("is applied to the database node and not only to the application node", () => {
    expect(readProgram("deploy/pulumi/oci-single/platform.ts")).toContain(
      "platformCommands: DATABASE_PLATFORM_COMMANDS,",
    );
  });
});

/**
 * Whether an instance waits for the route its subnet needs.
 *
 * This is an ingress test only in the sense that it is about the network a
 * machine boots into, and it lives here because the two clouds express it
 * differently and the difference is invisible until a machine boots. OCI hands
 * a subnet its `routeTableId` as an input, so an instance placed in that subnet
 * is ordered after the route by the graph. AWS makes the association a separate
 * resource that nothing else refers to: an instance names the subnet and the
 * security group, both of which resolve in seconds, and EC2 launches it while
 * the NAT gateway is still `pending`. Until the association exists the subnet
 * falls back to the VPC's main route table, which carries only the local route.
 *
 * What that costs is the whole of first boot. cloud-init opens with
 * `package_update: true` and installs docker.io, so the machine's first act
 * needs egress; `apt-get` times out, cloud-init records it and carries on, and
 * firstboot reaches `systemctl enable --now docker` with no Docker installed.
 * `pulumi up` reports the stack as up.
 */
describe("the route out, which an instance boots before waiting for", () => {
  it("makes every AWS instance wait for its subnet's route table association", () => {
    const associations = resourceCalls(aws, "aws.ec2.RouteTableAssociation");
    expect(associations, "a public and a private one").toHaveLength(2);
    // Named rather than discarded, which is the whole mechanism: a
    // `new aws.ec2.RouteTableAssociation(...)` whose value is thrown away
    // cannot be named in anything's `dependsOn`.
    const declarations = /const (\w+)\s*=[\s\S]{0,120}?new aws\.ec2\.RouteTableAssociation\(/g;
    const names = [...programCode(aws).matchAll(declarations)].map((match) => match[1]!).sort();
    expect(names).toEqual(["databaseRouteTableAssociation", "routeTableAssociation"]);

    const instances = resourceCallsCode(aws, "aws.ec2.Instance");
    expect(instances, "the application node and the database node").toHaveLength(2);
    expect(instances[0]).toContain("dependsOn: [routeTableAssociation]");
    // The database node's is a list because `ssm` adds the two interface
    // endpoints to it, but the association is still in it unconditionally —
    // which is the property this test is about. The endpoints are a different
    // kind of wait and the program says so: a missing route breaks first boot,
    // while a missing endpoint only means the agent backs off and recovers.
    expect(instances[1]).toMatch(
      /dependsOn: \[\s*\.\.\.\(databaseRouteTableAssociation \? \[databaseRouteTableAssociation\] : \[\]\),/,
    );
    expect(instances[1]).toContain("...ssmEndpoints,");
  });

  it("gives every OCI subnet its route table as an input, which needs no dependsOn", () => {
    const subnets = resourceCallsCode(oci, "oci.core.Subnet");
    expect(subnets, "the application subnet and the database subnet").toHaveLength(2);
    for (const subnet of subnets) expect(subnet).toContain("routeTableId:");
  });
});

/**
 * `simple-balance:databaseSubnet`, the setting `databaseNode` supersedes
 * without replacing.
 *
 * It is the OCI program's older way of asking for the private subnet and
 * nothing in it, for an operator who builds a managed PostgreSQL there by hand.
 * Gating the subnet on `databaseNode` made the one combination it exists for
 * build nothing: the run printed a deprecation line telling the operator that
 * `databaseNode` covers it, with `databaseNode` false, and then created no
 * subnet, no route table, no security list and no NAT gateway. `pulumi stack
 * output databaseSubnetId` — which `deploy/pulumi/README.md` tells them to run
 * next — printed nothing, so there was no subnet to place a DB system in.
 */
describe("the empty private subnet, for a database somebody else builds", () => {
  const code = programCode(oci);

  it("builds the private network when either setting asks for it", () => {
    expect(code).toContain(
      "const databaseNetwork = database !== undefined || databaseSubnetWanted",
    );
    // Every resource that makes the subnet usable, not just the subnet: a
    // subnet with no route out is one nothing can be installed into, and a
    // subnet with no security list is refused a database anyway.
    for (const gate of [
      "const natGateway = databaseNetwork",
      "const databaseRouteTable =\n  databaseNetwork && natGateway",
      "const databaseSecurityList = databaseNetwork",
      "const databaseSubnet =\n  databaseNetwork && databaseRouteTable && databaseSecurityList",
    ]) {
      expect(code, gate).toContain(gate);
    }
    expect(code).toContain("export const databaseSubnetId = databaseSubnet?.id");
  });

  it("warns without refusing, and says which of the two cases the stack is in", () => {
    const warning = /if \(databaseSubnetWanted\) \{[\s\S]*?\n\}/.exec(code);
    expect(warning, "the deprecation warning").not.toBeNull();
    expect(warning![0]).toContain("pulumi.log.warn");
    // Never `throw`: a setting that was accepted stays accepted.
    expect(warning![0]).not.toContain("throw");
    // Two branches, because one sentence is half wrong in both cases. With a
    // database node the setting genuinely adds nothing; without one it is the
    // only thing building the subnet, and saying it is ignored would send the
    // reader looking for an output that is then missing.
    expect(warning![0]).toContain("adds nothing here");
    expect(warning![0]).toContain("still honoured");
  });
});
