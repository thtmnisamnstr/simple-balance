import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import {
  parseLedgerFileText,
  serializeLedgerFile,
  splitLedgerFile,
  type LedgerFile,
} from "../../src/shared/ledger-file.js";
import type { LedgerFileMoveResult } from "../../src/shared/ledger-file-move.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";
import { LEDGER_FILE_HISTORY_MAX_BYTES } from "../../src/server/config-limits.js";
import { getDb } from "../../src/server/db/client.js";
import { ledgerAccounts, user } from "../../src/server/db/schema.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import { AppError } from "../../src/server/services/errors.js";
import { canonicalDecimal } from "../../src/server/services/helpers.js";
import {
  exportLedgerFile,
  moveLedgerFile,
  previewLedgerFile,
} from "../../src/server/services/ledger-file.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The edges of moving a Simple Balance file that only a real database shows:
 * a file's archive instant that names a moment still to come; a ledger moved a
 * date range at a time, which is the only way an agent can move one larger
 * than a call carries; an account whose range ends before it opens; one
 * account's file moved after another's, whose transfers came with the first;
 * and an account here the same as the file's in every field that holds
 * another ledger's transactions. Each either moves and comes out as the
 * ledger it came from, or is refused before anything is written, with a
 * sentence that names what to do.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger_file_move_edges");
const LIMITS = { maxRows: 100_000, maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES };
const TIMEZONE = "Europe/Berlin";

const person = (id: string): Actor => ({ userId: `lf-move-edge-${id}`, source: "web" });

async function seed(...actors: Actor[]) {
  for (const actor of actors) {
    await getDb()
      .insert(user)
      .values({ id: actor.userId, name: actor.userId, email: `${actor.userId}@example.com` });
    await setPreferences(actor, { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "light" });
  }
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("it was not refused");
}

const move = (
  actor: Actor,
  ledgerFile: string,
  extra: Record<string, unknown> = {},
): Promise<LedgerFileMoveResult> =>
  moveLedgerFile(actor, {
    ledgerFile,
    fileName: "edges.json",
    idempotencyKey: randomUUID(),
    ...extra,
  });

const account = (actor: Actor, name: string, openingDate: string, openingBalance: string) =>
  createAccount(actor, { name, type: "checking", currency: "EUR", openingDate, openingBalance });

const pay = (actor: Actor, from: string, date: string, amount: string, payee = "Shop") =>
  createTransaction(
    actor,
    { type: "withdrawal", date, payee, fromAccountId: from, amount } as never,
    randomUUID(),
  );

const receive = (actor: Actor, to: string, date: string, amount: string, payee = "Employer") =>
  createTransaction(
    actor,
    { type: "deposit", date, payee, toAccountId: to, amount } as never,
    randomUUID(),
  );

const transfer = (actor: Actor, from: string, to: string, date: string, amount: string) =>
  createTransaction(
    actor,
    {
      type: "transfer",
      date,
      payee: "Sweep",
      fromAccountId: from,
      toAccountId: to,
      sourceAmount: amount,
    } as never,
    randomUUID(),
  );

/** One account's postings up to a day, closing pairs included unless asked otherwise. */
async function balanceOn(actor: Actor, name: string, day: string, closings = true) {
  const result = await getDb().execute(sql`
    select coalesce(sum(p.amount), 0)::text as total
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
     where p.user_id = ${actor.userId} and a.name = ${name} and a.system_kind is null
       and p.date <= ${day}::date
       and (${closings} or p.closing_account_id is null)
  `);
  return canonicalDecimal(String((result.rows[0] as { total: string }).total));
}

/** Every account's postings netted by day, closing pairs included, by account name. */
async function postingsByDay(actor: Actor) {
  const result = await getDb().execute(sql`
    select a.name as account, p.date::text as day, sum(p.amount)::text as total
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
     where p.user_id = ${actor.userId} and a.system_kind is null
     group by 1, 2
    having sum(p.amount) <> 0
     order by 1, 2
  `);
  return (result.rows as { account: string; day: string; total: string }[]).map(
    (row) => `${row.account} ${row.day} ${canonicalDecimal(row.total)}`,
  );
}

async function counted(actor: Actor) {
  const result = await getDb().execute(sql`
    select
      (select count(*) from ledger_account where user_id = ${actor.userId})::int as accounts,
      (select count(*) from ledger_transaction where user_id = ${actor.userId})::int as entries,
      (select count(*) from posting where user_id = ${actor.userId})::int as postings
  `);
  return result.rows[0];
}

