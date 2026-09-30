import { describe, expect, it } from "vitest";

import {
  IPV6_APT_REWRITE,
  ipv6SubnetCidr,
  readDatabaseEgress,
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
      expect(refusal(value, KEY), value).toContain(`is "${value}"; it is nat or ipv6`);
    }
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
    // And the egress-only gateway only for the other, which is the resource
    // that carries no charge of any kind.
    expect(code).toMatch(
      /database && databaseEgress === "ipv6"\s*\?\s*new aws\.ec2\.EgressOnlyInternetGateway/,
    );
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

  it("adds the IPv6 block only for that choice, so an existing VPC plans nothing", () => {
    // `assignGeneratedIpv6CidrBlock` and the subnet's `ipv6CidrBlock` are
    // in-place updates rather than replacements, which is what makes this
    // option safe to turn on — but `undefined` rather than `false` is what
    // makes turning it *off* a no-op on a stack that never had it.
    expect(code).toContain(
      'assignGeneratedIpv6CidrBlock: databaseEgress === "ipv6" ? true : undefined,',
    );
    expect(code).toMatch(/ipv6CidrBlock:\s*databaseEgress === "ipv6"/);
    expect(code).toContain(
      'assignIpv6AddressOnCreation: databaseEgress === "ipv6" ? true : undefined,',
    );
    expect(code).toContain('ipv6AddressCount: databaseEgress === "ipv6" ? 1 : undefined,');
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
  it("rewrites the in-region EC2 mirror, which publishes no AAAA record", () => {
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
    expect(code).toContain(
      'const databaseBootCommands = databaseEgress === "ipv6" ? [IPV6_APT_REWRITE] : [];',
    );
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
