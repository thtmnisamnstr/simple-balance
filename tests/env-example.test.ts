import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The two example files an operator copies, and the two rules that keep them
 * readable as instructions rather than as inventories.
 *
 * Optional variables are commented out, so uncommenting a line is the act that
 * turns a setting on and an operator can see at a glance what they have
 * changed. Only the secrets are present and empty, because a secret has no
 * example value that is not a hazard. The compose file shipped nine optional
 * variables present and empty, which reads as nine settings already in force.
 */
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
