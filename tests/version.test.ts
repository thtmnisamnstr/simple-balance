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
 * The version is written in several places and `npm run set-version` is what
 * keeps them together. Any one left behind is only noticed later: a stale
 * manifest stops the release workflow, and a stale constant quietly tells every
 * MCP client the wrong thing for as long as nobody looks.
 *
 * The count is deliberately not written down here. It has already been wrong
 * once, when three Dockerfiles were added and the prose still said seven, and a
 * number in a comment is not something anything checks.
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
    expect(manifestVersion("deploy/pulumi/package.json")).toBe(version);
    expect(manifestVersion("deploy/pulumi/package-lock.json")).toBe(version);
    // A lockfile records the version of the root package it locks, too.
    for (const lockfile of [
      "package-lock.json",
      "runtime/package-lock.json",
      "deploy/pulumi/package-lock.json",
    ]) {
      const parsed = JSON.parse(read(lockfile)) as {
        packages: Record<string, { version?: string }>;
      };
      expect(parsed.packages[""]?.version, lockfile).toBe(version);
    }
  });

  it("is what the MCP server announces to its clients", () => {
    expect(APP_VERSION).toBe(version);
  });

  it("is every image's default build argument", () => {
    for (const dockerfile of [
      "Dockerfile",
      "deploy/docker/server.Dockerfile",
      "deploy/docker/frontend.Dockerfile",
      "deploy/docker/scheduler.Dockerfile",
    ]) {
      expect(read(dockerfile), dockerfile).toContain(`ARG APP_VERSION=${version}`);
    }
  });

  // The one version location with a consequence of its own: the chart's values
  // use it as the default image tag, so a release that leaves it behind installs
  // the previous release's images while reporting the new version everywhere
  // else. It was also the one location nothing checked.
  it("is the image tag the chart installs", () => {
    // Both of the chart's version fields. appVersion is the images it installs;
    // `version` is the chart itself, and they move together here because the
    // chart is only ever published on this repository's releases.
    expect(read("deploy/helm/simple-balance/Chart.yaml")).toContain(
      `version: ${version}`,
    );
    expect(read("deploy/helm/simple-balance/Chart.yaml")).toContain(
      `appVersion: "${version}"`,
    );
  });

  /**
   * Examples a reader copies. Pinned rather than `:latest` on purpose — an
   * upgrade moves the schema and should be a decision — which is exactly why a
   * release that leaves them behind hands somebody the previous release's
   * images while the page around them describes this one.
   */
  it("is the tag on every example image", () => {
    const pinned = /ghcr\.io\/thtmnisamnstr\/simple-balance(?:-[a-z]+)?:(\S+)/g;
    for (const relative of [
      "deploy/compose/compose.distributed.yml",
      "deploy/pulumi/README.md",
    ]) {
      const tags = [...read(relative).matchAll(pinned)].map((match) => match[1]);
      expect(tags.length, relative).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, relative).toBe(version);
    }
  });

  it("is the version the product backlog says it describes", () => {
    expect(manifestVersion("tasks/product.prd.json")).toBe(version);
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
      "deploy/docker/server.Dockerfile",
      "deploy/docker/frontend.Dockerfile",
      "deploy/docker/scheduler.Dockerfile",
      "deploy/helm/simple-balance/Chart.yaml",
      "deploy/pulumi/package.json",
      "deploy/pulumi/package-lock.json",
      "deploy/compose/compose.distributed.yml",
      "deploy/pulumi/README.md",
      "src/shared/version.ts",
      "tasks/product.prd.json",
    ]) {
      expect(script, target).toContain(target);
    }
  });
});
