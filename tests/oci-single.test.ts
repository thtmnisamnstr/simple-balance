import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ListedVolume } from "../deploy/pulumi/oci-single/platform.js";
import { requireDataVolumeDomain, requireRegion } from "../deploy/pulumi/oci-single/platform.js";

/**
 * The two things an Oracle Cloud stack cannot get back once they are wrong:
 * the region it was built in, and the data volume holding the secret,
 * env.local and every nightly dump.
 *
 * The region rule, and which availability domain the volume allows, are
 * functions in `platform.ts` and are run here. The rest of the volume rule is
 * a resource option, and the program that sets it cannot be imported —
 * it needs `@pulumi/pulumi` from `deploy/pulumi/node_modules`, which the job
 * running this suite does not install — so it is read as text, the way
 * `tests/cloud-init.test.ts` reads the attachment's options.
 */

const root = path.resolve(import.meta.dirname, "..");
const program = readFileSync(path.join(root, "deploy/pulumi/oci-single/index.ts"), "utf8");

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
 * registered before a program throws. An invoke above it reads and creates
 * nothing.
 */
const firstResource = program.indexOf("new oci.");

function refusal(region: string | undefined): string {
  try {
    requireRegion(region);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`requireRegion(${JSON.stringify(region)}) did not refuse`);
}

describe("the region an Oracle Cloud stack is built in", () => {
  it("is refused when the stack does not name one, blank included", () => {
    for (const unset of [undefined, "", "   "]) {
      expect(refusal(unset), JSON.stringify(unset)).toMatch(
        /^oci:region is required, in this stack: pulumi config set oci:region <region>/,
      );
    }
  });

  it("says what would decide it otherwise, and that Always Free lives in one region", () => {
    const message = refusal(undefined);
    expect(message).toContain("OCI_REGION or the region of whichever ~/.oci/config profile");
    expect(message).toContain(
      "only in the tenancy's home region, which is chosen at sign-up and cannot be changed",
    );
    // A stack built before the rule has resources somewhere already, and a
    // provider pointed anywhere else looks for them where they are not.
    expect(message).toContain("in the region its profile named: set that one, never another.");
  });

  it("is any region at all, because a promise about a country is one deployment's", () => {
    for (const region of ["us-ashburn-1", "eu-frankfurt-1", "ap-tokyo-1", "sa-saopaulo-1"]) {
      expect(requireRegion(region)).toBe(region);
    }
  });

  it("is read from the provider's own key before any resource is declared, and exported", () => {
    const check = 'const ociRegion = requireRegion(new pulumi.Config("oci").get("region"));';
    expect(program).toContain(check);
    expect(firstResource).toBeGreaterThan(-1);
    expect(program.indexOf(check), "checked before the first resource").toBeLessThan(firstResource);
    expect(program).toContain("export const region = ociRegion;");
  });
});

