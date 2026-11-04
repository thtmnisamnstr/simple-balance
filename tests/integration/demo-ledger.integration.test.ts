import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoLedgerMove, readDemoLedger } from "../../scripts/demo-ledger/rebase.mjs";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { listAccounts } from "../../src/server/services/accounts.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import { moveLedgerFile } from "../../src/server/services/ledger-file.js";
import type { Actor } from "../../src/shared/domain.js";
import type { LedgerFile } from "../../src/shared/ledger-file.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The demo ledger goes in whole, today.
 *
 * Everything that seeds a ledger here — the product kit's screenshots, a
 * design review, a smoke test — loads `scripts/demo-ledger/demo-ledger.json`
 * with a move, and a move writes every transaction or refuses the part. So a
 * change to a rule a move holds a file to, or to the format, that the
 * committed file no longer meets is found here rather than halfway through a
 * screenshot run. When this fails, the file is what needs saving again,
 * through the loop the README beside it describes.
 */
const connection = process.env.TEST_DATABASE_URL;
const database = scratchDatabase("demo_ledger");
const actor: Actor = { userId: "demo-ledger", source: "web" };
const committed = readDemoLedger() as LedgerFile;
// The server's day for a person who never chose a zone, which is the day a
// move's balance checks are read against for them.
const today = () => todayIn("UTC");

describe.skipIf(!connection)("the demo ledger", () => {
  beforeAll(async () => {
    await database.create();
    await getDb()
      .insert(user)
      .values({ id: actor.userId, name: "Alex Rivera", email: "alex@example.com" });
  });

  afterAll(async () => {
    await database.drop();
  });

  it("moves into a new sign-up's books today, every balance as the file says", async () => {
    const result = await moveLedgerFile(actor, demoLedgerMove({ today: today() }));
    const deleted = committed.entries.filter((entry) => entry.deleted === true).length;
    expect(result.written).toEqual({ entries: committed.entries.length - deleted, deleted });
    expect(result.staged).toBe(committed.staged.length);
    expect(result.balances?.checked).toBe(committed.accounts.length);

    const accounts = await listAccounts(actor, today());
    const held = Object.fromEntries(
      accounts.map((account) => [account.name, canonicalDecimal(account.balance)]),
    );
    const said = Object.fromEntries(
      committed.accounts.map((account) => [
        account.name,
        account.detail === "full" ? account.balance : undefined,
      ]),
    );
    expect(held).toEqual(said);
  });

  it("replays rather than writing twice when it is loaded again the same day", async () => {
    const again = await moveLedgerFile(actor, demoLedgerMove({ today: today() }));
    expect(again.written.entries + again.written.deleted).toBe(committed.entries.length);
    expect(await listAccounts(actor, today())).toHaveLength(committed.accounts.length);
  });
});
