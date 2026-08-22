import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(import.meta.dirname, "..", "src/client/App.tsx"),
  "utf8",
);

/**
 * The sidebar is in reading order rather than alphabetical: where the money is
 * and what moved it, then the work waiting on you, then the things that file and
 * repeat it, then what it all adds up to. That is a decision somebody made, and
 * an ordering nothing asserts is one a later edit reorders by accident — the
 * kind of change that reviews clean and lands wrong.
 */
describe("the sidebar", () => {
  const nav = source.slice(
    source.indexOf("const nav = ["),
    source.indexOf("];", source.indexOf("const nav = [")),
  );
  const labels = [...nav.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
  const routes = [...nav.matchAll(/to: "([^"]+)"/g)].map((match) => match[1]);

  it("is in the order it was decided in", () => {
    expect(labels).toEqual([
      "Overview",
      "Accounts",
      "Transactions",
      "Staged",
      "Categories",
      "Payees",
      "Templates",
      "Recurring",
      // After Recurring: it answers a question about a ledger somebody has
      // already been keeping rather than being something they do to it.
      "Reports",
      "Import CSV",
      "Activity",
      "Settings",
    ]);
  });

  it("names a route the app actually serves for every item", () => {
    for (const route of routes) {
      // The overview is the index route, matched by `end` rather than a path.
      if (route === "/") continue;
      expect(
        source.includes(`path="${route}"`) ||
          source.includes(`path="${route}/`) ||
          source.includes(`path="${route}:`),
        `${route} is in the sidebar with no Route for it`,
      ).toBe(true);
    }
  });

  it("offers every route it serves, or leaves it out on purpose", () => {
    const served = [...source.matchAll(/<Route path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((route) => !route.includes(":") && route !== "*" && route !== "/");
    // Reached from a row or from the queue rather than from the sidebar, which
    // is for the twelve places somebody goes on purpose.
    const reachedFromElsewhere = new Set([
      // A payee has no id of its own — it is text on a transaction — so its
      // detail page carries the name in the query string and sits under a
      // static path instead of a parameterised one.
      "/payees/transactions",
      // The run through the flagged rows, started from Staged transactions.
      // It is a job you do to the queue, not a place alongside it.
      "/staged/duplicates",
    ]);
    for (const route of served) {
      if (reachedFromElsewhere.has(route)) continue;
      expect(routes, `${route} is served but not in the sidebar`).toContain(route);
    }
  });
});
