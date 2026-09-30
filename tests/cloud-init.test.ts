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
  APPLICATION_CA_PATH,
  APP_FILES,
  AWS_USER_DATA_LIMIT,
  DATABASE_FILES,
  OCI_METADATA_LIMIT,
  PLACEHOLDER_CERTIFICATE,
  PLACEHOLDER_KEY,
  PLACEHOLDER_PASSWORD,
  SERVER_CERTIFICATE_PATH,
  SERVER_KEY_PATH,
  awsUserDataBase64,
  cloudInit,
  databaseCloudInit,
  databaseUrl,
  ociMetadata,
  repoFile,
  stripComments,
  type DatabaseSettings,
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

/**
 * What the database node is told, at each size. `maxConnections` is the
 * setting's own default; the five PostgreSQL numbers come from the row.
 */
function longDatabase(sizeName: string): DatabaseSettings {
  return { size: SIZES[sizeName]!, sizeName, maxConnections: 50, password: "" };
}

/**
 * Everything the database node's render needs beyond its settings, with the
 * program's own stand-ins for the three values Pulumi generates.
 *
 * The stand-ins rather than made-up shorter ones, because the point of every
 * measurement below is the size of the document and those are the values the
 * programs measure with — a test that used `"password"` and a two-line
 * certificate would report a comfortable margin the real render does not have.
 */
function longDatabaseRender(sizeName: string) {
  return {
    settings: longSettings(sizeName),
    database: longDatabase(sizeName),
    bindAddress: "10.30.1.10",
    applicationCidr: "10.30.0.0/24",
    applicationPassword: PLACEHOLDER_PASSWORD,
    serverCertificate: PLACEHOLDER_CERTIFICATE,
    serverKey: PLACEHOLDER_KEY,
  };
}

