import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/http.md` §Errors: "Any number in a message also appears in
 * the details as a field … A client should never have to parse a sentence to
 * learn a number."
 *
 * It was House and unchecked, and the sweep that read it against the code found
 * eight refusals saying a number in the sentence and nowhere else: both CSV
 * caps, the export cap, the 413, both report bounds, the budget report's, and
 * the frozen-account refusal that nine write paths raise. The bulk cap and the
 * plan limits beside them had always carried theirs, so the rule was known and
 * simply not reachable from a diff.
 *
 * Which interpolation is a number cannot be read off the source without a type
 * checker, and TypeScript 7 ships none to a test. So the check runs the other
 * way: **every** value a refusal sentence interpolates must also appear in its
 * details, unless it is named below as not being a number. A name, a currency
 * and a date the caller sent are the honest exceptions; each has its reason, and
 * one more interpolation fails until somebody says which kind it is.
 */
const NOT_A_NUMBER: Record<string, string> = {
  kind: "A counter-account kind: income, expense, equity or exchange.",
  currency: "An ISO currency code.",
  name: "The account name the caller can already see.",
  "group.name": "A group's name.",
  "existing.name": "The name that clashed, which the caller sent.",
  "clash.name": "The same, on rename.",
  "before.name": "A group's name.",
  activeFrom: "A date the caller sent, echoed so the sentence can say which.",
  activeTo: "The same.",
  targetDate: "The same.",
  "clash.activeFrom": "A date already stored, named so the caller can find the budget.",
  bucket: "A bucket name — week, month, quarter, year.",
  "parsed.periodUnit": "A period unit, the same closed set.",
  'named.join(" and ")': "Field names, joined.",
};

/**
 * A message that is not written at the throw site at all.
 *
 * Its interpolations are somewhere else, so the check above cannot see them,
 * and a refusal composed by a helper is exactly how the frozen account went
 * unnoticed. Each is named, and `carries` is the details key the helper's number
 * arrives in — asserted, so a helper that grows a number cannot pass on its name.
 */
const COMPOSED: Record<string, { readonly because: string; readonly carries?: string }> = {
  "allowance.message": { because: "The plan limit, from `accountAllowance`.", carries: "limit" },
  "change.message": { because: "The active-account choice's refusal.", carries: "limit" },
  frozenAccountRefusal: { because: "Shared with the browser so both say it.", carries: "limit" },
  exceedsBulkSelectionCap: { because: "The ten-thousand row cap.", carries: "limit" },
  "side.message": { because: "`resolveEntrySide` returns fixed sentences with no number in them." },
  PLAN_ENDING_REFUSAL: { because: "A constant sentence." },
  PLAN_GRANTED_REFUSAL: { because: "A constant sentence." },
};

/**
 * The constructors a refusal is raised through, and where each takes its
 * message, its details and — on the two that have one — the sentence an agent
 * reads instead, which is held to the same rule because an agent is the reader
 * least able to parse a number back out of prose.
 */
const CONSTRUCTORS: Record<
  string,
  { readonly message: number; readonly details: number; readonly agentMessage?: number }
> = {
  validationError: { message: 0, details: 1, agentMessage: 2 },
  conflict: { message: 0, details: 1, agentMessage: 2 },
  notFound: { message: 0, details: 1 },
  duplicate: { message: 0, details: 1 },
  errorResponse: { message: 3, details: 4 },
};

/** The index of the `)` closing the call whose `(` is at `open`, aware of strings and `${}`. */
function closingParen(code: string, open: number): number {
  const stack: string[] = [];
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    const character = code[index]!;
    const top = stack.at(-1);
    if (top === '"' || top === "'") {
      if (character === "\\") index++;
      else if (character === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (character === "\\") index++;
      else if (character === "`") stack.pop();
      else if (character === "$" && code[index + 1] === "{") {
        stack.push("{");
        index++;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") stack.push(character);
    else if (character === "{") stack.push("{");
    else if (character === "}") stack.pop();
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

/** Top-level arguments of a call, split on the commas that belong to it. */
function splitArguments(text: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const top = stack.at(-1);
    if (top === '"' || top === "'" || top === "`") {
      current += character;
      if (character === "\\") current += text[++index];
      else if (character === top) stack.pop();
      else if (top === "`" && character === "$" && text[index + 1] === "{") {
        stack.push("{");
        current += text[++index];
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") stack.push(character);
    else if ("([{".includes(character)) stack.push(character);
    else if (")]}".includes(character)) stack.pop();
    if (character === "," && stack.length === 0) {
      found.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) found.push(current.trim());
  return found;
}

/** Every `${…}` in a message, as written, with balanced braces. */
function interpolations(message: string): string[] {
  const found: string[] = [];
  for (let index = message.indexOf("${"); index !== -1; index = message.indexOf("${", index)) {
    let depth = 1;
    let end = index + 2;
    for (; end < message.length && depth > 0; end++) {
      if (message[end] === "{") depth++;
      else if (message[end] === "}") depth--;
    }
    found.push(message.slice(index + 2, end - 1).trim());
    index = end;
  }
  return found;
}

/**
 * The values a sentence names, looking through a choice between two pieces of
 * text: `${to ? ` through ${to}` : " onwards"}` names `to` and nothing else, and
 * a choice between two plain words names nothing at all.
 */
function values(message: string): string[] {
  return interpolations(message).flatMap((expression) =>
    /\?\s*["'`]/.test(expression) ? values(expression) : [expression],
  );
}

/**
 * The value under its formatting: `maxRows.toLocaleString("en-US")` and
 * `limit ?? 0` are `maxRows` and `limit`, which is how the details carry them.
 */
const unformatted = (expression: string) =>
  expression.replace(/\.toLocaleString\([^)]*\)$/, "").replace(/\s*\?\?\s*[\w"]+$/, "");

/** Whether a composed message's number is in these details, by the key `COMPOSED` names. */
const carriesComposed = (composer: string, details: string) => {
  const key = COMPOSED[composer]?.carries;
  return key === undefined || new RegExp(`\\b${key}\\b`).test(details);
};

type Refusal = {
  readonly where: string;
  readonly message: string;
  readonly agentMessage: string;
  readonly details: string;
};

const refusals: Refusal[] = [...sourceFiles("src/server"), ...sourceFiles("src/shared")]
  // The constructors themselves pass `message` through; every caller is read.
  .filter((file) => file.path !== "src/server/services/errors.ts")
  .flatMap((file) => {
    const found: Refusal[] = [];
    const pattern = new RegExp(`\\b(${Object.keys(CONSTRUCTORS).join("|")})\\(`, "g");
    for (const match of file.code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = closingParen(file.code, open);
      if (close === -1) continue;
      const positions = CONSTRUCTORS[match[1]!]!;
      const parts = splitArguments(file.code.slice(open + 1, close));
      const message = parts[positions.message];
      // The declaration of `errorResponse` itself, whose parameters are names.
      if (message === undefined || /^\w+:/.test(message)) continue;
      const line = file.code.slice(0, match.index).split("\n").length;
      found.push({
        where: `${file.path}:${line}`,
        message,
        agentMessage:
          positions.agentMessage === undefined ? "" : (parts[positions.agentMessage] ?? ""),
        details: parts[positions.details] ?? "",
      });
    }
    return found;
  });

/** The callee or member a message was composed by, or null when it is written in place. */
function composedBy(message: string): string | null {
  if (/^["'`]/.test(message) || message.includes("?")) return null;
  return /^([A-Za-z_$][\w$.]*)/.exec(message)?.[1] ?? null;
}

describe("a number in a refusal is a field in its details", () => {
  /**
   * The population first. A scanner that stopped matching would report no
   * violations and look exactly like compliance, so the count it reads is held
   * to a floor, and the refusals the rule was written about must be in it.
   */
  it("reads the refusals the rule is about", () => {
    expect(refusals.length).toBeGreaterThan(150);
    const written = refusals.map((refusal) => refusal.message).join("\n");
    for (const sentence of ["-byte limit", "-row limit", "Export exceeds", "is the most a"]) {
      expect(written, sentence).toContain(sentence);
    }
    expect(refusals.some((refusal) => refusal.message.startsWith("frozenAccountRefusal"))).toBe(
      true,
    );
  });

  it("puts every interpolated value in the details, or names why it is not a number", () => {
    const missing: string[] = [];
    for (const refusal of refusals) {
      const sentences = [refusal.agentMessage];
      if (!composedBy(refusal.message)) sentences.push(refusal.message);
      for (const expression of sentences.flatMap(values)) {
        if (NOT_A_NUMBER[expression]) continue;
        if (COMPOSED[expression] && carriesComposed(expression, refusal.details)) continue;
        if (refusal.details.includes(unformatted(expression))) continue;
        missing.push(`${refusal.where}: \${${expression}} is in the sentence and not the details`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names every message composed somewhere else, and finds its number in the details", () => {
    const unnamed: string[] = [];
    for (const refusal of refusals) {
      const composer = composedBy(refusal.message);
      if (!composer) continue;
      if (!COMPOSED[composer]) unnamed.push(`${refusal.where}: ${composer}`);
      else if (!carriesComposed(composer, refusal.details))
        unnamed.push(`${refusal.where}: ${composer} without its number in the details`);
    }
    expect(unnamed).toEqual([]);
  });

  it("keeps both registers to entries something still uses", () => {
    const written = refusals
      .map((refusal) => `${refusal.message}\n${refusal.agentMessage}`)
      .join("\n");
    const stale = [
      ...Object.keys(NOT_A_NUMBER).filter((expression) => !written.includes(`\${${expression}}`)),
      ...Object.keys(COMPOSED).filter(
        (composer) => !refusals.some((refusal) => composedBy(refusal.message) === composer),
      ),
    ];
    expect(stale).toEqual([]);
  });
});
