import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { describe, expect, it } from "vitest";
import {
  isStripeSurfacePath,
  type SecuritySurface,
  securityHeaderOptions,
} from "../src/server/http-security.js";

/**
 * The split deployment serves the application shell and the hashed assets from
 * nginx, so those responses never pass through the middleware that sets the
 * policy. nginx repeats it, which means the policy exists twice — once in
 * TypeScript and once in an nginx include — and two lists in two languages
 * drift silently. The response that drifts is the document that runs the app.
 */
const nginxHeaders = (file: string) => {
  const conf = readFileSync(new URL(`../deploy/docker/${file}`, import.meta.url), "utf8");
  return new Map(
    [...conf.matchAll(/^add_header\s+(\S+)\s+(?:"([^"]*)"|(\$\w+))\s+always;/gm)].map((match) => [
      match[1]!.toLowerCase(),
      match[2] ?? match[3]!,
    ]),
  );
};

/**
 * The two values `$sb_plan_csp` can take, read out of the template's map.
 *
 * The plan page's policy is not a constant in a snippet the way the rest are:
 * it depends on whether the deployment sells anything, so the snippet names a
 * variable and the template maps it. Both arms are checked — the selling one
 * against the Stripe surface, and the default against the ordinary one, because
 * a deployment that sells nothing must serve that path exactly as it serves
 * every other.
 */
