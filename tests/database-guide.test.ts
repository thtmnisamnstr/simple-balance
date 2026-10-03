import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The two rules in `docs/standards/code/database.md` that a program can hold
 * and nothing was holding: 1.6's second half, and 3.6.
 *
 * Both are about a cluster, and both fail in the same unhelpful way — on a
 * profile CI cannot run. `npm run verify` has no PostgreSQL at all and the
 * integration suite runs a single node, so a table that never reached a shard
 * and a `GROUP BY` that is legal only under a narrow primary key both pass
 * everything this repository executes. They are properties of the text, so
 * they are checked as properties of the text.
 *
 * `tests/migrations.test.ts` already holds 1.5 and the rest of `0023`'s shape;
 * this file deliberately does not restate either.
 */
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SCHEMA = "src/server/db/schema.ts";
const DISTRIBUTION = "drizzle/0023_citus_distribution.sql";

/**
 * Every table the schema declares, by the name PostgreSQL knows it as.
 *
 * Derived rather than listed, because a list is the thing this is checking for:
 * the migration already holds one, written on the day it was written, and the
 * whole defect is that a list stops being complete the moment a table is added
 * beside it.
 */
const declaredTables = (): string[] =>
  [...read(SCHEMA).matchAll(/\bpgTable\(\s*"([a-z_]+)"/g)].map((match) => match[1]!).sort();

/** The tables `0023` hands to Citus, in either shape. */
const distributedTables = (): string[] => {
  const sql = read(DISTRIBUTION);
  return [
    ...[...sql.matchAll(/create_distributed_table\('([a-z_]+)'/g)].map((match) => match[1]!),
    ...[...sql.matchAll(/create_reference_table\('([a-z_]+)'/g)].map((match) => match[1]!),
  ].sort();
};

describe("1.6 — a table added after the distribution migration", () => {
  /**
   * `0023` names every table once, and nothing makes it name the next one.
   *
   * Its first act is to return early where `pg_dist_partition` has a row, which
   * is correct — the runbook invites an operator to re-run the file by hand —
   * and means it will never pick up a table created after it ran. Nor does
   * anything else: this repository sets no `citus.use_citus_managed_tables`, so
   * a table created later lands on a cluster as a plain local table on the
   * coordinator, uncolocated, unable to carry a composite foreign key into a
   * distributed one, and perfectly happy on every profile CI can run.
   *
   * So the migration's list is checked against the schema rather than trusted.
   * A new table fails here, in the change that adds it, where the answer is
   * still cheap: distribute it in a new migration, or give it a reason to be a
   * reference table and say so.
   */
  it("is named by 0023 as either distributed or replicated", () => {
    const covered = new Set(distributedTables());
    const missing = declaredTables().filter((table) => !covered.has(table));
    expect(missing, `${DISTRIBUTION} names neither shape for these tables`).toEqual([]);
  });

  /**
   * And the other direction, which is the same defect read backwards: a table
   * that has left the schema under one name leaves `0023` distributing
   * something that no longer exists, and the migration dies on a cluster at the
   * statement naming it. Nothing else would say so, because the two gates at
   * the top mean the file is a no-op everywhere the suite runs.
   */
  it("names no table the schema does not declare", () => {
    const named = distributedTables();
    const declared = new Set(declaredTables());
    expect(named.filter((table) => !declared.has(table))).toEqual([]);
    // Once each, not twice: distributing a table that is already a reference
    // table is an error on the cluster and reads as thoroughness here.
    expect(new Set(named).size).toBe(named.length);
  });
});

/**
 * Every grouping expression written in `src/server`, in both spellings.
 *
 * Raw SQL and Drizzle's builder are the same rule with different punctuation,
 * and the five sites this rule came from are three of the first and two of the
 * second, so reading only one spelling would have found three of five.
 *
 * Comments are blanked first. `group by` appears in prose in this tree, and a
 * check that read a comment as code would report a correct file.
 */
type Grouping = {
  readonly file: string;
  readonly line: number;
  /**
   * The dotted column tokens the clause names, as a set.
   *
   * A set of tokens rather than a split on commas, because a clause can be
   * half TypeScript: `group by 1, p.currency, a.system_kind${byCategory ?
   * sql`, c.id, c.name` : sql``}` splits into items carrying backticks and a
   * ternary, so `c.name` never equals `c.name` and a correct query reads as a
   * leaning one.
   */
  readonly names: ReadonlySet<string>;
  readonly owner: (alias: string) => string;
  /**
   * What the statement selects, back to the `select` that opens it. A rule
   * about functional dependency cannot be decided from the grouping alone:
   * what makes a grouping lean is a column in the select list that it does not
   * name, so the select list has to be read beside it.
   */
  readonly selected: string;
};

/** Every `alias.column` token in a clause, whatever punctuation surrounds it. */
const columnsIn = (clause: string): Set<string> =>
  new Set([...clause.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\b/g)].map((match) => match[0]));

const groupings = (): Grouping[] => {
  const found: Grouping[] = [];
  for (const file of sourceFiles("src/server")) {
    const lines = file.code.split("\n");
    // Offsets rather than lines, because a SQL template spans many of them and
    // the select list opening a statement is nowhere near the clause closing it.
    const offsets = lines.map((_, index) =>
      lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0),
    );
    const sliceBack = (at: number, opener: RegExp, closer: RegExp): string => {
      const before = file.code.slice(0, at);
      const opens = [...before.matchAll(opener)];
      const start = opens.at(-1)?.index;
      if (start === undefined) return "";
      const rest = file.code.slice(start, at);
      const end = closer.exec(rest)?.index;
      return end === undefined ? rest : rest.slice(0, end);
    };
    lines.forEach((text, index) => {
      // Every `group by` in this tree is written on one line, and a clause
      // wrapped over two would be read as a short one rather than as none —
      // visible as a grouping whose items do not include the id at all.
      for (const match of text.matchAll(/\bgroup by\s+(.+?)(?:$|--)/gi)) {
        const at = offsets[index]! + match.index;
        found.push({
          file: file.path,
          line: index + 1,
          names: columnsIn(match[1]!),
          owner: (alias) => `${alias}.user_id`,
          selected: sliceBack(at, /\bselect\b/gi, /\bfrom\b/i),
        });
      }
      for (const match of text.matchAll(/\.groupBy\(([^)]*)\)/g)) {
        const at = offsets[index]! + match.index;
        found.push({
          file: file.path,
          line: index + 1,
          names: columnsIn(match[1]!),
          owner: (alias) => `${alias}.userId`,
          // Drizzle's builder has no `from` inside the projection, so the slice
          // runs to the grouping itself and takes the joins with it. That only
          // widens what counts as selected, which is the safe direction.
          selected: sliceBack(at, /\.select\(/g, /$^/),
        });
      }
    });
  }
  return found;
};

/**
 * Whether a grouping is relying on functional dependency at all.
 *
 * It is, exactly when the statement reads a column of that alias which the
 * grouping does not name — including `a.*`, which reads all of them, and a
 * bare table identifier in Drizzle's projection, which is the same thing
 * spelled as an object. Where every column it reads is grouped, PostgreSQL
 * needs no dependency and the query is right under either key: the two
 * category breakdowns group `c.id, c.name` and select exactly those two.
 */
const leansOn = (grouping: Grouping, alias: string): boolean => {
  if (new RegExp(String.raw`\b${alias}\.\*`).test(grouping.selected)) return true;
  if (new RegExp(String.raw`[:,{]\s*${alias}\s*[,}]`).test(grouping.selected)) return true;
  for (const read of grouping.selected.matchAll(new RegExp(String.raw`\b${alias}\.(\w+)`, "g"))) {
    if (!grouping.names.has(`${alias}.${read[1]!}`)) return true;
  }
  return false;
};

describe("3.6 — a GROUP BY names the whole key it leans on", () => {
  /**
   * PostgreSQL lets a select list name a column functionally determined by the
   * grouping, and only where the grouping covers the *whole* primary key. Every
   * tenant-owned table here gains `user_id` in front of its key when `0023`
   * distributes the ledger, at which point a grouping on the id alone
   * determines nothing and the query fails with `column "a.name" must appear in
   * the GROUP BY clause`.
   *
   * Naming both is correct under either key — `user_id` is already fixed by the
   * `WHERE` — which is why the fix shipped long before the migration did and
   * why this check is worth having on a branch whose CI has no cluster.
   *
   * It reads the select list beside the grouping rather than the grouping
   * alone, because a grouping that names every column the statement reads
   * leans on nothing and is right under either key. Flagging those too would
   * have asked for a word in two correct category breakdowns, and a check that
   * asks for pointless edits is a check people start overriding.
   */
  it("names the owner wherever it leans on an id", () => {
    const narrow: string[] = [];
    for (const grouping of groupings()) {
      for (const item of grouping.names) {
        const key = /^([A-Za-z_]\w*)\.id$/.exec(item);
        if (!key) continue;
        const owner = grouping.owner(key[1]!);
        if (grouping.names.has(owner)) continue;
        if (!leansOn(grouping, key[1]!)) continue;
        narrow.push(`${grouping.file}:${grouping.line} groups by ${item} without ${owner}`);
      }
    }
    expect(narrow, "add the owner column; the key gains it on a cluster").toEqual([]);
  });

  /**
   * And that the check has something to read.
   *
   * A regex that stopped matching — a reformat moving a clause onto its own
   * line, Drizzle spelling its builder some other way — would empty the
   * population and pass in silence, which is the failure a shape check is most
   * prone to. Five sites is what this rule was written from; fewer means the
   * scan broke rather than that the tree got better.
   */
  it("finds the groupings it is scanning, in both spellings", () => {
    const leaning = groupings().filter((grouping) =>
      [...grouping.names].some((item) => {
        const key = /^([A-Za-z_]\w*)\.id$/.exec(item);
        return key !== null && leansOn(grouping, key[1]!);
      }),
    );
    expect(leaning.length).toBeGreaterThanOrEqual(5);
    // Raw SQL and the builder separately, because reading one of them would
    // have found three of the five sites and called the sweep complete.
    const spelling = (grouping: Grouping) => grouping.owner("x");
    expect(leaning.filter((grouping) => spelling(grouping) === "x.user_id").length).toBeGreaterThan(
      0,
    );
    expect(leaning.filter((grouping) => spelling(grouping) === "x.userId").length).toBeGreaterThan(
      0,
    );
  });
});