async function accountsOf(actor: Actor) {
  const rows = await getDb()
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)));
  return new Map(rows.map((row) => [row.name, row]));
}

function read(text: string): LedgerFile {
  const parsed = parseLedgerFileText(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.file;
}

integration("the edges of moving a Simple Balance file", () => {
  beforeAll(async () => {
    await database.create();
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it("closes an account a file says was archived in the future today, as it holds nothing then", async () => {
    const source = person("future-source");
    const moved = person("future-moved");
    await seed(source, moved);
    const kept = await account(source, "Checking", "2026-01-01", "100");
    const closed = await account(source, "Old card", "2026-01-01", "40");
    await pay(source, String(closed.id), "2026-02-01", "15");
    await pay(source, String(kept.id), "2026-02-02", "5");
    await setAccountArchived(source, String(closed.id), Number(closed.version), true);
    const exported = read(
      (await exportLedgerFile(source, { kinds: ["preferences", "accounts", "entries"] }, LIMITS))
        .ledgerFile,
    );
    // Edited by hand, or exported by a copy whose clock runs ahead.
    const tampered = serializeLedgerFile({
      ...exported,
      accounts: exported.accounts.map((each) =>
        each.key === "Old card" && each.detail === "full"
          ? { ...each, archivedAt: "2099-01-01T00:00:00.000Z" }
          : each,
      ),
    });
    const result = await move(moved, tampered);
    expect(result.balances).toEqual({ checked: 1, notCompared: 1 });
    const card = (await accountsOf(moved)).get("Old card")!;
    expect(card.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // Closed today, as it was where it came from: on every day the two hold
    // the same, so nothing archived holds money a total leaves out.
    const today = todayIn(TIMEZONE);
    expect(await balanceOn(moved, "Old card", today)).toBe("0");
    expect(await postingsByDay(moved)).toEqual(await postingsByDay(source));

    // The service holds any caller to it, not only the import.
    await expect(
      createAccount(
        moved,
        {
          name: "Later",
          type: "cash",
          currency: "EUR",
          openingDate: "2026-01-01",
          openingBalance: "0",
        },
        undefined,
        { arriveArchived: true, archivedAt: new Date("2099-01-01T00:00:00.000Z") },
      ),
    ).rejects.toThrow("An archive instant cannot be later than now");
  });

  it("moves a ledger a date range at a time into the accounts the earlier range brought", async () => {
    const source = person("ranges-source");
    const moved = person("ranges-moved");
    const skipped = person("ranges-skipped");
    await seed(source, moved, skipped);
    const checking = String((await account(source, "Checking", "2024-12-01", "1000")).id);
    // Opened inside the first range, with money dated before that range.
    const savings = String((await account(source, "Savings", "2025-06-01", "50")).id);
    await receive(source, savings, "2024-12-15", "30");
    for (const day of ["2025-03-01", "2025-09-01", "2026-02-01", "2026-05-01"]) {
      await pay(source, checking, day, "100");
    }
    await transfer(source, checking, savings, "2025-07-01", "20");
    await transfer(source, checking, savings, "2026-03-01", "10");
    const range = async (start: string, end?: string) =>
      (
        await exportLedgerFile(
          source,
          { kinds: ["accounts", "entries"], start, ...(end === undefined ? {} : { end }) },
          LIMITS,
        )
      ).ledgerFile;
    const first = await range("2025-01-01", "2025-12-31");
    const second = await range("2026-01-01");

    const a = await move(moved, first);
    expect(a.balances).toEqual({ checked: 2, notCompared: 0 });
    // The second range's accounts open on its first day at what they carried
    // in, so they differ from the ones the first range made, and using those
    // is still offered: it is the only way the ranges add up.
    const preview = await previewLedgerFile(moved, { ledgerFile: second });
    for (const key of ["Checking", "Savings"]) {
      expect(preview.movePlan.records.find((each) => each.key === key)).toMatchObject({
        outcome: "duplicate",
        choices: ["use_existing", "rename"],
      });
    }
    const use = [
      { kind: "account", key: "Checking", action: "use_existing" },
      { kind: "account", key: "Savings", action: "use_existing" },
    ];
    const b = await move(moved, second, { decisions: use });
    expect(b.balances).toEqual({ checked: 2, notCompared: 0 });
    // The books are the source's: every balance from the first range's first
    // day on, and today's, with nothing counted twice.
    const today = todayIn(TIMEZONE);
    for (const day of ["2025-06-30", "2025-12-31", "2026-04-01", today]) {
      for (const name of ["Checking", "Savings"]) {
        expect(await balanceOn(moved, name, day), `${name} ${day}`).toBe(
          await balanceOn(source, name, day),
        );
      }
    }
    expect(await balanceOn(moved, "Checking", today)).toBe("570");
    expect(await balanceOn(moved, "Savings", today)).toBe("110");
    expect([...(await accountsOf(moved)).keys()].sort()).toEqual(["Checking", "Savings"]);

    // The second range without the first, into accounts that open as the
    // first range made them: the balance check is what notices, and it names
    // the file before this one as the likely cause.
    await account(skipped, "Checking", "2025-01-01", "1000");
    await account(skipped, "Savings", "2025-06-01", "80");
    const before = await counted(skipped);
    const refused = await refusal(move(skipped, second, { decisions: use }));
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toMatch(
      /^After the move, "Checking" would hold 790 EUR on \d{4}-\d{2}-\d{2}, and the file says 570 EUR: 220 EUR more than the file\. 2 accounts disagree in all\. Nothing was written\. This file starts on 2026-01-01, so a file covering the days before it may have to be moved in first\./,
    );
    // An agent with one part is never sent looking for earlier parts of it.
    expect(refused.agentMessage).toContain(
      'This file starts on 2026-01-01, so a file covering the days before it may have to be moved in first: move that file first, then this one again. Otherwise, "Checking" here holds',
    );
    expect(refused.agentMessage).not.toContain("earlier part");
    expect(refused.details).toMatchObject({ key: "Checking", difference: "220", count: 2 });
    expect(await counted(skipped)).toEqual(before);
  });

  it("moves a range that ends before an account opens, with money carried from before it", async () => {
    const source = person("opens-later-source");
    const moved = person("opens-later-moved");
    await seed(source, moved);
    const checking = String((await account(source, "Checking", "2026-06-01", "100")).id);
    // Dated before the account opened, which nothing stops, and before the range.
    await pay(source, checking, "2026-01-10", "20");
    await pay(source, checking, "2026-04-15", "5");
    const file = (
      await exportLedgerFile(
        source,
        { kinds: ["accounts", "entries"], start: "2026-03-01", end: "2026-05-31" },
        LIMITS,
      )
    ).ledgerFile;
    expect(read(file).accounts[0]).toMatchObject({
      carriedForward: { date: "2026-03-01", amount: "-20" },
      balance: "-25",
    });
    const preview = await previewLedgerFile(moved, { ledgerFile: file });
    expect(preview.movePlan.move!.checks).toEqual([
      { key: "Checking", name: "Checking", currency: "EUR", balance: "-25", compared: false },
    ]);
    const result = await move(moved, file);
    expect(result.balances).toEqual({ checked: 0, notCompared: 1 });
    // From its opening on it holds what it holds where it came from.
    const today = todayIn(TIMEZONE);
    expect(await balanceOn(moved, "Checking", today)).toBe("75");
    expect(await balanceOn(moved, "Checking", today)).toBe(
      await balanceOn(source, "Checking", today),
    );
  });

  it("refuses one account's file after another's brought its transfers, before writing anything", async () => {
    const source = person("pair-source");
    const moved = person("pair-moved");
    await seed(source, moved);
    const checking = await account(source, "Checking", "2026-01-01", "1000");
    const savings = await account(source, "Savings", "2026-01-01", "500");
    await pay(source, String(checking.id), "2026-02-01", "50");
    await transfer(source, String(checking.id), String(savings.id), "2026-02-02", "100");
    const fileOf = async (id: string) =>
      (await exportLedgerFile(source, { kinds: ["accounts", "entries"], accountIds: [id] }, LIMITS))
        .ledgerFile;
    // Checking's file first: Savings comes from its name alone, at zero,
    // holding the transfer.
    await move(moved, await fileOf(String(checking.id)), {
      decisions: [{ kind: "account", key: "Savings", action: "create" }],
    });
    const savingsFile = await fileOf(String(savings.id));
    const preview = await previewLedgerFile(moved, { ledgerFile: savingsFile });
    expect(preview.move.qualifies).toBe(true);
    expect(preview.rows.alreadyHereOn).toEqual({ Checking: 1, Savings: 1 });
    // Bringing it in under another name is the only answer left, and no name
    // makes it work, so the preview says so before it is given.
    expect(preview.movePlan.records.find((each) => each.key === "Savings")).toMatchObject({
      outcome: "duplicate",
      choices: ["rename"],
    });
    expect(preview.movePlan.problems).toContainEqual(
      expect.objectContaining({ field: "move", kind: "account", key: "Savings", count: 1 }),
    );
    const before = await counted(moved);
    const refused = await refusal(
      move(moved, savingsFile, {
        decisions: [{ kind: "account", key: "Savings", action: "rename", name: "Savings (bank)" }],
      }),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(refused.message).toBe(
      "One of this file's transactions on \"Savings\" is already here, on another account, from a file brought in before. A move passes over a transaction already here, so an account brought in under another name would not hold it and could never come out at the file's balance. Add this file instead, which sends its transactions to Staged for review.",
    );
    expect(refused.agentMessage).toBe(
      "One of this file's transactions on \"Savings\" is already here, on another account, from a file brought in before. A move passes over a transaction already here, so an account brought in under another name would not hold it and could never come out at the file's balance. Call add_ledger_file with this file instead; its transactions go to Staged for review.",
    );
    expect(refused.details).toMatchObject({ count: 1 });
    expect(await counted(moved)).toEqual(before);
  });

  it("asks before writing into an account the same as the file's that holds another ledger's", async () => {
    const first = person("same-first");
    const second = person("same-second");
    const moved = person("same-moved");
    const parted = person("same-parted");
    await seed(first, second, moved, parted);
    const a = String((await account(first, "Checking", "2026-01-01", "100")).id);
    await receive(first, a, "2026-02-01", "50");
    const c = String((await account(second, "Checking", "2026-01-01", "100")).id);
    await receive(second, c, "2026-02-03", "20");
    await receive(second, c, "2026-02-04", "7");
    const exported = async (actor: Actor) =>
      (await exportLedgerFile(actor, { kinds: ["accounts", "entries"] }, LIMITS)).ledgerFile;
    const fileA = await exported(first);
    const fileC = await exported(second);
    await move(moved, fileA);
    await move(parted, fileA);

    // Everything here came from a file, so the ledger still qualifies, and the
    // two accounts agree in every field; what tells them apart is what the
    // one here holds.
    const preview = await previewLedgerFile(moved, { ledgerFile: fileC });
    expect(preview.move.qualifies).toBe(true);
    expect(preview.rows.heldHere).toEqual({ Checking: { entries: 1, fromFile: 0 } });
    expect(preview.movePlan.records.find((each) => each.key === "Checking")).toMatchObject({
      outcome: "duplicate",
      choices: ["rename"],
      action: "undecided",
    });
    expect(preview.movePlan.problems).toEqual([
      expect.objectContaining({ field: "decisions", kind: "account", key: "Checking", held: 1 }),
    ]);
    const before = await counted(moved);
    expect((await refusal(move(moved, fileC))).code).toBe("VALIDATION_ERROR");
    expect(await counted(moved)).toEqual(before);
    const rename = [{ kind: "account", key: "Checking", action: "rename", name: "Checking (C)" }];
    const done = await move(moved, fileC, { decisions: rename });
    expect(done.balances).toEqual({ checked: 1, notCompared: 0 });
    expect(await balanceOn(moved, "Checking", "2026-10-01")).toBe("150");
    expect(await balanceOn(moved, "Checking (C)", "2026-10-01")).toBe("127");

    // In parts, each part keeps the answer the whole file gave, which none of
    // them can see on its own: the first makes the copy and the second lands
    // in it, so the parts already written never split from the rest.
    const split = splitLedgerFile(read(fileC), { maxRows: 1, maxBytes: 1_000_000 });
    if (!split.ok) throw new Error(split.message);
    expect(split.parts).toHaveLength(2);
    for (const [at, part] of split.parts.entries()) {
      await move(parted, serializeLedgerFile(part), {
        decisions: rename,
        part: { index: at + 1, count: 2 },
      });
    }
    expect(await balanceOn(parted, "Checking", "2026-10-01")).toBe("150");
    expect(await balanceOn(parted, "Checking (C)", "2026-10-01")).toBe("127");
  });
});
