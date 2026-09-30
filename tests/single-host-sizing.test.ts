import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `single` profile's host artifacts, held against the sizing they are
 * built for: the tuning the database machine actually runs on, what a night's
 * backups cost the application machine's disk, and whether a bigger volume
 * becomes bigger space.
 *
 * The first of those is the tuning, held against the machine the numbers that
 * size it were measured on.
 *
 * `tests/deployment-sizing.test.ts` holds the five memory settings to
 * `SIZES.small` and to the render that writes them. This holds the other half:
 * that the deployed server is tuned the way the *measured* server was, and
 * that the settings which describe the disk rather than the memory are decided
 * here rather than left to a name nothing writes.
 *
 * It exists because that half was missing and the gap was invisible from
 * either side. `docs/deployment-sizing.md` has said since it was written that
 * `random_page_cost=1.1`, `effective_io_concurrency=200` and
 * `wal_compression=on` are "the same at every size";
 * `scripts/capacity/compose.capacity.yml` has passed all three since the run
 * `docs/capacity.md` reports; `compose.postgres.yml` passed none of them. So
 * the 95th percentile the sizing table is sold on was measured on a server
 * told its disk was an SSD, and every deployment built from that table ran on
 * `random_page_cost` 4.0 — the spinning-disk default, and the reason an untuned
 * PostgreSQL prefers a sequential scan over the index that would have answered.
 *
 * Both defaults below were read back out of a running PostgreSQL 18.6
 * (`select boot_val from pg_settings`) rather than looked up, because the
 * numbers moved: 18 raised `effective_io_concurrency` from 1 to 16, and 14 had
 * already made `checkpoint_completion_target` 0.9 — which is why the harness's
 * fourth flag is deliberately absent here rather than missing.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const DEPLOYED = "deploy/compose/single/compose.postgres.yml";
const MEASURED = "scripts/capacity/compose.capacity.yml";
const EXAMPLE = "deploy/compose/single/.env.postgres.example";
const BACKUP = "deploy/systemd/simple-balance-backup";
const APP_FIRSTBOOT = "deploy/systemd/simple-balance-firstboot";
const DB_FIRSTBOOT = "deploy/systemd/simple-balance-db-firstboot";
const GROWFS = "deploy/systemd/simple-balance-growfs";
const GROWFS_UNIT = "deploy/systemd/simple-balance-growfs.service";

const deployed = read(DEPLOYED);
const measured = read(MEASURED);
const example = read(EXAMPLE);
const backup = read(BACKUP);
const firstboot = { [APP_FIRSTBOOT]: read(APP_FIRSTBOOT), [DB_FIRSTBOOT]: read(DB_FIRSTBOOT) };
const growfs = read(GROWFS);
const growfsUnit = read(GROWFS_UNIT);

/**
 * The `-c name=value` flags a compose file passes to `postgres`, as a map.
 *
 * A list item rather than anything cleverer, because that is the only form the
 * image acts on: it reads none of these names out of the environment, which is
 * what made the deleted `vps` file's `environment:` block five settings that
 * looked applied and did nothing.
 */
function flags(file: string): Map<string, string> {
  return new Map(
    [...file.matchAll(/^\s+- ([a-z_]+)=(.*)$/gm)].map((match) => [match[1]!, match[2]!.trim()]),
  );
}

const deployedFlags = flags(deployed);
const measuredFlags = flags(measured);

/**
 * Settings the measured server passes that the deployed one deliberately does
 * not, each with the reason it is absent rather than missing. A setting that
 * drops off this list and out of the compose file at the same time is the
 * defect this file exists for, so the reason is written down where the
 * exception is taken.
 */
const NOT_DEPLOYED: Record<string, string> = {
  checkpoint_completion_target:
    "0.9 has been PostgreSQL's own default since 14 and still is on 18 — a flag that restates a default is one more line to keep true for no effect",
  log_min_duration_statement:
    "the harness measures with it on; a deployment reaches it with ALTER SYSTEM, which writes inside PGDATA and so survives a rebuild",
};

/**
 * Settings both pass at different values, with the reason. `max_connections`
 * is the only one: the harness runs the stock 100 because it is measuring the
 * server, and the profile knows exactly how many the application holds.
 */
const DIFFERS: Record<string, string> = {
  max_connections: "the profile sizes it to the pool it owns; the harness does not own one",
};

