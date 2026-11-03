import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPack,
  comparePack,
  EXIT_CODES,
  foldQuotes,
  formatReport,
  localProvenance,
  parseCopy,
  parseLlms,
  previewNote,
  productHeadings,
  sha256,
  SyncError,
  type Pack,
} from "../scripts/lib/learn-sync.mjs";

/**
 * The decisions `scripts/sync-learn.mjs` makes, held offline.
 *
 * Freshness against smpl.money needs the network and another repository's
 * deploy, so it is release-prep's job rather than CI's — the same split the
 * site makes with its own `check-app-sync.mjs`. What CI can hold is that the
 * sync reads what the site writes, refuses what it does not understand as
 * "could not tell" rather than as a drift, and reports the one change that
 * needs an edit on this side: a guide whose Simple Balance steps moved.
 */
const LLMS = [
  "# Simple Balance",
  "",
  "## Docs",
  "",
  "- [Accounts](https://smpl.money/docs/accounts/index.md): Add accounts.",
  "",
  "## Money basics",
  "",
  "- [How to track your spending](https://smpl.money/learn/track-your-spending/index.md): Find out.",
  "- [What is net worth?](https://smpl.money/learn/net-worth/index.md): Own minus owe.",
  "",
].join("\n");

const copy = (slug: string, title: string, steps: string[], body = "Some words.") =>
  [
    `# ${title}`,
    "",
    `> A summary of ${slug}.`,
    "",
    `From Simple Balance: https://smpl.money/learn/${slug}/. Updated 2026-10-24.`,
    "",
    "",
    body,
    "",
    "## Why it matters",
    "",
    "Because.",
    "",
    "## How to do it in Simple Balance",
    "",
    ...steps.flatMap((step) => [`### ${step}`, "", "Press a button.", ""]),
    "## Sources",
    "",
    "- A source.",
    "",
  ].join("\n");

const copies = (overrides: Record<string, string> = {}) =>
  new Map([
    ["track-your-spending", copy("track-your-spending", "Track", ["Set up your accounts"])],
    ["net-worth", copy("net-worth", "Net worth", ["Add every account", "Read the report"])],
    ...Object.entries(overrides),
  ]);

const build = (overrides: Record<string, string> = {}, from = "https://smpl.money"): Pack =>
  buildPack({ from, llmsText: LLMS, copies: copies(overrides), syncedAt: "2026-10-25" });

describe("reading what the site publishes", () => {
  it("takes the guides from llms.txt in its order, and leaves the docs alone", () => {
    expect(parseLlms(LLMS)).toEqual(["track-your-spending", "net-worth"]);
  });

  it("calls a list with no guides in it a reason to stop, not an empty pack", () => {
    // Zero is what a changed format, an unannounced section and a site that
    // has not deployed the guides yet all look like. Exit 1 would invite a
    // --write that empties the pack.
    expect(() => parseLlms("# Simple Balance\n\n## Docs\n")).toThrow(SyncError);
  });

  it("reads the four facts a copy's header states", () => {
    expect(parseCopy(copy("net-worth", "Net worth", []), "net-worth")).toEqual({
      title: "Net worth",
      description: "A summary of net-worth.",
      url: "https://smpl.money/learn/net-worth/",
      updated: "2026-10-24",
    });
  });

  it("refuses a header it does not understand, or one that names another page", () => {
    expect(() => parseCopy("# Title\n\nNo summary here\n", "x")).toThrow(SyncError);
    expect(() => parseCopy(copy("net-worth", "Net worth", []), "emergency-fund")).toThrow(
      /not https:\/\/smpl\.money\/learn\/emergency-fund\//,
    );
    // Undated: every guide has a date, so one without is a shape this does
    // not know rather than a guide to vendor with a blank.
    const undated = copy("net-worth", "Net worth", []).replace(". Updated 2026-10-24.", "");
    expect(() => parseCopy(undated, "net-worth")).toThrow(SyncError);
  });

  it("finds the Simple Balance steps and only those", () => {
    const text = [
      "## How to do it",
      "### 1. Not a product step",
      "## How to do it in Simple Balance",
      "### Set the goal",
      "```",
      "### inside a fence",
      "```",
      "### Pay the bill",
      "## Sources",
      "### Not one either",
    ].join("\n");
    expect(productHeadings(text)).toEqual(["Set the goal", "Pay the bill"]);
  });

  it("folds curly quotes, because the site curls some of its text", () => {
    expect(foldQuotes("What’s left “to” assign")).toBe(`What's left "to" assign`);
  });
});

