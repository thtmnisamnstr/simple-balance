import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as csv from "../src/shared/csv.js";
import * as domain from "../src/shared/domain.js";
import { idempotencyKeySchema } from "../src/shared/domain.js";
import { sourceFiles, topLevelDeclarations, type SourceFile } from "./support/source.js";

/**
 * Two rules `http.md` lists under *What is checked* as not being, and both are
 * Binding from `AGENTS.md`: "Updates/deletes require an expected version.
 * Commits, and creates that write postings, require idempotency."
 *
 * Both are held today by tests of particular routes. A new route is not one of
 * those routes, which is the whole failure mode: the rule reads "every" and the
 * check reads "these".
 *
 * The routes come from `src/server/api.ts`, which is where a route is true, and
 * the schema each one parses is followed through to `src/shared/domain.ts`: a
 * handler rarely parses anything itself, it hands the body to a service and the
 * service parses. Then the schema is converted the way the MCP surface converts
 * it and read for the field, so a schema built by `.extend` or `.strict` is
 * read as what it accepts rather than as what its source text spells.
 *
 * **This may never force a required field onto a route that shipped without
 * one.** A deployment on the previous release has clients that do not send it,
 * and `AGENTS.md` forbids a release from narrowing what a client could do. So
 * the register below is how a route without one is recorded, and an entry is
 * an argument rather than a silence.
 */
