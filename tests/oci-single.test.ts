import { describe, expect, it } from "vitest";

import type { ListedVolume } from "../deploy/pulumi/oci-single/platform.js";
import { requireDataVolumeDomain, requireRegion } from "../deploy/pulumi/oci-single/platform.js";
import {
  OCI_SINGLE,
  programCode,
  readProgram,
  resourceCalls,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * The two things an Oracle Cloud stack cannot get back once they are wrong:
 * the region it was built in, and the data volume holding the secret and
 * every nightly dump.
 *
 * The region rule, and which availability domain the volume allows, are
 * functions in `platform.ts` and are run here. The rest of the volume rule is
 * a resource option, and the program that sets it cannot be imported —
 * it needs `@pulumi/pulumi` from `deploy/pulumi/node_modules`, which the job
 * running this suite does not install — so it is read as text, the way
 * `tests/cloud-init.test.ts` reads the attachment's options.
 */

const program = readProgram(OCI_SINGLE);

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

  /**
   * Each volume's inputs, and the resource options after them. Two of them
   * now: the application node's backups and secret, and the database node's
   * cluster.
   */
  function volumes(): { inputs: string; options: string }[] {
    const calls = resourceCallsCode(program, "oci.core.Volume");
    expect(calls, "one data volume per machine").toHaveLength(2);
    return calls.map((call) => {
      // The options are the last argument, and `protect` is its first key on
      // both volumes. Found by pattern rather than by an indent, because the
      // database node's whole declaration sits inside a ternary.
      const split = /\{\n\s*protect: protectDataVolume,/.exec(call);
      expect(split, "the options follow the inputs").not.toBeNull();
      return { inputs: call.slice(0, split!.index), options: call.slice(split!.index) };
    });
  }

  it("protects both data volumes unless the stack turns it off", () => {
    expect(program).toContain(setting);
    // One switch for both, because they are the same decision — whether this
    // stack may delete somebody's data — and two settings would be a way to
    // protect the backups and not the ledger they back up.
    for (const { options } of volumes()) {
      expect(options).toMatch(/^\{\n\s+protect: protectDataVolume,\n/);
    }
  });

  it("is built only once its machine has launched, so a launch refused for capacity leaves none", () => {
    // Built beside the network, an empty protected volume was waiting in the
    // domain when the launch failed, and moving to another domain — what the
    // capacity error is answered with — was refused as a replacement of it.
    const [application, database] = volumes();
    expect(application!.options).toMatch(/\n {4}dependsOn: \[instance\],\n/);
    expect(database!.options).toMatch(/\n {8}dependsOn: \[databaseInstance\],\n/);
    // By dependsOn alone. A property read off the instance would make every
    // replacement of the machine a replacement of the volume as well.
    for (const { inputs } of volumes()) expect(inputs).not.toMatch(/\binstance\b/i);
  });

  it("names both in the outputs, for the manual backup a teardown takes first", () => {
    expect(program).toContain("export const dataVolumeId = dataVolume.id;");
    expect(program).toContain("export const databaseVolumeId = databaseVolume?.id;");
  });

  it("reads the switch before any resource is declared, so a malformed one builds nothing", () => {
    expect(program.indexOf(setting)).toBeGreaterThan(-1);
    expect(program.indexOf(setting)).toBeLessThan(firstResource);
  });

  it("protects the volumes and nothing else, so either machine can still be replaced", () => {
    // The documented way back from a machine gone wrong is replacing it, and
    // its attachment goes with it. Either one protected would refuse that.
    expect(programCode(program).match(/\bprotect:/g)).toHaveLength(2);
    for (const kind of ["oci.core.Instance", "oci.core.VolumeAttachment"]) {
      for (const call of resourceCallsCode(program, kind)) {
        expect(call, kind).not.toMatch(/\bprotect\b/);
      }
    }
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
    // Both volumes, not just the application node's. The ledger is on the
    // other one, and a check that guarded the backups and not the database
    // they back up would be the wrong half.
    expect(domain).toContain(
      "oci.core.getVolumesOutput({ compartmentId, displayName: dataVolumeName })",
    );
    expect(domain).toContain(
      "oci.core.getVolumesOutput({ compartmentId, displayName: databaseVolumeName })",
    );
    expect(domain).toMatch(
      /requireDataVolumeDomain\(\s+chooseAvailabilityDomain\([\s\S]+\),\s+\[\.\.\.\(existing\.volumes \?\? \[\]\), \.\.\.\(existingDatabase\.volumes \?\? \[\]\)\],\s+protectDataVolume,\s+\)/,
    );
    // One value names each volume and its lookup, so neither is renamed alone.
    expect(program).toContain("const dataVolumeName = `${name}-data`;");
    expect(program).toContain("const databaseVolumeName = `${name}-db-data`;");
    // Every zoned resource on both machines takes the one domain, because a
    // block volume cannot be attached across them.
    for (const kind of ["oci.core.Instance", "oci.core.Volume"]) {
      const calls = resourceCalls(program, kind);
      expect(calls, kind).toHaveLength(2);
      for (const call of calls) expect(call, kind).toMatch(/\n {4,10}availabilityDomain,\n/);
    }
    const [application, database] = resourceCalls(program, "oci.core.Volume");
    expect(application).toContain("\n    displayName: dataVolumeName,\n");
    expect(database).toContain("\n        displayName: databaseVolumeName,\n");
  });
});
