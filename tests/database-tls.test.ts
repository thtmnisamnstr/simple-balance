import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The DATABASE_URL that verifies the server, as this repository's own
 * node-postgres reads it, and what the application says when verification
 * fails.
 *
 * Run against a server rather than read from a parser, because what matters is
 * what the TLS handshake does with the string: that `sslrootcert` is loaded as
 * the only CA trusted, that `verify-full` checks the name, and that the message
 * a failure produces sends the operator to the verified setting before the
 * unverified one. The server is a stand-in that speaks just enough of the
 * PostgreSQL protocol for node-postgres to finish connecting — the SSLRequest,
 * the handshake, and then AuthenticationOk and ReadyForQuery — so it needs no
 * database and no network. The certificates are made here, by the `openssl`
 * command, from a CA nobody else has.
 */

const dir = mkdtempSync(path.join(tmpdir(), "sb-db-tls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => path.join(dir, name);

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

/** A CA, and a server certificate it signed for exactly the names given. */
function authority(name: string) {
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...key,
    "-days",
    "2",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    file(`${name}.key`),
    "-out",
    file(`${name}.pem`),
  );
  return (server: string, altNames: string) => {
    openssl(
      "req",
      ...key,
      "-subj",
      `/CN=${server}`,
      "-keyout",
      file(`${server}.key`),
      "-out",
      file(`${server}.csr`),
    );
    writeFileSync(
      file(`${server}.ext`),
      `subjectAltName=${altNames}\nextendedKeyUsage=serverAuth\n`,
    );
    openssl(
      "x509",
      "-req",
      "-in",
      file(`${server}.csr`),
      "-CA",
      file(`${name}.pem`),
      "-CAkey",
      file(`${name}.key`),
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      file(`${server}.ext`),
      "-out",
      file(`${server}.crt`),
    );
    return {
      cert: readFileSync(file(`${server}.crt`), "utf8"),
      key: readFileSync(file(`${server}.key`), "utf8"),
    };
  };
}

/**
 * A server certificate the CA above signed for a window that closed in 2020.
 * `openssl ca` rather than `x509 -req`, because it is the one spelling that
 * takes both dates on every OpenSSL this runs under — LibreSSL on a Mac, and
 * the 3.0 an Ubuntu runner has, which predates `x509 -not_after`.
 */
function expiredFrom(name: string, server: string, altNames: string) {
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl(
    "req",
    ...key,
    "-subj",
    `/CN=${server}`,
    "-keyout",
    file(`${server}.key`),
    "-out",
    file(`${server}.csr`),
  );
  writeFileSync(file(`${server}.index`), "");
  writeFileSync(file(`${server}.serial`), "01\n");
  writeFileSync(
    file(`${server}.cnf`),
    [
      "[ca]",
      "default_ca = here",
      "[here]",
      `database = ${file(`${server}.index`)}`,
      `new_certs_dir = ${dir}`,
      `serial = ${file(`${server}.serial`)}`,
      "default_md = sha256",
      "policy = anything",
      "x509_extensions = server",
      "[anything]",
      "commonName = supplied",
      "[server]",
      `subjectAltName = ${altNames}`,
      "extendedKeyUsage = serverAuth",
      "",
    ].join("\n"),
  );
  openssl(
    "ca",
    "-batch",
    "-notext",
    "-config",
    file(`${server}.cnf`),
    "-cert",
    file(`${name}.pem`),
    "-keyfile",
    file(`${name}.key`),
    "-in",
    file(`${server}.csr`),
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
    "-out",
    file(`${server}.crt`),
  );
  return {
    cert: readFileSync(file(`${server}.crt`), "utf8"),
    key: readFileSync(file(`${server}.key`), "utf8"),
  };
}

/** PostgreSQL's SSLRequest code, the whole of the first message a TLS client sends. */
const SSL_REQUEST = 80877103;

/** A server that says yes to TLS and then lets whoever completes the handshake in. */
async function standIn(identity: { cert: string; key: string }) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (request) => {
      if (request.length !== 8 || request.readInt32BE(4) !== SSL_REQUEST) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const secure = new tls.TLSSocket(socket, { isServer: true, ...identity });
      secure.on("error", () => {});
      secure.once("data", () => {
        // AuthenticationOk, then ReadyForQuery in the idle state.
        secure.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
      });
    });
  });
  // Bound to whichever address `localhost` is here, and dialed by that name,
  // so the certificate's name is what the handshake checks.
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let caFile: string;
let wrongCaFile: string;
let named: Awaited<ReturnType<typeof standIn>>;
let misnamed: Awaited<ReturnType<typeof standIn>>;
let expired: Awaited<ReturnType<typeof standIn>>;

beforeAll(async () => {
  const signFor = authority("db-ca");
  authority("wrong-ca");
  caFile = file("db-ca.pem");
  wrongCaFile = file("wrong-ca.pem");
  named = await standIn(signFor("localhost", "DNS:localhost"));
  misnamed = await standIn(signFor("elsewhere", "DNS:db.elsewhere.example"));
  expired = await standIn(expiredFrom("db-ca", "stale", "DNS:localhost"));
});
afterAll(async () => {
  await Promise.all([named?.close(), misnamed?.close(), expired?.close()]);
});

