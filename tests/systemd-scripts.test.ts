import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
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
    const derive = (url: string) =>
      sh(
        `${fn}\nDATABASE_URL="$1"\npg_url=$(libpq_url "$DATABASE_URL")\n${derivations.join("\n")}\nprintf '%s %s' "$restore_db" "$maintenance_url"`,
        url,
      ).stdout;
    expect(derive("postgresql://u:p@db.example.com:5432/books?sslmode=no-verify")).toBe(
      "books postgresql://u:p@db.example.com:5432/postgres?sslmode=require",
    );
    // A query string with slashes in it, which sslrootcert always has. The
    // database is the path's last segment, never the certificate's file name.
    const ca = "sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem";
    expect(derive(`postgresql://u:p@db.example.com:5432/books?${ca}`)).toBe(
      `books postgresql://u:p@db.example.com:5432/postgres?${ca}`,
    );
    expect(derive("postgresql://u:p@db.example.com/books")).toBe(
      "books postgresql://u:p@db.example.com/postgres",
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

/** A shell function exactly as a script defines it, from its name to its closing brace. */
function shellFunction(script: string, name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(read(script));
  expect(match, `${script} defines ${name}`).not.toBeNull();
  return match![0];
}

/**
 * A `docker` that records how it was called and answers as the postgres client
 * would, just enough for either script to run to the end.
 *
 * Every argument of every call is written to the log, one call per line and
 * each argument ended by a unit separator, so a path with a space in it is
 * still one argument when it is read back.
 */
const FAKE_DOCKER = `#!/bin/sh
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >>"$FAKE_DOCKER_LOG"
case "$1 $2" in
"compose config") printf '%s\\n' $FAKE_SERVICES; exit 0 ;;
"compose exec") ;;
"compose "*) exit 0 ;;
esac
case " $* " in
*" pg_dump "*) printf 'PGDMP a fake archive' ;;
*" pg_restore --list "*) cat >/dev/null; printf '1; 0 0 TABLE DATA public ledger_account ledger\\n' ;;
*" pg_restore --version "*) printf 'pg_restore (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+2)\\n' ;;
*" pg_restore --no-owner --no-privileges -f - "*) cat >/dev/null; printf 'SET statement_timeout = 0;\\nSET transaction_timeout = 0;\\nCREATE TABLE t ();\\n' ;;
*" show server_version_num "*) printf '%s\\n' "$FAKE_SERVER_NUM" ;;
*" --single-transaction "*) cat >"$FAKE_DOCKER_LOG.sql" ;;
*" pg_restore "*) cat >/dev/null ;;
esac
exit 0
`;

/** The CA bundle locations the scripts look in, in their order, when nothing names one. */
const BUNDLE_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
];

/*
 * Thirty seconds, because these run the real scripts rather than reading them.
 * The slowest case walks eight bad `sslrootcert` values through both scripts,
 * which is sixteen shell invocations, and it measured 5.0 s here against
 * vitest's 5 s default — a test that passes on the machine it was written on
 * and fails on a busier one. The number is not a budget to grow into: a case
 * that needs a second digit of seconds is a case to split.
 */
const SCRIPT_RUN_TIMEOUT = 30_000;

