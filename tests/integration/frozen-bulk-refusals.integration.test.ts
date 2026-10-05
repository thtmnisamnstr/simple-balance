/**
 * The frozen-account guards nothing held: the bulk paths, the category merge
 * and the commit — and putting a frozen account away, which is held the other
 * way round.
 *
 * `assertAccountsWritable` is called at eight sites and the refusal was proved
 * at five of them. For two of the three left — `bulkDeleteTransactions` and
 * `mergeCategories` — that call is the *only* guard on the path: a bulk delete
 * reaches `repostTransaction`, which consults no freeze, and the merge does not
 * go through `prepareTransaction`. Deleting either line unguarded the path and
 * left all three tiers green.
 *
 * Archiving and deleting a frozen account were guarded too, and are not any
 * more: putting an account away gives it no place, so refusing it only stopped
 * somebody who had downgraded from tidying up. What has to hold instead is
 * that neither hands another frozen account a place, and that an archived one
 * still needs a free place to come back. The last block here holds both.
 *
 * `AGENTS.md` names "a payee **or category** merge that walks the whole ledger"
 * as the pair that must refuse. The payee half is pinned in
 * `frozen-accounts.integration.test.ts`; the twin written from the same
 * sentence was not, which is how a rule loses one of its halves.
 *
 * Two of them are defended in depth and are here for the case that gets past
 * the other guard:
 *
 *   - `bulkEditTransactions` also prepares each row, so a patch that leaves the
 *     accounts alone is refused by `resolveAccounts` regardless. The one that
 *     slips through without the call is a patch moving rows *off* the frozen
 *     account, which is exactly what `updateTransaction`'s own case covers one
 *     row at a time.
 *   - `commitStages` has no `assertAccountsWritable` of its own: it reads the
 *     freeze once and hands it to `validateDraft` and to
 *     `createTransactionWithinTx`, each of which reaches the same guard. So the
 *     refusal arrives as a row issue rather than as the sentence — the commit
 *     says every row must be complete and the frozen sentence is nested inside
 *     `issues`, which is what this asserts, because `/frozen/i` against the
 *     thrown message would quietly not match.
 *
 * Billing on, for this file only — see `account-limit.integration.test.ts` for
 * why this is at module scope and restored afterward.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_frozen_bulk",
  STRIPE_PUBLISHABLE_KEY: "pk_test_frozen_bulk",
  STRIPE_WEBHOOK_SECRET: "whsec_frozen_bulk",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createCategory, mergeCategories } from "../../src/server/services/categories.js";
import { commitStages, createStage, listStages } from "../../src/server/services/staging.js";
import {
  bulkDeleteTransactions,
  bulkEditTransactions,
  createTransaction,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("frozen_bulk_refusals");

let keySeed = 0;
const nextKey = () => `frozen-bulk-${String((keySeed += 1)).padStart(6, "0")}`;

const far = new Date("2099-01-01");

const freshOwner = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

/** The paid plan, so four accounts can be opened, then gone again. */
const paidUntil = async (owner: Actor, expiresAt: Date | null) => {
  await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, owner.userId));
  if (expiresAt === null) return;
  await getDb().insert(billingOverrides).values({
    userId: owner.userId,
    plan: "plus",
    expiresAt,
    reason: "frozen-bulk fixture",
    operator: "test",
  });
};

const open = async (owner: Actor, name: string) =>
  (
    await createAccount(owner, {
      name,
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "500",
    })
  ).id;

const spend = (owner: Actor, accountId: string, amount: string, payee = "Corner shop") =>
  createTransaction(
    owner,
    {
      type: "withdrawal",
      date: "2026-02-01",
      payee,
      description: null,
      fromAccountId: accountId,
      amount,
    },
    nextKey(),
  );

/**
 * A ledger whose fourth account is frozen, with the rows on it already written.
 *
 * Written while the plan was paid and frozen underneath them, which is the only
 * way a frozen account has rows to act on at all.
 */
const ledgerWithFrozenAccount = async (id: string, rows: readonly string[]) => {
  const owner = await freshOwner(id);
  await paidUntil(owner, far);
  const accounts: Record<string, string> = {};
  for (const name of ["First", "Second", "Third", "Fourth"]) {
    accounts[name] = await open(owner, name);
  }
  const written = [];
  for (const amount of rows) written.push(await spend(owner, accounts.Fourth!, amount));
  await paidUntil(owner, null);
  const frozen = (await listAccounts(owner)).filter((account) => account.frozen);
  expect(frozen.map((account) => account.name)).toEqual(["Fourth"]);
  return { owner, accounts, written };
};

const selection = (rows: readonly { id: string; version: number }[]) => ({
  mode: "ids" as const,
  items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })),
});

