import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, sourceFiles, topLevelDeclarations } from "./support/source.js";

/**
 * The second half of the scoping rule, which nothing checked.
 *
 * `AGENTS.md` is the authority: "Never accept a public `userId`. Derive it from
 * the authenticated `Actor`, and scope every finance read/write by that ID."
 * `tests/service-entry-points.test.ts` holds the first half — a service function
 * takes an actor first — and `services.md` 1.1 says in as many words that the
 * first half is not the half that does the work: a function that takes an actor
 * and then writes without it satisfies the parameter rule and breaks the real
 * one.
 *
 * Writes rather than reads, and the asymmetry is the point. A read that forgets
 * the owner shows somebody another tenant's row, and
 * `tests/integration/tenant-isolation.integration.test.ts` walks the surface
 * with two users and catches it. A write that forgets the owner can only be
 * caught by that suite if two tenants' rows can collide on the key it does use —
 * and every key here is a UUID, so they never collide and the suite is green
 * either way. That is exactly how `claimDueNotification` came to update
 * `template_notification` by id alone for a release: safe on the narrow primary
 * key, invisible to every behavioural test, and the one write in the directory
 * that `drizzle/0023_citus_distribution.sql` could not route to a single shard
 * once it made that table's primary key `(user_id, id)`.
 *
 * So this check is a property of the text, which is the only place the defect
 * exists. `database.md` 3.6 is the same shape one table along: a rule that is
 * about plain PostgreSQL but that a migration is what finally makes it bite.
 *
 * Inserts are deliberately outside it. An insert names the owner in its values
 * rather than in a `where`, so "the statement names `userId`" means something
 * different there and a sweep that lumped the two together would be checking
 * neither properly.
 */

/**
 * The user-owned tables, by both of their names.
 *
 * Discovered from the schema rather than listed, for the reason
 * `tests/support/source.ts` gives at length: a list is a claim about what exists
 * made once by somebody who could not see the future, and the next table added
 * would be outside this rule with nothing to say so.
 *
 * "Carries a `userId` column" is `database.md` 2.3's own definition of
 * user-owned, which is why the six tables without one — `auth_user` keyed by its
 * own id, the verification and rate-limit tables, and `billing_webhook_event`,
 * which `AGENTS.md` says belongs to the deployment rather than to anybody — drop
 * out of the population instead of needing excuses.
 */
function userOwnedTables() {
  const schema = readFileSync(path.join(repoRoot, "src/server/db/schema.ts"), "utf8");
  const declarations = [...schema.matchAll(/\nexport const (\w+) = pgTable\(\s*"(\w+)"/g)];
  const identifiers = new Set<string>();
  const sqlNames = new Set<string>();
  for (const [position, match] of declarations.entries()) {
    const start = match.index + match[0].length;
    const end = declarations[position + 1]?.index ?? schema.length;
    if (!/\buserId:/.test(schema.slice(start, end))) continue;
    identifiers.add(match[1]!);
    sqlNames.add(match[2]!);
  }
  return { identifiers, sqlNames };
}

/**
 * The index just past the statement starting at `from`.
 *
 * Brackets are balanced rather than counted to a line ending, because a drizzle
 * chain is several lines of `.set({…})` before the `.where` this is looking for.
 * Template literals are stepped over whole: `sql` fragments in this directory
 * contain semicolons of their own, and one of those would end the statement
 * early and hide whatever came after it.
 */
function endOfStatement(code: string, from: number): number {
  let depth = 0;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index]!;
    if (character === "`") {
      index = endOfTemplate(code, index);
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      // A closing bracket the scan never opened ends the statement too: a write
      // that is the last thing in a block has no `;` of its own before the `}`.
      if (depth < 0) return index;
    } else if (character === ";" && depth === 0) return index;
  }
  return code.length;
}

