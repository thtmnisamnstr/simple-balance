import { readFileSync } from "node:fs";

/**
 * The variables that also answer to a `NAME_FILE` form.
 *
 * This list is the definition of what this product calls a secret: if a name
 * has a `_FILE` form it is a secret, and if it does not it is a setting. Seven
 * rather than the four `docs/standards/operations.md` first named, because the
 * litmus runs both ways. `SETUP_TOKEN` is the code that claims an unclaimed
 * deployment and `DIRECT_DATABASE_URL` carries a password, so a list of four
 * would have been this file quietly calling both of them settings.
 * `METRICS_TOKEN` is the seventh and joined for the same reason: it is the only
 * thing standing between a scrape endpoint and anybody who can reach the port.
 */
export const FILE_BACKED_SECRETS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "SMTP_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "SETUP_TOKEN",
  "METRICS_TOKEN",
] as const;

export type FileBackedSecret = (typeof FILE_BACKED_SECRETS)[number];

/**
 * Resolved once, held here, and never written back into `process.env`.
 *
 * Cleared by `vi.resetModules()` and by nothing else. There is deliberately no
 * exported reset: a production module carrying a hatch that only a test uses is
 * a hatch something else eventually calls, and the tests already re-import this
 * module for every case.
 */
let resolved: ReadonlyMap<FileBackedSecret, string> | undefined;

/**
 * Reads every `NAME_FILE` that is set, once per process.
 *
 * The resolved values stay in this map and are handed out by `readSecret`. They
 * are never assigned back into `process.env`, for two reasons, and the second is
 * the load-bearing one.
 *
 * A Node diagnostic report serialises `process.env` as it stands when the report
 * is written, and `kubectl describe pod` and `kubectl exec -- env` show it too.
 * A value that never enters the environment cannot appear in any of them, which
 * is the whole reason an operator reached for the `_FILE` form.
 *
 * And a resolver that writes into the environment has to run before anything
 * reads it, which is an ordering requirement nobody can see. `getPool` and
 * `directConnectionString` read the connection string themselves, and
 * `npm run db:migrate` never calls `getConfig` at all, so a write-back design
 * needs a second call site bolted onto that script and a third onto whatever
 * entrypoint is added next. Resolving on first read removes the ordering
 * entirely, and `db/migrate.ts` needs no knowledge of this file.
 */
/**
 * Said once per process. `resolveFileBackedSecrets` memoises, so this only
 * repeats across a `vi.resetModules()` in tests, but the set costs nothing and
 * makes the intent plain.
 */
const warned = new Set<string>();

function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

export function resolveFileBackedSecrets(): ReadonlyMap<FileBackedSecret, string> {
  if (resolved) return resolved;
  const found = new Map<FileBackedSecret, string>();
  for (const name of FILE_BACKED_SECRETS) {
    const path = process.env[`${name}_FILE`]?.trim();
    if (!path) continue;
    const direct = process.env[name];
    // Non-empty rather than truthy. `.env.example` ships `AUTH_SECRET=` and
    // `deploy/compose/compose.distributed.yml` ships `SETUP_TOKEN: ${SETUP_TOKEN:-}`,
    // so a truthiness check here would treat a blank a deployment has always set
    // as a value it meant.
    if (typeof direct === "string" && direct !== "") {
      // The environment wins, and it warns rather than refusing.
      //
      // A precedence rule really does mean somebody eventually changes the value
      // that has no effect, and refusing is the clean answer to that — but not
      // here, and not on this release. These `_FILE` names did nothing at all in
      // 0.1.5, so a deployment that set one out of habit from the PostgreSQL
      // official image has been running with the environment variable in force
      // all along. Refusing would stop that deployment on upgrade, over a
      // variable that has never once been read.
      //
      // So the environment keeps winning, which is exactly what happened before,
      // and the warning names the file being ignored. That turns a silent
      // precedence rule into a loud one without taking anybody's ledger down for
      // it.
      warnOnce(
        `${name} and ${name}_FILE are both set. ${name} is being used and the file is ignored, ` +
          `which is what happened before ${name}_FILE did anything. Remove one of the two: ` +
          "keeping both means a change to the file will look like it worked and will not have.",
      );
      continue;
    }
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (cause) {
      // Loudly, and at startup. Falling back to the environment here would hand
      // a deployment whose secret file failed to mount the development default
      // instead, which is a server that comes up signing sessions with a key
      // everybody has.
      throw new Error(`${name}_FILE names ${path}, which could not be read.`, { cause });
    }
    // One trailing newline, and nothing else. `printf` and a Kubernetes secret
    // volume write none; `echo` and every text editor write one. A password may
    // legitimately end in a space, and `config.ts` stores `authSecret`
    // untrimmed, so the difference between stripping one newline and calling
    // `trim()` is a different session-signing key for the same secret typed two
    // ways.
    const value = contents.replace(/\r?\n$/, "");
    if (value === "") {
      throw new Error(`${name}_FILE names ${path}, which is empty.`);
    }
    found.set(name, value);
  }
  resolved = found;
  return resolved;
}

/**
 * The value of a secret, from its file if it has one and from the environment
 * otherwise.
 *
 * Every reader of these six names goes through here rather than through
 * `process.env`, which is what lets the resolve be lazy: whichever reader runs
 * first pays for it, and no entrypoint has to remember to prime anything.
 */
export function readSecret(name: FileBackedSecret): string | undefined {
  return resolveFileBackedSecrets().get(name) ?? process.env[name];
}