describe("the pack", () => {
  it("keeps every copy's exact bytes, and hashes them", () => {
    const pack = build();
    const article = pack.articles[1]!;
    const text = copies().get("net-worth")!;
    expect(article.lines.join("\n")).toBe(text);
    expect(article.sha256).toBe(sha256(text));
    expect(article.steps).toEqual(["Add every account", "Read the report"]);
    expect(pack.source).toMatchObject({
      site: "https://smpl.money",
      from: "https://smpl.money",
      syncedAt: "2026-10-25",
      llmsSha256: sha256(LLMS),
    });
    expect(pack.source.license).toMatch(/^MIT License/);
  });

  it("refuses to build without a copy of every listed guide", () => {
    expect(() =>
      buildPack({
        from: "https://smpl.money",
        llmsText: LLMS,
        copies: new Map([["net-worth", copy("net-worth", "N", [])]]),
        syncedAt: "2026-10-25",
      }),
    ).toThrow(/track-your-spending: no copy was read/);
  });

  it("says where a local build came from, and that it is a preview", () => {
    expect(
      localProvenance({ sha: "5aacc68628cc609fc238a061", dirty: true, builtAt: "2026-10-26" }),
    ).toBe("simple-balance-web@5aacc68628cc (local build, built 2026-10-26, uncommitted changes)");
    expect(localProvenance({ sha: null, dirty: false })).toBe(
      "simple-balance-web@unknown (local build)",
    );
  });
});

