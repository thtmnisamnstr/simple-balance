import { describe, expect, it } from "vitest";

import {
  IPV6_APT_REWRITE,
  SSM_SHELL_ENDPOINTS,
  databaseUsesIpv6,
  ipv6SubnetCidr,
  readDatabaseEgress,
  requireEndpointZone,
} from "../deploy/pulumi/aws-single/platform.js";
import {
  AWS_SINGLE,
  programCode,
  readProgram,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * The database node's way out on AWS, which is the largest single line in a
 * `small` bill and the only one this profile can make free.
 *
 * A NAT gateway is about $36.50 a month — $32.85 of it the hour rather than the
 * bytes, so nothing that merely moves less data saves anything — against a
 * `small` stack's $96. `simple-balance:databaseEgress: ipv6` replaces it with an
 * egress-only internet gateway and an Amazon-provided IPv6 block, neither of
 * which is charged for at all.
 *
 * What this file is really holding is that the saving is not free of *cost*.
 * The option takes Session Manager away from the machine holding the ledger,
 * because the agent resolves an IPv4-only endpoint and that subnet has no IPv4
 * route once the gateway is gone. A setting that quietly removes the only shell
 * to a database is worse than the bill it removes, so the refusal, the
 * replacement shell and the rule that `nat` stays the default are all checked
 * here rather than described in a document.
 */

const program = readProgram(AWS_SINGLE);
const code = programCode(program);

function refusal(value: string | undefined, sshPublicKey: string): string {
  try {
    readDatabaseEgress(value, sshPublicKey);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`readDatabaseEgress(${JSON.stringify(value)}) did not refuse`);
}

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleEx";

describe("which way out the stack asked for", () => {
  it("is the NAT gateway when the stack says nothing, which is what every older one has", () => {
    // The upgrade rule, at its narrowest: unset must be exactly what the
    // program did before this setting existed, with or without a key.
    expect(readDatabaseEgress(undefined, "")).toBe("nat");
    expect(readDatabaseEgress("", "")).toBe("nat");
    expect(readDatabaseEgress("nat", "")).toBe("nat");
  });

  it("is ipv6 only with a key, because ipv6 is what takes the agent-based shell away", () => {
    expect(readDatabaseEgress("ipv6", KEY)).toBe("ipv6");
    const message = refusal("ipv6", "");
    expect(message).toContain("Session Manager");
    expect(message).toContain("simple-balance:sshPublicKey");
    expect(message).toContain("no way at all onto the machine holding the ledger");
    // And what setting the key does to a stack that already has machines, which
    // is the half an operator meets *after* they have done as they were told.
    // EC2 cannot give a running instance a key pair, so the key arrives as
    // `keyName` on a new one and both machines plan a replacement — a real
    // outage, out of a setting whose name is about routing.
    expect(message).toContain("both instances plan a replacement");
    expect(message).toContain("two rebuilds of downtime");
  });

  it("refuses anything else by name, rather than falling back to a default", () => {
    // A misspelling that silently meant `nat` would be an operator paying $36.50
    // a month for a setting they believe they turned off.
    for (const value of ["none", "app-node", "NAT", "eigw"]) {
      expect(refusal(value, KEY), value).toContain(`is "${value}"; it is nat, ipv6 or ssm`);
    }
    // All three named with their prices, because the refusal is the only place
    // an operator who guessed is told what they could have asked for.
    const message = refusal("endpoints", KEY);
    expect(message).toContain("$36.50");
    expect(message).toContain("$14.60");
  });

  it("takes ssm with no key at all, because ssm is the option that keeps the agent", () => {
    // The key requirement is `ipv6`'s alone and must not spread. It exists to
    // replace a shell that `ipv6` removes; `ssm` does not remove it, so asking
    // for a key here would demand the one input that cannot reach a running
    // instance — EC2 has no API for it, so it arrives as `keyName` on a new
    // machine — and would turn a routing change into two rebuilds for nothing.
    expect(readDatabaseEgress("ssm", "")).toBe("ssm");
    expect(readDatabaseEgress("ssm", KEY)).toBe("ssm");
  });
});

/**
 * The predicate that decides whether the IPv6 network gets built, which `ssm`
 * needs every bit of.
 *
 * This is the file's most load-bearing assertion and it is worth saying why.
 * `ssm` buys a Session Manager shell with two interface endpoints — and an
 * interface endpoint reaches AWS services and nothing else, while the two
 * things this node fetches at first boot are Ubuntu's archive and Docker Hub,
 * neither of which is one. So `ssm` without the IPv6 half is a machine that
 * plans clean, boots, answers a shell, and has no database: apt times out,
 * `docker.io` never installs, `postgres:18` is never pulled. The shell that was
 * paid for is the only thing that works.
 */
describe("which ways out build the IPv6 network", () => {
  it("is both of the ones that are not a NAT gateway", () => {
    expect(databaseUsesIpv6("ipv6")).toBe(true);
    expect(databaseUsesIpv6("ssm")).toBe(true);
    expect(databaseUsesIpv6("nat")).toBe(false);
  });

  it("is asked once and spent everywhere the network is built", () => {
    // Every IPv6 property reads the predicate. A site left comparing against
    // the literal would be invisible to a plan and to a `pulumi up`, and would
    // surface as a first boot with no packages — so the count is pinned rather
    // than sampled.
    const uses = code.match(/\bdatabaseIpv6\b/g) ?? [];
    expect(uses, "one declaration and six uses").toHaveLength(7);
    for (const property of [
      "const databaseBootCommands = databaseIpv6 ?",
      "assignGeneratedIpv6CidrBlock: databaseIpv6 ?",
      "database && databaseIpv6",
      "ipv6CidrBlock: databaseIpv6",
      "assignIpv6AddressOnCreation: databaseIpv6 ?",
      "ipv6AddressCount: databaseIpv6 ?",
    ]) {
      expect(code, property).toContain(property);
    }
  });

  it("leaves exactly three things reading the literal, and they are about the shell", () => {
    // The whole point of the predicate is that nothing about the *network* asks
    // this question any more. What legitimately still does is the trade `ipv6`
    // makes and `ssm` does not: the warning about it, the SSH rule that stands
    // in for the agent, and the shell command itself. A fourth occurrence is a
    // network property that was missed.
    const literals = code.match(/databaseEgress === "ipv6"/g) ?? [];
    expect(literals, "the warning, the SSH rule and the printed shell").toHaveLength(3);
    expect(code).toContain('if (databaseEgress === "ipv6") {');
    expect(code).toMatch(/\.\.\.\(databaseEgress === "ipv6"/);
    expect(code).toMatch(/export const databaseShell[\s\S]*?databaseEgress === "ipv6"/);
  });
});

describe("the endpoints ssm buys, and the ones it deliberately does not", () => {
  it("is ssm and ssmmessages, and never ec2messages", () => {
    expect([...SSM_SHELL_ENDPOINTS]).toEqual(["ssm", "ssmmessages"]);
    // $7.30 a month each, so a third out of caution is a third of the bill
    // again. `ec2messages` is not caution: SSM Agent stopped calling it at
    // 3.3.40.0, regions launched from 2024 never offered it, and AWS retires
    // the endpoint on 2026-09-30. Paying for it would be paying for a service
    // being switched off.
    expect([...SSM_SHELL_ENDPOINTS]).not.toContain("ec2messages");
    expect([...SSM_SHELL_ENDPOINTS]).not.toContain("s3");
  });

  it("refuses, naming the zone and the ways out, when the zone cannot hold one", () => {
    // An interface endpoint is an ENI in a subnet, and AWS does not offer every
    // service in every zone. This program names no availability zone — it takes
    // the one AWS gave the first subnet — so a stack can be unlucky, and what
    // AWS answers on its own is a raw error at the endpoint that names neither
    // the setting nor an alternative.
    //
    // The name of this test is careful on purpose. The refusal is plan-time on
    // a stack whose subnets exist, which is the upgrade path off `nat`; on a
    // stack with none it arrives during `up`, because the zone is an unknown
    // Output at preview and Pulumi runs no `apply` over an unknown. Only the
    // function is exercised here, so claiming `preview` would be asserting a
    // guarantee this file never reaches. The test below holds the property that
    // makes the difference, and `platform.ts` carries why pinning a zone to
    // close it is refused for this release.
    const serviceName = "com.amazonaws.us-east-1.ssmmessages";
    expect(requireEndpointZone(serviceName, "us-east-1a", ["us-east-1a", "us-east-1b"])).toBe(
      serviceName,
    );
    let message = "";
    try {
      requireEndpointZone(serviceName, "us-east-1e", ["us-east-1a", "us-east-1b"]);
    } catch (error) {
      message = (error as Error).message;
    }
    // Naming what is missing, which is the service and the zone, and then the
    // two ways out that need no endpoint at all.
    expect(message).toContain(serviceName);
    expect(message).toContain("us-east-1e");
    expect(message).toContain("us-east-1a, us-east-1b");
    expect(message).toContain("pulumi config rm simple-balance:databaseEgress");
    expect(message).toContain("ipv6");
  });

  it("names no availability zone, which is what decides when that refusal lands", () => {
    // The property the test above cannot reach, held where it is decided. This
    // program gives no subnet an `availabilityZone` of its own: the first takes
    // whichever AWS picks and the second is pinned to it. That is why the zone
    // is an unknown Output on a stack with no subnets, and therefore why the
    // check runs during `up` there rather than at `pulumi preview`.
    //
    // Pinning a zone would make it preview-time everywhere and is refused: the
    // zone a program picks is not the one AWS already gave an existing stack,
    // so it would plan a replacement of both subnets and with them both
    // machines. If a later release takes that trade, this assertion is the one
    // to change, deliberately, and `docs/deployment-costs.md` is the paragraph
    // that has to change with it.
    const subnets = resourceCallsCode(program, "aws.ec2.Subnet");
    expect(subnets, "the application subnet and the database subnet").toHaveLength(2);
    const application = subnets.find((subnet) => !subnet.includes("`${name}-db`"));
    expect(application, "the application subnet").toBeDefined();
    expect(application!, "no zone is chosen").not.toContain("availabilityZone");
    expect(
      subnets.find((subnet) => subnet.includes("`${name}-db`"))!,
      "the second is pinned to the first rather than asked for again",
    ).toContain("availabilityZone: subnet.availabilityZone");
  });

  it("pins each endpoint ENI's address, because the machine's cannot move", () => {
    // Under `nat` the database subnet holds one interface and `10.20.1.10` only
    // had to clear AWS's four reserved addresses. `ssm` puts two more ENIs in
    // it and creates them *first*, because the instance names the endpoints in
    // `dependsOn` — so an address AWS chose could be the machine's, and the
    // launch would fail `InvalidIPAddress.InUse` identically on every retry.
    // Moving the machine is not the escape: its address is the name in the
    // server certificate's SAN and in DATABASE_URL.
    const endpoint = resourceCallsCode(program, "aws.ec2.VpcEndpoint")[0]!;
    expect(endpoint).toContain("subnetConfigurations: [");
    expect(endpoint).toContain("ipv4: ssmEndpointPrivateIps[service]");
    // Keyed by the service list, so a third endpoint fails the typecheck rather
    // than silently reusing an address, and none of them is the machine's.
    const addresses = [...code.matchAll(/^ {2}(ssm|ssmmessages): "([\d.]+)",$/gm)].map((m) => m[2]);
    expect(addresses, "one per service").toHaveLength(2);
    expect(new Set(addresses).size, "and they are different").toBe(2);
    expect(addresses).not.toContain("10.20.1.10");
    expect(code).toContain(
      "const ssmEndpointPrivateIps: Record<(typeof SSM_SHELL_ENDPOINTS)[number], string>",
    );
  });

  it("lets an empty list through rather than refusing on silence", () => {
    // The data source documents `availabilityZones` as unavailable for services
    // in other regions. Turning silence into a refusal would make this option
    // unusable somewhere it works, and letting it through is never worse than
    // having no check: that stack fails exactly where it fails today.
    expect(requireEndpointZone("com.amazonaws.eu-west-1.ssm", "eu-west-1a", [])).toBe(
      "com.amazonaws.eu-west-1.ssm",
    );
  });
});

describe("the /64 the database subnet takes out of the VPC's /56", () => {
  it("sets the low byte of the fourth group and nothing else", () => {
    expect(ipv6SubnetCidr("2600:1f18:2d35:d500::/56", 1)).toBe("2600:1f18:2d35:d501::/64");
    expect(ipv6SubnetCidr("2600:1f18:2d35:d500::/56", 0)).toBe("2600:1f18:2d35:d500::/64");
    expect(ipv6SubnetCidr("2600:1f18:2d35:d500::/56", 255)).toBe("2600:1f18:2d35:d5ff::/64");
  });

  it("reads the compressed form AWS actually returns, rather than splicing the string", () => {
    // AWS answers with `::`, and a block whose fourth group compresses
    // differently would otherwise put the subnet in somebody else's range.
    expect(ipv6SubnetCidr("2600:1f18:abcd:e00::/56", 1)).toBe("2600:1f18:abcd:0e01::/64");
    expect(ipv6SubnetCidr("2a05:d000:0:1200::/56", 1)).toBe("2a05:d000:0:1201::/64");
  });

  it("refuses a prefix it cannot cut a /64 out of, and an index outside a byte", () => {
    expect(() => ipv6SubnetCidr("2600:1f18:2d35:d500::/64", 1)).toThrow(/is a \/56/);
    expect(() => ipv6SubnetCidr("10.20.0.0/16", 1)).toThrow(/is a \/56/);
    expect(() => ipv6SubnetCidr("2600:1f18:2d35:d500::/56", 256)).toThrow(/0-255/);
    expect(() => ipv6SubnetCidr("2600:1f18:2d35:d500::/56", -1)).toThrow(/0-255/);
  });
});

describe("what the program builds for each choice", () => {
  it("builds the NAT gateway and its address only for the nat choice", () => {
    // Both, because the Elastic IP is $3.65 of the $36.50 and an address left
    // allocated to nothing is billed at a higher rate than one in use.
    expect(code).toContain('database && databaseEgress === "nat"');
    expect(code).toMatch(/new aws\.ec2\.NatGateway\(/);
    // And the egress-only gateway for both of the others, which is the
    // resource that carries no charge of any kind. Both, because `ssm` is the
    // same IPv6 network with Session Manager put back inside the VPC — the
    // endpoints reach AWS and nothing else, so without this gateway there is no
    // apt and no image.
    expect(code).toMatch(/database && databaseIpv6\s*\?\s*new aws\.ec2\.EgressOnlyInternetGateway/);
  });

  it("gives the private subnet one default route, never both", () => {
    // `::/0` to the egress-only gateway replaces `0.0.0.0/0` rather than
    // joining it. Leaving the IPv4 default route in place with nothing behind
    // it would be a blackhole that times out instead of failing.
    const routeTables = resourceCallsCode(program, "aws.ec2.RouteTable");
    const databaseTable = routeTables.find((table) => table.includes("`${name}-db`"));
    expect(databaseTable, "the private subnet's route table").toBeDefined();
    expect(databaseTable!).toContain('[{ cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id }]');
    expect(databaseTable!).toContain('[{ ipv6CidrBlock: "::/0", egressOnlyGatewayId:');
  });

  it("adds the IPv6 block only for those choices, so an existing VPC plans nothing", () => {
    // `assignGeneratedIpv6CidrBlock` and the subnet's `ipv6CidrBlock` are
    // in-place updates rather than replacements, which is what makes this
    // option safe to turn on — but `undefined` rather than `false` is what
    // makes turning it *off* a no-op on a stack that never had it. That is the
    // upgrade rule at its narrowest: a `nat` stack plans nothing at all.
    expect(code).toContain("assignGeneratedIpv6CidrBlock: databaseIpv6 ? true : undefined,");
    expect(code).toMatch(/ipv6CidrBlock: databaseIpv6/);
    expect(code).toContain("assignIpv6AddressOnCreation: databaseIpv6 ? true : undefined,");
    expect(code).toContain("ipv6AddressCount: databaseIpv6 ? 1 : undefined,");
  });

  /**
   * The replacement shell, and the property that matters about it.
   *
   * The database node's exposure is one rule by default — 5432 from the
   * application node — and this adds a second only under `ipv6`. Sourced from
   * the application node's *security group* and never from a CIDR, which is the
   * same rule 5432 follows: it names exactly that machine however it is
   * replaced or re-addressed, where a CIDR names whatever else is ever put in
   * the range.
   */
  it("opens SSH from the application node, and only when the agent-based shell is gone", () => {
    const groups = resourceCallsCode(program, "aws.ec2.SecurityGroup");
    const database = groups.find((group) => group.includes("single-profile database node"));
    expect(database, "the database node's security group").toBeDefined();
    const ingress = database!.slice(
      database!.indexOf("ingress: ["),
      database!.indexOf("egress: ["),
    );
    expect(ingress).toContain("fromPort: 5432");
    expect(ingress).toMatch(/databaseEgress === "ipv6"\s*\?\s*\[\s*\{/);
    expect(ingress).toContain("fromPort: 22");
    expect(ingress).toContain("securityGroups: [securityGroup.id],");
    // Never from the internet and never from a range, on either rule.
    expect(ingress, "no CIDR source on the database node").not.toContain("cidrBlocks");
    expect(ingress).not.toContain("0.0.0.0/0");
  });

  /**
   * The two interface endpoints, and the property that decides whether this
   * option is worth anything: they are built *in addition to* the IPv6 network
   * and never instead of it.
   *
   * An endpoint reaches AWS services. Ubuntu's archive resolves into AWS's EC2
   * prefix rather than its S3 one and Docker Hub's blobs are on Cloudflare, so
   * no endpoint of any kind carries apt or the image. Endpoints alone would
   * build a machine that comes up, answers a shell, and has no database — which
   * is why there is no setting for the two halves separately.
   */
  it("builds the endpoints only for ssm, and only alongside the IPv6 way out", () => {
    const endpoints = resourceCallsCode(program, "aws.ec2.VpcEndpoint");
    expect(endpoints, "one per service in the shared list").toHaveLength(1);
    expect(code).toContain("SSM_SHELL_ENDPOINTS.map((service) =>");
    // Gated on `ssm` alone, through the security group the endpoints hang off.
    expect(code).toContain('databaseEgress === "ssm"');
    expect(code).toContain("databaseSubnet && ssmEndpointSecurityGroup");
    // The IPv6 half is not a separate setting an operator can forget: it comes
    // from the same value, through the predicate the block above pins.
    expect(databaseUsesIpv6("ssm"), "ssm builds the IPv6 network too").toBe(true);
  });

  it("puts them in the database subnet, with private DNS and the zone checked first", () => {
    const endpoint = resourceCallsCode(program, "aws.ec2.VpcEndpoint")[0]!;
    expect(endpoint).toContain('vpcEndpointType: "Interface"');
    expect(endpoint).toContain("subnetIds: [databaseSubnet.id]");
    expect(endpoint).toContain("securityGroupIds: [ssmEndpointSecurityGroup.id]");
    // Without private DNS the agent resolves the public name to a public
    // address this subnet has no route to, so the endpoints would be paid for
    // and unused.
    expect(endpoint).toContain("privateDnsEnabled: true");
    // The name comes back through the zone check rather than being written
    // straight in, which is what makes an unlucky availability zone a refused
    // preview instead of a create that fails after the network exists.
    expect(endpoint).toContain("requireEndpointZone(serviceName, zone, zones)");
    expect(endpoint).toContain("databaseSubnet.availabilityZone");
  });

  it("prints a shell that works for the choice, rather than one that hangs", () => {
    // Under `ipv6` the database node's own agent reaches nothing, so
    // `aws ssm start-session --target <that machine>` would sit there rather
    // than fail. What is printed instead forwards a port through the
    // *application* node's agent to 22 on the database node.
    //
    // A forward rather than `ssh` run on the application node, because the
    // operator's private key is on their laptop and has to stay there: the key
    // this stack installs on both machines is the authorized half. So the
    // command has to name the application node's id, not the database node's.
    const printed = code.slice(code.indexOf("export const databaseShell"));
    expect(printed).toContain("AWS-StartPortForwardingSessionToRemoteHost");
    expect(printed).toContain("--target ${instance.id}");
    expect(printed).toContain('host="${databasePrivateIp}",portNumber="22"');
    expect(printed).toContain("ssh -p 2222 ubuntu@localhost");
  });
});

describe("the apt mirror, which is where a first boot on IPv6 would otherwise hang", () => {
  it("rewrites the in-region EC2 mirror, which is kept although it now has AAAA", () => {
    // The mirror published no AAAA when this was written and publishes one now
    // — checked 2026-09-30 in us-east-1, us-west-2 and eu-west-1 against three
    // resolvers — so the rewrite buys an out-of-region hop for nothing. It is
    // kept anyway: dropping it changes what every existing `ipv6` stack does at
    // first boot, which is the one moment nobody is watching, and the fact that
    // would justify dropping it is a record in somebody else's DNS.

    expect(IPV6_APT_REWRITE).toContain("ec2[.]archive[.]ubuntu[.]com");
    expect(IPV6_APT_REWRITE).toContain("http://archive.ubuntu.com/ubuntu");
    // Both layouts, because 24.04 moved the archive to deb822 and an image
    // built either side of that move is a machine that boots or does not.
    expect(IPV6_APT_REWRITE).toContain("/etc/apt/sources.list.d/*.sources");
    expect(IPV6_APT_REWRITE).toContain("/etc/apt/sources.list");
    // An unmatched glob is itself in POSIX sh and sed fails on it, and a failed
    // bootcmd stops cloud-init before the database exists.
    expect(IPV6_APT_REWRITE).toContain("|| true");
  });

  it("runs it in the boot stage, which is the only one earlier than package_update", () => {
    // `runcmd` — where `platformCommands` go — runs last, long after the
    // `apt-get` it would have to come before.
    expect(code).toContain("const databaseBootCommands = databaseIpv6 ? [IPV6_APT_REWRITE] : [];");
    const render = programCode(readProgram("deploy/pulumi/single-common/cloud-init.ts"));
    expect(render).toContain("bootcmd:");
    expect(render).toMatch(/\$\{bootCommands\}\npackage_update: true/);
  });

  it("measures the document that will be sent, rather than one without the command", () => {
    // EC2 refuses user data over 16 KB at the launch rather than at the
    // preview, so the pre-flight measurement has to carry every line the real
    // render will.
    const measured = code.indexOf("databaseUserDataBase64(");
    expect(
      code.indexOf("const databaseBootCommands"),
      "defined before the measurement",
    ).toBeLessThan(measured);
    expect(
      code.match(/bootCommands: databaseBootCommands,/g),
      "the check and the render",
    ).toHaveLength(2);
  });
});
