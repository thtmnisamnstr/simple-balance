import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import frozen from "./support/frozen-migrations.json" with { type: "json" };
import { repoRoot } from "./support/source.js";

/**
 * `AGENTS.md`: every migration that has shipped is frozen. "Never edit or
 * regenerate one: someone's database has already run it."
 *
 * `tests/migrations.test.ts` holds the list of names to what is on disk and to
 * `AGENTS.md`, and that was the whole of the check: a frozen file's *body* could
 * change and every test stayed green, which is the exact failure the rule is
 * about. drizzle's migrator runs a file only where the recorded timestamp is
 * older than the folder's and never compares the hash, so a database that ran
 * the old body records the new one as done and fails at the first read of
 * whatever moved, with nothing at startup to say so.
 *
 * So each frozen file is held to the SHA-256 of the bytes that shipped, and to
 * its journal `when`, which is the other half of what the migrator reads.
 * `tests/support/frozen-migrations.json` was written from the `v0.2.0` tag, not
 * from the working tree, so it records what shipped rather than what is here.
 * `cut-release` appends the release's new files when it freezes them.
 */
const DRIZZLE = path.join(repoRoot, "drizzle");
const journal = JSON.parse(readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string; when: number }[];
};
const register = frozen as Record<string, { sha256: string; when: number }>;

describe("a migration that has shipped", () => {
  it("is byte for byte what shipped", () => {
    const changed = Object.entries(register)
      .filter(([file, { sha256 }]) => {
        const body = readFileSync(path.join(DRIZZLE, file));
        return createHash("sha256").update(body).digest("hex") !== sha256;
      })
      .map(([file]) => file);
    expect(changed, "add a migration rather than editing one that has run").toEqual([]);
  });

  it("keeps the timestamp the migrator compares", () => {
    const when = new Map(journal.entries.map((entry) => [`${entry.tag}.sql`, entry.when]));
    const moved = Object.entries(register)
      .filter(([file, entry]) => when.get(file) !== entry.when)
      .map(([file]) => file);
    expect(moved).toEqual([]);
  });

  it("is every file AGENTS.md names as frozen, and only those", () => {
    const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    const named = [...agents.matchAll(/`(\d{4}_[a-z0-9_]+\.sql)`/g)].map((match) => match[1]!);
    expect(new Set(named).size).toBeGreaterThan(20);
    expect(Object.keys(register).sort()).toEqual([...new Set(named)].sort());
  });
});
