import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import {
  lockTransactionDuplicateKeys,
  transactionDuplicateKeys,
} from "../../src/server/services/transactions.js";
import type { Actor, TransactionDraft } from "../../src/shared/domain.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("duplicate_lock");
const actor: Actor = { userId: "duplicate-lock-user", source: "web" };

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
 */
const draft: TransactionDraft = {
  type: "deposit",
  date: "2026-08-24",
  payee: "Two tabs at once",
  description: "Two tabs at once",
  toAccountId: "00000000-0000-4000-8000-000000000001",
  amount: "31.41",
};

/** The same key the service would take, so this cannot drift from it. */
const fingerprint = () =>
  `${actor.userId}:${transactionDuplicateKeys(draft)[0]}`;

integration("the duplicate lock", () => {
  let outsider: PgClient;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Duplicate Lock",
      email: "duplicate-lock@example.com",
      emailVerified: true,
    });
    // A second connection, so the two transactions are genuinely simultaneous
    // rather than interleaved on one. It reads DATABASE_URL rather than
    // TEST_DATABASE_URL: create() points the first at the scratch database it
    // just made, and an advisory lock taken in one database is invisible in
    // another, so connecting to the wrong one would make every wait look free.
    outsider = new PgClient({ connectionString: process.env.DATABASE_URL });
    await outsider.connect();
  });

  afterAll(async () => {
    await outsider.end();
    await database.drop();
  });

  it("makes a second writer wait while the first holds the key", async () => {
    const key = fingerprint();
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

    // Take the lock and keep the transaction open.
    const held = getDb().transaction(async (tx) => {
      await lockTransactionDuplicateKeys(tx, actor, [draft]);
      taken!();
      await holding;
    });
    await locked;

    // The other connection asks for the same key, with a timeout short enough to
    // expire while it is blocked.
    await outsider.query("begin");
    await outsider.query("set local statement_timeout = '400ms'");
    const blocked = outsider
      .query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key])
      .then(() => "took the lock" as const)
      .catch((error: { code?: string }) =>
        error.code === "57014" ? ("timed out waiting" as const) : ("failed" as const),
      );

    expect(await blocked, "the second writer is made to wait").toBe(
      "timed out waiting",
    );
    await outsider.query("rollback");
    released!();
    await held;
  });

  it("hands the key over once the first writer is done", async () => {
    const key = fingerprint();
    // Nothing holds it now, so the same request that timed out above goes
    // straight through — which is what proves the timeout was the lock and not
    // something else about the statement.
    await outsider.query("begin");
    await outsider.query("set local statement_timeout = '400ms'");
    const result = await outsider
      .query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key])
      .then(() => "took the lock" as const)
      .catch(() => "blocked" as const);
    await outsider.query("rollback");
    expect(result).toBe("took the lock");
  });

  it("takes every key a draft contributes, not only the first", async () => {
    // A draft with an external id contributes two fingerprints. Both have to be
    // held, or an import that repeats one row slips through on the key that was
    // not taken.
    const withExternal = { ...draft, externalId: "bank-row-99" };
    const keys = transactionDuplicateKeys(withExternal).map(
      (one) => `${actor.userId}:${one}`,
    );
    expect(keys.length, "this draft has two keys").toBe(2);

    let released: (() => void) | undefined;
    let taken: (() => void) | undefined;
    const holding = new Promise<void>((resolve) => {
      released = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const held = getDb().transaction(async (tx) => {
      await lockTransactionDuplicateKeys(tx, actor, [withExternal]);
      taken!();
      await holding;
    });
    await locked;
    try {
      for (const key of keys) {
        await outsider.query("begin");
        await outsider.query("set local statement_timeout = '400ms'");
        const outcome = await outsider
          .query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key])
          .then(() => "free" as const)
          .catch((error: { code?: string }) =>
            error.code === "57014" ? ("held" as const) : ("failed" as const),
          );
        await outsider.query("rollback");
        expect(outcome, `key ${key} is held`).toBe("held");
      }
    } finally {
      released!();
      await held;
    }
  });
});
