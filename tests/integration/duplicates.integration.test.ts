import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, TransactionDraft } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount, listAccounts } from "../../src/server/services/accounts.js";
import {
  commitStages,
  createStage,
  deleteStages,
  getStage,
  listStages,
} from "../../src/server/services/staging.js";
import {
  createTransaction,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { listPayeeSuggestions } from "../../src/server/services/payees.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("duplicates");
const actor: Actor = { userId: "integration-duplicates", source: "web" };

integration("transaction duplicate protection", () => {
  let directAccountId: string;
  let stagedAccountId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Duplicate Test Tenant",
      email: "duplicate-integration@example.com",
      emailVerified: true,
    });
    const [directAccount, stagedAccount] = await Promise.all(
      ["Direct duplicate account", "Staged duplicate account"].map((name) =>
        createAccount(actor, {
          name,
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "0",
        }),
      ),
    );
    directAccountId = directAccount.id;
    stagedAccountId = stagedAccount.id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("rejects a direct heuristic duplicate unless explicitly overridden", async () => {
    const original: TransactionDraft = {
      type: "withdrawal",
      date: "2026-08-01",
      payee: "Coffee Shop",
      description: "Coffee Shop",
      fromAccountId: directAccountId,
      amount: "5.25",
      externalId: "bank-transaction-one",
    };
    const duplicateDraft: TransactionDraft = {
      ...original,
      payee: "coffee   shop",
      description: "coffee   shop",
      externalId: "bank-transaction-two",
    };

    const created = await createTransaction(actor, original, "duplicate-direct-original");
    const selfUpdated = await updateTransaction(actor, created.id, {
      draft: original,
      expectedVersion: created.version,
      allowDuplicate: false,
    });
    expect(selfUpdated.version).toBe(created.version + 1);
    await expect(
      createTransaction(actor, duplicateDraft, "duplicate-direct-rejected"),
    ).rejects.toMatchObject({
      code: "DUPLICATE",
      details: { duplicateOfId: created.id },
    });

    const afterRejection = await listTransactions(actor, {
      accountId: directAccountId,
      start: "2026-08-01",
      end: "2026-08-01",
    });
    expect(afterRejection.items).toHaveLength(1);

    const overridden = await createTransaction(
      actor,
      duplicateDraft,
      "duplicate-direct-overridden",
      true,
    );
    expect(overridden.id).not.toBe(created.id);

    const distinct = await createTransaction(
      actor,
      {
        ...original,
        date: "2026-08-02",
        payee: "Actually distinct",
        description: "Actually distinct",
        externalId: "bank-transaction-three",
      },
      "duplicate-update-distinct",
    );
    await expect(
      updateTransaction(actor, distinct.id, {
        draft: duplicateDraft,
        expectedVersion: distinct.version,
        allowDuplicate: false,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });

    const afterOverride = await listTransactions(actor, {
      accountId: directAccountId,
      start: "2026-08-01",
      end: "2026-08-01",
    });
    expect(afterOverride.items).toHaveLength(2);
  });

  it("treats percent and underscore characters literally in exact payee filters", async () => {
    const literal = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-08-13",
        payee: "Save 50%_A",
        description: null,
        fromAccountId: directAccountId,
        amount: "1.00",
      },
      "literal-payee-filter",
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-08-13",
        payee: "Save 500XA",
        description: null,
        fromAccountId: directAccountId,
        amount: "2.00",
      },
      "wildcard-like-payee-filter-collision",
    );

    const filtered = await listTransactions(actor, {
      accountId: directAccountId,
      start: "2026-08-13",
      end: "2026-08-13",
      payee: "save 50%_a",
    });

    expect(filtered.items.map((transaction) => transaction.id)).toEqual([literal.id]);
    expect(await listPayeeSuggestions(actor, "50%_")).toEqual([literal.payee]);
  });

  it("requires an explicit duplicate override when restoring a transaction", async () => {
    const draft: TransactionDraft = {
      type: "withdrawal",
      date: "2026-08-03",
      payee: "Restore collision",
      description: "Restore collision",
      fromAccountId: directAccountId,
      amount: "14.25",
      externalId: "restore-collision",
    };
    const original = await createTransaction(actor, draft, "restore-duplicate-original");
    const deleted = await setTransactionDeleted(actor, original.id, original.version, true);
    const activeDuplicate = await createTransaction(actor, draft, "restore-duplicate-active");

    await expect(
      setTransactionDeleted(actor, deleted.id, deleted.version, false),
    ).rejects.toMatchObject({
      code: "DUPLICATE",
      details: { duplicateOfId: activeDuplicate.id },
    });
    const afterRejection = await getTransaction(actor, deleted.id);
    expect(afterRejection).toMatchObject({
      version: deleted.version,
      deletedAt: expect.any(String),
    });

    const restored = await setTransactionDeleted(actor, deleted.id, deleted.version, false, true);
    expect(restored.deletedAt).toBeNull();
    expect(restored.version).toBe(deleted.version + 1);
  });

  it("binds direct transaction and staging idempotency keys to their request", async () => {
    const transactionDraft: TransactionDraft = {
      type: "deposit",
      date: "2026-08-04",
      payee: "Payload-bound transaction",
      description: "Payload-bound transaction",
      toAccountId: directAccountId,
      amount: "18.75",
    };
    const created = await createTransaction(actor, transactionDraft, "payload-bound-transaction");
    expect(
      await createTransaction(actor, { ...transactionDraft }, "payload-bound-transaction"),
    ).toEqual(created);
    await expect(
      createTransaction(
        actor,
        { ...transactionDraft, amount: "18.76" },
        "payload-bound-transaction",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const stageInput = {
      draft: {
        type: "deposit",
        date: "2026-08-05",
        payee: "Payload-bound stage",
        description: "Payload-bound stage",
        toAccountId: directAccountId,
        amount: "19.75",
      },
      rawData: { second: "value", first: "value" },
      idempotencyKey: "payload-bound-stage",
    };
    const stage = await createStage(actor, stageInput);
    const sameStage = await createStage(actor, {
      ...stageInput,
      rawData: { first: "value", second: "value" },
    });
    expect(sameStage).toEqual(stage);
    await expect(
      createStage(actor, {
        ...stageInput,
        draft: { ...stageInput.draft, amount: "19.76" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const commitInput = {
      stagedIds: [stage.id],
      expectedVersions: { [stage.id]: stage.version },
      idempotencyKey: "payload-bound-stage-commit",
      allowDuplicates: false,
      dryRun: false,
    };
    const committed = await commitStages(actor, commitInput);
    expect(await commitStages(actor, commitInput)).toEqual(committed);

    const otherStage = await createStage(actor, {
      draft: {
        type: "deposit",
        date: "2026-08-06",
        payee: "Different staged request",
        description: "Different staged request",
        toAccountId: directAccountId,
        amount: "20.75",
      },
      idempotencyKey: "payload-bound-other-stage",
    });
    await expect(
      commitStages(actor, {
        ...commitInput,
        stagedIds: [otherStage.id],
        expectedVersions: { [otherStage.id]: otherStage.version },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("detects selected staged duplicates in dry runs and commits atomically only with override", async () => {
    const first = await createStage(actor, {
      draft: {
        type: "deposit",
        date: "2026-08-02",
        payee: "First imported row",
        description: "First imported row",
        toAccountId: stagedAccountId,
        amount: "12.34",
        externalId: "shared-import-id",
      },
      idempotencyKey: "duplicate-staged-first",
    });
    const second = await createStage(actor, {
      draft: {
        type: "deposit",
        date: "2026-08-03",
        payee: "Different imported row",
        description: "Different imported row",
        toAccountId: stagedAccountId,
        amount: "8.5",
        externalId: "shared-import-id",
      },
      idempotencyKey: "duplicate-staged-second",
    });
    const commitInput = {
      stagedIds: [first.id, second.id],
      expectedVersions: {
        [first.id]: first.version,
        [second.id]: second.version,
      },
      allowDuplicates: false,
    };

    await expect(
      commitStages(actor, {
        ...commitInput,
        idempotencyKey: "duplicate-staged-dry-run",
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE",
      details: { duplicateOfStagedId: expect.any(String) },
    });
    expect((await getStage(actor, first.id)).status).toBe("staged");
    expect((await getStage(actor, second.id)).status).toBe("staged");
    expect(
      (
        await listTransactions(actor, {
          accountId: stagedAccountId,
          start: "2026-08-02",
          end: "2026-08-03",
        })
      ).items,
    ).toHaveLength(0);

    await expect(
      commitStages(actor, {
        ...commitInput,
        idempotencyKey: "duplicate-staged-rejected",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    expect((await getStage(actor, first.id)).status).toBe("staged");
    expect((await getStage(actor, second.id)).status).toBe("staged");
    expect(
      (await listAccounts(actor)).find((account) => account.id === stagedAccountId)?.balance,
    ).toBe("0");

    const result = await commitStages(actor, {
      ...commitInput,
      idempotencyKey: "duplicate-staged-overridden",
      allowDuplicates: true,
      dryRun: false,
    });
    if (!("committed" in result)) {
      throw new Error("Expected staged transactions to be committed");
    }
    expect(result.committed).toHaveLength(2);
    expect((await getStage(actor, first.id)).status).toBe("committed");
    expect((await getStage(actor, second.id)).status).toBe("committed");
    expect(
      (await listAccounts(actor)).find((account) => account.id === stagedAccountId)?.balance,
    ).toBe("20.84");
  });

  it("serializes concurrent MCP retries for direct and staged commits", async () => {
    const mcpActor: Actor = {
      userId: actor.userId,
      source: "mcp",
      clientId: "concurrent-retry-client",
    };
    const server = createMcpServer(mcpActor, new Set(["ledger:write"]));
    const client = new Client({
      name: "concurrent-retry-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const createArguments = {
      draft: {
        type: "deposit",
        date: "2026-08-10",
        payee: "Concurrent MCP direct retry",
        description: "Concurrent MCP direct retry",
        toAccountId: directAccountId,
        amount: "3.21",
      },
      idempotencyKey: "concurrent-mcp-direct-retry",
    };
    const [firstDirect, secondDirect] = await Promise.all([
      client.callTool({
        name: "create_transaction",
        arguments: createArguments,
      }),
      client.callTool({
        name: "create_transaction",
        arguments: createArguments,
      }),
    ]);
    expect(firstDirect.isError).not.toBe(true);
    expect(secondDirect.isError).not.toBe(true);
    expect(secondDirect.structuredContent).toEqual(firstDirect.structuredContent);
    const mismatchedDirect = await client.callTool({
      name: "create_transaction",
      arguments: {
        ...createArguments,
        draft: { ...createArguments.draft, amount: "3.22" },
      },
    });
    expect(mismatchedDirect).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          error: {
            code: "CONFLICT",
          },
        },
      },
    });

    const stage = await createStage(actor, {
      draft: {
        type: "deposit",
        date: "2026-08-11",
        payee: "Concurrent MCP staged retry",
        description: "Concurrent MCP staged retry",
        toAccountId: stagedAccountId,
        amount: "4.32",
      },
      idempotencyKey: "concurrent-mcp-stage",
    });
    const commitArguments = {
      stagedIds: [stage.id],
      expectedVersions: { [stage.id]: stage.version },
      idempotencyKey: "concurrent-mcp-stage-commit",
      allowDuplicates: false,
      dryRun: false,
    };
    const [firstCommit, secondCommit] = await Promise.all([
      client.callTool({
        name: "commit_staged_transactions",
        arguments: commitArguments,
      }),
      client.callTool({
        name: "commit_staged_transactions",
        arguments: commitArguments,
      }),
    ]);
    expect(firstCommit.isError).not.toBe(true);
    expect(secondCommit.isError).not.toBe(true);
    expect(secondCommit.structuredContent).toEqual(firstCommit.structuredContent);

    await client.close();
    await server.close();

    expect(
      (
        await listTransactions(actor, {
          accountId: directAccountId,
          start: "2026-08-10",
          end: "2026-08-10",
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await listTransactions(actor, {
          accountId: stagedAccountId,
          start: "2026-08-11",
          end: "2026-08-11",
        })
      ).items,
    ).toHaveLength(1);
  });

  /**
   * The one tool whose input schema carries a field its service refuses.
   *
   * `delete_staged_transactions` adds `idempotencyKey` to a schema that is now
   * strict, so handing the whole input back to the service would fail every
   * call. Nothing static catches it — the service takes `unknown` — and
   * `npm run verify` does not run this suite, so the only thing that can is a
   * call over a real connection. The replay half matters for the same reason
   * one level along: the recorded payload is deliberately the un-stripped
   * input, because that is what every stored record was hashed from.
   */
  it("deletes a staged row over a real connection, and replays the same key", async () => {
    const mcpActor: Actor = {
      userId: actor.userId,
      source: "mcp",
      clientId: "staged-delete-client",
    };
    const server = createMcpServer(mcpActor, new Set(["ledger:stage"]));
    const client = new Client({ name: "staged-delete-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const doomed = await createStage(actor, {
      draft: {
        type: "deposit",
        date: "2026-08-12",
        payee: "Staged delete over MCP",
        description: "Staged delete over MCP",
        toAccountId: stagedAccountId,
        amount: "7.65",
      },
      idempotencyKey: "mcp-staged-delete-stage",
    });
    const deleteArguments = {
      stagedIds: [doomed.id],
      expectedVersions: { [doomed.id]: doomed.version },
      idempotencyKey: "mcp-staged-delete",
    };
    const first = await client.callTool({
      name: "delete_staged_transactions",
      arguments: deleteArguments,
    });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      result: { deletedIds: [doomed.id], dryRun: false },
    });

    const replay = await client.callTool({
      name: "delete_staged_transactions",
      arguments: deleteArguments,
    });
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toEqual(first.structuredContent);

    await client.close();
    await server.close();

    expect((await getStage(actor, doomed.id)).status).toBe("deleted");
  });

  it("serializes concurrent direct-service retries before reading idempotency", async () => {
    const draft: TransactionDraft = {
      type: "deposit",
      date: "2026-08-20",
      payee: "Concurrent direct service retry",
      description: "Concurrent direct service retry",
      toAccountId: directAccountId,
      amount: "6.54",
    };
    const [firstDirect, secondDirect] = await Promise.all([
      createTransaction(actor, draft, "concurrent-web-direct-retry"),
      createTransaction(actor, draft, "concurrent-web-direct-retry"),
    ]);
    expect(secondDirect).toEqual(firstDirect);
    expect(
      (
        await listTransactions(actor, {
          accountId: directAccountId,
          start: "2026-08-20",
          end: "2026-08-20",
        })
      ).items,
    ).toHaveLength(1);

    const stageInput = {
      draft: {
        type: "deposit",
        date: "2026-08-21",
        payee: "Concurrent direct staged retry",
        description: "Concurrent direct staged retry",
        toAccountId: stagedAccountId,
        amount: "7.65",
      },
      idempotencyKey: "concurrent-web-stage-create",
    };
    const [firstStage, secondStage] = await Promise.all([
      createStage(actor, stageInput),
      createStage(actor, stageInput),
    ]);
    expect(secondStage).toEqual(firstStage);

    const commitInput = {
      stagedIds: [firstStage.id],
      expectedVersions: { [firstStage.id]: firstStage.version },
      idempotencyKey: "concurrent-web-stage-commit",
      allowDuplicates: false,
      dryRun: false,
    };
    const [firstCommit, secondCommit] = await Promise.all([
      commitStages(actor, commitInput),
      commitStages(actor, commitInput),
    ]);
    expect(secondCommit).toEqual(firstCommit);
    expect(
      (
        await listTransactions(actor, {
          accountId: stagedAccountId,
          start: "2026-08-21",
          end: "2026-08-21",
        })
      ).items,
    ).toHaveLength(1);
  });

  it("rolls back an overlapping staged deletion instead of reporting partial success", async () => {
    const stages = await Promise.all(
      ["A", "B", "C"].map((suffix) =>
        createStage(actor, {
          draft: {
            type: "deposit",
            date: "2026-08-12",
            payee: `Overlapping staged delete ${suffix}`,
            description: `Overlapping staged delete ${suffix}`,
            toAccountId: stagedAccountId,
            amount: "1",
          },
          idempotencyKey: `overlapping-stage-delete-${suffix}`,
        }),
      ),
    );
    const input = (selected: typeof stages) => ({
      stagedIds: selected.map((stage) => stage.id),
      expectedVersions: Object.fromEntries(selected.map((stage) => [stage.id, stage.version])),
    });
    const results = await Promise.allSettled([
      deleteStages(actor, input([stages[0]!, stages[1]!])),
      deleteStages(actor, input([stages[1]!, stages[2]!])),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const statuses = await Promise.all(
      stages.map(async (stage) => (await getStage(actor, stage.id)).status),
    );
    expect(statuses.filter((status) => status === "deleted")).toHaveLength(2);
    expect(statuses.filter((status) => status === "staged")).toHaveLength(1);
  });

  // Two rows that repeat each other were refused at commit while the queue's
  // own "possible duplicate" filter found nothing, so there was no way to see
  // which rows the refusal was about.
  it("shows rows that repeat each other, not only rows matching a commit", async () => {
    const draft = {
      type: "withdrawal" as const,
      date: "2027-09-01",
      payee: "Repeat Shop",
      description: null,
      fromAccountId: stagedAccountId,
      amount: "31.00",
    };
    const first = await createStage(actor, {
      draft,
      idempotencyKey: "repeat-stage-a",
    });
    const second = await createStage(actor, {
      draft,
      idempotencyKey: "repeat-stage-b",
    });

    // Neither matches anything committed, so the old flag stays null.
    expect(first.duplicateOfId).toBeNull();
    expect(second.duplicateOfId).toBeNull();

    const flagged = await listStages(actor, {
      validity: "duplicate",
      limit: 50,
    });
    const ids = flagged.items.map((item) => item.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(flagged.items.every((item) => item.repeatsStagedRow)).toBe(true);

    // And the commit still refuses them, which is what sent someone looking.
    await expect(
      commitStages(actor, {
        stagedIds: [first.id, second.id],
        expectedVersions: {
          [first.id]: first.version,
          [second.id]: second.version,
        },
        idempotencyKey: "repeat-stage-commit",
      }),
    ).rejects.toThrow(/duplicate/i);

    // A row on its own is not a repeat of anything.
    await deleteStages(actor, {
      stagedIds: [second.id],
      expectedVersions: { [second.id]: second.version },
    });
    const afterRemoval = await listStages(actor, {
      validity: "duplicate",
      limit: 50,
    });
    expect(afterRemoval.items.map((item) => item.id)).not.toContain(first.id);
  });
});
