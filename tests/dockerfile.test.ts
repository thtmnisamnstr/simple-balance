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
      "COPY runtime/package.json runtime/pnpm-lock.yaml ./",
    );
    expect(dockerfile).toContain(
      "pnpm install --prod --frozen-lockfile --ignore-workspace",
    );
    expect(dockerfile).toContain(
      "--config.auto-install-peers=false",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules ./node_modules",
    );
    expect(dockerfile).not.toContain("pnpm prune --prod");
    expect(dockerfile).not.toContain("pnpm --filter");
  });

  it("labels the baseline image with its product and release version", () => {
    const dockerfile = readFileSync(
      new URL("../Dockerfile", import.meta.url),
      "utf8",
    );

    expect(dockerfile).toContain(
      'org.opencontainers.image.title="Simple Balance"',
    );
    expect(dockerfile).toContain(
      'org.opencontainers.image.version="0.1.0"',
    );
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
    const runtimeLock = readFileSync(
      new URL("../runtime/pnpm-lock.yaml", import.meta.url),
      "utf8",
    );
    const betterAuthResolution = runtimeLock
      .split("\n")
      .find((line) => line.trimStart().startsWith("version: 1.6.25("));

    expect(runtimeLock).toContain("autoInstallPeers: false");
    expect(betterAuthResolution).toBeDefined();
    expect(betterAuthResolution).not.toContain("drizzle-kit");
    expect(betterAuthResolution).not.toContain("vitest");
  });
});
