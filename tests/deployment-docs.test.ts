import { readFileSync } from "node:fs";
import { repoFiles } from "./support/source.js";
import { describe, expect, it } from "vitest";

/**
 * The two files an operator actually copies from.
 *
 * This proves the four record names and the two pointers are present, and that
 * the run command carries the flags it is supposed to. It cannot prove the
 * section is useful: whether it answers the question somebody has at two in the
 * morning stays a person's job, and the guide's "review only" list says so.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("what an operator is told about getting mail delivered", () => {
  it("names the four records an operator has to publish", () => {
    const deployment = read("docs/deployment.md");
    const missing = ["SPF", "DKIM", "DMARC", "PTR"].filter((name) => !deployment.includes(name));

    expect(deployment).toContain("### Getting mail delivered");
    expect(missing).toEqual([]);
  });

  it("points at that section from the two files an operator meets first", () => {
    for (const path of ["README.md", ".env.example"]) {
      expect(read(path), path).toContain("SPF");
      expect(read(path), path).toContain("docs/deployment.md");
    }
  });

  it("keeps the RFC numbers in the standards guide", () => {
    // An operator needs the record and the registrar. A citation they cannot
    // check is worse than none, and the argument for each number lives in
    // docs/standards/operations.md where somebody is reading for the argument.
    expect(read("docs/deployment.md")).not.toMatch(/\bRFC \d+/);
  });
});

/** The fenced block holding the run command this project tells people to use. */
const documentedRunCommand = (path: string) => {
  const fenced = read(path).split("```");
  const block = fenced.find(
    (part) => part.includes("docker run") && part.includes("--env-file .env"),
  );
  expect(block, `${path} must document a docker run with --env-file`).toBeDefined();
  return block!;
};

describe("the run command people copy", () => {
  it("hands out a container that cannot write to itself or gain a privilege", () => {
    for (const path of ["README.md", "docs/deployment.md"]) {
      const command = documentedRunCommand(path);
      for (const flag of [
        "--read-only",
        "--tmpfs /tmp:rw,noexec,nosuid,size=16m",
        "--stop-timeout 30",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
      ]) {
        expect(command, `${path} must pass ${flag}`).toContain(flag);
      }
    }
  });
});

describe("the compose recipe", () => {
  const compose = read("deploy/compose/compose.distributed.yml");
  const [preamble, body] = [
    compose.slice(0, compose.indexOf("\nservices:\n")),
    compose.slice(compose.indexOf("\nservices:\n")).split("\nvolumes:\n")[0]!,
  ];
  const serviceNames = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
  const hardeningOf = (name: string) => {
    const start = body.indexOf(`\n  ${name}:\n`);
    const next = serviceNames
      .map((other) => body.indexOf(`\n  ${other}:\n`))
      .filter((at) => at > start);
    const block = body.slice(start, next.length ? Math.min(...next) : undefined);
    // A service either says it itself or merges the anchor that says it.
    const text = block.includes("<<: *hardening") ? block + preamble : block;
    return {
      dropsCapabilities: text.includes("cap_drop: [ALL]"),
      cannotGainPrivileges: text.includes('security_opt: ["no-new-privileges:true"]'),
    };
  };

  it("hardens every Simple Balance service the same way", () => {
    for (const name of ["server", "frontend", "scheduler"]) {
      expect(hardeningOf(name), name).toEqual({
        dropsCapabilities: true,
        cannotGainPrivileges: true,
      });
    }
  });

  it("leaves the bundled database its capabilities, because its entrypoint needs them", () => {
    // postgres starts as root, chowns its data directory and drops to the
    // postgres user. Dropping CAP_CHOWN and friends breaks the one-command
    // trial the service exists for, so it gets the half that costs nothing.
    expect(hardeningOf("postgres")).toEqual({
      dropsCapabilities: false,
      cannotGainPrivileges: true,
    });
  });
});

/**
 * Every readiness check against PostgreSQL, wherever it is written.
 *
 * `docs/standards/operations.md` §Health checks has the reasoning: the official
 * image runs a temporary server while it executes its initdb scripts, and that
 * one listens on the unix socket alone. A `pg_isready` with no `-h` answers
 * against that server, reports healthy, and is replaced moments later — so
 * whatever was waiting connects to `FATAL: the database system is shutting
 * down`.
 *
 * This walks the repository rather than checking a list of files, because a list
 * is exactly what was wrong: one recipe had carried `-h 127.0.0.1` with the
 * reason beside it for a release while four other places — the dev database, the
 * `vps` profile's own compose file, ralph's sandbox and both CI service
 * containers — were still checking the socket. Nobody had copied the reasoning
 * across, and nothing could have noticed.
 */
