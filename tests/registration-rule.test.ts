import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRegistrationRule } from "../src/server/config.js";

const originalAllowedEmails = process.env.ALLOWED_EMAILS;
const originalAuthMode = process.env.AUTH_MODE;

afterEach(() => {
  if (originalAllowedEmails === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = originalAllowedEmails;
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
  vi.resetModules();
});

/**
 * This decides who is allowed to hold an account on a deployment, so the
 * interesting cases are the ones where a mistake quietly admits the wrong
 * person rather than the ones where it obviously fails.
 */
describe("who may register", () => {
  it("admits nobody when nothing is configured", () => {
    expect(parseRegistrationRule(undefined)).toEqual({ kind: "closed" });
    expect(parseRegistrationRule("")).toEqual({ kind: "closed" });
    expect(parseRegistrationRule("  ,  ,")).toEqual({ kind: "closed" });
  });

  it("admits anyone for a star, wherever it appears in the list", () => {
    expect(parseRegistrationRule("*")).toEqual({ kind: "anyone" });
    expect(parseRegistrationRule("you@example.com, *")).toEqual({
      kind: "anyone",
    });
  });

  it("reads addresses and domains apart", () => {
    const rule = parseRegistrationRule(
      "You@Example.com, pinecone.io, @usc.edu",
    );
    expect(rule).toMatchObject({ kind: "list" });
    const list = rule as Extract<typeof rule, { kind: "list" }>;
    expect([...list.emails]).toEqual(["you@example.com"]);
    expect([...list.domains].sort()).toEqual(["pinecone.io", "usc.edu"]);
  });

  it("refuses entries that are neither", () => {
    for (const bad of ["not a domain", "@", "you@", "@@example.com", "example"]) {
      expect(() => parseRegistrationRule(bad)).toThrow(/ALLOWED_EMAILS/);
    }
  });
});

describe("matching an address against the rule", () => {
  // The shipped function, not a restatement of it. isEmailAllowed reads the
  // process configuration, so each case builds the configuration it needs and
  // then asks the real thing.
  const matches = async (raw: string, email: string) => {
    if (raw === "") delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = raw;
    process.env.AUTH_MODE = "local";
    vi.resetModules();
    const { isEmailAllowed } = await import("../src/server/config.js");
    return isEmailAllowed(email);
  };

  it("matches an exact address regardless of case or padding", async () => {
    expect(await matches("you@example.com", "  YOU@Example.COM ")).toBe(true);
    expect(await matches("you@example.com", "someone@example.com")).toBe(false);
  });

  it("matches every address at an allowed domain", async () => {
    expect(await matches("pinecone.io", "anyone@pinecone.io")).toBe(true);
    expect(await matches("@usc.edu", "student@usc.edu")).toBe(true);
    expect(await matches("pinecone.io", "anyone@example.com")).toBe(false);
  });

  // A subdomain is a different domain and may be under someone else's control,
  // so allowing example.com must not hand out mail.example.com.
  it("does not treat a subdomain as the domain", async () => {
    expect(await matches("example.com", "someone@mail.example.com")).toBe(false);
    expect(await matches("example.com", "someone@notexample.com")).toBe(false);
  });

  // The address before the @ is compared whole, so a plus tag is a different
  // address. Someone wanting the whole domain should say the domain.
  it("treats a plus tag as part of the address", async () => {
    expect(await matches("you@example.com", "you+other@example.com")).toBe(false);
    expect(await matches("example.com", "you+other@example.com")).toBe(true);
  });

  // An address may legally contain an @ in a quoted local part, so the domain
  // is whatever follows the LAST one.
  it("splits on the last at sign", async () => {
    expect(await matches("example.com", '"odd@name"@example.com')).toBe(true);
    expect(await matches("example.com", "someone@example.com@evil.test")).toBe(false);
  });

  it("closed admits nobody and star admits everybody", async () => {
    expect(await matches("", "anyone@anywhere.test")).toBe(false);
    expect(await matches("*", "anyone@anywhere.test")).toBe(true);
  });

  /**
   * Whether the setup code is any use is a different question from whether it
   * is required, and the startup log needs the first one. The sign-up route
   * reads the code only after the rule has turned an address away, so a rule
   * that turns nobody away makes it unreachable. Printing one anyway told the
   * operator to go and find a code no request would ever look at.
   */
  describe("whether the setup code can be used at all", () => {
    const openToAnyone = async (allowed: string) => {
      process.env.ALLOWED_EMAILS = allowed;
      process.env.AUTH_MODE = "local";
      vi.resetModules();
      const { isRegistrationOpenToAnyone } = await import(
        "../src/server/config.js"
      );
      return isRegistrationOpenToAnyone();
    };

    it("is no use when the rule admits everyone", async () => {
      expect(await openToAnyone("*")).toBe(true);
    });

    it("is the only way in when the rule admits nobody", async () => {
      expect(await openToAnyone("")).toBe(false);
    });

    // The middle case, and the reason this is not just isRegistrationClosed:
    // an address the list does not name still needs the code while the
    // instance is unclaimed.
    it("still reachable when the rule names some addresses", async () => {
      expect(await openToAnyone("you@example.com")).toBe(false);
      expect(await openToAnyone("example.com")).toBe(false);
    });
  });
});
