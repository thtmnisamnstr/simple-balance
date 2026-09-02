import { readFileSync } from "node:fs";
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
