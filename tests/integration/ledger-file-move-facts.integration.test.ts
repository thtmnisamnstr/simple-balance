import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { defaultLedgerFileKinds, parseLedgerFileText } from "../../src/shared/ledger-file.js";
import { LEDGER_FILE_MOVE_BLOCKED } from "../../src/shared/ledger-file-import.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import { stagedTransactions, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  addLedgerFile,
  exportLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { commitStages, deleteStages } from "../../src/server/services/staging.js";
import {
  createTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * What a preview reads for a move, against a real database: whether the
 * ledger may take one, which of a file's deleted entries are already here, and
 * which of its entries are here only as rows still waiting in Staged. The move
 * itself is not built yet; these are the facts its plan stands on, and the
 * reads behind them are the move's own.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_move_facts");
const LIMITS = { maxRows: 100_000, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };
const everything = { kinds: defaultLedgerFileKinds.filter((kind) => kind !== "history") };

const person = (id: string): Actor => ({ userId: `lf-move-${id}`, source: "web" });
const source = person("source");
const empty = person("empty");
const typed = person("typed");
const pending = person("pending");

let file = "";

integration("what a preview reads for a move", () => {
  beforeAll(async () => {
    await database.create();
    for (const actor of [source, empty, typed, pending]) {
      await getDb()
        .insert(user)
        .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
    }
    const account = await createAccount(source, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    const deposit = (payee: string, amount: string) =>
      createTransaction(
        source,
        {
          type: "deposit",
          date: "2026-02-01",
          toAccountId: String(account.id),
          amount,
          payee,
          description: null,
        },
        randomUUID(),
      );
    await deposit("Employer", "1000");
    await deposit("Refund", "20");
    const gone = await deposit("Mistake", "5");
    await setTransactionDeleted(source, String(gone.id), Number(gone.version), true);
    file = (await exportLedgerFile(source, everything, LIMITS)).ledgerFile;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("finds the ledger a file came from holding entries of its own, deleted one included", async () => {
    const preview = await previewLedgerFile(source, { ledgerFile: file });
    expect(preview.move).toEqual({ qualifies: false, reason: LEDGER_FILE_MOVE_BLOCKED });
    // The two live entries are on Checking. What each account here holds is
    // not read where no move is possible, which is every busy ledger.
    expect(preview.rows).toEqual({
      alreadyHere: 2,
      stagedAlreadyHere: 0,
      deletedAlreadyHere: 1,
      waiting: 0,
      alreadyHereOn: { Checking: 2 },
      heldHere: {},
    });
    expect(preview.movePlan.problems[0]).toEqual({
      field: "move",
      message: LEDGER_FILE_MOVE_BLOCKED,
    });
  });

  it("never counts as waiting an origin that is in the books as well", async () => {
    const parsed = parseLedgerFileText(file);
    if (!parsed.ok) throw new Error("the export did not read back");
    const live = parsed.file.entries.find((entry) => !entry.deleted)!;
    // A row and an entry under one origin is the race the unique indexes and
    // the one-statement lookup are there for; written directly, because no
    // service will write it.
    await getDb()
      .insert(stagedTransactions)
      .values({ userId: source.userId, draft: {}, importOrigin: live.id });
    const preview = await previewLedgerFile(source, { ledgerFile: file });
    expect(preview.rows).toMatchObject({ alreadyHere: 2, waiting: 0 });
    await getDb().delete(stagedTransactions).where(eq(stagedTransactions.userId, source.userId));
  });

  it("counts a deleted entry waiting in Staged as waiting too", async () => {
    const parsed = parseLedgerFileText(file);
    if (!parsed.ok) throw new Error("the export did not read back");
    const deleted = parsed.file.entries.find((entry) => entry.deleted)!;
    await getDb()
      .insert(stagedTransactions)
      .values({ userId: pending.userId, draft: {}, importOrigin: deleted.id });
    const preview = await previewLedgerFile(pending, { ledgerFile: file });
    expect(preview.rows).toEqual({
      alreadyHere: 0,
      stagedAlreadyHere: 0,
      deletedAlreadyHere: 1,
      waiting: 1,
      alreadyHereOn: {},
      heldHere: {},
    });
    expect(preview.movePlan.problems[0]).toMatchObject({ field: "move", count: 1 });
  });

  it("lets an empty ledger take a move, and counts what an add left waiting", async () => {
    const before = await previewLedgerFile(empty, { ledgerFile: file });
    expect(before.move.qualifies).toBe(true);
    expect(before.rows).toEqual({
      alreadyHere: 0,
      stagedAlreadyHere: 0,
      deletedAlreadyHere: 0,
      waiting: 0,
      alreadyHereOn: {},
      heldHere: {},
    });
    expect(before.movePlan.ok).toBe(true);
    expect(before.movePlan.move).toMatchObject({ toWrite: 2, toVoid: 1 });

    await addLedgerFile(empty, {
      ledgerFile: file,
      fileName: "simple-balance.json",
      idempotencyKey: randomUUID(),
    });
    // Staged by an add, with their origins, so the ledger still holds nothing
    // that did not come from a file; but a move would skip them and come out
    // short, so it is refused until they are dealt with.
    const staged = await previewLedgerFile(empty, { ledgerFile: file });
    expect(staged.move.qualifies).toBe(true);
    expect(staged.rows).toMatchObject({ alreadyHere: 2, deletedAlreadyHere: 0, waiting: 2 });
    // Waiting in Staged is on no account yet, so none of them is counted on
    // one, and the account the add made holds nothing.
    expect(staged.rows.alreadyHereOn).toEqual({});
    expect(staged.rows.heldHere).toEqual({});
    expect(staged.movePlan.problems[0]).toMatchObject({ field: "move", count: 2 });

    const rows = await getDb()
      .select()
      .from(stagedTransactions)
      .where(
        and(eq(stagedTransactions.userId, empty.userId), eq(stagedTransactions.status, "staged")),
      );
    const [first, second] = rows;
    await commitStages(empty, {
      stagedIds: [first!.id],
      expectedVersions: { [first!.id]: first!.version },
      idempotencyKey: randomUUID(),
    });
    await deleteStages(empty, {
      stagedIds: [second!.id],
      expectedVersions: { [second!.id]: second!.version },
    });
    // One is in the books now and one was discarded: neither is waiting, and
    // only the committed one is already here.
    const settled = await previewLedgerFile(empty, { ledgerFile: file });
    expect(settled.move.qualifies).toBe(true);
    // The committed one is on Checking, which holds it and nothing else, all
    // of it from this file.
    expect(settled.rows).toMatchObject({
      alreadyHere: 1,
      waiting: 0,
      alreadyHereOn: { Checking: 1 },
      heldHere: { Checking: { entries: 1, fromFile: 1 } },
    });
    expect(settled.movePlan.move).toMatchObject({ toWrite: 1, toVoid: 1, alreadyHere: 1 });
  });

  it("stops offering a move once somebody types a transaction in", async () => {
    const account = await createAccount(typed, {
      name: "Wallet",
      type: "cash",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    expect((await previewLedgerFile(typed, { ledgerFile: file })).move.qualifies).toBe(true);
    const entry = await createTransaction(
      typed,
      {
        type: "withdrawal",
        date: "2026-03-01",
        fromAccountId: String(account.id),
        amount: "3",
        payee: "Kiosk",
        description: null,
      },
      randomUUID(),
    );
    await setTransactionDeleted(typed, String(entry.id), Number(entry.version), true);
    // Deleted, and still somebody having typed into this ledger.
    const preview = await previewLedgerFile(typed, { ledgerFile: file });
    expect(preview.move).toEqual({ qualifies: false, reason: LEDGER_FILE_MOVE_BLOCKED });
    expect(preview.movePlan.ok).toBe(false);
  });
});
