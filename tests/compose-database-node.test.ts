import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoFiles } from "./support/source.js";

/**
 * The host-level artifacts of the `single` profile's database machine:
 * `compose.postgres.yml`, the `pg_hba.conf` it mounts over the one `initdb`
 * writes, and the `db-init.sh` the entrypoint runs once.
 *
 * Every assertion here was checked against a running PostgreSQL 18 before it
 * was written down, rather than reasoned about — the container was brought up,
 * `show hba_file` and `show ssl` were read back out of it, and each refusal
 * below was provoked with a real client. What the test holds is the shape that
 * produced those answers, because the shape is what a later edit can break
 * without anybody bringing a container up again.
 *
 * The four properties worth stating plainly, because each is one line away from
 * silently inverting:
 *
 *   - the server refuses plaintext, rather than the client remembering to ask;
 *   - the superuser cannot be reached across the network at all;
 *   - the application's role is not the superuser and owns only its own
 *     database;
 *   - a bind whose source is missing is a refusal, never a directory Docker
 *     made on the boot disk for a brand new empty cluster.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const COMPOSE = "deploy/compose/single/compose.postgres.yml";
const HBA = "deploy/compose/single/pg_hba.conf";
const INIT = "deploy/compose/single/db-init.sh";

const compose = read(COMPOSE);
const hba = read(HBA);
const init = read(INIT);

/** The `-c name=value` flags the compose file passes to `postgres`. */
const flags = new Map(
  [...compose.matchAll(/^\s+- ([a-z_]+)=(.*)$/gm)].map((match) => [match[1]!, match[2]!]),
);

/**
 * Every bind mount in the compose file, as `source -> target`.
 *
 * Split by indentation rather than by "everything up to the next blank line",
 * because the blocks in this file are separated by comment lines at the marker's
 * own indent — a greedy match runs straight through them and returns one bind
 * carrying every other bind's keys, which reads as a single read-only mount and
 * quietly agrees with whatever it is asked.
 */
const binds = compose.split("\n").flatMap((line, at, lines) => {
  if (!/^\s*- type: bind\s*$/.test(line)) return [];
  const keys: string[] = [];
  for (const entry of lines.slice(at + 1)) {
    if (entry.trim() === "") continue;
    if (entry.length - entry.trimStart().length <= line.length - line.trimStart().length) break;
    keys.push(entry);
  }
  const block = keys.join("\n");
  return [
    {
      source: /source: (\S+)/.exec(block)?.[1] ?? "",
      target: /target: (\S+)/.exec(block)?.[1] ?? "",
      readOnly: /read_only: true/.test(block),
      createsHostPath: !/create_host_path: false/.test(block),
    },
  ];
});

/** `pg_hba.conf` as records, comments and blank lines dropped. */
const hbaLines = hba
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => line.trim().split(/\s+/));

describe("the database machine's server settings", () => {
  it("serves TLS from the certificate the compose file mounts", () => {
    expect(flags.get("ssl")).toBe("on");
    // Named files rather than PGDATA's defaults, and the paths have to be ones
    // a mount really provides — a certificate path pointing at nothing is a
    // server that refuses to start, which is loud, but a *stale* path inside
    // the data volume is a server that starts on last year's certificate.
    for (const setting of ["ssl_cert_file", "ssl_key_file"]) {
      const file = flags.get(setting);
      expect(file, setting).toBeDefined();
      expect(
        binds.some((bind) => file!.startsWith(`${bind.target}/`)),
        `${setting}=${file} is not under anything the compose file mounts`,
      ).toBe(true);
    }
  });

  it("reads the pg_hba in this repository, not the one initdb wrote into PGDATA", () => {
    // This is the whole enforcement mechanism. Without `hba_file` the image's
    // generated rules apply, and those end in `host all all all scram-sha-256`
    // — which accepts an unencrypted connection that authenticates. Verified by
    // reading `show hba_file` back out of a running server.
    const file = flags.get("hba_file");
    expect(file).toBe("/etc/postgresql/pg_hba.conf");
    const mount = binds.find((bind) => bind.target === file);
    expect(mount, "pg_hba.conf is mounted").toBeDefined();
    expect(mount!.source).toBe("./pg_hba.conf");
    expect(mount!.readOnly, "a server that can rewrite its own rules").toBe(true);
    expect(file!.startsWith("/var/lib/postgresql")).toBe(false);
  });

  it("applies the five sizing numbers as flags, defaulted and overridable", () => {
    // They are `-c` flags and not an `environment:` block because the postgres
    // image reads none of these names. The deleted `vps` file set both, and the
    // copy in the environment was five settings that looked applied and did
    // nothing.
    for (const setting of [
      "shared_buffers",
      "effective_cache_size",
      "work_mem",
      "maintenance_work_mem",
      "max_wal_size",
      "max_connections",
    ]) {
      const value = flags.get(setting);
      expect(value, setting).toBeDefined();
      expect(value, `${setting} has no default`).toMatch(/^\$\{POSTGRES_[A-Z_]+:-[^}]+\}$/);
    }
    expect(flags.get("max_connections")).toContain(":-50");
  });

  it("pins the major version, because a tag that moved would not start", () => {
    // A `docker compose pull` on a floating tag that reached 19 restarts
    // against a data directory 19 refuses to read, and the deployment is down
    // until somebody works out why.
    expect(/^\s+image: postgres:(\d+)\s*$/m.exec(compose)?.[1]).toBe("18");
  });
});

