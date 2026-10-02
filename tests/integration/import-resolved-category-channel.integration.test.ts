import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { stagedTransactions, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { stageCsv } from "../../src/server/services/import-export.js";
import {
  APP_CSV_COLUMNS,
  APP_CSV_FORMAT,
  APP_CSV_LEGS_COLUMN,
  rowsToCsv,
} from "../../src/shared/csv.js";
import type { Actor } from "../../src/shared/domain.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * `csv.md` §9: a resolved row carries an id or a name, never both.
 *
 * The guide marks it unchecked and says exactly what holds it: "`assign` and
 * `writeTarget` in `resolveImportedCategories` clearing `categoryName` alongside
 * every id they write, and by nothing else". Two call sites and a convention.
 *
 * The defect it prevents is invisible until somebody's categories come back. A
 * staged row holding both answers has the name re-applied at commit, so a mass
 * edit that cleared the category across four hundred imported rows is undone
 * the moment they commit — silently, with no refusal, no issue badge and
 * nothing on the screen that changed. By then the edit looks like it worked.
 *
 * Three shapes, because the clearing happens in three places and the guide's
 * sentence covers all of them: a name the importer resolved, an id the file
 * carried alongside a name, and a split leg, which resolves through its own
 * branch.
 */
const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const scratch = scratchDatabase("category_channel");
const actor: Actor = { userId: "category-channel-user", source: "web" };

integration("a staged row whose category resolved", () => {
  let accountId = "";
  let groceriesId = "";

  beforeAll(async () => {
    await scratch.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Category Channel",
      email: "category-channel@example.com",
      emailVerified: true,
    });
    accountId = (
      await createAccount(actor, {
        name: "Channel Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    groceriesId = (await createCategory(actor, { name: "Groceries", kind: "expense" })).id;
  });

  afterAll(async () => {
    await scratch.drop();
  });

  /**
   * One row of this product's own export, which is the only shape that can
   * carry a category id at all: a mapped bank file has no such column, and
   * `csvMappingSchema` offers no way to name one.
   */
  const appExport = (row: Record<string, unknown>) => {
    // Every column, blank where this row says nothing. `rowsToCsv` takes its
    // header line from the first row's keys, and `isAppExportCsv` wants the
    // whole set present — a file carrying only the columns under test is read
    // as a foreign bank file and refused for having no mapping.
    const blank = Object.fromEntries(
      [...APP_CSV_COLUMNS, APP_CSV_LEGS_COLUMN].map((column) => [column, ""]),
    );
    return rowsToCsv([{ ...blank, simple_balance_format: APP_CSV_FORMAT, ...row }]);
  };

  /**
   * The ids one `stageCsv` call staged.
   *
   * The return type is a union because the same function previews without
   * staging, and a preview has no ids. Narrowed with an assertion rather than a
   * cast: a call that quietly previewed would otherwise read as a batch of no
   * rows, and every assertion below would pass by examining nothing.
   */
  const stagedIdsOf = (outcome: Awaited<ReturnType<typeof stageCsv>>) => {
    expect("stagedIds" in outcome, "the call staged rather than previewed").toBe(true);
    return (outcome as { stagedIds: string[] }).stagedIds;
  };

  /** Every staged row of one import batch, as the table holds it. */
  const draftsOf = async (stagedIds: readonly string[]) => {
    const rows = await Promise.all(
      stagedIds.map(async (id) =>
        getDb().select().from(stagedTransactions).where(eq(stagedTransactions.id, id)).limit(1),
      ),
    );
    return rows.map((found) => found[0]!.draft as Record<string, unknown>);
  };

  it("carries the id and not the name it was resolved from", async () => {
    const staged = await stageCsv(actor, {
      csv: ["date,payee,category,amount", "2026-03-14,Corner Shop,Groceries,-12.34"].join("\n"),
      fileName: "named-category.csv",
      idempotencyKey: "channel-named",
      defaultAccountId: accountId,
      mapping: { date: "date", payee: "payee", category: "category", amount: "amount" },
    });

    const [draft] = await draftsOf(stagedIdsOf(staged));
    expect(draft!.categoryId, "the name resolved to the category this ledger owns").toBe(
      groceriesId,
    );
    // Absent rather than empty: an empty string is a value the commit would
    // read, and the point is that there is nothing left to re-apply.
    expect(draft!.categoryName, "one answer, not two").toBeUndefined();
  });

  it("drops a name the file sent beside an id this ledger owns", async () => {
    // The app's own export writes both columns — the id for us and the name for
    // whoever opens the file — so this is the ordinary shape of a re-import
    // rather than a malformed file, and it is the branch `writeTarget` exists
    // for. The name is deliberately a different spelling, so a draft that kept
    // it would be visibly keeping the file's word over the ledger's.
    const staged = await stageCsv(actor, {
      csv: appExport({
        transaction_type: "withdrawal",
        date: "2026-03-15",
        payee: "Corner Shop",
        category_id: groceriesId,
        category_name: "Food shopping",
        source_account_name: "Channel Checking",
        source_amount: "9.99",
        source_currency: "USD",
      }),
      fileName: "id-and-name.csv",
      idempotencyKey: "channel-id-and-name",
      defaultAccountId: accountId,
    });

    const [draft] = await draftsOf(stagedIdsOf(staged));
    expect(draft!.categoryId, "the ledger's own id wins").toBe(groceriesId);
    expect(draft!.categoryName, "and the file's spelling of it goes").toBeUndefined();
  });

  it("clears the name on a split leg too", async () => {
    const legs = JSON.stringify([
      { amount: "5.00", categoryName: "Groceries" },
      { amount: "7.34", categoryName: "Groceries" },
    ]);
    const staged = await stageCsv(actor, {
      csv: appExport({
        transaction_type: "withdrawal",
        date: "2026-03-16",
        payee: "Corner Shop",
        [APP_CSV_LEGS_COLUMN]: legs,
        source_account_name: "Channel Checking",
        source_amount: "12.34",
        source_currency: "USD",
      }),
      fileName: "split-legs.csv",
      idempotencyKey: "channel-split",
      defaultAccountId: accountId,
    });

    const [draft] = await draftsOf(stagedIdsOf(staged));
    const resolved = draft!.legs as { categoryId?: unknown; categoryName?: unknown }[];
    expect(resolved, "the file staged a split").toHaveLength(2);
    for (const leg of resolved) {
      expect(leg.categoryId, "both legs land on the one category").toBe(groceriesId);
      expect(leg.categoryName, "and neither keeps the name").toBeUndefined();
    }
  });
});
