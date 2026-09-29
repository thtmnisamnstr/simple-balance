import { getConfig, logLevels, type LogLevel } from "./config.js";

/**
 * Everything this product writes to stdout, at the level an operator asked for.
 *
 * `LOG_LEVEL` existed before this file did and reached exactly one consumer:
 * Better Auth's own logger. This product's own thirty-one `console` calls
 * ignored it, so `LOG_LEVEL=error` still printed the startup banner, the mail
 * notice and the scheduler's warnings. A setting that governs somebody else's
 * logging and not your own is worse than no setting. Better Auth now logs
 * through here too (`fromLibrary`), and an error escaping one of its routes
 * reaches `failure` (`authReporting` in `auth.ts`), so one gate decides for
 * both. Not quite every line: a few notices about the library's own setup go
 * through a module-level logger of its own that no option reaches. None of
 * them carries anything from a request.
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
const ORDER = logLevels;

type Level = LogLevel;

/**
 * Read once, on the first line logged rather than at import.
 *
 * A module-level `getConfig()` would refuse an unconfigured environment as a
 * side effect of importing anything that logs, which is a failure with no
 * relation to what the caller was doing. Memoized because a scheduler tick logs
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
  /**
   * A line somebody else's code wrote, through this gate, with every email
   * address in it replaced.
   *
   * Better Auth logged on its own, to `console`, and at the default level it
   * wrote `Sign-up attempt for existing email: <the address>` for every sign-up
   * that named an account already here. That is a person's address, in a log
   * read by whoever operates the deployment, attached to the fact that they
   * have an account — which the sign-up response is careful never to say.
   *
   * Redacted rather than dropped, and everywhere rather than in that sentence.
   * Dropping the line means matching a library's wording, and the release that
   * rewords it puts the address back with nothing failing; it also loses the
   * one fact the line is worth, because a run of attempts on existing accounts
   * is what somebody probing for them looks like, and the response hides it.
   * Redacting by the address's shape holds whatever the library says, in any
   * line, and in whatever it hands along beside the line: another route passes
   * the whole profile a provider returned.
   *
   * `message` is `unknown` because the library's type says `string` and its
   * code does not. The OAuth sign-up path's catch hands over the error itself
   * (`logger.error(e)`), and that catch is the one a Google sign-up
   * `ALLOWED_EMAILS` turns away runs through. Read as a string it threw from
   * inside the library's own catch block, which turned the 401 the sign-in
   * screen explains into an empty 500 and lost the error being reported. So a
   * message that is not a string leads the parts instead, redacted like them.
   *
   * And nothing here may throw. A getter that throws, or a `toString` that
   * does, becomes a line saying so, because a logger that fails inside somebody
   * else's error handling replaces their failure with its own.
   */
  fromLibrary(source: string, level: Level, message: unknown, ...parts: unknown[]) {
    let line: unknown[];
    try {
      line =
        typeof message === "string"
          ? [`[${source}] ${withoutAddresses(message)}`, ...parts.map((part) => redacted(part))]
          : [`[${source}]`, ...[message, ...parts].map((part) => redacted(part))];
    } catch {
      line = [`[${source}] A line could not be logged without the risk of an address in it.`];
    }
    log[level](...line);
  },
};

/**
 * Anything shaped like an email address: a run with no space or `@` in it, an
 * `@`, then a domain. Delimiters that wrap an address in prose — brackets,
 * quotes, a comma — stop it, and so does a sentence's final period, so the line
 * around it still reads. So does a slash, which no address holds and every
 * path does: without it a stack frame under `node_modules/@better-auth/core`
 * read as an address, and the frame lost the file it names.
 *
 * Linear, and it has to be, because part of what it reads is the request. The
 * social sign-in route logs the provider name it was sent, which can be any
 * string up to the 64 KiB the auth body limit lets through. Unanchored, every
 * start inside a run with no `@` in it scanned to the end of that run before
 * failing, which is quadratic: 63 KiB held the one thread for 2.4 seconds, and
 * a few of those a second from one address is a server that answers nobody.
 * The lookbehind lets a match begin only where a run does, so a run is read
 * once as a local part and at most once more as a domain.
 *
 * Anchored rather than bounded. `{1,64}` before the `@` is linear too, and it
 * leaves the front of any local part longer than 64 characters in the line:
 * an address RFC 5321 refuses is still somebody's.
 */
const ADDRESS =
  /(?<![^\s@<>()[\]{}"'`,;:/])[^\s@<>()[\]{}"'`,;:/]+@[^\s@<>()[\]{}"'`,;:/]*[^\s@<>()[\]{}"'`,;:/.]/g;

/**
 * The most of any one string a library line carries. A statement, a message
 * and a ten-frame stack fit with room over; what does not is somebody's
 * request body echoed back, and the log is not where that belongs.
 */
const LONGEST_PART = 4096;

/**
 * Cut after redacting and never before. Cutting first can end the string just
 * past an address's `@`, and the local part left behind no longer looks like an
 * address to anything.
 */
function withoutAddresses(text: string) {
  const redactedText = text.replace(ADDRESS, "[email address]");
  if (redactedText.length <= LONGEST_PART) return redactedText;
  const cut = redactedText.length - LONGEST_PART;
  return `${redactedText.slice(0, LONGEST_PART)} [${cut} more characters]`;
}

/**
 * A copy of what a library passed beside its message, with the addresses gone.
 *
 * Strings are rewritten, arrays and plain objects copied through, and an error
 * rebuilt from its redacted message and stack — except a failed query, which
 * becomes its statement and its cause's message, the rule `failure` keeps: its
 * own message carries the bound parameters, and an address is only one of the
 * things those hold. Anything else becomes its redacted string, because a class
 * this cannot see inside is one it cannot vouch for. Bounded in depth, and each
 * object is copied once, because a library's context object can be deep or
 * refer back to itself.
 */
function redacted(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return withoutAddresses(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[repeated]";
  if (depth > 4) return "[nested]";
  seen.add(value);
  if (value instanceof Error) {
    const query = (value as { query?: unknown }).query;
    if (typeof query === "string") {
      const cause = value.cause instanceof Error ? ` (${value.cause.message})` : "";
      return withoutAddresses(`${value.name}: ${query}${cause}`);
    }
    const copy = new Error(withoutAddresses(value.message));
    copy.name = value.name;
    // Its own stack, not the copy's, which would point here.
    copy.stack = withoutAddresses(value.stack ?? `${value.name}: ${value.message}`);
    if (value.cause !== undefined) copy.cause = redacted(value.cause, depth + 1, seen);
    return copy;
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item, depth + 1, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    // The keys too: a lookup keyed by address is still a list of addresses.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        withoutAddresses(key),
        redacted(item, depth + 1, seen),
      ]),
    );
  }
  return withoutAddresses(String(value));
}

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
