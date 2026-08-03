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

const dockerfilePath = path.join(root, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");
const updated = dockerfile.replace(
  /^ARG APP_VERSION=.*$/m,
  `ARG APP_VERSION=${version}`,
);
if (updated === dockerfile) {
  console.error("Could not find ARG APP_VERSION in the Dockerfile.");
  process.exit(1);
}
writeFileSync(dockerfilePath, updated);
console.log(`  Dockerfile -> ${version}`);

// The MCP server announces this to every client that connects.
const versionModulePath = path.join(root, "src/shared/version.ts");
const versionModule = readFileSync(versionModulePath, "utf8");
const rewritten = versionModule.replace(
  /^export const APP_VERSION = ".*";$/m,
  `export const APP_VERSION = "${version}";`,
);
if (rewritten === versionModule) {
  console.error("Could not find APP_VERSION in src/shared/version.ts.");
  process.exit(1);
}
writeFileSync(versionModulePath, rewritten);
console.log(`  src/shared/version.ts -> ${version}`);

console.log(`\nNow commit, then tag: git tag v${version}`);
