import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Docker runtime", () => {
  it("uses the configured PORT for its readiness healthcheck", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const healthcheck = dockerfile.split("\n").find((line) => line.includes("process.env.PORT"));

    expect(healthcheck).toBeDefined();
    expect(healthcheck).not.toContain("127.0.0.1:3000/health/ready");
  });

  it("installs the production-only runtime manifest independently of dev peers", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const applicationPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; dependencies: Record<string, string> };
    const runtimePackage = JSON.parse(
      readFileSync(new URL("../runtime/package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Bundled by Vite into the client, so the server image never imports them
    // and shipping them would be megabytes of node_modules nothing reads. The
    // two Stripe entries are the pair that needs saying out loud: `stripe` is
    // the server SDK and belongs in the runtime image, while `@stripe/*` are
    // its browser halves and do not — three packages from one vendor, split
    // across the boundary.
    const browserOnlyDependencies = new Set([
      "@stripe/react-stripe-js",
      "@stripe/stripe-js",
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
    expect(dockerfile).toContain("COPY runtime/package.json runtime/package-lock.json ./");
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
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain("COPY public ./public");
  });

  it("labels the image with its product and the version being built", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const applicationPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(dockerfile).toContain('org.opencontainers.image.title="Simple Balance"');
    // A published image must report the release it contains, so the label comes
    // from a build argument that defaults to the current package version.
    expect(dockerfile).toContain('org.opencontainers.image.version="${APP_VERSION}"');
    expect(dockerfile).toContain(`ARG APP_VERSION=${applicationPackage.version}`);
  });

  it("applies available Alpine security updates to the final runtime stage", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    // Found by shape rather than by name: the base carries a digest now, and a
    // literal would have gone looking for a stage that is still there.
    const runtimeStage = dockerfile.slice(dockerfile.search(/^FROM (?:--\S+ )*\S+ AS runtime$/m));

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
      readFileSync(new URL("../runtime/package-lock.json", import.meta.url), "utf8"),
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
    for (const name of ["drizzle-kit", "vitest", "vite", "typescript", "esbuild", "tsx"]) {
      expect(runtimeLock.packages).not.toHaveProperty(`node_modules/${name}`);
    }
    expect(Object.values(runtimeLock.packages).some((entry) => entry.dev)).toBe(false);
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
        JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
          packages: Record<string, { version?: string }>;
        }
      ).packages;
    const root = resolved("../package-lock.json");
    const runtime = resolved("../runtime/package-lock.json");
    const shared = Object.keys(
      (
        JSON.parse(readFileSync(new URL("../runtime/package.json", import.meta.url), "utf8")) as {
          dependencies: Record<string, string>;
        }
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
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
    version: string;
  };

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
    expect(read("server.Dockerfile")).toContain('CMD ["node", "dist/server/server/index.js"]');
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
    const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
    const template = readFileSync(
      new URL("../deploy/docker/nginx.conf.template", import.meta.url),
      "utf8",
    );
    // Read out of the template rather than listed here. A hardcoded copy is a
    // mirror, not a check: it agrees with itself while the config it is meant
    // to be holding to account says something else.
    const alternation = /location ~ \^\/\(([^)]+)\)\(\/\|\$\)/.exec(template);
    expect(alternation, "no proxy location in the template").not.toBeNull();
    const proxied = new Set(alternation![1]!.split("|").map((name) => name.replaceAll("\\", "")));
    expect(proxied.size, "parsed no prefixes out of the proxy location").toBeGreaterThan(3);
    // Anything the client bundle is expected to own rather than the API.
    const servedByNginx = new Set(["assets"]);
    // Answered by the API and deliberately unreachable through the browser's
    // front door. A scrape goes to the API service directly, which is where a
    // Prometheus job and a NetworkPolicy can both see it; proxying it here
    // would put queue depths and write rates on the same public hostname as
    // the sign-in page, one path away.
    const deliberatelyNotProxied = new Set(["metrics"]);
    const prefixes = new Set(
      [...api.matchAll(/app\.(?:get|post|put|delete|use|all|on)\(\s*"\/([^/"*]+)/g)].map(
        (match) => match[1],
      ),
    );
    for (const prefix of prefixes) {
      if (servedByNginx.has(prefix) || deliberatelyNotProxied.has(prefix)) continue;
      expect(proxied, `/${prefix} is answered by the API but not proxied`).toContain(prefix);
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
    for (const path of ["/", "/recurrences", "/assets/index-abc.js", "/mcpanel", "/metrics"]) {
      expect(matcher.test(path), `${path} must stay with the bundle`).toBe(false);
    }
  });
});