/**
 * The index of the backtick closing the template that opens at `start`.
 *
 * `${…}` is stepped over rather than read, and that is not tidiness: the one
 * raw SQL write in this directory interpolates `sql.join(rekeyed.map(entry =>
 * sql`…`))`, so the first backtick after the statement opens a *nested*
 * template rather than closing this one. Reading it as the close cut the
 * fragment off three lines above its `where` and reported a correctly scoped
 * statement as unscoped — which is the whole failure mode this file is built to
 * avoid, met on its first run.
 */
function endOfTemplate(code: string, start: number): number {
  for (let index = start + 1; index < code.length; index += 1) {
    const character = code[index]!;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`") return index;
    if (character === "$" && code[index + 1] === "{") index = endOfInterpolation(code, index + 2);
  }
  return code.length;
}

/** The index of the `}` closing an interpolation whose contents start at `from`. */
function endOfInterpolation(code: string, from: number): number {
  let depth = 0;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index]!;
    if (character === "`") {
      index = endOfTemplate(code, index);
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return code.length;
}

/** The text of the parenthesized argument to `(` at `open`, brackets included. */
function argumentAt(code: string, open: number): string {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return code.slice(open);
}

type Write = {
  readonly kind: string;
  readonly table: string;
  /** Offset of the statement within the text it was found in. */
  readonly offset: number;
  /** The `where` argument as written, or null where the statement has none. */
  readonly where: string | null;
};

/**
 * Every `update` and `delete` against a user-owned table in one piece of code.
 *
 * The table argument is what tells a query apart from the rest, and it has to
 * be: this directory calls `.update(…)` on a hash seven times
 * (`createHash("sha256").update(payload)`) and `.delete(…)` on two Maps. A
 * sweep that matched the method name alone reported ten of those as unscoped
 * writes, which is nine false positives for every real one, and a check that
 * cries wolf nine times out of ten is a check somebody switches off.
 */
function buildersIn(code: string, tables: ReadonlySet<string>): Write[] {
  const found: Write[] = [];
  for (const match of code.matchAll(/\.(update|delete)\(\s*(\w+)\s*\)/g)) {
    if (!tables.has(match[2]!)) continue;
    const statement = code.slice(match.index, endOfStatement(code, match.index + match[0].length));
    const where = /\.where\(/.exec(statement);
    found.push({
      kind: match[1]!,
      table: match[2]!,
      offset: match.index,
      where: where ? argumentAt(statement, where.index + where[0].length - 1) : null,
    });
  }
  return found;
}

/**
 * The same, for a statement written as SQL.
 *
 * One exists — `payees.ts` rewrites the whole staged queue's duplicate keys in a
 * single statement over a values list — and it names the owner. It is swept
 * anyway, because a rule enforced on the query builder alone is a rule with a
 * documented way around it.
 */
function rawWritesIn(code: string, sqlNames: ReadonlySet<string>): Write[] {
  const found: Write[] = [];
  for (const match of code.matchAll(/^[^\S\n]*(update|delete\s+from)\s+(\w+)/gim)) {
    if (!sqlNames.has(match[2]!)) continue;
    found.push({
      kind: match[1]!.toLowerCase(),
      table: match[2]!,
      offset: match.index,
      // Everything to the end of the fragment, because a SQL `where` is not a
      // bracketed argument there is any way to cut out exactly.
      where: code.slice(match.index, endOfTemplate(code, match.index)),
    });
  }
  return found;
}

/**
 * Every `const` in a file and what it was assigned, so a condition built once
 * and used twice can be resolved.
 *
 * `setActiveAccounts` is why this exists. It builds `const mine = and(eq(…
 * .userId, actor.userId), …)` and then writes `.where(and(mine, inArray(…)))`
 * twice, so the owner is named by reference rather than in the text of either
 * statement. Reading the statement alone calls both of them unscoped, which is
 * the false positive this rule has to survive: the scope is really there, and an
 * excuse list with two correct entries on it teaches the next reader that
 * entries on the list are fine.
 */
function bindingsIn(code: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of code.matchAll(/\bconst (\w+) = /g)) {
    const start = match.index + match[0].length;
    found.set(match[1]!, code.slice(start, endOfStatement(code, start)));
  }
  return found;
}

