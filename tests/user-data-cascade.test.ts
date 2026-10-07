import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/source.js";

/**
 * `AGENTS.md`: "A table that holds somebody's data references `auth_user` with
 * `on delete cascade`, because deleting an account is one delete of that row
 * and nothing enumerates tables."
 *
 * `tests/integration/account-deletion.integration.test.ts` proves the delete
 * empties what its seed wrote, which was thirteen of the tables — so a new
 * table whose cascade was forgotten passed it as long as nothing in that seed
 * wrote a row there. This reads every table the schema declares instead.
 * `billing_webhook_event` is the one table with no `user_id`, and `AGENTS.md`
 * argues why it must not cascade from anybody; that it still has none is part
 * of the check, because giving it one is the mistake the argument is against.
 */
const schema = readFileSync(path.join(repoRoot, "src/server/db/schema.ts"), "utf8");

/** Each `pgTable("name", { … })`, sliced to the start of the next one. */
const tables = [...schema.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((match, index, all) => ({
  name: match[1]!,
  body: schema.slice(match.index, all[index + 1]?.index ?? schema.length),
}));

describe("a table that holds somebody's data", () => {
  it("is found, every one the schema declares", () => {
    expect(tables.length).toBeGreaterThan(25);
  });

  it("goes when its person does", () => {
    const owned = tables.filter(({ body }) => /\buserId:\s*text\("user_id"\)/.test(body));
    expect(owned.length).toBeGreaterThan(20);
    const loose = owned
      .filter(({ body }) => {
        // The column runs to the first comma ending a line: a chained
        // `.notNull()` and `.references()` carry none until the last of them.
        const column = /\buserId:\s*text\("user_id"\)[\s\S]*?,\n/.exec(body)![0];
        return !/\.references\(\(\) => user\.id, \{ onDelete: "cascade" \}\)/.test(column);
      })
      .map(({ name }) => name);
    expect(loose, "reference auth_user with on delete cascade").toEqual([]);
  });

  it("leaves the webhook record to nobody", () => {
    const webhook = tables.find(({ name }) => name === "billing_webhook_event");
    expect(webhook).toBeDefined();
    expect(webhook!.body).not.toMatch(/user_id/);
  });
});