const nginxMap = (name: string) => {
  const template = readFileSync(
    new URL("../deploy/docker/nginx.conf.template", import.meta.url),
    "utf8",
  );
  // The source is matched loosely — a bare `${NAME}`, a quoted one, or two
  // joined with a separator — because which shape a map uses is a detail of
  // what it has to decide. A parser that knew only one shape would stop
  // matching when a map gained a second input and pass while comparing nothing,
  // which is how this file's own regexes have gone quiet before.
  const block = new RegExp(`map\\s+"?[^"\\n]*?"?\\s+\\$${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    template,
  );
  if (!block) throw new Error(`no $${name} map in nginx.conf.template`);
  const arms = new Map(
    [
      ...block[1]!.matchAll(/^\s*(?:"([^"]*)"|(default))\s+(?:"([^"]*)"|'([^']*)'|(\$\w+));$/gm),
    ].map((match) => [match[1] ?? match[2]!, match[3] ?? match[4] ?? match[5]!] as const),
  );
  // A map with no arms is a regex that stopped matching, not a map with no
  // arms. Every one of these has at least one named arm and a default.
  if (arms.size < 2) throw new Error(`parsed no arms out of $${name}`);
  return arms;
};

/** Which arm a map yields for a given combination of settings. */
const armFor = (name: string, ...values: string[]) => {
  const arms = nginxMap(name);
  return arms.get(values.join(":")) ?? arms.get("default")!;
};

const planPolicies = () => ({
  configured: armFor("sb_plan_policy", "true", "true"),
  // Where Stripe is not configured the plan path is an ordinary page, so it
  // defers to whatever every other page carries rather than to a second copy of
  // the strict policy — which is what keeps it agreeing with the API when ads
  // are on.
  otherwise: armFor("sb_plan_policy", "false", "true"),
});

/** The policy every page but the plan tab carries, in each ads state. */
const appPolicies = () => ({
  withAds: armFor("sb_app_csp", "true"),
  without: armFor("sb_app_csp", "false"),
});

/** What a real response out of the middleware carries, not a list of guesses. */
const apiHeaders = async (surface: SecuritySurface = "app", reportOnly = false, ads = false) => {
  const app = new Hono();
  // Production, because that is what the split deployment runs and the only
  // mode that sets HSTS.
  app.use("*", secureHeaders(securityHeaderOptions(true, { surface, reportOnly, ads })));
  app.get("/", (c) => c.text("ok"));
  const response = await app.request("/");
  const headers = new Map<string, string>();
  response.headers.forEach((value, name) => headers.set(name.toLowerCase(), value));
  return headers;
};

describe("the security headers nginx repeats", () => {
  it("carries every header the API sets, with the same value", async () => {
    const api = await apiHeaders();
    const nginx = nginxHeaders("nginx-security-headers.conf");
    // Not a policy; it is what the response happens to be.
    api.delete("content-type");

    const missing = [...api.keys()].filter((name) => !nginx.has(name));
    expect(missing, `set by the API and not by nginx: ${missing.join(", ")}`).toEqual([]);

    for (const [name, value] of api) {
      // The policy is the one header nginx spells as a variable, because it
      // depends on whether ads are configured. Checked against the map instead.
      if (name === "content-security-policy") continue;
      expect(nginx.get(name), `${name} differs`).toBe(value);
    }
    expect(nginx.get("content-security-policy")).toBe("$sb_app_csp");
    expect(appPolicies().without).toBe(api.get("content-security-policy"));
  });

  it("adds nothing the API does not set", async () => {
    const api = await apiHeaders();
    const extra = [...nginxHeaders("nginx-security-headers.conf").keys()].filter(
      (name) => !api.has(name),
    );
    expect(extra, `set by nginx alone: ${extra.join(", ")}`).toEqual([]);
  });

  /**
   * X-Frame-Options and `frame-ancestors` say the same thing to two generations
   * of browser, so one saying DENY while the other says 'none' — or worse,
   * SAMEORIGIN, which Hono defaults to — is the pair disagreeing about whether
   * this application may be framed by itself.
   */
  it("says the same thing about framing in both headers", async () => {
    const api = await apiHeaders();
    expect(api.get("x-frame-options")).toBe("DENY");
    expect(api.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

/**
 * The plan and billing tab is the one page whose policy differs, and the one
 * page nginx has to be told about separately.
 *
 * It shipped once with the API half written and the nginx half missing, on the
 * strength of a comment claiming nginx proxies the document to the API. It does
 * not — nginx serves the shell itself and proxies four prefixes — so in the
 * split deployment the payment form could not load at all, with nothing on the
 * page to say why. That is exactly the drift the file above exists to catch,
 * one surface over, and it was invisible because the comparison only ever ran
 * for the default surface.
 */
describe("the plan page's wider policy, in both places it is written", () => {
  it("repeats every header the API sets for that surface", async () => {
    const api = await apiHeaders("stripe");
    const nginx = nginxHeaders("nginx-security-headers-plan.conf");
    api.delete("content-type");

    const missing = [...api.keys()].filter((name) => !nginx.has(name));
    expect(missing, `set by the API and not by nginx: ${missing.join(", ")}`).toEqual([]);

    for (const [name, value] of api) {
      // The policy itself is the one header nginx spells as a variable, because
      // it depends on configuration. Checked against the map below instead.
      if (name === "content-security-policy") continue;
      expect(nginx.get(name), `${name} differs`).toBe(value);
    }
  });

  it("serves the same policy the API would, when the deployment sells something", async () => {
    const api = await apiHeaders("stripe");
    expect(planPolicies().configured).toBe(api.get("content-security-policy"));
  });

  /**
   * And the arm that matters for everybody else. A deployment that never set
   * `SB_BILLING_ENABLED` has no plan tab to serve, so that path must come back
   * under exactly the policy every other page gets — not a wider one that
   * happens to have nothing to load.
   */
  it("falls back to the ordinary policy where Stripe is not configured", () => {
    // Literally the same variable, so it cannot drift from it — including when
    // ads widen that policy, which a hardcoded copy here did not follow.
    expect(planPolicies().otherwise).toBe("$sb_app_csp");
  });

  it("names a variable in the snippet rather than freezing one arm into it", () => {
    expect(nginxHeaders("nginx-security-headers-plan.conf").get("content-security-policy")).toBe(
      "$sb_plan_csp",
    );
  });

  /**
   * The two matchers agree about which paths get the wider policy.
   *
   * nginx matches `^/settings/plan/?$` and the API normalises before comparing,
   * because the browser's own router renders the plan tab for both spellings.
   * One of them matching where the other does not is a payment form that loads
   * in one deployment shape and not the other.
   */
  it("matches the same paths on both sides", () => {
    const conf = readFileSync(
      new URL("../deploy/docker/nginx.conf.template", import.meta.url),
      "utf8",
    );
    // The block that includes the plan snippet, not merely the first regex
    // location in the file — the proxy block above it is also a regex, and
    // matching that one would have compared the wrong rule and passed.
    const location =
      /location\s+~\s+(\S+)\s*\{(?:(?!\n  \})[\s\S])*security-headers-plan\.conf/.exec(conf);
    expect(location, "no regex location including the plan header snippet").not.toBeNull();
    const nginxMatcher = new RegExp(location![1]!);

    // nginx matches the location against the *decoded*, slash-merged URI, so
    // comparing a raw string against the location regex models something nginx
    // never does — which is how a percent-encoded lookalike passed this test
    // while really reaching the block. The raw check nginx now applies is the
    // `$sb_plan_raw` map, so both are modelled: the location as nginx matches
    // it, and the raw gate as written.
    const asNginxMatches = (path: string) => decodeURIComponent(path).replaceAll(/\/+/g, "/");
    const rawGate = new RegExp(
      /map \$request_uri \$sb_plan_raw \{\s*"~([^"]*)"/.exec(
        readFileSync(new URL("../deploy/docker/nginx.conf.template", import.meta.url), "utf8"),
      )![1]!,
    );
    const nginxServes = (path: string) =>
      nginxMatcher.test(asNginxMatches(path)) && rawGate.test(path);

    for (const path of ["/settings/plan", "/settings/plan/"]) {
      expect(isStripeSurfacePath(path), `API: ${path}`).toBe(true);
      expect(nginxServes(path), `nginx: ${path}`).toBe(true);
    }
    for (const path of [
      "/settings",
      "/settings/plans",
      "/settings/plan/extra",
      "/accounts",
      // The spellings that decode or normalise into the plan path. nginx would
      // match the location for each; the raw gate is what refuses them, and the
      // API refuses them by matching the raw path too. Divergence here is a
      // policy widened for a page the browser's router does not render.
      "/settings/%70lan",
      "/settings/plan%2F",
      "/SETTINGS/PLAN",
    ]) {
      expect(isStripeSurfacePath(path), `API: ${path}`).toBe(false);
      expect(nginxServes(path), `nginx: ${path}`).toBe(false);
    }
  });
});

/**
 * The rehearsal, which is the one mode where the two halves could disagree
 * about whether a page is protected at all.
 *
 * `SB_CSP_REPORT_ONLY` makes the plan tab report what its policy would have
 * blocked and block nothing. It reaches that page and no other, deliberately:
 * every other page keeps enforcing the policy this container has shipped since
 * 0.1.0, because learning about a page that renders no balances is not worth
 * taking the defence off every page that does.
 */
describe("rehearsing the plan page's policy instead of enforcing it", () => {
  it("sends the same report-only policy the API would", async () => {
    const api = await apiHeaders("stripe", true);
    expect(
      armFor("sb_plan_csp_report_only", "true", "true", "true").replace(
        "$sb_plan_policy",
        planPolicies().configured,
      ),
    ).toBe(api.get("content-security-policy-report-only"));
  });

  it("names the same place for the reports to go", async () => {
    const api = await apiHeaders("stripe", true);
    // Single-quoted in the template because the value itself carries double
    // quotes, which `nginxMap` reads either way.
    expect(armFor("sb_csp_reporting_endpoints", "true", "true", "true")).toBe(
      api.get("reporting-endpoints"),
    );
  });

  it("emits exactly one of the two headers, in each mode", async () => {
    const rehearsing = await apiHeaders("stripe", true);
    expect(rehearsing.get("content-security-policy")).toBeUndefined();
    expect(rehearsing.get("content-security-policy-report-only")).toBeTruthy();

    const enforcing = await apiHeaders("stripe", false);
    expect(enforcing.get("content-security-policy")).toBeTruthy();
    expect(enforcing.get("content-security-policy-report-only")).toBeUndefined();

    // nginx spells the same exclusivity with two `add_header` directives whose
    // values are empty in the opposite mode — it omits an empty one — so both
    // maps have to carry an empty arm or a page would get both headers.
    expect(armFor("sb_plan_csp", "true", "true", "true")).toBe("");
    expect(armFor("sb_plan_csp_report_only", "false", "true", "true")).toBe("");
  });

  /** The rehearsal stops at the plan tab. This is the assertion that says so. */
  it("leaves every other page enforcing", async () => {
    const ordinary = await apiHeaders("app", true);
    expect(ordinary.get("content-security-policy")).toBeTruthy();
    expect(ordinary.get("content-security-policy-report-only")).toBeUndefined();

    const conf = readFileSync(
      new URL("../deploy/docker/nginx-security-headers.conf", import.meta.url),
      "utf8",
    );
    expect(conf).not.toContain("Report-Only");
  });
});

/**
 * What each side asks in order to choose a policy, rather than what it answers.
 *
 * Comparing only the two policy strings leaves the most expensive mistake
 * invisible: nginx asked "is a plan for sale" while the API asked "is Stripe
 * configured", and both produced byte-identical policies for the case the test
 * happened to check. The case it did not check is an operator winding a
 * deployment down — `SB_BILLING_ENABLED=false` with the Stripe settings kept,
 * exactly as the runbook instructs — where their subscribers are still being
 * charged and still need to replace an expired card on that page. nginx served
 * it the strict policy, Stripe's script was blocked, and the card could not be
 * replaced.
 */
describe("the question each side asks before choosing a policy", () => {
  const template = () =>
    readFileSync(new URL("../deploy/docker/nginx.conf.template", import.meta.url), "utf8");

  const sourceOf = (name: string) => {
    const match = new RegExp(`map\\s+("?[^"\\n]*?"?)\\s+\\$${name}\\s*\\{`).exec(template());
    if (!match) throw new Error(`no $${name} map in nginx.conf.template`);
    return match[1]!;
  };

  it("asks whether Stripe is configured, not whether a plan is for sale", () => {
    // The API asks `getConfig().billing`, which `parseBillingSettings` returns
    // whenever the five STRIPE_* values are present — regardless of the selling
    // flag. `auth-policy.ts` draws the same line with `stripeConfigured()`.
    const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
    expect(api).toContain("getConfig().billing && isStripeSurfacePath(rawPathOf(c.req.url))");
    expect(sourceOf("sb_plan_policy")).toContain("SB_BILLING_CONFIGURED");
    expect(sourceOf("sb_plan_policy")).not.toContain("SB_BILLING_ENABLED");
  });

  /**
   * And the rehearsal asks both questions, because there is nothing to rehearse
   * where there is no Stripe policy. A deployment with no Stripe that set the
   * flag would otherwise report on the strict policy and enforce nothing, which
   * is worse than the enforcement it replaced. The API draws the same line by
   * scoping `reportOnly` to the `stripe` surface.
   */
  it("rehearses only where there is a Stripe policy to rehearse", () => {
    for (const name of ["sb_plan_csp", "sb_plan_csp_report_only", "sb_csp_reporting_endpoints"]) {
      expect(sourceOf(name), name).toContain("SB_BILLING_CONFIGURED");
      expect(sourceOf(name), name).toContain("SB_CSP_REPORT_ONLY");
    }
    // With Stripe unconfigured, the rehearsal arm is not selected whatever the
    // flag says: the page keeps an enforced policy.
    expect(armFor("sb_plan_csp", "false", "true", "true")).not.toBe("");
    expect(armFor("sb_plan_csp_report_only", "false", "true", "true")).toBe("");
  });

  /**
   * Every map source is quoted. An unset or empty value renders as nothing at
   * all, and a bare empty source is `[emerg] invalid number of arguments in
   * "map" directive` — the container refuses to start rather than falling back.
   */
  it("quotes every map source, so an empty value falls back instead of refusing to start", () => {
    for (const name of [
      "sb_app_csp",
      "sb_plan_policy",
      "sb_plan_csp",
      "sb_plan_csp_report_only",
      "sb_csp_reporting_endpoints",
    ]) {
      expect(sourceOf(name), name).toMatch(/^".*"$/);
    }
  });
});