const url = (port: number, query: string) =>
  `postgresql://ledger:secret@localhost:${port}/simple_balance?${query}`;

/**
 * Whether node-postgres connects with this string, and the code it refused with
 * if not. The client is made inside the `try` because a `sslrootcert` it cannot
 * read throws from the constructor, before anything connects.
 */
async function connects(connectionString: string): Promise<true | string> {
  let client: Client | undefined;
  try {
    client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
    await client.connect();
    return true;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  } finally {
    await client?.end().catch(() => {});
  }
}

describe("a DATABASE_URL that verifies the server", () => {
  it("connects with verify-full and sslrootcert naming the CA that signed it", async () => {
    expect(await connects(url(named.port, `sslmode=verify-full&sslrootcert=${caFile}`))).toBe(true);
  });

  it("trusts that file alone, so a CA that signed nothing here is refused", async () => {
    expect(
      await connects(url(named.port, `sslmode=verify-full&sslrootcert=${wrongCaFile}`)),
    ).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/);
  });

  it("refuses the right CA's certificate for a name the URL does not use", async () => {
    expect(await connects(url(misnamed.port, `sslmode=verify-full&sslrootcert=${caFile}`))).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
  });

  it("refuses verify-full with no sslrootcert, because Node's own roots do not have a private CA", async () => {
    expect(await connects(url(named.port, "sslmode=verify-full"))).toMatch(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/,
    );
  });

  it("still takes no-verify, which encrypts and checks nothing", async () => {
    expect(await connects(url(named.port, "sslmode=no-verify"))).toBe(true);
    expect(await connects(url(named.port, `sslmode=no-verify&sslrootcert=${wrongCaFile}`))).toBe(
      true,
    );
  });

  it("does not understand libpq's sslrootcert=system, which is why nothing recommends it", async () => {
    expect(await connects(url(named.port, "sslmode=verify-full&sslrootcert=system"))).toMatch(
      /ENOENT/,
    );
  });
});

describe("what the migration says when the server's certificate does not verify", () => {
  async function migrationRefusal(connectionString: string) {
    const previous = { url: process.env.DATABASE_URL, direct: process.env.DIRECT_DATABASE_URL };
    process.env.DATABASE_URL = connectionString;
    delete process.env.DIRECT_DATABASE_URL;
    try {
      const { runMigrations } = await import("../src/server/db/migrate.js");
      await runMigrations();
      throw new Error("the migration connected");
    } catch (error) {
      return error as Error & { cause?: { code?: string } };
    } finally {
      if (previous.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.url;
      if (previous.direct !== undefined) process.env.DIRECT_DATABASE_URL = previous.direct;
    }
  }

  it("sends the operator to verify-full with the CA's file before it offers no-verify", async () => {
    const refusal = await migrationRefusal(url(named.port, "sslmode=verify-full"));
    expect(refusal.message).toMatch(/^The database refused a verified TLS connection \(/);
    expect(refusal.cause?.code).toMatch(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/,
    );

    const verified = refusal.message.indexOf("?sslmode=verify-full&sslrootcert=");
    const unverified = refusal.message.indexOf("?sslmode=no-verify");
    expect(verified, "names the verified setting").toBeGreaterThan(-1);
    expect(unverified, "names the unverified one").toBeGreaterThan(-1);
    expect(verified, "the verified one first").toBeLessThan(unverified);
    expect(refusal.message).toContain(
      "If the URL names one already, it is not the one that signed",
    );
  });

  it("names no path only one deployment shape has, because every shape runs it", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/server/db/migrate.ts"), {
      encoding: "utf8",
    });
    const message = source.slice(
      source.indexOf("The database refused a verified TLS connection"),
      source.indexOf("{ cause: error }", source.indexOf("The database refused a verified")),
    );
    expect(message).toContain("sslrootcert=/path/to/ca.pem");
    expect(message).not.toMatch(/\/var\/lib|\/opt\/|simple-balance\/tls/);
  });

  it("says the same for a name the certificate does not carry", async () => {
    const refusal = await migrationRefusal(
      url(misnamed.port, `sslmode=verify-full&sslrootcert=${caFile}`),
    );
    expect(refusal.cause?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(refusal.message).toContain(
      "The host in the URL has to be a name the certificate carries",
    );
    // The right CA was named, so the reading a chain failure gets is false here.
    expect(refusal.message).toContain("Here the CA is not what failed");
    expect(refusal.message).not.toContain("it is not the one that signed");
  });

  it("sends an expired certificate to a renewal rather than to another CA", async () => {
    const refusal = await migrationRefusal(
      url(expired.port, `sslmode=verify-full&sslrootcert=${caFile}`),
    );
    expect(refusal.cause?.code).toBe("CERT_HAS_EXPIRED");
    expect(refusal.message).toContain("a renewal rather than another CA is what fixes it");
    expect(refusal.message).not.toContain("it is not the one that signed");
  });
});