describe("the certificate the backup and restore give libpq", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /**
   * A `single` machine in a scratch directory: a compose project with no
   * postgres, the database's CA certificate, and the fake `docker` first on
   * PATH. The environment is built rather than inherited, so an SB_PG_CA_BUNDLE
   * or a DATABASE_URL in the shell running the tests cannot decide a case.
   */
  function machine(options: { services?: string; serverNum?: string } = {}) {
    const box = mkdtempSync(path.join(tmpdir(), "sb-tls-"));
    dirs.push(box);
    for (const dir of ["bin", "compose", "backups", "tls"]) mkdirSync(path.join(box, dir));
    writeFileSync(path.join(box, "bin/docker"), FAKE_DOCKER, { mode: 0o755 });
    const ca = path.join(box, "tls/db-ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nnot really\n-----END CERTIFICATE-----\n");
    const bundle = path.join(box, "tls/bundle.pem");
    writeFileSync(bundle, "a bundle\n");
    const dump = path.join(box, "backups/simple-balance-20260901T031500Z.dump");
    writeFileSync(dump, "PGDMP a fake archive");
    const log = path.join(box, "docker.log");
    writeFileSync(log, "");

    const run = (script: string, env: Record<string, string>, ...args: string[]) => {
      const result = spawnSync("sh", [path.join(root, script), ...args], {
        encoding: "utf8",
        env: {
          PATH: `${path.join(box, "bin")}:${process.env.PATH}`,
          SB_COMPOSE_DIR: path.join(box, "compose"),
          SB_BACKUP_DIR: path.join(box, "backups"),
          SB_PG_CLIENT_IMAGE: "postgres:18",
          FAKE_DOCKER_LOG: log,
          FAKE_SERVICES: options.services ?? "app",
          FAKE_SERVER_NUM: options.serverNum ?? "180006",
          ...env,
        },
      });
      /** Every `docker run`, as its argument list. */
      const runs = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\u001f").slice(0, -1))
        .filter((call) => call[0] === "run");
      return { ...result, runs, log: readFileSync(log, "utf8") };
    };
    return { box, ca, bundle, dump, log, run };
  }

  const url = (query: string) =>
    `postgresql://ledger:p%40ss@db.example.com:5432/simple_balance${query ? `?${query}` : ""}`;

  /** The options a `docker run` gave docker itself, which end at the image. */
  const dockerOptions = (call: string[]) => call.slice(0, call.indexOf("postgres:18"));

  /** Whether a call mounts `file` read-only at the same path and points libpq at it. */
  function mountsForLibpq(call: string[], file: string) {
    const options = dockerOptions(call);
    return (
      options.includes(`type=bind,source=${file},target=${file},readonly`) &&
      options[options.indexOf(`type=bind,source=${file},target=${file},readonly`) - 1] ===
        "--mount" &&
      options.includes(`PGSSLROOTCERT=${file}`) &&
      options[options.indexOf(`PGSSLROOTCERT=${file}`) - 1] === "-e"
    );
  }

  it("is the same function in both scripts, and so is the way each runs a client", () => {
    for (const name of ["libpq_root_cert", "pg"]) {
      expect(shellFunction(SCRIPTS[1]!, name), name).toBe(shellFunction(SCRIPTS[0]!, name));
    }
  });

  describe("the function itself", () => {
    const fn = shellFunction(SCRIPTS[0]!, "libpq_root_cert");
    const call = (databaseUrl: string, env: Record<string, string> = {}) =>
      spawnSync("sh", ["-c", `${fn}\nlibpq_root_cert "$1"`, "sh", databaseUrl], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });

    it("finds sslrootcert and sslmode wherever they sit in the query, and the last of each", () => {
      const machineBox = mkdtempSync(path.join(tmpdir(), "sb-tls-fn-"));
      dirs.push(machineBox);
      const ca = path.join(machineBox, "db-ca.pem");
      writeFileSync(ca, "x\n");
      const bundle = path.join(machineBox, "bundle.pem");
      writeFileSync(bundle, "x\n");
      for (const query of [
        `sslrootcert=${ca}&sslmode=verify-full`,
        `sslmode=verify-full&sslrootcert=${ca}`,
        `application_name=x&sslrootcert=${ca}&sslmode=verify-full`,
        `sslrootcert=/elsewhere.pem&sslmode=verify-full&sslrootcert=${ca}`,
        `sslmode=require&sslrootcert=${ca}&sslmode=verify-ca`,
      ]) {
        const result = call(url(query), { SB_PG_CA_BUNDLE: bundle });
        expect(result.stdout, query).toBe(`${ca}\n`);
        expect(result.status, query).toBe(0);
      }
      // A parameter that only ends in the name is a different parameter, so
      // this URL names no root file and gets the bundle.
      expect(
        call(url(`xsslrootcert=${ca}&sslmode=verify-full`), {
          SB_PG_CA_BUNDLE: bundle,
        }).stdout,
      ).toBe(`${bundle}\n`);
      expect(
        call(url(`sslmode=verify-full&xsslmode=require`), {
          SB_PG_CA_BUNDLE: bundle,
        }).stdout,
      ).toBe(`${bundle}\n`);
    });

    it("gives verify-ca the file it names, and never the bundle", () => {
      // libpq's verify-ca checks the chain and not the name, so against a
      // bundle of public roots it takes anybody's certificate for any host.
      // libpq refuses verify-ca with sslrootcert=system for that reason, and
      // the bundle is the same trust spelled as a path.
      const machineBox = mkdtempSync(path.join(tmpdir(), "sb-tls-fn-"));
      dirs.push(machineBox);
      const ca = path.join(machineBox, "db-ca.pem");
      writeFileSync(ca, "x\n");
      const bundle = path.join(machineBox, "bundle.pem");
      writeFileSync(bundle, "x\n");
      expect(
        call(url(`sslmode=verify-ca&sslrootcert=${ca}`), {
          SB_PG_CA_BUNDLE: bundle,
        }),
      ).toMatchObject({ status: 0, stdout: `${ca}\n`, stderr: "" });
      for (const query of [
        "sslmode=verify-ca",
        `sslmode=verify-ca&xsslrootcert=${ca}`,
        `sslrootcert=&sslmode=verify-ca`,
      ]) {
        const result = call(url(query), { SB_PG_CA_BUNDLE: bundle });
        expect(result, query).toMatchObject({ status: 1, stdout: "" });
        expect(result.stderr, query).toContain(
          "sslmode=verify-ca in DATABASE_URL, with no sslrootcert, would take a certificate any public CA issued",
        );
      }
      // verify-full checks the name, so the bundle is the right trust there.
      expect(call(url("sslmode=verify-full"), { SB_PG_CA_BUNDLE: bundle })).toMatchObject({
        status: 0,
        stdout: `${bundle}\n`,
      });
    });

    it("needs nothing, and prints nothing, for a mode that verifies nothing", () => {
      for (const query of ["", "sslmode=require", "sslmode=no-verify", "sslmode=disable"]) {
        expect(call(url(query)), query).toMatchObject({
          status: 0,
          stdout: "",
          stderr: "",
        });
      }
    });

    it("mounts no root file under a mode that worked before the verify modes did, even one on disk", () => {
      // libpq handed a root file under `require` checks the chain, and
      // `no-verify` reaches libpq as `require`: mounting it there would refuse
      // a server the application connects to unchecked. So nothing is printed,
      // and the URL goes on to libpq as it always has.
      const machineBox = mkdtempSync(path.join(tmpdir(), "sb-tls-fn-"));
      dirs.push(machineBox);
      const ca = path.join(machineBox, "db-ca.pem");
      writeFileSync(ca, "x\n");
      for (const mode of ["no-verify", "require", "prefer", "disable"]) {
        const query = `sslmode=${mode}&sslrootcert=${ca}`;
        expect(call(url(query)), query).toMatchObject({
          status: 0,
          stdout: "",
          stderr: "",
        });
        expect(call(url(`sslrootcert=${ca}&sslmode=${mode}`)), query).toMatchObject({
          status: 0,
          stdout: "",
        });
      }
      // No sslmode at all is libpq's `prefer`, and the same.
      expect(call(url(`sslrootcert=${ca}`))).toMatchObject({
        status: 0,
        stdout: "",
        stderr: "",
      });
    });
  });

  it("dumps over verify-full with the CA the URL names, mounted where the URL says", () => {
    const box = machine({ services: "app" });
    writeFileSync(
      path.join(box.box, "compose/.env"),
      `DATABASE_URL='${url(`sslmode=verify-full&sslrootcert=${box.ca}`)}'\n`,
    );
    const result = box.run(SCRIPTS[0]!, {});
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("simple-balance-backup: wrote");
    expect(result.runs.map((call) => call[call.indexOf("postgres:18") + 1])).toEqual([
      "pg_dump",
      "pg_restore",
    ]);
    for (const call of result.runs) expect(mountsForLibpq(call, box.ca), call.join(" ")).toBe(true);
    // The URL reaches libpq with the parameter in it, the same string the
    // application reads.
    const dump = result.runs[0]!;
    expect(dump[dump.indexOf("-d") + 1]).toBe(url(`sslmode=verify-full&sslrootcert=${box.ca}`));
  });

  it("mounts the host's CA bundle for verify-full with no sslrootcert", () => {
    const box = machine();
    const named = box.run(SCRIPTS[0]!, {
      DATABASE_URL: url("sslmode=verify-full"),
      SB_PG_CA_BUNDLE: box.bundle,
    });
    expect(named.status).toBe(0);
    for (const call of named.runs) expect(mountsForLibpq(call, box.bundle)).toBe(true);

    // And from the usual places when nothing names one, whichever this
    // machine has first, or a refusal that says so when it has none.
    const found = BUNDLE_CANDIDATES.find((candidate) => {
      try {
        return statSync(candidate).isFile() && (accessSync(candidate, constants.R_OK), true);
      } catch {
        return false;
      }
    });
    const usual = machine().run(SCRIPTS[0]!, {
      DATABASE_URL: url("sslmode=verify-full"),
    });
    if (found) {
      expect(usual.status).toBe(0);
      for (const call of usual.runs) expect(mountsForLibpq(call, found)).toBe(true);
    } else {
      expect(usual.status).toBe(2);
      expect(usual.stderr).toContain("no CA bundle on this machine");
    }
  });

  it(
    "refuses, before it runs any client, a verify mode with a certificate it cannot use",
    () => {
      for (const [query, reason] of [
        ["sslmode=verify-full&sslrootcert=/nowhere/db-ca.pem", "is not a file this machine has"],
        ["sslmode=verify-full&sslrootcert=system", "is not an absolute path"],
        ["sslmode=verify-ca&sslrootcert=db-ca.pem", "is not an absolute path"],
        ["sslmode=verify-full&sslrootcert=%2Fvar%2Fdb-ca.pem", "is not an absolute path"],
        ["sslmode=verify-full&sslrootcert=/var/db%20ca.pem", "has a %, a + or a comma in it"],
        // node-postgres reads a + as a space, libpq as a +: two files.
        ["sslmode=verify-full&sslrootcert=/var/db+ca.pem", "has a %, a + or a comma in it"],
        ["sslmode=verify-ca&sslrootcert=/var/db,ca.pem", "has a %, a + or a comma in it"],
      ] as const) {
        for (const script of SCRIPTS) {
          const box = machine();
          const result = box.run(script, { DATABASE_URL: url(query) }, box.dump, "--yes");
          expect(result.status, `${script} ${query}`).toBe(2);
          expect(result.stderr, query).toContain(reason);
          expect(result.stderr, query).toContain("/var/lib/simple-balance/tls/db-ca.pem");
          expect(result.runs, `${script} ${query} ran a client`).toEqual([]);
        }
      }
      // verify-ca with no file of its own is refused though a bundle is there to
      // mount: the chain is all libpq would check, and a chain to a public CA is
      // what anybody can have for a host they control.
      for (const script of SCRIPTS) {
        const box = machine();
        const result = box.run(
          script,
          {
            DATABASE_URL: url("sslmode=verify-ca"),
            SB_PG_CA_BUNDLE: box.bundle,
          },
          box.dump,
          "--yes",
        );
        expect(result.status, script).toBe(2);
        expect(result.stderr, script).toContain("would take a certificate any public CA issued");
        expect(result.stderr, script).toContain("Use sslmode=verify-full");
        expect(result.stderr, script).toContain("/var/lib/simple-balance/tls/db-ca.pem");
        expect(result.runs, `${script} ran a client`).toEqual([]);
      }
      const box = machine();
      const missing = box.run(SCRIPTS[0]!, {
        DATABASE_URL: url("sslmode=verify-full"),
        SB_PG_CA_BUNDLE: path.join(box.box, "no-such-bundle.pem"),
      });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain("no CA bundle on this machine");
      expect(missing.runs).toEqual([]);
    },
    SCRIPT_RUN_TIMEOUT,
  );

  it(
    "leaves every string that worked before exactly as it was",
    () => {
      // no-verify becomes require and nothing is mounted: libpq stays
      // encrypted and unverified, the guarantee the application has.
      const plain = machine().run(SCRIPTS[0]!, {
        DATABASE_URL: url("sslmode=no-verify"),
      });
      expect(plain.status).toBe(0);
      for (const call of plain.runs) {
        expect(dockerOptions(call)).toEqual([
          "run",
          "--rm",
          "-i",
          "--network",
          "host",
          "-e",
          "PGCONNECT_TIMEOUT=15",
        ]);
      }
      expect(plain.runs[0]![plain.runs[0]!.indexOf("-d") + 1]).toBe(url("sslmode=require"));

      // A sslrootcert this machine does not have, under a mode that verifies
      // nothing, is passed through as it always was rather than refused.
      const unverified = machine().run(SCRIPTS[0]!, {
        DATABASE_URL: url("sslmode=require&sslrootcert=/nowhere/db-ca.pem"),
      });
      expect(unverified.status).toBe(0);
      for (const call of unverified.runs) expect(call).not.toContain("--mount");

      // And one it does have, under no-verify or require, is not mounted
      // either: libpq would check the chain with it, and the application does
      // not under no-verify, so a file that was never the right one would
      // start failing a backup that has always worked. Both scripts, the
      // restore's maintenance session included.
      for (const mode of ["no-verify", "require"]) {
        for (const script of SCRIPTS) {
          const box = machine({ services: "noop" });
          const databaseUrl = url(`sslmode=${mode}&sslrootcert=${box.ca}`);
          const result = box.run(script, { DATABASE_URL: databaseUrl }, box.dump, "--yes");
          expect(result.status, `${script} ${mode}`).toBe(0);
          expect(result.runs.length, `${script} ${mode}`).toBeGreaterThan(1);
          for (const call of result.runs) {
            expect(dockerOptions(call), `${script} ${mode}`).not.toContain("--mount");
            expect(dockerOptions(call).join(" "), `${script} ${mode}`).not.toContain(
              "PGSSLROOTCERT",
            );
          }
          const handed = result.runs.find((call) => call.includes("-d"))!;
          expect(handed[handed.indexOf("-d") + 1]).toMatch(
            new RegExp(
              `[?&]sslmode=require&sslrootcert=${box.ca.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
          );
        }
      }

      // The vps profile runs the client in its own database's container and
      // mounts nothing, whatever DATABASE_URL says.
      const vps = machine({ services: "postgres" }).run(SCRIPTS[0]!, {
        DATABASE_URL: url("sslmode=verify-full&sslrootcert=/nowhere/db-ca.pem"),
      });
      expect(vps.status).toBe(0);
      expect(vps.runs).toEqual([]);
      expect(vps.log).toContain("compose\u001fexec\u001f-T\u001fpostgres\u001fpg_dump\u001f");
    },
    SCRIPT_RUN_TIMEOUT,
  );

  it(
    "restores over verify-full, the maintenance session included, into a server of either age",
    () => {
      for (const serverNum of ["180006", "160015"]) {
        const box = machine({ services: "noop", serverNum });
        const databaseUrl = url(`sslmode=verify-full&sslrootcert=${box.ca}`);
        const result = box.run(SCRIPTS[1]!, { DATABASE_URL: databaseUrl }, box.dump, "--yes");
        expect(result.stderr, serverNum).toBe("");
        expect(result.status, serverNum).toBe(0);
        expect(result.runs.length, serverNum).toBeGreaterThan(3);
        for (const call of result.runs)
          expect(mountsForLibpq(call, box.ca), call.join(" ")).toBe(true);

        const targets = result.runs
          .filter((call) => call.includes("-d"))
          .map((call) => call[call.indexOf("-d") + 1]);
        const maintenance = databaseUrl.replace("/simple_balance?", "/postgres?");
        expect(new Set(targets), serverNum).toEqual(new Set([maintenance, databaseUrl]));
        const recreate = result.runs.find((call) =>
          call.includes('drop database if exists "simple_balance";'),
        );
        expect(recreate?.[recreate.indexOf("-d") + 1]).toBe(maintenance);
      }
      // The older server's restore went through the filter, as SQL, in one transaction.
      const older = machine({ services: "noop", serverNum: "160015" });
      older.run(
        SCRIPTS[1]!,
        { DATABASE_URL: url(`sslmode=verify-full&sslrootcert=${older.ca}`) },
        older.dump,
        "--yes",
      );
      expect(readFileSync(`${older.log}.sql`, "utf8")).toBe(
        "SET statement_timeout = 0;\nCREATE TABLE t ();\n",
      );
    },
    SCRIPT_RUN_TIMEOUT,
  );

  it("changes nothing when the server's version does not come back as a number", () => {
    const box = machine({
      services: "noop",
      serverNum: "WARNING: something to say\n160015",
    });
    const result = box.run(
      SCRIPTS[1]!,
      { DATABASE_URL: url("sslmode=require") },
      box.dump,
      "--yes",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not come back as a number. Nothing was changed.");
    expect(result.log).not.toContain("drop database");
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
        env: {
          PATH: process.env.PATH,
          SB_COMPOSE_DIR: compose,
          SB_STATE_DIR: state,
        },
      });
    return {
      compose,
      state,
      run,
      env: () => readFileSync(path.join(compose, ".env"), "utf8"),
    };
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
    const box = machine({
      base: "A=1\n",
      secrets: "AUTH_SECRET=abc\n",
      local: "",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe("A=1\nAUTH_SECRET=abc\n");

    writeFileSync(path.join(box.state, "env.local"), "SB_BILLING_ENABLED=true\n");
    expect(box.run().status).toBe(0);
    expect(box.env()).toContain("SB_BILLING_ENABLED=true\n");
  });

  it("leaves a hand-written .env alone on a machine no cloud program built", () => {
    const box = machine({
      env: "DATABASE_URL=mine\n",
      secrets: "AUTH_SECRET=abc\n",
    });
    const result = box.run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("is left as it is");
    expect(box.env()).toBe("DATABASE_URL=mine\n");
  });

  it("refuses to start on the last .env when the data volume's secret is missing", () => {
    const box = machine({
      base: "A=1\n",
      env: "A=0\nAUTH_SECRET=old\n",
      local: "B=2\n",
    });
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

  it("makes the certificate's directory on the data volume, readable by the application", () => {
    // After the mount, or it is made on the boot disk and hidden underneath
    // the volume, where nothing a rebuild keeps can see it.
    const mounted = code.indexOf(
      "mountpoint -q /var/lib/simple-balance || mount /var/lib/simple-balance",
    );
    expect(mounted, "the volume is mounted").toBeGreaterThan(-1);
    expect(code.indexOf("\nmkdir -p /var/lib/simple-balance/tls\n")).toBeGreaterThan(mounted);
    // Every run, because the application reads it as an unprivileged user and
    // an umask of 077 set earlier in the script would otherwise decide it.
    expect(code).toContain("\nchmod 0755 /var/lib/simple-balance/tls\n");
  });

  it("waits for the data volume as long as Pulumi would, and says so where a person reads it", () => {
    // The floor is the providers' own: on a first Oracle Cloud launch the
    // volume is built after the instance runs, and the OCI provider gives its
    // creation and its attachment twenty minutes each before failing the up.
    // Shorter, and a volume still on its way leaves a machine half set up.
    const loop =
      /\nwhile \[ ! -b "\$SB_DATA_DEVICE" \] && \[ "\$i" -lt (\d+) \]; do\n\ti=\$\(\(i \+ 1\)\)\n\tsleep (\d+)\ndone\n/.exec(
        code,
      );
    expect(loop, "the loop that waits for the device").not.toBeNull();
    const minutes = (Number(loop![1]) * Number(loop![2])) / 60;
    expect(minutes).toBeGreaterThanOrEqual(40);
    const word = ({ 40: "forty", 45: "forty-five", 60: "sixty" } as Record<number, string>)[
      minutes
    ];
    expect(word, `a word for ${minutes} minutes`).toBeDefined();
    expect(code).toContain(`waiting up to ${word} minutes for the data volume`);
    expect(read("deploy/pulumi/README.md")).toMatch(
      new RegExp(`first boot waits up to ${word}\\s+minutes for it`),
    );
  });
});

/**
 * The one path the database's CA certificate lives at, in every place that
 * names it.
 *
 * It is written once, in a URL, and read in two containers and on the host: the
 * application reads it through compose.db-tls.yml's mount, the backup client through
 * the scripts' own, and the scripts check it on the host before either. A
 * mount at any other path, a directory made anywhere else, or an example URL
 * naming a third place would each leave one of those three reading a file that
 * is not there.
 */
describe("the path of the database's CA certificate", () => {
  const DIR = "/var/lib/simple-balance/tls";
  const FILE = `${DIR}/db-ca.pem`;
  const verified = (text: string) =>
    [...text.matchAll(/DATABASE_URL='?(postgresql:\/\/[^'\n]*?sslmode=verify-full[^'\s]*)/g)].map(
      (match) => match[1]!,
    );

  const code = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

  it("is mounted into the application at the path it has on the host, read-only", () => {
    // The whole of the overlay, so a source that differs from its target, a
    // mount that can be written, or one Docker would make when it is missing
    // each fail here by name.
    expect(code(read("deploy/compose/single/compose.db-tls.yml"))).toBe(
      [
        "services:",
        "  app:",
        "    volumes:",
        "      - type: bind",
        `        source: ${DIR}`,
        `        target: ${DIR}`,
        "        read_only: true",
        "        bind:",
        "          create_host_path: false",
        "",
      ].join("\n"),
    );
  });

  it("is mounted by the overlay alone, so compose.yml starts where the directory cannot be made", () => {
    // A rootless daemon cannot make a directory under /var/lib, and a bind
    // mount it cannot satisfy stops the container starting, whatever
    // DATABASE_URL says. In compose.yml, that was every such deployment.
    const compose = code(read("deploy/compose/single/compose.yml"));
    expect(compose).not.toContain(DIR);
    const app = compose.slice(compose.indexOf("\n  app:\n"));
    expect(app).not.toMatch(/^ {4}volumes:/m);
  });

  it("is the directory firstboot makes, and the file both scripts send the operator to", () => {
    expect(read("deploy/systemd/simple-balance-firstboot")).toContain(`\nmkdir -p ${DIR}\n`);
    for (const script of SCRIPTS) {
      expect(read(script), script).toContain(`in ${FILE} and name that.`);
    }
  });

  it("is the file every example DATABASE_URL that names one names", () => {
    const files = [
      "deploy/systemd/simple-balance-firstboot",
      "deploy/compose/single/README.md",
      "deploy/compose/single/.env.example",
    ];
    const examples = files.flatMap((file) =>
      verified(read(file)).map((example) => ({ file, example })),
    );
    // Each of the three shows at least one, so none of them can drift out of
    // the check by dropping its example.
    expect(new Set(examples.map(({ file }) => file))).toEqual(new Set(files));
    for (const { file, example } of examples) {
      const rootCert = /[?&]sslrootcert=([^&]*)/.exec(example)?.[1];
      if (rootCert !== undefined) expect(rootCert, `${file}: ${example}`).toBe(FILE);
    }
    // And the first thing /etc/motd tells a fresh machine is the verified one.
    const motd = read("deploy/systemd/simple-balance-firstboot");
    const shown = motd.slice(motd.indexOf("<<'MOTD'"), motd.indexOf("\nMOTD\n"));
    expect(verified(shown)[0]).toMatch(/sslmode=verify-full&sslrootcert=/);
    expect(shown).not.toContain("sslmode=no-verify");
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
