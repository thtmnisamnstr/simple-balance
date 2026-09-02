import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * The invariant SB-029 said it was at risk of, held by a test rather than a
 * paragraph.
 *
 * Money dated in the future has not moved. A forecast is a projection of what
 * the balances would do if nothing changed, and the moment one of its figures
 * reaches a balance, a report total or the trial balance, the ledger is
 * claiming something happened because somebody expected it to. That is the one
 * thing this feature can do to the product that could not be undone by deleting
 * it.
 *
 * Two properties are checkable and both are checked. Nothing outside the
 * forecast may import it, so no balance or report can accidentally hold one of
 * its numbers; and the forecast writes nothing, so no projection can become a
 * posting.
 */
const FORECAST = "src/server/services/forecast.ts";

/**
 * Who may read the forecast: the two transports that answer a request for one,
 * and nothing else.
 *
 * A report or a balance importing it would be the defect this exists against.
 * The list is short on purpose — adding a name to it is a decision somebody has
 * to make in a diff, and the reason has to be that the caller is answering a
 * question about the future.
 */
const MAY_IMPORT = ["src/server/api.ts", "src/server/mcp.ts"];

describe("the forecast", () => {
  it("is imported by the transports that answer for it and by nothing else", () => {
    const importers = sourceFiles("src")
      .filter((file) => file.path !== FORECAST)
      .filter((file) => /from "[^"]*forecast\.js"/.test(file.code))
      .map((file) => file.path);
    expect(
      importers.filter((path) => !MAY_IMPORT.includes(path)),
      "a balance or a report holding a projected figure is the defect this rule exists against",
    ).toEqual([]);
    // And the two that may are really there, so this cannot pass by the file
    // having been renamed out from under it.
    expect(importers.sort()).toEqual([...MAY_IMPORT].sort());
  });

  it("writes nothing at all", () => {
    const source = sourceFiles("src").find((file) => file.path === FORECAST);
    expect(source, "the forecast service moved").toBeDefined();
    // Comments blanked, because the file argues about postings at length and a
    // grep that read the prose would fail on the explanation of the rule.
    const writes = [
      /\.insert\s*\(/,
      /\.update\s*\(/,
      /\.delete\s*\(/,
      /\binsert\s+into\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\bdelete\s+from\b/i,
      /withTransaction\s*\(/,
      /writeAudit\s*\(/,
    ].filter((pattern) => pattern.test(source!.code));
    expect(writes.map(String), "a projection that wrote a row would be a posting").toEqual([]);
  });

  /**
   * The vocabulary, which is the human half of the same rule.
   *
   * A field called `balance` in a projection is one copy-paste away from a
   * balance. Every figure the forecast projects is named for what it is, and
   * the one field that is a fact rather than a projection — what the accounts
   * hold today — is the only one allowed to say `openingBalance`.
   */
  it("names a projected figure as a projection", () => {
    const source = sourceFiles("src").find((file) => file.path === FORECAST);
    const fields = [...source!.code.matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]!);
    const balanceish = fields.filter(
      (name) => /balance/i.test(name) && !["openingBalance", "projectedBalance"].includes(name),
    );
    expect(balanceish, "call it projected, or call it what it is").toEqual([]);
  });
});
