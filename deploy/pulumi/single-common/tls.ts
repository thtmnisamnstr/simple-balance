import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";

/**
 * The certificate the database node presents and the CA the application node
 * checks it against, both made at plan time.
 *
 * Why a private CA at all, when the rest of this profile gets its certificates
 * from Let's Encrypt: the database node has no public address and no public
 * name, so it can answer no ACME challenge of any kind. HTTP-01 needs port 80
 * reachable from the internet, which is the one thing the design refuses it,
 * and DNS-01 would need the program to hold an API token for the operator's
 * registrar. A CA that exists only for this one stack, signing one name, is
 * smaller than either.
 *
 * Why at plan time rather than on the machine: the name in the certificate has
 * to be the name the application dials, and the application's cloud-init is
 * written before either machine boots. Generating on the database node would
 * mean the application node receiving a fingerprint it could not know yet, or
 * `sslmode=require` — which verifies nothing and is the divergence
 * docs/deployment.md records.
 *
 * ECDSA P-256 rather than RSA, and the reason is a byte count. Each machine
 * carries its half of this in user data, EC2 caps user data at 16,384 bytes
 * after gzip, and an RSA-4096 key and certificate are roughly ten times the
 * PEM of a P-256 pair. Nothing here needs a key that an old client can read:
 * the only client is node-postgres on the other machine and `psql` run by
 * hand, and both have spoken ECDSA for a decade.
 */

/** What the two certificates are for and who they are issued to. */
export interface DatabaseCertificateArgs {
  /** Resource name prefix, so two stacks in one account do not collide. */
  name: string;
  /**
   * The stack's name, which goes in the CA's common name. An operator looking
   * at a certificate in `psql`'s error output should be able to tell which of
   * their stacks issued it without opening Pulumi.
   */
  stack: string;
  /**
   * The provider's own internal DNS name for the database node. This is the
   * host in DATABASE_URL and the SAN `checkServerIdentity` compares against,
   * so the two are the same value read from one place — see `databaseHost` in
   * each program's `platform.ts`.
   */
  dnsName: string;
  /**
   * The database node's pinned private address, as a second SAN.
   *
   * Nothing the program writes dials the address, and that is not a style
   * choice: node-postgres sets the TLS `servername` only when `net.isIP(host)`
   * is 0, so an address in DATABASE_URL sends no SNI, Node falls back to
   * comparing the certificate against the literal string `localhost`, and
   * verification fails however many IP SANs the certificate carries. Measured
   * against a real PostgreSQL 18 rather than reasoned about. So the URL names
   * the provider's internal DNS name and only that.
   *
   * The SAN is here for libpq, which does verify one — `psql`, `pg_dump` and
   * `simple-balance-restore`, which is how the backups and any debugging by
   * hand reach this machine: `psql "host=10.20.1.10 sslmode=verify-full"` from
   * the application node works, where without this SAN it would fail
   * verification and read as a broken certificate rather than as a host
   * spelled the other way.
   */
  ipAddress: string;
}

export interface DatabaseCertificates {
  /** Public. Goes to the application node and into the backup script's path. */
  caCertificate: pulumi.Output<string>;
  /** Public. Goes to the database node, bind-mounted into PostgreSQL. */
  serverCertificate: pulumi.Output<string>;
  /** Secret. Goes to the database node and nowhere else. */
  serverKey: pulumi.Output<string>;
}

/**
 * Ten years for the CA and five for the server certificate, in hours, which is
 * the only unit this provider takes.
 *
 * Long deliberately, and the reason is `ignoreChanges`. Both programs ignore
 * changes to the machines' user data, because the alternative is replacing the
 * machine on every release — so a certificate re-issued by a later `pulumi up`
 * would sit in Pulumi's state and never reach either running machine. There is
 * no renewal here that could be automatic, which makes a short lifetime a
 * scheduled outage rather than a security property. Rotation is a by-hand
 * procedure, written down in deploy/pulumi/README.md, and the lifetimes are set
 * so that it is a thing an operator does on purpose rather than a thing that
 * happens to them.
 *
 * 3653 days is ten years with its leap days; 1826 is five with one.
 */
