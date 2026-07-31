import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createTransaction,
  getTransaction,
} from "../../src/server/services/transactions.js";

function resultRecord(result: unknown) {
  if (!result || typeof result !== "object") {
    throw new TypeError("MCP tool response was not an object");
  }
  return result as Record<string, unknown>;
}

function structuredResult(result: unknown) {
  return (resultRecord(result).structuredContent as { result: unknown }).result;
}

function textResult(result: unknown) {
  const content = resultRecord(result).content;
  if (!Array.isArray(content)) {
    throw new TypeError("MCP tool response content was not an array");
  }
  const textContent = (content as unknown[]).find(
    (content): content is { type: "text"; text: string } => {
      if (!content || typeof content !== "object") return false;
      const candidate = content as Record<string, unknown>;
      return candidate.type === "text" && typeof candidate.text === "string";
    },
  );
  if (!textContent) {
    throw new TypeError("MCP tool response did not include compatible text output");
  }
  return JSON.parse(textContent.text) as unknown;
}

async function connectedClient(scopes: Set<string>, actor: Actor) {
  const server = createMcpServer(actor, scopes);
  const client = new Client({
    name: "bulk-transactions-mcp-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("bulk transaction MCP tool contracts", () => {
  it("discovers preview and mutation tools only at their required scopes", async () => {
    const actor: Actor = {
      userId: "bulk-mcp-schema-user",
      source: "mcp",
      clientId: "bulk-mcp-schema-client",
    };
    const readConnection = await connectedClient(new Set(["ledger:read"]), actor);
    const stageConnection = await connectedClient(
      new Set(["ledger:stage"]),
      actor,
    );
    const writeConnection = await connectedClient(
      new Set(["ledger:write"]),
      actor,
    );

    try {
      const readTools = await readConnection.client.listTools();
      const stageTools = await stageConnection.client.listTools();
      const writeTools = await writeConnection.client.listTools();
      const readByName = new Map(readTools.tools.map((tool) => [tool.name, tool]));
      const writeByName = new Map(
        writeTools.tools.map((tool) => [tool.name, tool]),
      );

      expect(readByName.has("preview_bulk_transaction_selection")).toBe(true);
      expect(readByName.has("bulk_edit_transactions")).toBe(false);
      expect(
        stageTools.tools.some((tool) => tool.name === "preview_bulk_transaction_selection"),
      ).toBe(true);
      expect(
        stageTools.tools.some((tool) => tool.name === "bulk_edit_transactions"),
      ).toBe(false);
      expect(writeByName.has("preview_bulk_transaction_selection")).toBe(true);
      expect(writeByName.has("bulk_edit_transactions")).toBe(true);

      expect(
        readByName.get("preview_bulk_transaction_selection")?.annotations,
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(writeByName.get("bulk_edit_transactions")?.annotations).toMatchObject(
        {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      );
    } finally {
      await Promise.all([
        readConnection.client.close(),
        stageConnection.client.close(),
        writeConnection.client.close(),
      ]);
      await Promise.all([
        readConnection.server.close(),
        stageConnection.server.close(),
        writeConnection.server.close(),
      ]);
    }
  });
});

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseActor: Actor = {
  userId: "integration-bulk-transactions-mcp",
  source: "mcp",
  clientId: "bulk-transactions-mcp-integration",
};

integration("bulk transaction MCP PostgreSQL integration", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let checkingId: string;
  let savingsId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = connection;
    process.env.DATABASE_POOL_SIZE = "1";
    await runMigrations();
    await getDb().execute(
      sql`delete from auth_user where id = ${databaseActor.userId}`,
    );
    await getDb().insert(user).values({
      id: databaseActor.userId,
      name: "Bulk MCP Integration",
      email: "bulk-transactions-mcp-integration@example.com",
      emailVerified: true,
    });

    const checking = await createAccount(databaseActor, {
      name: "Bulk MCP Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2035-01-01",
      openingBalance: "100",
    });
    const savings = await createAccount(databaseActor, {
      name: "Bulk MCP Savings",
      type: "savings",
      currency: "USD",
      openingDate: "2035-01-01",
      openingBalance: "0",
    });
    checkingId = checking.id;
    savingsId = savings.id;

    ({ client, server } = await connectedClient(
      new Set(["ledger:write"]),
      databaseActor,
    ));
  });

  afterAll(async () => {
    await client?.close();
    await server?.close();
    if (connection) {
      await getDb().execute(
        sql`delete from auth_user where id = ${databaseActor.userId}`,
      );
    }
    await closeDb();
  });

  it("previews, dry-runs, commits, and idempotently replays a filter edit", async () => {
    const deposit = await createTransaction(
      databaseActor,
      {
        type: "deposit",
        date: "2035-01-15",
        payee: "Bulk MCP Deposit",
        description: null,
        toAccountId: checkingId,
        amount: "10",
      },
      "bulk-mcp-create-deposit",
    );
    const withdrawal = await createTransaction(
      databaseActor,
      {
        type: "withdrawal",
        date: "2035-01-16",
        payee: "Bulk MCP Withdrawal",
        description: null,
        fromAccountId: checkingId,
        amount: "3",
      },
      "bulk-mcp-create-withdrawal",
    );
    const transfer = await createTransaction(
      databaseActor,
      {
        type: "transfer",
        date: "2035-01-17",
        payee: "Bulk MCP Transfer",
        description: null,
        fromAccountId: checkingId,
        toAccountId: savingsId,
        sourceAmount: "2",
      },
      "bulk-mcp-create-transfer",
    );
    const filter = {
      start: "2035-01-15",
      end: "2035-01-17",
      includeDeleted: false,
    };

    const preview = await client.callTool({
      name: "preview_bulk_transaction_selection",
      arguments: { filter, excludedIds: [] },
    });
    expect(preview.isError).not.toBe(true);
    expect(structuredResult(preview)).toMatchObject({
      count: 3,
      activeCount: 3,
      deletedCount: 0,
      transferCount: 1,
      currencies: ["USD"],
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(textResult(preview)).toEqual(preview.structuredContent);

    const snapshot = structuredResult(preview) as {
      count: number;
      fingerprint: string;
    };
    const selection = {
      mode: "filter" as const,
      filter,
      excludedIds: [],
      expectedCount: snapshot.count,
      expectedFingerprint: snapshot.fingerprint,
    };
    const dryRun = await client.callTool({
      name: "bulk_edit_transactions",
      arguments: {
        selection,
        patch: { notes: "MCP bulk note" },
        idempotencyKey: "bulk-mcp-dry-run",
        allowDuplicates: false,
        dryRun: true,
      },
    });
    expect(dryRun.isError).not.toBe(true);
    expect(structuredResult(dryRun)).toMatchObject({
      updatedCount: 3,
      dryRun: true,
      selectionCount: 3,
      selectionFingerprint: snapshot.fingerprint,
      activeCount: 3,
      deletedCount: 0,
      transferCount: 1,
      currencies: ["USD"],
      itemsTruncated: false,
    });
    expect(textResult(dryRun)).toEqual(dryRun.structuredContent);
    for (const transaction of [deposit, withdrawal, transfer]) {
      expect(await getTransaction(databaseActor, transaction.id)).toMatchObject({
        version: transaction.version,
        notes: null,
      });
    }

    const mutationArguments = {
      selection,
      patch: { notes: "MCP bulk note" },
      idempotencyKey: "bulk-mcp-actual",
      allowDuplicates: false,
      dryRun: false,
    };
    const committed = await client.callTool({
      name: "bulk_edit_transactions",
      arguments: mutationArguments,
    });
    expect(committed.isError).not.toBe(true);
    expect(structuredResult(committed)).toMatchObject({
      updatedCount: 3,
      dryRun: false,
      selectionCount: 3,
      selectionFingerprint: snapshot.fingerprint,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: deposit.id,
          previousVersion: deposit.version,
          nextVersion: deposit.version + 1,
        }),
        expect.objectContaining({ id: withdrawal.id }),
        expect.objectContaining({ id: transfer.id, type: "transfer" }),
      ]),
    });
    expect(textResult(committed)).toEqual(committed.structuredContent);

    const replay = await client.callTool({
      name: "bulk_edit_transactions",
      arguments: mutationArguments,
    });
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toEqual(committed.structuredContent);
    for (const transaction of [deposit, withdrawal, transfer]) {
      expect(await getTransaction(databaseActor, transaction.id)).toMatchObject({
        version: transaction.version + 1,
        notes: "MCP bulk note",
      });
    }
  });

  it("returns a structured stale-version error without partially editing IDs", async () => {
    const first = await createTransaction(
      databaseActor,
      {
        type: "deposit",
        date: "2035-02-01",
        payee: "Bulk MCP Atomic First",
        description: null,
        toAccountId: checkingId,
        amount: "11",
      },
      "bulk-mcp-atomic-first",
    );
    const stale = await createTransaction(
      databaseActor,
      {
        type: "withdrawal",
        date: "2035-02-02",
        payee: "Bulk MCP Atomic Stale",
        description: null,
        fromAccountId: checkingId,
        amount: "4",
      },
      "bulk-mcp-atomic-stale",
    );

    const result = await client.callTool({
      name: "bulk_edit_transactions",
      arguments: {
        selection: {
          mode: "ids",
          items: [
            { id: first.id, expectedVersion: first.version },
            { id: stale.id, expectedVersion: stale.version + 1 },
          ],
        },
        patch: { payee: "Must Not Be Written" },
        idempotencyKey: "bulk-mcp-atomic-stale-edit",
        allowDuplicates: false,
        dryRun: false,
      },
    });
    expect(result.isError).toBe(true);
    expect(structuredResult(result)).toMatchObject({
      error: { code: "STALE_VERSION" },
    });
    expect(textResult(result)).toEqual(result.structuredContent);
    expect(await getTransaction(databaseActor, first.id)).toMatchObject({
      version: first.version,
      payee: first.payee,
    });
    expect(await getTransaction(databaseActor, stale.id)).toMatchObject({
      version: stale.version,
      payee: stale.payee,
    });
  });
});
