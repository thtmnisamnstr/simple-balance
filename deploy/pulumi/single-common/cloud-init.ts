import * as crypto from "crypto";
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

/**
 * One machine's shape, named by what it is rather than by a provider's SKU.
 *
 * `diskGib` rather than `dataGib`, and the rename is the point: there are two
 * of these per row now, and the old name belonged to a table that had one disk
 * for two machines with opposite appetites. Anything still reading `dataGib`
 * is reading a number that no longer exists rather than the wrong one.
 */
export interface NodeSize {
  vcpu: number;
  memoryGib: number;
  /** The data disk. The boot disk holds the operating system and the images. */
  diskGib: number;
}

/**
 * A row of the size table, which is one name buying two machines. The table
 * itself is `SIZES` in `./index.ts`.
 *
 * Two shapes rather than one read twice, because the two nodes want different
 * things and a single number could only be right for one of them. The
 * application node runs Node and Caddy and stores no ledger; the database node
 * is PostgreSQL, whose memory decides how much of the index is in cache and
 * whose disk holds the cluster, the write-ahead log and the room a REINDEX
 * needs. The five server settings below belong to `database` — they are
 * written from the row the *database* node was sized with — which is why they
 * sit beside it rather than inside either shape.
 */
export interface Size {
  application: NodeSize;
  database: NodeSize;
  sharedBuffers: string;
  effectiveCacheSize: string;
  workMem: string;
  maintenanceWorkMem: string;
  maxWalSize: string;
}

/**
 * What the database node's render reads. `./index.ts` reads them from the
 * stack, and `password` empty is what makes the program generate one.
 */
export interface DatabaseSettings {
  size: Size;
  sizeName: string;
  maxConnections: number;
  password: string;
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
  /**
   * The database node this stack built, when it built one.
   *
   * Absent is `simple-balance:databaseNode: false`, and then the machine is
   * exactly what it was before this profile grew a second node: no env.db, no
   * CA on the boot disk, and firstboot's `grep -q '^DATABASE_URL=..*'` gate
   * stopping the deployment until an operator writes a URL of their own into
   * env.local. That gate is untouched by any of this; with a database node it
   * simply never fires, because cloud-init supplied one.
   */
  database?: ApplicationDatabase;
}

/** What the application node is told about the database node. */
export interface ApplicationDatabase {
  /**
   * The whole connection string, built by the program because the password is
   * a Pulumi output and this module is deliberately Pulumi-free. `databaseUrl`
   * below is the one place its shape is decided.
   */
  url: string;
  /**
   * The CA certificate in PEM, which is public: a CA certificate is what a
   * server hands every client that asks. It is the server's private key that
   * must not be in this document, and it is not.
   */
  caCertificate: string;
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
export type CommentSyntax = "shell" | "yaml" | "systemd" | "caddyfile" | "hash";

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
    case "hash":
      return hashComments(lines);
  }
}

/**
 * A line-oriented file whose only structure is `#`: pg_hba.conf, which is the
 * one the database node sends.
 *
 * The simplest reader here, and it is simple because the format is. A
 * pg_hba.conf record is one line, there is no quoting that spans lines, no
 * heredoc and no continuation — PostgreSQL's own parser reads a `#` as the
 * start of a comment wherever it appears and ends the record at the newline.
 * So a line whose first non-blank character is `#` is a comment, always, and
 * nothing can make it content. Nothing is ever refused, which is why this
 * returns a set rather than null.
 */
