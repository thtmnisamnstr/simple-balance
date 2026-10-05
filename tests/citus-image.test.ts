import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The chart's database image against the workflow that publishes it.
 *
 * These two files are the only halves of one fact — what the Citus image is
 * called and which tag exists — and nothing joined them, so they disagreed all
 * the way to a real cluster. `values.yaml` named
 * `thtmnisamnstr/simple-balance-citus:14.2.0-pg18`; the workflow published
 * `<owner>/<repo>-citus`; and because the workflow's `push` trigger carried a
 * paths filter on the Dockerfile, no run had ever built it at all. Installing
 * the chart with `database.enabled=true` met ImagePullBackOff, which is
 * indistinguishable from a slow pull until you look.
 *
 * None of that is visible to `helm lint`, to `helm template`, or to any test
 * that reads one file. It is visible here.
 */
const WORKFLOW = readFileSync(".github/workflows/citus-image.yml", "utf8");
const VALUES = readFileSync("deploy/helm/simple-balance/values.yaml", "utf8");
const DOCKERFILE = readFileSync("deploy/docker/citus.Dockerfile", "utf8");

/** `database:` block of values.yaml, which is where the image lives. */
const databaseBlock = (): string => {
  const start = VALUES.indexOf("\ndatabase:\n");
  expect(start, "values.yaml has no top-level database block").toBeGreaterThan(-1);
  const rest = VALUES.slice(start + 1);
  const end = rest.search(/\n[a-zA-Z]/);
  return end === -1 ? rest : rest.slice(0, end);
};

describe("the Citus image the chart asks for", () => {
  const block = databaseBlock();

  it("is named plainly, not after this product", () => {
    const repository = /^\s*repository:\s*(\S+)\s*$/m.exec(block)?.[1];
    expect(repository, "database.image.repository is missing").toBeDefined();
    // It is a PostgreSQL image with Citus in it, carrying Citus's version. A
    // name with the product in it implies it moves with the product's
    // releases, and it does not.
    expect(repository).toMatch(/\/citus$/);
    expect(repository).not.toContain("simple-balance-citus");
  });

  it("is the name the workflow actually publishes", () => {
    // The workflow builds the image reference from the repository OWNER plus a
    // literal, so the chart's must be <owner>/citus. Matching the two by hand
    // is what drifted.
    const owner = /^\s*repository:\s*([^/\s]+)\//m.exec(block)?.[1];
    expect(owner, "database.image.repository has no owner segment").toBeDefined();
    expect(
      WORKFLOW,
      "the workflow no longer derives its image from the repository owner plus /citus",
    ).toMatch(/image=ghcr\.io\/\$\(echo "\$\{GITHUB_REPOSITORY_OWNER\}"[^)]*\)\/citus/);
  });

  it("asks for a tag the workflow builds, from the versions in the Dockerfile", () => {
    const tag = /^\s*tag:\s*"?([^"\s]+)"?\s*$/m.exec(block)?.[1];
    expect(tag, "database.image.tag is missing").toBeDefined();
    const citus = /^ARG CITUS_VERSION=(\S+)$/m.exec(DOCKERFILE)?.[1];
    const pg = /^ARG POSTGRES_IMAGE=postgres:(\d+)/m.exec(DOCKERFILE)?.[1];
    expect(citus, "citus.Dockerfile has no ARG CITUS_VERSION").toBeDefined();
    expect(pg, "citus.Dockerfile has no ARG POSTGRES_IMAGE").toBeDefined();
    // The workflow's own `tag=$citus-pg$pg`. Reproduced here rather than
    // referenced, because the point is that the chart names a tag that exists.
    expect(tag).toBe(`${citus}-pg${pg}`);
  });

  it("is published on a release tag, with no paths filter to skip it", () => {
    /*
     * The failure this defends against has no symptom in this repository at
     * all. The image's version is Citus's, so a release usually changes
     * neither the Dockerfile nor this workflow — and with a paths filter on
     * every trigger, a release would publish a chart referencing an image no
     * run had built. The tag trigger must therefore stay filterless.
     */
    const push = /\n  push:\n([\s\S]*?)\n  [a-z_]+:/.exec(WORKFLOW)?.[1] ?? "";
    expect(push, "the push trigger no longer lists tags").toMatch(/tags:/);
    const afterTags = push.slice(push.indexOf("tags:"));
    expect(
      afterTags,
      "a paths filter under the tag trigger would let a release skip the image",
    ).not.toMatch(/^\s*paths:/m);
  });
});
