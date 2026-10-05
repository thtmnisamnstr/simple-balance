import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * AGENTS.md: postings are append-only. A correction appends the difference;
 * nothing updates a posting, and the only delete is `deleteAccount` taking an
 * unused account's opening and closing pairs with it, because nothing else
 * refers to them and the account row cannot go while they do.
 *
 * Read from the source rather than asserted per service, because the defect
 * this stops is a new write path — a mass edit, a merge — that reaches for
 * `.update(postings)` to "fix" a figure, and that path does not exist yet.
 */
const SOURCES = globSync("src/server/**/*.ts");

function writes(pattern: RegExp) {
  const found: { file: string; line: number; inside: string }[] = [];
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(0, match.index);
      const inside = [...before.matchAll(/(?:export )?async function (\w+)/g)].at(-1)?.[1] ?? "?";
      found.push({ file, line: before.split("\n").length, inside });
    }
  }
  return found;
}

describe("a posting", () => {
  it("is never updated", () => {
    const updates = writes(/\.update\(\s*postings\s*\)|\bupdate\s+posting\b/gi);
    expect(updates.map((one) => `${one.file}:${one.line} in ${one.inside}`)).toEqual([]);
  });

  it("is deleted only by deleteAccount, which takes an unused account's pairs with it", () => {
    const deletes = writes(/\.delete\(\s*postings\s*\)|\bdelete\s+from\s+posting\b/gi);
    expect(deletes.map((one) => `${one.file} in ${one.inside}`)).toEqual([
      "src/server/services/accounts.ts in deleteAccount",
    ]);
  });
});
