// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme } from "../src/client/theme.js";
import type { Theme } from "../src/client/api.js";

/**
 * The script that paints the theme before the page paints, and the module that
 * paints it afterwards, holding to the same answers.
 *
 * They are two implementations of one rule on purpose and not by neglect: the
 * boot script runs before the bundle exists, so it cannot import the module, and
 * an inline script — which could have shared nothing either — is refused by the
 * Content-Security-Policy. Two implementations of one rule is exactly the thing
 * that drifts, so the rule is asserted against both here.
 */
// jsdom gives `import.meta.url` an http origin, so this joins from the test
// directory rather than resolving a file URL.
const BOOT = readFileSync(path.join(import.meta.dirname, "..", "public/theme-boot.js"), "utf8");

/** Runs the boot script against the current document, the way a browser would. */
function runBoot() {
  new Function(BOOT)();
}

/**
 * jsdom here provides no `localStorage` at all — `typeof window.localStorage` is
 * "undefined" — so the test installs one. Which is the right shape anyway: the
 * storage is the dependency under test, including the case where it throws.
 *
 * That absence is also why both implementations reach for it inside a try/catch
 * rather than checking for it: a browser in private mode throws on access, and
 * reading a property of undefined throws too, so one guard covers both.
 */
let store: Map<string, string>;
let throwOnRead = false;

function installStorage() {
  store = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => {
        if (throwOnRead) throw new Error("private browsing");
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

function setCache(value: string | null) {
  if (value === null) store.delete("sb.theme");
  else store.set("sb.theme", value);
}

const stamped = () => document.documentElement.getAttribute("data-theme");

describe("painting the theme before first paint", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    throwOnRead = false;
    installStorage();
  });

  it("stamps nothing when nobody has overridden their machine", () => {
    setCache(JSON.stringify({ theme: "system" }));
    runBoot();
    // Not "light" and not "dark": leaving the attribute off is what hands the
    // decision to the stylesheet's media query, which is the only way the page
    // follows the machine when the machine changes with the tab already open.
    expect(stamped()).toBeNull();
  });

  it("stamps nothing at all when there is no cache yet", () => {
    runBoot();
    expect(stamped()).toBeNull();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`stamps ${theme} when that is the choice on record`, () => {
      setCache(JSON.stringify({ theme }));
      runBoot();
      expect(stamped()).toBe(theme);
    });
  }

  it("clears a stale stamp rather than leaving it standing", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    setCache(JSON.stringify({ theme: "system" }));
    runBoot();
    expect(stamped()).toBeNull();
  });

  describe("a cache it cannot trust", () => {
    // This runs before anything else on the page, so a half-written or
    // hand-edited entry must not be able to decide what the app looks like, and
    // must not be able to stop it booting.
    for (const [name, value] of [
      ["not JSON at all", "{oh no"],
      ["JSON that is not an object", '"dark"'],
      ["an object with no theme", '{"nothing":"useful"}'],
      ["a theme that is not one of the three", '{"theme":"midnight"}'],
      ["a theme of the wrong type", '{"theme":true}'],
      ["null", "null"],
    ] as const) {
      it(`ignores ${name}`, () => {
        setCache(value);
        expect(() => runBoot()).not.toThrow();
        expect(stamped()).toBeNull();
      });
    }

    it("survives storage that throws on access", () => {
      throwOnRead = true;
      expect(() => runBoot()).not.toThrow();
      expect(stamped()).toBeNull();
    });

    it("survives a browser with no storage at all", () => {
      // Which is not hypothetical: this test environment is one.
      Reflect.deleteProperty(window, "localStorage");
      expect(() => runBoot()).not.toThrow();
      expect(stamped()).toBeNull();
      installStorage();
    });
  });

  describe("the browser chrome", () => {
    const metas = () =>
      [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => ({
        for: meta.getAttribute("data-theme-for"),
        media: meta.getAttribute("media"),
      }));

    beforeEach(() => {
      document.head.innerHTML = `
        <meta name="theme-color" data-theme-for="light" media="(prefers-color-scheme: light)" content="#ffffff" />
        <meta name="theme-color" data-theme-for="dark" media="(prefers-color-scheme: dark)" content="#000000" />
      `;
    });

    it("leaves both scoped to the machine while following it", () => {
      setCache(JSON.stringify({ theme: "system" }));
      runBoot();
      expect(metas()).toEqual([
        { for: "light", media: "(prefers-color-scheme: light)" },
        { for: "dark", media: "(prefers-color-scheme: dark)" },
      ]);
    });

    for (const theme of ["light", "dark"] as const) {
      it(`unscopes the ${theme} one and disables the other on an override`, () => {
        setCache(JSON.stringify({ theme }));
        runBoot();
        // `media` keys off the machine and an override is precisely the case the
        // machine disagrees with, so the winning meta cannot stay scoped or a
        // phone frames a dark page in the light colour.
        expect(metas()).toEqual([
          { for: "light", media: theme === "light" ? null : "not all" },
          { for: "dark", media: theme === "dark" ? null : "not all" },
        ]);
      });
    }
  });

  describe("agreeing with the module that takes over afterwards", () => {
    // The bundle re-applies the theme once it knows the account's setting. If the
    // two disagreed, every load would visibly correct itself.
    for (const theme of ["system", "light", "dark"] as const) {
      it(`reaches the same DOM as applyTheme for ${theme}`, () => {
        document.head.innerHTML = `
          <meta name="theme-color" data-theme-for="light" media="(prefers-color-scheme: light)" content="#ffffff" />
          <meta name="theme-color" data-theme-for="dark" media="(prefers-color-scheme: dark)" content="#000000" />
        `;
        setCache(JSON.stringify({ theme }));
        runBoot();
        const afterBoot = document.documentElement.outerHTML;

        document.documentElement.removeAttribute("data-theme");
        document.head.innerHTML = `
          <meta name="theme-color" data-theme-for="light" media="(prefers-color-scheme: light)" content="#ffffff" />
          <meta name="theme-color" data-theme-for="dark" media="(prefers-color-scheme: dark)" content="#000000" />
        `;
        applyTheme(theme as Theme);
        expect(document.documentElement.outerHTML).toBe(afterBoot);
      });
    }
  });
});
