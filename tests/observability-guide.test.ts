import { readFileSync } from "node:fs";
import { Counter } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";
import { registry, setMetricsComponent } from "../src/server/metrics.js";
import { sourceFiles } from "./support/source.js";

/**
 * The rules in `docs/standards/code/observability.md` that a program can hold.
 *
 * Named for the guide rather than for a module, because every check here exists
 * to stop one of its sentences becoming false. Where a sentence is a count, the
 * count is measured and compared against what the guide says, so the number
 * cannot drift by the code moving and nobody coming back to the page.
 *
 * `tests/metrics.test.ts` and `tests/log-level.test.ts` keep the checks that are
 * about the registry and the gate themselves; this file is about the guide.
 */
const GUIDE = "docs/standards/code/observability.md";

const server = sourceFiles("src/server");

const fileAt = (path: string) => {
  const found = server.find((file) => file.path === path);
  // A check that silently found nothing is worse than one that fails, and a
  // renamed module would otherwise leave every assertion below vacuously true.
  if (!found) throw new Error(`${path} is gone, and this check is about it`);
  return found;
};

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * A label whose values a person's data could ever supply.
 *
 * The same list `tests/metrics.test.ts` holds, kept here because this file
 * reads it against a different half of the metric — see §1.8 of the guide.
 */
const FORBIDDEN_LABELS = new Set([
  "user",
  "userid",
  "user_id",
  "actor",
  "email",
  "account",
  "accountid",
  "account_id",
  "payee",
  "category",
  "id",
  "name",
  "amount",
  "currency",
]);

const looksIdentifying = (label: string) => FORBIDDEN_LABELS.has(label.toLowerCase());

const PROBE = "simple_balance_probe_total";

/** What `getMetricsAsArray` hands back, which is the metric object itself. */
type Declared = { readonly name: string; readonly type: string; readonly labelNames?: string[] };

/** The three ways a metric is moved, as much of each as driving one needs. */
type Movable = {
  observe?: (labels: Record<string, string>, value: number) => void;
  set?: (labels: Record<string, string>, value: number) => void;
  inc?: (labels: Record<string, string>, value?: number) => void;
};

const declarations = () => registry.getMetricsAsArray() as unknown as Declared[];

/**
 * Every label name a scrape would publish, read where a scrape reads it.
 *
 * On the values, never on the declaration: `getMetricsAsJSON` returns `help`,
 * `name`, `type`, `values` and `aggregator` and no declared label names at all,
 * and the registry's default label appears on the values and nowhere else.
 */
async function publishedLabels() {
  const published = new Map<string, Set<string>>();
  for (const metric of await registry.getMetricsAsJSON()) {
    const names = new Set<string>();
    for (const sample of metric.values) {
      for (const label of Object.keys(sample.labels)) names.add(label);
    }
    published.set(metric.name, names);
  }
  return published;
}

/**
 * Move every metric once, so each contributes a value to read labels off.
 *
 * This is the cost the guide's §1.8 names: a metric nothing has incremented
 * publishes nothing, so the reading that is correct about labels needs the
 * registry exercised first. The label *names* come from the declaration, which
 * is what driving needs; the check below reads none of its answers from there.
 */
function driveEveryMetric() {
  for (const declared of declarations()) {
    const labels = Object.fromEntries(
      (declared.labelNames ?? []).map((label) => [label, "exercised"]),
    );
    const metric = registry.getSingleMetric(declared.name) as unknown as Movable | undefined;
    if (declared.type === "histogram" || declared.type === "summary") metric?.observe?.(labels, 0);
    else if (declared.type === "gauge") metric?.set?.(labels, 0);
    else metric?.inc?.(labels, 1);
  }
}

