// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The browser entry never asks whether it may `eval`.
 *
 * Zod probes with `new Function("")` the first time an object schema is built,
 * and the app's policy has no `'unsafe-eval'`, so the probe was reported as a
 * violation on every page load. `src/client/zod-jitless.ts` turns it off, and
 * only works because `main.tsx` imports it before anything that builds a
 * schema — a `z.config` call in the entry's body was built and still raised
 * the violation, because imports are evaluated first.
 *
 * The browser tier cannot hold this: its dev server applies no policy, so a
 * probe there is caught and forgotten. What can be watched is the constructor
 * the probe calls. This file runs in a process of its own, so the Zod it loads
 * is fresh and nothing has probed before the entry does.
 */
describe("the client entry and Zod's eval probe", () => {
  it("imports the setting before anything else", () => {
    const entry = readFileSync("src/client/main.tsx", "utf8");
    const imports = [...entry.matchAll(/^import\s+(?:[^"';]*?\sfrom\s+)?"([^"]+)";/gm)].map(
      (match) => match[1],
    );
    expect(imports.length, "the pattern found the entry's imports").toBeGreaterThan(3);
    expect(imports[0]).toBe("./zod-jitless.js");
  });

  it("loads the whole app, every shared schema included, without constructing the probe", async () => {
    // Every `new Function(...)` from here on. The probe is the one with a
    // single empty body; anything else is recorded too, so the watcher is
    // shown to see a construction before its silence is believed.
    const constructed: unknown[][] = [];
    const RealFunction = globalThis.Function;
    vi.stubGlobal(
      "Function",
      new Proxy(RealFunction, {
        construct(target, args, newTarget) {
          constructed.push(args);
          return Reflect.construct(target, args, newTarget) as object;
        },
      }),
    );
    // The app asks for its session first; left pending, it renders the
    // loading state and nothing else.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    document.body.innerHTML = '<div id="root"></div>';

    await import("../src/client/main.js");

    // Present: the entry loaded the shared schemas, and they parse. Which is
    // the half of `jitless` worth asserting — it settles which parser Zod
    // builds, and the interpreted one answers what the compiled one would.
    const { activeAccountsSchema } = await import("../src/shared/domain.js");
    expect(activeAccountsSchema.parse({ accountIds: [] })).toEqual({ accountIds: [] });
    const { z } = await import("zod");
    expect(z.config().jitless).toBe(true);
    // And the watcher sees a construction made the way Zod makes its own,
    // through an alias of the global name.
    const F = Function;
    new F("return 1");
    expect(constructed).toContainEqual(["return 1"]);

    // Absent: the probe.
    expect(constructed, "Zod probed for eval while the entry loaded").not.toContainEqual([""]);
  });
});
