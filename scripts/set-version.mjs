#!/usr/bin/env node
/**
 * Set the release version everywhere it is written down.
 *
 * The version appears in the application manifest, the runtime manifest that
 * ships inside the image, both lockfiles, the Dockerfile's default build
 * argument, and the constant the MCP server announces to its clients. `npm run verify` checks that the two manifests agree, and the
 * release workflow refuses to publish when the tag and the manifest disagree,
 * so changing one by hand and missing another fails late and confusingly.
 *
 *   npm run set-version 0.1.0
 *
 * Then commit, and tag with a leading v.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    "Usage: npm run set-version <version>\n" +
      "  e.g. npm run set-version 0.1.0\n" +
      "  Prereleases are allowed: 0.2.0-rc.1",
  );
  process.exit(1);
}

const manifests = [
  "package.json",
  "package-lock.json",
  "runtime/package.json",
  "runtime/package-lock.json",
];

for (const relative of manifests) {
  const file = path.join(root, relative);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  parsed.version = version;
  // A lockfile also records the version of the root package it locks.
  if (parsed.packages?.[""]) parsed.packages[""].version = version;
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`  ${relative} -> ${version}`);
}

/**
 * Rewrite one line, and fail only when the line is not there.
 *
 * Testing whether the file changed instead conflates "no such line" with
 * "already says that", so setting the version to the one already set reported
 * a missing Dockerfile line and stopped before the files after it.
 */
function rewriteLine(relative, pattern, replacement, describe) {
  const file = path.join(root, relative);
  const before = readFileSync(file, "utf8");
  if (!pattern.test(before)) {
    console.error(`Could not find ${describe} in ${relative}.`);
    process.exit(1);
  }
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(file, after);
  console.log(`  ${relative} -> ${version}`);
}

// Every image that stamps a version label, not just the one at the root. The
// decomposed images are built by hand rather than by CI, so nothing else would
// catch one left a release behind, and tests/dockerfile.test.ts fails the whole
// suite when they disagree with package.json.
for (const dockerfile of [
  "Dockerfile",
  "deploy/docker/server.Dockerfile",
  "deploy/docker/frontend.Dockerfile",
  "deploy/docker/scheduler.Dockerfile",
]) {
  rewriteLine(
    dockerfile,
    /^ARG APP_VERSION=.*$/m,
    `ARG APP_VERSION=${version}`,
    "ARG APP_VERSION",
  );
}

// The MCP server announces this to every client that connects.
rewriteLine(
  "src/shared/version.ts",
  /^export const APP_VERSION = ".*";$/m,
  `export const APP_VERSION = "${version}";`,
  "APP_VERSION",
);

// The Ralph backlog names the version it describes. Left behind it drifts, and
// the file is the one place a reader looks for what the product is at.
const prdPath = path.join(root, "tasks/product.prd.json");
const prd = JSON.parse(readFileSync(prdPath, "utf8"));
prd.version = version;
writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`);
console.log(`  tasks/product.prd.json -> ${version}`);

console.log(`\nNow commit, then tag: git tag v${version}`);
