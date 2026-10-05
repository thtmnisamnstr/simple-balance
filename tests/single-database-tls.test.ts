import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as aws from "../deploy/pulumi/aws-single/platform.js";
import * as oci from "../deploy/pulumi/oci-single/platform.js";
import {
  APPLICATION_CA_PATH,
  DATABASE_NAME,
  DATABASE_PORT,
  DATABASE_ROLE,
  databaseUrl,
} from "../deploy/pulumi/single-common/cloud-init.js";
import { AWS_SINGLE, OCI_SINGLE, programCode, readProgram } from "./support/pulumi-source.js";

/**
 * The name in the certificate, the name in the connection string, and the path
 * the CA is read from: three strings that have to be one fact three times.
 *
 * `tests/database-tls.test.ts` is the other half of this and is the more
 * expensive half — it stands up a server and makes node-postgres really
 * connect to it, which is what proved the asymmetry below. This file is the
 * cheap half: it checks that the values the programs compute agree with each
 * other, which no handshake can, because a handshake only ever sees one of
 * them.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/** The host out of a connection string, without pretending postgresql:// is http. */
const hostOf = (url: string) => /@([^:/?]+):/.exec(url)?.[1] ?? "";

describe("the name the application dials", () => {
  it("is the provider's internal DNS name and never an address", () => {
    // node-postgres sets the TLS servername only when `net.isIP(host)` is 0, so
    // an address sends no SNI and Node then verifies the certificate against
    // the literal string `localhost` — which no certificate this program issues
    // names. libpq is the other way round and verifies an IP SAN happily, so
    // the asymmetry is real and it cuts against the one client that matters
    // most. Measured against a real PostgreSQL 18 rather than reasoned about.
    const hosts = [
      oci.databaseHost("simplebalance", "db", "db"),
      aws.databaseHost("10.20.1.10", "us-west-2"),
      aws.databaseHost("10.20.1.10", "us-east-1"),
    ];
    for (const host of hosts) {
      expect(net.isIP(host), host).toBe(0);
      expect(hostOf(databaseUrl(host, "x".repeat(32))), host).toBe(host);
    }
  });

  it("is refused outright when it is one, rather than failing at the first connection", () => {
    // The failure it replaces is `Hostname/IP does not match certificate's
    // altnames` on a deployment `pulumi up` has already reported as done.
    for (const address of ["10.20.1.10", "127.0.0.1", "fd00::1"]) {
      expect(() => databaseUrl(address, "x".repeat(32)), address).toThrow(
        /is an address rather than a DNS name/,
      );
    }
  });

  it("spells us-east-1 the way only us-east-1 is spelled", () => {
    // Every other region is ip-10-20-1-10.<region>.compute.internal, and
    // us-east-1 alone is ip-10-20-1-10.ec2.internal. Getting it wrong issues a
    // certificate for a name that resolves nowhere, and the symptom is
    // ENOTFOUND rather than a verification error — which reads like a network
    // fault and sends an operator to the wrong place entirely.
    expect(aws.databaseHost("10.20.1.10", "us-east-1")).toBe("ip-10-20-1-10.ec2.internal");
    for (const region of ["us-west-2", "eu-central-1", "ap-southeast-2", "sa-east-1"]) {
      expect(aws.databaseHost("10.20.1.10", region), region).toBe(
        `ip-10-20-1-10.${region}.compute.internal`,
      );
    }
    // The address is spelled with dashes because that is what AWS names it.
    expect(aws.databaseHost("10.0.0.4", "us-west-2")).toBe(
      "ip-10-0-0-4.us-west-2.compute.internal",
    );
  });

  it("is built from the same labels the OCI resources take, so neither is renamed alone", () => {
    // The VCN resolver composes the name from three labels, and a subnet
    // relabelled in one place and not the other is a certificate that verifies
    // against nothing — found at the first connection rather than at preview.
    expect(oci.databaseHost("simplebalance", "db", "db")).toBe("db.db.simplebalance.oraclevcn.com");
    const program = programCode(readProgram(OCI_SINGLE));
    expect(program).toContain(
      "const databaseDnsName = databaseHost(vcnDnsLabel, databaseSubnetDnsLabel, databaseHostLabel);",
    );
    expect(program).toContain("dnsLabel: vcnDnsLabel,");
    expect(program).toContain("dnsLabel: databaseSubnetDnsLabel,");
    expect(program).toContain("hostnameLabel: databaseHostLabel,");
  });
});

