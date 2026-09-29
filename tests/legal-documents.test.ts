import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What `/api/auth/methods` says about the deployment's privacy policy and terms
 * of use, which is what every screen that links them reads.
 *
 * The policy was published only while AdSense was configured. A deployment
 * that sold a plan and showed no advertising then linked no policy at all —
 * not on the sign-up form that collects a name and an address, and not on the
 * plan tab that takes a payment — which are the places California's online
 * privacy law expects one to be conspicuous. Published whenever it is set now,
 * and the terms beside it.
 *
 * The one query the options make, whether anybody has an account yet, answers
 * from a stand-in: this is about what the payload carries, and a database
 * would add nothing to it.
 */
vi.mock("../src/server/db/client.js", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ limit: async () => [{ id: "owner" }] }) }),
  }),
}));

const environment = { ...process.env };

afterEach(() => {
  process.env = { ...environment };
  vi.resetModules();
});

async function optionsWith(settings: Record<string, string>) {
  for (const name of [
    "PRIVACY_POLICY_URL",
    "TERMS_OF_USE_URL",
    "ADSENSE_CLIENT_ID",
    "ADSENSE_BANNER_SLOT_ID",
    "SMTP_HOST",
    "STRIPE_SECRET_KEY",
  ]) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    AUTH_MODE: "local",
    APP_BASE_URL: "http://localhost:3000",
    AUTH_SECRET: "legal-documents-test-secret-at-least-32-chars",
    ALLOWED_EMAILS: "*",
    ...settings,
  });
  vi.resetModules();
  const { getPublicAuthOptions } = await import("../src/server/auth-policy.js");
  return getPublicAuthOptions();
}

describe("the documents the sign-in screen is told about", () => {
  it("publishes the privacy policy with no ads configured", async () => {
    const options = await optionsWith({
      PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
    });

    expect(options.adsAvailable).toBe(false);
    expect(options).toMatchObject({
      privacyPolicyUrl: "https://smpl.money/privacy/",
    });
  });

  it("publishes the terms of use beside it", async () => {
    const options = await optionsWith({
      PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
      TERMS_OF_USE_URL: "https://smpl.money/terms/",
    });

    expect(options).toMatchObject({
      privacyPolicyUrl: "https://smpl.money/privacy/",
      termsOfUseUrl: "https://smpl.money/terms/",
    });
  });

  it("still publishes the policy the ads require", async () => {
    const options = await optionsWith({
      ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
      ADSENSE_BANNER_SLOT_ID: "9876543210",
      PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
    });

    expect(options.adsAvailable).toBe(true);
    expect(options).toMatchObject({
      privacyPolicyUrl: "https://smpl.money/privacy/",
    });
  });

  it("leaves both out where the operator set neither", async () => {
    const options = await optionsWith({});

    expect(options).not.toHaveProperty("privacyPolicyUrl");
    expect(options).not.toHaveProperty("termsOfUseUrl");
  });
});
