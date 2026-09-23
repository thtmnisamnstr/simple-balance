import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import * as aws from "../deploy/pulumi/aws-single/platform.js";
import * as oci from "../deploy/pulumi/oci-single/platform.js";
import {
  AWS_USER_DATA_LIMIT,
  EMBEDDED_FILES,
  OCI_METADATA_LIMIT,
  awsUserDataBase64,
  cloudInit,
  ociMetadata,
  repoFile,
  stripComments,
  type MachineSettings,
  type Size,
} from "../deploy/pulumi/single-common/cloud-init.js";

/**
 * The cloud-init both single-machine programs send, rendered exactly as a
 * `pulumi up` renders it.
 *
 * Every failure here is one a provider or a machine would otherwise report,
 * long after the network and the disk had been built: OCI refusing
 * LaunchInstance for metadata over 32,000 bytes, EC2 refusing user data over
 * 16,384, a script that no longer parses once its comments are gone, a stack's
 * image tag that never reaches the compose file. The programs cannot be
 * imported here — they need `@pulumi/pulumi` from `deploy/pulumi/node_modules`
 * — so what they send is built in modules that can.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * The real table, not a copy of it: the `SIZES` literal out of the program's
 * own source, evaluated. A size added there is rendered here without anybody
 * adding it twice.
 */
const SIZES = (() => {
  const source = read("deploy/pulumi/single-common/index.ts");
  const literal = /export const SIZES: Record<string, Size> = (\{[\s\S]*?\n\});/.exec(source);
  expect(literal, "SIZES in single-common/index.ts").not.toBeNull();
  return new Function(`return (${literal![1]});`)() as Record<string, Size>;
})();

/**
 * Settings as long as a real stack's plausibly get, because the limits are
 * about bytes and a test that measured `example.com` would pass on a document
 * somebody's own hostname pushes over.
 */
function longSettings(sizeName: string): MachineSettings {
  return {
    size: SIZES[sizeName]!,
    sizeName,
    hostname: "household-ledger.accounts.a-rather-long-family-name.example-domain.co.uk",
    acmeEmail: "certificate-renewal-warnings@a-rather-long-family-name.example-domain.co.uk",
    allowedEmails: [
      "*@a-rather-long-family-name.example-domain.co.uk",
      "partner.with.a.long.name@example.com",
      "the-bookkeeper@an-accounting-firm-with-a-long-name.example.com",
      "a-fourth-person-who-helps@example.org",
    ].join(","),
    // A published release other than the pinned one, so the compose check below
    // can tell the stack's tag from the default.
    imageTag: "0.1.5",
    imageRepository:
      "registry.example-organization.example.com/mirrors/thtmnisamnstr/simple-balance",
    timezone: "America/Argentina/ComodRivadavia",
    backupKeep: 365,
  };
}

