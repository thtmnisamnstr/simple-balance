import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import type { BillingStatus } from "../../../src/client/api.js";
import { MAX_FREE_ACCOUNTS } from "../../../src/shared/domain.js";
import { blankComments, repoRoot } from "../../support/source.js";

/**
 * The pages the browser app serves, read out of its own route table.
 *
 * Two specs make a claim about every page — no document scrolls sideways, no
 * target is too small to hit — and both used to carry a list of the paths
 * they meant. The reflow list missed `/settings/plan`, `/staged/duplicates`,
 * `/payees/transactions`, every detail page and five of the six reports; the
 * target-size list was three paths long. Neither failed when a page was added,
 * which is the property `docs/standards/code/testing.md` 2.6 is about: a list
 * does not fail when the world grows past it, it stops being about everything.
 *
 * So the population is `<Route path>` in `src/client/App.tsx`, read as text
 * because the router cannot be imported into a Node process without rendering
 * the app around it. A parameter is filled from ids the calling spec's own seed
 * created, and a parameter nobody supplied throws rather than skipping the
 * page: a new detail route fails both specs until a seed makes something for
 * it to show.
 */
export function routePatterns(): string[] {
  const app = blankComments(readFileSync(path.join(repoRoot, "src/client/App.tsx"), "utf8"));
  // `\s+` rather than a space: `/settings/plan` wraps its props onto the next
  // line, which a one-line pattern read as a route that did not exist.
  return [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]!);
}

/**
 * Patterns in the table that are not a page of their own, each with the reason.
 *
 * Kept short on purpose, because every entry is a place neither spec looks.
 */
export const NOT_A_PAGE = new Map([
  ["*", 'The catch-all renders `<Navigate to="/">`, so what it shows is `/`, visited already'],
]);

/** How a spec fills the table in: values for each `:param`, and a query for a route that reads one. */
export type Fill = {
  readonly params: Readonly<Record<string, readonly string[]>>;
  readonly search?: Readonly<Record<string, string>>;
};

/** One page to open: the URL, and the pattern it came from, which is what a register names. */
export type Visit = { readonly pattern: string; readonly url: string };

/**
 * Every URL to visit: each pattern with each parameter replaced by every value
 * supplied for it, and a query appended where a route's page reads one.
 *
 * Throws, naming the pattern, for a parameter with no values, and for a value
 * or a query nothing in the table asks for — a key left over after a rename
 * reads as coverage and is none.
 */
export function pagesToVisit(fill: Fill): Visit[] {
  const patterns = routePatterns();
  const problems: string[] = [];
  const pages: Visit[] = [];
  for (const pattern of patterns) {
    if (NOT_A_PAGE.has(pattern)) continue;
    let expanded = [pattern];
    for (const [, param] of pattern.matchAll(/:(\w+)/g)) {
      const values = fill.params[param!] ?? [];
      if (values.length === 0) problems.push(`${pattern}: nothing seeded for :${param}`);
      expanded = expanded.flatMap((one) =>
        values.map((value) => one.replace(`:${param}`, encodeURIComponent(value))),
      );
    }
    const search = fill.search?.[pattern] ?? "";
    pages.push(...expanded.map((one) => ({ pattern, url: `${one}${search}` })));
  }
  const asked = new Set(patterns.flatMap((one) => [...one.matchAll(/:(\w+)/g)].map((m) => m[1]!)));
  for (const param of Object.keys(fill.params)) {
    if (!asked.has(param)) problems.push(`:${param} was seeded and no route takes it`);
  }
  for (const pattern of Object.keys(fill.search ?? {})) {
    if (!patterns.includes(pattern)) problems.push(`${pattern} has a query and is not a route`);
  }
  if (problems.length > 0) throw new Error(`The route table moved:\n${problems.join("\n")}`);
  return pages;
}

/**
 * Answer the plan tab's one request, so `/settings/plan` shows the tab rather
 * than the alert it shows where nothing is for sale.
 *
 * The browser tier runs with no Stripe keys, so `/api/v1/billing` is not
 * registered and the page renders its heading, the Settings strip and "could
 * not be loaded" — a page, but not the one a person on a selling deployment
 * reads. `plan-buttons.spec.ts` argues the trade at length: there is no seeding
 * path to a priced tab, and this one response is the whole of what is faked.
 *
 * The free plan with both intervals on offer, because that is the tab most
 * people see and the one with the most on it: the offer, both priced buttons
 * and the account count against its limit.
 */
export async function answerPlanStatus(page: Page) {
  const status: BillingStatus = {
    selling: true,
    advertises: true,
    publishableKey: "pk_test_browser_tier",
    prices: {
      monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
      yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
    },
    entitlement: { billing: true, plan: "free", accountLimit: MAX_FREE_ACCOUNTS, source: "free" },
    accountsUsed: 1,
    accountsFrozen: 0,
    accountsLive: 1,
    activeChoicePending: false,
    subscription: null,
    override: null,
  };
  // By pathname, for the reason `plan-buttons.spec.ts` gives: the tab's other
  // billing paths hang off this one and must not be answered with a status.
  await page.route(
    (url) => url.pathname === "/api/v1/billing",
    (route) => route.fulfill({ json: status }),
  );
}
