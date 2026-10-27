import { describe, expect, it } from "vitest";
import {
  accountCreateSchema,
  categoryCreateSchema,
  categoryGroupCreateSchema,
  preferencesSchema,
  transactionTemplateBulkPatchSchema,
} from "../src/shared/domain.js";
import { ledgerFileAddInputSchema } from "../src/shared/ledger-file-import.js";
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
 * is a shape: a `.min(…)`, `.max(…)` or `.length(…)` with one argument
 * anywhere in a chain that starts at `z.string()`. The whole chain, across
 * lines: it read one line at a time, and every chain written a call to a line
 * — which is how oxfmt writes a long one — went past it, the add's `fileName`
 * and the timezone among them.
 */
/**
 * Found rather than listed (`testing.md` 2.6). This read five named files in
 * `src/shared`, so a schema split into a sixth, or written in a service or a
 * transport — the local-password route's, inline in `api.ts` — fell outside it
 * while the check stayed green. Every module under `src` that builds a string
 * schema is read, apart from the two that never build a request.
 */
const NOT_A_REQUEST: Record<string, string> = {
  "src/server/config.ts":
    "The process environment, read once at startup by the operator rather than typed into a form.",
  "src/server/learn/pack.ts":
    "The vendored learn pack, validated against a file this repository ships.",
};
const files = sourceFiles("src").filter(
  (file) => /\bz\s*\.\s*string\s*\(/.test(file.code) && !(file.path in NOT_A_REQUEST),
);

/**
 * A bare chain that nobody's refusal ever shows, by file, the name it is
 * declared under and its bare calls, each with the reason.
 */
const NEVER_READ: Record<string, string> = {
  "src/shared/domain.ts name min(1) max(500)": "payeeSummarySchema, describing a list reply.",
  "src/shared/domain.ts normalizedName min(1) max(500)":
    "payeeSummarySchema and payeeDuplicateGroupSchema, both describing list replies.",
  "src/shared/domain.ts idempotencyKeySchema min(8) max(200)":
    "A key a client generates, never one a person types; the browser makes a UUID.",
  "src/shared/domain.ts cursor min(1) max(500)":
    "The audit and list cursors: a resume token the server handed out, sent back as it came.",
  "src/shared/domain.ts setupIntentId min(1) max(255)":
    "The id Stripe's own script gives the browser, never typed.",
  "src/shared/csv.ts cursor min(1) max(500)": "The import-batch list's resume token, the same.",
  "src/shared/csv.ts date min(1)":
    "A CSV mapping's column heading, which the page picks from the file's header line.",
  "src/shared/csv.ts payee min(1)": "The same, for the payee column.",
  "src/shared/csv.ts csv min(1)":
    "The file's whole text, which the page reads from the file somebody picks.",
  "src/shared/csv.ts categoryName min(1) max(120)":
    "A leg read back from a CSV's legs column by `parseExportedLegs`, which answers null on any failure and shows no message.",
  "src/server/mcp.ts slug min(1) max(80)":
    "A guide's slug, which an agent copies from `list_learn_articles` and nobody types.",
  "src/server/mcp.ts clientId min(1)":
    "A connected agent's id, copied from `list_connected_agents`; the browser sends it from the list.",
  "src/server/services/cursor.ts key min(1)":
    "Decoded from a signed cursor the server issued; a failure is caught and refused with its own sentence.",
  "src/server/services/import-export.ts payee min(1) max(160)":
    "A Simple Balance CSV's round-trip column, read with `safeParse` and falling back to the visible column on any failure.",
  "src/server/services/import-export.ts externalId max(200)": "The same round-trip read.",
  "src/server/services/import-export.ts categoryName min(1) max(120)": "The same round-trip read.",
};

/** Past a quoted string, from its opening quote; a template's `${…}` included. */
function pastString(code: string, at: number): number {
  const quote = code[at]!;
  let i = at + 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && code[i + 1] === "{") {
      i = pastBalanced(code, i + 1);
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Past the bracket at `at` and everything up to the one that closes it. */
function pastBalanced(code: string, at: number): number {
  let depth = 0;
  let i = at;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = pastString(code, i);
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Whether an argument list has more than one argument. */
function severalArguments(args: string): boolean {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = pastString(args, i) - 1;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) depth -= 1;
    if (c === "," && depth === 0) return true;
  }
  return false;
}

/** Every chain from `z.string()` holding a length call with no message. */
function bareChains() {
  const found: { key: string; at: string }[] = [];
  for (const file of files) {
    const { code } = file;
    for (const start of code.matchAll(/\bz\s*\.\s*string\s*\(\s*\)/g)) {
      let at = start.index + start[0].length;
      const bare: string[] = [];
      for (;;) {
        const call = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(at));
        if (!call) break;
        const open = at + call[0].length - 1;
        const end = pastBalanced(code, open);
        const args = code.slice(open + 1, end - 1);
        if (["min", "max", "length"].includes(call[1]!) && !severalArguments(args)) {
          bare.push(`${call[1]}(${args.trim()})`);
        }
        at = end;
      }
      if (!bare.length) continue;
      // The name it is declared under: a property or a const, past any
      // wrapper such as `oneLine(` between it and the chain.
      const before = code.slice(0, start.index).replace(/(?:\s|[A-Za-z_$][\w$]*\()*$/, "");
      const name = /([A-Za-z_$][\w$]*)\s*[:=]$/.exec(before)?.[1] ?? "(unnamed)";
      const line = code.slice(0, start.index).split("\n").length;
      found.push({ key: `${file.path} ${name} ${bare.join(" ")}`, at: `${file.path}:${line}` });
    }
  }
  return found;
}

describe("a free-text field's refusal", () => {
  it("is a sentence somebody wrote, on every string that measures its length", () => {
    const bare = bareChains()
      .filter(({ key }) => !(key in NEVER_READ))
      .map(({ key, at }) => `${at} ${key}`);
    expect(bare, "pass enter(…) or atMost(…) beside the number").toEqual([]);
  });

  it("reads every module that builds a string schema, across lines", () => {
    const read = files.map((file) => file.path);
    // A floor and named members, so a matcher that stopped finding modules
    // cannot pass on reading none of them.
    expect(read.length).toBeGreaterThanOrEqual(8);
    expect(read).toEqual(
      expect.arrayContaining(["src/shared/domain.ts", "src/server/api.ts", "src/server/mcp.ts"]),
    );
    for (const path of Object.keys(NOT_A_REQUEST)) {
      expect(
        sourceFiles("src").map((file) => file.path),
        path,
      ).toContain(path);
    }
    // A chain written a call to a line is found: the shape that hid these.
    expect(bareChains().map(({ key }) => key)).toContain(
      "src/shared/domain.ts idempotencyKeySchema min(8) max(200)",
    );
  });

  it("keeps its exceptions to chains that still exist", () => {
    const keys = new Set(bareChains().map(({ key }) => key));
    for (const key of Object.keys(NEVER_READ)) expect(keys, key).toContain(key);
  });

  it("reads as an instruction at the ends a person or an agent reaches", () => {
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
    // One sentence, not that and "not recognized" after it: a hand-edited
    // file's empty timezone is listed on the import page as it is said here.
    const timezone = preferencesSchema.shape.timezone.safeParse("");
    expect(timezone.error!.issues.map((issue) => issue.message)).toEqual(["Enter a timezone"]);
    const fileName = ledgerFileAddInputSchema.shape.fileName;
    expect(message(fileName.safeParse("  "))).toBe("Enter a file name");
    expect(message(fileName.safeParse("x".repeat(241)))).toBe(
      "A file name must be 240 characters or fewer",
    );
  });
});
