import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { stageCsv } from "../../src/server/services/import-export.js";
import { listStages } from "../../src/server/services/staging.js";
import { createTransaction } from "../../src/server/services/transactions.js";

/**
 * What the import REPORTS about payees agrees with what it stored.
 *
 * `csv.md` §11: "the preview shows the first rows as they will be interpreted",
 * so a right preview and a wrong import is a bug rather than a surprise. And
 * §9: `referenceResolution` reports every payee as `existing` or `new` before
 * anything is committed.
 *
 * `canonicalizeImportedPayees` opened its loop with `if (!row.draft) continue;`,
 * so it read and rewrote only the rows that became a draft. A row whose date or
 * amount will not parse stages as a `partial` instead — the queue exists to fix
 * exactly those — and so does a transfer out of one of our own exports, because
 * an import names one account and a transfer needs two. An unreadable date is
 * the fixture here because it needs no second account to set up, and the loop
 * that was wrong never looked at why a row had no draft.
 * This is the identical defect the guide already records having fixed one field
 * over, for categories: "Including on a transfer, which stages as a partial
 * rather than a draft and had its category silently dropped until the resolver
 * learned to look there." The category resolver learned; the payee
 * canonicalizer did not.
 *
 * The STORED row was right all along, because `insertImportedStages` runs every
 * draft through `canonicalizeStagedDraftPayee` including a partial. The
 * reported row was not, and the two are built at different moments —
 * `preview.sample` is assembled before the insert. So the panel and the MCP
 * sample showed the file's spelling while the queue held the ledger's, and a
 * file of nothing but transfers reported "0 matched and 0 new" while creating
 * payees.
 *
 * `ACME  Co` with two interior spaces is the fixture because the round-trip
 * JSON validates with `z.string().trim()`, which collapses nothing in the
 * middle: only `cleanHumanName` does, and only on the path under test.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("import_partial_payees");
const actor: Actor = { userId: "import-partial-payees", source: "web" };

let checkingId = "";

integration("what an import reports about a payee on a row that is not a draft", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Partial Payees",
      email: "import-partial-payees@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Partial Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    // The spelling the ledger already uses, so the canonicalizer has something
    // to rewrite towards rather than inventing one.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Acme Co",
        description: null,
        fromAccountId: checkingId,
        amount: "5.00",
      },
      "import-partial-payees-seed",
    );
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  });

  it("canonicalizes the payee on a row that could not be assembled into a draft", async () => {
    const preview = await stageCsv(actor, {
      csv: ["date,payee,description,amount", "not a date,ACME  Co,Moved,-100.00"].join("\n"),
      fileName: "unreadable-date.csv",
      idempotencyKey: "import-partial-payees-dry",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "payee",
        description: "description",
        amount: "amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: true,
    });

    // The row really is a partial: if it ever becomes a draft this test is
    // examining the case that was already right.
    const [row] = preview.sample as { draft: unknown; partial?: Record<string, unknown> }[];
    expect(row, "nothing was sampled, so nothing was checked").toBeDefined();
    expect(row!.draft, "this row stages as a draft now, so it proves nothing").toBeNull();

    const reportedPayee = (row!.partial as { payee?: unknown } | undefined)?.payee;
    expect(reportedPayee).toBe("Acme Co");
    expect(preview.referenceResolution.payees).toEqual([
      { inputPayee: "ACME Co", resolvedPayee: "Acme Co", resolution: "existing" },
    ]);
  }, 60_000);

  it("stores what it reported", async () => {
    await stageCsv(actor, {
      csv: ["date,payee,description,amount", "also not a date,ACME  Co,Moved again,-100.00"].join(
        "\n",
      ),
      fileName: "unreadable-date-live.csv",
      idempotencyKey: "import-partial-payees-live",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "payee",
        description: "description",
        amount: "amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: false,
    });

    // The queue was always right. This is the half the report has to agree
    // with, and asserting it here is what makes the test above a comparison
    // rather than a restatement of whatever the canonicalizer happens to do.
    const staged = await listStages(actor, { limit: 50 });
    const stored = staged.items.map(
      (one) => (one.draft as { payee?: unknown; description?: unknown }).payee,
    );
    expect(stored).toContain("Acme Co");
    expect(stored).not.toContain("ACME  Co");
  }, 60_000);
});
