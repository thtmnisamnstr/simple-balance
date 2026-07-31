import { and, eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { createMcpServer } from "../../src/server/mcp.js";
import {
  auditEvents,
  stagedTransactions,
  transactions,
  user,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  listDuplicatePayees,
  listPayees,
  listPayeeSuggestions,
  mergePayees,
} from "../../src/server/services/payees.js";
import {
  createStage,
  getStage,
  updateStage,
} from "../../src/server/services/staging.js";
import {
  createTransaction,
  getTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_payees_${process.pid}_${Date.now()}`;
const primary: Actor = { userId: "payee-integration-primary", source: "web" };
const other: Actor = {
  userId: "payee-integration-other",
  source: "mcp",
  clientId: "payee-integration-client",
};
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let primaryAccountId: string;
let otherAccountId: string;

integration("derived payee management", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);

    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values([
      {
        id: primary.userId,
        name: "Payee Primary",
        email: "payee-primary@example.com",
        emailVerified: true,
      },
      {
        id: other.userId,
        name: "Payee Other",
        email: "payee-other@example.com",
        emailVerified: true,
      },
    ]);
    const [primaryAccount, otherAccount] = await Promise.all([
      createAccount(primary, {
        name: "Primary checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
      createAccount(other, {
        name: "Other checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
    ]);
    primaryAccountId = primaryAccount.id;
    otherAccountId = otherAccount.id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("canonicalizes valid payee text for committed and staged writes", async () => {
    const canonical = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-01",
        payee: "Canonical Merchant",
        description: null,
        toAccountId: primaryAccountId,
        amount: "10",
      },
      "canonical-payee-original",
    );
    const reused = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-02",
        payee: "canonical   merchant",
        description: null,
        toAccountId: primaryAccountId,
        amount: "11",
      },
      "canonical-payee-reused",
    );
    expect(canonical.payee).toBe("Canonical Merchant");
    expect(reused.payee).toBe("Canonical Merchant");

    const invalidStage = await createStage(primary, {
      draft: {
        type: "not-a-transaction-type",
        payee: "  CANONICAL   MERCHANT  ",
      },
      rawData: { payee: "  CANONICAL   MERCHANT  ", source: "manual" },
      idempotencyKey: "canonical-invalid-stage",
    });
    expect(invalidStage.draft).toMatchObject({ payee: "Canonical Merchant" });
    expect(invalidStage.rawData).toEqual({
      payee: "  CANONICAL   MERCHANT  ",
      source: "manual",
    });
    expect(invalidStage.validationIssues).not.toHaveLength(0);

    const updated = await updateStage(primary, invalidStage.id, {
      draft: {
        type: "still-invalid",
        payee: "canonical merchant",
      },
      expectedVersion: invalidStage.version,
    });
    expect(updated.draft).toMatchObject({ payee: "Canonical Merchant" });
    expect(updated.version).toBe(invalidStage.version + 1);

    const oversized = "x".repeat(161);
    const oversizedStage = await createStage(primary, {
      draft: {
        type: "deposit",
        date: "2026-07-03",
        payee: oversized,
        toAccountId: primaryAccountId,
        amount: "1",
      },
      rawData: { payee: oversized },
      idempotencyKey: "oversized-payee-stage",
    });
    expect(oversizedStage.draft).toMatchObject({ payee: oversized });
    expect(oversizedStage.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "payee" }),
      ]),
    );
    expect((await getStage(primary, oversizedStage.id)).rawData).toEqual({
      payee: oversized,
    });
  });

  it("lists exact variants, groups logical duplicates, and isolates tenants", async () => {
    const target = await createTransaction(
      primary,
      {
        type: "withdrawal",
        date: "2026-07-10",
        payee: "Acme Market",
        description: null,
        fromAccountId: primaryAccountId,
        amount: "20",
      },
      "payee-list-target",
    );
    const source = await createTransaction(
      primary,
      {
        type: "withdrawal",
        date: "2026-07-11",
        payee: "Temporary merchant",
        description: null,
        fromAccountId: primaryAccountId,
        amount: "21",
      },
      "payee-list-source",
    );
    await getDb()
      .update(transactions)
      .set({ payee: "acme   market" })
      .where(eq(transactions.id, source.id));
    const [stage] = await getDb()
      .insert(stagedTransactions)
      .values({
        userId: primary.userId,
        draft: { payee: " ACME MARKET ", type: "invalid" },
        validationIssues: [],
      })
      .returning();
    await createTransaction(
      other,
      {
        type: "withdrawal",
        date: "2026-07-10",
        payee: "Other Tenant Payee",
        description: null,
        fromAccountId: otherAccountId,
        amount: "20",
      },
      "other-tenant-payee",
    );

    const summaries = await listPayees(primary, { search: "aCmE" });
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Acme Market",
          normalizedName: "acme market",
          transactionCount: 1,
          stagedTransactionCount: 0,
          totalCount: 1,
        }),
        expect.objectContaining({
          name: "acme   market",
          normalizedName: "acme market",
          transactionCount: 1,
        }),
        expect.objectContaining({
          name: " ACME MARKET ",
          normalizedName: "acme market",
          stagedTransactionCount: 1,
        }),
      ]),
    );
    expect(summaries.every((summary) => summary.name !== "Other Tenant Payee")).toBe(true);
    expect(await listPayeeSuggestions(primary, "ACME")).toEqual([
      "Acme Market",
    ]);
    expect(await listDuplicatePayees(primary)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedName: "acme market",
          count: 3,
          payees: expect.arrayContaining([
            expect.objectContaining({ name: "Acme Market" }),
            expect.objectContaining({ name: "acme   market" }),
            expect.objectContaining({ name: " ACME MARKET " }),
          ]),
        }),
      ]),
    );

    const mergeInput = {
      sourcePayees: ["acme   market", " ACME MARKET "],
      targetPayee: "Acme Market",
      idempotencyKey: "payee-merge-idempotent",
    };
    const result = await mergePayees(primary, mergeInput);
    expect(result).toEqual({
      targetPayee: "Acme Market",
      mergedSourcePayees: ["acme   market", " ACME MARKET "],
      updatedTransactionCount: 1,
      updatedStagedTransactionCount: 1,
    });
    const replay = await mergePayees(primary, mergeInput);
    expect(replay).toEqual(result);

    expect(await getTransaction(primary, source.id)).toMatchObject({
      payee: "Acme Market",
      version: source.version + 1,
    });
    expect(await getStage(primary, stage.id)).toMatchObject({
      draft: { payee: "Acme Market" },
      version: stage.version + 1,
    });
    expect(await getTransaction(primary, target.id)).toMatchObject({
      payee: "Acme Market",
      version: target.version,
    });

    const mergedSummary = await listPayees(primary, { search: "acme" });
    expect(mergedSummary).toEqual([
      expect.objectContaining({
        name: "Acme Market",
        transactionCount: 2,
        stagedTransactionCount: 1,
        totalCount: 3,
      }),
    ]);
    expect(await listDuplicatePayees(primary)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedName: "acme market" }),
      ]),
    );

    const mergeAudits = await getDb()
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, primary.userId),
          inArray(auditEvents.operation, ["payee_merge", "merge"]),
        ),
      );
    expect(
      mergeAudits.map((event) => [event.entityType, event.operation]),
    ).toEqual(
      expect.arrayContaining([
        ["transaction", "payee_merge"],
        ["staged_transaction", "payee_merge"],
        ["payee", "merge"],
      ]),
    );
    expect(
      mergeAudits.filter(
        (event) => event.entityType === "payee" && event.operation === "merge",
      ),
    ).toHaveLength(1);
    expect(
      await listPayees(other, { search: "Other Tenant" }),
    ).toEqual([
      expect.objectContaining({ name: "Other Tenant Payee", totalCount: 1 }),
    ]);

    await expect(
      mergePayees(primary, {
        ...mergeInput,
        sourcePayees: ["Something else"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back when any requested payee is outside the tenant namespace", async () => {
    const target = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-20",
        payee: "Rollback Target",
        description: null,
        toAccountId: primaryAccountId,
        amount: "30",
      },
      "payee-rollback-target",
    );
    const source = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-21",
        payee: "Rollback Source",
        description: null,
        toAccountId: primaryAccountId,
        amount: "31",
      },
      "payee-rollback-source",
    );
    await expect(
      mergePayees(primary, {
        sourcePayees: ["Rollback Source", "Other Tenant Payee"],
        targetPayee: "Rollback Target",
        idempotencyKey: "payee-merge-tenant-rollback",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getTransaction(primary, source.id)).toMatchObject({
      payee: "Rollback Source",
      version: source.version,
    });
    expect(await getTransaction(primary, target.id)).toMatchObject({
      payee: "Rollback Target",
      version: target.version,
    });
  });

  it("exposes payee listing and idempotent merging through MCP", async () => {
    const target = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-25",
        payee: "MCP Canonical Payee",
        description: null,
        toAccountId: primaryAccountId,
        amount: "40",
      },
      "mcp-payee-target",
    );
    const source = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-26",
        payee: "MCP Alternate Payee",
        description: null,
        toAccountId: primaryAccountId,
        amount: "41",
      },
      "mcp-payee-source",
    );
    const server = createMcpServer(
      { ...primary, source: "mcp", clientId: "payee-tools-test" },
      new Set(["ledger:write"]),
    );
    const client = new Client({ name: "payee-tools-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.callTool({
        name: "list_payees",
        arguments: { search: "mcp" },
      });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        result: expect.arrayContaining([
          expect.objectContaining({ name: target.payee }),
          expect.objectContaining({ name: source.payee }),
        ]),
      });

      const arguments_ = {
        sourcePayees: [source.payee],
        targetPayee: target.payee,
        idempotencyKey: "mcp-payee-merge-idempotent",
      };
      const merged = await client.callTool({
        name: "merge_payees",
        arguments: arguments_,
      });
      expect(merged.isError).not.toBe(true);
      expect(merged.structuredContent).toMatchObject({
        result: {
          targetPayee: target.payee,
          mergedSourcePayees: [source.payee],
          updatedTransactionCount: 1,
        },
      });
      const replay = await client.callTool({
        name: "merge_payees",
        arguments: arguments_,
      });
      expect(replay.structuredContent).toEqual(merged.structuredContent);
      expect(await getTransaction(primary, source.id)).toMatchObject({
        payee: target.payee,
        version: source.version + 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
