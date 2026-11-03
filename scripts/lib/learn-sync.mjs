/**
 * The decisions behind `scripts/sync-learn.mjs`, kept apart from its I/O so
 * `tests/learn-sync.test.ts` can hold every one of them offline.
 *
 * **What is being synced.** The marketing site publishes each of its money
 * guides twice: as a page at `/learn/<slug>/`, and as a plain-Markdown copy at
 * `/learn/<slug>/index.md` with its pictures, diagrams and callouts already
 * turned into text and its links made absolute. `/llms.txt` lists those copies
 * in the site's reading order. The MCP server carries the copies, byte for
 * byte, in `src/server/learn/learn-pack.json`, so an agent can read a guide on
 * a deployment that cannot reach the internet.
 *
 * **Why the copies and not the site's source.** The site owns the one function
 * that flattens its components (`src/lib/markdown.ts` there), and the words of
 * every diagram live in TypeScript only the site can evaluate. Flattening again
 * here would be a second copy of that function, which drifts. And a byte-for-
 * byte copy can be compared by hash, so "is the pack current" is an equality
 * rather than a judgment.
 *
 * **Three answers, never two.** The same split the site's own
 * `scripts/check-app-sync.mjs` makes: 0 is "the pack is what the site
 * publishes", 1 is "it has drifted, and here is how", and 2 is "I could not
 * tell". The third is deliberately its own exit, because "the guides have not
 * changed" and "I could not reach the guides" must never look alike — a site
 * that stopped listing them, or a copy whose header changed shape, is a reason
 * to stop and look rather than a drift to write over the pack.
 */
import { createHash } from "node:crypto";

/** The format of the pack, so a reader can refuse one it does not know. */
export const PACK_FORMAT = "simple-balance-learn-pack-1";

/** Where the guides are published, and what every copy's links point at. */
export const SITE = "https://smpl.money";

/** The heading every guide's product section carries, held by the site's own tests. */
const PRODUCT_HEADING = "## How to do it in Simple Balance";

/**
 * The site's license, carried in the pack because the words are the site's.
 * MIT text inside an AGPL-3.0 program is compatible, and the notice is what MIT
 * asks for in return.
 */
const SITE_LICENSE = "MIT License, Copyright (c) 2026 Gavin Johnson (simple-balance-web)";

export const EXIT_CODES = Object.freeze({ inSync: 0, drifted: 1, unknown: 2 });

/**
 * A reason the comparison could not be made at all, which is exit 2.
 *
 * A class rather than a flag on the result, so every parser can refuse from
 * wherever it is without each caller remembering to check a field.
 */
export class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncError";
  }
}

/** The SHA-256 of a copy's exact bytes, which is the whole freshness test. */
export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The guides `/llms.txt` lists, in the order it lists them.
 *
 * Matched on the shape of the copy's URL rather than on the heading above the
 * list, so the site can rename its "Money basics" section without this
 * noticing. Docs pages are listed in the same file and are not guides; their
 * URLs do not match. A guide listed twice is listed once, at its first place.
 *
 * Zero guides is exit 2 rather than "everything was removed": it is what a
 * changed format, an unannounced section and a site that has not deployed the
 * guides yet all look like, and none of them is a reason to empty the pack.
 */
export function parseLlms(text, site = SITE) {
  const escaped = site.replaceAll(".", "\\.");
  const pattern = new RegExp(`\\]\\(${escaped}/learn/([a-z0-9-]+)/index\\.md\\)`, "g");
  const slugs = [];
  for (const match of text.matchAll(pattern)) {
    if (!slugs.includes(match[1])) slugs.push(match[1]);
  }
  if (slugs.length === 0) {
    throw new SyncError(
      `llms.txt lists no guide copies under ${site}/learn/ — the format changed, or the guides are not published there yet`,
    );
  }
  return slugs;
}

/**
 * The four facts a copy's header states, read rather than inferred.
 *
 * The site writes `# title`, a blank line, `> description`, a blank line, then
 * `From Simple Balance: <url>. Updated <date>.` (`entryMarkdown` there). The
 * URL has to be the guide's own page, so a copy served at the wrong address is
 * caught here rather than shipped under another guide's slug. Every guide is
 * dated, so a header with no date is a header this does not understand.
 */
