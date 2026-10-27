import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { lockTransactionDuplicateKeys } from "../../src/server/services/transactions.js";
import type { Actor, TransactionDraft } from "../../src/shared/domain.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("duplicate_lock");
const actor: Actor = { userId: "duplicate-lock-user", source: "web" };
const other: Actor = { userId: "duplicate-lock-other", source: "web" };

/**
 * The advisory lock that makes the duplicate check mean anything under
 * concurrency, tested on its own rather than through a write.
 *
 * Through a write it cannot be tested honestly. Two calls started together do
 * not reliably overlap — whichever one commits first is simply found by the
 * other, so the assertion passes with the lock removed and reads as cover it is
 * not. What is actually true of the lock is that a second holder must wait, and
 * that is what this asserts: a statement timeout short enough to expire while
 * blocked either expires, meaning the lock held, or does not, meaning it did not.
 *
 * One lock for the person rather than one per fingerprint
 * (`lockTransactionDuplicates`), so the second writer here asks with a draft
 * that shares no key with the first, and still waits; and the last case counts
 * what one call holds, because the per-key locks ran PostgreSQL's shared lock
 * table out of memory on a move part of ten thousand entries.
 */
const draft: TransactionDraft = {
  type: "deposit",
  date: "2026-08-24",
  payee: "Two tabs at once",
  description: "Two tabs at once",
  toAccountId: "00000000-0000-4000-8000-000000000001",
  amount: "31.41",
};
const unrelated: TransactionDraft = { ...draft, payee: "Something else", amount: "2.00" };

/** The pg error under whatever drizzle wrapped it in. */
const codeOf = (error: unknown): string | undefined => {
  const each = error as { code?: string; cause?: { code?: string } };
  return each.code ?? each.cause?.code;
};

/** Ask for the lock from a second connection, giving up after 400ms. */
const ask = (who: Actor, drafts: TransactionDraft[]) =>
  getDb()
    .transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '400ms'`);
      await lockTransactionDuplicateKeys(tx, who, drafts);
    })
    .then(() => "took the lock" as const)
    .catch((error: unknown) =>
      codeOf(error) === "57014" ? ("timed out waiting" as const) : ("failed" as const),
    );

integration("the duplicate lock", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Duplicate Lock",
      email: "duplicate-lock@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  /** Hold the lock for `actor` with `draft` until `run` is done. */
  async function whileHeld(run: () => Promise<void>) {
    let released: (() => void) | undefined;
    let taken: (() => void) | undefined;
    const holding = new Promise<void>((resolve) => {
      released = resolve;
    });
    // The handshake matters: without waiting for the lock to actually be taken,
    // the other connection can ask for it first and find it free, which looks
    // exactly like the lock not working.
    const locked = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const held = getDb().transaction(async (tx) => {
      await lockTransactionDuplicateKeys(tx, actor, [draft]);
      taken!();
      await holding;
    });
    await locked;
    try {
      await run();
    } finally {
      released!();
      await held;
    }
  }

  it("makes a second writer for the same person wait, whatever it is writing", async () => {
    await whileHeld(async () => {
      expect(await ask(actor, [draft]), "the same draft waits").toBe("timed out waiting");
      expect(await ask(actor, [unrelated]), "a draft sharing no key waits too").toBe(
        "timed out waiting",
      );
    });
  });

  it("lets another person's writer through while the first holds it", async () => {
    await whileHeld(async () => {
      expect(await ask(other, [draft])).toBe("took the lock");
    });
  });

  it("hands the lock over once the first writer is done", async () => {
    // Nothing holds it now, so the same request that timed out above goes
    // straight through — which is what proves the timeout was the lock and not
    // something else about the statement.
    expect(await ask(actor, [draft])).toBe("took the lock");
  });

  it("holds one lock however many drafts it is given", async () => {
    // Two thousand drafts, half with an external id and so two keys each: three
    // thousand locks one per key, where the lock table holds about sixty-four
    // per connection allowed. Counted from inside the transaction holding them.
    const drafts = Array.from({ length: 2_000 }, (_, index) => ({
      ...draft,
      payee: `Payee ${index}`,
      ...(index % 2 ? { externalId: `bank-row-${index}` } : {}),
    }));
    const held = await getDb().transaction(async (tx) => {
      await lockTransactionDuplicateKeys(tx, actor, drafts);
      const result = await tx.execute<{ held: number }>(sql`
        select count(*)::int as held from pg_locks
         where locktype = 'advisory' and pid = pg_backend_pid()
      `);
      return Number(result.rows[0]?.held);
    });
    expect(held).toBe(1);
  });
});
