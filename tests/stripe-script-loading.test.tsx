// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stripe's script loads on the plan tab, when there is a payment to confirm,
 * and nowhere else.
 *
 * The default `@stripe/stripe-js` entry breaks that by being imported: one
 * microtask later it appends `<script src="https://js.stripe.com/…">` whether or
 * not `loadStripe` is ever called. `PlanPage` is imported by the app shell, so
 * every page of every deployment — the sign-in screen, a subscriber's
 * balances, a deployment that sells nothing — fetched Stripe.js. Where ads
 * widen the policy it ran; everywhere else the policy refused it and the
 * console said so on every load. The browser suite could not see either,
 * because the Vite dev server it runs against sends no policy at all.
 */
const stripeScripts = () =>
  [...document.querySelectorAll("script")].filter((script) =>
    (script.getAttribute("src") ?? "").includes("js.stripe.com"),
  );

/** Long enough for the default entry's `Promise.resolve().then(…)` to have run. */
const settle = async () => {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  for (const script of stripeScripts()) script.remove();
  vi.resetModules();
});

describe("where Stripe's script is fetched", () => {
  it("is not fetched by importing the plan page", async () => {
    await import("../src/client/pages/PlanPage.js");
    await settle();

    expect(stripeScripts().map((script) => script.src)).toEqual([]);
  });

  /**
   * The same promise one step wider. A module that imports the default entry
   * for a value — not a type — reintroduces the injection wherever that module
   * is loaded, and the test above only watches one of them. Type imports are
   * erased under `verbatimModuleSyntax`, so they are the one spelling that is
   * safe, and `/pure` is the only entry that injects nothing until asked.
   */
  it("is imported for a value from the pure entry only, anywhere in the browser app", () => {
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    // From the working directory rather than `import.meta.url`, which jsdom
    // hands back as a URL with no file path in it.
    walk(join(process.cwd(), "src", "client"));

    const offenders = files.filter((file) =>
      /^import\s+(?!type\b)[^;]*from\s+["']@stripe\/stripe-js["']/m.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
