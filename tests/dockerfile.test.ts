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

  it("locks the standalone runtime without Better Auth development peers", () => {
    const runtimeLock = JSON.parse(
      readFileSync(
        new URL("../runtime/package-lock.json", import.meta.url),
        "utf8",
      ),
    ) as {
      packages: Record<string, { version?: string; dev?: boolean }>;
    };

    expect(runtimeLock.packages["node_modules/better-auth"]?.version).toBe(
      "1.6.25",
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
});

/**
 * The decomposed images are not built by CI, by request, so nothing else would
 * notice them going stale. These assertions are the substitute: they catch a
 * renamed build script, a moved file, or a proxy that stops covering a route
 * prefix, which are the ways a Dockerfile nobody builds quietly stops working.
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
    for (const prefix of proxied) {
      expect(template).toContain(prefix.replace(".", "\\."));
    }
  });
});
