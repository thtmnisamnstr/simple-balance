import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Who a setting's name belongs to.
 *
 * `docs/standards/operations.md` §Configuration → Naming decides it: a name a
 * platform already defines by convention stays unprefixed, a credential or an
 * identifier belonging to somebody else's product keeps that product's own
 * spelling, and everything this product invents is prefixed `SB_`. The existing
 * unprefixed inventions are frozen because renaming them would break every
 * operator, and the rule applies to new ones.
 *
 * That section says the rule is *not checked mechanically*, "for the same
 * reason the rule above is not: a grep would have to know which names belong to
 * a vendor". True of a grep, and the gap it leaves is what this file closes —
 * the grep does not have to know, because the lists below do, and a name on
 * none of them fails by name. The cost is that somebody extends a list on
 * purpose and writes down which case they are claiming. That is the point: this
 * release invented nine unprefixed names and the guide's open question named
 * three of them, so six would have frozen unexamined.
 *
 * Reasons keyed by name rather than bare arrays, because a bare array of
 * exceptions is one nobody can audit a year later.
 */

const root = new URL("../", import.meta.url).pathname;
const read = (path: string) => readFileSync(root + path, "utf8");

/**
 * The four example files §`.env.example` governs. The three under
 * `deploy/compose` are discovered, so a new recipe's file is covered the day it
 * is added; the root file is named because it sits outside that tree.
 */
const exampleFiles = [
  ...globSync("deploy/compose/**/.env*.example", { cwd: root }),
  ".env.example",
].sort();

/**
 * Every compose file and Caddyfile under `deploy/compose`. Six of the names
 * this check was written for never reach an example file: `ACME_EMAIL_OPTION`
 * exists only in `compose.caddy.yml` and the `Caddyfile`, so a scan of the
 * example files alone reports the profile clean.
 *
 * `deploy/helm` and `deploy/docker` are outside, and not by oversight. The
 * chart invents no application setting — its ConfigMap takes whatever keys the
 * operator's values supply — and the names its templates do spell are Patroni's
 * and libpq's, which no reader of this file would be deciding about.
 */
const recipeFiles = [
  ...globSync("deploy/compose/**/*.yml", { cwd: root }),
  ...globSync("deploy/compose/**/Caddyfile", { cwd: root }),
].sort();

const configFiles = globSync("src/server/config*.ts", { cwd: root }).sort();

/** Where each name was found, so a failure names a file to open. */
const found = new Map<string, Set<string>>();
const record = (name: string, where: string) => {
  const places = found.get(name) ?? new Set<string>();
  places.add(where);
  found.set(name, places);
};

for (const file of exampleFiles) {
  // A commented-out variable is a setting the file offers, so the leading `#`
  // is part of the convention rather than something to skip past.
  for (const line of read(file).split("\n")) {
    const name = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (name) record(name, file);
  }
}

for (const file of recipeFiles) {
  // Whole-line comments go first. These files explain themselves at length, and
  // a paragraph naming `${VAR:-...}` as a shape would otherwise arrive here as
  // a variable called VAR.
  const text = read(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) record(match[1]!, file);
  for (const match of text.matchAll(/\{\$([A-Z][A-Z0-9_]*)\}/g)) record(match[1]!, file);
  // An `environment:` entry set to a literal is a name too: NODE_ENV and PORT
  // reach a container without any example file mentioning them.
  for (const match of text.matchAll(/^[ \t]+([A-Z][A-Z0-9_]*):[ \t]/gm)) record(match[1]!, file);
}

