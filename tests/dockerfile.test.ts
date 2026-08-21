import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Docker runtime", () => {
  it("uses the configured PORT for its readiness healthcheck", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );
    const healthcheck = dockerfile
      .split("\n")
      .find((line) => line.includes("process.env.PORT"));

    expect(healthcheck).toBeDefined();
    expect(healthcheck).not.toContain("127.0.0.1:3000/health/ready");
  });

  it("installs the production-only runtime manifest independently of dev peers", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );
    const applicationPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; dependencies: Record<string, string> };
    const runtimePackage = JSON.parse(
      readFileSync(
        new URL("../runtime/package.json", import.meta.url),
        "utf8",
      ),
    ) as {
      version: string;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const browserOnlyDependencies = new Set([
      "@tanstack/react-query",
      "lucide-react",
      "react",
      "react-dom",
    ]);
    const expectedRuntimeDependencies = Object.fromEntries(
      Object.entries(applicationPackage.dependencies).filter(
        ([name]) => !browserOnlyDependencies.has(name),
      ),
    );

    expect(runtimePackage.version).toBe(applicationPackage.version);
    expect(runtimePackage.dependencies).toEqual(expectedRuntimeDependencies);
    browserOnlyDependencies.forEach((name) => {
      expect(runtimePackage.dependencies).not.toHaveProperty(name);
    });
    expect(runtimePackage.devDependencies).toBeUndefined();
    expect(dockerfile).toContain(
      "COPY runtime/package.json runtime/package-lock.json ./",
    );
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain(
      "COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules",
    );
    // Every install must resolve from a committed lockfile, so the image cannot
    // drift between builds.
    expect(dockerfile).not.toMatch(/\bnpm install\b/);
    expect(dockerfile).not.toMatch(/\bnpm prune\b/);
    expect(dockerfile).not.toContain("pnpm");
  });

  // Everything referenced by index.html has to reach the build stage. The
  // favicon lives in public/, which Vite copies into the output, so leaving the
  // directory out ships an image whose icon 404s and nothing else notices.
  it("copies every build input the client references", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );
    expect(dockerfile).toContain("COPY public ./public");
  });

  it("labels the image with its product and the version being built", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );
    const applicationPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(dockerfile).toContain(
      'org.opencontainers.image.title="Simple Balance"',
    );
    // A published image must report the release it contains, so the label comes
    // from a build argument that defaults to the current package version.
    expect(dockerfile).toContain(
      'org.opencontainers.image.version="${APP_VERSION}"',
    );
    expect(dockerfile).toContain(`ARG APP_VERSION=${applicationPackage.version}`);
  });

  it("applies available Alpine security updates to the final runtime stage", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );
    const runtimeStage = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-alpine AS runtime"),
    );

    expect(runtimeStage).toContain("RUN apk upgrade --no-cache");
    expect(runtimeStage.indexOf("RUN apk upgrade --no-cache")).toBeLessThan(
      runtimeStage.indexOf("USER node"),
    );
  });

  /**
   * The frontend is the one published image that terminates traffic, and it was
   * also the one that never applied its base image's updates. It runs as a
   * non-root user, so the upgrade has to step up to root and back down again —
   * getting the second half wrong would leave nginx running as root.
   */
  it("patches the frontend image and leaves it running as its own user", () => {
    const dockerfile = readFileSync(
      new URL("../deploy/docker/frontend.Dockerfile", import.meta.url),
      "utf8",
    );
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));

    expect(runtimeStage).toContain("RUN apk upgrade --no-cache");
    const upgrade = runtimeStage.indexOf("RUN apk upgrade --no-cache");
    expect(runtimeStage.lastIndexOf("USER root", upgrade)).toBeGreaterThan(-1);
    expect(runtimeStage.indexOf("USER 101", upgrade)).toBeGreaterThan(upgrade);
    expect(runtimeStage.trimEnd().endsWith("USER root")).toBe(false);
  });

  it("locks the standalone runtime without Better Auth development peers", () => {
    const runtimeLock = JSON.parse(
      readFileSync(
        new URL("../runtime/package-lock.json", import.meta.url),
        "utf8",
      ),
    ) as {
      packages: Record<string, { version?: string; dev?: boolean }>;
    };

    // Against the manifest rather than a version written out here. What is
    // worth knowing is that the two agree, and a literal turns every routine
    // Better Auth bump into a failing pull request that says nothing about
    // whether anything is wrong.
    const runtimeManifest = JSON.parse(
      readFileSync(new URL("../runtime/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(runtimeLock.packages["node_modules/better-auth"]?.version).toBe(
      runtimeManifest.dependencies["better-auth"],
    );
    // Better Auth declares optional peers on database tooling. The runtime image
    // ships production dependencies only, so none of it may reach the lockfile.
    for (const name of [
      "drizzle-kit",
      "vitest",
      "vite",
      "typescript",
      "esbuild",
      "tsx",
    ]) {
      expect(runtimeLock.packages).not.toHaveProperty(`node_modules/${name}`);
    }
    expect(
      Object.values(runtimeLock.packages).some((entry) => entry.dev),
    ).toBe(false);
  });

  /**
   * The two manifests carry the same ranges, which is already asserted, and a
   * range is not a version: `^1.2.0` resolves to whatever was newest when each
   * lockfile was written. Install in one and not the other and the image ships
   * a version the suite never ran, with nothing to say so — the ranges still
   * agree and both lockfiles are internally valid.
   */
  it("ships the versions the tests ran against", () => {
    const resolved = (relative: string) =>
      (
        JSON.parse(
          readFileSync(new URL(relative, import.meta.url), "utf8"),
        ) as { packages: Record<string, { version?: string }> }
      ).packages;
    const root = resolved("../package-lock.json");
    const runtime = resolved("../runtime/package-lock.json");
    const shared = Object.keys(
      (
        JSON.parse(
          readFileSync(new URL("../runtime/package.json", import.meta.url), "utf8"),
        ) as { dependencies: Record<string, string> }
      ).dependencies,
    );

    for (const name of shared) {
      expect(
        runtime[`node_modules/${name}`]?.version,
        `${name} resolves differently in the two lockfiles`,
      ).toBe(root[`node_modules/${name}`]?.version);
    }
  });
});