/** The other half: what the application node is told about that database. */
function longApplicationDatabase(host = "db.db.simplebalance.oraclevcn.com") {
  return {
    url: databaseUrl(host, PLACEHOLDER_PASSWORD),
    caCertificate: PLACEHOLDER_CERTIFICATE,
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

/** The mode cloud-init is told to create a file with. */
function writtenPermissions(document: string, target: string): string {
  const lines = document.split("\n");
  const start = lines.indexOf(`  - path: ${target}`);
  expect(start, `${target} is written`).toBeGreaterThan(-1);
  return /^ {4}permissions: "(.*)"$/.exec(lines[start + 1] ?? "")?.[1] ?? "";
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
      // With the database node's connection string and CA certificate in it,
      // which is the larger of the two documents and the one this profile now
      // sends. Measured without them, the check would pass on a deployment
      // nobody builds and say nothing about the one everybody does.
      const sent = Buffer.from(
        aws.userDataBase64(settings, aws.PLACEHOLDER_VOLUME_ID, longApplicationDatabase()),
        "base64",
      );
      expect(sent.length, `AWS gzipped user data at ${sizeName}`).toBeLessThanOrEqual(
        AWS_USER_DATA_LIMIT * 0.75,
      );
      expect([...sent.subarray(0, 2)], sizeName).toEqual([0x1f, 0x8b]);
      const document = gunzipSync(sent).toString("utf8");
      expect(document.startsWith("#cloud-config\n")).toBe(true);
      expect(document).toContain(
        `SB_DATA_DEVICE=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${aws.PLACEHOLDER_VOLUME_ID.replace(/-/g, "")}`,
      );
      // And without one, which is what simple-balance:databaseNode false sends.
      const bare = Buffer.from(aws.userDataBase64(settings, aws.PLACEHOLDER_VOLUME_ID), "base64");
      expect(
        bare.length,
        `AWS gzipped user data at ${sizeName}, no database node`,
      ).toBeLessThanOrEqual(AWS_USER_DATA_LIMIT * 0.75);
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
    for (const file of APP_FILES) {
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
    const comment = {
      shell: /^\s*#/,
      yaml: /^\s*#/,
      systemd: /^\s*[#;]/,
      caddyfile: /^\s*#/,
      hash: /^\s*#/,
    };
    for (const file of [...APP_FILES, ...DATABASE_FILES]) {
      const original = repoFile(file.source);
      expect(
        onlyCommentsRemoved(original, stripComments(original, file.syntax), comment[file.syntax]),
        file.source,
      ).toEqual([]);
    }
  });

  it("sends every script as one sh and bash both still parse, meaning what it meant", () => {
    const shellFiles = [...APP_FILES, ...DATABASE_FILES].filter(
      (entry) => entry.syntax === "shell",
    );
    for (const file of shellFiles) {
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

  it("runs every compose file it sends, the certificate's overlay included", () => {
    // COMPOSE_FILE is the only thing that makes an overlay part of the
    // deployment. The certificate's is an overlay so a hand install without
    // the directory still starts; these machines always have the directory,
    // made by firstboot on the data volume, so an overlay sent and not named
    // here is a DATABASE_URL naming a file the application cannot see.
    const document = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
    const defaults = writtenFile(document, "/etc/default/simple-balance");
    const named = /^COMPOSE_FILE=(.*)$/m.exec(defaults)?.[1]?.split(":");
    expect(named).toEqual(["compose.yml", "compose.caddy.yml", "compose.db-tls.yml"]);
    const sent = APP_FILES.map((file) => file.target)
      .filter((target) => /^\/opt\/simple-balance\/compose[\w.-]*\.yml$/.test(target))
      .map((target) => path.basename(target));
    expect([...sent].sort()).toEqual([...named!].sort());
  });

  it("installs the drop-in that makes a restart fold env.local in", () => {
    const document = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
    const dropIn = writtenFile(document, "/etc/systemd/system/simple-balance.service.d/env.conf");
    expect(dropIn).toContain("[Unit]\nRequiresMountsFor=/var/lib/simple-balance\n");
    expect(dropIn).toContain("[Service]\nExecStartPre=/usr/local/sbin/simple-balance-env\n");
    // And the thing it runs is on the machine, at that path.
    expect(APP_FILES.map((file) => file.target)).toContain("/usr/local/sbin/simple-balance-env");
    // The header nextSteps points at says the same restart the drop-in makes true.
    expect(document).toMatch(
      /a setting +edit \/var\/lib\/simple-balance\/env\.local, then\n# +sudo systemctl restart simple-balance\n/,
    );
  });
});

describe("what the programs send the database machine", () => {
  const renders = Object.keys(SIZES).map((sizeName) => ({
    sizeName,
    args: longDatabaseRender(sizeName),
  }));

  it("fits both providers' ceilings at every size, with a quarter of EC2's to spare", () => {
    for (const { sizeName, args } of renders) {
      const metadata = oci.databaseInstanceMetadata(args, LONG_KEY);
      expect(
        Buffer.byteLength(JSON.stringify(metadata)),
        `OCI metadata at ${sizeName}`,
      ).toBeLessThan(OCI_METADATA_LIMIT);

      const sent = Buffer.from(
        aws.databaseUserDataBase64(args, aws.PLACEHOLDER_VOLUME_ID),
        "base64",
      );
      expect(sent.length, `AWS gzipped user data at ${sizeName}`).toBeLessThanOrEqual(
        AWS_USER_DATA_LIMIT * 0.75,
      );
      expect([...sent.subarray(0, 2)], sizeName).toEqual([0x1f, 0x8b]);
      expect(gunzipSync(sent).toString("utf8").startsWith("#cloud-config\n")).toBe(true);
    }
  });

  it("writes every embedded file as its stripped self", () => {
    const document = databaseCloudInit({ ...longDatabaseRender("small"), dataDevice: "/dev/sdx" });
    for (const file of DATABASE_FILES) {
      const original = repoFile(file.source);
      const stripped = stripComments(original, file.syntax);
      expect(writtenFile(document, file.target), file.source).toBe(
        `${stripped.replace(/\n+$/, "")}\n`,
      );
      expect(stripped.length, `${file.source} was sent unstripped`).toBeLessThan(original.length);
    }
  });

  it("runs every compose file it sends, and sends every one it runs", () => {
    // The same rule as the application node's, and it matters more here: this
    // machine's COMPOSE_FILE is one entry, so a second compose file sent and
    // not named would be a file nobody ever reads, and a name with no file
    // behind it stops `docker compose up` before PostgreSQL exists.
    const document = databaseCloudInit({ ...longDatabaseRender("small"), dataDevice: "/dev/sdx" });
    const defaults = writtenFile(document, "/etc/default/simple-balance");
    const named = /^COMPOSE_FILE=(.*)$/m.exec(defaults)?.[1]?.split(":");
    expect(named).toEqual(["compose.postgres.yml"]);
    const sent = DATABASE_FILES.map((file) => file.target)
      .filter((target) => /^\/opt\/simple-balance\/compose[\w.-]*\.yml$/.test(target))
      .map((target) => path.basename(target));
    expect([...sent].sort()).toEqual([...named!].sort());
  });

  it("carries the server's key and certificate, and neither the CA's key nor AUTH_SECRET", () => {
    const document = databaseCloudInit({ ...longDatabaseRender("small"), dataDevice: "/dev/sdx" });
    expect(writtenFile(document, SERVER_CERTIFICATE_PATH)).toBe(PLACEHOLDER_CERTIFICATE);
    expect(writtenFile(document, SERVER_KEY_PATH)).toBe(PLACEHOLDER_KEY);
    // PostgreSQL refuses a key anyone but its own user can read, and
    // simple-balance-db-firstboot cannot loosen what cloud-init made tighter,
    // so the mode starts where it has to end up.
    expect(writtenPermissions(document, SERVER_KEY_PATH)).toBe("0600");
    expect(writtenPermissions(document, SERVER_CERTIFICATE_PATH)).toBe("0644");
    // The secret this machine has no business holding. AUTH_SECRET is generated
    // on the application node and kept on its data volume; a copy here would be
    // a copy in instance metadata, which anyone who can describe the instance
    // can read.
    expect(document).not.toContain("AUTH_SECRET");
    // And the credential the application node needs, which this machine is told
    // so that initdb can create the role — under the name db-firstboot folds.
    expect(writtenFile(document, "/opt/simple-balance/env.db")).toBe(
      `POSTGRES_APP_PASSWORD=${PLACEHOLDER_PASSWORD}\n`,
    );
    expect(writtenPermissions(document, "/opt/simple-balance/env.db")).toBe("0600");
  });

  it("applies the sizing table's five PostgreSQL numbers, and the connection ceiling", () => {
    for (const [sizeName, size] of Object.entries(SIZES)) {
      const base = writtenFile(
        databaseCloudInit({ ...longDatabaseRender(sizeName), dataDevice: "/dev/sdx" }),
        "/opt/simple-balance/env.base",
      );
      // Read by compose.postgres.yml as `-c` flags. They were dead numbers in
      // the sizing table until this profile owned a database to apply them to.
      expect(base, sizeName).toContain(`POSTGRES_SHARED_BUFFERS=${size.sharedBuffers}\n`);
      expect(base, sizeName).toContain(
        `POSTGRES_EFFECTIVE_CACHE_SIZE=${size.effectiveCacheSize}\n`,
      );
      expect(base, sizeName).toContain(`POSTGRES_WORK_MEM=${size.workMem}\n`);
      expect(base, sizeName).toContain(
        `POSTGRES_MAINTENANCE_WORK_MEM=${size.maintenanceWorkMem}\n`,
      );
      expect(base, sizeName).toContain(`POSTGRES_MAX_WAL_SIZE=${size.maxWalSize}\n`);
      expect(base, sizeName).toContain("POSTGRES_MAX_CONNECTIONS=50\n");
      // The address the compose file publishes on, which is this machine's
      // private one and never 0.0.0.0.
      expect(base, sizeName).toContain("SB_BIND_ADDRESS=10.30.1.10\n");
    }
  });

  it("gives db-firstboot the subnet it narrows pg_hba to, and the device to format", () => {
    const defaults = writtenFile(
      databaseCloudInit({ ...longDatabaseRender("small"), dataDevice: "/dev/sdx" }),
      "/etc/default/simple-balance",
    );
    expect(defaults).toContain("SB_APP_CIDR=10.30.0.0/24\n");
    expect(defaults).toContain("SB_DATA_DEVICE=/dev/sdx\n");
  });

  it("waits for the data volume before it starts, and folds .env when it does", () => {
    // fstab mounts the volume `nofail`, so without RequiresMountsFor systemd is
    // free to start the deployment first — and PGDATA's bind has
    // create_host_path off precisely so that a missing directory is a refusal
    // rather than an empty one on the boot disk that an empty cluster is then
    // initialised into. The ordering stops the question being asked; the
    // refusal makes the wrong answer loud.
    const document = databaseCloudInit({ ...longDatabaseRender("small"), dataDevice: "/dev/sdx" });
    const dropIn = writtenFile(document, "/etc/systemd/system/simple-balance.service.d/env.conf");
    expect(dropIn).toContain("[Unit]\nRequiresMountsFor=/var/lib/simple-balance\n");
    // And the thing it runs reads the superuser password off that same volume,
    // so a start that raced the mount would fold a .env without one.
    expect(dropIn).toContain("[Service]\nExecStartPre=/usr/local/sbin/simple-balance-env\n");
    expect(DATABASE_FILES.map((file) => file.target)).toContain(
      "/usr/local/sbin/simple-balance-env",
    );
  });

  it("runs the platform's firewall commands before its first-boot script", () => {
    // On OCI the host ruleset REJECTs 5432 whatever the security list says, so
    // the order is the difference between a database that answers and one that
    // is healthy and unreachable.
    const document = oci.databaseInstanceMetadata(longDatabaseRender("small"), LONG_KEY);
    const text = gunzipSync(Buffer.from(document.user_data!, "base64")).toString("utf8");
    const runcmd = text.slice(text.indexOf("\nruncmd:\n"));
    expect(runcmd).toContain("--dport 5432 -j ACCEPT");
    expect(runcmd.indexOf("--dport 5432")).toBeLessThan(
      runcmd.indexOf("simple-balance-db-firstboot"),
    );
    // Nothing for 80 or 443: this machine serves neither, and a rule for a port
    // nothing listens on is an invitation to put something there later.
    expect(runcmd).not.toContain("--dport 80");
    expect(runcmd).not.toContain("--dport 443");
  });
});

describe("what the application machine is told about its database", () => {
  const document = () =>
    cloudInit({
      settings: longSettings("small"),
      dataDevice: oci.DATA_DEVICE,
      database: longApplicationDatabase(),
    });

  it("puts the connection string in env.db alone, at 0600", () => {
    // env.db and not env.base, and that split is the whole upgrade-safety story
    // for the machine: simple-balance-env folds base, db, secrets, local, so a
    // DATABASE_URL somebody wrote into env.local still wins.
    const written = writtenFile(document(), "/opt/simple-balance/env.db");
    expect(written.split("\n").filter(Boolean)).toHaveLength(1);
    expect(written).toBe(
      `DATABASE_URL=${databaseUrl("db.db.simplebalance.oraclevcn.com", PLACEHOLDER_PASSWORD)}\n`,
    );
    expect(writtenPermissions(document(), "/opt/simple-balance/env.db")).toBe("0600");
    expect(writtenFile(document(), "/opt/simple-balance/env.base")).not.toContain("DATABASE_URL");
  });

  it("stages the CA on the boot disk, where the data volume's mount cannot shadow it", () => {
    // write_files runs before firstboot mounts the volume, so a CA written
    // straight to its final path would vanish under the mount and the
    // application would verify against a file that is not there.
    expect(writtenFile(document(), "/opt/simple-balance/db-ca.pem")).toBe(PLACEHOLDER_CERTIFICATE);
    expect(document()).not.toContain(`  - path: ${APPLICATION_CA_PATH}`);
    // And the path firstboot installs it to is the one the URL names.
    expect(writtenFile(document(), "/opt/simple-balance/env.db")).toContain(
      `sslrootcert=${APPLICATION_CA_PATH}`,
    );
  });

  it("carries neither the server's private key nor the CA's", () => {
    const text = document();
    expect(text).not.toContain(PLACEHOLDER_KEY);
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });

  it("writes none of it at all when the stack builds no database node", () => {
    const bare = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
    // The two generated files, by the lines that would create them. Not by
    // searching the whole document for the words: simple-balance-env names
    // env.db and DATABASE_URL in code that runs on every machine, and
    // compose.db-tls.yml names the CA's path whether or not there is a CA —
    // both of which are what makes this branch cost the render nothing.
    expect(bare).not.toContain("  - path: /opt/simple-balance/env.db\n");
    expect(bare).not.toContain("  - path: /opt/simple-balance/db-ca.pem\n");
    expect(bare).not.toContain("DATABASE_URL=postgresql://");
    expect(bare).not.toContain("BEGIN CERTIFICATE");
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
    // Both halves of every row, because the floor is applied twice — once per
    // machine — and a row whose application disk cleared it while its database
    // disk did not would fail at CreateVolume rather than here.
    for (const [name, size] of Object.entries(SIZES)) {
      for (const [machine, node] of Object.entries({
        application: size.application,
        database: size.database,
      })) {
        expect(oci.dataVolumeGb(node), `${name}.${machine}`).toBe(Math.max(node.diskGib, 50));
      }
    }
    expect(oci.dataVolumeGb(SIZES.small!.application)).toBe(50);
    expect(oci.dataVolumeGb(SIZES.small!.database)).toBe(50);
    // And each volume is sized by it, not by the shared table directly — twice,
    // once per machine, since the two halves of a row are different numbers.
    const program = read("deploy/pulumi/oci-single/index.ts");
    expect(program).toContain("const dataGb = dataVolumeGb(size.application);");
    expect(program).toContain(
      "const databaseDataGb = database ? dataVolumeGb(database.size.database) : 0;",
    );
    expect(program).toContain("sizeInGbs: String(dataGb),");
    expect(program).toContain("sizeInGbs: String(databaseDataGb),");
    expect(program).not.toMatch(/sizeInGbs: String\(size\.\w+\.diskGib\)/);
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
    // Named properties rather than the whole of `sourceDetails`, because
    // `ignoreChanges` on a parent ignores everything under it — including the
    // `kmsKeyId` a customer key has to reach. The two named are exactly the two
    // that used to move on their own: the image Canonical rebuilds every few
    // weeks, and the boot volume's size. `tests/single-customer-keys.test.ts`
    // holds the same shape from the key's side.
    expect(program).toContain(
      'ignoreChanges: ["sourceDetails.sourceId", "sourceDetails.bootVolumeSizeInGbs", "metadata"]',
    );
    expect(program, "the parent would swallow the key").not.toContain(
      'ignoreChanges: ["sourceDetails", "metadata"]',
    );
  });
});

/**
 * Every constructor call that builds a resource of one kind, each from
 * `new <kind>(` to the `);` that closes it at the start of a line, which is how
 * both programs lay out a call with options.
 *
 * All of them rather than the one, because the profile has two machines now:
 * two instances, two data volumes and two attachments on each cloud. A helper
 * that took the first would check the application node and quietly say nothing
 * at all about the machine the ledger is on.
 */
function resourceCalls(program: string, kind: string): string[] {
  const calls: string[] = [];
  for (
    let at = program.indexOf(`new ${kind}(`);
    at > -1;
    at = program.indexOf(`new ${kind}(`, at + 1)
  ) {
    // To the `);` that closes it, at whatever indentation. Anchoring on a `);`
    // at column zero was right while every resource was declared at the top
    // level; a call inside an `if` closes two spaces in, and the slice ran on
    // past it into the next resource — which is a check that reads the wrong
    // declaration and passes.
    const end = /\n\s*\);\n/.exec(program.slice(at));
    expect(end, `${kind} closes`).not.toBeNull();
    calls.push(program.slice(at, at + end!.index));
  }
  expect(calls.length, kind).toBeGreaterThan(0);
  return calls;
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
    it(`${program} detaches every volume from its old machine before attaching it`, () => {
      const calls = resourceCalls(read(program), attachment);
      expect(calls, "one attachment per machine").toHaveLength(2);
      for (const call of calls) expect(call).toContain("deleteBeforeReplace: true");
    });
  }

  it("moves AWS's address after the volume, not as soon as the new machine exists", () => {
    const program = read("deploy/pulumi/aws-single/index.ts");
    expect(program).toContain("const attachment = new aws.ec2.VolumeAttachment(");
    const association = resourceCalls(program, "aws.ec2.EipAssociation");
    expect(association).toHaveLength(1);
    expect(association[0]).toContain("    deleteBeforeReplace: true,\n");
    expect(association[0]).toContain("    dependsOn: [attachment],\n");
  });
});

describe("what the programs tell a person to do next", () => {
  for (const program of [
    "deploy/pulumi/oci-single/index.ts",
    "deploy/pulumi/aws-single/index.ts",
  ]) {
    /**
     * Both halves of step three plus the steps after it. The database step is
     * a branch now, declared above `nextSteps`, so slicing from `nextSteps`
     * alone would read a document with the step missing and pass on nothing.
     */
    const steps = (path: string) => {
      const text = read(path);
      const at = text.indexOf("const databaseStep = database");
      expect(at, `${path} branches on whether it built a database node`).toBeGreaterThan(-1);
      return text.slice(at);
    };

    it(`${program} settles the database before looking for the setup code`, () => {
      const text = steps(program);
      const setupCode = text.indexOf("Find the setup code");
      expect(setupCode, "a setup-code step").toBeGreaterThan(-1);
      // With a database node there is nothing to do, and saying so is the
      // whole change: the old step told somebody to go and find a PostgreSQL.
      const settled = text.indexOf("The database is already running");
      expect(settled, "the database-node branch").toBeGreaterThan(-1);
      expect(settled, "before the setup code").toBeLessThan(setupCode);
      // Without one, the step that was always here, and the gate in firstboot
      // that holds the deployment stopped until a URL appears, are untouched.
      const byo = text.indexOf("DATABASE_URL=");
      expect(byo, "the bring-your-own branch").toBeGreaterThan(-1);
      expect(byo, "before the setup code").toBeLessThan(setupCode);
      expect(text).toContain("sudo /usr/local/sbin/simple-balance-firstboot");
      expect(text).toMatch(/firstboot\n\s+which starts the deployment and its nightly backup/);
      // The first start is firstboot and not a restart, which would leave the
      // backup timer waiting for a reboot and /etc/motd saying nothing runs.
      expect(text).not.toContain("once it has run");
      // A later setting is an edit and a restart, which the drop-in makes true.
      expect(text).toMatch(
        /env\.local, which[\s\S]{0,120}a setting is an edit to it, then\n\s+sudo systemctl restart simple-balance\./,
      );
    });

    it(`${program} says a hand-written DATABASE_URL still wins over the generated one`, () => {
      // simple-balance-env folds env.base, env.db, secrets.env, env.local in
      // that order, so the last one to name a variable is what Compose reads.
      // Saying so here is what makes "nothing to turn off first" checkable.
      expect(steps(program)).toContain(
        "it is folded last and wins over the generated\n   one, with nothing to turn off first.",
      );
    });

    it(`${program} names the settings a pooled database and AdSense cannot start without`, () => {
      const text = steps(program);
      expect(text).toMatch(/transaction pooler, DIRECT_DATABASE_URL beside it/);
      expect(text).toMatch(/AdSense and the PRIVACY_POLICY_URL it requires/);
    });

    it(`${program} points at a header a person can read, and all of it`, () => {
      // user-data.txt is the gzip the program sent, so the file a person would
      // open is binary. `cloud-init query` decompresses it.
      const text = steps(program);
      expect(text).not.toContain("user-data.txt");
      const document = cloudInit({ settings: longSettings("small"), dataDevice: oci.DATA_DEVICE });
      const lines = document.split("\n");
      const header = lines.findIndex((line) => !line.startsWith("#"));
      expect(lines[header], "the header ends where the configuration starts").toMatch(
        /^timezone: /,
      );
      expect(text).toContain(`sudo cloud-init query userdata | head -${header}\n`);
      // And the database machine's own header ends in the same place, so one
      // instruction serves both.
      const databaseDocument = databaseCloudInit({
        ...longDatabaseRender("small"),
        dataDevice: "/dev/sdx",
      });
      expect(
        databaseDocument.split("\n").findIndex((line) => !line.startsWith("#")),
        "both headers are the same length",
      ).toBe(header);
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
