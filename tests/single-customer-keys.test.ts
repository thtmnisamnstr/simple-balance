import { describe, expect, it } from "vitest";

import type { KmsKeyFacts } from "../deploy/pulumi/aws-single/platform.js";
import {
  requireNewStackForKmsKey,
  requireUsableKmsKey as requireUsableAwsKey,
} from "../deploy/pulumi/aws-single/platform.js";
import type { OciKeyFacts } from "../deploy/pulumi/oci-single/platform.js";
import {
  hsmKeyWarning,
  readKmsSelection,
  requireUsableKmsKey as requireUsableOciKey,
} from "../deploy/pulumi/oci-single/platform.js";
import {
  AWS_SINGLE,
  OCI_SINGLE,
  programCode,
  readProgram,
  resourceCallsCode,
} from "./support/pulumi-source.js";

/**
 * The customer-managed key, which is the one setting in this profile that can
 * make somebody's ledger permanently unreadable.
 *
 * `tests/single-encryption.test.ts` holds the at-rest story: that every volume
 * on both clouds is encrypted, and that unset means the provider's own key,
 * which is already encryption at rest and needs no vault, no policy and no
 * monthly charge. This file holds the half that arrived with the setting: that
 * a key is *accepted* and never created, that an unusable one is refused at
 * plan time rather than at the reboot weeks later, and that a stack which sets
 * nothing passes `undefined` rather than an empty string.
 *
 * Why refusing early is the whole of the guard on AWS, in one sentence AWS
 * writes itself: a disabled or pending-deletion key has no effect on a running
 * instance, because EBS encrypts disk I/O with the data key in the Nitro card —
 * the failure lands on the next detach and reattach, which may be after the
 * deletion window has closed, and then the volume is unreadable by anybody
 * including its owner.
 */

const aws = programCode(readProgram(AWS_SINGLE));
const oci = programCode(readProgram(OCI_SINGLE));

const USABLE: KmsKeyFacts = {
  keyState: "Enabled",
  keyManager: "CUSTOMER",
  keySpec: "SYMMETRIC_DEFAULT",
  keyUsage: "ENCRYPT_DECRYPT",
};
const ARN = "arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

function awsRefusal(facts: Partial<KmsKeyFacts>): string {
  try {
    requireUsableAwsKey(ARN, { ...USABLE, ...facts });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`requireUsableKmsKey(${JSON.stringify(facts)}) did not refuse`);
}

