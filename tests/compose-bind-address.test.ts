import { describe, expect, it } from "vitest";
import { repoFiles } from "./support/source.js";

/**
 * Which address every published port in `deploy/compose/` binds to.
 *
 * A Compose `ports:` entry with no address publishes to `0.0.0.0`, and on Linux
 * Docker writes its own DNAT rules ahead of the host firewall — so a mapping
 * that forgot its address is reachable from the network whatever `ufw` or
 * `iptables` were told. That is the single line between "PostgreSQL listens on
 * this machine's private address" and "the ledger is on the internet", and
 * until this file nothing in the repository read those lines at all.
 *
 * The rule is not "everything is loopback", because something has to serve the
 * site. It is that every mapping falls into one of three named shapes, and the
 * third is a short list with a reason per entry:
 *
 *   - loopback, literally `127.0.0.1`;
 *   - an address the operator must supply, `${SB_...:?}` — a mapping that
 *     refuses to start rather than defaulting to everything;
 *   - a port the deployment's firewall tables genuinely open to the internet.
 *
 * Read as text, following the one layout these files share, because no YAML
 * parser is among this repository's dependencies — the same decision
 * `tests/env-example.test.ts` documents.
 */

const composeFiles = repoFiles(
  (path) => path.startsWith("deploy/compose/") && /\.ya?ml$/.test(path),
);

/** The indentation of a line, for finding the block a key belongs to. */
const indentOf = (line: string) => line.length - line.trimStart().length;

type Mapping = {
  /** `deploy/compose/single/compose.yml caddy`, for a failure that names the service. */
  readonly at: string;
  /** The entry as written, quotes and all. */
  readonly entry: string;
};

/**
 * Every `ports:` entry in every compose file, paired with the service it is on.
 *
 * The service is the nearest two-space key above the entry, which is the layout
 * every file here uses. A `ports:` block that appeared anywhere else would come
 * back with an empty service name rather than being skipped, so it fails the
 * assertions below instead of passing by being invisible.
 */
const mappings: Mapping[] = composeFiles.flatMap(({ path, text }) => {
  const lines = text.split("\n");
  const found: Mapping[] = [];
  let service = "";
  lines.forEach((line, at) => {
    const name = / {2}([\w-]+):\s*$/.exec(line);
    if (name !== null && indentOf(line) === 2) service = name[1]!;
    if (!/^ +ports:\s*$/.test(line)) return;
    for (const entry of lines.slice(at + 1)) {
      if (entry.trim() === "" || entry.trimStart().startsWith("#")) continue;
      if (indentOf(entry) <= indentOf(line)) break;
      const value = /^\s*- (.*)$/.exec(entry);
      // A `ports:` list written long-form (`- target: 5432`) would land here.
      // Failing is right: this check cannot read it, and a mapping it cannot
      // read is a mapping it is not checking.
      expect(value, `${path} ${service}: a ports entry this test cannot read: ${entry}`).not.toBe(
        null,
      );
      found.push({ at: `${path} ${service}`, entry: value![1]!.replace(/^"|"$/g, "") });
    }
  });
  return found;
});

/**
 * The mappings that are deliberately published to everything, each with the
 * reason it has to be.
 *
 * Keyed by service and entry together, so opening a *second* port on a service
 * that already has one open is a failure rather than something the key covers.
 * Both entries are Caddy's, and Caddy is the only process in either profile
 * that the internet is supposed to reach: `docs/deployment-profiles.md`'s
 * firewall table opens 80 and 443 on the application machine and nothing else,
 * and the two cloud programs open exactly those.
 */
const DELIBERATELY_PUBLIC: Record<string, string> = {
  'deploy/compose/single/compose.caddy.yml caddy "80:80"':
    "the HTTPS redirect and the ACME HTTP-01 challenge, which Let's Encrypt has to reach from anywhere",
  'deploy/compose/single/compose.caddy.yml caddy "443:443"':
    "the site; this is the browser's only way in, and the machine is the edge because there is no load balancer in this profile",
  'deploy/compose/single/compose.caddy.yml caddy "443:443/udp"':
    "HTTP/3, opened to match 443/tcp rather than leaving a silent fall back to TCP",
};

describe("which address a published port binds to", () => {
  it("finds the mappings it is checking, in every file that has one", () => {
    // Without a floor a layout change that stopped matching would empty the
    // list and every assertion below would agree about nothing.
    expect(mappings.length).toBeGreaterThanOrEqual(6);
    expect(new Set(mappings.map((mapping) => mapping.at.split(" ")[0]))).toEqual(
      new Set([
        "deploy/compose/compose.distributed.yml",
        "deploy/compose/single/compose.yml",
        "deploy/compose/single/compose.caddy.yml",
        "deploy/compose/single/compose.postgres.yml",
      ]),
    );
  });

  it("binds every mapping to loopback, to a required address, or to a named public port", () => {
    const unaccounted = mappings.filter(({ at, entry }) => {
      const key = `${at} "${entry}"`;
      if (key in DELIBERATELY_PUBLIC) return false;
      // `127.0.0.1:8080:8080`, and `${APP_BIND_ADDRESS:-127.0.0.1}:3000:3000` —
      // a default that is loopback, so an unset variable is still loopback.
      if (/^(?:\$\{[A-Z][A-Z0-9_]*:-127\.0\.0\.1\}|127\.0\.0\.1):/.test(entry)) return false;
      // `${SB_BIND_ADDRESS:?...}:5432:5432`. The `:?` is the whole point: with
      // `:-` an unset variable would publish to every interface, which is the
      // exact mistake this check exists for.
      if (/^\$\{SB_[A-Z0-9_]*:\?[^}]*\}:/.test(entry)) return false;
      return true;
    });

    expect(unaccounted.map(({ at, entry }) => `${at} "${entry}"`)).toEqual([]);
  });

  it("keeps its public list genuinely public, and genuinely a list", () => {
    // An exception list that has drifted proves nothing: every entry still has
    // to name a mapping that is really there, and still be a mapping with no
    // address on it. One that acquired an address should leave this list.
    const keys = new Set(mappings.map(({ at, entry }) => `${at} "${entry}"`));
    for (const [key, reason] of Object.entries(DELIBERATELY_PUBLIC)) {
      expect(keys, `${key} is no longer published at all`).toContain(key);
      expect(reason.length, key).toBeGreaterThan(20);
      expect(/"(?:\d+):/.test(key), `${key} names an address after all`).toBe(true);
    }
    // And the database is never on it, whatever else is. This is the assertion
    // the file is for: PostgreSQL published to everything is the ledger on the
    // internet, and it is one deleted variable away at any time.
    for (const key of Object.keys(DELIBERATELY_PUBLIC)) expect(key).not.toContain(":5432");
  });

  it("publishes the database on a required private address and on one port", () => {
    const database = mappings.filter(({ at }) => at.endsWith("compose.postgres.yml postgres"));

    expect(database.map(({ entry }) => entry)).toEqual([
      "${SB_BIND_ADDRESS:?set SB_BIND_ADDRESS to this machine's private IP}:5432:5432",
    ]);
  });
});
