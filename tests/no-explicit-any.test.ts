import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/source.js";

/**
 * `docs/standards/code/typescript.md` 2.1: there is no `any` in `src`, and the
 * number to hold is zero.
 *
 * It was held by a sentence. `typescript/no-explicit-any` sits outside the
 * `correctness` category oxlint runs by default, so nothing failed if somebody
 * wrote one, and the sentence would have gone on saying zero.
 *
 * The linter is asked rather than the text, because the text cannot tell the
 * difference between a type and a word. `any` appears twice in `src` as prose —
 * "as good a name for the row as any" in `TemplatesPage.tsx` — and it appears in
 * forms a `: any` grep never sees: `as any`, `any[]`, `Record<string, any>`, a
 * bare `<any>` type argument. A parser finds all four and neither comment.
 *
 * The better home for this is a `deny` in `.oxlintrc.json`, which would fail
 * `npm run lint` a second earlier and cost nothing, since the count is zero.
 * This test does the same job from where a test can reach.
 */
const RULE = "typescript(no-explicit-any)";

type Diagnostic = {
  code?: string;
  filename?: string;
  labels?: { span?: { line?: number; column?: number } }[];
};

const explicitAnyIn = (target: string): string[] => {
  // A finding is a non-zero exit, so the status says nothing useful and the
  // parsed output is the whole signal. Same shape as `tests/lint-budget.test.ts`.
  let raw: string;
  try {
    raw = execFileSync(
      "npx",
      ["oxlint", "--format=json", "-D", "typescript/no-explicit-any", target],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    raw = String((error as { stdout?: string }).stdout ?? "");
  }
  const parsed = JSON.parse(raw) as { diagnostics?: Diagnostic[] };
  return (parsed.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code === RULE)
    .map((diagnostic) => {
      const span = diagnostic.labels?.[0]?.span;
      return `${diagnostic.filename}:${span?.line}:${span?.column}`;
    });
};

describe("the type `any`", () => {
  it("appears nowhere in src", () => {
    expect(explicitAnyIn("src"), "use `unknown` and narrow it with a Zod parse").toEqual([]);
  });

  /**
   * The check above passes today whether it works or not, which is the shape of
   * test `testing.md` 2.3 warns about. So it is also pointed at a file written
   * to fail it, in each of the four spellings the sentence it replaces could not
   * see. Outside the tree, because a fixture holding `any` inside `src` would be
   * the very thing the first case forbids.
   */
  it("is found in every spelling, not only `: any`", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "simple-balance-any-"));
    try {
      const fixture = path.join(directory, "probe.ts");
      writeFileSync(
        fixture,
        [
          "// The word any, in prose, is not a type.",
          "export const annotated = (value: any) => value;",
          "export const asserted = (value: unknown) => value as any;",
          "export const collection: any[] = [];",
          "export const record: Record<string, any> = {};",
          "",
        ].join("\n"),
      );
      expect(explicitAnyIn(fixture)).toHaveLength(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
