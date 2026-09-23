import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The scripts and units in `deploy/systemd/`, run where they can be and read
 * where they cannot.
 *
 * What is run: the connection string the backup and restore scripts hand to
 * libpq, and the fold that builds the file Compose reads. Both are small enough
 * to execute here against a scratch directory, and both were wrong in ways only
 * running them shows — a `sslmode` libpq refuses, a setting that never reached
 * the containers. What is read: the parts that need a machine, a block device
 * and systemd, which a unit test cannot stand in for.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const sh = (script: string, ...args: string[]) =>
  spawnSync("sh", ["-c", script, "sh", ...args], { encoding: "utf8" });

const SCRIPTS = ["deploy/systemd/simple-balance-backup", "deploy/systemd/simple-balance-restore"];

/** The `libpq_url` function exactly as a script defines it. */
function libpqUrlFunction(script: string): string {
  const match = /^libpq_url\(\) \{\n[\s\S]*?\n\}\n/m.exec(read(script));
  expect(match, `${script} defines libpq_url`).not.toBeNull();
  return match![0];
}

describe("the connection string the backup and restore scripts give libpq", () => {
  it("is the same function in both, so a dump and its restore cannot disagree", () => {
    expect(libpqUrlFunction(SCRIPTS[1]!)).toBe(libpqUrlFunction(SCRIPTS[0]!));
  });

  const base = "postgresql://ledger:p%40ss%24word@db.example.com:5432/simple_balance";
  const cases: [string, string][] = [
    // node-postgres's spelling of "encrypted, not verified", which libpq refuses.
    [`${base}?sslmode=no-verify`, `${base}?sslmode=require`],
    [`${base}?sslmode=no-verify&application_name=x`, `${base}?sslmode=require&application_name=x`],
    [`${base}?application_name=x&sslmode=no-verify`, `${base}?application_name=x&sslmode=require`],
    // An unknown URI parameter to libpq, wherever it sits.
    [`${base}?uselibpqcompat=true&sslmode=require`, `${base}?sslmode=require`],
    [`${base}?sslmode=require&uselibpqcompat=true`, `${base}?sslmode=require`],
    [`${base}?a=1&uselibpqcompat=true&b=2`, `${base}?a=1&b=2`],
    [`${base}?uselibpqcompat=true`, base],
    [`${base}?sslmode=no-verify&uselibpqcompat=true`, `${base}?sslmode=require`],
    // Everything libpq already reads passes through untouched.
    [`${base}?sslmode=verify-full`, `${base}?sslmode=verify-full`],
    [`${base}?sslmode=require`, `${base}?sslmode=require`],
    [base, base],
    [`${base}?sslmode=no-verifyish`, `${base}?sslmode=no-verifyish`],
  ];

  for (const script of SCRIPTS) {
    it(`${path.basename(script)} rewrites only what libpq refuses`, () => {
      const fn = libpqUrlFunction(script);
      for (const [input, expected] of cases) {
        const result = sh(`${fn}\nlibpq_url "$1"`, input);
        expect(result.stderr, input).toBe("");
        expect(result.stdout, input).toBe(`${expected}\n`);
      }
    });

    it(`${path.basename(script)} hands libpq that spelling, never DATABASE_URL itself`, () => {
      const text = read(script);
      const clientCalls = text
        .split("\n")
        .filter((line) => /\bpg (pg_dump|pg_restore|psql)\b.*\s-d\s/.test(line));
      expect(clientCalls.length, "the database-by-URL calls").toBeGreaterThan(0);
      for (const call of clientCalls) {
        // Either the vps profile's own database by name, or libpq's spelling.
        expect(call, call.trim()).toMatch(
          /-d (simple_balance|postgres|"\$pg_url"|"\$maintenance_url")(\s|$)/,
        );
      }
      expect(text).toContain('pg_url=$(libpq_url "$DATABASE_URL")');
    });
  }

  it("connects the restore's maintenance session with the same spelling", () => {
    const text = read(SCRIPTS[1]!);
    const derivations = text
      .split("\n")
      .filter((line) => /^\s*(restore_db|maintenance_url)=/.test(line))
      .map((line) => line.trim());
    expect(derivations).toHaveLength(2);
    for (const line of derivations) expect(line).toContain('"$pg_url"');

    // And the real lines, run, give a maintenance URL libpq will accept.
    const fn = libpqUrlFunction(SCRIPTS[1]!);
    const result = sh(
      `${fn}\nDATABASE_URL="$1"\npg_url=$(libpq_url "$DATABASE_URL")\n${derivations.join("\n")}\nprintf '%s %s' "$restore_db" "$maintenance_url"`,
      "postgresql://u:p@db.example.com:5432/books?sslmode=no-verify",
    );
    expect(result.stdout).toBe(
      "books postgresql://u:p@db.example.com:5432/postgres?sslmode=require",
    );
  });
});

