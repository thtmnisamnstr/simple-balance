import { describe, expect, it } from "vitest";

import {
  AWS_SINGLE,
  OCI_SINGLE,
  programCode,
  readProgram,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * One size name buying two differently shaped machines, and the two ways that
 * can go wrong that no document can see.
 *
 * `tests/deployment-sizing.test.ts` holds the table against
 * `docs/deployment-sizing.md`, which is the question "do the numbers agree".
 * This file asks the two questions that come after the split: whether a number
 * shrank, which on a data disk is a `pulumi up` that fails on AWS and a deleted
 * ledger on OCI, and whether each program reads the half of the row that
 * belongs to the machine it is building. Both halves are `{ vcpu, memoryGib,
 * diskGib }` with the same field names, so `size.application` handed to the
 * database node compiles, deploys, and gives somebody a PostgreSQL machine with
 * the application node's disk.
 */

const SOURCE = readProgram("deploy/pulumi/single-common/index.ts");
const aws = programCode(readProgram(AWS_SINGLE));
const oci = programCode(readProgram(OCI_SINGLE));

const NAMES = ["small", "medium", "large"] as const;

/** One size's block out of the `SIZES` literal, by name. */
function sizeBlock(name: string): string {
  const start = SOURCE.indexOf(`\n  ${name}: {`);
  expect(start, `${name} is missing from SIZES`).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("\n  },", start));
}

/** One node's shape out of a row: `application: { vcpu: 2, ... }`. */
function shape(name: string, node: "application" | "database") {
  const match = new RegExp(
    `${node}: \\{ vcpu: (\\d+), memoryGib: (\\d+), diskGib: (\\d+) \\}`,
  ).exec(sizeBlock(name));
  expect(
    match,
    `${name}.${node} is missing or is not a { vcpu, memoryGib, diskGib }`,
  ).not.toBeNull();
  return { vcpu: Number(match![1]), memoryGib: Number(match![2]), diskGib: Number(match![3]) };
}

describe("the size table, now that a row is two machines", () => {
  it("gives every row both shapes, so neither node is sized by the other's appetite", () => {
    for (const name of NAMES) {
      for (const node of ["application", "database"] as const) {
        const node_ = shape(name, node);
        expect(node_.vcpu, `${name}.${node}.vcpu`).toBeGreaterThan(0);
        expect(node_.memoryGib, `${name}.${node}.memoryGib`).toBeGreaterThan(0);
        expect(node_.diskGib, `${name}.${node}.diskGib`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The upgrade rule, as arithmetic rather than as a paragraph.
   *
   * Before the split each row had one `dataGib` that both machines were built
   * with: 20, 50 and 100. Growing a volume is an in-place update on both
   * clouds. Shrinking one AWS refuses outright — `ModifyVolume` will not make a
   * volume smaller — and on OCI it is a replacement, which with
   * `protectDataVolume` off deletes the ledger and with it on fails the
   * preview. So a disk in this table may be made more generous and never less,
   * whatever else a re-shaping changes.
   */
  it("never shrinks a data disk below what the one-disk table gave that node", () => {
    const before: Record<string, number> = { small: 20, medium: 50, large: 100 };
    for (const name of NAMES) {
      for (const node of ["application", "database"] as const) {
        expect(shape(name, node).diskGib, `${name}.${node}.diskGib`).toBeGreaterThanOrEqual(
          before[name]!,
        );
      }
    }
  });

  /**
   * Machines may shrink where disks may not, and this is the one direction that
   * has to hold when they do. The application node stores no ledger and its
   * memory caches nothing the database reads, so every gigabyte belongs on the
   * other machine first.
   */
  it("never gives the application node more memory or more cores than the database node", () => {
    for (const name of NAMES) {
      const application = shape(name, "application");
      const database = shape(name, "database");
      expect(application.memoryGib, `${name} memory`).toBeLessThanOrEqual(database.memoryGib);
      expect(application.vcpu, `${name} cores`).toBeLessThanOrEqual(database.vcpu);
    }
  });
});

describe("each program reading the half of the row its machine is", () => {
  it("never hands one node's shape to the other's resource, on either cloud", () => {
    // Both halves have the same three field names, so the compiler cannot tell
    // these apart: `size.application.diskGib` on the database volume is a
    // PostgreSQL machine with the backup disk, and it typechecks.
    for (const [cloud, program] of [
      ["aws", aws],
      ["oci", oci],
    ] as const) {
      const applicationReads = program.match(/\bsize\.application\./g) ?? [];
      const databaseReads = program.match(/database\.size\.database\./g) ?? [];
      expect(applicationReads.length, `${cloud} reads the application half`).toBeGreaterThan(0);
      expect(databaseReads.length, `${cloud} reads the database half`).toBeGreaterThan(0);
      // `settings.size` is the application node's row and `database.size` the
      // database node's, so the only correct spellings are these two. A bare
      // `size.database` would be the application node sized by the database's
      // column of a row it does not own.
      expect(program, `${cloud} does not cross the halves`).not.toMatch(
        /[^.]\bsize\.database\.|database\.size\.application\./,
      );
    }
  });

  it("sizes each AWS volume from its own node's disk", () => {
    const [application, database] = resourceCallsCode(readProgram(AWS_SINGLE), "aws.ebs.Volume");
    expect(application).toContain("size: size.application.diskGib,");
    expect(database).toContain("size: database.size.database.diskGib,");
  });

  it("raises each OCI volume to the 50 GB floor from its own node's disk", () => {
    // `dataVolumeGb` takes one node's shape rather than a row, so the floor is
    // applied to each disk separately. Before the split there was one number to
    // raise, and `small`'s application and database disks now differ.
    expect(oci).toContain("const dataGb = dataVolumeGb(size.application);");
    expect(oci).toContain(
      "const databaseDataGb = database ? dataVolumeGb(database.size.database) : 0;",
    );
  });

  it("gives each AWS node its own instance-type table, all of them Nitro", () => {
    // Two tables, because the two machines stopped wanting the same shape: the
    // application node comes down to a burstable pair at every size and the
    // database node keeps the cores it had. Every family in both is Nitro, and
    // that is load-bearing rather than incidental — EBS traffic between a Nitro
    // instance and an encrypted volume is encrypted in transit by the
    // hypervisor, with no property to set, so a pre-Nitro family added to
    // either table would take that guarantee away silently.
    const tables = [
      ...aws.matchAll(/const (\w*InstanceTypes): Record<string, string> = \{[\s\S]*?\n\};/g),
    ];
    expect(
      tables.map((table) => table[1]),
      "one table per node",
    ).toEqual(["applicationInstanceTypes", "databaseInstanceTypes"]);
    for (const table of tables) {
      const families = [...table[0].matchAll(/"([a-z0-9]+)\.[a-z0-9]+"/g)].map(
        (match) => match[1]!,
      );
      expect(families.length, table[1]).toBe(3);
      for (const family of families) expect(["t4g", "m7g", "c7g", "r7g"], family).toContain(family);
    }
    // And each node reads its own, which is the mistake the two tables exist to
    // make visible.
    expect(aws).toContain("const instanceType = applicationInstanceTypes[settings.sizeName]!;");
    expect(aws).toContain("instanceType: databaseInstanceTypes[database.sizeName]!,");
  });
});
