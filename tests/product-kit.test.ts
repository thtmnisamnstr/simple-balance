import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `docs/product/`, the kit the marketing site consumes.
 *
 * Three files with one job between them: `facts.json` says what the product
 * charges and permits, `features.json` says what it does and how much a
 * stranger would care, and `screenshots.json` lists the pictures. The site at
 * smpl.money reads all three and cannot run this application, so a defect
 * here is invisible from over there until it reaches a reader.
 *
 * `features.json` is **declared** — how much somebody would care is a
 * judgement, not a property of a module — so what a test can hold is its
 * shape, its internal agreement, and that it points at pictures that exist.
 */
const dir = join(process.cwd(), "docs/product");
const appVersion = (
  JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  }
).version;

const features = JSON.parse(readFileSync(join(dir, "features.json"), "utf8")) as {
  appVersion: string;
  tiers: Record<string, string>;
  features: {
    id: string;
    tier: string;
    rank: number;
    name: string;
    plain: string;
    why: string;
    screen: string;
    screenshot: string;
  }[];
};

describe("the feature list", () => {
  it("has features to check", () => {
    expect(features.features.length).toBeGreaterThan(10);
  });

  it("says which release it describes", () => {
    // The marketing site records this, so "which version is the site
    // advertising" has an answer rather than being inferred from a date.
    expect(features.appVersion).toBe(appVersion);
  });

  it("uses only the three tiers it defines", () => {
    expect(Object.keys(features.tiers).sort()).toEqual(["A", "B", "C"]);
    for (const feature of features.features) {
      expect(Object.keys(features.tiers), `${feature.id} is tier ${feature.tier}`).toContain(
        feature.tier,
      );
    }
  });

  it("ranks each tier from 1 with no gaps and no ties", () => {
    // The rank is the order the marketing site presents them in. A gap or a
    // tie makes that order arbitrary, which defeats the point of ranking.
    for (const tier of Object.keys(features.tiers)) {
      const ranks = features.features
        .filter((feature) => feature.tier === tier)
        .map((feature) => feature.rank)
        .sort((a, b) => a - b);
      expect(ranks, `tier ${tier}`).toEqual(ranks.map((_, index) => index + 1));
    }
  });

  it("gives every feature a unique id", () => {
    const ids = features.features.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("writes `plain` as something a person would actually read", () => {
    // The field exists so the marketing site has a starting point written for
    // a general reader rather than for whoever wrote the code. A one-line
    // fragment is not that.
    for (const feature of features.features) {
      expect(feature.plain.length, `${feature.id} is too short`).toBeGreaterThan(50);
      expect(feature.plain, `${feature.id} does not end as a sentence`).toMatch(/[.!?]$/);
    }
  });

  it("says why each one matters, not only what it is", () => {
    // `why` is the half a marketing page cannot invent honestly, because it
    // is a claim about the product's users.
    for (const feature of features.features) {
      expect(feature.why.length, `${feature.id} has no reason`).toBeGreaterThan(30);
    }
  });

  it("names a screen that exists in the application", () => {
    const routes = readFileSync(join(process.cwd(), "src/client/App.tsx"), "utf8");
    for (const feature of features.features) {
      expect(routes, `${feature.id} points at ${feature.screen}`).toContain(`"${feature.screen}"`);
    }
  });

  it("keeps tier A small enough to be a summary", () => {
    // "If a stranger reads three things" — a tier A of ten is not a tier.
    const a = features.features.filter((feature) => feature.tier === "A");
    expect(a.length).toBeLessThanOrEqual(5);
  });
});

describe("the screenshots", () => {
  const manifestPath = join(dir, "screenshots.json");

  it("has a manifest, or the kit has never been built", () => {
    expect(
      existsSync(manifestPath),
      "run `node scripts/product-kit/build.mjs` — see the product-kit skill",
    ).toBe(true);
  });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    appVersion: string;
    screens: string[];
    shots: { file: string; route: string; theme: string }[];
  };

  it("records the release it photographed", () => {
    // A screenshot set older than the application it advertises is the
    // failure that looks most like success.
    expect(manifest.appVersion).toBe(appVersion);
  });

  it("captured every screen in both themes", () => {
    expect(manifest.screens.length).toBeGreaterThan(10);
    for (const screen of manifest.screens) {
      for (const theme of ["light", "dark"]) {
        expect(manifest.shots.map((shot) => shot.file)).toContain(`${screen}-${theme}.webp`);
      }
    }
  });

  it("has every file the manifest lists", () => {
    const missing = manifest.shots
      .map((shot) => shot.file)
      .filter((file) => !existsSync(join(dir, "screenshots", file)));
    expect(missing).toEqual([]);
  });

  it("points every feature at a screenshot that was taken", () => {
    // The one failure the marketing site cannot detect from its side: it
    // would fetch a filename that does not exist and render a broken image.
    const named = [...new Set(features.features.map((feature) => feature.screenshot))];
    const missing = named.filter((name) => !manifest.screens.includes(name));
    expect(missing).toEqual([]);
  });

  it("keeps each shot small enough to ship", () => {
    // These are committed and fetched over the network by another
    // repository. A 2x PNG would be 400 KB each and thirty of them.
    const heavy = manifest.shots
      .map((shot) => ({
        file: shot.file,
        kb: statSync(join(dir, "screenshots", shot.file)).size / 1024,
      }))
      .filter((shot) => shot.kb > 150)
      .map((shot) => `${shot.file} is ${Math.round(shot.kb)} KB`);
    expect(heavy).toEqual([]);
  });
});