/**
 * A restore into a server older than the client.
 *
 * From 17 on, pg_restore opens every restore with `SET transaction_timeout =
 * 0`, which a 15 or 16 server does not have, and the restore used to find that
 * out after it had dropped the database: an empty ledger and a stopped
 * application, from a procedure the docs allow on every supported server. What
 * the script does about it was proved against a real PostgreSQL 16 with the
 * postgres:18 client; what is held here is the order, because the order is the
 * whole defect, and the one line that is taken out.
 */
describe("the restore into a server older than its client", () => {
  const script = read("deploy/systemd/simple-balance-restore");
  const at = (needle: string) => {
    const index = script.indexOf(needle);
    expect(index, `the restore contains ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it("asks the server's version, and renders the dump, before anything is stopped or dropped", () => {
    const version = at("show server_version_num");
    const rendered = at("pg pg_restore --no-owner --no-privileges -f -");
    expect(version).toBeLessThan(at("docker compose stop app"));
    expect(rendered).toBeLessThan(at("docker compose stop app"));
    expect(rendered).toBeLessThan(at('drop database if exists \\"$restore_db\\"'));
  });

  it("takes out the one statement an older server refuses, and nothing else", () => {
    const filter = /sed '(\/\^SET transaction_timeout = 0;\$\/d)'/.exec(script);
    expect(filter, "the filter is the one sed expression").not.toBeNull();
    const run = sh(
      `printf 'SET statement_timeout = 0;\\nSET transaction_timeout = 0;\\nCREATE TABLE t ();\\n' | sed '${filter![1]}'`,
    );
    expect(run.stdout).toBe("SET statement_timeout = 0;\nCREATE TABLE t ();\n");
  });

  it("loads the rendered SQL in one transaction that stops at the first error", () => {
    expect(script).toMatch(
      /psql -d "\$pg_url" -v ON_ERROR_STOP=1 --single-transaction <"\$filter_sql"/,
    );
  });

  it("reads the machine's settings, exported, so the restart keeps the Caddy overlay", () => {
    expect(at("set -a")).toBeLessThan(at(". /etc/default/simple-balance"));
    expect(at(". /etc/default/simple-balance")).toBeLessThan(
      at('"${SB_PG_CLIENT_IMAGE:=postgres:18}"'),
    );
  });
});

describe("simple-balance-env, which builds the .env Compose reads", () => {
  const script = path.join(root, "deploy/systemd/simple-balance-env");
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** A compose directory and a data volume, as the cloud programs lay them out. */
  function machine(parts: { base?: string; secrets?: string; local?: string; env?: string }) {
    const compose = mkdtempSync(path.join(tmpdir(), "sb-compose-"));
    const state = mkdtempSync(path.join(tmpdir(), "sb-state-"));
    dirs.push(compose, state);
    if (parts.base !== undefined) writeFileSync(path.join(compose, "env.base"), parts.base);
    if (parts.env !== undefined) writeFileSync(path.join(compose, ".env"), parts.env);
    if (parts.secrets !== undefined) writeFileSync(path.join(state, "secrets.env"), parts.secrets);
    if (parts.local !== undefined) writeFileSync(path.join(state, "env.local"), parts.local);
    const run = () =>
      spawnSync("sh", [script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SB_COMPOSE_DIR: compose, SB_STATE_DIR: state },
      });
    return { compose, state, run, env: () => readFileSync(path.join(compose, ".env"), "utf8") };
  }

  it("folds the three parts together, the hand-added ones last, readable by root alone", () => {
    const box = machine({
      base: "APP_BASE_URL=https://books.example.com\n",
      secrets: "AUTH_SECRET=abc\n",
      local: "DATABASE_URL='postgresql://u:p@db/simple_balance'\n",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe(
      "APP_BASE_URL=https://books.example.com\nAUTH_SECRET=abc\n" +
        "# --- added by hand, on the volume that survives a rebuild ---\n" +
        "DATABASE_URL='postgresql://u:p@db/simple_balance'\n",
    );
    expect(statSync(path.join(box.compose, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(box.compose, ".env.partial"))).toBe(false);
  });

  it("picks up an edit to env.local on the next run, which is what a restart now is", () => {
    const box = machine({ base: "A=1\n", secrets: "AUTH_SECRET=abc\n", local: "" });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe("A=1\nAUTH_SECRET=abc\n");

    writeFileSync(path.join(box.state, "env.local"), "SB_BILLING_ENABLED=true\n");
    expect(box.run().status).toBe(0);
    expect(box.env()).toContain("SB_BILLING_ENABLED=true\n");
  });

  it("leaves a hand-written .env alone on a machine no cloud program built", () => {
    const box = machine({ env: "DATABASE_URL=mine\n", secrets: "AUTH_SECRET=abc\n" });
    const result = box.run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("is left as it is");
    expect(box.env()).toBe("DATABASE_URL=mine\n");
  });

  it("refuses to start on the last .env when the data volume's secret is missing", () => {
    const box = machine({ base: "A=1\n", env: "A=0\nAUTH_SECRET=old\n", local: "B=2\n" });
    const result = box.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is the data volume mounted");
    expect(box.env()).toBe("A=0\nAUTH_SECRET=old\n");
  });
});

describe("the first-boot script", () => {
  const firstboot = read("deploy/systemd/simple-balance-firstboot");
  const code = firstboot
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("builds .env with the same script a restart runs, not a copy of it", () => {
    expect(code).toMatch(/^\/usr\/local\/sbin\/simple-balance-env$/m);
    expect(code).not.toMatch(/>\s*\/opt\/simple-balance\/\.env/);
  });

  it("restarts the deployment, so running it again applies a new setting", () => {
    const start = code.slice(code.lastIndexOf(": >/etc/motd"));
    expect(start).toContain("systemctl restart simple-balance.service");
    expect(code).not.toMatch(/enable --now simple-balance\.service/);
  });
});

describe("the lint every script gets before it runs unattended", () => {
  /** Every file in deploy/systemd that is a shell script, by its first line. */
  const scripts = readdirSync(path.join(root, "deploy/systemd"))
    .map((name) => `deploy/systemd/${name}`)
    .filter((file) => read(file).startsWith("#!/bin/sh\n"))
    .sort();

  const workflow = read(".github/workflows/deployment-profile.yml");

  /** The paths the workflow's `shellcheck` command names, continuation lines and all. */
  const linted = (() => {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => /^\s*shellcheck\s+\S/.test(line));
    expect(start, "deployment-profile.yml runs shellcheck").toBeGreaterThan(-1);
    const command: string[] = [];
    for (const line of lines.slice(start)) {
      command.push(line.replace(/\\$/, ""));
      if (!line.trimEnd().endsWith("\\")) break;
    }
    return command.join(" ").trim().split(/\s+/).slice(1).sort();
  })();

  it("finds the scripts it is checking for", () => {
    // Without a floor, a shebang that stopped matching would empty both sides
    // and the comparison below would agree about nothing.
    expect(scripts).toContain("deploy/systemd/simple-balance-env");
    expect(scripts.length).toBeGreaterThanOrEqual(4);
  });

  it("names every script in deploy/systemd, and nothing else", () => {
    expect(linted).toEqual(scripts);
  });

  it("says how many it passed, and the number is the list's", () => {
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    expect(workflow).toContain(`shellcheck passed all ${words[scripts.length]} scripts`);
  });
});

describe("the units", () => {
  const unitSection = (file: string) => {
    const text = read(file);
    return text
      .slice(text.indexOf("[Unit]"), text.indexOf("[Service]"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
  };

  it("never starts a deployment somebody stopped, just to back it up", () => {
    const unit = unitSection("deploy/systemd/simple-balance-backup.service");
    expect(unit).toContain("Requisite=simple-balance.service");
    expect(unit).toContain("After=simple-balance.service");
    expect(unit.filter((line) => /^(BindsTo|Requires|Wants)=/.test(line))).toEqual([]);
  });

  it("leaves the shared unit with no fold of its own, for the hand-installed profiles", () => {
    // The fold is the cloud programs' drop-in. Here it would overwrite the .env
    // a hand install writes, or fail on the env.base it does not have.
    const service = read("deploy/systemd/simple-balance.service")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(service.filter((line) => line.startsWith("ExecStartPre="))).toEqual([]);
  });
});