describe("the AWS key, checked before a volume is made with it", () => {
  it("passes a key EBS can use", () => {
    expect(requireUsableAwsKey(ARN, USABLE)).toBe(ARN);
  });

  it("refuses a key that is disabled or on its way out, and says how to bring it back", () => {
    // The state that costs nothing to fix now and cannot be fixed at all once
    // the window closes.
    for (const state of ["Disabled", "PendingDeletion", "Unavailable"]) {
      const message = awsRefusal({ keyState: state });
      expect(message, state).toContain(state);
      expect(message, state).toContain("cancel-key-deletion");
      expect(message, state).toContain("enable-key");
    }
  });

  it("refuses an AWS-managed key, because naming one is what unsetting already does", () => {
    const message = awsRefusal({ keyManager: "AWS" });
    expect(message).toContain("alias/aws/ebs");
    expect(message).toContain("pulumi config rm simple-balance:kmsKeyArn");
  });

  it("refuses an asymmetric key, which EBS does not take", () => {
    expect(awsRefusal({ keySpec: "RSA_4096" })).toContain("symmetric");
    expect(awsRefusal({ keyUsage: "SIGN_VERIFY" })).toContain("ENCRYPT_DECRYPT");
  });

  /**
   * The one path from a single line of configuration to a destroyed ledger, and
   * the reason the guard cannot be built on Pulumi's own protection.
   *
   * `kms_key_id` is ForceNew on an EBS volume, so naming a key on a stack whose
   * volumes exist plans a *replacement*. `protect` refuses that — which is why
   * it is the default — but `protect` is a flag in the **state snapshot** and
   * `simple-balance:protectDataVolume` is a flag in the **config**, and the two
   * come apart: `pulumi state unprotect <urn>` is this repository's own
   * documented way to let one destroy through, and it leaves the config saying
   * `true`. A guard that read the config would return happily in exactly the
   * state where Pulumi goes ahead. `protectDataVolume: false` was one of two
   * dangerous states, not the only one.
   *
   * So the refusal asks the question that decides the outcome — do these
   * volumes exist? — of the one party that knows.
   */
  it("refuses a key until the stack says the volumes do not exist yet", () => {
    expect(() => requireNewStackForKmsKey(ARN, true)).not.toThrow();
    expect(() => requireNewStackForKmsKey("", false)).not.toThrow();
    let message = "";
    try {
      requireNewStackForKmsKey(ARN, false);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("fixed when the volume is created");
    // Both ways the protection can be off, because naming only the config one
    // is what made the previous guard a false guarantee.
    expect(message).toContain("pulumi state unprotect");
    expect(message).toContain("simple-balance:protectDataVolume");
    expect(message).toContain("pulumi config set simple-balance:kmsKeyArnIsNewStack true");
    // The migration is a snapshot copy and is deliberately not a `pulumi up`:
    // AWS states plainly that an existing volume's key cannot be changed and
    // that a copy is the only way to carry data onto another one.
    expect(message).toContain("copy-snapshot --kms-key-id");
    expect(message).toContain("none of it is a pulumi up");
  });

  /**
   * And that the acknowledgement is a setting an existing stack can ignore.
   *
   * Every deployment in the field sets no `kmsKeyArn`, so the guard returns on
   * its first line and the new setting changes nothing about what a `pulumi up`
   * plans — which is the release rule this whole setting is most at risk of
   * breaking.
   */
  it("is inert on every stack that names no key", () => {
    for (const acknowledged of [true, false]) {
      expect(() => requireNewStackForKmsKey("", acknowledged)).not.toThrow();
      expect(() => requireNewStackForKmsKey("   ", acknowledged)).not.toThrow();
    }
  });
});

describe("the Oracle Cloud key, which needs its vault to be checked at all", () => {
  const usable: OciKeyFacts = { state: "ENABLED", algorithm: "AES", protectionMode: "SOFTWARE" };

  it("takes both settings or neither, and refuses half a configuration", () => {
    expect(readKmsSelection("", "")).toBeUndefined();
    expect(readKmsSelection(" ocid1.vault.x ", " ocid1.key.y ")).toEqual({
      vaultId: "ocid1.vault.x",
      keyId: "ocid1.key.y",
    });
    // The vault is not a second thing to guess: every Key Management call goes
    // to that vault's own management endpoint, so a key OCID alone cannot even
    // be looked up, let alone checked.
    expect(() => readKmsSelection("ocid1.vault.x", "")).toThrow(/kmsKeyOcid is not/);
    expect(() => readKmsSelection("", "ocid1.key.y")).toThrow(/kmsVaultOcid is not/);
  });

  it("refuses a key in pending deletion, which makes its volumes unreadable at once", () => {
    // The opposite failure to AWS's, and louder: on this cloud a scheduled key
    // takes effect immediately rather than at the next detach.
    const message = (() => {
      try {
        requireUsableOciKey("ocid1.key.y", { ...usable, state: "PENDING_DELETION" });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).toContain("PENDING_DELETION");
    expect(message).toContain("inaccessible");
  });

  it("refuses an RSA key, which the Block Volume service does not encrypt with", () => {
    expect(() => requireUsableOciKey("ocid1.key.y", { ...usable, algorithm: "RSA" })).toThrow(
      /AES keys only/,
    );
    expect(requireUsableOciKey("ocid1.key.y", usable)).toBe("ocid1.key.y");
  });

  it("warns about an HSM key rather than refusing it, because it is billed and permanent", () => {
    // `protectionMode` cannot be changed after a key is created and HSM key
    // versions are billed where software ones are not, so an Always Free stack
    // that was $0 stops being $0 with no way back but a different key. A
    // warning rather than a refusal: an operator may want HSM, and refusing
    // would be making somebody's compliance decision for them.
    expect(hsmKeyWarning(usable)).toBeUndefined();
    const warning = hsmKeyWarning({ ...usable, protectionMode: "HSM" });
    expect(warning).toContain("billed per");
    expect(warning).toContain("cannot be changed");
    expect(warning).toContain("SOFTWARE");
  });
});

describe("what each program does with the key, and what it does without one", () => {
  it("accepts a key and never creates one, on either cloud", () => {
    // A key this program made would have the stack's lifetime, and that is the
    // wrong lifetime for the thing that decrypts a ledger: `pulumi destroy
    // --exclude-protected` keeps both data volumes on purpose and would leave
    // them beside a key counting down to unrecoverable. On OCI it is worse,
    // because a key needs a vault and deleting a vault schedules every key in
    // it.
    expect(aws, "no aws.kms resource").not.toMatch(/new aws\.kms\./);
    expect(oci, "no oci.kms resource").not.toMatch(/new oci\.kms\./);
    // Only the lookups, which read and create nothing.
    expect(aws).toContain("aws.kms.getKeyOutput({ keyId: kmsKeyArn })");
    expect(oci).toContain("oci.kms.getVaultOutput({ vaultId: kmsSelection.vaultId })");
  });

  it("gives the key to every encrypted disk on AWS, and to none of them when unset", () => {
    for (const volume of resourceCallsCode(readProgram(AWS_SINGLE), "aws.ebs.Volume")) {
      expect(volume).toContain("encrypted: true");
      expect(volume).toContain("kmsKeyId,");
    }
    const roots = aws.match(/rootBlockDevice: \{[\s\S]*?\n {4}\},/g) ?? [];
    expect(roots, "one root device per machine").toHaveLength(2);
    for (const root of roots) expect(root).toContain("kmsKeyId,");
    // Shorthand, so all four take the same value and the unset case is one
    // `undefined` rather than four chances to write `""`. That distinction is
    // load-bearing: `kms_key_id` is Optional+Computed on an EBS volume, so an
    // empty string would diff against the `aws/ebs` ARN AWS fills in and plan a
    // replacement on a stack whose operator set nothing at all.
    expect(aws).toMatch(/const kmsKeyId = kmsKeyArn\s*\?\s*aws\.kms/);
    expect(aws).toContain(": undefined;");
  });

  it("gives the key to every encrypted disk on Oracle Cloud, boot volumes included", () => {
    for (const volume of resourceCallsCode(readProgram(OCI_SINGLE), "oci.core.Volume")) {
      expect(volume).toContain("kmsKeyId,");
    }
    const sources = oci.match(/sourceDetails: \{[\s\S]*?\n {4,12}\},/g) ?? [];
    expect(sources, "one boot volume per machine").toHaveLength(2);
    for (const source of sources) expect(source).toContain("kmsKeyId,");
  });

  /**
   * The silent half, and the reason it would have been silent.
   *
   * `ignoreChanges` on a parent ignores everything under it, so
   * `["sourceDetails", "metadata"]` would swallow a `kmsKeyId` added to a stack
   * that already exists while a fresh stack took it — the same configuration,
   * different encryption, and nothing said. The two properties named instead
   * are exactly the two that used to move on their own: the image, which
   * Canonical rebuilds every few weeks, and the boot volume's size.
   */
  it("ignores the properties that drift on OCI rather than the object holding the key", () => {
    const ignores = [...oci.matchAll(/ignoreChanges: \[([^\]]*)\]/g)].map((match) => match[1]!);
    expect(ignores, "one per instance").toHaveLength(2);
    for (const ignore of ignores) {
      expect(ignore).toContain('"sourceDetails.sourceId"');
      expect(ignore).toContain('"sourceDetails.bootVolumeSizeInGbs"');
      expect(ignore).toContain('"metadata"');
      expect(ignore, "never the whole object").not.toMatch(/"sourceDetails"/);
    }
  });

  it("refuses before any disk is registered, which is what --skip-preview needs", () => {
    // Two refusals with two different reaches, and saying so is the point.
    //
    // The *settings* refusal is synchronous and above every `new`, so no
    // resource at all exists when it throws. The *usability* refusal is not: it
    // is an Output from a DescribeKey, consumed as each encrypted resource's
    // own input, so under `pulumi up --skip-preview` the engine builds the VPC,
    // the subnets, the Elastic IP and the gateway while that call is still in
    // flight, and the run fails at the first volume. Nothing the key would
    // encrypt is created while it is unresolved — which is the honest claim,
    // and narrower than "nothing at all", which is what three documents used to
    // say.
    for (const [cloud, program, first] of [
      ["aws", aws, aws.indexOf("new aws.")],
      ["oci", oci, oci.indexOf("new oci.")],
    ] as const) {
      const read = program.indexOf(cloud === "aws" ? 'cfg.get("kmsKeyArn")' : "readKmsSelection(");
      expect(read, `${cloud} reads the key setting`).toBeGreaterThan(-1);
      expect(read, `${cloud} reads it before the first resource`).toBeLessThan(first);
    }
    expect(aws.indexOf("requireNewStackForKmsKey(")).toBeLessThan(aws.indexOf("new aws."));
  });
});
