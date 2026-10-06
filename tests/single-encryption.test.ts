import { describe, expect, it } from "vitest";

import {
  AWS_SINGLE,
  OCI_SINGLE,
  programCode,
  readProgram,
  resourceCalls,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * Encryption at rest and in transit on the machines the `single` profile
 * builds, asserted property by property.
 *
 * This suite exists because there was nothing. Two lines of `encrypted: true`
 * in the AWS program, with no comment and no document, were the whole of the
 * repository's at-rest story, and `docs/standards/operations.md`'s "what is
 * checked, and what is not" table had no row for encryption at all — which by
 * that section's own closing rule made it a rule nobody was responsible for.
 * Every property below is one that can be deleted in a tidy-up without
 * anything failing until somebody audits a deployment.
 *
 * Why a property rather than the provider's word, which is the objection this
 * suite invites. On AWS encryption at rest is *not* a default: EBS encryption by
 * default is an account setting that is off on a fresh account, so the property
 * is the whole guarantee, it shows in `pulumi preview` where a setting does not,
 * and it can be tested, which is what this file is. On Oracle every volume is
 * encrypted at rest and nothing turns that off, so there is no property to hold
 * and what is held instead is the hop between a machine and its disks, which is
 * off unless asked for. `AGENTS.md` draws the line at exactly that place.
 */

const aws = readProgram(AWS_SINGLE);
const oci = readProgram(OCI_SINGLE);

describe("what AWS writes to disk, and what carries it there", () => {
  it("encrypts both data volumes, and asks for gp3 on both", () => {
    const volumes = resourceCallsCode(aws, "aws.ebs.Volume");
    // Two: the application node's backups, secret and CA, and the database
    // node's cluster. One volume covered and not the other would be the ledger
    // in the clear beside encrypted backups of it.
    expect(volumes, "one data volume per machine").toHaveLength(2);
    for (const volume of volumes) {
      expect(volume).toContain("encrypted: true");
      expect(volume).toContain('type: "gp3"');
    }
  });

  it("encrypts both boot disks, which hold the staged CA and every log line", () => {
    const roots = programCode(aws).match(/rootBlockDevice: \{[\s\S]*?\n {4}\},/g) ?? [];
    expect(roots, "one root device per machine").toHaveLength(2);
    for (const root of roots) {
      expect(root).toContain("encrypted: true");
      expect(root).toContain('volumeType: "gp3"');
    }
  });

  it("sets encryption in four places, up from the two that were the whole story", () => {
    // Counted, so that a volume or a machine added later without it fails here
    // rather than in an audit of a running deployment.
    expect(programCode(aws).match(/encrypted: true/g)).toHaveLength(4);
  });

  it("names only Nitro instance families, which is what encrypts the disk hop", () => {
    // EBS traffic between a Nitro instance and an encrypted volume is encrypted
    // in transit by the hypervisor. There is no property for it: the guarantee
    // is the instance family plus `encrypted: true`, together, so a pre-Nitro
    // family added to either table would take it away with nothing failing.
    //
    // Both tables, because the two machines stopped wanting the same shape: one
    // covered and not the other would be the database node — the machine
    // holding the ledger — on whatever family somebody typed.
    const tables = [
      ...programCode(aws).matchAll(
        /const (?:application|database)InstanceTypes: Record<string, string> = \{[\s\S]*?\n\};/g,
      ),
    ].map((match) => match[0]);
    expect(tables, "one instance-type table per machine").toHaveLength(2);
    for (const table of tables) {
      const types = [...table.matchAll(/"([a-z0-9]+)\.[a-z0-9]+"/g)].map((match) => match[1]!);
      expect(types.length, table).toBeGreaterThanOrEqual(3);
      // Every family this profile offers. Graviton throughout, and all of them
      // are Nitro; the list is spelled out rather than pattern-matched because
      // "does this family run on Nitro" is a fact about AWS rather than about
      // its name.
      for (const family of types) expect(["t4g", "m7g", "c7g", "r7g"], family).toContain(family);
    }
  });

  it("leaves the key to AWS unless the stack names one, in one place for all four disks", () => {
    // The default is still the provider's key, and that is the setting worth
    // protecting: it needs no key policy to get wrong, costs nothing a month,
    // and cannot be deleted out from under somebody's ledger. What changed is
    // that a deployment with a key-management policy can now name a key — and
    // the shape of that has to stay exactly this, because `kms_key_id` is
    // Optional+Computed on an EBS volume: one shorthand `kmsKeyId` fed by one
    // `undefined` when unset, never four chances to write `""`, which would
    // diff against the `aws/ebs` ARN AWS fills in and plan a replacement on a
    // stack whose operator set nothing at all.
    expect(programCode(aws)).toMatch(/const kmsKeyId = kmsKeyArn\s*\?\s*aws\.kms/);
    expect(programCode(aws)).toContain(": undefined;");
    expect(
      programCode(aws).match(/^\s+kmsKeyId,$/gm),
      "four disks, one shorthand each",
    ).toHaveLength(4);
    // And nothing anywhere still says the opposite. A sentence kept for a
    // phrase match is how a test goes on passing about a program that changed.
    expect(aws, "the AWS-managed-key note outlived the decision").not.toContain("No `kmsKeyId`");
  });
});

describe("what Oracle Cloud writes to disk, and what carries it there", () => {
  it("turns on in-transit encryption on both instances", () => {
    // OCI leaves this off unless asked, and it is a launch property on a
    // machine the program refuses to replace — so a stack built without it
    // cannot be given it later without rebuilding the machine.
    const instances = resourceCallsCode(oci, "oci.core.Instance");
    expect(instances, "one per machine").toHaveLength(2);
    for (const instance of instances) {
      expect(instance).toContain("isPvEncryptionInTransitEnabled: true");
    }
  });

  it("turns it on again on both volume attachments, which is the other hop", () => {
    // Two flags because they are two hops: the instance's covers its boot
    // volume, the attachment's covers the attached one. Either alone leaves
    // half the machine's disk traffic unencrypted.
    const attachments = resourceCallsCode(oci, "oci.core.VolumeAttachment");
    expect(attachments, "one per machine").toHaveLength(2);
    for (const attachment of attachments) {
      expect(attachment).toContain("isPvEncryptionInTransitEnabled: true");
      // The flag is offered on paravirtualized attachments only, so the two go
      // together and neither may be changed without the other.
      expect(attachment).toContain('attachmentType: "paravirtualized"');
    }
  });

  it("leaves at rest to Oracle's own key unless the stack names one, and says so", () => {
    // OCI encrypts every boot and block volume at rest with an Oracle-managed
    // key and offers no way to turn it off, so a stack that sets nothing is
    // already encrypted at rest and has no vault, no key policy to get wrong,
    // no monthly charge and no way to lock itself out. That claim is the thing
    // this asserts cannot silently stop being made.
    expect(oci).toContain("encrypts every boot and block volume at rest");
    // Both data volumes take the stack's key where it named one, and the same
    // `undefined` where it did not — which is what keeps the sentence above
    // true of a stack that sets nothing.
    const volumes = resourceCalls(oci, "oci.core.Volume");
    expect(volumes, "one data volume per machine").toHaveLength(2);
    for (const volume of volumes) expect(programCode(volume)).toContain("kmsKeyId,");
    expect(programCode(oci)).toMatch(/const kmsKeyId = kmsSelection\s*\?/);
  });
});

describe("the hop between the application and the database", () => {
  it("is verified rather than merely encrypted, on both clouds", () => {
    // `require` encrypts and verifies nothing for libpq, and the backup script
    // reads the same URL the application does. One string, two client
    // libraries, different defaults — so it says what it means.
    const url = readProgram("deploy/pulumi/single-common/cloud-init.ts");
    expect(url).toContain("?sslmode=verify-full&sslrootcert=${APPLICATION_CA_PATH}");
    for (const program of [aws, oci]) {
      expect(program).toContain("databaseUrl(databaseDnsName, password)");
    }
  });

  it("names the database by a DNS name, because node-postgres will not verify an address", () => {
    // `pg` sets the TLS servername only when `net.isIP(host)` is 0, so an
    // address sends no SNI and Node verifies against the literal `localhost`.
    // Measured against a real PostgreSQL 18; the certificate's IP SAN is for
    // libpq, which does verify one, and which is what the backups use.
    for (const program of [aws, oci]) {
      expect(programCode(program)).toContain("const databaseDnsName = databaseHost(");
      // The pinned address is the certificate's second SAN and never the URL's
      // host, so the two uses are visibly different calls.
      expect(programCode(program)).toContain("ipAddress: databasePrivateIp,");
      expect(programCode(program)).not.toMatch(/databaseUrl\(databasePrivateIp/);
    }
  });

  it("keeps the CA's private key off both machines", () => {
    // User data is readable by anyone who can describe the instance, and on
    // both clouds that is a wider set of people than it sounds. A key that
    // could mint a certificate for this database must not be there — which is
    // the whole reason the certificates are signed in the program rather than
    // on the machine.
    const tls = readProgram("deploy/pulumi/single-common/tls.ts");
    const returned = tls.slice(tls.indexOf("return {"));
    expect(returned).toContain("caCertificate: ca.certPem");
    expect(returned).not.toContain("caKey");
    for (const program of [aws, oci]) {
      expect(programCode(program)).not.toContain("caPrivateKey");
    }
  });
});
