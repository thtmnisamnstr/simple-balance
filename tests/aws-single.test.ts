import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireRegion } from "../deploy/pulumi/aws-single/platform.js";

/**
 * The two things an AWS single-machine stack cannot get back once they are
 * wrong: the region it was built in, and the EBS volume holding the secret,
 * env.local and every nightly dump. `tests/oci-single.test.ts` holds the same
 * two for Oracle Cloud.
 *
 * The region rule is a function in `platform.ts` and is run here. The volume
 * rule is a resource option, and the program that sets it cannot be imported —
 * it needs `@pulumi/pulumi` from `deploy/pulumi/node_modules`, which the job
 * running this suite does not install — so it is read as text, the way
 * `tests/cloud-init.test.ts` reads the attachment's options. What the options
 * do was proved against the real provider on a stand-in of this graph, and
 * `deploy/pulumi/README.md`, "Tearing down on AWS", is what came of it.
 */

const root = path.resolve(import.meta.dirname, "..");
const program = readFileSync(path.join(root, "deploy/pulumi/aws-single/index.ts"), "utf8");

/** The program with its comment lines taken out, for what it does rather than says. */
const code = program
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
  .join("\n");

/** From `new <kind>(` to the `);` that closes it at the start of a line. */
function resourceCall(kind: string): string {
  const start = program.indexOf(`new ${kind}(`);
  expect(start, kind).toBeGreaterThan(-1);
  expect(program.indexOf(`new ${kind}(`, start + 1), `one ${kind}`).toBe(-1);
  return program.slice(start, program.indexOf("\n);\n", start));
}

/**
 * Where the program declares its first resource. A setting that refuses has to
 * refuse before this, because `pulumi up --skip-preview` creates whatever was
 * registered before a program throws. The AMI lookup above it is an invoke,
 * which reads and creates nothing.
 */
const firstResource = program.indexOf("new aws.");

function refusal(region: string | undefined): string {
  try {
    requireRegion(region);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`requireRegion(${JSON.stringify(region)}) did not refuse`);
}

describe("the region an AWS single-machine stack is built in", () => {
  it("is refused when the stack does not name one, blank included", () => {
    for (const unset of [undefined, "", "   "]) {
      expect(refusal(unset), JSON.stringify(unset)).toMatch(
        /^aws:region is required, in this stack: pulumi config set aws:region <region>/,
      );
    }
  });

  it("says what would decide it otherwise, and which region an older stack is in", () => {
    const message = refusal(undefined);
    expect(message).toContain("AWS_REGION or AWS_DEFAULT_REGION from the shell");
    // The provider records a region on every resource, so the wrong one is a
    // plan to rebuild the whole stack elsewhere rather than a lookup that fails.
    expect(message).toContain("would plan to replace every resource there");
    expect(message).toContain(
      "which `pulumi stack output shell` names after --region: set that one, never another.",
    );
  });

  it("is any region at all", () => {
    for (const region of ["us-west-2", "eu-central-1", "ap-southeast-2", "sa-east-1"]) {
      expect(requireRegion(region)).toBe(region);
    }
  });

  it("is read from the stack's own key before any resource is declared, and exported", () => {
    const check = 'const awsRegion = requireRegion(new pulumi.Config("aws").get("region"));';
    expect(program).toContain(check);
    expect(firstResource).toBeGreaterThan(-1);
    expect(program.indexOf(check), "checked before the first resource").toBeLessThan(firstResource);
    expect(program).toContain("export const region = awsRegion;");
    // aws.config.region falls back to AWS_REGION, which is the shell deciding.
    expect(code).not.toContain("aws.config.region");
  });

  it("is where the refusal says an older stack will find it", () => {
    expect(program).toMatch(
      /export const shell = pulumi\.interpolate`aws ssm start-session --target \$\{instance\.id\} --region \$\{awsRegion\}`;/,
    );
  });
});

describe("the data volume an AWS single-machine stack keeps", () => {
  const setting =
    'const protectDataVolume =\n  new pulumi.Config("simple-balance").getBoolean("protectDataVolume") ?? true;';

  it("is protected unless the stack turns it off", () => {
    expect(program).toContain(setting);
    expect(resourceCall("aws.ebs.Volume")).toMatch(/\n {2}\{ protect: protectDataVolume \},$/);
  });

  it("reads the switch before any resource is declared, so a malformed one builds nothing", () => {
    expect(program.indexOf(setting)).toBeGreaterThan(-1);
    expect(program.indexOf(setting)).toBeLessThan(firstResource);
  });

  it("protects the volume and nothing else, so the machine can still be replaced", () => {
    // The documented way back from a machine gone wrong is replacing it, and
    // its attachment and address association go with it. Any of them
    // protected would refuse that.
    expect(code.match(/\bprotect:/g)).toHaveLength(1);
    for (const kind of ["aws.ec2.Instance", "aws.ec2.VolumeAttachment", "aws.ec2.EipAssociation"]) {
      expect(resourceCall(kind), kind).not.toMatch(/\bprotect\b/);
    }
  });

  it("is built before the machine and from nothing of it, so replacing the machine keeps it", () => {
    // The machine's user data names the volume by its id, so the dependency
    // runs from the instance to the volume. The other way round, a replaced
    // machine would be a replaced volume, which the protection then refuses.
    const volume = resourceCall("aws.ebs.Volume");
    expect(volume).not.toMatch(/\binstance\b|dependsOn/);
    expect(program.indexOf("new aws.ebs.Volume(")).toBeLessThan(
      program.indexOf("new aws.ec2.Instance("),
    );
  });

  it("is named in the outputs, for the snapshot a teardown takes first", () => {
    expect(program).toContain("export const dataVolumeId = dataVolume.id;");
  });
});