const CA_VALIDITY_HOURS = 3653 * 24;
const SERVER_VALIDITY_HOURS = 1826 * 24;

/**
 * The CA, the server key and the server certificate for one stack's database.
 *
 * The CA's private key is the one value in this profile that exists only in
 * Pulumi's state: it is never written into either machine's user data, because
 * neither machine ever signs anything. That is the whole reason the split is
 * worth making — user data is readable by anyone who can describe the instance,
 * and on both clouds that is a wider set of people than it sounds, so a key
 * that could mint a certificate for this database must not be there.
 *
 * Use a Pulumi backend that encrypts state, which both the service and a
 * passphrase-protected self-managed backend do; `deploy/pulumi/README.md` says
 * so beside this.
 */
export function databaseCertificates(args: DatabaseCertificateArgs): DatabaseCertificates {
  const { name, stack, dnsName, ipAddress } = args;

  const caKey = new tls.PrivateKey(`${name}-db-ca`, {
    algorithm: "ECDSA",
    ecdsaCurve: "P256",
  });

  const ca = new tls.SelfSignedCert(`${name}-db-ca`, {
    privateKeyPem: caKey.privateKeyPem,
    isCaCertificate: true,
    // A CA that may sign end-entity certificates and nothing below them. The
    // default is unlimited, which for a CA whose only job is one server
    // certificate is authority nobody asked for.
    maxPathLength: 0,
    subject: {
      commonName: `Simple Balance ${stack} database CA`,
      organization: "Simple Balance",
    },
    // certSigning is what makes it a CA; crlSigning so a revocation list is
    // possible for an operator who wants one, and digitalSignature because some
    // verifiers refuse a chain whose CA lacks it.
    // snake_case, and it is the provider's spelling rather than a style
    // choice: @pulumi/tls validates this list against Terraform's own enum and
    // refuses "certSigning" outright. Nothing here catches that — the type is
    // string[], so it typechecks, and every source-level assertion passes. It
    // fails at `pulumi preview`, against the real provider, which is why
    // AGENTS.md says to exercise a new surface over a real connection.
    allowedUses: ["cert_signing", "crl_signing", "digital_signature"],
    validityPeriodHours: CA_VALIDITY_HOURS,
  });

  const serverKey = new tls.PrivateKey(`${name}-db`, {
    algorithm: "ECDSA",
    ecdsaCurve: "P256",
  });

  const request = new tls.CertRequest(`${name}-db`, {
    privateKeyPem: serverKey.privateKeyPem,
    subject: { commonName: dnsName, organization: "Simple Balance" },
    // Both SANs, and the common name is not one of them. Every client that
    // matters has ignored the common name for years — Node's own
    // `checkServerIdentity` included — so the DNS name has to appear here as
    // well as in the subject, or verification fails against a certificate that
    // looks right in `openssl x509 -text`.
    dnsNames: [dnsName],
    ipAddresses: [ipAddress],
  });

  const server = new tls.LocallySignedCert(`${name}-db`, {
    certRequestPem: request.certRequestPem,
    caPrivateKeyPem: caKey.privateKeyPem,
    caCertPem: ca.certPem,
    // serverAuth is the extended key usage a PostgreSQL client checks; the
    // other two are what the handshake needs. No clientAuth: this certificate
    // identifies a server, and one that can do both is one that can be replayed
    // as a client somewhere else.
    allowedUses: ["digital_signature", "key_encipherment", "server_auth"],
    validityPeriodHours: SERVER_VALIDITY_HOURS,
  });

  return {
    caCertificate: ca.certPem,
    serverCertificate: server.certPem,
    // Marked secret so it never appears in `pulumi preview`, in a stack output,
    // or in a diff. The provider already marks `privateKeyPem`; saying so again
    // here is what keeps that true if the provider ever stops.
    serverKey: pulumi.secret(serverKey.privateKeyPem),
  };
}
