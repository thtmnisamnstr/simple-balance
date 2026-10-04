import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * The restricted key's permissions, as `docs/billing-operations.md` step 2
 * lists them, against the calls the server actually makes.
 *
 * The table is what an operator builds the key from, and it said PaymentMethods
 * was "Read, never written" while replacing a card names the new one as the
 * default on the subscription and the customer — which Stripe allows only with
 * Write on Payment Methods. Nothing compared the two, and a sandbox never
 * showed it: a test account whose customers never saved and swapped a card
 * never makes the call. The first person to find it would have been a paying
 * customer whose card replacement failed.
 *
 * So the access each resource needs is derived from `src/server/stripe.ts`
 * itself: a call that is not a read needs Write on its resource, a card named
 * as a default needs Write on Payment Methods, and a card read expanded needs
 * Read on it.
 */

const root = path.resolve(import.meta.dirname, "..");

/** The SDK's property for each resource, and the name the dashboard and the table use. */
const RESOURCES: Record<string, string> = {
  customers: "Customers",
  subscriptions: "Subscriptions",
  subscriptionSchedules: "Subscription schedules",
  setupIntents: "SetupIntents",
  invoices: "Invoices",
  paymentIntents: "PaymentIntents",
  paymentMethods: "PaymentMethods",
  prices: "Prices",
};

const READS = new Set(["retrieve", "list", "search"]);

/** The table, as `{ resource: access }`. */
function table(): Record<string, string> {
  const doc = readFileSync(path.join(root, "docs/billing-operations.md"), "utf8");
  const rows = [...doc.matchAll(/^\s*\| ([A-Za-z][A-Za-z ]*?) \| (Read|Write) \|/gm)];
  return Object.fromEntries(rows.map((row) => [row[1]!, row[2]!]));
}

/** What the server's own code needs, from its calls and what it names in them. */
function needed(): Record<string, "Read" | "Write"> {
  // Comments blanked, so a call described in prose is not counted as made.
  const code = sourceFiles("src/server")
    .filter((file) => file.path === "src/server/stripe.ts")
    .map((file) => file.code)
    .join("\n");
  const access: Record<string, "Read" | "Write"> = {};
  const want = (resource: string, level: "Read" | "Write") => {
    if (access[resource] !== "Write") access[resource] = level;
  };
  for (const [, property, method] of code.matchAll(/\.(\w+)\.(\w+)\(/g)) {
    const resource = RESOURCES[property!];
    if (resource) want(resource, READS.has(method!) ? "Read" : "Write");
  }
  // A card named as somebody's default is a write on the card, whichever
  // resource the call is made on.
  if (/\bdefault_payment_method: /.test(code)) want("PaymentMethods", "Write");
  // A card read inside another object still needs Read on cards.
  if (/expand: \[[^\]]*payment_method/.test(code)) want("PaymentMethods", "Read");
  return access;
}

describe("the restricted key's permission table", () => {
  it("is read as a table at all", () => {
    expect(Object.keys(table()).length, "rows read from step 2").toBeGreaterThanOrEqual(7);
  });

  it("asks for Write on every resource the server writes, cards named as a default included", () => {
    const rows = table();
    const short = Object.entries(needed())
      .filter(([resource, level]) => level === "Write" && rows[resource] !== "Write")
      .map(
        ([resource]) =>
          `${resource}: the server writes it, the table says ${rows[resource] ?? "nothing"}`,
      );
    expect(short).toEqual([]);
  });

  it("names every resource the server reads, and none it never touches", () => {
    const rows = table();
    const access = needed();
    expect(Object.keys(access).filter((resource) => !(resource in rows))).toEqual([]);
    expect(Object.keys(rows).filter((resource) => !(resource in access))).toEqual([]);
  });

  it("is what the startup check asks about, less the one a read cannot prove", () => {
    const source = readFileSync(path.join(root, "src/server/stripe.ts"), "utf8");
    const probes = source.slice(
      source.indexOf("const accessProbes"),
      source.indexOf("];", source.indexOf("const accessProbes")),
    );
    const probed = [...probes.matchAll(/\[\s*"([A-Za-z ]+)",\s*"/g)].map((match) => match[1]!);
    expect(probed.sort()).toEqual(
      Object.keys(table())
        .filter((resource) => resource !== "PaymentMethods")
        .sort(),
    );
  });
});