describe("the data volume an Oracle Cloud stack keeps", () => {
  const setting = 'const protectDataVolume = cfg.getBoolean("protectDataVolume") ?? true;';

  /** The volume's inputs, and the resource options after them. */
  function volume(): { inputs: string; options: string } {
    const call = resourceCall("oci.core.Volume");
    const split = call.lastIndexOf("\n  {\n");
    return { inputs: call.slice(0, split), options: call.slice(split) };
  }

  it("is protected unless the stack turns it off", () => {
    expect(program).toContain(setting);
    expect(volume().options).toMatch(/^\n {2}\{\n {4}protect: protectDataVolume,\n/);
  });

  it("is built only once a machine has launched, so a launch refused for capacity leaves none", () => {
    // Built beside the network, an empty protected volume was waiting in the
    // domain when the launch failed, and moving to another domain — what the
    // capacity error is answered with — was refused as a replacement of it.
    const { inputs, options } = volume();
    expect(options).toMatch(/\n {4}dependsOn: \[instance\],\n/);
    // By dependsOn alone. A property read off the instance would make every
    // replacement of the machine a replacement of the volume as well.
    expect(inputs).not.toMatch(/\binstance\b/);
  });

  it("is named in the outputs, for the manual backup a teardown takes first", () => {
    expect(program).toContain("export const dataVolumeId = dataVolume.id;");
  });

  it("reads the switch before any resource is declared, so a malformed one builds nothing", () => {
    expect(program.indexOf(setting)).toBeGreaterThan(-1);
    expect(program.indexOf(setting)).toBeLessThan(firstResource);
  });

  it("protects the volume and nothing else, so the machine can still be replaced", () => {
    // The documented way back from a machine gone wrong is replacing it, and
    // its attachment goes with it. Either one protected would refuse that.
    expect(program.match(/\bprotect:/g)).toHaveLength(1);
    expect(resourceCall("oci.core.Instance")).not.toMatch(/\bprotect\b/);
    expect(resourceCall("oci.core.VolumeAttachment")).not.toMatch(/\bprotect\b/);
  });
});

describe("an availability domain the kept data volume is not in", () => {
  const AD1 = "Uocm:US-ASHBURN-AD-1";
  const AD2 = "Uocm:US-ASHBURN-AD-2";
  const volume = (availabilityDomain: string, state = "AVAILABLE"): ListedVolume => ({
    id: "ocid1.volume.oc1.iad.kept",
    availabilityDomain,
    state,
  });

  it("is refused while the volume is protected, with the way back in the message", () => {
    // Pulumi refuses replacing a protected volume only on reaching it, after
    // the instance, and under --skip-preview the machine has been deleted and
    // relaunched in the new domain by then. So the program refuses first.
    for (const state of ["AVAILABLE", "PROVISIONING", "RESTORING", "FAULTY"]) {
      expect(() => requireDataVolumeDomain(AD2, [volume(AD1, state)], true), state).toThrow(
        `simple-balance:availabilityDomain chooses ${AD2}, but this stack's data volume ` +
          `(ocid1.volume.oc1.iad.kept) is in ${AD1}`,
      );
    }
    expect(() => requireDataVolumeDomain(AD2, [volume(AD1)], true)).toThrow(
      `neither the machine nor the volume has been touched. To stay: pulumi config set simple-balance:availabilityDomain "${AD1}".`,
    );
    expect(() => requireDataVolumeDomain(AD2, [volume(AD1)], true)).toThrow(
      "copy off what is on it first, then set simple-balance:protectDataVolume to false.",
    );
  });

  it("is the domain it is in, whatever the case, and anything at all before there is one", () => {
    // The provider compares availability domains without case to decide a
    // replacement, so a difference of case alone moves nothing.
    expect(requireDataVolumeDomain(AD1, [volume(AD1)], true)).toBe(AD1);
    expect(requireDataVolumeDomain(AD1, [volume(AD1.toLowerCase())], true)).toBe(AD1);
    // No volume is what a launch refused for capacity leaves, and the retry in
    // another domain has to go through.
    expect(requireDataVolumeDomain(AD2, [], true)).toBe(AD2);
    for (const state of ["TERMINATING", "TERMINATED"]) {
      expect(requireDataVolumeDomain(AD2, [volume(AD1, state)], true), state).toBe(AD2);
    }
  });

  it("is let through once the stack turns the protection off", () => {
    expect(requireDataVolumeDomain(AD2, [volume(AD1)], false)).toBe(AD2);
  });

  it("is checked where every zoned resource takes its domain from, under the volume's own name", () => {
    const start = program.indexOf("const availabilityDomain = ");
    expect(start).toBeGreaterThan(-1);
    const domain = program.slice(start, program.indexOf(";\n", start));
    expect(domain).toContain(
      "oci.core.getVolumesOutput({ compartmentId, displayName: dataVolumeName })",
    );
    expect(domain).toMatch(
      /requireDataVolumeDomain\(\s+chooseAvailabilityDomain\([\s\S]+\),\s+existing\.volumes \?\? \[\],\s+protectDataVolume,\s+\)/,
    );
    // One value names the volume and the lookup, so neither is renamed alone.
    expect(program).toContain("const dataVolumeName = `${name}-data`;");
    for (const kind of ["oci.core.Instance", "oci.core.Volume"]) {
      expect(resourceCall(kind), kind).toMatch(/\n {4}availabilityDomain,\n/);
    }
    expect(resourceCall("oci.core.Volume")).toContain("\n    displayName: dataVolumeName,\n");
  });
});