describe("the database machine runs the tuning its numbers were measured on", () => {
  it("finds both sets of flags", () => {
    // A parser that matched nothing would pass every assertion below.
    expect(deployedFlags.size).toBeGreaterThan(5);
    expect(measuredFlags.size).toBeGreaterThan(5);
  });

  it("passes every performance setting the capacity run measured with", () => {
    const missing = [...measuredFlags.keys()].filter(
      (name) => !deployedFlags.has(name) && !(name in NOT_DEPLOYED),
    );

    expect(
      missing,
      `${MEASURED} tunes these and ${DEPLOYED} does not, so the deployment is not the machine docs/capacity.md measured`,
    ).toEqual([]);
  });

  it("passes them at the same values, or says why not", () => {
    for (const [name, value] of measuredFlags) {
      if (name in NOT_DEPLOYED || name in DIFFERS) continue;
      const here = deployedFlags.get(name);
      // Compared by the default inside `${VAR:-default}` where both are
      // overridable, so a renamed variable is the other test's business and a
      // moved *number* is caught here.
      const unwrap = (flag: string) => /^\$\{[A-Z_]+:-([^}]+)\}$/.exec(flag)?.[1] ?? flag;
      expect(unwrap(here!), `${name} differs from the server that was measured`).toBe(
        unwrap(value),
      );
    }
  });

  it("keeps every exception named, so one cannot be taken silently", () => {
    // An exception for a setting the harness stopped passing is an exception
    // nothing is watching; it would go on excusing a flag that is now simply
    // absent from both.
    for (const name of [...Object.keys(NOT_DEPLOYED), ...Object.keys(DIFFERS)]) {
      expect(
        measuredFlags.has(name),
        `${name} is excepted but ${MEASURED} no longer passes it`,
      ).toBe(true);
    }
    for (const [name, reason] of Object.entries({ ...NOT_DEPLOYED, ...DIFFERS })) {
      expect(reason.length, `${name}'s exception carries no reason`).toBeGreaterThan(20);
    }
  });
});