/**
 * What an image says about itself when nobody published it.
 *
 * The release workflow runs `docker/metadata-action`, which adds `created`,
 * `revision` and more on top, so a published image has always carried more than
 * a hand-built one. These are the labels every image carries however it was
 * built, which is what makes them the ones worth guaranteeing.
 */
describe("the labels on every image", () => {
  const dockerfiles = [
    "Dockerfile",
    "deploy/docker/server.Dockerfile",
    "deploy/docker/scheduler.Dockerfile",
    "deploy/docker/frontend.Dockerfile",
  ] as const;
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("names the product, its licence and where it came from", () => {
    for (const path of dockerfiles) {
      const dockerfile = read(path);
      for (const label of [
        "org.opencontainers.image.title=",
        "org.opencontainers.image.description=",
        'org.opencontainers.image.version="${APP_VERSION}"',
        'org.opencontainers.image.licenses="AGPL-3.0-only"',
        'org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"',
        'org.opencontainers.image.url="https://github.com/thtmnisamnstr/simple-balance"',
        "org.opencontainers.image.documentation=",
      ]) {
        expect(dockerfile, `${path} must set ${label}`).toContain(label);
      }
    }
  });

  it("records the base it was actually built on, by name and by digest", () => {
    for (const path of dockerfiles) {
      const dockerfile = read(path);
      // Read out of the file rather than written down here, so bumping a base
      // and forgetting the label fails instead of shipping an image that lies
      // about what it contains. Dependabot moves the `FROM` line and cannot
      // move a label, so this is what catches half a bump: the pull request
      // stays red until the digest below it is the digest above it.
      const runtime = [
        ...dockerfile.matchAll(/^FROM (?:--\S+ )*(\S+?)@(sha256:[0-9a-f]{64}) AS runtime$/gm),
      ].at(-1);
      expect(runtime, `${path} must pin its runtime base by digest`).toBeDefined();
      expect(dockerfile, path).toContain(`org.opencontainers.image.base.name="${runtime![1]!}"`);
      expect(dockerfile, `${path} labels a digest its runtime FROM does not name`).toContain(
        `org.opencontainers.image.base.digest="${runtime![2]!}"`,
      );
    }
  });

  /**
   * The shipped stage is the one the label describes, and every other stage
   * still decides what is in it. A build stage on a moving tag compiles the
   * application against whatever `node:24-alpine` meant this morning, which is
   * the half of reproducibility a label cannot record.
   */
  it("pins every base it builds on, not only the one it ships", () => {
    for (const path of dockerfiles) {
      // `--platform=...` and any other flag is skipped rather than left to make
      // the line stop matching, because a regex that no longer matches is a
      // check that reports nothing and passes.
      const floating = [...read(path).matchAll(/^FROM (?:--\S+ )*(\S+) AS \S+$/gm)]
        .map((match) => match[1]!)
        // A stage naming an earlier stage carries no tag and needs no digest.
        .filter((image) => image.includes(":") && !image.includes("@sha256:"));

      expect(floating, `${path} builds on a tag that can move`).toEqual([]);
    }
  });

  it("claims no build fact a hand build cannot know", () => {
    for (const path of dockerfiles) {
      // Instructions only: the comment above each LABEL names both of these
      // while explaining why neither is set.
      const dockerfile = read(path)
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n");
      // A Dockerfile cannot emit a label conditionally, so setting either of
      // these from a defaulted ARG would label every hand-built image with an
      // empty string, which a consumer reads as known and empty rather than as
      // absent. The release workflow supplies both.
      expect(dockerfile, path).not.toContain("org.opencontainers.image.created");
      expect(dockerfile, path).not.toContain("org.opencontainers.image.revision");
    }
  });
});

