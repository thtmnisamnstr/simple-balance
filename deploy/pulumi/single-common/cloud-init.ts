import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/**
 * The cloud-init both single-machine programs send, and everything about how it
 * is sent.
 *
 * Its own module, with no Pulumi import, so the test suite at the repository
 * root can render it exactly as a `pulumi up` would. That suite cannot import
 * `./index.ts`, which needs `@pulumi/pulumi` from `deploy/pulumi/node_modules`,
 * and the failures this module exists to prevent — a document a provider
 * refuses for its size, a tag that never reaches the compose file — are only
 * visible in the rendered text.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");

/** A machine size. The table itself is `SIZES` in `./index.ts`. */
export interface Size {
  /** Machine sizes, named by what they are rather than by a provider's SKU. */
  vcpu: number;
  memoryGib: number;
  /** The data disk. The boot disk holds the operating system and the images. */
  dataGib: number;
  sharedBuffers: string;
  effectiveCacheSize: string;
  workMem: string;
  maintenanceWorkMem: string;
  maxWalSize: string;
}

/** What the render reads from a stack's settings. `./index.ts` reads them. */
export interface MachineSettings {
  size: Size;
  sizeName: string;
  hostname: string;
  acmeEmail: string;
  allowedEmails: string;
  /** Always a tag: `readSingleSettings` fills in the release when a stack sets none. */
  imageTag: string;
  imageRepository: string;
  timezone: string;
  backupKeep: number;
}

export interface CloudInitArgs {
  settings: MachineSettings;
  /**
   * The block device the data volume appears as. AWS NVMe presents an EBS
   * volume under a name the kernel chooses, so that program passes a
   * by-id path; OCI presents a stable `/dev/oracleoci/...` symlink.
   */
  dataDevice: string;
  /**
   * Shell commands run before the first-boot script, for whatever the platform
   * gets wrong on its own.
   *
   * It exists for OCI, whose Ubuntu images ship a netfilter ruleset that
   * accepts 22 and drops everything else — so opening 80 and 443 in the cloud's
   * own security list is necessary and not sufficient, and the symptom is a
   * machine that answers SSH and times out on the web. AWS needs nothing here.
   */
  platformCommands?: string[];
}

// ------------------------------------------------------------ comments ---

/**
 * How a file writes a comment, which decides what can safely be left out of it.
 *
 * Only whole-line comments are ever removed, and only where the syntax says the
 * line is a comment rather than content: never a shebang, never a line inside a
 * heredoc or a quoted string that spans lines, never one inside a YAML block
 * scalar. A file with anything the readers below cannot account for is sent as
 * it is, because a copy that is a few hundred bytes longer is a better failure
 * than a script that means something different on the machine.
 */
export type CommentSyntax = "shell" | "yaml" | "systemd" | "caddyfile";

/**
 * The file with its whole-line comments removed, or unchanged where that is
 * not provably safe.
 *
 * Why it is done at all: the providers cap user data — OCI at 32,000 bytes of
 * instance metadata, EC2 at 16,384 bytes before base64 — and this repository's
 * deployment material is commented at the density `docs/standards/code/comments.md`
 * asks for. Compressed as it is, it fit EC2 by a couple of hundred bytes, which
 * is the next paragraph somebody adds to a script. The comments stay in the
 * repository, where they are read; the machine runs the same lines without them.
 */
export function stripComments(text: string, syntax: CommentSyntax): string {
  const lines = text.split("\n");
  const removable = removableLines(lines, syntax);
  if (!removable) return text;
  return lines.filter((_, index) => !removable.has(index)).join("\n");
}

function removableLines(lines: string[], syntax: CommentSyntax): Set<number> | null {
  switch (syntax) {
    case "shell":
      return shellComments(lines);
    case "yaml":
      return yamlComments(lines);
    case "systemd":
      return systemdComments(lines);
    case "caddyfile":
      return caddyfileComments(lines);
  }
}

const isCommentLine = (line: string) => line.trimStart().startsWith("#");

/**
 * POSIX shell, read the way sh reads it as far as comments are concerned.
 *
 * A line is a comment only when it starts outside every quote, heredoc,
 * `${...}` and `$(...)`, and when the line before it did not end in a
 * backslash — `cmd \` followed by `# note` is one command whose comment ends
 * it, and removing the note would join `cmd` to whatever came next. Anything
 * the reader cannot follow to a clean end refuses the whole file.
 */
