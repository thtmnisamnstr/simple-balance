import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { auditEvents, ledgerAccounts, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccountBalances,
  setAccountArchived,
  updateAccount,
} from "../../src/server/services/accounts.js";
import { createStage } from "../../src/server/services/staging.js";
import {
  createTransaction,
  getTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("account_balances");
const first: Actor = { userId: "balance-snapshot-first", source: "web" };
const second: Actor = { userId: "balance-snapshot-second", source: "web" };

integration("account balance snapshots", () => {
  let accountId: string;

  beforeAll(async () => {
    await database.create();
    const db = getDb();
    await db.execute(sql`delete from auth_user where id in (${first.userId}, ${second.userId})`);
    await db.insert(user).values([
      {
        id: first.userId,
        name: "Balance Snapshot First",
        email: "balance-snapshot-first@example.com",
        emailVerified: true,
      },
      {
        id: second.userId,
        name: "Balance Snapshot Second",
        email: "balance-snapshot-second@example.com",
        emailVerified: true,
      },
    ]);

    const account = await createAccount(first, {
      name: "Boundary Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2020-01-01",
      openingBalance: "100",
    });
    accountId = account.id;

    await createTransaction(
      first,
      {
        type: "deposit",
        date: "2020-01-09",
        payee: "Before range",
        description: "Before range",
        toAccountId: accountId,
        amount: "10",
      },
      "balance-before-range",
    );
    await createTransaction(
      first,
      {
        type: "deposit",
        date: "2020-01-10",
        payee: "On start date",
        description: "On start date",
        toAccountId: accountId,
        amount: "20",
      },
      "balance-on-start",
    );
    await createTransaction(
      first,
      {
        type: "withdrawal",
        date: "2020-01-20",
        payee: "On end date",
        description: "On end date",
        fromAccountId: accountId,
        amount: "5",
      },
      "balance-on-end",
    );
    await createTransaction(
      first,
      {
        type: "deposit",
        date: "2020-01-21",
        payee: "After range",
        description: "After range",
        toAccountId: accountId,
        amount: "40",
      },
      "balance-after-range",
    );
    const deleted = await createTransaction(
      first,
      {
        type: "deposit",
        date: "2020-01-15",
        payee: "Deleted transaction",
        description: "Deleted transaction",
        toAccountId: accountId,
        amount: "999",
      },
      "balance-deleted",
    );
    await setTransactionDeleted(first, deleted.id, deleted.version, true);
    await createTransaction(
      first,
      {
        type: "deposit",
        date: "9999-12-31",
        payee: "Future transaction",
        description: "Future transaction",
        toAccountId: accountId,
        amount: "1000",
      },
      "balance-future",
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it("treats the opening date as the first inclusive ending-balance date", async () => {
    const balances = await getAccountBalances(first, accountId, {
      start: "2020-01-01",
      end: "2020-01-01",
    });

    expect(balances.beginning.balance).toBe("0");
    expect(balances.ending.balance).toBe("100");
  });

  it("uses strict start and inclusive end boundaries", async () => {
    const balances = await getAccountBalances(first, accountId, {
      start: "2020-01-10",
      end: "2020-01-20",
    });

    expect(balances.beginning.balance).toBe("110");
    expect(balances.ending.balance).toBe("125");
    expect(balances.ending.balancePresentation).toEqual({
      label: "Balance",
      amount: "125",
    });
  });

  it("excludes deleted postings and separates current from future balance", async () => {
    const balances = await getAccountBalances(first, accountId, {});

    expect(balances.beginning.balance).toBe("0");
    expect(balances.ending.balance).toBe("1165");
    expect(balances.current.balance).toBe("165");
    expect(balances.future.balance).toBe("1165");
  });

  it("does not expose another tenant's account", async () => {
    await expect(getAccountBalances(second, accountId, {})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not claim or audit deletion when an account is archived", async () => {
    const account = await createAccount(first, {
      name: "Archived disposable account",
      type: "checking",
      currency: "USD",
      openingDate: "2026-07-30",
      openingBalance: "0",
    });
    const archived = await setAccountArchived(first, account.id, account.version, true);

    await expect(deleteAccount(first, account.id, archived.version)).rejects.toMatchObject({
      code: "CONFLICT",
      // The precondition docs/mcp.md and the delete_account description both
      // state. It is refused before any reference is counted, so an account
      // archived while empty is refused too.
      message: expect.stringContaining("Unarchive this account first"),
    });

    const persisted = await getDb()
      .select()
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, account.id));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].archivedAt).not.toBeNull();

    const deletionAudits = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, account.id), eq(auditEvents.operation, "delete")));
    expect(deletionAudits).toHaveLength(0);
  });

  it("audits an account deletion only after the row is actually removed", async () => {
    const account = await createAccount(first, {
      name: "Unused disposable account",
      type: "checking",
      currency: "USD",
      openingDate: "2026-07-30",
      openingBalance: "0",
    });

    await expect(deleteAccount(first, account.id, account.version)).resolves.toEqual({
      id: account.id,
      deleted: true,
    });
    expect(
      await getDb().select().from(ledgerAccounts).where(eq(ledgerAccounts.id, account.id)),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, account.id), eq(auditEvents.operation, "delete"))),
    ).toHaveLength(1);
  });

  it("serializes staged references against concurrent account deletion", async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const account = await createAccount(first, {
        name: `Concurrent staged deletion ${attempt}`,
        type: "checking",
        currency: "USD",
        openingDate: "2026-07-30",
        openingBalance: "0",
      });
      const [stageResult, deletionResult] = await Promise.allSettled([
        createStage(first, {
          draft: {
            type: "deposit",
            date: "2026-07-30",
            payee: `Concurrent account reference ${attempt}`,
            description: `Concurrent account reference ${attempt}`,
            toAccountId: account.id,
            amount: "1",
          },
          idempotencyKey: `concurrent-account-stage-${attempt}`,
        }),
        deleteAccount(first, account.id, account.version),
      ]);

      expect(stageResult.status).toBe("fulfilled");
      if (stageResult.status !== "fulfilled") continue;
      if (deletionResult.status === "fulfilled") {
        expect(stageResult.value.validationIssues.length).toBeGreaterThan(0);
        expect(
          await getDb().select().from(ledgerAccounts).where(eq(ledgerAccounts.id, account.id)),
        ).toHaveLength(0);
      } else {
        expect(deletionResult.reason).toMatchObject({ code: "CONFLICT" });
        expect(stageResult.value.validationIssues).toHaveLength(0);
      }
    }
  });

  it("blocks currency changes and archival while staged references are active", async () => {
    const account = await createAccount(first, {
      name: "Staged reference mutation guard",
      type: "checking",
      currency: "USD",
      openingDate: "2026-07-30",
      openingBalance: "0",
    });
    const stage = await createStage(first, {
      draft: {
        type: "deposit",
        date: "2026-07-30",
        payee: "Pending account mutation guard",
        description: "Pending account mutation guard",
        toAccountId: account.id,
        amount: "1",
      },
      idempotencyKey: "staged-account-mutation-guard",
    });
    expect(stage.validationIssues).toHaveLength(0);

    await expect(
      updateAccount(first, account.id, {
        currency: "EUR",
        expectedVersion: account.version,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      setAccountArchived(first, account.id, account.version, true),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("preserves existing archived account references without allowing rerouting", async () => {
    const originalAccount = await createAccount(first, {
      name: "Archived transaction origin",
      type: "checking",
      currency: "USD",
      openingDate: "2026-07-30",
      openingBalance: "0",
    });
    const unrelatedAccount = await createAccount(first, {
      name: "Unrelated archived destination",
      type: "checking",
      currency: "USD",
      openingDate: "2026-07-30",
      openingBalance: "0",
    });
    const transaction = await createTransaction(
      first,
      {
        type: "deposit",
        date: "2026-07-30",
        payee: "Archived account history",
        description: "Archived account history",
        toAccountId: originalAccount.id,
        amount: "15",
      },
      "archived-account-history",
    );
    await setAccountArchived(first, originalAccount.id, originalAccount.version, true);
    await setAccountArchived(first, unrelatedAccount.id, unrelatedAccount.version, true);

    const preserved = await updateTransaction(first, transaction.id, {
      draft: {
        type: "deposit",
        date: transaction.date,
        payee: "Edited archived account history",
        description: "Edited archived account history",
        toAccountId: originalAccount.id,
        amount: transaction.destinationAmount!,
      },
      expectedVersion: transaction.version,
    });
    expect(preserved).toMatchObject({
      destinationAccountId: originalAccount.id,
      payee: "Edited archived account history",
      description: "Edited archived account history",
    });

    await expect(
      updateTransaction(first, transaction.id, {
        draft: {
          type: "deposit",
          date: transaction.date,
          payee: "Rerouted archived account history",
          description: "Rerouted archived account history",
          toAccountId: unrelatedAccount.id,
          amount: transaction.destinationAmount!,
        },
        expectedVersion: preserved.version,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(getTransaction(first, transaction.id)).resolves.toMatchObject({
      destinationAccountId: originalAccount.id,
      payee: "Edited archived account history",
      description: "Edited archived account history",
      version: preserved.version,
    });
  });
});