describe("waiting for PostgreSQL", () => {
  it("goes over TCP everywhere, never over the unix socket", () => {
    const offenders: string[] = [];
    // Discovered, not listed. `tests/support/source.ts` has the argument; the
    // short version is that the first version of this check carried a list and
    // missed four of the five places that wait for PostgreSQL.
    for (const { path: file, text } of repoFiles(() => true)) {
      if (!text.includes("pg_isready")) continue;
      if (file.endsWith("deployment-docs.test.ts")) continue;
      const markdown = file.endsWith(".md");
      let fenced = false;
      for (const [index, line] of text.split("\n").entries()) {
        // In a document, prose *about* the command is not a command. What is, is
        // anything inside a fence — an operator copies those, and the upgrade
        // note's own procedure told them to wait on the socket for a release.
        if (markdown && line.trimStart().startsWith("```")) {
          fenced = !fenced;
          continue;
        }
        if (!line.includes("pg_isready")) continue;
        if (markdown && !fenced) continue;
        if (/pg_isready[^\n]*-h\s/.test(line)) continue;
        offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Every Simple Balance container in every compose file, hardened the same way.
 *
 * The block above this one checks `compose.distributed.yml` by name, which was
 * the whole population when it was written and is now one file of ten. This
 * release added five — the `vps` profile's four and the capacity harness — and
 * nothing looked at any of them; the harness turned out to be running the
 * application image with no `cap_drop` and no `no-new-privileges` at all, which
 * makes a measurement taken against a container configured unlike the
 * deployment.
 *
 * The population is every service whose image is a Simple Balance one. That is
 * the right boundary rather than "every service": `postgres` and `caddy` are
 * somebody else's images with their own needs, and the one exception among them
 * is argued where it lives — PostgreSQL's entrypoint starts as root, chowns its
 * data directory and drops privileges, so it keeps the capabilities it needs and
 * takes the half that costs nothing.
 */
describe("hardening, across every compose file", () => {
  /** Services are the keys under `services:` and above `volumes:`/`networks:`. */
  const servicesOf = (text: string) => {
    const start = text.indexOf("\nservices:\n");
    if (start < 0) return [];
    let body = text.slice(start);
    for (const end of ["\nvolumes:\n", "\nnetworks:\n", "\nsecrets:\n"]) {
      const at = body.indexOf(end);
      if (at > 0) body = body.slice(0, at);
    }
    const names = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
    return names.map((name) => {
      const at = body.indexOf(`\n  ${name}:\n`);
      const nexts = names.map((other) => body.indexOf(`\n  ${other}:\n`)).filter((x) => x > at);
      let block = body.slice(at, nexts.length ? Math.min(...nexts) : undefined);
      // A service either states it or merges an anchor that does.
      if (block.includes("<<: *hardening")) block += text.slice(0, start);
      // Comments explain hardening as often as they apply it — one compose file
      // says "No cap_drop here, and this is the exception rather than an
      // oversight" — so a check that read them would pass on the explanation.
      const code = block
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      return { name, code };
    });
  };

  const composeFiles = repoFiles((file) => /(^|\/)compose[a-z.]*\.ya?ml$/.test(file));

  it("finds every compose file in the tree", () => {
    // Without this the regex could stop matching and every assertion below would
    // pass over an empty population, which is the failure a list makes slowly.
    expect(composeFiles.length).toBeGreaterThanOrEqual(8);
    expect(composeFiles.map((file) => file.path)).toContain("deploy/compose/vps/compose.app.yml");
  });

  it("drops every capability from every Simple Balance service", () => {
    const unhardened: string[] = [];
    for (const file of composeFiles) {
      for (const service of servicesOf(file.text)) {
        if (!/image:\s*\S*simple-balance/.test(service.code)) continue;
        const dropped = service.code.includes("cap_drop: [ALL]");
        const noPrivileges = service.code.includes("no-new-privileges");
        if (!dropped || !noPrivileges) {
          unhardened.push(
            `${file.path} ${service.name}${dropped ? "" : " (cap_drop)"}${noPrivileges ? "" : " (no-new-privileges)"}`,
          );
        }
      }
    }
    expect(unhardened).toEqual([]);
  });
});