function shellComments(lines: string[]): Set<number> | null {
  type Context =
    | { kind: "single" | "double" | "backtick" | "brace" }
    | { kind: "sub"; depth: number };
  const stack: Context[] = [];
  const pending: { delimiter: string; tabs: boolean }[] = [];
  let heredoc: { delimiter: string; tabs: boolean } | null = null;
  let continued = false;
  const removable = new Set<number>();

  for (const [index, line] of lines.entries()) {
    if (heredoc) {
      const candidate = heredoc.tabs ? line.replace(/^\t+/, "") : line;
      if (candidate === heredoc.delimiter) heredoc = pending.shift() ?? null;
      continue;
    }
    if (stack.length === 0 && !continued && isCommentLine(line)) {
      if (!(index === 0 && line.startsWith("#!"))) removable.add(index);
      continue;
    }

    continued = false;
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at]!;
      const next = line[at + 1];
      const top = stack[stack.length - 1];

      // Inside single quotes nothing is special but the closing quote, a
      // backslash included.
      if (top?.kind === "single") {
        if (char === "'") stack.pop();
        continue;
      }
      if (char === "\\") {
        if (at === line.length - 1) continued = true;
        at += 1;
        continue;
      }
      if (top?.kind === "backtick") {
        if (char === "`") stack.pop();
        continue;
      }
      if (char === "$" && next === "(") {
        stack.push({ kind: "sub", depth: 0 });
        at += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        stack.push({ kind: "brace" });
        at += 1;
        continue;
      }
      if (char === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (char === '"') {
        if (top?.kind === "double") stack.pop();
        else stack.push({ kind: "double" });
        continue;
      }
      if (top?.kind === "double") continue;
      if (char === "'") {
        stack.push({ kind: "single" });
        continue;
      }
      if (top?.kind === "brace") {
        if (char === "}") stack.pop();
        continue;
      }
      if (top?.kind === "sub") {
        if (char === "(") top.depth += 1;
        if (char === ")") {
          if (top.depth === 0) stack.pop();
          else top.depth -= 1;
        }
      }
      // A comment starts a word, so `${1##*/}`, `$#` and `s#a#b#` are not
      // comments. Inside `$(...)` one still is, and it swallows a `)` after it,
      // which is why the rest of the line is not read.
      if (char === "#" && (at === 0 || /[\s;&|()<>]/.test(line[at - 1]!))) break;
      if (char === "<" && next === "<") {
        const operator = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(
          line.slice(at),
        );
        // `<<<` is bash's here-string, `$((a << 2))` is a shift, and anything
        // else after `<<` is a spelling this reader has no rule for.
        if (!operator) return null;
        pending.push({
          delimiter: operator[2] ?? operator[3] ?? operator[4]!,
          tabs: operator[1] === "-",
        });
        at += operator[0].length - 1;
      }
    }

    if (pending.length > 0) {
      // The body starts on the next line only when this one ends the command.
      if (continued || stack.length > 0) return null;
      heredoc = pending.shift()!;
    }
  }

  if (stack.length > 0 || heredoc || pending.length > 0 || continued) return null;
  return removable;
}

/**
 * YAML, for the compose files.
 *
 * A `#` line is content inside a block scalar (`key: |`) and a comment
 * everywhere else, so block scalars are followed: every line more indented than
 * the one that opened it belongs to it and is kept. Using the opening line's own
 * indentation rather than the scalar's content indentation keeps more than it
 * has to in one corner and never removes content. A quoted or flow value that
 * does not close on its own line, or a plain scalar continued onto the next,
 * refuses the file rather than being reasoned about.
 */