describe("which settings the operator may move, and which this file decides", () => {
  /** The five that follow from the database node's memory, plus the ceiling. */
  const BY_MEMORY = [
    "shared_buffers",
    "effective_cache_size",
    "work_mem",
    "maintenance_work_mem",
    "max_wal_size",
    "max_connections",
  ];

  /** The three that follow from the disk, which is the same on every size. */
  const BY_DISK = ["random_page_cost", "effective_io_concurrency", "wal_compression"];

  it("leaves the memory settings overridable, because the row they come from moves", () => {
    for (const name of BY_MEMORY) {
      const value = deployedFlags.get(name);
      expect(value, name).toBeDefined();
      expect(value, `${name} has no overridable default`).toMatch(
        /^\$\{POSTGRES_[A-Z_]+:-[^}]+\}$/,
      );
    }
  });

  it("decides the disk settings here, rather than through a name nothing writes", () => {
    for (const name of BY_DISK) {
      const value = deployedFlags.get(name);
      expect(value, `${name} is not passed at all`).toBeDefined();
      // There is no row for the render to write these from, so a
      // `${VAR:-...}` would be a setting that looks configurable and is
      // decided here anyway — which is the shape this file exists not to
      // repeat.
      expect(value, `${name} reads a variable nothing writes`).not.toContain("${");
    }
  });

  it("offers no name in the example .env that the compose file does not read", () => {
    // The example is the hand-install path and is read as documentation. A
    // `#POSTGRES_SOMETHING=` in it that no `-c` flag reads is a setting an
    // operator uncomments, restarts for, and never gets.
    const offered = [...example.matchAll(/^#?(POSTGRES_[A-Z_]+)=/gm)].map((match) => match[1]!);
    expect(offered.length, "the example offers no settings at all").toBeGreaterThan(0);
    const unread = [...new Set(offered)].filter((name) => !deployed.includes(`\${${name}:`));
    expect(unread, `${EXAMPLE} offers these and ${DEPLOYED} reads none of them`).toEqual([]);
  });
});

describe("what the nightly dump costs the application node's disk", () => {
  it("keeps SB_BACKUP_KEEP + 1 on the disk, because the prune runs after the move", () => {
    // This is the arithmetic every application-node disk figure rests on, and
    // it is a property of the order of two statements rather than of any
    // number: the verified dump is moved into place, and only then is the
    // surplus pruned, so the newest kept dump and the one being written
    // coexist for the length of a pg_dump.
    //
    // The order is not the bug and must not be "fixed". Pruning first would
    // delete a good backup to make room for a dump that has not verified yet.
    const moved = backup.indexOf('mv "$partial" "$final"');
    const pruned = backup.indexOf("surplus=$(($# - SB_BACKUP_KEEP))");

    expect(moved, "the partial is no longer moved into place").toBeGreaterThan(-1);
    expect(pruned, "the prune no longer counts against SB_BACKUP_KEEP").toBeGreaterThan(-1);
    expect(
      moved,
      "pruning before the move would drop a good dump for an unverified one",
    ).toBeLessThan(pruned);
    // And the glob the prune walks cannot see a partial, which is the other
    // half: an interrupted dump must not push a good backup off the end.
    expect(backup).toContain('set -- "$SB_BACKUP_DIR"/simple-balance-*.dump');
  });

  it("says so where somebody sizing the disk would read it", () => {
    // The number is 7% light without the plus one, and it lands on the night
    // the disk was already nearly full.
    expect(backup, "the retention default does not mention the peak").toContain(
      "SB_BACKUP_KEEP + 1",
    );
  });
});

describe("whether a bigger volume becomes bigger space", () => {
  /**
   * Raising a row in `docs/deployment-sizing.md` enlarges the block device in
   * place on both clouds and does nothing whatever to the filesystem on it.
   * Without this the new capacity is a number in a table: the space is real,
   * paid for, and unreachable, and nobody finds out until the disk that was
   * supposed to have grown fills.
   *
   * Proven rather than reasoned about, on a real Linux: a 64M ext4 on a loop
   * device, the backing file grown to 192M, `losetup -c`, and then exactly the
   * `resize2fs` below — `df` went from 55M usable to 175M without unmounting,
   * and a second run printed "Nothing to do!" and exited 0.
   *
   * **Where it runs matters as much as what it does.** Inline in the two
   * first-boot scripts the growth reaches nothing: both are invoked only from
   * cloud-init's `runcmd`, which is once per instance, and a `pulumi up` that
   * grows a volume replaces no machine. A bigger disk on a stack that already
   * exists is what this is for, and that shape cannot serve it. So it is a
   * unit, and these assertions cover the unit as well as the command.
   */
  it("grows the filesystem from a unit that runs at every boot", () => {
    // WantedBy plus a mount dependency, which together are "every boot, after
    // the volume is there". `RequiresMountsFor` rather than `After=local-fs`
    // because the fstab line carries `nofail`, so the mount is a unit
    // local-fs.target does not wait for.
    expect(growfsUnit).toContain("WantedBy=multi-user.target");
    expect(growfsUnit).toContain("RequiresMountsFor=/var/lib/simple-balance");
    expect(growfsUnit).toContain("ExecStart=/usr/local/sbin/simple-balance-growfs");
    // Enabled by both first-boot scripts, after the daemon-reload that makes
    // systemd aware of the file cloud-init has just written.
    for (const [file, script] of Object.entries(firstboot)) {
      const reloaded = script.indexOf("systemctl daemon-reload");
      const enabled = script.indexOf("systemctl enable simple-balance-growfs.service");
      expect(enabled, `${file} never enables the unit`).toBeGreaterThan(-1);
      expect(enabled, `${file} enables it before the reload`).toBeGreaterThan(reloaded);
    }
  });

  it("resizes the device the mount resolved to, not $SB_DATA_DEVICE", () => {
    // A volume somebody partitioned by hand holds its filesystem on a
    // partition, and `$SB_DATA_DEVICE` is the whole disk. Asking the mount is
    // the spelling that works either way — and it is the same command
    // docs/upgrades.md gives an operator, which is what keeps the two from
    // disagreeing.
    expect(growfs).toMatch(
      /SB_DATA_FS=\$\(findmnt -no SOURCE "\$SB_GROW_DIR" 2>\/dev\/null \|\| true\)/,
    );
    expect(growfs).toContain('resize2fs "$SB_DATA_FS"');
    expect(growfs, "resize2fs was pointed at the raw device").not.toContain(
      'resize2fs "$SB_DATA_DEVICE"',
    );
  });

  it("warns rather than refusing to finish booting", () => {
    // The deployment works at the old size. A machine that will not come up
    // because it could not grow a disk is worse than one that says so — and the
    // script is `set -e`, so the `||` is what makes it a warning. Nothing
    // follows the resize, so the whole tail is the branch.
    const block = growfs.slice(growfs.indexOf('resize2fs "$SB_DATA_FS"'));
    expect(block).toContain("||");
    expect(block, "a failed resize ends the boot").not.toContain("exit 1");
  });

  it("does it the same way on both machines, because it is the same file", () => {
    // One file rather than two copies compared against each other, which is the
    // stronger form of the same rule: a fix applied to one of them cannot be a
    // fix missing from the other.
    for (const [file, script] of Object.entries(firstboot)) {
      const mounted = script.search(/^mountpoint -q .* \|\| mount /m);
      const grown = script.indexOf("/usr/local/sbin/simple-balance-growfs ");
      expect(mounted, `${file} mounts the volume`).toBeGreaterThan(-1);
      expect(grown, `${file} never grows the filesystem`).toBeGreaterThan(-1);
      expect(grown, `${file} grows before the mount, which resizes nothing`).toBeGreaterThan(
        mounted,
      );
      expect(script, `${file} still holds its own copy`).not.toContain("resize2fs ");
    }
    // Both machines get the script and the unit, so a database node cannot be
    // the one that quietly keeps the old filesystem.
    const cloudInit = read("deploy/pulumi/single-common/cloud-init.ts");
    expect(cloudInit.match(/source: "deploy\/systemd\/simple-balance-growfs",/g)).toHaveLength(2);
    expect(
      cloudInit.match(/source: "deploy\/systemd\/simple-balance-growfs\.service",/g),
    ).toHaveLength(2);
  });
});
