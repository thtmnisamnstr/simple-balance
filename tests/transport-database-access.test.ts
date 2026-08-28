import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/services.md` 1.2: a route parses, calls one service
 * function, and serialises.
 *
 * The rule's own test for whether a line is in the wrong place is "would the
 * MCP and the HTTP API both need it?", and that question cannot be asked of a
 * line by a program. What can be asked is the thing that goes wrong when the
 * rule is broken: a transport reaching for the database on its own. Every
 * ledger read and write already goes through `src/server/services`, so a query
 * in `api.ts` or `mcp.ts` is either one of the five below or a decision that
 * has escaped the layer both surfaces share.
 *
 * The five are listed with the reason each is not that. None of them is
 * bookkeeping: two are Better Auth's own tables behind the consent screen,
 * which is reachable from a session and has no MCP counterpart, one is the
 * readiness probe, one is the first-account lock that `AGENTS.md` requires to
 * live outside the application pool, and one is the transaction an MCP tool
 * call is made idempotent inside.
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
    snippet: "getDb().execute(sql`select 1`)",
    because:
      "The readiness probe. Whether the pool answers is a question about this process, " +
      "and there is no service function that would mean anything.",
  },
  {
    file: "src/server/api.ts",
    snippet: "getAuthBootstrapLockPool().connect()",
    because:
      "The first-account claim's advisory lock, which AGENTS.md requires to be serialised " +
      "outside the application pool — the pool it would otherwise take the last connection of.",
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

/** A line that reaches the database rather than a service. */
const REACHES_DATABASE =
  /\bgetDb\(\)|\bgetPool\(\)|getAuthBootstrapLockPool\(\)|\bdb\.(?:select|insert|update|delete|execute|transaction)\b/;

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

  it("reaches the database only where somebody has said why", () => {
    const unexplained: string[] = [];
    for (const file of transports) {
      const lines = file.code.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!REACHES_DATABASE.test(line)) continue;
        // A query is spread over the lines that build it, and what identifies
        // it is usually the column list rather than the `getDb()` that opens
        // it. So the statement is the matched line and the few after it, which
        // is enough to reach a `select({ … })` and short enough that the next
        // statement cannot vouch for this one.
        const statement = lines.slice(index, index + 6).join("\n");
        const covered = ALLOWED.some(
          (entry) => entry.file === file.path && statement.includes(entry.snippet),
        );
        // The line is reported as written rather than as blanked, so a failure
        // can be pasted into a search.
        if (!covered)
          unexplained.push(`${file.path}:${index + 1} ${file.text.split("\n")[index]?.trim()}`);
      }
    }
    expect(
      unexplained,
      "A transport is querying the database. If both surfaces would need it, it belongs in " +
        "src/server/services. If it is genuinely transport plumbing, add it to ALLOWED with " +
        "the reason, and say so in docs/standards/code/services.md 1.2.",
    ).toEqual([]);
  });

  it("still has every line the list claims", () => {
    // The other direction: an entry left behind after its line went is a reason
    // nobody can check, and the next reader has to guess whether it is stale.
    for (const entry of ALLOWED) {
      const file = transports.find((candidate) => candidate.path === entry.file);
      expect(file?.code, `${entry.file} is not one of the transports`).toBeDefined();
      expect(file!.code, `${entry.file} no longer contains ${entry.snippet}`).toContain(
        entry.snippet,
      );
    }
  });
});
