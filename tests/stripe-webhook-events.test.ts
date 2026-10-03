import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNoteworthyEvent, subscriptionIdForEvent } from "../src/server/services/billing.js";
import { sourceFiles } from "./support/source.js";

/**
 * The event list an operator copies into Stripe, against the code that reads it.
 *
 * Stripe makes event selection a required step and nothing in this deployment
 * can see what was chosen, so a wrong selection fails in silence: the delivery
 * that mattered never arrives, and the ones that do are acknowledged. Both
 * `docs/deployment.md` and `docs/billing-operations.md` say exactly that, which
 * makes the two lists a contract. A branch renamed in a refactor leaves the
 * documented type pointing at nothing, and a type dropped from the table leaves
 * an operator subscribing to less than the handler needs; neither has a symptom
 * anybody can see.
 *
 * Kept out of `tests/stripe-events.test.ts`, which is deliberately filesystem-
 * free and pure, and out of `tests/stripe-webhook-route.test.ts`, which proves
 * what each branch *does*. This file only holds the two descriptions of the
 * same set to each other.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * A Stripe event type as either document writes one: lower case, underscores,
 * at least one dot, inside backticks. `docs/deployment.md` is cited in the same
 * prose and matches that shape without being an event, so anything ending
 * `.md` is dropped.
 */
const eventTypesIn = (markdown: string) => [
  ...new Set(
    [...markdown.matchAll(/`([a-z_]+(?:\.[a-z_]+)+)`/g)]
      .map((match) => match[1]!)
      .filter((type) => !type.endsWith(".md")),
  ),
];

/**
 * The region of a document between two anchors, which fails rather than
 * returning nothing when an anchor has moved.
 *
 * The alternative is the failure this whole file exists to prevent one level
 * up: a heading reworded in an edit, a slice that comes back empty, and every
 * assertion below passing over a population of zero.
 */
function between(markdown: string, from: string, to: string, what: string) {
  const start = markdown.indexOf(from);
  expect(start, `${what}: no section starting ${JSON.stringify(from)}`).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + from.length);
  const end = rest.indexOf(to);
  expect(end, `${what}: no ${JSON.stringify(to)} ending the section`).toBeGreaterThanOrEqual(0);
  return rest.slice(0, end);
}

const deploymentTypes = eventTypesIn(
  between(
    read("docs/deployment.md"),
    "### The webhook, and which events it has to be sent",
    "\nAnything else",
    "docs/deployment.md",
  ),
);

const operationsTypes = eventTypesIn(
  between(
    read("docs/billing-operations.md"),
    "3. **The webhook endpoint**",
    "\n4. ",
    "docs/billing-operations.md",
  ),
);

const server = sourceFiles("src/server");
const sourceOf = (path: string) => {
  const file = server.find((candidate) => candidate.path === path);
  expect(file, `${path} must be under src/server`).toBeDefined();
  // The comment-blanked copy. The webhook's comments name event types in prose
  // — that is what they are for — and reading those as branches would report a
  // handler for every type the reasoning mentions.
  return file!.code;
};

