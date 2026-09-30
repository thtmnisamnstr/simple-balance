import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * The sizing table exists twice, and this holds the two together.
 *
 * `deploy/pulumi/single-common/index.ts` is where it is *executed*: both cloud
 * programs read it twice, once for each machine — `simple-balance:size` picks
 * the application node's row and `simple-balance:databaseSize` the database
 * node's — to choose an instance shape and a data disk, which `oci-single`
 * raises to OCI's 50 GB minimum. The five PostgreSQL settings used to be
 * advice about a server somebody else ran, applied by nothing; the profile now
 * owns a database, and the database node's render writes them into env.base
 * for `compose.postgres.yml` to pass as `-c` flags.
 * `docs/deployment-sizing.md` is where the table is *read*, by somebody
 * deciding how big a machine to buy.
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

/**
 * The five PostgreSQL numbers, which are no longer dead.
 *
 * They were in the table, in the document, and applied by nothing: advice about
 * a machine this repository did not build. The database node applies them, and
 * these are the two joints that would have to hold for that to stay true — the
 * render has to write each one under the name the compose file reads, and the
 * compose file has to pass each one to the server. A settings block whose names
 * do not line up is five numbers that look applied and do nothing, which is
 * exactly what the `vps` file did with an `environment:` block the postgres
 * image never read.
 */
describe("the PostgreSQL settings the database machine actually runs on", () => {
  const COMPOSE = read("deploy/compose/single/compose.postgres.yml");
  const EXAMPLE = read("deploy/compose/single/.env.postgres.example");
  const RENDER = read("deploy/pulumi/single-common/cloud-init.ts");

  const applied = [
    ["sharedBuffers", "POSTGRES_SHARED_BUFFERS", "shared_buffers"],
    ["effectiveCacheSize", "POSTGRES_EFFECTIVE_CACHE_SIZE", "effective_cache_size"],
    ["workMem", "POSTGRES_WORK_MEM", "work_mem"],
    ["maintenanceWorkMem", "POSTGRES_MAINTENANCE_WORK_MEM", "maintenance_work_mem"],
    ["maxWalSize", "POSTGRES_MAX_WAL_SIZE", "max_wal_size"],
  ] as const;

  it("passes each of the five to the server as a `-c` flag on the variable it is written as", () => {
    for (const [, variable, setting] of applied) {
      // `-c name=${VAR:-default}`, which is the only form the postgres image
      // acts on: the image reads none of these names out of the environment.
      expect(COMPOSE, setting).toMatch(new RegExp(`- ${setting}=\\$\\{${variable}:-[^}]+\\}`));
    }
  });

  /**
   * The defaults beside those flags, which are what a hand install actually
   * runs on.
   *
   * Two of the five did not match `SIZES.small` and nothing saw it, because the
   * check above reads only the variable name: `effective_cache_size` defaulted
   * to 3GB against the table's 1536MB, and `max_wal_size` to 2GB against 4GB.
   * Both files say in prose that the defaults *are* the smallest row, so a
   * reader who left the lines commented as instructed had no way to notice —
   * and a Pulumi-built machine, which writes all five, never met it.
   */
  it("defaults each of the five to the smallest row, which is what both files claim", () => {
    for (const [key, variable, setting] of applied) {
      const match = new RegExp(`- ${setting}=\\$\\{${variable}:-([^}]+)\\}`).exec(COMPOSE);
      expect(match, setting).not.toBeNull();
      expect(match![1], `${setting}'s default is SIZES.small.${key}`).toBe(field("small", key));
      // And the commented copy an operator uncomments, which is the same claim
      // written a third time.
      expect(EXAMPLE, variable).toContain(`#${variable}=${field("small", key)}`);
    }
  });

  it("writes each of the five from the row the database node was sized with", () => {
    for (const [key, variable] of applied) {
      expect(RENDER, variable).toContain(`${variable}=\${size.${key}}`);
    }
    // And the connection ceiling, which is a setting of its own rather than a
    // column of the table: one application process at DATABASE_POOL_SIZE 10,
    // plus one while it starts, plus psql and pg_dump, is eleven of it.
    expect(RENDER).toContain("POSTGRES_MAX_CONNECTIONS=${database.maxConnections}");
    expect(COMPOSE).toMatch(/- max_connections=\$\{POSTGRES_MAX_CONNECTIONS:-50\}/);
    expect(SOURCE).toContain(
      'const databaseMaxConnections = cfg.getNumber("databaseMaxConnections") ?? 50;',
    );
  });

  it("sizes the database machine from the same table, by a setting of its own", () => {
    // Defaulted to the application node's size rather than to `small`, so a
    // stack that asked for `medium` and said nothing else gets a database that
    // can keep up with the machine in front of it — and named separately
    // because the two want opposite things.
    expect(SOURCE).toContain('const databaseSizeName = cfg.get("databaseSize") ?? sizeName;');
    expect(SOURCE).toContain("const databaseSize = SIZES[databaseSizeName];");
  });
});