/**
 * The names in an expression that stand for a value, rather than naming a
 * function being called or a column on a table.
 *
 * Both exclusions matter. Without them `and`, `eq` and `inArray` are identifiers
 * to resolve, and so is the `userId` in `billingCustomers.userId` — which would
 * make the member access itself the answer and defeat the resolution entirely.
 */
function bareIdentifiers(expression: string): string[] {
  return [...expression.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*\()/g)].map(
    (match) => match[1]!,
  );
}

const NAMES_OWNER = /\b(?:userId|user_id)\b/;

function ownerNamed(where: string | null, bindings: Map<string, string>): boolean {
  if (where === null) return false;
  if (NAMES_OWNER.test(where)) return true;
  // One level of resolution and no more. A condition assembled two hops away
  // fails this and wants a person to look, which is the conservative direction:
  // the cost of being wrong here is a reader confirming a scope that is present,
  // and the cost of being wrong the other way is a cross-tenant write.
  return bareIdentifiers(where).some((name) => NAMES_OWNER.test(bindings.get(name) ?? ""));
}

/**
 * Writes whose `where` cannot name the owner, and why.
 *
 * Keyed by the function it is in rather than by a line, so the excuse survives
 * the file being edited above it — and so a reader meets the reason beside the
 * name rather than beside a number that has since moved.
 */
const UNSCOPED_BY_DESIGN = new Map([
  [
    "closeStripeCustomer",
    "Stripe's delivery names a customer and nobody else; this delete of `billing_customer` by the unique `stripe_customer_id` is the lookup that produces the owner, and the subscription update two lines below it is scoped by what this returned. `database.md` 2.3 argues the same exception for the read on the same path: the key is issued by Stripe rather than typed by anybody, so the row it reaches is the only row it could reach.",
  ],
]);

/**
 * The sweep, run once and read by four tests.
 *
 * `excused` is the half `tests/service-entry-points.test.ts` learned to keep:
 * "nothing unexplained" is said just as loudly by a sweep that has gone blind as
 * by a sweep that is working, so the excuses that were actually spent are
 * recorded and an unspent one fails.
 */
function sweepWrites() {
  const { identifiers, sqlNames } = userOwnedTables();
  const unscoped: string[] = [];
  const excused = new Set<string>();
  let checked = 0;
  let outsideADeclaration = 0;

  for (const file of sourceFiles("src/server/services")) {
    const bindings = bindingsIn(file.code);
    let seen = 0;
    for (const declaration of topLevelDeclarations(file)) {
      const writes = [
        ...buildersIn(declaration.body, identifiers),
        ...rawWritesIn(declaration.body, sqlNames),
      ];
      for (const write of writes) {
        seen += 1;
        checked += 1;
        if (ownerNamed(write.where, bindings)) continue;
        if (UNSCOPED_BY_DESIGN.has(declaration.name)) {
          excused.add(declaration.name);
          continue;
        }
        const offset = declaration.body.slice(0, write.offset).split("\n").length - 1;
        const shown = (write.where ?? "(no where at all)").replace(/\s+/g, " ").slice(0, 120);
        unscoped.push(
          `${file.path}:${declaration.line + offset}: ${declaration.name} ${write.kind}s ${write.table} where ${shown}`,
        );
      }
    }
    // A write sitting outside every top-level declaration would be swept by
    // nothing above, and so would a write the declaration splitter lost. Both
    // are the sweep going blind rather than the directory being clean.
    const whole =
      buildersIn(file.code, identifiers).length + rawWritesIn(file.code, sqlNames).length;
    if (whole !== seen) outsideADeclaration += whole - seen;
  }
  return { unscoped, excused, checked, outsideADeclaration };
}

const sweep = sweepWrites();

