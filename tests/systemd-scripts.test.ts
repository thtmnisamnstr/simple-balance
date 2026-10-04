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
        // Either the database machine's own database by name, or libpq's
        // spelling. Never a maintenance URL: see the pg_hba test below.
        expect(call, call.trim()).toMatch(/-d (simple_balance|postgres|"\$pg_url")(\s|$)/);
      }
      expect(text).toContain('pg_url=$(libpq_url "$DATABASE_URL")');
    });
  }

  it("names the database it is restoring into, from libpq's spelling", () => {
    const text = read(SCRIPTS[1]!);
    const derivations = text
      .split("\n")
      .filter((line) => /^\s*restore_db=/.test(line))
      .map((line) => line.trim());
    expect(derivations).toHaveLength(1);
    for (const line of derivations) expect(line).toContain('"$pg_url"');

    const fn = libpqUrlFunction(SCRIPTS[1]!);
    const derive = (url: string) =>
      sh(
        `${fn}\nDATABASE_URL="$1"\npg_url=$(libpq_url "$DATABASE_URL")\n${derivations.join("\n")}\nprintf '%s' "$restore_db"`,
        url,
      ).stdout;
    expect(derive("postgresql://u:p@db.example.com:5432/books?sslmode=no-verify")).toBe("books");
    // A query string with slashes in it, which sslrootcert always has. The
    // database is the path's last segment, never the certificate's file name.
    const ca = "sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem";
    expect(derive(`postgresql://u:p@db.example.com:5432/books?${ca}`)).toBe("books");
    expect(derive("postgresql://u:p@db.example.com/books")).toBe("books");
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
    expect(rendered).toBeLessThan(at("drop schema if exists public cascade;"));
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

/**
 * Who the two scripts sign in as when the database is a service in their own
 * Compose project, and whether `pg_hba.conf` lets that role in at all.
 *
 * The two files are edited for different reasons by different people, and
 * nothing connected them until this: when the database moved out of the
 * deleted `vps` recipe its superuser stopped being called `simple_balance` and
 * became `postgres`, while both scripts went on saying `-U simple_balance`.
 * The result was a nightly dump that failed with `no pg_hba.conf entry for
 * host "[local]", user "simple_balance"`, into a journal, with the last good
 * backup quietly getting older. Reproduced against a real PostgreSQL 18 before
 * this was written, and the fix verified the same way.
 *
 * Which role is not a detail. `pg_restore --no-owner` hands every object it
 * creates to whoever connected, so a dump and restore taken as the superuser
 * leaves a ledger owned by `postgres` that the application meets as
 * `permission denied for table ledger_posting` — measured, not reasoned.
 * Dropping and creating a database, on the other hand, needs CREATEDB, which
 * the application's role deliberately does not have. So the split is exact.
 */
describe("the role the backup and restore use inside the database machine", () => {
  const hba = read("deploy/compose/single/pg_hba.conf")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/));
  const socketRoles = hba.filter((rule) => rule[0] === "local").map((rule) => rule[2]);

  it("signs in as a role pg_hba has a local line for, in both scripts", () => {
    for (const script of SCRIPTS) {
      const roles = [
        ...new Set(
          [...read(script).matchAll(/\bpg (?:psql|pg_dump|pg_restore) -U (\w+)/g)].map(
            (match) => match[1]!,
          ),
        ),
      ];

      expect(roles.length, `${script} connects as somebody over the socket`).toBeGreaterThan(0);
      for (const role of roles)
        expect(socketRoles, `${script} signs in as ${role}, which pg_hba refuses`).toContain(role);
    }
  });

  it("touches data as the application's role and never as the superuser", () => {
    expect(read(SCRIPTS[0]!)).toContain("pg pg_dump -U simple_balance -d simple_balance");
    expect(read(SCRIPTS[1]!)).toContain("pg pg_restore -U simple_balance -d simple_balance");
    for (const script of SCRIPTS)
      expect(read(script), script).not.toMatch(/pg (?:pg_dump|pg_restore) -U postgres/);
  });

  it("creates the database as the superuser and hands it straight to the application", () => {
    // The one statement the application's role cannot run, because CREATEDB is
    // not among the privileges `db-init.sh` gives it. The `owner` clause is
    // what keeps the restore that follows able to create a table in `public`:
    // from PostgreSQL 15 that schema follows the database's owner.
    const restore = read(SCRIPTS[1]!);

    expect(restore).toContain("pg psql -U postgres -d postgres");
    expect(restore).toContain(
      "create database simple_balance owner simple_balance template template0;",
    );
  });
});

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
    "restores over verify-full, every session included, into a server of either age",
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

        // Every connection is to the ledger's own database. There is no second
        // one: a session on the server's `postgres` database is what the
        // database machine's pg_hba.conf refuses, and what the application's
        // role could do nothing with if it were let in.
        const targets = result.runs
          .filter((call) => call.includes("-d"))
          .map((call) => call[call.indexOf("-d") + 1]);
        expect(new Set(targets), serverNum).toEqual(new Set([databaseUrl]));
        const empty = result.runs.find((call) =>
          call.includes("drop schema if exists public cascade;"),
        );
        expect(empty?.[empty.indexOf("-d") + 1]).toBe(databaseUrl);
        expect(empty).toContain("create schema public authorization current_user;");
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
    expect(result.log).not.toContain("drop schema");
    expect(result.log).not.toContain("drop database");
  });

  /**
   * The restore over a network, held against the `pg_hba.conf` that machine
   * actually runs.
   *
   * The script used to swap the database name for `postgres` and drop and
   * create from there, which is how a restore is ordinarily written and is
   * refused twice over here: `pg_hba.conf` has exactly one line that crosses a
   * network and its DATABASE column is `simple_balance`, so a session on
   * `postgres` matches no rule at all; and `db-init.sh` withholds CREATEDB on
   * purpose, so the role could not have created one if it had got in. The
   * backups live on the application machine and the restore script is not even
   * shipped to the database machine, so the documented recovery ran nowhere.
   * The existing coverage never saw it, because it only exercised the branch
   * where the database is a service in this same project.
   */
  it(
    "connects, over a network, only as a role and to a database pg_hba admits",
    () => {
      const network = read("deploy/compose/single/pg_hba.conf")
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#"))
        .map((line) => line.trim().split(/\s+/))
        .filter((rule) => rule[0] === "hostssl" || rule[0] === "host")
        .filter((rule) => rule[3] !== "127.0.0.1/32");
      expect(network.length, "pg_hba has a line for the network").toBeGreaterThan(0);

      const box = machine({ services: "noop" });
      const databaseUrl = url(`sslmode=verify-full&sslrootcert=${box.ca}`);
      const result = box.run(SCRIPTS[1]!, { DATABASE_URL: databaseUrl }, box.dump, "--yes");
      expect(result.status).toBe(0);

      const targets = result.runs
        .filter((call) => call.includes("-d"))
        .map((call) => call[call.indexOf("-d") + 1]!);
      expect(targets.length).toBeGreaterThan(1);
      for (const target of targets) {
        // `url()` builds postgresql://ledger:...@host/<database>?..., and the
        // role the profile's own DATABASE_URL carries is `simple_balance`.
        const database = target.replace(/\?.*$/, "").replace(/^.*\//, "");
        expect(
          network.some((rule) => rule[1] === database || rule[1] === "all"),
          `pg_hba admits a connection to ${database}`,
        ).toBe(true);
      }
    },
    SCRIPT_RUN_TIMEOUT,
  );
});

