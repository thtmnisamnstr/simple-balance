import { describe, expect, it, vi, afterEach } from "vitest";
import app from "../src/server/api.js";
import {
  CSP_REPORT_PATH,
  isStripeSurfacePath,
  rawPathOf,
  securityHeaderOptions,
} from "../src/server/http-security.js";

/**
 * The rehearsal switch: report what the policy would block, block nothing.
 *
 * It exists because this release widens the policy for one page against a
 * vendor whose host list is published only in part, so an operator needs a way
 * to find out what their own deployment would refuse before it refuses it.
 *
 * Two things have to be true for that to be worth anything. The enforcing
 * header has to be *gone* — a report-only copy beside an enforcing one is not a
 * rehearsal, the page breaks exactly as it would have — and the reports have to
 * reach somewhere, which needs a route that a browser's own POST can get to.
 */
describe("the content security policy in report-only mode", () => {
  it("sends the report-only header and no enforcing one", () => {
    const options = securityHeaderOptions(true, { surface: "stripe", reportOnly: true });
    expect(options.contentSecurityPolicyReportOnly).toBeDefined();
    // Not merely absent from the type: actually undefined, so `secureHeaders`
    // emits no enforcing header at all.
    expect(options.contentSecurityPolicy).toBeUndefined();
  });

  it("describes the same policy it would have enforced", () => {
    const rehearsing = securityHeaderOptions(true, { surface: "stripe", reportOnly: true });
    const enforcing = securityHeaderOptions(true, { surface: "stripe" });
    const reported = { ...rehearsing.contentSecurityPolicyReportOnly };
    // The reporting directives are the only difference; a rehearsal of a
    // different policy would tell an operator nothing about the real one.
    delete reported.reportUri;
    delete reported.reportTo;
    expect(reported).toEqual(enforcing.contentSecurityPolicy);
  });

  it("names somewhere for the reports to go, in both spellings", () => {
    // The stripe surface, because that is the only one the rehearsal touches.
    const options = securityHeaderOptions(true, { surface: "stripe", reportOnly: true });
    // `report-uri` is deprecated and is the one every browser in the field
    // implements; `report-to` is its replacement and needs the header below.
    // One without the other is a rehearsal that collects nothing somewhere.
    expect(options.contentSecurityPolicyReportOnly?.reportUri).toBe(CSP_REPORT_PATH);
    expect(options.contentSecurityPolicyReportOnly?.reportTo).toBe("csp");
    expect(options.reportingEndpoints).toEqual([{ name: "csp", url: CSP_REPORT_PATH }]);
  });

  /**
   * And the restriction that makes the whole thing acceptable: asking for a
   * rehearsal on any other surface gets an enforced policy anyway. Taking the
   * defence off every page that renders balances, to learn about a page that
   * renders none, is not a trade worth offering.
   */
  it("refuses to rehearse any page but the plan tab", () => {
    const ordinary = securityHeaderOptions(true, { surface: "app", reportOnly: true });
    expect(ordinary.contentSecurityPolicy).toBeDefined();
    expect(ordinary.contentSecurityPolicyReportOnly).toBeUndefined();
    expect(ordinary).toEqual(securityHeaderOptions(true, { surface: "app" }));
  });

  it("adds nothing at all when it is off, which is the default", () => {
    const off = securityHeaderOptions(true, { surface: "stripe" });
    expect(off.contentSecurityPolicyReportOnly).toBeUndefined();
    expect(off.reportingEndpoints).toBeUndefined();
    expect(off.contentSecurityPolicy?.reportUri).toBeUndefined();
    expect(securityHeaderOptions(true)).toEqual(securityHeaderOptions(true, { surface: "app" }));
  });
});

describe("where a browser posts what the policy would have blocked", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  /** The API app, rebuilt against the environment this test just set. */
  async function freshApp() {
    vi.resetModules();
    const module = (await import("../src/server/api.js")) as { default: typeof app };
    return module.default;
  }

  const report = JSON.stringify({
    "csp-report": {
      "blocked-uri": "https://js.stripe.com/v3",
      "violated-directive": "script-src-elem",
      "document-uri": "https://example.test/settings/plan",
    },
  });

  it("is absent from a deployment that is not rehearsing", async () => {
    process.env.SB_CSP_REPORT_ONLY = "false";
    const server = await freshApp();
    const response = await server.request(`http://localhost${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: report,
    });
    expect(response.status).not.toBe(204);
  });

  /**
   * The content type is the point of this one. A violation report is posted by
   * the browser as `application/csp-report`, never `application/json`, and with
   * no `Origin` this app would recognise — so a route under `/api/v1` would be
   * refused by `protectBrowserMutation` before it was read, and the rehearsal
   * would produce a silence indistinguishable from a clean run.
   */
  it("accepts a report the browser's own POST shape", async () => {
    process.env.SB_CSP_REPORT_ONLY = "true";
    const server = await freshApp();
    const response = await server.request(`http://localhost${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: report,
    });
    expect(response.status).toBe(204);
  });

  it("takes the newer reporting shape as well", async () => {
    process.env.SB_CSP_REPORT_ONLY = "true";
    const server = await freshApp();
    const response = await server.request(`http://localhost${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify([
        {
          type: "csp-violation",
          body: { blockedURL: "https://m.stripe.com/6", effectiveDirective: "connect-src" },
        },
      ]),
    });
    expect(response.status).toBe(204);
  });

  it("answers a body it cannot read rather than failing", async () => {
    // One-way messages with nobody to tell about a failure, the same reasoning
    // the Stripe webhook uses for always answering 2xx.
    process.env.SB_CSP_REPORT_ONLY = "true";
    const server = await freshApp();
    const response = await server.request(`http://localhost${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "not json at all",
    });
    expect(response.status).toBe(204);
  });
});

/**
 * The path the wider policy is chosen by, compared the way the browser does it.
 *
 * Hono's `c.req.path` decodes percent-escapes, so `/settings/%70lan` would ask
 * for the plan tab's policy while the browser's own router — which does not
 * decode — renders something else. Matching the raw spelling keeps the two
 * asking the same question.
 */
describe("which path gets the wider policy", () => {
  it("matches both spellings the client router renders the plan tab for", () => {
    for (const path of ["/settings/plan", "/settings/plan/", "//settings/plan"]) {
      expect(isStripeSurfacePath(path), path).toBe(true);
    }
  });

  it("matches nothing else, including a percent-encoded lookalike", () => {
    for (const path of [
      "/settings",
      "/settings/plans",
      "/settings/plan/extra",
      "/accounts",
      "/settings/%70lan",
      "/SETTINGS/PLAN",
    ]) {
      expect(isStripeSurfacePath(path), path).toBe(false);
    }
  });

  it("reads a raw path off a URL without decoding it", () => {
    expect(rawPathOf("https://example.test/settings/%70lan?x=1")).toBe("/settings/%70lan");
    expect(rawPathOf("https://example.test/settings/plan")).toBe("/settings/plan");
    expect(rawPathOf("https://example.test/settings/plan#a")).toBe("/settings/plan");
    expect(rawPathOf("https://example.test")).toBe("/");
  });
});