describe("a metric's labels", () => {
  afterEach(() => {
    registry.removeSingleMetric(PROBE);
  });

  it("carry nobody's identity, read where a scrape reads them", async () => {
    // The component label is set by both entrypoints at import time; set here
    // because this file imports neither, and because it is half of what makes
    // the values the right place to read.
    setMetricsComponent("api");
    driveEveryMetric();

    const published = await publishedLabels();
    const offenders = [...published].flatMap(([name, labels]) =>
      [...labels].filter((label) => looksIdentifying(label)).map((l) => `${name} publishes ${l}`),
    );

    expect(offenders).toEqual([]);
    // Every metric carries it, and no declaration mentions it: the default
    // label is reachable on one side of the metric only.
    expect([...published].filter(([, labels]) => !labels.has("component"))).toEqual([]);
    expect(declarations().filter((m) => (m.labelNames ?? []).includes("component"))).toEqual([]);
  });

  it("show on the values the declaration side cannot be asked for at all", async () => {
    const probe = new Counter({
      name: PROBE,
      help: "A counter that breaks the rule, so the check can be seen working.",
      labelNames: ["email", "user_id", "amount"] as const,
      registers: [registry],
    });
    probe.inc({ email: "person@example.com", user_id: "u_1", amount: "12.00" });

    const published = await publishedLabels();
    expect([...(published.get(PROBE) ?? [])].sort()).toEqual([
      "amount",
      "component",
      "email",
      "user_id",
    ]);

    // And the reading this replaced. `getMetricsAsJSON` carries no declaration,
    // so a check over `labelNames` reads `undefined ?? []` for every metric and
    // is indistinguishable from one that passes on everything.
    const asJson = (await registry.getMetricsAsJSON()).find((metric) => metric.name === PROBE);
    expect(Object.keys(asJson ?? {}).sort()).toEqual([
      "aggregator",
      "help",
      "name",
      "type",
      "values",
    ]);
    expect((asJson as { labelNames?: string[] } | undefined)?.labelNames).toBeUndefined();
  });

  it("are invisible until something moves the metric, which is why each one is driven", async () => {
    const probe = new Counter({
      name: PROBE,
      help: "A counter nothing has touched yet.",
      labelNames: ["email"] as const,
      registers: [registry],
    });

    expect((await publishedLabels()).get(PROBE)?.size ?? 0).toBe(0);
    probe.inc({ email: "person@example.com" });

    expect((await publishedLabels()).get(PROBE)?.has("email")).toBe(true);
  });
});

/** The handler's body, brace-balanced from the route registration. */
function webhookHandler() {
  const api = fileAt("src/server/api.ts").code;
  const start = api.indexOf('app.post("/api/billing/webhook"');
  expect(start).toBeGreaterThan(-1);
  const from = api.indexOf("{", start);
  let depth = 0;
  let end = from;
  do {
    const character = api[end];
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    end += 1;
  } while (depth > 0 && end < api.length);
  return api.slice(from, end);
}