function yamlComments(lines: string[]): Set<number> | null {
  const removable = new Set<number>();
  let block: number | null = null;

  for (const [index, line] of lines.entries()) {
    const indent = line.length - line.trimStart().length;
    if (block !== null) {
      if (line.trim() === "" || indent > block) continue;
      block = null;
    }
    if (line.trim() === "") continue;
    if (isCommentLine(line)) {
      removable.add(index);
      continue;
    }

    // Sequence dashes, then an optional `key:`. What is left is the value.
    const content = line.trimStart();
    const shape = /^((?:- +)*)(?:(?:"[^"]*"|'[^']*'|[^\s#'"{[][^#]*?) *:(?: +|$))?/.exec(content)!;
    const value = content.slice(shape[0].length);
    const isNode = shape[1]!.length > 0 || shape[0].trimEnd().endsWith(":") || content === "-";
    if (!isNode && content !== "---" && content !== "...") return null;
    if (!closesOnItsLine(value)) return null;
    if (/^[|>][-+1-9]{0,2}\s*(#.*)?$/.test(value)) block = indent;
  }
  return removable;
}

/** Whether a YAML value that opens a quote or a flow collection closes it. */
function closesOnItsLine(value: string): boolean {
  const first = value[0];
  if (first === '"') return /^"(?:[^"\\]|\\.)*"/.test(value);
  if (first === "'") return /^'(?:[^']|'')*'/.test(value);
  if (first !== "[" && first !== "{") return true;
  let depth = 0;
  let quote: string | null = null;
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]!;
    if (quote === '"') {
      if (char === "\\") at += 1;
      else if (char === '"') quote = null;
    } else if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * A systemd unit. `#` and `;` lines are comments, except where a backslash
 * continues the line before, and systemd's rule for a comment inside a
 * continuation has changed between releases — so a unit with any continuation
 * at all is sent whole.
 */
function systemdComments(lines: string[]): Set<number> | null {
  if (lines.some((line) => !isCommentLine(line) && line.trimEnd().endsWith("\\"))) return null;
  const removable = new Set<number>();
  for (const [index, line] of lines.entries()) {
    const start = line.trimStart();
    if (start.startsWith("#") || start.startsWith(";")) removable.add(index);
  }
  return removable;
}

/**
 * A Caddyfile. `#` at the start of a line is a comment, unless the line is
 * inside a heredoc, a backtick token or a quoted token spanning lines, or
 * follows a backslash continuation. This one has none of those, and a Caddyfile
 * that grows one is sent whole rather than parsed here.
 */
function caddyfileComments(lines: string[]): Set<number> | null {
  const unsafe = lines
    .filter((line) => !isCommentLine(line))
    .some(
      (line) =>
        line.includes("<<") ||
        line.includes("`") ||
        line.trimEnd().endsWith("\\") ||
        (line.replace(/\\"/g, "").match(/"/g) ?? []).length % 2 === 1,
    );
  if (unsafe) return null;
  const removable = new Set<number>();
  for (const [index, line] of lines.entries()) if (isCommentLine(line)) removable.add(index);
  return removable;
}

// --------------------------------------------------------------- files ---

/** Indents a file's contents to sit under a cloud-init `content: |` key. */
function block(contents: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return contents
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : ""))
    .join("\n");
}

/**
 * Reads a file out of the repository, so the compose files, the units and the
 * scripts have one definition rather than a copy in each cloud program.
 *
 * The failure it guards is this module being run from somewhere other than its
 * place in the tree — copied out, vendored, or built to a different depth —
 * where `repoRoot` resolves to a directory that simply does not have these
 * files under it. Node's own error for that names a path three levels from
 * anything recognizable and says nothing about why it was looking there.
 */