/**
 * The ads axis, which widens the policy on every page *except* the plan tab.
 *
 * It is the opposite shape to the Stripe surface — that one page against all the
 * others — and the two never combine: ads live in the application shell and the
 * plan tab is the one page this product promises not to put them on.
 *
 * There was no comparison for this at all when the axis landed, which is how a
 * fully wired AdSense configuration could be blocked by the app's own policy
 * while eighty-three tests stayed green.
 */
describe("the policy when a deployment serves advertising", () => {
  it("widens the ordinary policy the same way on both transports", async () => {
    const api = await apiHeaders("app", false, true);
    expect(appPolicies().withAds).toBe(api.get("content-security-policy"));
  });

  it("leaves the ordinary policy untouched when no ads are configured", async () => {
    const api = await apiHeaders("app");
    expect(appPolicies().without).toBe(api.get("content-security-policy"));
  });

  /**
   * The plan tab never carries ads, so its policy must not widen when they are
   * on. If it did, the page that takes somebody's card details would be the one
   * page allowing scripts from any HTTPS origin.
   */
  it("never widens the plan tab, which carries no ads", async () => {
    const withAds = await apiHeaders("stripe", false, true);
    const without = await apiHeaders("stripe");
    expect(withAds.get("content-security-policy")).toBe(without.get("content-security-policy"));
    expect(withAds.get("content-security-policy")).not.toContain("'unsafe-eval'");
  });

  it("keeps what the widening does not buy", async () => {
    const api = (await apiHeaders("app", false, true)).get("content-security-policy") ?? "";
    // The page still cannot be reaimed or framed and plugin embedding stays
    // closed, whatever the ad stack needs.
    expect(api).toContain("base-uri 'self'");
    expect(api).toContain("form-action 'self'");
    expect(api).toContain("frame-ancestors 'none'");
    expect(api).toContain("object-src 'none'");
    // `'unsafe-inline'` is granted for styles and withheld for scripts, and the
    // distinction is the point: Google's consent message styles itself with
    // injected `<style>` blocks and will not render without it, while an
    // injected *script* written inline into the document stays impossible.
    expect(api).toContain("style-src 'self' 'unsafe-inline'");
    expect(api).toMatch(/script-src (?!.*'unsafe-inline')/);
  });

  /**
   * The consent message is not in an iframe.
   *
   * It appends into this document and styles itself from injected blocks and a
   * Google font stylesheet. Under `style-src 'self'` it renders unstyled and in
   * the normal flow far down the page, nobody answers it, and in the EEA and UK
   * no ad request completes — which looks exactly like having no inventory.
   */
  it("carries what Google's consent message needs to render", async () => {
    const api = (await apiHeaders("app", false, true)).get("content-security-policy") ?? "";
    expect(api).toContain("'unsafe-inline'");
    expect(api).toContain("font-src");

    const without = (await apiHeaders("app")).get("content-security-policy") ?? "";
    expect(without).not.toContain("'unsafe-inline'");
    expect(without, "no font-src at all where no ads are served").not.toContain("font-src");
  });
});