/** A 4096-bit RSA public key is the longest one people commonly paste. */
const LONG_KEY = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ${"A".repeat(680)} someone@a-long-laptop-hostname.local`;

/** One file cloud-init writes, read back out of the rendered document. */
function writtenFile(document: string, target: string): string {
  const lines = document.split("\n");
  const start = lines.indexOf(`  - path: ${target}`);
  expect(start, `${target} is written`).toBeGreaterThan(-1);
  expect(lines[start + 2]).toBe("    content: |");
  const body: string[] = [];
  for (const line of lines.slice(start + 3)) {
    if (line !== "" && !line.startsWith("      ")) break;
    body.push(line.slice(6));
  }
  // The block scalar clips to one trailing newline, as cloud-init will.
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return `${body.join("\n")}\n`;
}

/**
 * Whether `stripped` is `original` with some comment lines taken out and
 * nothing else changed: every line it has is the original's, in order, and
 * every line it lacks is a comment.
 */
function onlyCommentsRemoved(original: string, stripped: string, comment: RegExp): string[] {
  const kept = stripped.split("\n");
  const problems: string[] = [];
  let at = 0;
  for (const [index, line] of original.split("\n").entries()) {
    if (at < kept.length && kept[at] === line) {
      at += 1;
    } else if (!comment.test(line)) {
      problems.push(`line ${index + 1} was removed and is not a comment: ${line}`);
    }
  }
  if (at !== kept.length)
    problems.push(`line ${at + 1} of the stripped copy is not in the original`);
  return problems;
}

const scratch = mkdtempSync(path.join(tmpdir(), "sb-cloud-init-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Parses a shell script without running it: exit status and complaint. */
function parses(shell: "sh" | "bash", script: string) {
  const file = path.join(scratch, `script-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, script);
  const result = spawnSync(shell, ["-n", file], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

/**
 * The script as bash understands it, with every comment gone: the body of a
 * function, printed back by `declare -f`. Two scripts that differ only in their
 * comments print the same text, and a heredoc or a quoted string that lost a
 * line prints differently — so this is the check that stripping changed no
 * code, made by a shell rather than by the reader that did the stripping.
 */
function canonical(script: string): string {
  return execFileSync(
    "bash",
    ["-c", 'eval "__script() {\n$1\n}"; declare -f __script', "_", script],
    {
      encoding: "utf8",
    },
  );
}

describe("what the single-machine programs send", () => {
  const renders = Object.keys(SIZES).map((sizeName) => ({
    sizeName,
    settings: longSettings(sizeName),
  }));

  it("renders every size in the table", () => {
    expect(Object.keys(SIZES).sort()).toEqual(["large", "medium", "small"]);
  });

  it("fits OCI's metadata ceiling, key and all, as gzip that decodes back to the document", () => {
    for (const { sizeName, settings } of renders) {
      const metadata = oci.instanceMetadata(settings, LONG_KEY);
      const bytes = Buffer.byteLength(JSON.stringify(metadata));
      expect(bytes, `OCI metadata at ${sizeName}`).toBeLessThan(OCI_METADATA_LIMIT);

      const sent = Buffer.from(metadata.user_data!, "base64");
      // The gzip magic number, which is what cloud-init looks for.
      expect([...sent.subarray(0, 2)], sizeName).toEqual([0x1f, 0x8b]);
      expect(gunzipSync(sent).toString("utf8")).toBe(
        cloudInit({
          settings,
          dataDevice: oci.DATA_DEVICE,
          platformCommands: oci.PLATFORM_COMMANDS,
        }),
      );
      expect(metadata.ssh_authorized_keys).toBe(LONG_KEY);
    }
  });

  it("fits EC2's user-data ceiling with a quarter of it to spare", () => {
    for (const { sizeName, settings } of renders) {
      const sent = Buffer.from(aws.userDataBase64(settings, aws.PLACEHOLDER_VOLUME_ID), "base64");
      expect(sent.length, `AWS gzipped user data at ${sizeName}`).toBeLessThanOrEqual(
        AWS_USER_DATA_LIMIT * 0.75,
      );
      expect([...sent.subarray(0, 2)], sizeName).toEqual([0x1f, 0x8b]);
      const document = gunzipSync(sent).toString("utf8");
      expect(document.startsWith("#cloud-config\n")).toBe(true);
      expect(document).toContain(
        `SB_DATA_DEVICE=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${aws.PLACEHOLDER_VOLUME_ID.replace(/-/g, "")}`,
      );
    }
  });

  it("refuses, rather than sends, a document either provider would turn away", () => {
    // Random bytes do not compress, so this is past both ceilings however it
    // is encoded — the shape of an embedded file that has grown too far.
    const incompressible = `#cloud-config\n# ${randomBytes(24_000).toString("base64")}\n`;
    expect(() => ociMetadata(incompressible, LONG_KEY)).toThrow(/OCI accepts fewer than 32000/);
    expect(() => awsUserDataBase64(incompressible)).toThrow(/EC2 accepts 16384/);
  });

  it("puts the stack's image, and only that one, in the compose file", () => {
    const settings = longSettings("small");
    const compose = writtenFile(
      cloudInit({ settings, dataDevice: oci.DATA_DEVICE }),
      "/opt/simple-balance/compose.yml",
    );
    expect(compose).toContain(`image: ${settings.imageRepository}:0.1.5\n`);
    expect(compose).not.toContain("image: ghcr.io/thtmnisamnstr/simple-balance:");
  });

  it("fills in the release when a stack names no tag, in the one place that decides it", () => {
    // `readSingleSettings` needs Pulumi and cannot run here, so this reads it:
    // an unset imageTag has to become the pinned release before the render,
    // which substitutes whatever tag it is given.
    expect(read("deploy/pulumi/single-common/index.ts")).toContain(
      'imageTag: cfg.get("imageTag") || DEFAULT_TAG,',
    );
  });

  it("writes every embedded file as its stripped self, and each one really was stripped", () => {
    const settings = longSettings("small");
    const document = cloudInit({ settings, dataDevice: oci.DATA_DEVICE });
    for (const file of EMBEDDED_FILES) {
      let original = repoFile(file.source);
      if (file.source.endsWith("/compose.yml")) {
        original = original.replace(
          /image: ghcr\.io\/thtmnisamnstr\/simple-balance:\S+/,
          `image: ${settings.imageRepository}:${settings.imageTag}`,
        );
      }
      const stripped = stripComments(original, file.syntax);
      expect(writtenFile(document, file.target), file.source).toBe(
        `${stripped.replace(/\n+$/, "")}\n`,
      );
      // A file the reader refuses is sent whole, which is safe and several
      // times the size. Saying so here is what keeps that from being found by
      // a launch that no longer fits.
      expect(stripped.length, `${file.source} was sent unstripped`).toBeLessThan(original.length);
    }
  });

  it("changes nothing in a stripped file but its comment lines", () => {
    const comment = { shell: /^\s*#/, yaml: /^\s*#/, systemd: /^\s*[#;]/, caddyfile: /^\s*#/ };
    for (const file of EMBEDDED_FILES) {
      const original = repoFile(file.source);
      expect(
        onlyCommentsRemoved(original, stripComments(original, file.syntax), comment[file.syntax]),
        file.source,
      ).toEqual([]);
    }
  });

  it("sends every script as one sh and bash both still parse, meaning what it meant", () => {
    for (const file of EMBEDDED_FILES.filter((entry) => entry.syntax === "shell")) {
      const original = repoFile(file.source);
      const stripped = stripComments(original, "shell");
      expect(stripped.startsWith("#!/bin/sh\n"), `${file.source} keeps its shebang`).toBe(true);
      for (const shell of ["sh", "bash"] as const) {
        expect(parses(shell, stripped), `${shell} -n ${file.source}`).toEqual({
          status: 0,
          stderr: "",
        });
      }
      expect(canonical(stripped), file.source).toBe(canonical(original));
    }
  });

  it("installs the drop-in that makes a restart fold env.local in", () => {
    const document = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
    const dropIn = writtenFile(document, "/etc/systemd/system/simple-balance.service.d/env.conf");
    expect(dropIn).toContain("[Unit]\nRequiresMountsFor=/var/lib/simple-balance\n");
    expect(dropIn).toContain("[Service]\nExecStartPre=/usr/local/sbin/simple-balance-env\n");
    // And the thing it runs is on the machine, at that path.
    expect(EMBEDDED_FILES.map((file) => file.target)).toContain(
      "/usr/local/sbin/simple-balance-env",
    );
    // The header nextSteps points at says the same restart the drop-in makes true.
    expect(document).toMatch(
      /a setting +edit \/var\/lib\/simple-balance\/env\.local, then\n# +sudo systemctl restart simple-balance\n/,
    );
  });
});

describe("the comment stripper, on the cases the deployment files do not have yet", () => {
  const shellKeeps = (script: string, ...lines: string[]) => {
    const stripped = stripComments(script, "shell");
    for (const line of lines) expect(stripped.split("\n"), line).toContain(line);
    expect(canonical(stripped)).toBe(canonical(script));
    return stripped;
  };

  it("removes a shell comment and keeps the shebang", () => {
    expect(stripComments("#!/bin/sh\n# gone\necho hi # stays\n", "shell")).toBe(
      "#!/bin/sh\necho hi # stays\n",
    );
  });

  it("keeps every line of a heredoc, quoted or not, tab-stripped or not", () => {
    const stripped = shellKeeps(
      "#!/bin/sh\n# gone\ncat <<'A' <<EOF\n# in A\nA\n# in EOF\nEOF\ncat <<-TABS\n\t# in TABS\n\tTABS\n# gone too\n",
      "# in A",
      "# in EOF",
      "\t# in TABS",
    );
    expect(stripped).not.toContain("# gone");
  });

  it("keeps lines inside a quoted string that spans them", () => {
    shellKeeps(
      "#!/bin/sh\necho 'one\n# in single\n'\necho \"two\n# in double $(date)\n\"\n# gone\n",
      "# in single",
      "# in double $(date)",
    );
  });

  it("keeps a comment that ends a command continued onto its line", () => {
    shellKeeps("#!/bin/sh\necho a \\\n# ends the echo\necho b\n", "# ends the echo");
  });

  it("keeps a comment line inside a command substitution that spans lines", () => {
    shellKeeps('#!/bin/sh\nx=$(\n# inside\necho a)\necho "$x"\n', "# inside");
  });

  it("reads ${x#y}, $# and a quote inside a trailing comment as code and comment", () => {
    const stripped = stripComments(
      '#!/bin/sh\necho "${1##*/}" $# # it\'s fine\n# gone\necho done\n',
      "shell",
    );
    expect(stripped).toBe('#!/bin/sh\necho "${1##*/}" $# # it\'s fine\necho done\n');
  });

  it("sends a script it cannot follow to the end exactly as it was", () => {
    for (const script of [
      "#!/bin/sh\n# comment\necho 'never closed\n",
      "#!/bin/sh\n# comment\ncat <<<here\n",
      "#!/bin/sh\n# comment\ncat <<EOF\nno terminator\n",
    ]) {
      expect(stripComments(script, "shell")).toBe(script);
    }
  });

  it("keeps a YAML block scalar's lines, # or not, and strips around it", () => {
    const yaml = [
      "# gone",
      "a:",
      "  script: |",
      "    # kept, it is content",
      "",
      "    echo hi",
      "  folded: >-",
      "    # also content",
      "  # gone, the scalar has ended",
      "  b: 1",
      "",
    ].join("\n");
    expect(stripComments(yaml, "yaml")).toBe(
      [
        "a:",
        "  script: |",
        "    # kept, it is content",
        "",
        "    echo hi",
        "  folded: >-",
        "    # also content",
        "  b: 1",
        "",
      ].join("\n"),
    );
  });

  it("sends YAML with a value spanning lines exactly as it was", () => {
    for (const yaml of [
      '# c\na: "starts here\n  # inside the string\n  ends here"\n',
      "# c\na: plain starts\n  # a comment inside a plain scalar\n  continues\n",
      "# c\na: [one,\n  # inside\n  two]\n",
      // Continuations that look like nodes, so only the quote and the bracket
      // give them away.
      '# c\na: "starts here\n  - an item?\n  # inside the string\n  b: ends"\n',
      "# c\na: [one,\n  # inside\n  - two]\n",
    ]) {
      expect(stripComments(yaml, "yaml")).toBe(yaml);
    }
  });

  it("strips both kinds of systemd comment, and leaves a continued unit alone", () => {
    expect(stripComments("# a\n; b\n[Unit]\nDescription=x\n", "systemd")).toBe(
      "[Unit]\nDescription=x\n",
    );
    const continued = "# a\n[Service]\nExecStart=/bin/echo \\\n  two\n";
    expect(stripComments(continued, "systemd")).toBe(continued);
  });

  it("leaves a Caddyfile with a heredoc or a backtick token alone", () => {
    expect(stripComments("# a\n:80 {\n\trespond 1\n}\n", "caddyfile")).toBe(
      ":80 {\n\trespond 1\n}\n",
    );
    for (const caddyfile of [
      "# a\n:80 {\n\trespond <<HTML\n# inside\nHTML 200\n}\n",
      "# a\n:80 {\n\trespond `one\n# inside\n` 200\n}\n",
    ]) {
      expect(stripComments(caddyfile, "caddyfile")).toBe(caddyfile);
    }
  });
});

describe("the Oracle Cloud program's own decisions", () => {
  it("never asks OCI for a data volume under its 50 GB floor", () => {
    for (const [name, size] of Object.entries(SIZES)) {
      expect(oci.dataVolumeGb(size), name).toBe(Math.max(size.dataGib, 50));
    }
    expect(oci.dataVolumeGb(SIZES.small!)).toBe(50);
    // And the volume is sized by it, not by the shared table directly.
    const program = read("deploy/pulumi/oci-single/index.ts");
    expect(program).toContain("const dataGb = dataVolumeGb(size);");
    expect(program).toContain("sizeInGbs: String(dataGb),");
    expect(program).not.toMatch(/sizeInGbs: String\(size\.dataGib\)/);
  });

  it("builds in the availability domain asked for, by name or number, and refuses a stranger", () => {
    const domains = ["Uocm:US-ASHBURN-AD-1", "Uocm:US-ASHBURN-AD-2", "Uocm:US-ASHBURN-AD-3"];
    expect(oci.chooseAvailabilityDomain(domains, "")).toBe(domains[0]);
    expect(oci.chooseAvailabilityDomain(domains, "2")).toBe(domains[1]);
    expect(oci.chooseAvailabilityDomain(domains, " Uocm:US-ASHBURN-AD-3 ")).toBe(domains[2]);
    expect(() => oci.chooseAvailabilityDomain(domains, "4")).toThrow(/1 \(Uocm:US-ASHBURN-AD-1\)/);
    expect(() => oci.chooseAvailabilityDomain(domains, "0")).toThrow(/none of this region's/);
    expect(() => oci.chooseAvailabilityDomain(domains, "AD-2")).toThrow(/none of this region's/);
    expect(() => oci.chooseAvailabilityDomain([], "")).toThrow(/No availability domain/);
  });

  it("refuses a stack with no SSH key, the only way onto the machine", () => {
    expect(() => oci.requireSshPublicKey("")).toThrow(/sshPublicKey is required on Oracle Cloud/);
    expect(() => oci.requireSshPublicKey(LONG_KEY)).not.toThrow();
    expect(read("deploy/pulumi/oci-single/index.ts")).toContain(
      "requireSshPublicKey(settings.sshPublicKey);",
    );
  });

  it("opens 22 to its own subnet for a Bastion, enables the plugin, and leaves metadata alone", () => {
    const program = read("deploy/pulumi/oci-single/index.ts");
    expect(program).toMatch(
      /description: "SSH, from a Bastion in this subnet",\s+source: instanceCidr,[\s\S]{0,120}tcpOptions: \{ min: 22, max: 22 \}/,
    );
    expect(program).toContain('pluginsConfigs: [{ name: "Bastion", desiredState: "ENABLED" }]');
    expect(program).toContain('ignoreChanges: ["sourceDetails", "metadata"]');
  });
});

/**
 * The constructor call that builds one resource, from `new <kind>(` to the
 * `);` that closes it at the start of a line, which is how both programs lay
 * out a call with options.
 */
function resourceCall(program: string, kind: string): string {
  const start = program.indexOf(`new ${kind}(`);
  expect(start, kind).toBeGreaterThan(-1);
  expect(program.indexOf(`new ${kind}(`, start + 1), `one ${kind}`).toBe(-1);
  return program.slice(start, program.indexOf("\n);\n", start));
}

describe("what replacing a single machine does to its data volume", () => {
  // A new instance forces a new attachment, and Pulumi builds a replacement
  // before removing what it replaces unless told otherwise. Neither cloud
  // attaches a volume that is still attached elsewhere, so that order fails
  // the documented replacement with two machines and the volume on the old one.
  for (const [program, attachment] of [
    ["deploy/pulumi/aws-single/index.ts", "aws.ec2.VolumeAttachment"],
    ["deploy/pulumi/oci-single/index.ts", "oci.core.VolumeAttachment"],
  ] as const) {
    it(`${program} detaches the volume from the old machine before attaching it`, () => {
      expect(resourceCall(read(program), attachment)).toMatch(
        /\n {2}\{\n(?: {4}.*\n)*? {4}deleteBeforeReplace: true,\n {2}\},$/,
      );
    });
  }

  it("moves AWS's address after the volume, not as soon as the new machine exists", () => {
    const program = read("deploy/pulumi/aws-single/index.ts");
    expect(program).toContain("const attachment = new aws.ec2.VolumeAttachment(");
    const association = resourceCall(program, "aws.ec2.EipAssociation");
    expect(association).toContain("    deleteBeforeReplace: true,\n");
    expect(association).toContain("    dependsOn: [attachment],\n");
  });
});

describe("what the programs tell a person to do next", () => {
  for (const program of [
    "deploy/pulumi/oci-single/index.ts",
    "deploy/pulumi/aws-single/index.ts",
  ]) {
    it(`${program} gives the machine a database before looking for the setup code`, () => {
      const text = read(program);
      const steps = text.slice(text.indexOf("export const nextSteps"));
      const database = steps.indexOf("DATABASE_URL=");
      const setupCode = steps.indexOf("Find the setup code");
      expect(database, "a DATABASE_URL step").toBeGreaterThan(-1);
      expect(database, "before the setup code").toBeLessThan(setupCode);
      expect(steps).toContain("sudo /usr/local/sbin/simple-balance-firstboot");
      // The first start is firstboot and not a restart, which would leave the
      // backup timer waiting for a reboot and /etc/motd saying nothing runs.
      expect(steps).not.toContain("once it has run");
      expect(steps).toMatch(/firstboot\n\s+which starts the deployment and its nightly backup/);
      // A later setting is an edit and a restart, which the drop-in makes true.
      expect(steps).toMatch(
        /env\.local, which[\s\S]{0,120}a setting is an edit to it, then\n\s+sudo systemctl restart simple-balance\./,
      );
    });

    it(`${program} names the settings a pooled database and AdSense cannot start without`, () => {
      const text = read(program);
      const steps = text.slice(text.indexOf("export const nextSteps"));
      expect(steps).toMatch(/transaction pooler, DIRECT_DATABASE_URL beside it/);
      expect(steps).toMatch(/AdSense and the PRIVACY_POLICY_URL it requires/);
    });

    it(`${program} points at a header a person can read, and all of it`, () => {
      // user-data.txt is the gzip the program sent, so the file a person would
      // open is binary. `cloud-init query` decompresses it.
      const text = read(program);
      const steps = text.slice(text.indexOf("export const nextSteps"));
      expect(steps).not.toContain("user-data.txt");
      const document = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
      const lines = document.split("\n");
      const header = lines.findIndex((line) => !line.startsWith("#"));
      expect(lines[header], "the header ends where the configuration starts").toMatch(
        /^timezone: /,
      );
      expect(steps).toContain(`sudo cloud-init query userdata | head -${header}\n`);
    });
  }

  it("sends the OCI reader of the sshCidr branch somewhere that has the Bastion commands", () => {
    const text = read("deploy/pulumi/oci-single/index.ts");
    const reach = text.slice(text.indexOf("const reach = settings.sshCidr"));
    const sshBranch = reach.slice(0, reach.indexOf("\n  : pulumi.interpolate"));
    expect(sshBranch).not.toMatch(/\bbelow\b/);
    expect(sshBranch).toContain('"Reaching the Oracle Cloud machine" in deploy/pulumi/README.md');
    expect(read("deploy/pulumi/README.md")).toContain("\n### Reaching the Oracle Cloud machine\n");
  });
});
