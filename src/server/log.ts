import { getConfig } from "./config.js";

/**
 * Everything this product writes to stdout, at the level an operator asked for.
 *
 * `LOG_LEVEL` existed before this file did and reached exactly one consumer:
 * Better Auth's own logger. This product's own thirty-one `console` calls
 * ignored it, so `LOG_LEVEL=error` still printed the startup banner, the mail
 * notice and the scheduler's warnings. A setting that governs somebody else's
 * logging and not your own is worse than no setting, because the log looks like
 * the answer to a question that was never asked.
 *
 * Levels are the four `LOG_LEVEL` already accepts, and nothing invents a fifth.
 * `error` is never silenced: it is the top of the order, so the quietest
 * setting still reports what went wrong.
 *
 * Sentences, not JSON. `docs/standards/operations.md` treats a log line as
 * something a person reads while a container refuses to start, and every line
 * this repository writes was written that way; the machine-readable half of
 * observability is `/metrics`, which is a better shape for it than a log a
 * human has to reread through `jq`.
 */
const ORDER = ["debug", "info", "warn", "error"] as const;

type Level = (typeof ORDER)[number];

/**
 * Read once, on the first line logged rather than at import.
 *
 * A module-level `getConfig()` would refuse an unconfigured environment as a
 * side effect of importing anything that logs, which is a failure with no
 * relation to what the caller was doing. Memoised because a scheduler tick logs
 * on a timer and re-parsing the environment on every line is work for nobody.
 */
let configured: Level | undefined;

function threshold(): Level {
  if (configured === undefined) {
    try {
      configured = getConfig().logLevel;
    } catch {
      // Configuration that has not been read yet, or cannot be. The line still
      // has to come out: this path is how a startup failure gets reported at
      // all, and swallowing it would leave a container exiting in silence.
      return "debug";
    }
  }
  return configured;
}

const enabled = (level: Level) => ORDER.indexOf(level) >= ORDER.indexOf(threshold());

export const log = {
  /**
   * A line the operator cannot do their job without, at any level.
   *
   * Not a fifth level and not a synonym for `info`: this is for the handful of
   * lines that are the product's only channel for something somebody has to
   * have. The first-run setup code is the whole of it — a fresh production
   * instance prints a one-time code and there is nowhere else to read it, so
   * `LOG_LEVEL=warn` turned a supported setting into a deployment that cannot
   * be claimed. The startup banner is not here: nobody is locked out by not
   * knowing which port was logged.
   *
   * `tests/log-level.test.ts` holds the call sites, so this stays two lines
   * rather than becoming the level everything is written at.
   */
  announce(...parts: unknown[]) {
    console.info(...parts);
  },
  /**
   * A failure, with the part of it an operator must not be handed.
   *
   * Drizzle builds an error's message out of the failing SQL *and its bound
   * parameters*, and one of those parameters is the OAuth access token the MCP
   * token endpoint looks a grant up by. Logging such an error whole writes a
   * live credential into the log on any database hiccup — and the parameters of
   * an ordinary ledger query are somebody's payees and amounts, which is the
   * same rule one notch less alarming.
   *
   * The statement is what an operator needs and the values are not, so this
   * keeps the first and drops the second. It lives here rather than at either
   * transport because `api.ts` had it and `mcp.ts` did not: the HTTP path
   * narrowed the error and the agent path logged it whole, which is one
   * transport quietly holding a rule the other one keeps.
   */
  failure(context: string, error: unknown) {
    const query = (error as { query?: unknown } | null)?.query;
    if (typeof query === "string") {
      // The cause where there is one, and the class name where there is not:
      // both say what went wrong without repeating the statement's arguments.
      const cause = (error as { cause?: unknown }).cause;
      log.error(`${context}: ${query}`, cause ?? (error as { name?: unknown })?.name);
      return;
    }
    log.error(context, error);
  },
  debug(...parts: unknown[]) {
    if (enabled("debug")) console.debug(...parts);
  },
  info(...parts: unknown[]) {
    if (enabled("info")) console.info(...parts);
  },
  warn(...parts: unknown[]) {
    if (enabled("warn")) console.warn(...parts);
  },
  error(...parts: unknown[]) {
    if (enabled("error")) console.error(...parts);
  },
};

/**
 * For tests, which set `LOG_LEVEL` and then import this module again.
 *
 * Nothing in `src` calls it: the memo is per process and a process reads its
 * configuration once. It said "and for the startup path that reads
 * configuration twice", which named a caller that does not exist and made the
 * export look load-bearing.
 */
export function resetLogLevel() {
  configured = undefined;
}