/**
 * CI builds all three, but a build proves only that it built. These assertions
 * cover what it cannot: an entrypoint naming a file the compiler no longer
 * emits, the browser bundle leaking into the API image, a proxy that stops
 * covering a route prefix. Each of those builds cleanly and fails later.
 */
describe("the decomposed images", () => {
  const read = (name: string) =>
    readFileSync(new URL(`../deploy/docker/${name}`, import.meta.url), "utf8");
  const scripts = (
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string>; version: string }
  );

  it("runs build scripts and entrypoints that exist", () => {
    for (const [name, script] of [
      ["server.Dockerfile", "build:server"],
      ["scheduler.Dockerfile", "build:server"],
      ["frontend.Dockerfile", "build:client"],
    ] as const) {
      const dockerfile = read(name);
      expect(dockerfile, name).toContain(`RUN npm run ${script}`);
      expect(scripts.scripts, name).toHaveProperty(script);
      expect(dockerfile, name).not.toMatch(/\bnpm install\b/);
      expect(dockerfile, name).toContain(`ARG APP_VERSION=${scripts.version}`);
    }
    // tsconfig.server.json emits to dist/server, and both node images run a
    // file from it. A path that stops matching produces an image that builds
    // and then exits immediately.
    expect(read("server.Dockerfile")).toContain(
      'CMD ["node", "dist/server/server/index.js"]',
    );
    expect(read("scheduler.Dockerfile")).toContain(
      'CMD ["node", "dist/server/server/scheduler.js"]',
    );
  });

  it("keeps the API image free of the bundle nginx serves", () => {
    const server = read("server.Dockerfile");
    expect(server).toContain("COPY --from=build --chown=node:node /app/dist/server ./dist/server");
    expect(server).not.toContain("dist/client");
  });

  it("proxies every route prefix the API actually answers on", () => {
    const api = readFileSync(
      new URL("../src/server/api.ts", import.meta.url),
      "utf8",
    );
    const proxied = new Set(["api", "mcp", "health", ".well-known"]);
    // Anything the client bundle is expected to own rather than the API.
    const servedByNginx = new Set(["assets"]);
    const prefixes = new Set(
      [...api.matchAll(/app\.(?:get|post|put|delete|use|all|on)\(\s*"\/([^/"*]+)/g)].map(
        (match) => match[1],
      ),
    );
    const template = readFileSync(
      new URL("../deploy/docker/nginx.conf.template", import.meta.url),
      "utf8",
    );
    for (const prefix of prefixes) {
      if (servedByNginx.has(prefix)) continue;
      expect(proxied, `/${prefix} is answered by the API but not proxied`).toContain(
        prefix,
      );
    }

    // The regex itself, run against real paths rather than searched for as a
    // substring. /mcp is registered with and without its slash and discovery
    // advertises the bare form, so a pattern that only matches the slashed one
    // hands every correctly-configured client the application shell instead.
    const location = /location\s+~\s+(\S+)\s*\{/.exec(template);
    expect(location).not.toBeNull();
    const matcher = new RegExp(location![1]!);
    for (const path of [
      "/mcp",
      "/mcp/",
      "/api/v1/recurrences",
      "/health/ready",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect(matcher.test(path), `${path} must reach the API`).toBe(true);
    }
    for (const path of ["/", "/recurrences", "/assets/index-abc.js", "/mcpanel"]) {
      expect(matcher.test(path), `${path} must stay with the bundle`).toBe(false);
    }
  });
});