describe("a service write", () => {
  it("names the owner in its where, or says why it cannot", () => {
    expect(
      sweep.unscoped,
      "add the owner to the where — `userId` is in scope wherever a service writes — or say in UNSCOPED_BY_DESIGN why this statement has nobody to name",
    ).toEqual([]);
  });

  it("is swept in numbers, and every one of them inside a function", () => {
    // The directory holds about sixty-five of these. A sweep that has stopped
    // recognizing the shape reports zero unscoped writes, which reads exactly
    // like a clean directory.
    expect(sweep.checked).toBeGreaterThan(50);
    expect(
      sweep.outsideADeclaration,
      "a write the declaration walk missed: either it sits outside every top-level declaration, or the splitter lost it and this sweep is partly blind",
    ).toBe(0);
  });

  it("has spent every excuse on the list", () => {
    const decorative = [...UNSCOPED_BY_DESIGN.keys()].filter((name) => !sweep.excused.has(name));
    expect(
      decorative,
      "excused, but the sweep never found an unscoped write there — the excuse is decorative and could be deleted with this suite still green",
    ).toEqual([]);
  });

  /**
   * The reader against the shapes that decide whether it is worth anything, on
   * a fixture rather than on the directory.
   *
   * Held here so it keeps meaning something after the files it was written
   * about are rewritten, and so a failure names the reader rather than whichever
   * service happens to be shaped like the bug today.
   */
  it("tells a write from a hash, and a prebuilt condition from a missing one", () => {
    const tables = new Set(["templateNotifications", "ledgerAccounts"]);
    const fixture = [
      'const hashed = createHash("sha256").update(payload).digest("hex");',
      "const removed = cache.delete(tx);",
      "const mine = and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.archivedAt));",
      "await tx",
      "  .update(ledgerAccounts)",
      "  .set({ active: true })",
      "  .where(and(mine, inArray(ledgerAccounts.id, activating)));",
      "await tx",
      "  .update(templateNotifications)",
      "  .set({ lastNotifiedDate: owed.occurrenceDate })",
      "  .where(eq(templateNotifications.id, row.notification.id));",
    ].join("\n");

    const writes = buildersIn(fixture, tables);
    // Neither the hash nor the Map is a write, and both were reported as one by
    // the first version of this sweep.
    expect(writes.map((write) => write.table)).toEqual(["ledgerAccounts", "templateNotifications"]);

    const bindings = bindingsIn(fixture);
    expect(ownerNamed(writes[0]!.where, bindings), "the prebuilt `mine` names the owner").toBe(
      true,
    );
    expect(ownerNamed(writes[1]!.where, bindings), "by id alone, and nothing else").toBe(false);
    // And a statement with no `where` at all, which is the worst case of the
    // same defect and must not read as scoped by accident.
    expect(ownerNamed(null, bindings)).toBe(false);
  });

  it("reads a raw SQL write past a nested template, to the where that follows it", () => {
    const names = new Set(["staged_transaction"]);
    // `${sql.join(rows.map(row => sql`…`))}` is the real statement's shape, and
    // the backtick inside it is the one that fooled the first reader.
    const scoped =
      "await tx.execute(sql`\n  update staged_transaction as s\n  set duplicate_key = v.key\n  from (values ${sql.join(rekeyed.map((entry) => sql`(${entry.id}::uuid)`))}) as v(id)\n  where s.id = v.id and s.user_id = ${actor.userId}\n`);";
    const unscoped =
      "await tx.execute(sql`\n  update staged_transaction as s\n  set duplicate_key = v.key\n  where s.id = v.id\n`);";
    const bindings = new Map<string, string>();
    expect(rawWritesIn(scoped, names)).toHaveLength(1);
    expect(ownerNamed(rawWritesIn(scoped, names)[0]!.where, bindings)).toBe(true);
    expect(ownerNamed(rawWritesIn(unscoped, names)[0]!.where, bindings)).toBe(false);
  });
});
