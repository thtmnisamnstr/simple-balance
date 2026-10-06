import { describe, expect, it } from "vitest";
import {
  accountCreateSchema,
  categoryCreateSchema,
  categoryGroupCreateSchema,
  transactionTemplateBulkPatchSchema,
} from "../src/shared/domain.js";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/errors.md` 3.3, Binding: "A Zod message is the one
 * somebody wrote." The client shows a schema's own sentence in preference to
 * the envelope, so a field that leaves its length rules to Zod shows a person
 * "Too small: expected string to have >=1 characters" — which is what typing a
 * space into the Categories add box produced, because the name is trimmed
 * before it is measured. Nineteen request schemas fell back that way.
 *
 * Read from the source, because the defect is a call with no message and that
 * is a shape: a `.min(…)` or `.max(…)` with one argument on a `z.string()`.
 */
const domain = sourceFiles("src/shared").find((file) => file.path === "src/shared/domain.ts")!;

/** Never a refusal anybody reads: each is an output schema describing a reply. */
const OUTPUT_ONLY: Record<string, string> = {
  "name: z.string().min(1).max(500),": "payeeSummarySchema, a list reply",
  "normalizedName: z.string().min(1).max(500),":
    "payeeSummarySchema and payeeDuplicateGroupSchema, both list replies",
};

describe("a free-text field's refusal", () => {
  it("is a sentence somebody wrote, on every string that measures its length", () => {
    const bare = domain.code
      .split("\n")
      .map((line, index) => ({ line: line.trim(), at: index + 1 }))
      .filter(({ line }) => /z\.string\(\)/.test(line) && /\.(min|max)\([^,()]*\)/.test(line))
      .filter(({ line }) => !(line in OUTPUT_ONLY))
      .map(({ line, at }) => `src/shared/domain.ts:${at} ${line.slice(0, 80)}`);
    expect(bare, "pass enter(…) or atMost(…) beside the number").toEqual([]);
  });

  it("keeps its exceptions to lines that still exist", () => {
    for (const line of Object.keys(OUTPUT_ONLY)) expect(domain.code).toContain(line);
  });

  it("reads as an instruction at the two ends a person reaches", () => {
    const message = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
      result.error!.issues[0]!.message;
    expect(message(categoryCreateSchema.safeParse({ name: " " }))).toBe("Enter a category name");
    expect(message(categoryGroupCreateSchema.safeParse({ name: "" }))).toBe("Enter a group name");
    expect(
      message(accountCreateSchema.pick({ name: true }).safeParse({ name: "x".repeat(121) })),
    ).toBe("An account name must be 120 characters or fewer");
    expect(message(transactionTemplateBulkPatchSchema.safeParse({ notes: "" }))).toMatch(
      /Send null to clear/,
    );
  });
});