export function repoFile(relative: string): string {
  const file = path.join(repoRoot, relative);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Cannot read ${relative}: it is not under ${repoRoot}. These programs read the deployment ` +
        "material out of the repository rather than repeating it, so they have to be run from " +
        "their own directory inside a checkout.",
    );
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Every repository file the machine receives, where it goes, and how it
 * comments. One list, so the render and the test that checks each stripped
 * file still parses cannot disagree about which files there are.
 */
export const EMBEDDED_FILES: readonly {
  source: string;
  target: string;
  permissions: string;
  syntax: CommentSyntax;
}[] = [
  {
    source: "deploy/compose/single/compose.yml",
    target: "/opt/simple-balance/compose.yml",
    permissions: "0644",
    syntax: "yaml",
  },
  {
    source: "deploy/compose/single/compose.caddy.yml",
    target: "/opt/simple-balance/compose.caddy.yml",
    permissions: "0644",
    syntax: "yaml",
  },
  {
    source: "deploy/compose/single/Caddyfile",
    target: "/opt/simple-balance/Caddyfile",
    permissions: "0644",
    syntax: "caddyfile",
  },
  {
    source: "deploy/systemd/simple-balance.service",
    target: "/etc/systemd/system/simple-balance.service",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    source: "deploy/systemd/simple-balance-backup.service",
    target: "/etc/systemd/system/simple-balance-backup.service",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    source: "deploy/systemd/simple-balance-backup.timer",
    target: "/etc/systemd/system/simple-balance-backup.timer",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    source: "deploy/systemd/simple-balance-backup",
    target: "/usr/local/bin/simple-balance-backup",
    permissions: "0755",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance-restore",
    target: "/usr/local/bin/simple-balance-restore",
    permissions: "0755",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance-env",
    target: "/usr/local/sbin/simple-balance-env",
    permissions: "0700",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance-firstboot",
    target: "/usr/local/sbin/simple-balance-firstboot",
    permissions: "0700",
    syntax: "shell",
  },
];

/**
 * The only line of the compose file a stack changes: which image to run.
 *
 * Matched rather than assumed, and refused when it is missing. The compose file
 * pins the release by this spelling, and a render that found nothing to replace
 * would send the pinned release while the stack asked for another — which is how
 * `simple-balance:imageTag` is set, looks set, and is never pulled.
 */
const PINNED_IMAGE = /image: ghcr\.io\/thtmnisamnstr\/simple-balance:\S+/;

function composeWithImage(compose: string, image: string): string {
  if (!PINNED_IMAGE.test(compose)) {
    throw new Error(
      "deploy/compose/single/compose.yml no longer pins `image: ghcr.io/thtmnisamnstr/simple-balance:<tag>`, " +
        "which is the line these programs replace to deploy simple-balance:imageTag.",
    );
  }
  return compose.replace(PINNED_IMAGE, `image: ${image}`);
}

// ---------------------------------------------------------- the render ---

/**
 * The whole of the machine's configuration, as cloud-init.
 *
 * The compose files, the Caddyfile, the units and the scripts are read from
 * this repository rather than repeated here, so there is one description of the
 * deployment and a change to it reaches the cloud programs without anybody
 * remembering to copy it.
 *
 * No secret appears in this text, and that is a deliberate design rather than
 * an omission. AUTH_SECRET is generated on the machine at first boot and kept on
 * the data volume, so it never enters user data — which is readable by anyone
 * who can describe the instance — and never enters Pulumi's state file either.
 * Nothing outside the machine needs to know it. The settings that genuinely come
 * from outside — DATABASE_URL, an SMTP password, a Stripe key — are added to
 * /var/lib/simple-balance/env.local afterward; the README says so, because
 * putting them here would undo the whole point.
 *
 * The cloud-config's own comments are kept short, and they are the one set that
 * reaches the machine whole: the header is what `nextSteps` points people at.
 * The reasons behind the rest are here instead, where they cost it nothing.
 *
 * - Ubuntu's own docker.io and docker-compose-v2 rather than Docker's apt
 *   repository: one less third-party key to trust at first boot, and the same
 *   plugin under a different maintainer.
 * - The drop-in is what makes "edit env.local, then restart" true. The unit
 *   runs Compose against /opt/simple-balance/.env and only simple-balance-env
 *   folds env.local into it, so without the drop-in a restart re-read the old
 *   file and a new setting silently did nothing. It is written here, for the
 *   machines these programs build, and not into the shared unit: that unit also
 *   serves the hand-installed `single` and `vps` profiles, whose .env is written
 *   by hand and has no env.base to be assembled from. RequiresMountsFor because
 *   fstab mounts the data volume `nofail`, and at boot the fold would otherwise
 *   race the mount and find no secrets.env.
 * - env.base has no DATABASE_URL, and its absence is the design rather than an
 *   omission. This profile's database is somebody else's, so the connection
 *   string carries a password, and everything here arrives as user data. It
 *   goes in env.local by hand, the way an SMTP password or a Stripe key does;
 *   firstboot leaves the deployment enabled-but-stopped and says so until it is
 *   there. Nor are there POSTGRES_* tuning settings: nothing on the machine
 *   reads them, and docs/deployment-sizing.md has the numbers to set on
 *   whichever PostgreSQL this is pointed at.
 */
export function cloudInit(args: CloudInitArgs): string {
  const { settings, dataDevice } = args;
  const image = `${settings.imageRepository}:${settings.imageTag}`;

  const files = EMBEDDED_FILES.map((file) => {
    const original = repoFile(file.source);
    const text = file.source.endsWith("/compose.yml")
      ? composeWithImage(original, image)
      : original;
    return `  - path: ${file.target}
    permissions: "${file.permissions}"
    content: |
${block(stripComments(text, file.syntax), 6)}`;
  }).join("\n\n");

  return `#cloud-config
# Generated by deploy/pulumi/single-common and applied once, when this machine
# first booted. The files below are the repository's own, from
# deploy/compose/single and deploy/systemd, with their comment lines left out
# to fit the provider's limit on user data; the commented originals are there.
#
# A later \`pulumi up\` neither re-runs this nor replaces the machine when it
# changes. These programs provision the machine; they do not keep managing it.
# So apply a change here, not there:
#   an application upgrade   edit the image tag in /opt/simple-balance/compose.yml, then
#                            sudo docker compose -f /opt/simple-balance/compose.yml pull
#                            sudo systemctl restart simple-balance
#   a setting                edit /var/lib/simple-balance/env.local, then
#                            sudo systemctl restart simple-balance
#
# env.local is on the data volume, so it survives the machine being rebuilt.
timezone: ${settings.timezone}

package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - unattended-upgrades

write_files:
${files}

  - path: /etc/systemd/system/simple-balance.service.d/env.conf
    permissions: "0644"
    content: |
      [Unit]
      RequiresMountsFor=/var/lib/simple-balance

      [Service]
      ExecStartPre=/usr/local/sbin/simple-balance-env

  - path: /etc/default/simple-balance
    permissions: "0644"
    content: |
      COMPOSE_FILE=compose.yml:compose.caddy.yml
      SB_BACKUP_DIR=/var/lib/simple-balance/backups
      SB_BACKUP_KEEP=${settings.backupKeep}
      SB_DATA_DEVICE=${dataDevice}
      SB_PG_CLIENT_IMAGE=postgres:18

  - path: /opt/simple-balance/env.base
    permissions: "0644"
    content: |
      APP_BASE_URL=https://${settings.hostname}
      SITE_ADDRESS=${settings.hostname}
      ACME_EMAIL=${settings.acmeEmail}
      AUTH_MODE=local
      ALLOWED_EMAILS=${settings.allowedEmails}
      LOG_LEVEL=info

runcmd:
${(args.platformCommands ?? []).map((command) => `  - ${command}`).join("\n")}
  - [/usr/local/sbin/simple-balance-firstboot]
`;
}

// ------------------------------------------------------------- sending ---

/**
 * OCI's ceiling on an instance's `metadata` and `extendedMetadata` together,
 * from the provider's own documentation of the field. `ssh_authorized_keys`
 * counts against it as well as `user_data`.
 */
export const OCI_METADATA_LIMIT = 32_000;

/** EC2's ceiling on user data, measured before base64 — so after gzip. */
export const AWS_USER_DATA_LIMIT = 16_384;

/**
 * Compressed, which cloud-init recognizes by the gzip magic bytes and undoes
 * before reading, on both clouds. Level 9 because this is computed once per
 * `pulumi up` and every byte counts against a limit.
 */
export function gzipUserData(text: string): Buffer {
  return zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
}

/**
 * The OCI instance's metadata: the key, and the user data as base64 of its gzip.
 *
 * Refused here, at `pulumi preview`, when it would not fit, rather than as a
 * LaunchInstance 400 after the network and the volume have been built around a
 * machine that will never exist. The size is JSON's, which is how the metadata
 * travels and is a few bytes more than the values alone.
 */
export function ociMetadata(text: string, sshPublicKey: string): Record<string, string> {
  const metadata = {
    ssh_authorized_keys: sshPublicKey,
    user_data: gzipUserData(text).toString("base64"),
  };
  const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  if (bytes >= OCI_METADATA_LIMIT) {
    throw new Error(
      `The instance metadata comes to ${bytes} bytes and OCI accepts fewer than ${OCI_METADATA_LIMIT}. ` +
        "It is the deployment material in deploy/compose/single and deploy/systemd, compressed, plus " +
        "the SSH key. Something there has grown past what one instance can be sent; " +
        "tests/cloud-init.test.ts measures it.",
    );
  }
  return metadata;
}

/** The EC2 instance's `userDataBase64`, refused when the gzip would not fit. */
export function awsUserDataBase64(text: string): string {
  const gzipped = gzipUserData(text);
  if (gzipped.length > AWS_USER_DATA_LIMIT) {
    throw new Error(
      `The user data comes to ${gzipped.length} bytes compressed and EC2 accepts ${AWS_USER_DATA_LIMIT}. ` +
        "It is the deployment material in deploy/compose/single and deploy/systemd; something there " +
        "has grown past what one instance can be sent. tests/cloud-init.test.ts measures it.",
    );
  }
  return gzipped.toString("base64");
}