describe("who may reach the database machine, and how", () => {
  it("refuses plaintext on every line that crosses a network", () => {
    // The server refusing is the only half of encryption in transit that cannot
    // be forgotten: a client's `sslmode` is the client's choice. Provoked
    // against a real server, which answered `no pg_hba.conf entry for host
    // ..., no encryption`.
    const networked = hbaLines.filter(([type]) => type !== "local");
    expect(networked.length).toBeGreaterThan(0);
    for (const line of networked) {
      const [type, , , address] = line;
      // The loopback line is the health check's, inside the container's own
      // network namespace, where no packet from off the machine can arrive.
      if (address === "127.0.0.1/32") {
        expect(type, line.join(" ")).toBe("host");
        continue;
      }
      expect(type, `${line.join(" ")} would take an unencrypted connection`).toBe("hostssl");
    }
  });

  it("never lets the superuser in over the network, on any line", () => {
    // Verified: `postgres` over TLS with the right password was refused with
    // `no pg_hba.conf entry`. The superuser exists for the entrypoint and for
    // anyone who already has a shell on the machine.
    for (const line of hbaLines) {
      const [type, , user] = line;
      if (type === "local") continue;
      if (user === "postgres") expect(line[3], line.join(" ")).toBe("127.0.0.1/32");
    }
  });

  it("trusts nothing that arrives from off the machine", () => {
    for (const line of hbaLines) {
      const [type, , , address, method] = line;
      if (method !== "trust") continue;
      expect(
        type === "local" || address === "127.0.0.1/32",
        `${line.join(" ")} trusts a connection from off this machine`,
      ).toBe(true);
    }
  });

  it("lets the application in only as its own role, into its own database", () => {
    // Verified from a client container: the same role into `postgres` was
    // refused, and so was the same role with `sslmode=disable`.
    const application = hbaLines.filter(
      ([type, , user]) => user === "simple_balance" && type !== "local",
    );
    expect(application.length).toBe(1);
    expect(application[0]!.slice(0, 3)).toEqual(["hostssl", "simple_balance", "simple_balance"]);
    expect(application[0]![4]).toBe("scram-sha-256");
  });

  it("lets the same role in over the container's own socket, which is what the backups need", () => {
    // `simple-balance-backup` and `simple-balance-restore` find `postgres` in
    // this project's service list and dump through `docker compose exec`, as
    // `simple_balance`. Without this line every one of them fails with
    // `no pg_hba.conf entry for host "[local]", user "simple_balance"` — which
    // is what happened, and which nothing caught, because the role stopped
    // being the superuser when the database moved out of the deleted `vps`
    // recipe and the two scripts went on naming it.
    //
    // As the application's role rather than the superuser, and that is about
    // the restore rather than the dump: `pg_restore --no-owner` hands every
    // object to whoever connected, so restoring as `postgres` leaves a ledger
    // the application meets as `permission denied for table ledger_posting`.
    // Measured against a real server, both ways round.
    const socket = hbaLines.filter(([type]) => type === "local");

    expect(socket.map((line) => line[2])).toEqual(["postgres", "simple_balance"]);
    // Narrowed to the one database, so it is not a second way into the cluster.
    expect(socket.find((line) => line[2] === "simple_balance")![1]).toBe("simple_balance");
  });
});