for (const file of configFiles) {
  // Comment lines go first here too, and for a reason the compose files do not
  // have: this layer is commented at length about the names it reads, so a
  // sentence about `DATABASE_URL_FILE` or about `ORDER` in log.ts arrives as a
  // setting somebody then has to account for. Whole lines only — a string in
  // this file may hold a URL, and cutting at `//` would take real code with it.
  const text = read(file)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) record(match[1]!, file);
  for (const match of text.matchAll(/process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)/g)) {
    record(match[1]!, file);
  }
  // `config-files.ts` lists its nine `_FILE`-backed secrets and reaches
  // `process.env` through a variable, so the two patterns above find nothing in
  // it at all. Every screaming-case literal in the configuration layer is a
  // variable name, and one that is not would be cheaper to exempt here than a
  // secret would be to miss.
  for (const match of text.matchAll(/["'`]([A-Z][A-Z0-9_]+)["'`]/g)) record(match[1]!, file);
}

/** §Naming: "Names a platform already defines by convention stay unprefixed." */
const platformConventions: Record<string, string> = {
  NODE_ENV: "Node's own, and the images set it",
  PORT: "the convention every container platform listens for",
  DATABASE_URL: "the twelve-factor spelling",
  LOG_LEVEL: "generic enough that a sidecar or a base image may set it",
};

/**
 * §Naming's third category. The test is ownership, not familiarity: an operator
 * meets `STRIPE_SECRET_KEY` in Stripe's own documentation and in every other
 * application they have wired to Stripe, so `SB_STRIPE_SECRET_KEY` would make
 * this the one place it is written differently.
 */
const vendorSpellings: Record<string, string> = {
  GOOGLE_CLIENT_ID: "Google's",
  GOOGLE_CLIENT_SECRET: "Google's",
  STRIPE_SECRET_KEY: "Stripe's",
  STRIPE_PUBLISHABLE_KEY: "Stripe's",
  STRIPE_WEBHOOK_SECRET: "Stripe's",
  STRIPE_PRICE_MONTHLY_ID: "Stripe's: the id names a price in their account",
  STRIPE_PRICE_YEARLY_ID: "Stripe's: the id names a price in their account",
  ADSENSE_CLIENT_ID: "Google's: the ca-pub- id is issued by AdSense",
  ADSENSE_BANNER_SLOT_ID: "Google's: the slot is created in AdSense",
  ADSENSE_FOOTER_SLOT_ID: "Google's: the slot is created in AdSense",
  POSTGRES_DB: "the postgres image's own entrypoint variable",
  POSTGRES_USER: "the postgres image's own entrypoint variable",
  POSTGRES_PASSWORD: "the postgres image's own entrypoint variable",
};

/**
 * §Naming: "The existing unprefixed names are frozen, and the rule applies to
 * new ones." Frozen means released — each of these was readable in the tree at
 * v0.1.6, so a deployment already sets it and renaming it breaks that
 * deployment.
 *
 * Nothing may join this list, or the 0.2.0 one below it.
 */
const frozenIn01x: Record<string, string> = {
  ALLOWED_EMAILS: "released in 0.1.x",
  APP_BASE_URL: "released in 0.1.x",
  AUTH_MODE: "released in 0.1.x, and generic enough to collide with a sidecar",
  AUTH_SECRET: "released in 0.1.x",
  CSV_MAX_BYTES: "released in 0.1.x",
  CSV_MAX_ROWS: "released in 0.1.x",
  DATABASE_POOL_SIZE: "released in 0.1.x",
  DIRECT_DATABASE_URL: "released in 0.1.x, a sibling of DATABASE_URL and spelled like one",
  IDEMPOTENCY_RETENTION_HOURS: "released in 0.1.x",
  MAIL_FROM: "released in 0.1.x",
  MAIL_REPLY_TO: "released in 0.1.x",
  METRICS_ENABLED: "released in 0.1.x",
  METRICS_TOKEN: "released in 0.1.x",
  RECURRENCE_CATCH_UP_LIMIT: "released in 0.1.x",
  RECURRENCE_CLAIM_LIMIT: "released in 0.1.x",
  RECURRENCE_SCHEDULER: "released in 0.1.x",
  RECURRENCE_TICK_SECONDS: "released in 0.1.x",
  SETUP_TOKEN: "released in 0.1.x",
  SMTP_HOST: "released in 0.1.x",
  SMTP_PASSWORD: "released in 0.1.x",
  SMTP_PORT: "released in 0.1.x",
  SMTP_SSL: "released in 0.1.x",
  SMTP_USERNAME: "released in 0.1.x",
  TRUST_PROXY: "released in 0.1.x, and generic enough to collide with a sidecar",
};

/**
 * §Naming: frozen in 0.2.0, by the release shipping them.
 *
 * Every name here is this product's own invention, unprefixed, and released in
 * 0.2.0. Before the cut they were held here as an open question, due before
 * 0.2.0 shipped, in two lists — ten "open" and nine "arguable" — and the
 * release answered it by shipping all nineteen as they were. A rename is now a
 * deprecation that accepts both spellings for a release, not an edit, so this
 * is a record of what froze and why each is as it is.
 *
 * Nothing may join it. A name invented from 0.2.1 on is prefixed `SB_`, and a
 * name that arrives here without one is the defect this file exists to catch.
 *
 * The `POSTGRES_*` entries are the ones invented inside PostgreSQL's
 * namespace. The six tuning names are the mild end: `compose.postgres.yml`
 * interpolates them into `-c` flags, so the variables are ours while the
 * settings inside them are PostgreSQL's own. `POSTGRES_APP_PASSWORD` is the
 * sharp end — PostgreSQL has no `app_password`, so only the prefix is
 * borrowed. `POSTGRES_IMAGE` and `POSTGRES_DATA_MOUNT` name which PostgreSQL
 * container `compose.distributed.yml` runs and where its volume is mounted,
 * and `deploy/docker/citus.Dockerfile` already carries `ARG POSTGRES_IMAGE`
 * for the same choice.
 */
const frozenIn020: Record<string, string> = {
  PRIVACY_POLICY_URL: "arrived with the ads work; §Naming records the question it was",
  TERMS_OF_USE_URL: "arrived beside the policy, and is set with it",
  SITE_ADDRESS:
    "no Caddy convention names it, the Caddyfile in this " +
    "repository is what spells it, and the machine beside it already says " +
    "SB_BIND_ADDRESS for an address of its own",
  ACME_EMAIL:
    "ours: no ACME or Caddy specification names it, and Caddy reads whatever " +
    "{$NAME} the Caddyfile here spells. It fails quietly — compose.caddy.yml " +
    "renders the directive with ${ACME_EMAIL:+...}, so a prefixed spelling " +
    "typed by analogy with a renamed neighbour buys an anonymous ACME account " +
    "and says nothing about it",
  ACME_EMAIL_OPTION:
    "ours, and derived rather than set: compose.caddy.yml builds the whole " +
    "directive the way the split recipe derives SB_BILLING_CONFIGURED from a " +
    "key being present, and that sibling is prefixed",
  MAX_BODY_SIZE:
    "ours: the ceiling nginx carries as the prefixed SB_MAX_UPLOAD_SIZE, to the " +
    "byte. ${MAX_BODY_SIZE:-61MiB}, so a misspelling is the default ceiling " +
    "with no word about it",
  APP_BIND_ADDRESS:
    "ours, and the sharpest of the set: §Naming settles SITE_ADDRESS by arguing " +
    "that one profile spells two addresses it owns two different ways on two " +
    "machines set up in one sitting. There are three, and the third is on the " +
    "same machine as the first",
  APP_PORT: "ours: where compose.yml publishes the application on the host",
  CADDY_IMAGE: "ours: no Caddy convention names it, compose.caddy.yml interpolates it",
  ADSENSE_CONSENT_MANAGED:
    "ours, inside a vendor's namespace by familiarity rather than by ownership. " +
    "Google issues the ca-pub- id and the slot ids; whether this deployment " +
    "asserts it has a certified consent platform is a question only this " +
    "product asks — which is §Naming's own argument for prefixing " +
    "SB_BILLING_ENABLED while leaving STRIPE_SECRET_KEY alone",
  POSTGRES_APP_PASSWORD: "db-init.sh's, not the image's — nothing in src/ or in postgres reads it",
  POSTGRES_SHARED_BUFFERS: "ours around PostgreSQL's shared_buffers",
  POSTGRES_EFFECTIVE_CACHE_SIZE: "ours around PostgreSQL's effective_cache_size",
  POSTGRES_WORK_MEM: "ours around PostgreSQL's work_mem",
  POSTGRES_MAINTENANCE_WORK_MEM: "ours around PostgreSQL's maintenance_work_mem",
  POSTGRES_MAX_WAL_SIZE: "ours around PostgreSQL's max_wal_size",
  POSTGRES_MAX_CONNECTIONS: "ours around PostgreSQL's max_connections",
  POSTGRES_IMAGE:
    "ours, and already this repository's spelling for the same choice in " +
    "deploy/docker/citus.Dockerfile's ARG — which PostgreSQL container a " +
    "recipe runs, rather than anything the container itself reads",
  POSTGRES_DATA_MOUNT:
    "ours, and the other half of that choice: 16 keeps PGDATA at " +
    "/var/lib/postgresql/data and 18 moved it into a versioned subdirectory, " +
    "so the image and the mount path travel together",
};

const accounted: Record<string, string> = {
  ...platformConventions,
  ...vendorSpellings,
  ...frozenIn01x,
  ...frozenIn020,
};

const whereFor = (name: string) => [...(found.get(name) ?? [])].sort().join(", ");

describe("the scan this check rests on", () => {
  it("reads all four example files", () => {
    expect(exampleFiles).toEqual([
      ".env.example",
      "deploy/compose/.env.example",
      "deploy/compose/single/.env.example",
      "deploy/compose/single/.env.postgres.example",
    ]);
  });

  /**
   * A check that can only ever report zero has passed nothing. Each source is
   * proved by a name only that source carries, so an extractor that stops
   * matching fails here rather than reporting the tree clean.
   */
  it("finds a name in each kind of file it reads", () => {
    expect(whereFor("CADDY_IMAGE")).toContain("deploy/compose/single/.env.example");
    expect(whereFor("ACME_EMAIL_OPTION")).toContain("deploy/compose/single/compose.caddy.yml");
    expect(whereFor("ACME_EMAIL_OPTION")).toContain("deploy/compose/single/Caddyfile");
    expect(whereFor("GOOGLE_CLIENT_SECRET")).toContain("src/server/config-files.ts");
  });

  it("finds enough names to be reading the tree rather than a fragment", () => {
    expect(found.size).toBeGreaterThan(60);
  });

  it("reads a shape as a shape rather than as a setting", () => {
    // compose.postgres.yml explains itself with "`${VAR:-...}`" in a comment,
    // and a scan that counted it would hold a name nobody can look up.
    expect(found.has("VAR")).toBe(false);
  });
});

describe("who a setting's name belongs to", () => {
  it("prefixes every name this product invented, or accounts for it by name", () => {
    const unaccounted = [...found.keys()]
      .filter((name) => !name.startsWith("SB_"))
      .filter((name) => !(name in accounted))
      .sort()
      .map((name) => `${name} (${whereFor(name)})`);
    expect(
      unaccounted,
      "operations.md §Configuration → Naming: an unprefixed name is a platform " +
        "convention, a vendor's spelling, or frozen by having been released. A " +
        "new name this product invented is prefixed SB_, and neither frozen " +
        "register takes a new entry",
    ).toEqual([]);
  });

  it("keeps no exception for a name the tree no longer has", () => {
    const stale = Object.keys(accounted)
      .filter((name) => !found.has(name))
      .sort();
    expect(stale, "an exception outliving its variable is a grant nobody is reading").toEqual([]);
  });

  it("freezes exactly what 0.2.0 shipped, and nothing since", () => {
    // Pinned by membership, so a name added here — an exception a change
    // writes for itself — fails rather than freezing quietly.
    expect(Object.keys(frozenIn020).sort()).toEqual([
      "ACME_EMAIL",
      "ACME_EMAIL_OPTION",
      "ADSENSE_CONSENT_MANAGED",
      "APP_BIND_ADDRESS",
      "APP_PORT",
      "CADDY_IMAGE",
      "MAX_BODY_SIZE",
      "POSTGRES_APP_PASSWORD",
      "POSTGRES_DATA_MOUNT",
      "POSTGRES_EFFECTIVE_CACHE_SIZE",
      "POSTGRES_IMAGE",
      "POSTGRES_MAINTENANCE_WORK_MEM",
      "POSTGRES_MAX_CONNECTIONS",
      "POSTGRES_MAX_WAL_SIZE",
      "POSTGRES_SHARED_BUFFERS",
      "POSTGRES_WORK_MEM",
      "PRIVACY_POLICY_URL",
      "SITE_ADDRESS",
      "TERMS_OF_USE_URL",
    ]);
  });
});
