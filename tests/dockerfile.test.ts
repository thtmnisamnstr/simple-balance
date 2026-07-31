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