/**
 * simple-balance-settings, which fetches the stack's settings from the cloud's
 * secret store with the machine's own identity.
 *
 * Run against a fake `docker` and a fake `systemctl` on PATH, because what is
 * under test is everything the script decides around the CLI call: what it
 * accepts as settings, what it does when the store does not answer, and when it
 * restarts the deployment. The CLI calls themselves are the providers'.
 */
describe("simple-balance-settings, which fetches the stack's settings", () => {
  const script = path.join(root, "deploy/systemd/simple-balance-settings");
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  const SETTINGS =
    "# Written by Pulumi.\nSB_BILLING_ENABLED='true'\nSMTP_PASSWORD='p@ss $word #1'\n";

  function machine(source: "oci-vault" | "aws-secretsmanager" | "" = "aws-secretsmanager") {
    const dir = mkdtempSync(path.join(tmpdir(), "sb-settings-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    // The fake CLI: prints $FAKE_OUT (base64-decoded first, so a test can hand
    // it anything), writes $FAKE_ERR to stderr, exits $FAKE_STATUS, and records
    // its arguments so a test can see which provider's command ran.
    writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/sh\necho "$*" >>"$FAKE_LOG"\n[ -n "$FAKE_ERR" ] && echo "$FAKE_ERR" >&2\n' +
        'printf %s "$FAKE_OUT" | base64 -d\nexit "${FAKE_STATUS:-0}"\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, "systemctl"), '#!/bin/sh\necho "systemctl $*" >>"$FAKE_LOG"\n', {
      mode: 0o755,
    });
    const defaults = path.join(dir, "defaults");
    writeFileSync(
      defaults,
      source
        ? `SB_COMPOSE_DIR=${dir}\nSB_SETTINGS_SOURCE=${source}\nSB_SETTINGS_ID=secret-id\n` +
            `SB_SETTINGS_REGION=us-sanjose-1\nSB_SETTINGS_IMAGE=example/cli:1\n`
        : `SB_COMPOSE_DIR=${dir}\n`,
    );
    const log = path.join(dir, "log");
    writeFileSync(log, "");
    const run = (mode?: string, answer: { out?: string; err?: string; status?: number } = {}) => {
      // The OCI branch decodes what the CLI prints, because Vault hands back
      // base64; the AWS branch takes it as it comes.
      const printed =
        source === "oci-vault"
          ? Buffer.from(answer.out ?? "").toString("base64")
          : (answer.out ?? "");
      return spawnSync("sh", [script, ...(mode ? [mode] : [])], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          SB_DEFAULTS: defaults,
          SB_SETTINGS_RETRY_SECONDS: "0",
          FAKE_LOG: log,
          FAKE_OUT: Buffer.from(printed).toString("base64"),
          FAKE_ERR: answer.err ?? "",
          FAKE_STATUS: String(answer.status ?? 0),
        },
      });
    };
    const target = path.join(dir, "env.settings");
    return {
      run,
      target,
      settings: () => readFileSync(target, "utf8"),
      log: () => readFileSync(log, "utf8"),
    };
  }

  it("does nothing at all on a machine with no settings source", () => {
    const box = machine("");
    const result = box.run();
    expect(result.status).toBe(0);
    expect(existsSync(box.target)).toBe(false);
    expect(box.log()).toBe("");
  });

  it("writes what the store answers, readable by root alone, on either cloud", () => {
    for (const source of ["aws-secretsmanager", "oci-vault"] as const) {
      const box = machine(source);
      const result = box.run(undefined, { out: SETTINGS });
      expect(result.status, source).toBe(0);
      expect(box.settings(), source).toBe(SETTINGS);
      expect(statSync(box.target).mode & 0o777, source).toBe(0o600);
      // The provider's own command, with the machine's own identity.
      expect(box.log(), source).toContain(
        source === "oci-vault"
          ? "secrets secret-bundle get --secret-id secret-id --auth instance_principal --region us-sanjose-1"
          : "secretsmanager get-secret-value --secret-id secret-id --region us-sanjose-1",
      );
      expect(box.log(), source).toContain("--network host example/cli:1");
    }
  });

  it("refuses an answer that is not settings, and says what the CLI said", () => {
    const box = machine();
    const result = box.run(undefined, {
      out: "An error occurred (AccessDeniedException)\n",
      err: "denied",
    });
    expect(result.status).toBe(1);
    expect(existsSync(box.target)).toBe(false);
    expect(result.stderr).toContain("could not read secret-id");
    expect(result.stderr).toContain("denied");
  });

  it("treats an empty answer as a failure, which is what a failed CLI looks like on OCI", () => {
    // sh has no pipefail, so `cli | base64 -d` succeeds with nothing when the
    // CLI fails. Accepting that would start the deployment with no settings.
    const box = machine("oci-vault");
    const result = box.run(undefined, {
      out: "",
      err: "NotAuthorizedOrNotFound",
      status: 0,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NotAuthorizedOrNotFound");
  });

  it("starts on the last settings when the store does not answer, rather than staying down", () => {
    const box = machine();
    expect(box.run(undefined, { out: SETTINGS }).status).toBe(0);
    const result = box.run(undefined, { err: "timeout", status: 255 });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("starting on the settings fetched last time");
    expect(box.settings()).toBe(SETTINGS);
  });

  it("restarts the deployment when, and only when, the settings changed", () => {
    const box = machine();
    expect(box.run(undefined, { out: SETTINGS }).status).toBe(0);
    expect(box.run("refresh", { out: SETTINGS }).status).toBe(0);
    expect(box.log()).not.toContain("systemctl");

    const changed = `${SETTINGS}ADSENSE_CLIENT_ID='ca-pub-0000000000000000'\n`;
    const result = box.run("refresh", { out: changed });
    expect(result.status).toBe(0);
    expect(box.settings()).toBe(changed);
    // try-restart: a deployment stopped on purpose stays stopped.
    expect(box.log()).toContain("systemctl try-restart simple-balance.service");
  });

  it("refreshes nothing before the first fetch, so it cannot start a deployment early", () => {
    const box = machine();
    const result = box.run("refresh", { out: SETTINGS });
    expect(result.status).toBe(0);
    expect(existsSync(box.target)).toBe(false);
    expect(box.log()).toBe("");
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
  function machine(parts: {
    base?: string;
    db?: string;
    secrets?: string;
    /** The stack's settings, as simple-balance-settings last fetched them. */
    settings?: string;
    /** The file the settings used to be typed into, which must not be read. */
    local?: string;
    env?: string;
  }) {
    const compose = mkdtempSync(path.join(tmpdir(), "sb-compose-"));
    const state = mkdtempSync(path.join(tmpdir(), "sb-state-"));
    dirs.push(compose, state);
    if (parts.base !== undefined) writeFileSync(path.join(compose, "env.base"), parts.base);
    if (parts.db !== undefined) writeFileSync(path.join(compose, "env.db"), parts.db);
    if (parts.env !== undefined) writeFileSync(path.join(compose, ".env"), parts.env);
    if (parts.secrets !== undefined) writeFileSync(path.join(state, "secrets.env"), parts.secrets);
    if (parts.settings !== undefined)
      writeFileSync(path.join(compose, "env.settings"), parts.settings);
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

  it("folds the parts together, the stack's settings last, readable by root alone", () => {
    const box = machine({
      base: "APP_BASE_URL=https://books.example.com\n",
      secrets: "AUTH_SECRET=abc\n",
      settings: "DATABASE_URL='postgresql://u:p@db/simple_balance'\n",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe(
      "APP_BASE_URL=https://books.example.com\nAUTH_SECRET=abc\n" +
        "# --- the stack's settings, from the cloud's secret store ---\n" +
        "DATABASE_URL='postgresql://u:p@db/simple_balance'\n",
    );
    expect(statSync(path.join(box.compose, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(box.compose, ".env.partial"))).toBe(false);
  });

  it("picks up newly fetched settings on the next run, which is what a restart now is", () => {
    const box = machine({
      base: "A=1\n",
      secrets: "AUTH_SECRET=abc\n",
      settings: "",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe("A=1\nAUTH_SECRET=abc\n");

    writeFileSync(path.join(box.compose, "env.settings"), "SB_BILLING_ENABLED='true'\n");
    expect(box.run().status).toBe(0);
    expect(box.env()).toContain("SB_BILLING_ENABLED='true'\n");
  });

  it("does not read env.local any more, and says so at every start", () => {
    // A machine built while settings were typed into a file on the volume may
    // still have one. Folding it would make the stack not the one place a
    // setting lives; ignoring it silently would leave somebody editing a file
    // that does nothing. So: not read, and named on every start.
    const box = machine({
      base: "A=1\n",
      secrets: "AUTH_SECRET=abc\n",
      local: "SB_BILLING_ENABLED=true\n",
    });
    const result = box.run();
    expect(result.status).toBe(0);
    expect(box.env()).not.toContain("SB_BILLING_ENABLED");
    expect(result.stderr).toContain("env.local is no longer read");
    expect(result.stderr).toContain("simple-balance:secrets");
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
      settings: "B=2\n",
    });
    const result = box.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is the data volume mounted");
    expect(box.env()).toBe("A=0\nAUTH_SECRET=old\n");
  });

  /**
   * The order the four parts are folded in, which is this profile's whole
   * upgrade-safety story for a machine a cloud program built.
   *
   * Compose reads the *last* assignment of a name, so the order below is what
   * decides who wins. An operator who writes their own DATABASE_URL — pointing
   * at a database they already keep, or at a replica during a move — has to
   * get it on a machine whose program generates one, with nothing to turn off
   * first. The stack's settings are folded last for exactly that.
   */
  const URL_FROM_THE_PROGRAM =
    "DATABASE_URL=postgresql://simple_balance:generated@db.db.simplebalance.oraclevcn.com:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem\n";

  it("folds the database credential after the base and before the secret", () => {
    const box = machine({
      base: "APP_BASE_URL=https://books.example.com\n",
      db: URL_FROM_THE_PROGRAM,
      secrets: "AUTH_SECRET=abc\n",
      settings: "",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe(
      "APP_BASE_URL=https://books.example.com\n" +
        "# --- the database credential this machine's program generated ---\n" +
        `${URL_FROM_THE_PROGRAM}AUTH_SECRET=abc\n`,
    );
  });

  it("lets the stack's own DATABASE_URL beat the generated one", () => {
    const mine =
      "DATABASE_URL=postgresql://u:p@db.example.com/simple_balance?sslmode=verify-full\n";
    const box = machine({
      base: "A=1\n",
      db: URL_FROM_THE_PROGRAM,
      secrets: "AUTH_SECRET=abc\n",
      settings: mine,
    });
    expect(box.run().status).toBe(0);
    // Both are present — nothing is filtered out, which would need this script
    // to parse rather than concatenate — and the stack's is last.
    const folded = box.env();
    expect(folded).toContain(URL_FROM_THE_PROGRAM);
    expect(folded.lastIndexOf("DATABASE_URL=")).toBe(folded.indexOf(mine));
  });

  it("carries on with no env.db at all, for a machine told to build no database node", () => {
    // And for every machine built before this file existed, which is the same
    // case: an upgrade must not need a file the old release never wrote.
    const box = machine({
      base: "A=1\n",
      secrets: "AUTH_SECRET=abc\n",
      local: "",
    });
    expect(box.run().status).toBe(0);
    expect(box.env()).toBe("A=1\nAUTH_SECRET=abc\n");
    expect(box.env()).not.toContain("the database credential");
  });

  it("warns about a URL that encrypts nothing, and still writes it", () => {
    // Said, never enforced. A URL the stack set is the operator's decision, and
    // refusing here would stop a deployment on a machine whose operator is not
    // watching, for a reason they would have to find in the journal anyway.
    for (const [label, url] of [
      ["disable", "postgresql://u:p@h/db?sslmode=disable"],
      ["disable among others", "postgresql://u:p@h/db?application_name=x&sslmode=disable"],
      ["no sslmode at all", "postgresql://u:p@h/db"],
    ] as const) {
      const box = machine({
        base: "A=1\n",
        secrets: "AUTH_SECRET=abc\n",
        settings: `DATABASE_URL=${url}\n`,
      });
      const result = box.run();
      expect(result.status, label).toBe(0);
      expect(result.stderr, label).toContain("sslmode=verify-full");
      expect(box.env(), label).toContain(url);
    }
  });

  it("says nothing about a URL that verifies, or on a machine with no URL at all", () => {
    // It must never fire on what the cloud programs generate, or the warning is
    // noise on every start of every machine and stops being read.
    const verified = machine({
      base: "A=1\n",
      db: URL_FROM_THE_PROGRAM,
      secrets: "AUTH_SECRET=abc\n",
      settings: "",
    });
    expect(verified.run().stderr).toBe("");
    // The database machine, whose env.db holds the role's password rather than
    // a URL: nothing here has an opinion to offer.
    const database = machine({
      base: "A=1\n",
      db: "POSTGRES_APP_PASSWORD=abc\n",
      secrets: "POSTGRES_PASSWORD=def\n",
      settings: "",
    });
    expect(database.run().stderr).toBe("");
  });

  it("reads the quoted spelling of a URL the same way Compose does", () => {
    // An operator who quoted the value must get the same answer as one who did
    // not, or the warning fires on exactly the deployments that were careful.
    const box = machine({
      base: "A=1\n",
      secrets: "AUTH_SECRET=abc\n",
      settings: `DATABASE_URL="postgresql://u:p@h/db?sslmode=verify-full&sslrootcert=/x.pem"\n`,
    });
    expect(box.run().stderr).toBe("");
  });
});

describe("the database machine's first-boot script", () => {
  const script = read("deploy/systemd/simple-balance-db-firstboot");
  const code = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const appFirstboot = read("deploy/systemd/simple-balance-firstboot");

  it("generates the superuser password only when there is none, so a rebuild cannot rotate it", () => {
    // POSTGRES_PASSWORD is applied by initdb and by nothing afterwards. A
    // rebuild that rotated it would hand the container a password the cluster
    // on the volume has never had: the entrypoint starts, finds PGDATA already
    // initialised, skips initdb entirely, and the two disagree until somebody
    // looks. The guard is the file's absence, not a flag.
    const guard = /if \[ ! -f "\$secrets" \]; then\n([\s\S]*?)\nfi\n/.exec(code);
    expect(guard, "the secret is written under a guard").not.toBeNull();
    expect(guard![1]).toContain("POSTGRES_PASSWORD=$(openssl rand -base64 48");
    // And nowhere else, so there is one writer rather than a second path that
    // forgot the guard.
    expect(code.match(/POSTGRES_PASSWORD=\$\(openssl/g)).toHaveLength(1);
  });

  it("makes its secret the same way the application machine makes AUTH_SECRET", () => {
    // One recipe on this profile rather than two: the `tr` deletes the newlines
    // openssl wraps at and the three base64 characters that would need escaping
    // in a URL or a compose file.
    const recipe = /openssl rand -base64 48 \| tr -d '\\n\/\+=' \| cut -c1-48/;
    expect(recipe.test(code)).toBe(true);
    expect(recipe.test(appFirstboot)).toBe(true);
  });

  it("never generates the password the other machine has to agree about", () => {
    // The role the application signs in as is decided by the Pulumi program,
    // because both machines need the same value and only one of them can
    // choose. A password generated here would be a plausible-looking secret the
    // application machine has never heard of.
    expect(code).not.toMatch(/POSTGRES_APP_PASSWORD=\$\(/);
    expect(code).not.toContain("AUTH_SECRET=$(");
  });

  it("formats the volume only when it is not already a filesystem", () => {
    // On this machine that one line is the difference between rebuilding the
    // database host and erasing the ledger.
    expect(code).toMatch(/if ! blkid "\$SB_DATA_DEVICE" >\/dev\/null 2>&1; then\n\tmkfs\.ext4/);
    expect(code.match(/mkfs\./g)).toHaveLength(1);
  });

  it("waits for the volume as long as the application machine does, and for a worse reason", () => {
    // Racing it here would leave PGDATA on the boot disk, an empty cluster
    // initialised into it, and a machine that comes up healthy and empty.
    const loop =
      /while \[ ! -b "\$SB_DATA_DEVICE" \] && \[ "\$i" -lt (\d+) \]; do\n\ti=\$\(\(i \+ 1\)\)\n\tsleep (\d+)\ndone/;
    const here = loop.exec(code);
    const there = loop.exec(appFirstboot);
    expect(here, "the loop that waits for the device").not.toBeNull();
    expect([here![1], here![2]]).toEqual([there![1], there![2]]);
  });

  it("labels its volume differently from the application machine's, within ext4's sixteen bytes", () => {
    // The two are never on one machine, but attaching the wrong one is a
    // mistake somebody makes at three in the morning — and a label that does
    // not match leaves the mount unsatisfied rather than starting PostgreSQL on
    // top of somebody's backups.
    //
    // Sixteen bytes is checked rather than only reasoned about in the script's
    // comment, because the failure of a seventeenth is silent at the point of
    // the mistake: `mkfs.ext4 -L` truncates and carries on, and what an
    // operator sees is the application on the other machine unable to connect.
    // `simple-balance-db` is exactly seventeen, which is how that happened.
    const label = /^SB_DATA_LABEL=(\S+)$/m.exec(code);
    expect(label, "the database script sets SB_DATA_LABEL").not.toBeNull();
    expect(Buffer.byteLength(label![1]!, "utf8")).toBeLessThanOrEqual(16);
    expect(code).toContain(`LABEL=$SB_DATA_LABEL `);
    expect(label![1]).toBe("sb-db-data");
    expect(appFirstboot).toContain("LABEL=simple-balance ");
    expect(code).not.toContain("LABEL=simple-balance ");
  });

  it("owns the data directory and the key by the image's own uid, which is the same number", () => {
    // The entrypoint chowns PGDATA but not the parent it is mounted at, so a
    // root-owned parent leaves the server unable to traverse into its own data
    // directory; and PostgreSQL refuses a private key with group or world
    // access on one the database user owns. Both failures are loud, which is
    // the only reason a hard-coded number is tolerable at all.
    expect(code).toContain("SB_POSTGRES_UID=999");
    expect(code).toContain("SB_POSTGRES_GID=999");
    expect(code).toMatch(/chown "\$SB_POSTGRES_UID:\$SB_POSTGRES_GID" "\$SB_PGDATA_DIR"/);
    expect(code).toMatch(/chown "\$SB_POSTGRES_UID:\$SB_POSTGRES_GID" "\$tls\/server\.key"/);
    expect(code).toMatch(/chmod 0600 "\$tls\/server\.key"/);
  });

  it("builds .env with the same script a restart runs, not a copy of it", () => {
    expect(code).toMatch(/^\/usr\/local\/sbin\/simple-balance-env$/m);
    expect(code).not.toMatch(/>\s*\/opt\/simple-balance\/\.env/);
  });

  it("stops short with an instruction rather than failing, when its half has not arrived", () => {
    // Safe to run again is what makes the instruction in /etc/motd a real one,
    // so the missing-credential path exits 0 after enabling the unit without
    // starting it — the same shape as the application machine's missing
    // DATABASE_URL, and for the same reason.
    const stanza = /\nif \[ -n "\$missing" \]; then\n([\s\S]*?)\nfi\n/.exec(code);
    expect(stanza, "the stanza that runs when a credential has not arrived").not.toBeNull();
    expect(stanza![1]).toContain("systemctl enable simple-balance.service");
    expect(stanza![1]).not.toMatch(/systemctl (?:start|restart|enable --now)/);
    expect(stanza![1].trimEnd().endsWith("exit 0")).toBe(true);
    // And the way out is in /etc/motd, where somebody who logs in meets it.
    expect(script).toContain("sudo /usr/local/sbin/simple-balance-db-firstboot");
  });

  it("restarts rather than starts at the end, so running it again applies a new setting", () => {
    // A start does nothing to a oneshot unit that is already active, which on a
    // live machine would rebuild .env and leave the container on the old one.
    const end = code.slice(code.lastIndexOf(": >/etc/motd"));
    expect(end).toContain("systemctl restart simple-balance.service");
    expect(code).not.toMatch(/enable --now simple-balance\.service/);
  });

  it("starts no backup timer, because the nightly dump is taken from the other machine", () => {
    // One copy of the ledger, on the volume that is already protected, rather
    // than a second one on the machine whose loss is the thing being insured
    // against.
    expect(code).not.toContain("simple-balance-backup.timer");
    expect(appFirstboot).toContain("simple-balance-backup.timer");
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
  // Every verified URL, however it is introduced: as `DATABASE_URL=` in a file,
  // or on its own line after `pulumi config set ... secrets.DATABASE_URL`, which
  // is how the machine's own instructions now give it.
  const verified = (text: string) =>
    [...text.matchAll(/(postgresql:\/\/[^'\n]*?sslmode=verify-full[^'\s]*)/g)].map(
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
    // a hand install writes, or fail on the env.base it does not have. The wait
    // beside it is the opposite case and belongs in the shared unit: a hand
    // install whose DATABASE_URL names a machine that boots alongside this one
    // meets exactly the ordering problem the cloud shape does.
    const service = read("deploy/systemd/simple-balance.service")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(service.filter((line) => line.startsWith("ExecStartPre="))).toEqual([
      "ExecStartPre=/usr/local/sbin/simple-balance-waitdb",
    ]);
    expect(service.join("\n")).not.toContain("simple-balance-env");
  });

  /**
   * Every program the shared unit runs, installed by every recipe that installs
   * the unit.
   *
   * `ExecStartPre=/usr/local/sbin/simple-balance-waitdb` shipped with nothing
   * outside cloud-init putting that file on a machine, and the two install
   * recipes in the unit's own header — which `deploy/compose/single/README.md`
   * sends every hand installer to — copied the units, the defaults file, the
   * compose files and `simple-balance-backup` and stopped. systemd treats an
   * absent `ExecStartPre` binary as `status=203/EXEC`, not as a step to skip,
   * so both documented hand installs failed at `systemctl enable --now` with a
   * path nothing had told the operator to create. Nothing starts: not the
   * application, not Caddy, and on the database machine not PostgreSQL.
   */
  it("installs every program it runs, in both of its own install recipes", () => {
    const unit = read("deploy/systemd/simple-balance.service");
    const header = unit.slice(0, unit.indexOf("[Unit]"));
    const body = unit
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    const programs = [...body.matchAll(/^Exec\w+=-?(\/usr\/local\/\S+)/gm)].map(
      (match) => match[1]!,
    );
    expect(programs, "the unit runs something out of /usr/local").toContain(
      "/usr/local/sbin/simple-balance-waitdb",
    );

    // The header is two recipes, one per machine, and the split is the sentence
    // that introduces the second. Both have to install every program, because
    // the same unit file is enabled on both hosts.
    const split = header.indexOf("# The database machine");
    expect(split, "the header describes the database machine too").toBeGreaterThan(-1);
    const recipes = {
      application: header.slice(0, split),
      database: header.slice(split),
    };
    for (const [machine, recipe] of Object.entries(recipes)) {
      for (const program of programs) {
        const name = path.basename(program);
        expect(
          recipe.includes(`${program.slice(0, program.lastIndexOf("/"))}/`) &&
            recipe.includes(`deploy/systemd/${name}`),
          `the ${machine} recipe installs ${program}`,
        ).toBe(true);
      }
    }
  });
});
