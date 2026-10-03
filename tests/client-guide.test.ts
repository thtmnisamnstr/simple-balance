// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The two rules in `docs/standards/code/client.md` that are about what a module
 * may do rather than about what it renders: 3.4, a third-party script is
 * fetched by what needs it, and 2.3, the server decides an entitlement.
 *
 * Both are here rather than in the browser tier on purpose, and the reason is
 * the same for each. Neither dev server sends the content security policy, so a
 * script fetched by an import is invisible to Playwright — it loads, and the
 * only complaint is in a production console nobody reads on the sign-in screen.
 * And an entitlement computed in the browser agrees with the server right up
 * until the moment it does not, which is a moment no test can schedule.
 */

/** Long enough for a `Promise.resolve().then(…)` in an imported module to run. */
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Every script in the document whose address leaves this origin.
 *
 * By origin rather than by vendor name: the rule is about the next vendor, and
 * a list of hosts already met would pass the one that has not been met yet.
 * A relative `src` resolves to this origin and is the app's own bundle.
 */
const foreignScripts = () =>
  [...document.querySelectorAll("script")]
    .map((script) => script.getAttribute("src"))
    .filter((src): src is string => src !== null)
    .filter((src) => {
      const resolved = URL.parse(src, document.baseURI);
      return resolved !== null && resolved.origin !== new URL(document.baseURI).origin;
    });

afterEach(() => {
  for (const script of document.querySelectorAll("script")) script.remove();
});

describe("client.md 3.4: a third-party script is fetched by what needs it", () => {
  /**
   * The shell, because the shell is what made the original defect universal.
   * `PlanPage` is imported by `App.tsx` for a value, so a vendor entry that
   * injects on import injects on every page of every deployment — including
   * one that sells nothing and one nobody has signed in to yet.
   */
  it("fetches nothing by importing the app shell", async () => {
    await import("../src/client/App.js");
    await settle();

    expect(foreignScripts()).toEqual([]);
  });

  /**
   * The other way the same thing gets done, and the one that looks most like
   * documentation says to: both vendors' own quick-starts put a `<script>` in
   * the page. Here that would fetch the script before the session has resolved,
   * which is before anything knows whether this person pays not to see ads.
   */
  it("names no cross-origin script or stylesheet in the shell page", () => {
    const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
    const addresses = [
      ...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g),
      ...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/g),
    ].map((match) => match[1]!);

    expect(addresses.length).toBeGreaterThan(0);
    // A scheme or a protocol-relative `//host` both leave this origin; every
    // address the page is allowed to carry is a path under it.
    expect(addresses.filter((address) => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(address))).toEqual([]);
  });
});

/**
 * client.md 2.3, as a property of the source rather than of a render.
 *
 * These two are the deciders: `resolveEntitlement` turns a plan and an override
 * into what somebody may do, and `frozenAccountIds` turns that into a set of
 * ids. Both live in `src/shared` and so are reachable from the browser — the
 * module boundary allows it, which is exactly why this needs saying.
 *
 * The sentence-makers beside them are deliberately absent from this list.
 * `accountAllowance`, `restoreAllowance`, `frozenAccountRefusal`,
 * `activeChoicePending` and `planChangeTakesEffect` are all imported by the
 * client and all correct: each renders something the server has decided or will
 * decide, which is rule 2.2 rather than a breach of 2.3.
 */
const DECIDERS = ["resolveEntitlement", "frozenAccountIds"];

describe("client.md 2.3: the server decides an entitlement", () => {
  const client = sourceFiles("src/client");
  const domain = readFileSync(path.join(repoRoot, "src/shared/domain.ts"), "utf8");

  it("has no entitlement decider reaching the browser app", () => {
    // `code` has every comment blanked, so the three sites that name these
    // functions while explaining why they are not called do not fire. Blanked
    // rather than stripped, so a failure still reports the real line.
    const offenders = client.flatMap((file) =>
      DECIDERS.flatMap((name) =>
        new RegExp(`\\b${name}\\b`).test(file.code) ? [`${file.path}: ${name}`] : [],
      ),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * Held against the module that defines them, because a rename would otherwise
   * void the check above without failing anything: every file would stop
   * matching a name nothing exports and the test would go green.
   */
  it("still names functions that exist", () => {
    expect(DECIDERS.filter((name) => !domain.includes(`export function ${name}(`))).toEqual([]);
  });
});
