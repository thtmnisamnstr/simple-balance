import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/shared/version.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) =>
  readFileSync(path.join(root, relative), "utf8");
const manifestVersion = (relative: string) =>
  (JSON.parse(read(relative)) as { version: string }).version;

/**
 * The version is written in six places, and `npm run set-version` is what keeps
 * them together. Any one of them left behind is only noticed later: a stale
 * manifest stops the release workflow, and a stale constant quietly tells every
 * MCP client the wrong thing for as long as nobody looks.
 */
describe("the release version", () => {
  const version = manifestVersion("package.json");

  it("is a version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("is the same in every manifest and lockfile", () => {
    expect(manifestVersion("runtime/package.json")).toBe(version);
    expect(manifestVersion("package-lock.json")).toBe(version);
    expect(manifestVersion("runtime/package-lock.json")).toBe(version);
    // A lockfile records the version of the root package it locks, too.
    for (const lockfile of ["package-lock.json", "runtime/package-lock.json"]) {
      const parsed = JSON.parse(read(lockfile)) as {
        packages: Record<string, { version?: string }>;
      };
      expect(parsed.packages[""]?.version, lockfile).toBe(version);
    }
  });

  it("is what the MCP server announces to its clients", () => {
    expect(APP_VERSION).toBe(version);
  });

  it("is the image's default build argument", () => {
    expect(read("Dockerfile")).toContain(`ARG APP_VERSION=${version}`);
  });

  // Everything above is only kept true by one script, so it has to know about
  // every one of them.
  it("is covered by set-version", () => {
    const script = read("scripts/set-version.mjs");
    for (const target of [
      "package.json",
      "package-lock.json",
      "runtime/package.json",
      "runtime/package-lock.json",
      "Dockerfile",
      "src/shared/version.ts",
    ]) {
      expect(script, target).toContain(target);
    }
  });
});
