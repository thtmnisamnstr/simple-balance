import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeHumanName } from "../src/shared/names.js";

/**
 * One rule for comparing payee names, spelled in SQL in five places.
 *
 * It is the same rule every time — NFKC, trim, collapse whitespace, lower — and
 * it has to be, because the value it is compared against is normalised in
 * JavaScript by `normalizeHumanName`. A spelling that differs does not raise: it
 * silently fails to match. One of the five had dropped the NFKC and read
 * "Match the same way payees are compared elsewhere" directly above, so
 * filtering the queue by a payee holding a ligature returned nothing at all.
 *
 * Two of the five are index expressions. Those have to match exactly or the
 * planner will not use the index for the query it was created for — it is not
 * wrong, just quietly useless.
 */
const FILES = [
  "src/server/services/payees.ts",
  "src/server/services/transactions.ts",
  "src/server/services/staging.ts",
  "src/server/db/schema.ts",
];

const read = (file: string) =>
  readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

/**
 * Each SQL normalisation, with the column it reads replaced by a placeholder so
 * expressions over different columns compare as equal.
 */
function spellings(source: string) {
  const found: string[] = [];
  // Bounded to one line. Allowing newlines let a lazy match run past the end of
  // one expression and take the tail of the next, so a wrong spelling was
  // reported with the right shape — the extractor agreeing with itself rather
  // than with the file.
  for (const match of source.matchAll(
    /lower\(regexp_replace\((?:trim|btrim)\(([^\n]*?)\),\s*'[^']*',\s*' ',\s*'g'\)\)/g,
  )) {
    const inner = match[1]!;
    const shape = match[0]!
      // The column, whatever it is.
      .replace(inner, inner.includes("NFKC") ? "COLUMN, NFKC" : "COLUMN")
      .replace(/\s+/g, " ");
    found.push(shape);
  }
  return found;
}

describe("comparing payee names", () => {
  const all = FILES.flatMap((file) =>
    spellings(read(file)).map((shape) => ({ file, shape })),
  );

  it("is spelled the same way everywhere it is spelled in SQL", () => {
    expect(all.length, "the expressions were found at all").toBeGreaterThan(4);
    const distinct = [...new Set(all.map((one) => one.shape))];
    expect(
      distinct,
      `spelled ${distinct.length} different ways:\n` +
        all.map((one) => `  ${one.file}: ${one.shape}`).join("\n"),
    ).toHaveLength(1);
  });

  it("normalises the way the value it compares against is normalised", () => {
    // Both halves have to fold NFKC or a folded parameter never meets an
    // unfolded column.
    expect(all[0]!.shape).toContain("NFKC");
    expect(normalizeHumanName("Café ﬁne")).toBe("café fine");
  });
});