/**
 * Every `SB_` name the nginx template reads has somewhere to come from.
 *
 * The nginx image's entrypoint builds its envsubst list by walking the
 * environment and keeping the names that match `NGINX_ENVSUBST_FILTER`. A name
 * that is not *in* the environment is therefore never substituted: it survives
 * into the rendered config as a literal `${SB_WHATEVER}`, nginx reads that as a
 * variable reference, and the container exits with
 * `[emerg] unknown "sb_whatever" variable` before it serves anything.
 *
 * That is not a degraded mode. The frontend container is the only one serving
 * the bundle and the only one proxying `/api`, `/mcp`, `/health` and
 * `/.well-known`, so the whole product is unreachable while the API and the
 * scheduler stay healthy and log nothing about it. It shipped exactly once, in
 * the change that added the rehearsal switch, and every test in this repository
 * read the template as text rather than running it.
 *
 * An `ENV` default in the image is what makes the name present, and it is what
 * makes `docker run`, Compose and Helm all work without each repeating it.
 */
describe("the nginx template and the image that renders it", () => {
  const template = readFileSync(
    new URL("../deploy/docker/nginx.conf.template", import.meta.url),
    "utf8",
  );
  const dockerfile = readFileSync(
    new URL("../deploy/docker/frontend.Dockerfile", import.meta.url),
    "utf8",
  );

  it("gives every SB_ name the template reads a default in the image", () => {
    // Both spellings. `envsubst` substitutes `$SB_NAME` exactly as it does
    // `${SB_NAME}`, so a census that knew only the braced form would miss a
    // reference written the other way — and reproduce the container-will-not-
    // start defect this guard exists to prevent, while passing.
    const referenced = [...template.matchAll(/\$\{?(SB_[A-Z0-9_]+)\}?/g)].map((match) => match[1]!);
    const defined = new Set(
      [...dockerfile.matchAll(/^ENV (SB_[A-Z0-9_]+)=/gm)].map((match) => match[1]!),
    );
    // The census finds something, so a broken regex reads as a pass rather than
    // as a template with no variables in it.
    expect(new Set(referenced).size).toBeGreaterThanOrEqual(4);
    const orphaned = [...new Set(referenced)].filter((name) => !defined.has(name));
    expect(orphaned, "referenced by the template with no ENV default to render from").toEqual([]);
  });

  /**
   * And the other direction, because a default nothing reads is a setting an
   * operator can set with no effect — which is the shape the compose recipe
   * shipped for a release with `IDEMPOTENCY_RETENTION_HOURS`.
   */
  it("reads every SB_ default the image declares", () => {
    const defined = [...dockerfile.matchAll(/^ENV (SB_[A-Z0-9_]+)=/gm)].map((match) => match[1]!);
    const referenced = new Set(
      [...template.matchAll(/\$\{?(SB_[A-Z0-9_]+)\}?/g)].map((match) => match[1]!),
    );
    const unread = defined.filter((name) => !referenced.has(name));
    expect(unread, "defaulted in the image and read by nothing").toEqual([]);
  });

  /**
   * And the third direction: every one of them can be set from both shapes that
   * deploy this image.
   *
   * The two above are about a container that will not start, which is loud. This
   * one is about a setting that exists and cannot be reached, which is silent —
   * the operator reads the documentation, finds the name, and has nowhere to put
   * it. `SB_TRUSTED_PROXY_CIDR` was exactly that for the length of one commit:
   * the image defaulted it, the template read it, and neither the chart nor the
   * compose recipe passed it, so every deployment kept the shared sign-in
   * allowance it was written to fix while the census above stayed green.
   *
   * An image default is not the answer to this. A default is the *off*
   * position by construction — that is what makes an upgrade change nothing —
   * so a name nobody can set is a name permanently off.
   */
  it("lets both deployment shapes set every SB_ name", () => {
    const referenced = [
      ...new Set([...template.matchAll(/\$\{?(SB_[A-Z0-9_]+)\}?/g)].map((match) => match[1]!)),
    ];
    for (const [label, relative] of [
      ["the chart", "../deploy/helm/simple-balance/templates/frontend-deployment.yaml"],
      ["the compose recipe", "../deploy/compose/compose.distributed.yml"],
    ] as const) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      const missing = referenced.filter((name) => !source.includes(name));
      expect(missing, `read by the template and unreachable from ${label}`).toEqual([]);
    }
  });
});

