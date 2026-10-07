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

/**
 * One machine's half of a row: `application: { vcpu, memoryGib, diskGib }`.
 *
 * A second reader rather than a wider `field`, because the two halves use the
 * same three key names and a regular expression over the whole block would find
 * whichever came first. That is exactly the defect the split was made to fix —
 * one number standing for two machines — so the test that holds the table is
 * the last place it should be able to come back.
 */
function node(name: string, machine: "application" | "database", key: string): string {
  const block = sizeBlock(name);
  const start = block.indexOf(`${machine}: {`);
  expect(start, `${name}.${machine} is missing`).toBeGreaterThan(-1);
  const half = block.slice(start, block.indexOf("}", start));
  const match = new RegExp(`${key}: (\\d+)`).exec(half);
  expect(match, `${name}.${machine}.${key} is missing`).not.toBeNull();
  return match![1]!;
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
  it("agrees about both machines", () => {
    // | `size` | Application node | Its data disk | Database node | Its data disk |
    //
    // Four cells per row rather than three, because a row sizes two machines
    // that want opposite things: the application node runs a Node process that
    // is mostly idle and stores no ledger, the database node runs PostgreSQL.
    for (const name of NAMES) {
      const cells = row(`\`${name}\``);
      for (const [machine, shape, disk] of [
        ["application", 1, 2],
        ["database", 3, 4],
      ] as const) {
        expect(cells[shape], `${name} ${machine} shape`).toBe(
          `${node(name, machine, "vcpu")} vCPU, ${node(name, machine, "memoryGib")} GiB`,
        );
        expect(cells[disk], `${name} ${machine} data disk`).toBe(
          `${node(name, machine, "diskGib")} GiB`,
        );
      }
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
   * And that the two capacity rows are the arithmetic the document describes
   * rather than numbers somebody liked.
   *
   * 1,248 bytes per transaction is measured — 50,000 transactions with one in
   * ten split three ways occupied 60 MB across `posting`, `ledger_transaction`
   * and `transaction_leg`, indexes included — and 0.145 is the measured ratio
   * of a `pg_dump -Fc` to the live database, 8.7 MB of 60.
   *
   * Two formulas rather than one, because the split gave the machines different
   * jobs and the old single formula described neither. The database node holds
   * `PGDATA` and nothing else; the application node holds the dumps and nothing
   * else, and at `backupKeep`'s default of 14 it is the one that binds.
   */
  it("derives both capacity rows from the measurements", () => {
    const bytesPerTransaction = 1248;
    const dumpRatio = 0.145;
    const slackGib = 1;
    // × 1.20 for bloat and × 0.15 for a REINDEX's second copy of the largest
    // index, ÷ 0.95 for ext4's reserved blocks and ÷ 0.80 because a PGDATA
    // volume should not be run fuller than that. The document derives every one
    // of those; this is the same sentence as arithmetic.
    const databaseOverhead = 1.2 + 0.15;
    const usableFraction = 0.95 * 0.8;

    // The two measured figures are quoted in the prose, so a change to one
    // without the other is caught here rather than read as fact.
    expect(DOC, "the measured cost per transaction").toContain(
      `**${bytesPerTransaction.toLocaleString("en-US")} bytes per transaction**`,
    );
    expect(DOC, "the measured dump ratio").toContain(`**${dumpRatio}×**`);

    const millions = (bytes: number) => `${(bytes / bytesPerTransaction / 1e6).toFixed(1)}M`;

    for (const [index, name] of NAMES.entries()) {
      // The database node: its whole disk, less twice max_wal_size, carries the
      // ledger and its overheads.
      const wal = Number(field(name, "maxWalSize").replace("GB", ""));
      const databaseGib = Number(node(name, "database", "diskGib"));
      const ledgerBytes = ((databaseGib * usableFraction - 2 * wal) / databaseOverhead) * 1024 ** 3;
      const ledgerCell = row("Ledger the database disk holds")[index + 1]!;
      expect(ledgerCell.replace(" transactions", ""), `${name} ledger`).toBe(millions(ledgerBytes));

      // The application node: its whole disk, less a gigabyte for the secret
      // and the CA, carries `backupKeep` + 1 dumps — fifteen at the
      // default, because the newest is verified before the oldest is pruned.
      const applicationGib = Number(node(name, "application", "diskGib"));
      const dumpableBytes = (applicationGib * usableFraction - slackGib) * 1024 ** 3;
      for (const [keep, label] of [
        [14, "Dumps the application disk holds, at `backupKeep` 14"],
        [3, "The same at `backupKeep` 3"],
      ] as const) {
        const held = dumpableBytes / ((keep + 1) * dumpRatio);
        expect(
          row(label)[index + 1]!.replace(" transactions", ""),
          `${name} at backupKeep ${keep}`,
        ).toBe(millions(held));
      }
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

/**
 * Oracle's own database half for `small`, held to its row the way the table is.
 *
 * A literal of its own rather than a column of the table, because it is one
 * cloud's machine and AWS builds the row as written; read out of its own block,
 * so a number changed in the program and not the document fails here rather
 * than being found by whoever sized a machine from the page.
 */
describe("Oracle's own database machine for `small`", () => {
  const start = SOURCE.indexOf("export const OCI_DATABASE_SIZES");
  const block = SOURCE.slice(start, SOURCE.indexOf("\n};", start));
  const shape = /database: \{ vcpu: (\d+), memoryGib: (\d+), diskGib: (\d+) \}/.exec(block);
  const keys = [
    "sharedBuffers",
    "effectiveCacheSize",
    "workMem",
    "maintenanceWorkMem",
    "maxWalSize",
  ] as const;

  it("agrees with the document's row for it", () => {
    expect(start, "OCI_DATABASE_SIZES is missing").toBeGreaterThan(-1);
    expect(shape, "OCI_DATABASE_SIZES.small.database").not.toBeNull();
    const cells = row("`small` on Oracle Cloud");
    expect(cells[1], "database node").toBe(`${shape![1]} vCPU, ${shape![2]} GiB`);
    keys.forEach((key, index) => {
      const match = new RegExp(`${key}: "([^"]+)"`).exec(block);
      expect(match, key).not.toBeNull();
      expect(cells[index + 2], key).toBe(match![1]);
    });
  });

  // The cores and the disk are the table's, and only the memory moves: a disk
  // that differed would hold a different ledger on each cloud under one name,
  // and fewer cores is not what the row was measured with.
  it("changes the memory and nothing else about the machine", () => {
    expect(shape![1]).toBe(node("small", "database", "vcpu"));
    expect(shape![3]).toBe(node("small", "database", "diskGib"));
    expect(Number(shape![2])).toBeGreaterThan(Number(node("small", "database", "memoryGib")));
  });

  it("is laid over the row by the Oracle program and by no other", () => {
    const oci = read("deploy/pulumi/oci-single/index.ts");
    const aws = read("deploy/pulumi/aws-single/index.ts");
    expect(oci).toContain(
      "size: { ...settings.database.size, ...single.OCI_DATABASE_SIZES[settings.database.sizeName] },",
    );
    expect(aws).not.toContain("OCI_DATABASE_SIZES");
  });
});
