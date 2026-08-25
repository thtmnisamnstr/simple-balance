import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { stagedTransactions, user } from "../../src/server/db/schema.js";
import { listStages } from "../../src/server/services/staging.js";
import type { Actor } from "../../src/shared/domain.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("staged_cursor");
const actor: Actor = { userId: "staged-cursor-user", source: "web" };

/**
 * Paging the queue by date when the dates are not all strings.
 *
 * A staged draft is unvalidated JSON on purpose — the schema types every field
 * `unknown`, because a CSV import stores what it read so somebody can fix it —
 * so a draft can carry a number where a date belongs. PostgreSQL's `->>` renders
 * that number as text and sorts by it; the cursor used to be recomputed in
 * JavaScript, which returned "" for anything that was not already a string. The
 * cursor then named a boundary the ordering had never used, and the following
 * page skipped rows or repeated one — with the total count still reporting the
 * truth, so nothing looked wrong.
 */
const DRAFTS: unknown[] = [
  { date: "2026-01-05", payee: "A string date" },
  { date: 20260106, payee: "A number date" },
  { date: "2026-01-07", payee: "Another string date" },
  { date: true, payee: "A boolean date" },
  { date: "2026-01-09", payee: "A later string date" },
  { payee: "No date at all" },
];

integration("paging the queue by date", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Staged Cursor",
      email: "staged-cursor@example.com",
      emailVerified: true,
    });
    await getDb()
      .insert(stagedTransactions)
      .values(
        DRAFTS.map((draft, index) => ({
          userId: actor.userId,
          // Deterministic ids so the tie-break is stable and the test is not
          // reading a different order each run.
          id: `00000000-0000-4000-8000-00000000000${index}`,
          draft,
          status: "staged" as const,
          validationIssues: [],
        })),
      );
  });

  afterAll(async () => {
    await database.drop();
  });

  it("returns every row exactly once across pages", async () => {
    for (const direction of ["asc", "desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      // One at a time, which is the size that exercises every boundary.
      for (let page = 0; page < DRAFTS.length + 2; page++) {
        const result = await listStages(actor, {
          sort: "date",
          direction,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(seen.length, `${direction}: every row came back`).toBe(DRAFTS.length);
      expect(new Set(seen).size, `${direction}: and none of them twice`).toBe(DRAFTS.length);
    }
  });

  it("pages in the same order the whole listing is in", async () => {
    // The order a cursor walks has to be the order one big page is in, or the
    // cursor is comparing against something the sort did not use.
    for (const direction of ["asc", "desc"] as const) {
      const whole = await listStages(actor, {
        sort: "date",
        direction,
        limit: 100,
      });
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < DRAFTS.length + 2; page++) {
        const result = await listStages(actor, {
          sort: "date",
          direction,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        walked.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      expect(walked, direction).toEqual(whole.items.map((item) => item.id));
    }
  });

  it("finds a payee whose spelling NFKC folds", async () => {
    // The filter compares against a value normalised in JavaScript, which folds
    // NFKC. The SQL side did not, so a payee holding a ligature — or a full-width
    // letter, or any of the presentation forms NFKC collapses — never matched and
    // the queue came back empty rather than saying why.
    const stored = "Caf\u00e9 \ufb01ne";
    await getDb()
      .insert(stagedTransactions)
      .values([
        {
          userId: actor.userId,
          id: "00000000-0000-4000-8000-0000000000ff",
          draft: { date: "2026-02-01", payee: stored },
          status: "staged" as const,
          validationIssues: [],
        },
      ]);
    const found = await listStages(actor, { payee: stored, limit: 50 });
    expect(found.items.map((item) => (item.draft as { payee?: string }).payee)).toContain(stored);
    // And the folded spelling finds it too, which is the same rule from the
    // other side.
    const folded = await listStages(actor, { payee: "Caf\u00e9 fine", limit: 50 });
    expect(folded.items.length, "the folded spelling matches as well").toBeGreaterThan(0);
  });
});
