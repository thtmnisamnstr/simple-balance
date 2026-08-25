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

/** For tests, and for the startup path that reads configuration twice. */
export function resetLogLevel() {
  configured = undefined;
}