describe("comparing the vendored pack with the source", () => {
  it("is in sync when the guides are byte for byte the same", () => {
    const result = comparePack(build(), build());
    expect(result).toMatchObject({ inSync: true, added: [], removed: [], changed: [] });
  });

  /**
   * The vendored pack is held to its own lines, not to the hash and steps it
   * stores beside them, because those are exactly what a hand edit leaves
   * behind. Trusting them reported an edited pack as in sync, and the
   * readiness report's line comes from this comparison.
   */
  it("calls a hand-edited pack drift, whichever half of it was edited", () => {
    const edited = build();
    const guide = edited.articles.find((article) => article.slug === "net-worth")!;
    guide.lines = guide.lines.map((line) => (line === "Because." ? "Because, edited." : line));
    expect(comparePack(edited, build())).toMatchObject({
      inSync: false,
      changed: [expect.objectContaining({ slug: "net-worth", stepsChanged: false })],
    });

    const restepped = build();
    restepped.articles.find((article) => article.slug === "net-worth")!.steps = ["Read it"];
    expect(comparePack(restepped, build())).toMatchObject({
      inSync: false,
      changed: [expect.objectContaining({ slug: "net-worth", stepsChanged: true })],
    });
  });

  it("reports a guide added, removed, or reworded", () => {
    const before = build();
    const after = buildPack({
      from: "https://smpl.money",
      llmsText: LLMS.replace("track-your-spending/index.md", "emergency-fund/index.md"),
      copies: new Map([
        ["emergency-fund", copy("emergency-fund", "Emergency", ["Give it an account"])],
        [
          "net-worth",
          copy("net-worth", "Net worth", ["Add every account", "Read the report"], "New."),
        ],
      ]),
      syncedAt: "2026-10-26",
    });
    const result = comparePack(before, after);
    expect(result.inSync).toBe(false);
    expect(result.added).toEqual(["emergency-fund"]);
    expect(result.removed).toEqual(["track-your-spending"]);
    // Reworded, with its steps intact: nothing to map.
    expect(result.changed).toEqual([
      expect.objectContaining({ slug: "net-worth", stepsChanged: false }),
    ]);
  });

  it("says when a guide's steps changed, which is the edit this repository owes", () => {
    const after = build({
      "net-worth": copy("net-worth", "Net worth", [
        "Add every account",
        "Read the net worth report",
      ]),
    });
    const result = comparePack(build(), after);
    expect(result.changed).toEqual([
      {
        slug: "net-worth",
        stepsChanged: true,
        stepsBefore: ["Add every account", "Read the report"],
        stepsAfter: ["Add every account", "Read the net worth report"],
      },
    ]);
    expect(formatReport(result, { vendoredFrom: "a", freshFrom: "b" })).toContain(
      "in-simple-balance.ts needs the same edit",
    );
  });

  it("counts the reading order as part of what the site publishes", () => {
    const reordered = buildPack({
      from: "https://smpl.money",
      llmsText: LLMS.split("\n").reverse().join("\n"),
      copies: copies(),
      syncedAt: "2026-10-25",
    });
    expect(comparePack(build(), reordered)).toMatchObject({ inSync: false, reordered: true });
  });

  it("asks for a preview pack to be restamped once the site publishes the same bytes", () => {
    // Identical guides, but the vendored pack came from somebody's machine. A
    // release reads `source.from`, so it is not done until that says the site.
    const preview = build({}, "simple-balance-web@abc (local build)");
    const result = comparePack(preview, build());
    expect(result).toMatchObject({ inSync: false, restamp: true, changed: [] });
    // And not the other way: checking a preview against another local build
    // is a question about bytes alone.
    expect(comparePack(preview, build({}, "simple-balance-web@def (local build)")).inSync).toBe(
      true,
    );
  });

  it("treats no pack at all as every guide added", () => {
    expect(comparePack(null, build())).toMatchObject({
      inSync: false,
      added: ["track-your-spending", "net-worth"],
    });
  });

  /**
   * A release's pack comes from the published site. A preview says where it
   * came from in `source.from`, and its tools still hand out the site's
   * addresses for every guide, so it is the one pack a release refuses — in
   * a job the publish job needs, so before an image is built, because no other
   * step stood between a preview and a cut. Checked against the workflow's text, which is
   * what `tests/workflows.test.ts` reads too.
   */
  it("lets a release ship only a pack written from the published site", () => {
    expect(previewNote(build())).toBeNull();
    const preview = previewNote(build({}, "simple-balance-web@abc (local build)"));
    expect(preview).toContain("simple-balance-web@abc (local build)");
    expect(preview).toContain("node scripts/sync-learn.mjs --write");
    expect(previewNote(null)).not.toBeNull();

    const release = readFileSync(".github/workflows/release.yml", "utf8");
    const job = (name: string) => {
      const start = release.indexOf(`\n  ${name}:\n`);
      const next = release.slice(start + 1).search(/\n {2}[\w-]+:\n/);
      return start === -1 ? "" : release.slice(start, next === -1 ? undefined : start + 1 + next);
    };
    expect(job("learn-pack"), "a job checks the pack").toContain(
      "run: node scripts/sync-learn.mjs --published",
    );
    expect(job("publish"), "and no image is built until it has").toMatch(
      /needs: \[[^\]]*\blearn-pack\b[^\]]*\]/,
    );
  });

  it("keeps the three exits apart", () => {
    expect(EXIT_CODES).toEqual({ inSync: 0, drifted: 1, unknown: 2 });
    expect(formatReport({ note: "https://smpl.money/llms.txt: HTTP 404" }, {})).toBe(
      "Could not tell: https://smpl.money/llms.txt: HTTP 404",
    );
  });
});