integration("what a frozen account refuses when the request never names it", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);

  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("refuses a mass delete of rows on it, whole rather than row by row", async () => {
    const { owner, written } = await ledgerWithFrozenAccount("frozen-bulk-delete", ["10", "11"]);

    await expect(
      bulkDeleteTransactions(owner, {
        selection: selection(written),
        idempotencyKey: nextKey(),
        dryRun: false,
      }),
    ).rejects.toThrow(/"Fourth" is frozen/);
  });

  it("refuses a mass edit that moves its rows off it", async () => {
    // The case the per-row `prepareTransaction` does not already cover: the
    // patch names a different account, so the row being prepared is about the
    // account it is moving to.
    const { owner, accounts, written } = await ledgerWithFrozenAccount("frozen-bulk-edit", ["12"]);

    await expect(
      bulkEditTransactions(owner, {
        selection: selection(written),
        patch: { accountId: accounts.First! },
        idempotencyKey: nextKey(),
        allowDuplicates: false,
      }),
    ).rejects.toThrow(/frozen/i);
  });

  it("refuses a category merge that would rewrite one of its rows", async () => {
    // The twin of the payee merge, and the same shape: the request names two
    // categories and no account at all, and finds the frozen account by
    // walking the ledger.
    const owner = (await ledgerWithFrozenAccount("frozen-bulk-merge", [])).owner;
    const accounts = (await listAccounts(owner)).reduce<Record<string, string>>(
      (found, account) => ({ ...found, [account.name]: String(account.id) }),
      {},
    );
    await paidUntil(owner, far);
    const groceries = await createCategory(owner, { name: "Groceries", kind: "expense" });
    const market = await createCategory(owner, { name: "Market", kind: "expense" });
    await createTransaction(
      owner,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Village Stores",
        description: null,
        fromAccountId: accounts.Fourth!,
        amount: "13",
        categoryId: market.id,
      },
      nextKey(),
    );
    await paidUntil(owner, null);

    await expect(
      mergeCategories(owner, {
        sourceCategoryIds: [market.id],
        targetCategoryId: groceries.id,
        expectedVersions: { [market.id]: market.version },
        targetExpectedVersion: groceries.version,
      }),
    ).rejects.toThrow(/frozen/i);
  });

  it("refuses a commit of a staged row that would land on it, as a row issue", async () => {
    // Not `/frozen/i` against the thrown message: `validateDraft` catches the
    // refusal and files it against the row, so the commit refuses with its own
    // sentence and the frozen one is nested in `issues`. An assertion on the
    // message alone would pass whether or not the guard was there.
    const { owner, accounts } = await ledgerWithFrozenAccount("frozen-bulk-commit", []);
    await paidUntil(owner, far);
    await createStage(owner, {
      draft: {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Staged while usable",
        description: null,
        fromAccountId: accounts.Fourth!,
        amount: "14",
      },
      idempotencyKey: nextKey(),
    });
    await paidUntil(owner, null);
    const queued = await listStages(owner, { page: 1, pageSize: 100 });

    await expect(
      commitStages(owner, {
        stagedIds: queued.items.map((staged) => staged.id),
        expectedVersions: Object.fromEntries(
          queued.items.map((staged) => [staged.id, staged.version]),
        ),
        idempotencyKey: nextKey(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/must be complete before it can commit/i),
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/"Fourth" is frozen/) }),
        ]),
      },
    });
  });

  describe("putting a frozen account away", () => {
    const frozenNames = async (owner: Actor) =>
      (await listAccounts(owner))
        .filter((account) => account.frozen)
        .map((account) => account.name)
        .sort();

    /** Five accounts, so archiving or deleting one frozen account leaves another to watch. */
    const ledgerWithTwoFrozen = async (id: string, rowsOnFourth: readonly string[] = []) => {
      const owner = await freshOwner(id);
      await paidUntil(owner, far);
      const accounts: Record<string, string> = {};
      for (const name of ["First", "Second", "Third", "Fourth", "Fifth"]) {
        accounts[name] = await open(owner, name);
      }
      for (const amount of rowsOnFourth) await spend(owner, accounts.Fourth!, amount);
      await paidUntil(owner, null);
      expect(await frozenNames(owner)).toEqual(["Fifth", "Fourth"]);
      return { owner, accounts };
    };

    it("archives one, closing it at zero and giving the other no place", async () => {
      const { owner, accounts } = await ledgerWithTwoFrozen("frozen-archive", ["40"]);
      const fourth = await getAccount(owner, accounts.Fourth!);

      const archived = await setAccountArchived(owner, accounts.Fourth!, fourth.version, true);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.balance).toMatch(/^0(\.0+)?$/);
      expect(await frozenNames(owner)).toEqual(["Fifth"]);
      expect(
        (await listAccounts(owner))
          .filter((account) => !account.frozen)
          .map((account) => account.name)
          .sort(),
      ).toEqual(["First", "Second", "Third"]);
      // Coming back is where the limit is enforced, so the archive is not the
      // first half of a swap.
      await expect(
        setAccountArchived(owner, accounts.Fourth!, archived.version, false),
      ).rejects.toThrow(/needs one of those places/);
    });

    it("deletes one with nothing on it, giving the other no place", async () => {
      const { owner, accounts } = await ledgerWithTwoFrozen("frozen-delete");
      const fifth = await getAccount(owner, accounts.Fifth!);

      await expect(deleteAccount(owner, accounts.Fifth!, fifth.version)).resolves.toMatchObject({
        deleted: true,
      });
      expect(await frozenNames(owner)).toEqual(["Fourth"]);
      expect((await listAccounts(owner)).map((account) => account.name).sort()).toEqual([
        "First",
        "Fourth",
        "Second",
        "Third",
      ]);
    });

    it("sends one with history to the archive instead, as it would any account", async () => {
      const { owner, accounts } = await ledgerWithTwoFrozen("frozen-delete-used", ["12"]);
      const fourth = await getAccount(owner, accounts.Fourth!);

      await expect(deleteAccount(owner, accounts.Fourth!, fourth.version)).rejects.toThrow(
        /Archive it instead/,
      );
    });

    it("answers a restore of one that is already live with its real standing", async () => {
      // The no-op path used to sit behind the freeze check, which made
      // `frozen: false` true by construction there. Without the check it has
      // to be read.
      const { owner, accounts } = await ledgerWithTwoFrozen("frozen-restore-noop");
      const fourth = await getAccount(owner, accounts.Fourth!);

      const answer = await setAccountArchived(owner, accounts.Fourth!, fourth.version, false);
      expect(answer.frozen).toBe(true);
      expect(answer.version).toBe(fourth.version);
    });
  });
});