export function parseCopy(text, slug, site = SITE) {
  const lines = text.split("\n");
  const title = /^# (.+)$/.exec(lines[0] ?? "")?.[1];
  const description = /^> (.+)$/.exec(lines[2] ?? "")?.[1];
  const from = /^From [^:]+: (\S+)\. Updated (\d{4}-\d{2}-\d{2})\.$/.exec(lines[4] ?? "");
  if (!title || !description || !from || lines[1] !== "" || lines[3] !== "") {
    throw new SyncError(`${slug}: the copy's header is not the shape this reads`);
  }
  const url = `${site}/learn/${slug}/`;
  if (from[1] !== url) {
    throw new SyncError(`${slug}: the copy says it is ${from[1]}, not ${url}`);
  }
  return { title, description, url, updated: from[2] };
}

/** Straight quotes for curly ones, because the site curls some of its text. */
export function foldQuotes(text) {
  return text.replaceAll(/[‘’]/g, "'").replaceAll(/[“”]/g, '"');
}

/**
 * The `###` steps under a guide's "How to do it in Simple Balance", in order.
 *
 * These are what `src/server/learn/in-simple-balance.ts` maps to tools, so a
 * step the site renames, adds or drops is the one change to a guide that needs
 * an edit on this side too. Fenced blocks are skipped, so a `###` inside one is
 * not read as a step. An empty list is a guide with no product section, which
 * `tests/learn-pack.test.ts` refuses.
 */
export function productHeadings(text) {
  const headings = [];
  let inside = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (line.startsWith("## ")) inside = line === PRODUCT_HEADING;
    else if (inside && line.startsWith("### ")) headings.push(line.slice(4).trim());
  }
  return headings;
}

/**
 * Where a local build came from, in the words the pack records.
 *
 * A pack synced from a build on somebody's machine is a preview: its guides
 * may not be published, and its links may not resolve yet. Saying so in the
 * pack is what lets release-prep's report tell a preview from a release.
 */
export function localProvenance({ sha, dirty, builtAt }) {
  const notes = ["local build"];
  if (builtAt) notes.push(`built ${builtAt}`);
  if (dirty) notes.push("uncommitted changes");
  return `simple-balance-web@${sha ? sha.slice(0, 12) : "unknown"} (${notes.join(", ")})`;
}

/**
 * The pack, built from what was read.
 *
 * `lines` rather than one string per guide, so `git diff` shows the sentence a
 * sync changed rather than a hundred-kilobyte line. Splitting on `\n` and
 * joining on it again is exact — a trailing newline is a trailing empty line —
 * and `sha256` is over the joined bytes, so a hand edit to the pack fails its
 * own hash.
 */
export function buildPack({ site = SITE, from, builtAt = null, llmsText, copies, syncedAt }) {
  const slugs = parseLlms(llmsText, site);
  const articles = slugs.map((slug) => {
    const text = copies.get(slug);
    if (typeof text !== "string") throw new SyncError(`${slug}: no copy was read`);
    return {
      slug,
      ...parseCopy(text, slug, site),
      sha256: sha256(text),
      steps: productHeadings(text),
      lines: text.split("\n"),
    };
  });
  return {
    format: PACK_FORMAT,
    source: {
      site,
      from,
      builtAt,
      llmsSha256: sha256(llmsText),
      syncedAt,
      license: SITE_LICENSE,
    },
    articles,
  };
}

/** The article's fields a sync can change, compared as one string. */
const identity = (article) =>
  JSON.stringify([article.title, article.description, article.url, article.updated]);

/**
 * How the vendored pack differs from a freshly built one.
 *
 * In sync means the same guides, in the same order, with the same bytes and the
 * same header facts — and, when the fresh pack came from the published site, a
 * vendored pack that came from the published site too. A pack synced from a
 * local build matches the site byte for byte once the site deploys it, and is
 * still a preview until somebody restamps it from the site: its `from` says
 * "local build", and release-prep's report reads that field.
 *
 * `steps` is reported per changed guide because a renamed, added or removed
 * step is the one change to a guide that needs `in-simple-balance.ts` edited in
 * the same commit; a reworded paragraph needs nothing on this side.
 */
