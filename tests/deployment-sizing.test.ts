import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * The sizing table exists twice, and this holds the two together.
 *
 * `deploy/pulumi/single-common/index.ts` is where it is *executed*: both cloud
 * programs read it to choose an instance shape and a data disk, which
 * `oci-single` raises to OCI's 50 GB minimum. The five PostgreSQL settings are
 * what the document gives for the server `DATABASE_URL` names, and nothing on
 * the machine applies them. `docs/deployment-sizing.md` is where it is *read*,
 * by somebody deciding how big a machine to buy.
 *
 * A table that disagrees with the program implementing it is worse than no
 * table: the reader sizes their machine from the document, the program builds
 * something else, and nothing says so. There is no way to make one derive from
 * the other — a markdown document is not generated here, and the Pulumi project
 * is a separate npm project this suite cannot import — so the check is that
 * they say the same thing.
 *
 * Read as text rather than imported for that last reason: `single-common`
 * imports `@pulumi/pulumi`, which is installed in `deploy/pulumi/node_modules`
 * and not in this one.
 */
const SOURCE = read("deploy/pulumi/single-common/index.ts");
const DOC = read("docs/deployment-sizing.md");

const NAMES = ["small", "medium", "large"] as const;

/** One size's block out of the `SIZES` literal, by name. */
function sizeBlock(name: string): string {
  const start = SOURCE.indexOf(`\n  ${name}: {`);
  expect(start, `${name} is missing from SIZES`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  },", start);
  return SOURCE.slice(start, end);
}

function field(name: string, key: string): string {
  const match = new RegExp(`${key}: "?([^",\\n]+)"?,`).exec(sizeBlock(name));
  expect(match, `${name}.${key} is missing`).not.toBeNull();
  return match![1]!.trim();
}

/** A row of a markdown table, split into its cells. */
function row(label: string): string[] {
  const line = DOC.split("\n").find((candidate) => candidate.startsWith(`| ${label} |`));
  expect(line, `docs/deployment-sizing.md has no row starting "| ${label} |"`).toBeDefined();
  return line!
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

describe("the sizing table, in the document and in the program", () => {
  it("agrees about the machine", () => {
    for (const name of NAMES) {
      const cells = row(`\`${name}\``);
      expect(cells[1], `${name} vCPU`).toBe(field(name, "vcpu"));
      expect(cells[2], `${name} memory`).toBe(`${field(name, "memoryGib")} GiB`);
      expect(cells[3], `${name} data disk`).toBe(`${field(name, "dataGib")} GiB`);
    }
  });

  it("agrees about the five PostgreSQL settings", () => {
    const settings: [string, string][] = [
      ["`shared_buffers`", "sharedBuffers"],
      ["`effective_cache_size`", "effectiveCacheSize"],
      ["`work_mem`", "workMem"],
      ["`maintenance_work_mem`", "maintenanceWorkMem"],
      ["`max_wal_size`", "maxWalSize"],
    ];
    for (const [label, key] of settings) {
      const cells = row(label);
      NAMES.forEach((name, index) => {
        expect(cells[index + 1], `${label} at ${name}`).toBe(field(name, key));
      });
    }
  });

  /**
   * And that the capacity column is the arithmetic the document describes
   * rather than a number somebody liked.
   *
   * 1,248 bytes per transaction is measured — 50,000 transactions with one in
   * ten split three ways occupied 60 MB across `posting`, `ledger_transaction`
   * and `transaction_leg`, indexes included. The rest is the document's own
   * sentence: the disk, less the write-ahead log, less a gigabyte of slack,
   * divided between a ledger and fourteen dumps of it at 0.15x each.
   */
  it("derives the capacity column from the measurement", () => {
    const bytesPerTransaction = 1248;
    const dumpRatio = 0.15;
    const dumps = 14;
    const slackGib = 1;

    // The two measured figures are quoted in the prose, so a change to one
    // without the other is caught here rather than read as fact.
    expect(DOC, "the measured cost per transaction").toContain(
      `**${bytesPerTransaction.toLocaleString("en-US")} bytes per transaction**`,
    );

    for (const name of NAMES) {
      const disk = Number(field(name, "dataGib"));
      const wal = Number(field(name, "maxWalSize").replace("GB", ""));
      const usableBytes = (disk - wal - slackGib) * 1024 ** 3;
      const transactions = usableBytes / (1 + dumps * dumpRatio) / bytesPerTransaction;
      const stated = `${(transactions / 1e6).toFixed(1)}M transactions`;
      expect(row(`\`${name}\``)[4], `${name} capacity`).toBe(stated);
    }
  });
});
