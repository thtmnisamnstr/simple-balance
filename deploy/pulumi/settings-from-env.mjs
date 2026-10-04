#!/usr/bin/env node
/**
 * Copies the application settings in a `.env` file into a Pulumi stack's
 * `simple-balance:env` and `simple-balance:secrets`, each secret with
 * `--secret`.
 *
 *   node deploy/pulumi/settings-from-env.mjs <program> [file] [--stack <name>] [--dry-run]
 *
 *   <program>   the Pulumi program's directory, such as deploy/pulumi/oci-single
 *   [file]      the .env to read; ./.env when left out
 *   --stack     the stack to write to; Pulumi's selected stack when left out
 *   --dry-run   say what would be set, by name, and set nothing
 *
 * The file is read literally, one NAME=value per line, never sourced: a value
 * such as `Simple Balance <balance@example.com>` is a syntax error to a shell
 * and a perfectly good MAIL_FROM. One pair of matching quotes around a value
 * is removed, which is how Compose reads the same file.
 *
 * What it copies is what the application reads and a stack may set. It leaves
 * out, and says so:
 *
 * - names the application does not read at all, such as OCI_TENANCY_OCID — a
 *   deployment's own credentials belong to the shell running Pulumi, not to the
 *   machine;
 * - names a program decides from a stack key of its own, such as APP_BASE_URL,
 *   or from what is in front of it, such as TRUST_PROXY — a development `.env`
 *   says false, and production is behind a proxy;
 * - and the four that describe *where* a deployment is rather than how it
 *   behaves — DATABASE_URL, DIRECT_DATABASE_URL, AUTH_SECRET and SETUP_TOKEN.
 *   A development `.env` has all four, pointing at a laptop, and copying them
 *   would point production there too. Set one of them deliberately, by hand.
 *
 * A secret's value is handed to `pulumi config set` on its standard input,
 * never as an argument, so it appears in no process list and no shell history.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The two lists from `./common/app-settings.ts`, read out of its source.
 *
 * Read rather than repeated, so there is one list; and read as text because
 * Node 20 cannot import TypeScript. `tests/app-settings.test.ts` holds what
 * this extracts to what that module exports.
 */
export function settingsLists(
  source = readFileSync(path.join(here, "common/app-settings.ts"), "utf8"),
) {
  const list = (name) => {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
    if (!match)
      throw new Error(`common/app-settings.ts no longer declares ${name} as this script reads it`);
    return [...match[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
  };
  return { server: list("SERVER_SETTINGS"), secret: list("SECRET_SETTINGS") };
}

/** Names left out on purpose, with the reason printed beside each. */
export const LEFT_OUT = {
  APP_BASE_URL: "decided by simple-balance:hostname",
  ALLOWED_EMAILS: "set simple-balance:allowedEmails instead",
  NODE_ENV: "the image sets production",
  PORT: "the deployment decides its own port",
  RECURRENCE_SCHEDULER: "the deployment decides where the schedule runs",
  TRUST_PROXY:
    "decided by what is in front of the app, which the deployment knows and a .env does not",
  DATABASE_URL: "where the database is, not how the app behaves; set it by hand if you mean it",
  DIRECT_DATABASE_URL:
    "where the database is, not how the app behaves; set it by hand if you mean it",
  AUTH_SECRET: "generated on the machine, or simple-balance:authSecret on a cluster",
  SETUP_TOKEN: "generated at first start, or simple-balance:setupToken on a cluster",
};

/** `NAME=value` lines, literally, with one pair of matching quotes removed. */
export function parseEnvFile(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    entries.push([match[1], value]);
  }
  return entries;
}

/** What to set and what to leave, decided from the file alone. */
export function plan(entries, lists = settingsLists()) {
  const server = new Set(lists.server);
  const secret = new Set(lists.secret);
  const set = [];
  const skipped = [];
  for (const [name, value] of entries) {
    if (!server.has(name)) {
      skipped.push([name, "not a setting the application reads"]);
    } else if (name in LEFT_OUT) {
      skipped.push([name, LEFT_OUT[name]]);
    } else if (value === "") {
      skipped.push([name, "empty, which is the same as unset"]);
    } else {
      set.push({ name, value, secret: secret.has(name) });
    }
  }
  return { set, skipped };
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return false;
    args.splice(at, 1);
    return true;
  };
  const option = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    return value;
  };
  const dryRun = flag("--dry-run");
  const stack = option("--stack");
  const [program, file = ".env"] = args;
  if (!program || !existsSync(path.join(program, "Pulumi.yaml"))) {
    console.error(
      "usage: settings-from-env.mjs <program directory> [.env file] [--stack <name>] [--dry-run]",
    );
    console.error(
      "  <program directory> is the one holding Pulumi.yaml, such as deploy/pulumi/oci-single.",
    );
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`settings-from-env: ${file} does not exist`);
    process.exit(2);
  }

  const { set, skipped } = plan(parseEnvFile(readFileSync(file, "utf8")));
  for (const [name, why] of skipped) console.log(`  skip  ${name}: ${why}`);
  for (const { name, value, secret } of set) {
    const key = `simple-balance:${secret ? "secrets" : "env"}.${name}`;
    console.log(`  ${secret ? "secret" : "set   "} ${key}`);
    if (dryRun) continue;
    const result = spawnSync(
      "pulumi",
      [
        "-C",
        program,
        "config",
        "set",
        ...(stack ? ["--stack", stack] : []),
        ...(secret ? ["--secret"] : []),
        "--path",
        key,
      ],
      // The value on stdin: Pulumi reads it from there when the command line
      // has none, and a secret on the command line would be in `ps`.
      { input: value, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.status !== 0) {
      console.error(`settings-from-env: pulumi config set ${key} failed`);
      process.exit(result.status ?? 1);
    }
  }
  console.log(
    dryRun
      ? `${set.length} to set, ${skipped.length} left out. Nothing was written (--dry-run).`
      : `${set.length} set, ${skipped.length} left out. Run pulumi up to apply them.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