export function comparePack(vendored, fresh) {
  const before = new Map((vendored?.articles ?? []).map((article) => [article.slug, article]));
  const after = new Map(fresh.articles.map((article) => [article.slug, article]));
  const added = [...after.keys()].filter((slug) => !before.has(slug));
  const removed = [...before.keys()].filter((slug) => !after.has(slug));
  const changed = [];
  for (const [slug, article] of after) {
    const old = before.get(slug);
    if (!old) continue;
    // The vendored article is held to its own lines rather than trusted: its
    // stored hash and steps are what a hand edit leaves behind, so comparing
    // only those reported an edited pack as in sync. The CI test refuses the
    // same edit, but release-prep's line comes from here.
    const oldText = (old.lines ?? []).join("\n");
    const same =
      old.sha256 === article.sha256 &&
      sha256(oldText) === article.sha256 &&
      JSON.stringify(old.steps ?? []) === JSON.stringify(productHeadings(oldText)) &&
      identity(old) === identity(article);
    if (same) continue;
    const stepsBefore = old.steps ?? [];
    const stepsChanged =
      JSON.stringify(stepsBefore.map(foldQuotes)) !== JSON.stringify(article.steps.map(foldQuotes));
    changed.push({ slug, stepsChanged, stepsBefore, stepsAfter: article.steps });
  }
  const common = (order) => order.filter((slug) => before.has(slug) && after.has(slug));
  const reordered = common([...before.keys()]).join() !== common([...after.keys()]).join();
  const restamp =
    fresh.source.from === fresh.source.site && vendored?.source?.from !== fresh.source.site;
  const inSync =
    vendored?.format === PACK_FORMAT &&
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    !reordered &&
    !restamp;
  return { inSync, added, removed, changed, reordered, restamp };
}

/**
 * Why a pack may not ship in a release, or null when it may.
 *
 * A release's pack comes from the published site. One written from a local
 * build is a preview: the tools still say the guides are published at the
 * site and hand out their addresses, and until the site deploys them every one
 * of those addresses is a 404. The release workflow runs this before it
 * publishes an image, because nothing else stood between a preview pack and a
 * cut. It reads only the vendored pack, so it needs no network and answers
 * the same on a runner as on a laptop.
 */
export function previewNote(pack) {
  const site = pack?.source?.site ?? SITE;
  const from = pack?.source?.from;
  if (from === site) return null;
  return `The learn pack came from ${from ?? "nowhere this can name"}, not from ${site}, so its guides may not be published and their addresses may lead nowhere. Once ${site}/llms.txt lists them, run node scripts/sync-learn.mjs --write and commit the pack.`;
}

/** The comparison as a person reads it; `--json` prints the object instead. */
export function formatReport(result, { vendoredFrom, freshFrom }) {
  if (result.note) return `Could not tell: ${result.note}`;
  const lines = [`Pack: ${vendoredFrom ?? "none"}`, `Source: ${freshFrom}`];
  if (result.inSync)
    return [...lines, "In sync: the pack is what the source publishes."].join("\n");
  for (const slug of result.added) {
    lines.push(
      `Added: ${slug} — map its steps in in-simple-balance.ts, and decide whether list_learn_articles' description should name its topic`,
    );
  }
  for (const slug of result.removed)
    lines.push(`Removed: ${slug} — drop it from in-simple-balance.ts`);
  for (const change of result.changed) {
    lines.push(
      change.stepsChanged
        ? `Changed: ${change.slug} — its steps changed, so in-simple-balance.ts needs the same edit:\n    before: ${change.stepsBefore.join(" | ")}\n    after:  ${change.stepsAfter.join(" | ")}`
        : `Changed: ${change.slug} — wording only; nothing to map`,
    );
  }
  if (result.reordered) lines.push("Reordered: the site changed its reading order");
  if (result.restamp) {
    lines.push("Restamp: the pack came from a local build; write it again from the published site");
  }
  return lines.join("\n");
}
