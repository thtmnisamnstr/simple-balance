import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/server/api.js";

/**
 * The file that decides whether an operator is paid.
 *
 * AdSense treats inventory on a domain with no `/ads.txt` as unauthorised and
 * pays nothing for it. The failure is silent from inside the product — ads
 * render, impressions happen, revenue is zero — so the file existing and being
 * correct is worth pinning rather than trusting.
 */
describe("the authorised-sellers file", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  async function freshApp(ads: boolean) {
    vi.resetModules();
    if (ads) {
      process.env.ADSENSE_CLIENT_ID = "ca-pub-1234567890123456";
      process.env.ADSENSE_BANNER_SLOT_ID = "9876543210";
      // Required once AdSense is configured: the server refuses to start
      // without it, because Google's terms require a policy on any site
      // serving their ads.
      process.env.PRIVACY_POLICY_URL = "https://smpl.money/privacy/";
    } else {
      delete process.env.ADSENSE_CLIENT_ID;
      delete process.env.ADSENSE_BANNER_SLOT_ID;
      delete process.env.PRIVACY_POLICY_URL;
    }
    const module = (await import("../src/server/api.js")) as { default: typeof app };
    return module.default;
  }

  it("declares Google as an authorised seller for the operator's own publisher id", async () => {
    const server = await freshApp(true);
    const response = await server.request("http://localhost/ads.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    // `pub-…`, not `ca-pub-…`. The ad code uses one spelling and this file uses
    // the other, and the wrong one parses cleanly while authorising nobody.
    expect(await response.text()).toBe(
      "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n",
    );
  });

  it("does not exist on a deployment that serves no ads", async () => {
    const server = await freshApp(false);
    const response = await server.request("http://localhost/ads.txt");
    // Either a 404 or the single-page shell, depending on whether a built
    // client is on disk. What matters is that no declaration comes back: a
    // deployment showing no ads must not be telling crawlers who may sell its
    // inventory.
    expect(await response.text()).not.toContain("f08c47fec0942fa0");
  });
});
