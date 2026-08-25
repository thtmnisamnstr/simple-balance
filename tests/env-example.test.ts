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
 * The nginx container's own three. Neither example file configures it: the root
 * file serves the single container, which contains no nginx, and the compose
 * file sets them on the frontend service beside the reason each is what it is.
 * `docs/deployment.md` says so where they are documented, which is what makes
 * this an exception rather than the drift above.
 */
const frontendImageOnly = ["SB_API_ORIGIN", "SB_FRONTEND_PORT", "SB_MAX_UPLOAD_SIZE"];
/**
 * The bundled `postgres:16-alpine` container's own variable, documented at
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
