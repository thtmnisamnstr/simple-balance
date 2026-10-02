import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Which PostgreSQL `compose.distributed.yml` runs by default, and where it
 * mounts the volume that holds it.
 *
 * A release upgrades cleanly from the one before it, and this is the one recipe
 * in the repository that ships a `postgres` service — so it is the one an
 * operator pulls onto a `postgres-data` volume that already exists. A
 * PostgreSQL container cannot read the previous major version's data directory,
 * and 18's image moved `PGDATA` into a versioned subdirectory, so moving either
 * of these two defaults stops the database. Behind `restart: unless-stopped`
 * and the `service_healthy` gate the server, frontend and scheduler all wait
 * on, that is not a refusal anybody reads: it is a restart loop with the whole
 * recipe down behind it.
 *
 * It was measured rather than argued. A volume initialised by
 * `postgres:16-alpine` at the old path, then mounted at the new one under
 * `postgres:18`, exits 1 and loops on `mkdir: cannot create directory
 * '/var/lib/postgresql': Permission denied` — the Alpine data directory belongs
 * to uid 70 and Debian's `postgres` is 999, so the entrypoint's own explanatory
 * PGDATA check is never reached.
 *
 * So both defaults are 0.1.6's, and 18 is an opt-in through two variables.
 * `docs/standards/writing.md` §Versioning is the rule, and its own sentence is
 * why a note in `docs/upgrades.md` was not enough: a documented break is one
 * somebody reads about after the container will not come up. The defaults move
 * in a later release, once the deprecation has been in the field, which is the
 * shape that file prescribes for a renamed route.
 *
 * Read as text, following the one layout these files share, because no YAML
 * parser is among this repository's dependencies — the decision
 * `tests/env-example.test.ts` documents.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const COMPOSE = "deploy/compose/compose.distributed.yml";
const compose = read(COMPOSE);

/** The lines of the `postgres:` service, which is the first two-space key. */
const postgresService = (() => {
  const lines = compose.split("\n");
  const at = lines.findIndex((line) => line === "  postgres:");
  expect(at, `${COMPOSE} has no postgres service`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    body.push(line);
  }
  return body.join("\n");
})();

/** A setting as written, comments and blank lines skipped. */
const settingIn = (service: string, key: string) =>
  new RegExp(`^ +${key}: (.+)$`, "m").exec(service)?.[1];

/** The volume entries, which are the `- ` lines under `volumes:`. */
const volumesIn = (service: string) => {
  const lines = service.split("\n");
  const at = lines.findIndex((line) => /^ +volumes:\s*$/.test(line));
  if (at === -1) return [];
  const indent = lines[at]!.length - lines[at]!.trimStart().length;
  const found: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.length - line.trimStart().length <= indent) break;
    found.push(line.trim().replace(/^- /, ""));
  }
  return found;
};

describe("the PostgreSQL compose.distributed.yml runs by default", () => {
  it("is still the image 0.1.6 ran, as the default of an opt-in variable", () => {
    expect(settingIn(postgresService, "image")).toBe("${POSTGRES_IMAGE:-postgres:16-alpine}");
  });

  it("still mounts postgres-data where 0.1.6 mounted it", () => {
    expect(volumesIn(postgresService)).toEqual([
      "postgres-data:${POSTGRES_DATA_MOUNT:-/var/lib/postgresql/data}",
    ]);
  });

  it("offers both halves of the opt-in, since neither is any use alone", () => {
    // The new image against the old path loops on a permission error; the old
    // image against the new path quietly initialises a second, empty cluster
    // beside data it then never reads. An example file that showed one would
    // be an invitation to the second failure.
    const example = read("deploy/compose/.env.example");

    for (const name of ["POSTGRES_IMAGE=postgres:18", "POSTGRES_DATA_MOUNT=/var/lib/postgresql"])
      expect(example, `deploy/compose/.env.example does not offer ${name}`).toContain(name);
  });

  it("tells an operator in the file where the procedure is", () => {
    // Here as well as in docs/upgrades.md, because here is where somebody
    // looking at the database service will be.
    expect(postgresService).toContain("POSTGRES_IMAGE=postgres:18");
    expect(postgresService).toContain("POSTGRES_DATA_MOUNT=/var/lib/postgresql");
    expect(postgresService).toContain("docs/upgrades.md");
  });
});

describe("what docs/upgrades.md says about it", () => {
  const upgrades = read("docs/upgrades.md");

  it("carries the procedure under a heading the other files cite", () => {
    expect(upgrades).toContain("#### Moving the bundled database to PostgreSQL 18");
  });

  it("does not describe the move as something to do before pulling", () => {
    // The sentence this replaced told an operator to move the database "before
    // you pull", which is only true while the default moves with the release.
    expect(upgrades).not.toMatch(/move its database to\s+PostgreSQL 18 before you pull/);
  });

  it("does not promise an explanatory refusal that the images do not give", () => {
    // It claimed starting 18 "fails immediately with a message naming both
    // facts, which is the good failure". The measured failure names neither.
    expect(upgrades).not.toContain("fails immediately with a message naming both facts");
  });
});