describe("every mutating route", () => {
  const api = sourceFiles("src/server").find((file) => file.path === "src/server/api.ts");
  if (!api) throw new Error("src/server/api.ts has moved");
  /**
   * The handlers `api.ts` names before registering them, which the shared
   * declaration splitter cannot see.
   *
   * It splits on `const name =`, and these are written `const archiveAccount:
   * Handler<AppEnv> = …` — a type annotation between the name and the `=`. So
   * three of the routes carrying an expected version had their bodies folded
   * into whatever declaration came before them, and the route that named one
   * resolved to nothing. Sliced to the `app.` that registers it, which is
   * always the next thing in this file.
   */
  const namedHandlers = [...api.code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*:\s*Handler\b/g)].map(
    (hit) => {
      const rest = api.code.slice(hit.index);
      const until = rest.indexOf("\napp.");
      return {
        name: hit[1]!,
        exported: false,
        line: 0,
        body: until < 0 ? rest : rest.slice(0, until),
        file: api.path,
      };
    },
  );
  const declarations = [
    ...[...sourceFiles("src/server/services"), api].flatMap((file: SourceFile) =>
      topLevelDeclarations(file).map((declaration) => ({ ...declaration, file: file.path })),
    ),
    ...namedHandlers,
  ];
  const callsIn = (body: string) =>
    [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((hit) => hit[1]!);
  /**
   * Every name a route's handler mentions, not only the ones it calls.
   *
   * Three routes register a handler by passing it — `app.post(path,
   * archiveAccount)` — so a reader that matched `name(` saw no handler at all
   * and reported the route as asking for nothing. It is the shape that carries
   * the most versions in the file, which is the worst place to have a blind
   * spot.
   */
  const namesIn = (body: string) =>
    [...body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((hit) => hit[1]!);

  /**
   * The schemas a route parses, found at the shallowest depth that has any.
   *
   * A full transitive closure cannot be used and the reason is that it cannot
   * fail: `commitStagedTransactions` reaches `createTransaction`, so the commit
   * route inherited the create's idempotency key and the check went on passing
   * with the commit's own key renamed away. So the search stops at the first
   * hop that parses anything — the handler's own text, then what it names, then
   * what those name — which is where a reader looking for "what does this route
   * accept" would also stop.
   */
  const parsedBy = (body: string) =>
    new Set(
      // The parse may not follow the name directly: `versionedMutationSchema
      // .extend({ archived }).parse(…)` is how both archive routes read their
      // body, and a pattern anchored to the name saw no schema at all. Held to
      // one statement, so it cannot reach across a line and attribute a
      // neighbour's schema to this one.
      [...body.matchAll(/\b(\w+Schema)\b[^;\n]*\.\s*(?:safeParse|parse)\s*\(/g)].map(
        (hit) => hit[1]!,
      ),
    );

  const requestSchemas = (handler: string) => {
    const seen = new Set<string>();
    let frontier = namesIn(handler);
    const named = new Set<string>([...handler.matchAll(/\b(\w+Schema)\b/g)].map((it) => it[1]!));
    for (let depth = 0; depth < 4 && named.size === 0; depth += 1) {
      const next: string[] = [];
      for (const name of frontier) {
        if (seen.has(name)) continue;
        seen.add(name);
        const declaration = declarations.find((it) => it.name === name);
        if (!declaration) continue;
        for (const schema of parsedBy(declaration.body)) named.add(schema);
        next.push(...callsIn(declaration.body));
      }
      frontier = next;
    }
    return named;
  };

  /** Whether a published schema asks for a field anywhere inside it. */
  const asksFor = (node: unknown, field: string): boolean => {
    if (!node || typeof node !== "object") return false;
    const record = node as Record<string, unknown>;
    const properties = record["properties"] as Record<string, unknown> | undefined;
    if (properties && Object.hasOwn(properties, field)) return true;
    // Anywhere, not at the top: a bulk edit carries a version per row, inside
    // an array inside the arm of a union, and a reader that looked only at the
    // top level would pass every one of them without looking.
    return Object.values(record).some((value) =>
      Array.isArray(value) ? value.some((entry) => asksFor(entry, field)) : asksFor(value, field),
    );
  };

  const routes = () => {
    const found = [
      ...api.code.matchAll(/app\.(get|post|put|delete)\(\s*\n?\s*"(\/api\/v1[^"]*)"/g),
    ];
    return found.flatMap((hit, at) => {
      const method = hit[1]!.toUpperCase();
      if (method === "GET") return [];
      const to = at + 1 < found.length ? found[at + 1]!.index : api.code.length;
      const handler = api.code.slice(hit.index, to);
      let version = false;
      let key = false;
      let read = 0;
      for (const name of requestSchemas(handler)) {
        // Both shared modules: the CSV request schemas live beside the format
        // rather than in domain.ts, and a schema this did not find would read
        // as a route asking for nothing.
        const schema =
          (domain as Record<string, unknown>)[name] ?? (csv as Record<string, unknown>)[name];
        if (!schema) continue;
        read += 1;
        const json = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" });
        if (asksFor(json, "expectedVersion") || asksFor(json, "expectedVersions")) version = true;
        if (asksFor(json, "idempotencyKey")) key = true;
      }
      return [{ route: `${method} ${hit[2]}`, handler, version, key, read }];
    });
  };

  /**
   * The mutating routes that ask for no expected version, each with the
   * argument `AGENTS.md` or `http.md` already makes for it.
   */
  const NO_VERSION: Record<string, string> = {
    "POST /api/v1/auth/local-password":
      "Sets a credential rather than replacing a record. There is no row whose version somebody could be holding, and the refusal it needs — that a password already exists — is a condition of the account rather than of a revision.",
    "PUT /api/v1/preferences":
      "A patch over a settings row that only its owner can write, from one session at a time in practice. The fields are independent and last-write-wins is the behavior somebody expects from a settings page.",
    "DELETE /api/v1/me":
      "Deletes the person. There is no later state for a stale version to protect, and refusing the deletion because something changed would be refusing the one request that makes everything else moot.",
    "DELETE /api/v1/connected-apps/:clientId":
      "Revokes an authorization by the client id the person is looking at. Revoking twice is revoking, and refusing the second attempt because the row moved would leave an agent connected while telling somebody it was not.",
    "PUT /api/v1/accounts/active":
      "The one update AGENTS.md exempts, and the reason is its shape: it states the whole set that stays active, so sending it twice leaves exactly the state the first call left. What serializes it is `lockAccountNamespace` rather than a version — an expected version would not stop two requests both taking the last free place, and the lock does.",
    "POST /api/v1/accounts":
      "A create. There is no row to be stale about, and a second submit is refused by the account name being unique among the person's accounts rather than by a version.",
    "POST /api/v1/recurrences": "A create, protected by its own name being unique among theirs.",
    "POST /api/v1/category-groups":
      "A create, protected by its own name being unique among theirs.",
    "POST /api/v1/budget-plans":
      "A create. A second one for the same target, currency and period overlaps the first and is refused on that rather than on a version.",
    "POST /api/v1/categories": "A create, protected by its own name being unique among theirs.",
    "POST /api/v1/transaction-templates":
      "A create, protected by its own name being unique among theirs.",
    "POST /api/v1/transactions":
      "A create that writes postings, so it is the other half of the sentence: it carries an idempotency key instead, which is what makes a retry return the first answer rather than record the money twice.",
    "POST /api/v1/staged-transactions":
      "A create in the staging queue, carrying an idempotency key for the same reason. Nothing it writes touches a balance, and there is no prior row to be stale about.",
    "POST /api/v1/payees/merge":
      "A payee is text rather than a record, so there is no row and no version to hold. The merge names the spellings to fold in and carries an idempotency key so a retry does not fold a second time.",
    "POST /api/v1/transactions/bulk-selection":
      "Reads a filter and hands back a count and a fingerprint. It writes nothing; the fingerprint it returns is what the edit that follows is held to.",
    "POST /api/v1/staged-transactions/bulk-selection":
      "The same preview over the staged queue, writing nothing and naming no record.",
    "POST /api/v1/csv/preview":
      "Parses a file and reports what it found. It writes nothing at all and names no record.",
    "PUT /api/v1/billing/subscription":
      "Starts or changes a subscription at Stripe, which holds the state. There is no local row whose version a caller could be holding — the local record is written from what Stripe answers, and `lockBillingState` is what serializes two deliveries racing.",
    "PUT /api/v1/billing/subscription/cancellation":
      "The other half of the same decision, and the same argument: the state being changed belongs to Stripe, and the row here is a copy written from the answer.",
    "POST /api/v1/billing/payment-setups":
      "Asks Stripe for a SetupIntent and returns a secret only Stripe's browser SDK can use. It replaces no record of this deployment's.",
    "POST /api/v1/billing/payment-setups/confirmations":
      "Reports a SetupIntent that Stripe's browser SDK has already confirmed, so the state it records was decided elsewhere and there is no local revision to hold.",
    "POST /api/v1/csv/stage":
      "Stages a file's rows, which creates records rather than replacing them, and carries an idempotency key so a resubmitted upload does not stage the file twice.",
  };

  /**
   * Routes that reach a write of the posting table and ask for no idempotency
   * key, each with the argument.
   */
  const NO_KEY: Record<string, string> = {
    "POST /api/v1/accounts":
      "An opening balance posts against equity, so this is a create that writes postings — and the sentence's own second clause covers it: a record somebody names is protected by its own name being unique, so a second submit fails rather than duplicating.",
    "POST /api/v1/accounts/:id/archived":
      "Archiving posts what the account still holds out to equity, but it is an update rather than a create: it carries an expected version, which is the other half of the same rule.",
    "POST /api/v1/accounts/:id/archive":
      "The 0.1.6 spelling of the route above, still registered so a tab left open across the upgrade keeps working. Same handler, same argument.",
    "POST /api/v1/transactions/:id/deleted":
      "Voiding and restoring post the reversal and the reinstatement, and both are updates to a transaction somebody named: the expected version is what makes a repeat safe.",
    "PUT /api/v1/accounts/:id":
      "An account edit can move the opening balance, which reposts. It is an update and carries the expected version.",
    "PUT /api/v1/transactions/:id":
      "An edit reposts the difference per account, currency and date. It is an update of a transaction somebody named and carries the expected version, which is what makes a repeat of the same request safe.",
  };

  it("is found, with a schema behind it", () => {
    const all = routes();
    // Four things that each stopped matching once in this repository: the route
    // scan, the schema walk, the conversion, and the field reader.
    expect(all.length, "no mutating route read").toBeGreaterThan(30);
    expect(all.filter((it) => it.read > 0).length, "no schema resolved").toBeGreaterThan(25);
    expect(all.filter((it) => it.version).length, "no version found anywhere").toBeGreaterThan(15);
    expect(all.filter((it) => it.key).length, "no idempotency key found anywhere").toBeGreaterThan(
      5,
    );
  });

  it("asks for an expected version, or is named with the argument", () => {
    const unguarded = routes()
      .filter((it) => !it.version && !(it.route in NO_VERSION))
      .map((it) => it.route);
    expect(
      unguarded,
      "take an expectedVersion, or name the route above with why a lost update cannot happen on it",
    ).toEqual([]);
  });

  it("asks for an idempotency key wherever a create writes postings", () => {
    // Derived rather than listed: the question is whether this route reaches a
    // write of the posting table at all, which is the thing a retry would
    // duplicate. A route that reaches none cannot double anybody's money.
    const posting = new Set(
      declarations
        .filter((it) => /\.insert\s*\(\s*postings\s*\)/.test(it.body))
        .map((it) => it.name),
    );
    expect(posting.size, "nothing was found writing postings").toBeGreaterThan(1);
    const reaches = (handler: string) => {
      const seen = new Set<string>();
      const walk = (names: readonly string[]): boolean => {
        for (const name of names) {
          if (posting.has(name)) return true;
          if (seen.has(name)) continue;
          seen.add(name);
          const declaration = declarations.find((it) => it.name === name);
          if (declaration && walk(callsIn(declaration.body))) return true;
        }
        return false;
      };
      return walk(namesIn(handler));
    };

    const posting_routes = routes().filter((it) => reaches(it.handler));
    expect(posting_routes.length, "no route reaches a posting write").toBeGreaterThan(4);
    const unkeyed = posting_routes
      .filter((it) => !it.key && !(it.route in NO_KEY))
      .map((it) => it.route);
    expect(
      unkeyed,
      "take an idempotencyKey, or name the route above with what stops a retry writing the money twice",
    ).toEqual([]);
  });

  it("excuses nothing that is no longer there", () => {
    const present = new Set(routes().map((it) => it.route));
    expect(Object.keys(NO_VERSION).filter((route) => !present.has(route))).toEqual([]);
    expect(Object.keys(NO_KEY).filter((route) => !present.has(route))).toEqual([]);
    for (const [route, reason] of Object.entries({ ...NO_VERSION, ...NO_KEY })) {
      expect(reason.length, route).toBeGreaterThan(40);
    }
  });
});

/**
 * The key's own bounds, which nothing reaches.
 *
 * `tests/idempotency-key.test.ts` is about the browser's generator and never
 * gets to the schema the server holds a request to. The ceiling is the one that
 * matters on the wire: the column is 200 characters wide, so a longer key would
 * come back as a server error rather than as a refused request — and the trim
 * is what keeps a key pasted with a newline from being a different key from the
 * same one typed.
 */
describe("the idempotency key a write is held to", () => {
  it("trims, and refuses one too short or too long", () => {
    expect(idempotencyKeySchema.parse("  a-key-that-is-long-enough  ")).toBe(
      "a-key-that-is-long-enough",
    );
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(200)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
    // Trimmed before measuring, so padding cannot push a legal key past the
    // column width.
    expect(idempotencyKeySchema.parse(` ${"x".repeat(200)} `)).toHaveLength(200);
  });
});