/** The two types the route names outright, before any family test. */
const namedRouteLiterals = [
  ...new Set(
    [...sourceOf("src/server/api.ts").matchAll(/event\.type === "([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  ),
];

const billingSource = sourceOf("src/server/services/billing.ts");
const noteworthyLiterals = [
  ...new Set(
    [
      ...(/const noteworthyEvents = new Set\(\[([^\]]*)\]/.exec(billingSource)?.[1] ?? "").matchAll(
        /"([^"]+)"/g,
      ),
    ].map((match) => match[1]!),
  ),
];
const familyPrefixes = [
  ...new Set(
    [...billingSource.matchAll(/event\.type\.startsWith\("([^"]+)"\)/g)].map((match) => match[1]!),
  ),
];

describe("the event list an operator is told to subscribe to", () => {
  it("was read out of both documents and out of the code", () => {
    // Every assertion below compares sets, and a regex that stopped matching
    // would compare two empty ones and pass. These are the sizes that make the
    // comparisons mean something.
    expect(deploymentTypes.length).toBeGreaterThanOrEqual(10);
    expect(operationsTypes.length).toBeGreaterThanOrEqual(10);
    expect(namedRouteLiterals).toHaveLength(2);
    expect(noteworthyLiterals.length).toBeGreaterThanOrEqual(4);
    expect(familyPrefixes).toHaveLength(2);
  });

  it("says the same thing in both places, in the same order", () => {
    // Two copies of one list in two documents an operator may read either of.
    // Order as well as membership, because the tables are read top to bottom
    // and a reordered copy is the kind of difference that survives a skim.
    expect(operationsTypes).toEqual(deploymentTypes);
  });

  it("documents every type the route names outright", () => {
    // `customer.deleted` and `setup_intent.succeeded` are the two the handler
    // tests for by name. Either one missing from the table is an endpoint that
    // never receives it: the card saved through a 3-D Secure redirect is never
    // made the one Stripe bills, or a customer mapping Stripe has deleted is
    // kept and the next attempt to subscribe fails against it.
    expect(namedRouteLiterals.filter((type) => !deploymentTypes.includes(type))).toEqual([]);
  });

  it("documents every type it would only log", () => {
    // These change no entitlement, so an operator who is not subscribed to them
    // loses nothing automatic — they lose the only notice that somebody charged
    // back a year of the plan, which is a decision `docs/billing-operations.md`
    // expects them to make.
    expect(noteworthyLiterals.filter((type) => !deploymentTypes.includes(type))).toEqual([]);
  });
});

/**
 * One payload for every type, carrying both spellings a subscription reference
 * arrives in, so the probe encodes nothing about which family a type belongs
 * to. A per-family payload would be the answer written into the question.
 */
const probe = {
  id: "sub_probe",
  object: "subscription",
  customer: "cus_probe",
  subscription: "sub_probe",
};

/**
 * Which of the handler's three ways of having an opinion a type falls into,
 * asked in the order the route asks them: the named branches come before
 * `isNoteworthyEvent`, which comes before `subscriptionIdForEvent`.
 */
function familyOf(type: string): "named" | "noteworthy" | "reconciled" | "unhandled" {
  if (namedRouteLiterals.includes(type)) return "named";
  if (isNoteworthyEvent(type)) return "noteworthy";
  if (subscriptionIdForEvent({ type, data: { object: probe } }) !== null) return "reconciled";
  return "unhandled";
}

/**
 * The expectation is this literal table and nothing derived from the code.
 *
 * Walking the documented list and asserting that each type is handled *somehow*
 * would pass with every row misfiled — `invoice.payment_failed` treated as
 * noteworthy rather than reconciled is precisely the mistake that looks
 * harmless and loses the fifteen-day grace, because the grace is started by
 * re-reading the subscription and recording when the failure happened, not by
 * a log line.
 */
const EXPECTED: ReadonlyArray<readonly [string, ReturnType<typeof familyOf>]> = [
  ["customer.subscription.created", "reconciled"],
  ["customer.subscription.updated", "reconciled"],
  ["customer.subscription.deleted", "reconciled"],
  ["invoice.paid", "reconciled"],
  ["invoice.payment_failed", "reconciled"],
  ["setup_intent.succeeded", "named"],
  ["customer.deleted", "named"],
  ["charge.refunded", "noteworthy"],
  ["charge.dispute.created", "noteworthy"],
  ["charge.dispute.closed", "noteworthy"],
  ["charge.dispute.funds_withdrawn", "noteworthy"],
];

describe("what the code does with each documented type", () => {
  it("is exactly the eleven types the table lists", () => {
    // Against the literal, so a row quietly dropped from the document fails
    // here rather than being compared to a shorter copy of itself.
    expect(deploymentTypes).toEqual(EXPECTED.map(([type]) => type));
  });

  it("handles each of them the way it was documented to", () => {
    expect(deploymentTypes.map((type) => [type, familyOf(type)] as const)).toEqual(EXPECTED);
  });

  it("has no opinion about a type nobody was told to subscribe to", () => {
    // The other half of "anything else is acknowledged and ignored". Without
    // it, a family prefix widened by one character — `customer.` for
    // `customer.subscription.` — would pass every assertion above while
    // reconciling deliveries that name no subscription at all.
    const strangers = ["customer.created", "payment_intent.succeeded", "invoiceitem.created"];
    expect(strangers.map((type) => [type, familyOf(type)] as const)).toEqual([
      ["customer.created", "unhandled"],
      ["payment_intent.succeeded", "unhandled"],
      ["invoiceitem.created", "unhandled"],
    ]);
  });
});
