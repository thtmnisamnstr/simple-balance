import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoFiles, sourceFiles } from "./support/source.js";

/**
 * The example files an operator copies, and the two rules that keep them
 * readable as instructions rather than as inventories.
 *
 * Optional variables are commented out, so uncommenting a line is the act that
 * turns a setting on and an operator can see at a glance what they have
 * changed. Only the secrets are present and empty, because a secret has no
 * example value that is not a hazard. The compose file shipped nine optional
 * variables present and empty, which reads as nine settings already in force.
 */
const root = new URL("../", import.meta.url).pathname;
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const assignedIn = (file: string) =>
  read(file)
    .split("\n")
    .flatMap((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []);

/** The comment block sitting directly above a variable, closest line first. */
const commentAbove = (file: string, name: string) => {
  const lines = read(file).split("\n");
  const at = lines.findIndex((line) => line.replace(/^# ?/, "").startsWith(`${name}=`));
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i]!.startsWith("#"); i -= 1) block.push(lines[i]!);
  return block.join("\n");
};

describe("what an example file leaves switched on", () => {
  it("assigns nothing in the single-container example but the settings a deployment always has", () => {
    expect(assignedIn(".env.example").sort()).toEqual(
      [
        "APP_BASE_URL",
        "AUTH_MODE",
        "AUTH_SECRET",
        "CSV_MAX_BYTES",
        "CSV_MAX_ROWS",
        "DATABASE_POOL_SIZE",
        "DATABASE_URL",
        "LOG_LEVEL",
        "PORT",
        "RECURRENCE_CATCH_UP_LIMIT",
        "RECURRENCE_CLAIM_LIMIT",
        "RECURRENCE_SCHEDULER",
        "RECURRENCE_TICK_SECONDS",
        "TRUST_PROXY",
      ].sort(),
    );
  });

  it("assigns nothing in the compose example but the settings a deployment always has", () => {
    // POSTGRES_PASSWORD is here because it is a secret, not because it is one of
    // this product's variables: it belongs to the bundled database container.
    expect(assignedIn("deploy/compose/.env.example").sort()).toEqual(
      ["APP_BASE_URL", "AUTH_MODE", "AUTH_SECRET", "LOG_LEVEL", "POSTGRES_PASSWORD"].sort(),
    );
  });

  // The vps profile's two files shipped every optional setting present and
  // empty, the same shape the compose file was corrected out of above.
  // SB_BIND_ADDRESS is this machine's own address, which it always has.
  it("assigns nothing in the vps application example but what both machines always have", () => {
    expect(assignedIn("deploy/compose/vps/.env.app.example").sort()).toEqual(
      ["APP_BASE_URL", "AUTH_SECRET", "DATABASE_URL", "SB_BIND_ADDRESS"].sort(),
    );
  });

  it("assigns nothing in the vps frontend example but what that machine always has", () => {
    expect(assignedIn("deploy/compose/vps/.env.frontend.example").sort()).toEqual(
      ["SB_API_ORIGIN", "SITE_ADDRESS"].sort(),
    );
  });
});

describe("the quoting warning beside a password", () => {
  it("tells the reader of the single-container file not to quote", () => {
    const warning = commentAbove(".env.example", "SMTP_PASSWORD");

    expect(warning).toContain("Do not quote");
    expect(warning).toContain("--env-file");
  });

  it("tells the reader of the compose file the opposite, because a different parser reads it", () => {
    const warning = commentAbove("deploy/compose/.env.example", "SMTP_PASSWORD");

    expect(warning).toContain("single-quote");
    expect(warning).toContain("$");
  });
});

/** Every variable named in a `docs/deployment.md` settings table. */
const documented = () =>
  new Set(
    [...read("docs/deployment.md").matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map(
      (match) => match[1]!,
    ),
  );

/** Every variable an example file mentions, whether or not the line is live. */
const mentionedIn = (file: string) =>
  new Set(
    read(file)
      .split("\n")
      .flatMap((line) => /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []),
  );

/**
 * The nginx container's own. Neither example file configures it: the root file
 * serves the single container, which contains no nginx, and the compose file
 * sets them on the frontend service beside the reason each is what it is.
 * `docs/deployment.md` says so where they are documented, which is what makes
 * this an exception rather than the drift above.
 *
 * `SB_CSP_REPORT_ONLY` is deliberately *not* here: the server reads it too, and
 * the example files are where a reader meets it. `SB_BILLING_CONFIGURED` is,
 * because only nginx reads it — the server derives the same fact from the
 * Stripe settings themselves.
 */
const frontendImageOnly = [
  "SB_API_ORIGIN",
  "SB_FRONTEND_PORT",
  "SB_MAX_UPLOAD_SIZE",
  "SB_BILLING_CONFIGURED",
  "SB_ADS_CONFIGURED",
];
/**
 * The bundled `postgres:18` container's own variable, documented at
 * `deploy/compose/README.md` beside the file that uses it. Putting another
 * image's settings in this product's tables would make the tables less true.
 */
const bundledDatabaseOnly = ["POSTGRES_PASSWORD"];

/**
 * A drifted example file is worse than no example file, because it is believed.
 *
 * Six variables were outside the correspondence while it was kept by hand
 * rather than checked: `NODE_ENV` and the two Google settings were in the root
 * example and in no table, and the three the nginx image reads were in a table
 * and in no example. Both halves are the same defect from opposite ends — an
 * operator who copies the example gets a variable nothing documents, and one
 * who reads the tables looks for a line that is not there.
 */
describe("what the example files and the deployment tables say about each other", () => {
  it.each([".env.example", "deploy/compose/.env.example"])(
    "documents every variable %s names",
    (file) => {
      const tables = documented();
      const undocumented = [...mentionedIn(file)].filter(
        (name) => !tables.has(name) && !bundledDatabaseOnly.includes(name),
      );

      expect(tables.size).toBeGreaterThan(0);
      expect(undocumented).toEqual([]);
    },
  );

  it("shows an example of every variable the tables document", () => {
    const examples = new Set([
      ...mentionedIn(".env.example"),
      ...mentionedIn("deploy/compose/.env.example"),
    ]);
    const unexampled = [...documented()].filter(
      (name) => !examples.has(name) && !frontendImageOnly.includes(name),
    );

    expect(examples.size).toBeGreaterThan(0);
    expect(unexampled).toEqual([]);
  });

  it("keeps the named exceptions to that rule genuinely outside it", () => {
    // A test whose exception list has quietly become the rule proves nothing,
    // so each name has to still be missing from the side it is excused from.
    const examples = new Set([
      ...mentionedIn(".env.example"),
      ...mentionedIn("deploy/compose/.env.example"),
    ]);
    for (const name of frontendImageOnly) {
      expect(documented(), name).toContain(name);
      expect(examples, name).not.toContain(name);
    }
    for (const name of bundledDatabaseOnly) {
      expect(examples, name).toContain(name);
      expect(documented(), name).not.toContain(name);
    }
  });
});

/**
 * A variable the compose example documents and the compose file never passes.
 *
 * The two files look like one thing and are not: `.env.example` is copied to
 * `.env`, which Compose reads for *interpolation*, and a variable only reaches
 * a container if `compose.distributed.yml` names it in its environment block.
 * So a variable can be documented, uncommented by an operator, and do nothing
 * at all — which is worse than not documenting it, because the operator has
 * every reason to believe it worked.
 *
 * This was a real gap: nine monetization variables were added to the example
 * and to the deployment tables, and none of them were wired into the compose
 * file. Nothing failed, because nothing looked.
 */
describe("what the compose example promises and the compose file delivers", () => {
  /**
   * Variables consumed by a bundled container's own `environment:` rather than
   * by this product, or interpolated into a connection string rather than
   * passed through. `POSTGRES_DATA_DIR` is a volume's bind path and never
   * reaches a process at all.
   */
  const databaseOnly = ["POSTGRES_PASSWORD", "POSTGRES_DATA_DIR"];

  /**
   * Every example file under `deploy/compose/`, paired with the compose files
   * beside it.
   *
   * Discovered rather than listed, and for the reason the list itself
   * demonstrates: this check was written for one pair, and adding the `single`
   * profile created a second pair that nothing looked at — the same defect the
   * docblock above describes, reintroduced by the fix's own shape. A recipe is
   * a directory holding an example and the compose files it is an example for.
   */
  const recipes = globSync("deploy/compose/**/.env*.example", { cwd: root }).map((example) => {
    const directory = example.slice(0, example.lastIndexOf("/"));
    const files = globSync(`${directory}/*.yml`, { cwd: root });
    return { example, directory, delivered: files.map((file) => read(file)).join("\n") };
  });

  it("covers every recipe under deploy/compose", () => {
    // Every example rather than every directory, because the vps profile keeps
    // one per machine, named `.env.app.example` and so on — which the first
    // spelling of this glob, `.env.example` exactly, never matched, so that
    // whole profile sat outside the check. A file that nothing paired would
    // otherwise read as a pass.
    expect(recipes.map((recipe) => recipe.example).sort()).toEqual([
      "deploy/compose/.env.example",
      "deploy/compose/single/.env.example",
      "deploy/compose/vps/.env.app.example",
      "deploy/compose/vps/.env.frontend.example",
      "deploy/compose/vps/.env.postgres.example",
    ]);
    for (const recipe of recipes)
      expect(recipe.delivered.length, recipe.directory).toBeGreaterThan(0);
  });

  it.each(recipes.map((recipe) => [recipe.example, recipe] as const))(
    "passes every variable %s names",
    (_label, recipe) => {
      const undelivered = [...mentionedIn(recipe.example)].filter(
        (name) =>
          !databaseOnly.includes(name) && !new RegExp(`\\b${name}[:}]`).test(recipe.delivered),
      );

      expect(undelivered).toEqual([]);
    },
  );
});

/**
 * What the server reads, and every compose file that runs it passing each name.
 *
 * The block above runs from the example files outward, so it can only look for
 * a name somebody already wrote into an example. `PRIVACY_POLICY_URL` was in
 * none of the compose examples, and all three compose shapes dropped it: an
 * operator turning AdSense on set it, Compose passed the AdSense ids and left
 * the policy address behind, and the server refused to start asking for the
 * variable they had just set. The `vps` profile was missing eight names that
 * way and passed two — `SMTP_SECURE` and `SMTP_FROM` — that the server has
 * never read, so configuring mail there stopped both machines. A name
 * misspelled the same way in an example and a compose file agrees with itself,
 * and no check driven by the examples can see it.
 *
 * So this one starts from the source. The names are what `src/server` reads —
 * `process.env.NAME`, `readSecret("NAME")`, and the bounded integers
 * `config-limits.ts` reads by name — with comments blanked so that prose cannot
 * add one. Every server or scheduler service a compose file runs has to be
 * passed each of them, and nothing the server does not read.
 */
describe("what the server reads and every compose file that runs it passes", () => {
  const serverCode = sourceFiles("src/server")
    .map((file) => file.code)
    .join("\n");
  const namesIn = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].map((match) => match[1]!);
  const serverReads = new Set(
    [
      /process\.env\.([A-Z][A-Z0-9_]*)\b/g,
      /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
      /readSecret\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
      /boundedEnvironmentInteger\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    ].flatMap((pattern) => namesIn(serverCode, pattern)),
  );
  // Found by the refusal each one carries, which is also what makes an empty
  // value fatal: every boolean the server reads is parsed against exactly
  // `true` and `false`.
  const serverBooleans = new Set(namesIn(serverCode, /"([A-Z][A-Z0-9_]*) must be true or false"/g));
  // A frontend service's settings are the nginx template's, read here as the
  // template reads them.
  const nginxReads = new Set(
    namesIn(read("deploy/docker/nginx.conf.template"), /\$\{(SB_[A-Z0-9_]+)\}/g),
  );
  /**
   * The postgres image's own settings, on the database service
   * `compose.distributed.yml` bundles beside the application. Another image's
   * variables, so they are neither a name the server reads nor a defect.
   */
  const bundledDatabase = ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"];

  /**
   * Names the server reads that one process deliberately is not passed, each
   * with its reason. Keyed by file and service, because a reason is about a
   * process: what is wrong to offer one is the whole point of another.
   */
  const schedulerIgnoresIt =
    "the scheduler's entrypoint always ticks and never reads it, so each file sets it on the server alone";
  const deliberatelyUnpassed: Record<string, Record<string, string>> = {
    "deploy/compose/single/compose.yml app": {
      RECURRENCE_SCHEDULER:
        "the one process in the profile, so off would leave recurrences that nothing ever proposes",
    },
    "deploy/compose/compose.distributed.yml scheduler": {
      RECURRENCE_SCHEDULER: schedulerIgnoresIt,
    },
    "deploy/compose/vps/compose.app.yml scheduler": { RECURRENCE_SCHEDULER: schedulerIgnoresIt },
  };

  /**
   * Every service a compose file declares, with the names its `environment:`
   * block hands the container and what kind of container it is.
   *
   * Per service rather than per file, because a file is not what receives a
   * setting. `compose.distributed.yml` runs nginx beside the server, and its
   * frontend passes `SB_CSP_REPORT_ONLY` too, so a check reading every name in
   * the file still found that one after it had gone from the server's block:
   * the server lost the setting that registers its report endpoint and both
   * directions passed. And a server secret added to the frontend passed as a
   * name the server reads.
   *
   * Read as text, following the one layout these files share — services at two
   * spaces, their keys at four, anchors at the margin merged with `<<:` or
   * named whole — because no YAML parser is among this repository's
   * dependencies. An environment line in any other shape throws rather than
   * reading as a setting nobody passes.
   */
  const indentOf = (line: string) => line.length - line.trimStart().length;
  /** The lines indented under line `at`, blank lines and comments left out. */
  const under = (lines: string[], at: number) => {
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      if (indentOf(line) <= indentOf(lines[at]!)) break;
      body.push(line);
    }
    return body;
  };
  const kindOf = (service: string) =>
    /^\s+image: ghcr\.io\/thtmnisamnstr\/simple-balance(?:-server|-scheduler)?:/m.test(service) ||
    /^\s+dockerfile: deploy\/docker\/(?:server|scheduler)\.Dockerfile$/m.test(service)
      ? "server"
      : /^\s+image: ghcr\.io\/thtmnisamnstr\/simple-balance-frontend:/m.test(service) ||
          /^\s+dockerfile: deploy\/docker\/frontend\.Dockerfile$/m.test(service)
        ? "frontend"
        : /^\s+image: postgres:/m.test(service)
          ? "database"
          : "other";
  const servicesIn = (path: string, text: string) => {
    const lines = text.split("\n");
    const anchors = new Map<string, string[]>();
    lines.forEach((line, at) => {
      const anchor = /^[\w-]+: &([\w-]+)\s*$/.exec(line)?.[1];
      if (anchor !== undefined) anchors.set(anchor, under(lines, at));
    });
    const anchored = (anchor: string) => {
      const mapping = anchors.get(anchor);
      if (!mapping) throw new Error(`${path}: no anchor &${anchor}`);
      return mapping;
    };
    const names = (mapping: string[]): string[] =>
      mapping
        .filter((line) => indentOf(line) === indentOf(mapping[0]!))
        .flatMap((line) => {
          const merged = /^\s+<<: \*([\w-]+)$/.exec(line)?.[1];
          if (merged !== undefined) return names(anchored(merged));
          const name = /^\s+([A-Z][A-Z0-9_]*):/.exec(line)?.[1];
          if (name === undefined)
            throw new Error(`${path}: an environment line this test cannot read: ${line}`);
          return [name];
        });

    const start = lines.indexOf("services:");
    if (start === -1) return [];
    const next = lines.findIndex((line, at) => at > start && /^[A-Za-z]/.test(line));
    return lines.slice(start + 1, next === -1 ? undefined : next).flatMap((line, offset) => {
      const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
      if (name === undefined) return [];
      const body = under(lines, start + 1 + offset);
      const environment = body.findIndex((entry) => /^ {4}environment:/.test(entry));
      const whole = /^ {4}environment: \*([\w-]+)\s*$/.exec(body[environment] ?? "")?.[1];
      const passes =
        environment === -1
          ? []
          : whole !== undefined
            ? names(anchored(whole))
            : names(under(body, environment));
      return [{ name, kind: kindOf(body.join("\n")), passes: new Set(passes) }];
    });
  };

  const composeFiles = repoFiles(
    (path) => path.startsWith("deploy/compose/") && /\.ya?ml$/.test(path),
  ).map(({ path, text }) => ({ path, text, services: servicesIn(path, text) }));
  const runsTheServer = composeFiles.filter(({ services }) =>
    services.some((service) => service.kind === "server"),
  );
  const each = runsTheServer.map((file) => [file.path, file] as const);
  const processes = (file: (typeof composeFiles)[number]) =>
    file.services.filter((service) => service.kind === "server");

  it("finds what the server reads by every route it reads by", () => {
    // One name per route, so a pattern that stopped matching fails here rather
    // than reading as a server that reads less.
    for (const name of [
      "APP_BASE_URL",
      "DATABASE_URL",
      "IDEMPOTENCY_RETENTION_HOURS",
      "CSV_MAX_ROWS",
    ]) {
      expect(serverReads, name).toContain(name);
    }
    expect(serverBooleans).toContain("SMTP_SSL");
    expect(nginxReads).toContain("SB_API_ORIGIN");
  });

  it("finds every compose file that runs the server", () => {
    // Discovered, so a fourth shape is checked the day it lands; listed here as
    // well, so a discovery rule that stopped matching one cannot pass by
    // checking fewer.
    expect(runsTheServer.map((file) => file.path).sort()).toEqual([
      "deploy/compose/compose.distributed.yml",
      "deploy/compose/single/compose.yml",
      "deploy/compose/vps/compose.app.yml",
    ]);
  });

  it("reads every service in them as a kind it knows", () => {
    // What each one is decides which rule holds it, so a service this test
    // cannot place would sit outside all of them.
    expect(
      runsTheServer.map((file) => [
        file.path,
        file.services.map((service) => `${service.name}: ${service.kind}`),
      ]),
    ).toEqual([
      [
        "deploy/compose/compose.distributed.yml",
        ["postgres: database", "server: server", "frontend: frontend", "scheduler: server"],
      ],
      ["deploy/compose/single/compose.yml", ["app: server"]],
      ["deploy/compose/vps/compose.app.yml", ["server: server", "scheduler: server"]],
    ]);
  });

  it.each(each)("passes every setting the server reads, to each process in %s", (_label, file) => {
    const dropped = processes(file).flatMap((service) => {
      const excused = deliberatelyUnpassed[`${file.path} ${service.name}`] ?? {};
      return [...serverReads]
        .filter((name) => !service.passes.has(name) && !(name in excused))
        .map((name) => `${service.name}: ${name}`);
    });

    expect(dropped.sort()).toEqual([]);
  });

  it.each(each)(
    "passes nothing the server does not read, to each process in %s",
    (_label, file) => {
      const unread = processes(file).flatMap((service) =>
        [...service.passes]
          .filter((name) => !serverReads.has(name))
          .map((name) => `${service.name}: ${name}`),
      );

      expect(unread.sort()).toEqual([]);
    },
  );

  it("passes a frontend nothing but the nginx template's settings, and a database only its own", () => {
    // The other half of reading per service: a server secret added to the
    // frontend would otherwise pass as a name the server reads.
    const frontends = composeFiles.flatMap((file) =>
      file.services
        .filter((service) => service.kind === "frontend")
        .map((service) => ({ ...service, at: `${file.path} ${service.name}` })),
    );
    const databases = runsTheServer.flatMap((file) =>
      file.services
        .filter((service) => service.kind === "database")
        .map((service) => ({ ...service, at: `${file.path} ${service.name}` })),
    );

    expect(frontends.map((service) => service.at).sort()).toEqual([
      "deploy/compose/compose.distributed.yml frontend",
      "deploy/compose/vps/compose.frontend.yml frontend",
    ]);
    for (const service of frontends)
      expect(
        [...service.passes].filter((name) => !nginxReads.has(name)),
        service.at,
      ).toEqual([]);
    expect(databases.length).toBeGreaterThan(0);
    for (const service of databases)
      expect(
        [...service.passes].filter((name) => !bundledDatabase.includes(name)),
        service.at,
      ).toEqual([]);
  });

  it.each(each)(
    "gives every boolean a real default rather than an empty string, in %s",
    (_label, file) => {
      // `${VAR:-}` resolves to "" when the variable is unset, and an empty
      // boolean refuses to start. The defaulted form is what keeps an unset
      // variable meaning "off" rather than meaning "stop".
      const booleans = [...file.text.matchAll(/^[ \t]+([A-Z][A-Z0-9_]*): (.*)$/gm)].filter(
        ([, name]) => serverBooleans.has(name!),
      );

      expect(booleans.length).toBeGreaterThan(0);
      for (const [, name, value] of booleans) {
        expect(value, `${name} can arrive empty`).toMatch(
          /^(?:"?(?:true|false)"?|\$\{\w+:-(?:true|false)\})$/,
        );
      }
    },
  );

  it("keeps its exceptions genuinely outside the rule", () => {
    // An exception list that has quietly become the rule proves nothing, so
    // each entry has to still be a name the server reads and still be absent
    // from the process it excuses.
    for (const [at, names] of Object.entries(deliberatelyUnpassed)) {
      const [path, name] = at.split(" ");
      const service = runsTheServer
        .find((candidate) => candidate.path === path)
        ?.services.find((candidate) => candidate.name === name && candidate.kind === "server");
      expect(service, `${at} no longer runs the server`).toBeDefined();
      for (const unpassed of Object.keys(names)) {
        expect(serverReads, `${at}: the server no longer reads ${unpassed}`).toContain(unpassed);
        expect(service!.passes, `${at} passes ${unpassed} after all`).not.toContain(unpassed);
      }
    }
    for (const name of bundledDatabase) expect(serverReads, name).not.toContain(name);
  });
});