function hashComments(lines: string[]): Set<number> {
  const removable = new Set<number>();
  for (const [index, line] of lines.entries()) if (isCommentLine(line)) removable.add(index);
  return removable;
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

/** One repository file on its way to a machine. */
export interface EmbeddedFile {
  source: string;
  target: string;
  permissions: string;
  syntax: CommentSyntax;
}

/**
 * Every repository file the application node receives, where it goes, and how
 * it comments. One list, so the render and the test that checks each stripped
 * file still parses cannot disagree about which files there are.
 *
 * Split from `DATABASE_FILES` rather than sent to both machines, and the reason
 * is not tidiness: each document is measured against the provider's cap on its
 * own, and a database node carrying the Caddyfile, the backup script and the
 * restore script would be paying for three files it has no service to run. The
 * split is also what makes "the server key is in one document and not the
 * other" a thing a test can check rather than a thing somebody remembers.
 */
export const APP_FILES: readonly EmbeddedFile[] = [
  {
    // Both machines get it. On the database machine DATABASE_URL is unset, so
    // it waits for nothing and exits immediately; shipping it to one machine
    // only would make the unit's ExecStartPre a file that exists on one host
    // and not the other, which is a start failure rather than a no-op.
    source: "deploy/systemd/simple-balance-waitdb",
    target: "/usr/local/sbin/simple-balance-waitdb",
    permissions: "0755",
    syntax: "shell",
  },
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
    source: "deploy/compose/single/compose.db-tls.yml",
    target: "/opt/simple-balance/compose.db-tls.yml",
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
    source: "deploy/systemd/simple-balance-growfs.service",
    target: "/etc/systemd/system/simple-balance-growfs.service",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    // 0755 rather than the 0700 the first-boot script gets, because this one
    // holds no secret and an operator reading `systemctl cat` should be able to
    // read what it runs. It is still only ever started as root.
    source: "deploy/systemd/simple-balance-growfs",
    target: "/usr/local/sbin/simple-balance-growfs",
    permissions: "0755",
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
 * Every repository file the database node receives.
 *
 * A short list, because that machine runs one service. It does not
 * get the backup or the restore script: the backups are taken from the
 * application node over the network onto its protected data volume, which is
 * what keeps `simple-balance-backup`'s "is postgres a service in this project"
 * branch answering the same thing it answers today. Nor the env drop-in, since
 * nothing on this machine folds an env.local — there is no setting a person
 * adds to a database node by hand that is not already in the compose file.
 *
 * The unit is the same `simple-balance.service` the application node runs, with
 * a different COMPOSE_FILE in /etc/default. That is the whole of the
 * difference, and it is deliberate: one unit means one place where the start
 * order, the `--wait`, and the six-hundred-second start timeout are decided.
 */
export const DATABASE_FILES: readonly EmbeddedFile[] = [
  {
    // Both machines get it. On the database machine DATABASE_URL is unset, so
    // it waits for nothing and exits immediately; shipping it to one machine
    // only would make the unit's ExecStartPre a file that exists on one host
    // and not the other, which is a start failure rather than a no-op.
    source: "deploy/systemd/simple-balance-waitdb",
    target: "/usr/local/sbin/simple-balance-waitdb",
    permissions: "0755",
    syntax: "shell",
  },
  {
    source: "deploy/compose/single/compose.postgres.yml",
    target: "/opt/simple-balance/compose.postgres.yml",
    permissions: "0644",
    syntax: "yaml",
  },
  {
    // Mounted as PostgreSQL's `hba_file` rather than left to the image, which
    // generates `host ... scram-sha-256` lines that accept a connection with no
    // TLS at all. A file this repository owns is what makes `hostssl` the only
    // way in, so the encryption is enforced by the server rather than requested
    // by the client.
    source: "deploy/compose/single/pg_hba.conf",
    target: "/opt/simple-balance/pg_hba.conf",
    permissions: "0644",
    syntax: "hash",
  },
  {
    // Beside the compose file and under this name, because that is the bind
    // source compose.postgres.yml names; the entrypoint sees it at
    // /docker-entrypoint-initdb.d/10-application-role.sh, which is where the
    // number that fixes its order lives.
    source: "deploy/compose/single/db-init.sh",
    target: "/opt/simple-balance/db-init.sh",
    permissions: "0755",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance.service",
    target: "/etc/systemd/system/simple-balance.service",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    // The same fold as the application node, and it has to be the same file:
    // simple-balance-db-firstboot runs it to build this machine's .env from
    // env.base, env.db and the superuser password it has just generated. A
    // second copy here would be a second place the precedence order — the one
    // that keeps env.local winning — could quietly differ.
    source: "deploy/systemd/simple-balance-env",
    target: "/usr/local/sbin/simple-balance-env",
    permissions: "0700",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance-growfs.service",
    target: "/etc/systemd/system/simple-balance-growfs.service",
    permissions: "0644",
    syntax: "systemd",
  },
  {
    // 0755 rather than the 0700 the first-boot script gets, because this one
    // holds no secret and an operator reading `systemctl cat` should be able to
    // read what it runs. It is still only ever started as root.
    source: "deploy/systemd/simple-balance-growfs",
    target: "/usr/local/sbin/simple-balance-growfs",
    permissions: "0755",
    syntax: "shell",
  },
  {
    source: "deploy/systemd/simple-balance-db-firstboot",
    target: "/usr/local/sbin/simple-balance-db-firstboot",
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

/** The files of one list, as a cloud-config `write_files` fragment. */
function writeFiles(
  files: readonly EmbeddedFile[],
  transform: (file: EmbeddedFile, text: string) => string,
): string {
  return files
    .map((file) => {
      const text = transform(file, repoFile(file.source));
      return `  - path: ${file.target}
    permissions: "${file.permissions}"
    content: |
${block(stripComments(text, file.syntax), 6)}`;
    })
    .join("\n\n");
}

/** One generated file, in the same shape as an embedded one. */
function generatedFile(target: string, permissions: string, contents: string): string {
  return `  - path: ${target}
    permissions: "${permissions}"
    content: |
${block(contents, 6)}`;
}

// ------------------------------------------------------------ database ---

/**
 * The role, the database and the port, which are the same on every stack.
 *
 * Not settings, and that is the point: they appear in the connection string,
 * in pg_hba.conf, in db-init.sh and in the backup script's `psql`, and a name
 * that can differ is a name four files have to agree about. `simple_balance`
 * rather than `postgres` because the application is not a superuser: the
 * entrypoint creates the database as `postgres` and db-init.sh hands it over,
 * so a SQL injection that got as far as the driver still cannot read
 * `pg_authid` or write outside this database.
 */
export const DATABASE_ROLE = "simple_balance";
export const DATABASE_NAME = "simple_balance";
export const DATABASE_PORT = 5432;

/**
 * Where the CA certificate is on the application node, and it is one path on
 * purpose.
 *
 * It is the host path firstboot creates on the data volume, the container path
 * compose.db-tls.yml mounts it at, and the `sslrootcert` in the URL. Those are
 * three readers of one string: mount it anywhere else and the application
 * verifies against a file the backup cannot see, or the other way round, and
 * the nightly dump is what finds out.
 */
export const APPLICATION_CA_PATH = "/var/lib/simple-balance/tls/db-ca.pem";

/**
 * Where cloud-init leaves the CA before firstboot installs it.
 *
 * On the boot disk, and that is forced rather than chosen: `write_files` runs
 * before firstboot mounts the data volume, so anything written under
 * /var/lib/simple-balance would be shadowed the moment the mount happened and
 * the application would look at an empty directory. firstboot copies it across
 * after the mount, and only when the destination is absent, so a CA an
 * operator installed by hand survives a machine being rebuilt.
 */
export const STAGED_CA_PATH = "/opt/simple-balance/db-ca.pem";

/** Where the database node keeps the certificate it presents. */
export const SERVER_CERTIFICATE_PATH = "/opt/simple-balance/db-tls/server.crt";
export const SERVER_KEY_PATH = "/opt/simple-balance/db-tls/server.key";

/**
 * The connection string, and the one place its shape is decided.
 *
 * `sslmode=verify-full`, not `require`, and the difference is the whole point
 * of the certificate above it. pg-connection-string returns `ssl: {}` for both
 * spellings, so node-postgres applies Node's defaults either way and verifies
 * the chain — but `verify-full` is also what `psql`, `pg_dump` and
 * `simple-balance-restore` read, and for libpq `require` checks nothing at all.
 * One string is read by two client libraries with different defaults, so it
 * says what it means.
 *
 * `sslrootcert` names a file rather than leaning on the system trust store,
 * because this CA is in no system trust store and putting it in one would mean
 * trusting it for every TLS connection the machine makes rather than for this
 * one.
 */
/**
 * The host is always a DNS name and never an address, whatever the caller has
 * to hand.
 *
 * node-postgres sets the TLS `servername` only for a host `net.isIP` calls 0,
 * so an address here sends no SNI and Node verifies against the literal string
 * `localhost`, which no certificate this program issues names. The failure is
 * `Hostname/IP does not match certificate's altnames` at the first connection,
 * after `pulumi up` has reported success. libpq is the other way round and
 * verifies an IP SAN quite happily, which is why the backup scripts can dial
 * the address and the application cannot — so the asymmetry is real, and it
 * cuts against the one client that matters most.
 */
function requireDnsName(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    throw new Error(
      `DATABASE_URL would name ${host}, which is an address rather than a DNS name. ` +
        "node-postgres sends no SNI for an address and then verifies the certificate against " +
        '"localhost", so sslmode=verify-full fails at the first connection whatever subject ' +
        "alternative names the certificate carries. Use the provider's internal DNS name for the " +
        "database node — `databaseHost` in each program's platform.ts builds it.",
    );
  }
  return host;
}

export function databaseUrl(host: string, password: string): string {
  requireDnsName(host);
  return (
    `postgresql://${DATABASE_ROLE}:${password}@${host}:${DATABASE_PORT}/${DATABASE_NAME}` +
    `?sslmode=verify-full&sslrootcert=${APPLICATION_CA_PATH}`
  );
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
 * One secret appears in this text and exactly one: the application role's
 * password, inside DATABASE_URL, and only when this stack built the database
 * node. It has to be here, because it is the one credential that has to reach
 * this machine before anybody logs in, and it is the least dangerous one to
 * carry: it grants exactly one role on one database on a machine with no
 * public address, reachable only from this instance's security group.
 *
 * Everything else is deliberately absent. AUTH_SECRET is generated on the
 * machine at first boot and kept on the data volume, so it never enters user
 * data — which is readable by anyone who can describe the instance — and never
 * enters Pulumi's state file either. The database's superuser password is
 * generated on the database node and never leaves it. The CA's private key
 * exists only in Pulumi's state. The settings that genuinely come from outside
 * — an SMTP password, a Stripe key — are added to
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
 *   serves a hand-installed `single` profile, whose .env is written
 *   by hand and has no env.base to be assembled from. RequiresMountsFor because
 *   fstab mounts the data volume `nofail`, and at boot the fold would otherwise
 *   race the mount and find no secrets.env.
 * - DATABASE_URL is in env.db and not in env.base, and the split is what keeps a
 *   hand-written setting winning. simple-balance-env folds env.base, then
 *   env.db, then secrets.env, then env.local, and the last file to name a
 *   variable is the one Compose reads — so an operator who points this machine
 *   at a database of their own by writing DATABASE_URL into env.local still gets
 *   theirs, with nothing to turn off first. env.base is 0644 and holds nothing
 *   secret; env.db is 0600 and holds one line. With no database node there is no
 *   env.db at all, and firstboot's gate leaves the deployment
 *   enabled-but-stopped until somebody writes one.
 * - There are no POSTGRES_* tuning settings here. They belong to the database
 *   node, whose own render applies them as `-c` flags on the server; nothing on
 *   this machine would read them.
 * - COMPOSE_FILE names compose.db-tls.yml, which mounts the directory the
 *   database's CA certificate goes in, and a hand install does not unless it
 *   asks. The mount needs its directory to exist before anything starts, and
 *   here firstboot makes it on the data volume first; on a hand install under
 *   a rootless daemon, the same line in compose.yml stopped the application
 *   starting at all.
 */
export function cloudInit(args: CloudInitArgs): string {
  const { settings, dataDevice, database } = args;
  const image = `${settings.imageRepository}:${settings.imageTag}`;

  const files = writeFiles(APP_FILES, (file, text) =>
    file.source.endsWith("/compose.yml") ? composeWithImage(text, image) : text,
  );

  // Two files and neither is optional-looking: without the CA the URL below
  // names a file that is not there and every connection fails verification,
  // and without the URL firstboot stops the deployment and writes /etc/motd.
  // So they are written together or not at all.
  const databaseFiles = database
    ? `\n\n${generatedFile(STAGED_CA_PATH, "0644", database.caCertificate)}\n
${generatedFile("/opt/simple-balance/env.db", "0600", `DATABASE_URL=${database.url}\n`)}`
    : "";

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
${files}${databaseFiles}

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
      COMPOSE_FILE=compose.yml:compose.caddy.yml:compose.db-tls.yml
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

/** What the database node's cloud-init needs that the stack cannot state. */
export interface DatabaseCloudInitArgs {
  /** The application node's settings, read only for the timezone. */
  settings: MachineSettings;
  database: DatabaseSettings;
  dataDevice: string;
  /**
   * This machine's own private address, which the compose file publishes
   * PostgreSQL on and nowhere else. Known here because the program pins it —
   * it has to, since the certificate's SAN is decided before the machine
   * exists.
   */
  bindAddress: string;
  /**
   * The application node's subnet, which db-firstboot writes into pg_hba's one
   * network line in place of `all`. The third line of defence, after the
   * provider's firewall and the bound address, and the only one of the three
   * the database itself enforces.
   */
  applicationCidr: string;
  /**
   * The application role's password, resolved: the stack's own, or the one the
   * program generated. This is the value the other machine's DATABASE_URL
   * carries, and the two are written from one source for that reason.
   */
  applicationPassword: string;
  serverCertificate: string;
  serverKey: string;
  platformCommands?: string[];
  /**
   * Shell commands run in cloud-init's *boot* stage, which is the only stage
   * earlier than `package_update`.
   *
   * `platformCommands` above cannot serve: those go in `runcmd`, which runs
   * last, long after the apt fetch they would have to come before.
   *
   * This exists for *both* of the IPv6 ways out on AWS —
   * `simple-balance:databaseEgress: ipv6` and `: ssm` — because under either
   * one the machine's only route out is IPv6, and `ssm`'s two interface
   * endpoints reach AWS services rather than Ubuntu's archive. A reader who
   * takes this for `ipv6` alone leaves the `ssm` path unexercised. What goes in
   * it is `IPV6_APT_REWRITE` in `../aws-single/platform.ts`, which carries why
   * it is still here now that the in-region EC2 mirror does publish an AAAA
   * record; the argument is not restated, so that there is one copy of it.
   *
   * Empty everywhere else, and the `bootcmd:` key is then left out of the
   * document entirely rather than emitted empty, because an empty list is a
   * line of user data spent on nothing.
   */
  bootCommands?: string[];
}

/**
 * The whole of the database node's configuration, as cloud-init.
 *
 * A second render rather than a flag on the first, and the reason is that
 * almost nothing is shared: this machine runs one service, has no Caddy, no
 * ACME, no backup timer and no env.local anybody edits, and it is measured
 * against the provider's cap on its own. A single render with branches would
 * be a document whose size depended on a boolean, which is exactly the thing
 * `tests/cloud-init.test.ts` measures and the thing a provider refuses late.
 *
 * Two secrets are in this text and both have to be: the server's private key,
 * because PostgreSQL cannot present a certificate without one and this machine
 * has no other way to receive it, and the application role's password, because
 * only the program can decide a value both machines agree on. Neither is the
 * dangerous one. The superuser password is generated by
 * simple-balance-db-firstboot on this machine and exists nowhere else, and the
 * CA's private key is in Pulumi's state and in neither document — so nobody
 * holding this user data can mint a certificate for this database or sign in
 * as the cluster's owner.
 *
 * The certificate and the key stay on the boot disk and are bind-mounted
 * read-only. Nothing copies them to the data volume, because a rebuild is
 * handed them again; the volume holds the cluster and the superuser password,
 * which a rebuild is not handed and must not lose.
 *
 * It gets the same drop-in the application node does, and `RequiresMountsFor`
 * is the half that matters here. fstab mounts the data volume `nofail`, so
 * without it systemd is free to start the deployment first — and the compose
 * file's PGDATA bind has `create_host_path: false` precisely so that a missing
 * directory is a refusal rather than an empty one on the boot disk that a brand
 * new empty cluster is initialised into. The ordering is what stops the
 * question being asked; the refusal is what makes the wrong answer loud. The
 * `ExecStartPre` comes with it because `simple-balance-env` reads the
 * superuser password off that same volume, so a start that raced the mount
 * would fold a .env without it and hand the container nothing.
 *
 * Its header is exactly as many lines as the application node's, and that is a
 * constraint rather than a coincidence: both programs' last step tells an
 * operator to read the header with one `head -16`, and two machines whose
 * headers were different lengths would need two instructions or one that cut
 * the longer short. `tests/cloud-init.test.ts` holds them equal, so a paragraph
 * added to either is a line taken out of it or a number changed in three
 * places on purpose.
 */
export function databaseCloudInit(args: DatabaseCloudInitArgs): string {
  const { settings, database, dataDevice, bindAddress, applicationCidr } = args;
  const size = database.size;

  const files = writeFiles(DATABASE_FILES, (_file, text) => text);

  // A blank line when there is nothing to run, so the document is byte-for-byte
  // what it was before this hook existed on every deployment that does not use
  // it — which is what keeps `tests/cloud-init.test.ts`'s size measurements and
  // the equal-length header rule true without a second case to reason about.
  const bootCommands = args.bootCommands?.length
    ? `\nbootcmd:\n${args.bootCommands.map((command) => `  - ${command}`).join("\n")}\n`
    : "";

  return `#cloud-config
# Generated by deploy/pulumi/single-common and applied once, when this database
# machine first booted. The files below are the repository's own, from
# deploy/compose/single and deploy/systemd, with their comment lines left out
# to fit the provider's limit on user data; the commented originals are there.
#
# This machine has no public address. It answers 5432 to the application
# machine and nothing else; a shell on it comes from the provider's own agent —
# Session Manager on AWS, a Bastion on Oracle Cloud — which opens no port.
#
# A later \`pulumi up\` neither re-runs this nor replaces the machine when it
# changes. So apply a change here, not there:
#   a PostgreSQL setting     edit /opt/simple-balance/env.base, then
#                            sudo /usr/local/sbin/simple-balance-db-firstboot
#   the certificate          replace /opt/simple-balance/db-tls/server.crt and
#                            its .key, then run that same script.
timezone: ${settings.timezone}
${bootCommands}
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

${generatedFile(SERVER_CERTIFICATE_PATH, "0644", args.serverCertificate)}

${generatedFile(SERVER_KEY_PATH, "0600", args.serverKey)}

  - path: /etc/default/simple-balance
    permissions: "0644"
    content: |
      COMPOSE_FILE=compose.postgres.yml
      SB_DATA_DEVICE=${dataDevice}
      SB_APP_CIDR=${applicationCidr}

  - path: /opt/simple-balance/env.base
    permissions: "0644"
    content: |
      SB_BIND_ADDRESS=${bindAddress}
      POSTGRES_SHARED_BUFFERS=${size.sharedBuffers}
      POSTGRES_EFFECTIVE_CACHE_SIZE=${size.effectiveCacheSize}
      POSTGRES_WORK_MEM=${size.workMem}
      POSTGRES_MAINTENANCE_WORK_MEM=${size.maintenanceWorkMem}
      POSTGRES_MAX_WAL_SIZE=${size.maxWalSize}
      POSTGRES_MAX_CONNECTIONS=${database.maxConnections}

${generatedFile("/opt/simple-balance/env.db", "0600", `POSTGRES_APP_PASSWORD=${args.applicationPassword}\n`)}

runcmd:
${(args.platformCommands ?? []).map((command) => `  - ${command}`).join("\n")}
  - [/usr/local/sbin/simple-balance-db-firstboot]
`;
}

// -------------------------------------------------------- measuring it ---

/**
 * Stand-ins for the three values that only exist once Pulumi has run, so that
 * both programs can measure their documents against the provider's cap at
 * `pulumi preview` rather than at the launch that fails.
 *
 * The password is generated by `random.RandomPassword` and the two PEMs by
 * `@pulumi/tls`, and all three are Pulumi outputs: their real text is not known
 * until the deployment is under way, by which time the network and the disks
 * have been built around a machine the provider is about to refuse. So the
 * check runs twice — here with these, and again inside the apply with the real
 * values, where it is a last resort rather than the first line.
 *
 * Deliberately *larger* than the real thing, so the early check is
 * conservative: a P-256 certificate is around 700 bytes of PEM and its key
 * around 240, against the 1,024 and 512 below. A stand-in that undershot would
 * pass here and fail there, which is the failure this exists to move.
 *
 * And deliberately incompressible, which is the part that is easy to get
 * wrong. The document is measured after gzip, and a thousand bytes of `A`
 * compress to nothing at all — a filler made that way would measure as zero and
 * the check would silently stop meaning anything. A chain of SHA-256 digests
 * has no structure to compress and, unlike random bytes, is the same on every
 * render, which is what lets the test suite compare two renders for equality.
 */
function incompressible(bytes: number): string {
  const chunks: Buffer[] = [];
  let digest = crypto.createHash("sha256").update("simple-balance size check").digest();
  for (let size = 0; size < bytes; size += digest.length) {
    chunks.push(digest);
    digest = crypto.createHash("sha256").update(digest).digest();
  }
  return Buffer.concat(chunks).subarray(0, bytes).toString("base64");
}

/** A PEM of a given size, in the shape `write_files` will carry. */
function pemStandIn(label: string, bytes: number): string {
  // 64 characters to the line, which is what every PEM encoder emits and what
  // decides how many newlines the document carries.
  const body = incompressible(bytes)
    .match(/.{1,64}/g)!
    .join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** As long as the longest `random.RandomPassword` this profile asks for. */
export const PLACEHOLDER_PASSWORD = "0".repeat(32);

export const PLACEHOLDER_CERTIFICATE = pemStandIn("CERTIFICATE", 1024);
export const PLACEHOLDER_KEY = pemStandIn("PRIVATE KEY", 512);

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
