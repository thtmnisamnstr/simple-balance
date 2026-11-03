/**
 * Bring the money guides the MCP server carries in line with what smpl.money
 * publishes, or say how far apart they are.
 *
 *   node scripts/sync-learn.mjs --check                 # compare with smpl.money; exit 0 / 1 / 2
 *   node scripts/sync-learn.mjs --write                 # rewrite the pack from smpl.money
 *   node scripts/sync-learn.mjs --check --from ../simple-balance-web/out
 *   node scripts/sync-learn.mjs --write --from ../simple-balance-web/out   # a preview, and says so
 *   node scripts/sync-learn.mjs --check --json          # for the product-kit skill
 *   node scripts/sync-learn.mjs --published             # may this pack ship? reads nothing else
 *
 * Exits 0 when the pack is what the source publishes, 1 when it has drifted,
 * and 2 when it could not tell — an unreachable site, a site that lists no
 * guides, a copy whose header this does not understand. `--write` writes only
 * when it could read everything, and exits 0 after writing. `--published`
 * exits 0 when the vendored pack was written from the published site and 1
 * when it is a preview from a local build (`previewNote`), which is the
 * question the release workflow asks before it publishes an image.
 *
 * **This file is only the I/O.** Every decision is in `scripts/lib/learn-sync.mjs`,
 * where `tests/learn-sync.test.ts` holds it offline: freshness against the live
 * site needs the network and another repository's deploy, so it is something
 * release-prep runs rather than something CI does. `product-kit` §6 owns it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPack,
  comparePack,
  EXIT_CODES,
  formatReport,
  localProvenance,
  parseLlms,
  previewNote,
  SITE,
  SyncError,
} from "./lib/learn-sync.mjs";

const PACK = fileURLToPath(new URL("../src/server/learn/learn-pack.json", import.meta.url));

const args = process.argv.slice(2);
const write = args.includes("--write");
const asJson = args.includes("--json");
const fromIndex = args.indexOf("--from");
const from = fromIndex === -1 ? SITE : args[fromIndex + 1];

/** A URL is fetched; anything else is a directory holding a site build. */
const remote = /^https?:\/\//.test(from ?? "");

async function read(relative) {
  if (remote) {
    const url = `${from.replace(/\/$/, "")}/${relative}`;
    let response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (error) {
      throw new SyncError(`${url}: ${error.message}`);
    }
    if (!response.ok) throw new SyncError(`${url}: HTTP ${response.status}`);
    return { text: await response.text(), modified: response.headers.get("last-modified") };
  }
  const file = path.join(from, relative);
  try {
    return { text: readFileSync(file, "utf8"), modified: statSync(file).mtime.toISOString() };
  } catch (error) {
    throw new SyncError(`${file}: ${error.code ?? error.message}`);
  }
}

/**
 * Which commit of the site a local build was made from, and whether the files
 * that make a guide's copy had uncommitted changes. `--no-optional-locks`
 * because another session may be working in that checkout, and an ordinary
 * `git status` refreshes the index under a lock it could be holding.
 */
function siteCommit(directory) {
  const git = (...rest) =>
    execFileSync("git", ["--no-optional-locks", "-C", directory, ...rest], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const sha = git("rev-parse", "HEAD");
    const root = git("rev-parse", "--show-toplevel");
    const dirty =
      execFileSync(
        "git",
        [
          "--no-optional-locks",
          "-C",
          root,
          "status",
          "--porcelain",
          "--",
          "content/learn",
          "src/content/learn-art",
          "src/lib/markdown.ts",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() !== "";
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: false };
  }
}

function vendoredPack() {
  try {
    return JSON.parse(readFileSync(PACK, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new SyncError(`the vendored pack does not parse: ${error.message}`);
  }
}

async function main() {
  if (args.includes("--published")) {
    const vendored = vendoredPack();
    if (!vendored) throw new SyncError("there is no vendored pack to check");
    const note = previewNote(vendored);
    console.log(
      asJson
        ? JSON.stringify({ published: note === null, note }, null, 2)
        : (note ?? `Published: the pack came from ${vendored.source.from}.`),
    );
    return note === null ? EXIT_CODES.inSync : EXIT_CODES.drifted;
  }
  if (!from) throw new SyncError("--from needs a URL or a directory");
  const llms = await read("llms.txt");
  const copies = new Map();
  for (const slug of parseLlms(llms.text)) {
    copies.set(slug, (await read(`learn/${slug}/index.md`)).text);
  }
  const builtAt = llms.modified
    ? new Date(llms.modified).toISOString().replace(/\.\d{3}Z$/, "Z")
    : null;
  const fresh = buildPack({
    from: remote ? from.replace(/\/$/, "") : localProvenance({ ...siteCommit(from), builtAt }),
    builtAt,
    llmsText: llms.text,
    copies,
    // The day in UTC. It says when the copy was taken, to the day, and a
    // machine's own zone would make two people syncing at once disagree.
    syncedAt: new Date().toISOString().slice(0, 10),
  });
  const vendored = vendoredPack();
  const result = comparePack(vendored, fresh);
  const report = {
    ...result,
    vendoredFrom: vendored?.source?.from ?? null,
    freshFrom: fresh.source.from,
  };
  if (write) {
    writeFileSync(PACK, `${JSON.stringify(fresh, null, 2)}\n`);
    report.wrote = path.relative(process.cwd(), PACK);
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(result, report));
  if (report.wrote && !asJson) console.log(`Wrote ${report.wrote}.`);
  return write || result.inSync ? EXIT_CODES.inSync : EXIT_CODES.drifted;
}

// Anything that stops the comparison is exit 2, a crash included: node's own
// exit code for an uncaught throw is 1, which is the answer "it drifted", and a
// bug in this file is not evidence that the guides changed.
try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof SyncError)) console.error(error);
  const note = error instanceof SyncError ? error.message : `unexpected failure: ${error.message}`;
  console.log(asJson ? JSON.stringify({ note }, null, 2) : formatReport({ note }, {}));
  process.exitCode = EXIT_CODES.unknown;
}