describe("the role the application signs in as", () => {
  it("is created by the entrypoint, in the directory the entrypoint runs", () => {
    const mount = binds.find((bind) => bind.source === `./${INIT.split("/").at(-1)}`);
    expect(mount, "db-init.sh is mounted").toBeDefined();
    expect(mount!.target.startsWith("/docker-entrypoint-initdb.d/")).toBe(true);
    // Numbered, because the entrypoint runs that directory in lexical order and
    // anything added later has to be orderable against this.
    expect(mount!.target).toMatch(/\/\d+-[\w-]+\.sh$/);
  });

  it("is not the superuser, and the compose file does not make it one", () => {
    // The deleted `vps` recipe set `POSTGRES_USER: simple_balance`, so the
    // application connected as the owner of the cluster and one leaked
    // connection string could drop every database on the machine. The
    // superuser here is `postgres`, and pg_hba refuses it over the network.
    expect(/POSTGRES_USER: (\S+)/.exec(compose)?.[1]).toBe("postgres");
    expect(init).not.toMatch(/CREATE ROLE \S+ [^;]*SUPERUSER/i);
    expect(init).not.toMatch(/ALTER ROLE \S+ [^;]*SUPERUSER/i);
    // The name is a shell variable in the SQL because it is also written into
    // pg_hba.conf and into the DATABASE_URL the cloud programs generate, and a
    // name spelled in four places is a name three of them can be wrong about.
    expect(init).toMatch(/^role=simple_balance$/m);
    expect(init).toMatch(/CREATE ROLE \$role LOGIN PASSWORD/);
  });

  it("owns the database rather than being granted on it", () => {
    // PostgreSQL 15 stopped granting CREATE on `public` to PUBLIC, so a role
    // with mere rights in the database cannot create a table — and the
    // application's first act is to run its migrations. Ownership is one
    // statement that stays true as schemas are added.
    expect(init).toMatch(/ALTER DATABASE :"db" OWNER TO \$role/);
  });

  it("passes the password to psql as a parameter, never interpolated into SQL", () => {
    // `-v` plus `:'password'` makes psql quote and escape the value itself, so
    // a password is a literal however it is spelled. Exercised with
    // `o'brien;--$x`, which left exactly one role behind.
    expect(init).toMatch(/-v "password=\$POSTGRES_APP_PASSWORD"/);
    expect(init).toMatch(/PASSWORD :'password'/);
    expect(init).not.toMatch(/PASSWORD '\$/);
    // And a failed statement stops the script, rather than leaving a cluster
    // with no application role behind an entrypoint that reported success.
    expect(init).toContain("ON_ERROR_STOP=1");
  });

  it("rotates rather than recreates, because by then the role owns the schema", () => {
    expect(init).toMatch(/ALTER ROLE \$role PASSWORD/);
    expect(init).not.toMatch(/DROP ROLE/);
  });
});

describe("what a missing directory does", () => {
  it("refuses at `up` rather than letting Docker invent one", () => {
    // The worst failure this file can have is coming up green with an empty
    // ledger: Docker creates the missing source on the boot disk, PostgreSQL
    // initialises a brand new cluster into it, and the health check passes.
    // One line per bind prevents it.
    const inventing = binds.filter((bind) => bind.createsHostPath);

    expect(inventing.map((bind) => `${bind.source} -> ${bind.target}`)).toEqual([]);
  });

  it("mounts the parent of PGDATA, which is what PostgreSQL 18 needs", () => {
    // 18 moved PGDATA into a versioned subdirectory and its entrypoint refuses
    // to start against a volume mounted at the old path. The parent is also
    // what lets a later `pg_upgrade --link` work without crossing a mount
    // boundary.
    const data = binds.find((bind) => bind.target === "/var/lib/postgresql");
    expect(data, "the data volume is mounted at the parent").toBeDefined();
    expect(data!.source).toMatch(/^\$\{SB_PGDATA_DIR:-\/var\/lib\/simple-balance\/postgresql\}$/);
    expect(binds.some((bind) => bind.target === "/var/lib/postgresql/data")).toBe(false);
  });

  it("keeps the certificate and the rules read-only", () => {
    // A key a process can rewrite is a key a compromise of that process can
    // replace, and rules a server can rewrite are not rules.
    for (const bind of binds.filter((bind) => bind.target !== "/var/lib/postgresql"))
      expect(bind.readOnly, `${bind.target} is writable`).toBe(true);
  });
});

describe("the name the application verifies the database by", () => {
  /**
   * Every `DATABASE_URL` example under `deploy/` that asks for a verified
   * certificate.
   */
  const verified = repoFiles(
    (file) => file.startsWith("deploy/") && !file.includes("/node_modules/"),
  ).flatMap(({ path: file, text }) =>
    [...text.matchAll(/postgres(?:ql)?:\/\/[^\s"'`]*sslmode=verify-full[^\s"'`]*/g)].map(
      (match) => ({ file, url: match[0]! }),
    ),
  );

  it("finds the examples it is checking", () => {
    expect(verified.length).toBeGreaterThan(0);
  });

  it("never writes an address where `verify-full` needs a hostname", () => {
    // Measured against pg 8.23 and a real PostgreSQL 18, not read off
    // anything. `node-postgres` sets the TLS server name from the URL's host
    // only when that host is not an IP literal (`net.isIP(host) === 0`, in
    // `pg/lib/connection.js`); with an address it sends none, Node falls back
    // to checking the certificate against the string `localhost`, and the
    // connection fails with `Host: localhost. is not in the cert's altnames`
    // however many IP entries the certificate carries.
    //
    // So the IP in the certificate is for `psql`, which does verify an IP
    // entry properly — that was confirmed the same way, from a client
    // container. An application URL has to name the host.
    const addressed = verified.filter(({ url }) => /@(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\//.test(url));

    expect(addressed.map(({ file, url }) => `${file}: ${url}`)).toEqual([]);
  });
});
