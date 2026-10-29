import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/services.md` 1.2: a route parses, calls one service
 * function, and serializes.
 *
 * The rule's own test for whether a line is in the wrong place is "would the
 * MCP and the HTTP API both need it?", and that question cannot be asked of a
 * line by a program. What can be asked is the thing that goes wrong when the
 * rule is broken: a transport reaching for the database on its own. Every
 * ledger read and write already goes through `src/server/services`, so a query
 * in `api.ts` or `mcp.ts` is either one of the six below or a decision that
 * has escaped the layer both surfaces share.
 *
 * The six are four things, listed with the reason each is not that. None of
 * them is bookkeeping: two are Better Auth's own tables behind the consent
 * screen, which is reachable from a session and has no MCP counterpart, one is
 * the first-account lock that `AGENTS.md` requires to live outside the
 * application pool — three lines, the connection and the two statements taken
 * on it — and one is the transaction an MCP tool call is made idempotent
 * inside. The readiness probe's `select 1` was a fifth until it moved to
 * `src/server/readiness.ts`, which both entrypoints share and which is not a
 * transport.
 *
 * Matching is by a snippet of the line rather than by line number, so ordinary
 * edits above them do not fail this.
 *
 * `getPool()` is in the pattern beside `getDb()` because `src/server/db/client.ts`
 * exports both, and a transport reaching for the pool directly is the same
 * defect one level lower: it would have walked past this check while doing
 * exactly what the check exists to catch.
 */
const ALLOWED = [
  {
    file: "src/server/api.ts",
    snippet: "getAuthBootstrapLockPool().connect()",
    because:
      "The first-account claim's advisory lock, which AGENTS.md requires to be serialized " +
      "outside the application pool — the pool it would otherwise take the last connection of.",
  },
  {
    file: "src/server/api.ts",
    snippet: "select pg_try_advisory_lock($1) as acquired",
    because:
      "The same lock, taken on the connection the entry above opened. An entry of its own " +
      "because a line is vouched for from itself downwards, never by the line above it.",
  },
  {
    file: "src/server/api.ts",
    snippet: "select pg_advisory_unlock($1)",
    because: "The same lock, released on the same connection.",
  },
  {
    file: "src/server/api.ts",
    snippet: "value: verification.value",
    because:
      "The pending authorize request, as Better Auth stored it. The consent screen is " +
      "reachable from a session and never from a token, so no MCP surface needs this.",
  },
  {
    file: "src/server/api.ts",
    snippet: "name: oauthApplication.name",
    because: "The client's display name for the same screen, from the same library's table.",
  },
  {
    file: "src/server/mcp.ts",
    snippet: "getDb().transaction(async (tx) =>",
    because:
      "The transaction a tool call is made idempotent inside. It opens one and hands `tx` " +
      "to the service helpers; the deciding is all theirs.",
  },
] as const;

/** A line that opens a handle on the database rather than calling a service. */
const OPENS_DATABASE = /\bgetDb\(\)|\bgetPool\(\)|getAuthBootstrapLockPool\(\)/;

/**
 * Every Drizzle builder, and every raw statement, on whatever receiver.
 *
 * The pattern this replaced named `db.` and nothing else, so a builder reached
 * through a transaction handle — `tx.select(`, `tx.execute(`, or the same on
 * whatever name a callback binds the transaction to — walked past it. That is
 * the shape a query takes inside the one transaction `mcp.ts` is allowed to
 * open, which made it the likeliest escape and the one the check could not see.
 * It could not see `client.query(` either, which is how the bootstrap lock
 * talks to PostgreSQL, and why the lock is three entries above rather than one.
 *
 * So the receiver is not part of the match. A method name is, and the leading
 * dot: a chained `.select(` on a line of its own has no receiver on that line at
 * all, which is the commonest way a Drizzle query is formatted here.
 */
const BUILDER =
  /\.\s*(?:select|selectDistinct|selectDistinctOn|insert|update|delete|execute|transaction|query|batch|with|\$with|\$count|refreshMaterializedView)\s*(?:<[^>]*>)?\s*\(|\.query\.\w+\.find(?:First|Many)\s*\(/g;

/**
 * Receivers whose methods share a builder's name and touch no database.
 *
 * Matched exactly, so a new receiver is reported rather than guessed at: a
 * false alarm here costs one line in this list, and a guess costs the check.
 */
const NOT_A_DATABASE = [
  {
    receiver: "app",
    because: "The Hono application. `app.delete(` registers a route; it deletes nothing.",
  },
  {
    receiver: "c.req",
    because: "Hono's request. `c.req.query(` reads the query string a client sent.",
  },
  {
    receiver: "headers",
    because: "A `Headers` object. `headers.delete(` drops a header from a response.",
  },
] as const;

/** The receiver a call on this line was made on, or `""` for a chained one. */
const receiverBefore = (line: string, at: number) =>
  /([\w$]+(?:\(\))?(?:\s*\.\s*[\w$]+(?:\(\))?)*)\s*$/.exec(line.slice(0, at))?.[1] ?? "";

describe("a transport", () => {
  const transports = sourceFiles("src/server").filter((file) =>
    /src\/server\/(?:api|mcp)\.ts$/.test(file.path),
  );

  it("is reading the two files it is supposed to be reading", () => {
    expect(transports.map((file) => file.path).sort()).toEqual([
      "src/server/api.ts",
      "src/server/mcp.ts",
    ]);
  });

  // Worked out once, because both directions below read the same answer.
  const excused = new Set<string>();
  const reaching = transports.flatMap((file) => {
    const lines = file.code.split("\n");
    return [...lines.entries()].flatMap(([index, line]) => {
      const builders = [...line.matchAll(BUILDER)].filter((call) => {
        const receiver = receiverBefore(line, call.index);
        if (!NOT_A_DATABASE.some((known) => known.receiver === receiver)) return true;
        excused.add(receiver);
        return false;
      });
      if (!OPENS_DATABASE.test(line) && builders.length === 0) return [];
      // A query is spread over the lines that build it, and what identifies
      // it is usually the column list rather than the `getDb()` that opens
      // it. So the statement is the matched line and the few after it, which
      // is enough to reach a `select({ … })` and short enough that the next
      // statement cannot vouch for this one.
      const statement = lines.slice(index, index + 6).join("\n");
      const entry = ALLOWED.find(
        (known) => known.file === file.path && statement.includes(known.snippet),
      );
      // The line is reported as written rather than as blanked, so a failure
      // can be pasted into a search.
      return [
        { where: `${file.path}:${index + 1} ${file.text.split("\n")[index]?.trim()}`, entry },
      ];
    });
  });

  it("reaches the database only where somebody has said why", () => {
    const unexplained = reaching.filter((line) => !line.entry).map((line) => line.where);
    expect(
      unexplained,
      "A transport is querying the database. If both surfaces would need it, it belongs in " +
        "src/server/services. If it is genuinely transport plumbing, add it to ALLOWED with " +
        "the reason, and say so in docs/standards/code/services.md 1.2.",
    ).toEqual([]);
  });

  /**
   * The other direction, and the scan's own proof that it still matches.
   *
   * This used to ask only whether each snippet was still in the file, which
   * stays true however blind the pattern becomes: a `REACHES_DATABASE` that
   * matched nothing would have passed both tests. Asking that each entry still
   * excuses a line the scan *found* is what fails when the matcher goes quiet,
   * and an entry left behind after its line went is a reason nobody can check.
   */
  it("still finds every line the list claims", () => {
    const stale = ALLOWED.filter((entry) => !reaching.some((line) => line.entry === entry)).map(
      (entry) => `${entry.file} ${entry.snippet}`,
    );
    expect(stale).toEqual([]);
    const unused = NOT_A_DATABASE.filter((known) => !excused.has(known.receiver)).map(
      (known) => known.receiver,
    );
    expect(unused, "a receiver nothing calls a builder-named method on any more").toEqual([]);
  });
});

/**
 * `AGENTS.md`: a rule the browser previews and the server enforces is one
 * function, in `src/shared`, or the preview eventually shows something the
 * server refuses. A transport adapter that writes a constraint of its own is
 * where that goes wrong first, because neither the browser nor the other
 * transport can reach it.
 *
 * It went wrong once already: the local-password route parsed
 * `z.string().min(12).max(128)` inline in `api.ts`, a third server copy of a
 * length the settings form hard-coded twice more, with Zod's default "Too
 * small: expected string to have >=12 characters" as its only sentence. The
 * schema lives in `src/shared/domain.ts` now and every reader takes its
 * numbers from there.
 *
 * So every Zod constraint written in `api.ts` or `mcp.ts` — a bound, a pattern,
 * a refinement, a closed set — is one of the few below, each with the reason
 * no browser previews it, and a new one fails until it moves to `src/shared` or
 * is argued here. Keyed by a snippet of the statement it sits in, not a line.
 */
const TRANSPORT_RULES = [
  {
    file: "src/server/api.ts",
    snippet: "const uuidPathSchema",
    because:
      "The id in a route's path, which nobody types: every id the browser sends came back " +
      "from a response. Its sentence says where a good one comes from.",
  },
  {
    file: "src/server/mcp.ts",
    snippet: "slug: z.string()",
    because:
      "A money guide's slug, a field only the agent surface has: a person reads the same " +
      "guides at smpl.money/learn and no page calls a route for them, so there is no " +
      "browser to preview anything for.",
  },
  {
    file: "src/server/mcp.ts",
    snippet: "clientId: z",
    because:
      "An id copied from `list_connected_agents`. The browser revokes by the path, and the " +
      "rule is the shape of an id rather than a rule anybody types against.",
  },
  {
    file: "src/server/mcp.ts",
    snippet: "Choose at least one preference to change",
    because:
      "The service's own rule — a patch names at least one preference — said again in the " +
      "tool's published input schema so an agent can read it before calling. The service " +
      "still enforces it for both surfaces, so this copy can only refuse earlier, never differently.",
  },
] as const;

const CONSTRAINT =
  /(?<!Math)\.(?:min|max|length|regex|refine|superRefine|email|url|uuid|int|positive|nonnegative|gte|lte|gt|lt)\s*\(|\bz\.(?:enum|literal)\s*\(/g;

describe("a rule a transport writes for itself", () => {
  const found = sourceFiles("src/server")
    .filter((file) => /src\/server\/(?:api|mcp)\.ts$/.test(file.path))
    .flatMap((file) =>
      [...file.code.matchAll(CONSTRAINT)].map((match) => {
        const lines = file.code.split("\n");
        const index = file.code.slice(0, match.index).split("\n").length - 1;
        // The statement around the call: a chained constraint sits lines
        // below the field it constrains, and a refinement's message lines
        // below the call.
        const statement = file.text
          .split("\n")
          .slice(Math.max(0, index - 3), index + 6)
          .join("\n");
        const entry = TRANSPORT_RULES.find(
          (known) => known.file === file.path && statement.includes(known.snippet),
        );
        return { where: `${file.path}:${index + 1} ${lines[index]?.trim()}`, entry };
      }),
    );

  it("is one somebody has argued no browser previews", () => {
    expect(
      found.filter((one) => !one.entry).map((one) => one.where),
      "Move the schema to src/shared, so the form and the other transport read the same rule, " +
        "or add it to TRANSPORT_RULES with the reason nothing previews it.",
    ).toEqual([]);
  });

  it("still finds every rule the list argues", () => {
    const stale = TRANSPORT_RULES.filter((entry) => !found.some((one) => one.entry === entry));
    expect(stale.map((entry) => `${entry.file} ${entry.snippet}`)).toEqual([]);
  });
});