describe("the Stripe webhook", () => {
  it("counts every delivery through one function, so a branch added later cannot escape", () => {
    const body = webhookHandler();

    // Two increments and no more, whatever the branch count becomes: the funnel
    // every 2xx leaves through, and the one exit that answers a status of its
    // own. A third is a counter line copied onto a `return`, which is the shape
    // the rule exists to refuse.
    expect([...body.matchAll(/billingWebhookDeliveries\.inc\(/g)]).toHaveLength(2);
    // The 200 body is written in one place, which is what makes the funnel the
    // only way out rather than merely the usual one.
    expect([...body.matchAll(/c\.json\(\{\s*received:/g)]).toHaveLength(1);
    expect([...body.matchAll(/\breturn answered\(/g)].length).toBeGreaterThanOrEqual(5);
  });

  it("names a branch and never anything of the vendor's vocabulary", () => {
    const body = webhookHandler();

    // Every outcome a literal, which is the only reason the label set can be
    // enumerated at all. An event type would be Stripe's vocabulary, growing
    // whenever Stripe ships an event, on the one route whose body an
    // unauthenticated caller supplies.
    const outcomes = [...body.matchAll(/\banswered\(\s*([^,]+),/g)].map((match) =>
      match[1]!.trim(),
    );
    expect(outcomes.filter((outcome) => !/^"[a-z_]+"$/.test(outcome))).toEqual([]);
    expect(
      [...body.matchAll(/billingWebhookDeliveries\.inc\(\{([^}]*)\}\)/g)]
        .map((match) => match[1]!.trim())
        .sort(),
    ).toEqual(["outcome", 'outcome: "signature_refused"']);
  });
});

describe("the scheduler process", () => {
  it("serves only the routes §1.7 excludes, and counts none of them", () => {
    const scheduler = fileAt("src/server/scheduler.ts").code;

    const mounted = [
      ...scheduler.matchAll(/\bhealth\.(get|post|put|patch|delete|all|use|on)\(\s*"([^"]+)"/g),
    ]
      .map((match) => `${match[1]} ${match[2]}`)
      .sort();

    // Pinned so the guide's exception stays the size it is. A fourth route here
    // is either instrumented or an edit to §1.7, and both are decisions
    // somebody makes in a diff rather than things that happen.
    expect(mounted).toEqual(["get /health/live", "get /health/ready", "get /metrics"]);
    expect(scheduler).not.toMatch(/httpRequests|httpDuration|startTimer/);
  });
});

describe("the configuration layer's exception to the log gate", () => {
  /**
   * The three files §2.1 excuses, `log.ts` excluded: that one is on the list
   * because it is the gate rather than because it is excused from it.
   */
  const EXCUSED = [
    "src/server/config.ts",
    "src/server/config-files.ts",
    "src/server/config-limits.ts",
  ];

  it("names only files that cannot reach the gate", () => {
    // The structural half of the exception, which `tests/log-level.test.ts`
    // cannot see: it asserts each file still warns somewhere, and a file that
    // moved its warning out of the first configuration read would pass. A file
    // that imports `log` has somewhere else to write and does not need excusing.
    const reaching = EXCUSED.filter((path) => /from "\.\.?\/log\.js"/.test(fileAt(path).code));

    expect(reaching).toEqual([]);
  });
});

/** The argument list of a call opening at `from`, balanced to its closing paren. */
function argumentsOf(text: string, from: number) {
  let depth = 1;
  let end = from;
  while (depth > 0 && end < text.length) {
    const character = text[end];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    end += 1;
  }
  return text.slice(from, end - 1);
}

/**
 * The two shapes §2.3 and §2.4 record a disagreement about, measured.
 *
 * `dotted` is a log line written as an event key and a field object rather than
 * as a sentence. `stringified` is a log call that hands an identifier bound by a
 * `catch` in the same file to `String()`, which for a database error yields the
 * statement and every value bound into it.
 */
function loggingShapes() {
  const dotted: string[] = [];
  const stringified: string[] = [];
  for (const file of server) {
    const caught = new Set(
      [...file.code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!),
    );
    for (const call of file.code.matchAll(/log\.(?:debug|info|warn|error)\(/g)) {
      const where = `${file.path}:${lineOf(file.code, call.index)}`;
      const args = argumentsOf(file.code, call.index + call[0].length);
      if (/^\s*"[a-z0-9_]+(?:\.[a-z0-9_]+)+"/.test(args)) dotted.push(where);
      const named = [...args.matchAll(/String\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map(
        (match) => match[1]!,
      );
      if (named.some((name) => caught.has(name))) stringified.push(where);
    }
  }
  return { dotted, stringified };
}

const filesOf = (sites: string[]) => [...new Set(sites.map((site) => site.split(":")[0]!))].sort();

describe("the billing subsystem's logging", () => {
  const SUBSYSTEM = ["src/server/services/billing.ts", "src/server/stripe.ts"];

  it("is where both recorded disagreements are, and nowhere else", () => {
    const { dotted, stringified } = loggingShapes();

    // Bounding the disagreement rather than blessing it. §2.3 and §2.4 describe
    // what the rest of the server does; a third subsystem adopting either shape
    // would make them describe a minority, which is the point at which a rule
    // stops being a rule.
    expect(filesOf(dotted)).toEqual(SUBSYSTEM);
    expect(filesOf(stringified)).toEqual(SUBSYSTEM);
  });

  it("is recorded in the guide at the size it actually is", () => {
    const { dotted, stringified } = loggingShapes();
    // Flattened, because the sentence these numbers live in is wrapped at 80
    // columns and a line break through the middle of it is not a disagreement.
    const guide = readFileSync(GUIDE, "utf8").replaceAll(/\s+/g, " ");

    // Measured and compared, never regenerated: a count written into a page and
    // left there is the drift these two sections exist to stop. When the code is
    // fixed this fails, and the fix is to rewrite the paragraph rather than the
    // number.
    expect(guide, "update the measured counts in observability.md §2.3 and §2.4").toContain(
      `${dotted.length} lines in \`src/server/services/billing.ts\` and \`src/server/stripe.ts\``,
    );
    expect(guide, "update the measured counts in observability.md §2.4").toContain(
      `${stringified.length} log calls across the same two files`,
    );
  });
});
