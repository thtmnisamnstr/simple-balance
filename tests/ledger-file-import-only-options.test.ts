import { describe, expect, it } from "vitest";
import {
  accountCreateSchema,
  categoryCreateSchema,
  transactionDraftSchema,
} from "../src/shared/domain.js";
import { sourceFiles } from "./support/source.js";

/**
 * The options only a Simple Balance file's import may pass, held to the one
 * module that passes them.
 *
 * Each is an argument rather than a field, so that no form and no tool can
 * reach it: an account that arrives archived at an instant somebody names, a
 * close left for later, a write into an archived account or category, a
 * reminder that says it was already sent, a recurrence that says it already
 * proposed, an entry that claims an origin. A route or a tool that passed one
 * would be the backdoor the argument exists to close, and nothing about the
 * types would say so, because the options are the services' own. So the
 * calls are read off the source: every call that names one of them is in
 * `src/server/services/ledger-file.ts` — the staged commit alone besides it
 * copies an origin — and the transports pass the creates nothing past what a
 * form or a tool sends.
 */
const FENCED = [
  "arriveArchived",
  "archivedAt",
  "deferClose",
  "allowArchived",
  "deferArchivedClose",
  "lastNotifiedDate",
  "lastOccurrenceDate",
];
const SERVICES = [
  "createAccount",
  "createCategory",
  "createTransactionWithinTx",
  "setTransactionDeleted",
  "createTransactionTemplate",
  "createRecurrence",
];
const IMPORT = "src/server/services/ledger-file.ts";

type Call = { file: string; line: number; name: string; args: string[]; text: string };

/** The text of each top-level argument of the call whose `(` is at `open`. */
function argumentsAt(code: string, open: number): { args: string[]; text: string } {
  let depth = 0;
  let start = open + 1;
  const args: string[] = [];
  for (let at = open; at < code.length; at += 1) {
    const char = code[at]!;
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    if (depth === 1 && char === ",") {
      args.push(code.slice(start, at).trim());
      start = at + 1;
    }
    if (depth === 0) {
      const last = code.slice(start, at).trim();
      if (last) args.push(last);
      return { args, text: code.slice(open, at + 1) };
    }
  }
  throw new Error("An unclosed call");
}

/** Every call of the services above in `src`, with its arguments, comments set aside. */
function calls(): Call[] {
  const found: Call[] = [];
  for (const file of sourceFiles("src")) {
    for (const match of file.code.matchAll(new RegExp(`\\b(${SERVICES.join("|")})\\s*\\(`, "g"))) {
      const before = file.code.slice(0, match.index);
      // A declaration is not a call.
      if (/function\s*$/.test(before)) continue;
      const { args, text } = argumentsAt(file.code, match.index + match[0].length - 1);
      found.push({
        file: file.path,
        line: before.split("\n").length,
        name: match[1]!,
        args,
        text,
      });
    }
  }
  return found;
}

describe("the options only an import passes", () => {
  const all = calls();

  it("finds the calls it is about", () => {
    // A reader that found nothing would pass everything below.
    expect(all.filter((call) => call.file === IMPORT).map((call) => call.name)).toEqual(
      expect.arrayContaining([
        "createAccount",
        "createCategory",
        "createTransactionWithinTx",
        "setTransactionDeleted",
        "createTransactionTemplate",
        "createRecurrence",
      ]),
    );
    expect(all.some((call) => call.file === "src/server/api.ts")).toBe(true);
    expect(all.some((call) => call.file === "src/server/mcp.ts")).toBe(true);
  });

  it("are named in calls in the import's own module and nowhere else", () => {
    const outside = all.filter(
      (call) =>
        call.file !== IMPORT &&
        FENCED.some((option) => new RegExp(`\\b${option}\\b`).test(call.text)),
    );
    expect(outside.map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
  });

  it("let an origin onto an entry from a file's import or the staged commit alone", () => {
    const origins = all.filter(
      (call) => call.name === "createTransactionWithinTx" && /\bimportOrigin\b/.test(call.text),
    );
    expect([...new Set(origins.map((call) => call.file))].sort()).toEqual([
      IMPORT,
      "src/server/services/staging.ts",
    ]);
  });

  it("are never reached from a route or a tool, which pass the creates nothing more", () => {
    const most: Record<string, number> = {
      createAccount: 3,
      createCategory: 3,
      createTransactionTemplate: 3,
      createRecurrence: 3,
      setTransactionDeleted: 6,
      createTransactionWithinTx: 0,
    };
    const over = all.filter(
      (call) =>
        (call.file === "src/server/api.ts" || call.file === "src/server/mcp.ts") &&
        call.args.length > most[call.name]!,
    );
    expect(over.map((call) => `${call.file}:${call.line} ${call.name}`)).toEqual([]);
  });

  it("cannot arrive as fields, which the create schemas leave behind", () => {
    const account = accountCreateSchema.safeParse({
      name: "Checking",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "0",
      archivedAt: "2020-01-01T00:00:00.000Z",
      arriveArchived: true,
    });
    expect(
      account.success && ("archivedAt" in account.data || "arriveArchived" in account.data),
    ).toBe(false);
    const category = categoryCreateSchema.safeParse({
      name: "Old hobby",
      kind: "expense",
      archivedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(category.success && "archivedAt" in category.data).toBe(false);
    const draft = transactionDraftSchema.safeParse({
      type: "deposit",
      date: "2026-01-01",
      payee: "Somebody",
      toAccountId: "00000000-0000-4000-8000-000000000001",
      amount: "1",
      importOrigin: "00000000-0000-4000-8000-000000000002",
    });
    expect(draft.success && "importOrigin" in draft.data).toBe(false);
  });
});