describe("the certificate the database node presents", () => {
  const tls = read("deploy/pulumi/single-common/tls.ts");

  it("names the URL's host as a DNS SAN and the pinned address as an IP one", () => {
    // Both, and for different clients: the DNS name is what node-postgres
    // checks, the address is what libpq checks when the backup scripts or a
    // person dial it directly. The common name is neither — every client that
    // matters has ignored it for years.
    expect(tls).toContain("dnsNames: [dnsName],");
    expect(tls).toContain("ipAddresses: [ipAddress],");
    for (const program of [AWS_SINGLE, OCI_SINGLE]) {
      const code = programCode(readProgram(program));
      expect(code, program).toContain("dnsName: databaseDnsName,");
      expect(code, program).toContain("ipAddress: databasePrivateIp,");
    }
  });

  it("identifies a server and not a client", () => {
    // A certificate that can do both is one that can be replayed as a client
    // somewhere else.
    //
    // Snake case, because that is the vocabulary the provider takes:
    // @pulumi/tls's own `selfSignedCert.d.ts` example writes `key_encipherment`,
    // `digital_signature` and `server_auth`. A camelCase spelling asserted here
    // would be a test asking for three uses the provider does not recognise,
    // and the obvious repair — making the code match the test — fails every
    // `pulumi up` at the certificate on both single-machine stacks.
    expect(tls).toContain('allowedUses: ["digital_signature", "key_encipherment", "server_auth"]');
    // The code, not the prose: the paragraph beside it says the word in
    // explaining why it is absent. Spelled the way the provider would take it,
    // so the guard can actually fire — `clientAuth` is a spelling that could
    // never appear, which is a guard that passes whatever is added.
    expect(programCode(tls)).not.toContain("client_auth");
  });

  it("is signed by a CA that may sign nothing below it", () => {
    expect(tls).toContain("isCaCertificate: true");
    expect(tls).toContain("maxPathLength: 0");
  });
});

describe("where the CA certificate is read from", () => {
  it("is one path, and it is the path the overlay mounts", () => {
    // Three readers of one string: the host path firstboot creates on the data
    // volume, the container path compose.db-tls.yml mounts it at, and the
    // `sslrootcert` in the URL. Mount it anywhere else and the application
    // verifies against a file the backup cannot see, or the other way round,
    // and the nightly dump is what finds out.
    const overlay = read("deploy/compose/single/compose.db-tls.yml");
    const directory = path.posix.dirname(APPLICATION_CA_PATH);
    expect(overlay).toContain(`source: ${directory}`);
    expect(overlay).toContain(`target: ${directory}`);
    expect(databaseUrl("db.db.simplebalance.oraclevcn.com", "x".repeat(32))).toContain(
      `sslrootcert=${APPLICATION_CA_PATH}`,
    );
  });

  it("is verify-full, not require, because two client libraries read the same string", () => {
    // pg-connection-string returns `ssl: {}` for both spellings, so
    // node-postgres verifies either way — but for libpq, which is what
    // simple-balance-backup and simple-balance-restore use, `require` checks
    // nothing at all.
    const url = databaseUrl("db.db.simplebalance.oraclevcn.com", "x".repeat(32));
    expect(url).toContain("?sslmode=verify-full&");
    expect(url).not.toContain("sslmode=require");
    expect(url.startsWith(`postgresql://${DATABASE_ROLE}:`), url).toBe(true);
    expect(url).toContain(`:${DATABASE_PORT}/${DATABASE_NAME}?`);
  });

  it("is not the superuser's account", () => {
    // The entrypoint creates the database as `postgres` and db-init.sh hands it
    // over, so a SQL injection that got as far as the driver still cannot read
    // pg_authid or write outside this database.
    expect(DATABASE_ROLE).not.toBe("postgres");
    expect(read("deploy/compose/single/db-init.sh")).toContain(DATABASE_ROLE);
    expect(read("deploy/compose/single/pg_hba.conf")).toMatch(
      new RegExp(`^hostssl ${DATABASE_ROLE} +${DATABASE_ROLE} `, "m"),
    );
  });
});
