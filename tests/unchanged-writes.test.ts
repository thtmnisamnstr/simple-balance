import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every service function that bumps a version compares before it writes.
 *
 * `AGENTS.md` (the postings bullet) and `docs/standards/code/services.md` §2.2:
 * an edit that changes nothing writes nothing, not even a new version. The
 * 0.2.0 sandbox smoke test found the rule held for postings alone — every
 * update rewrote its row and bumped its version whatever it had been sent — so
 * this derives its population from the product: any exported service function
 * whose body writes `version: … + 1` has to show one of the comparisons, or be
 * named below with the reason its writes always change something.
 * `tests/integration/unchanged-edits.integration.test.ts` is what proves the
 * comparisons are right; this is what stops a new update path forgetting one.
 */
const SERVICES = path.join(import.meta.dirname, "..", "src/server/services");

const ALWAYS_A_CHANGE: Record<string, string> = {
  mergeCategories: "rewrites only rows that name a category being merged away, so each one moves",
  mergePayees: "rewrites only rows that carry a payee being merged away, so each one moves",
  deleteStages: "takes rows still in the queue out of it, which changes their status",
  commitStages: "turns queued rows into transactions, which changes their status",
};

/**
 * Any `version: <something> + 1`, and the SQL spelling. It named the six
 * operands it had met, so `existing.version + 1` — four writes in the category
 * and import services — bumped a version and was never asked to compare.
 */
const BUMP = /version:\s*[A-Za-z_$][\w$.]*\s*\+\s*1\b|version:\s*sql`\$\{[\w.]+\.version\} \+ 1`/;
const COMPARES =
  /changesNothing\(|\(before\.(?:archivedAt|deletedAt) !== null\) ===|deletedAt === null\)|JSON\.stringify\(before\) !== JSON\.stringify/i;

function versionBumpingFunctions() {
  const found: { file: string; name: string; compares: boolean }[] = [];
  for (const file of readdirSync(SERVICES).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(path.join(SERVICES, file), "utf8");
    for (const part of source.split(/^export async function /m).slice(1)) {
      const name = /^(\w+)/.exec(part)![1]!;
      const body = part.split("\nexport ")[0]!;
      if (BUMP.test(body)) found.push({ file, name, compares: COMPARES.test(body) });
    }
  }
  return found;
}

describe("a write that bumps a version", () => {
  it("compares what it would store with what is stored first", () => {
    const missing = versionBumpingFunctions()
      .filter((one) => !one.compares && !(one.name in ALWAYS_A_CHANGE))
      .map((one) => `${one.file}: ${one.name}`);
    expect(missing).toEqual([]);
  });

  it("names an exception only for a function that still bumps without comparing", () => {
    const bumping = new Map(versionBumpingFunctions().map((one) => [one.name, one]));
    for (const name of Object.keys(ALWAYS_A_CHANGE)) {
      expect(bumping.get(name)?.compares, `${name} is still an exception`).toBe(false);
    }
  });

  it("finds the updates it is about", () => {
    const names = versionBumpingFunctions().map((one) => one.name);
    for (const name of ["updateTransaction", "updateAccount", "updateCategory", "updateStage"]) {
      expect(names).toContain(name);
    }
  });
});