/**
 * The database image, which is not one of the four and must not be treated as
 * one.
 *
 * `docs/standards/operations.md` §An image we build for a dependency carries the
 * dependency's version is the rule. The obligations it shares with the other
 * four — a pinned base, a licence, a source — are checked here rather than in the
 * loop above, because two of that loop's assertions are actively wrong for this
 * image: its `FROM` comes from an `ARG` so the digest is one level down, and its
 * version label is Citus's rather than `APP_VERSION`.
 *
 * Adding it to the list would therefore have meant weakening the list. The four
 * app images are one population and this is another, and saying so is what keeps
 * both checks strict.
 */
describe("the database image", () => {
  const path = "deploy/docker/citus.Dockerfile";
  const dockerfile = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("pins its base by digest, through the ARG that names it", () => {
    const base = /^ARG POSTGRES_IMAGE=(\S+)$/m.exec(dockerfile)?.[1];
    expect(base, "citus.Dockerfile must name its base in ARG POSTGRES_IMAGE").toBeDefined();
    expect(base, "the base must be pinned by digest, not by a tag that can move").toContain(
      "@sha256:",
    );
    // And nothing else may introduce an unpinned base behind its back.
    const floating = [...dockerfile.matchAll(/^FROM (?:--\S+ )*(\S+)/gm)]
      .map((match) => match[1]!)
      .filter((image) => image.includes(":") && !image.includes("@sha256:"));
    expect(floating, "builds on a tag that can move").toEqual([]);
  });

  it("pins the source it compiles, and its checksum", () => {
    expect(dockerfile).toMatch(/^ARG CITUS_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/^ARG CITUS_SHA256=[a-f0-9]{64}$/m);
    // A tarball fetched over the network and compiled into a database holding
    // people's money is where a substitution would be worth making, so the
    // checksum has to be verified rather than merely recorded.
    expect(dockerfile).toContain("sha256sum -c -");
  });

  it("carries the licence and source, and does not claim this product's version", () => {
    for (const label of [
      "org.opencontainers.image.title=",
      'org.opencontainers.image.licenses="AGPL-3.0-only"',
      'org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"',
    ]) {
      expect(dockerfile, `${path} must set ${label}`).toContain(label);
    }
    // The rule, stated as a check: this image's version belongs to Citus and
    // PostgreSQL. Labelling it with APP_VERSION would print 0.2.0 on contents
    // decided by somebody else's release cycle.
    //
    // Instructions only, the same way the four-image loop above reads them: the
    // comment at the top of this file explains at length why APP_VERSION is not
    // used, and a check that read comments would fail on the sentence saying so.
    const instructions = dockerfile
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(instructions, "the database image must not claim APP_VERSION").not.toContain(
      "APP_VERSION",
    );
  });
});
