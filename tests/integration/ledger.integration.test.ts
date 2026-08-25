import { sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalJWKSet, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, TransactionDraft } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import {
  account,
  importBatches,
  oauthAccessToken,
  oauthApplication,
  user,
} from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import {
  getMcpJwks,
  issueMcpAccessToken,
  resignMcpIdToken,
  unwrapMcpAccessToken,
} from "../../src/server/mcp-token.js";
import { createAccount, listAccounts } from "../../src/server/services/accounts.js";
import { listAuditEvents } from "../../src/server/services/audit.js";
import {
  auditEventResultSchema,
  cursorPageResultSchema,
} from "../../src/server/mcp-output-schemas.js";
import { commitStages, createStage } from "../../src/server/services/staging.js";
import { getSummary } from "../../src/server/services/summary.js";
import { createTransaction, getTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ledger");
const first: Actor = { userId: "integration-first", source: "web" };
const second: Actor = { userId: "integration-second", source: "mcp", clientId: "test" };

integration("PostgreSQL ledger integration", () => {
  let checkingId: string;
  let savingsId: string;
  let euroId: string;
  let directAccountId: string;
  let stagedAccountId: string;
  let mcpAccountId: string;

  beforeAll(async () => {
    process.env.DATABASE_POOL_SIZE = "1";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_SECRET = "integration-test-secret-at-least-32-characters";
    process.env.GOOGLE_CLIENT_ID = "integration-google-client";
    process.env.GOOGLE_CLIENT_SECRET = "integration-google-secret";
    process.env.AUTH_MODE = "both";
    process.env.ALLOWED_EMAILS = "first-integration@example.com,second-integration@example.com";
    await database.create();
    const db = getDb();
    await db.execute(sql`delete from auth_user where id in (${first.userId}, ${second.userId})`);
    await db.insert(user).values([
      {
        id: first.userId,
        name: "First Tenant",
        email: "first-integration@example.com",
        emailVerified: true,
      },
      {
        id: second.userId,
        name: "Second Tenant",
        email: "second-integration@example.com",
        emailVerified: true,
      },
    ]);
    await db.insert(account).values([
      {
        id: "integration-first-google",
        accountId: "integration-first-google-subject",
        providerId: "google",
        userId: first.userId,
      },
      {
        id: "integration-second-google",
        accountId: "integration-second-google-subject",
        providerId: "google",
        userId: second.userId,
      },
    ]);
    const checking = await createAccount(first, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "500",
    });
    const savings = await createAccount(first, {
      name: "Savings",
      type: "savings",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const euro = await createAccount(first, {
      name: "Euro Cash",
      type: "cash",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "20",
    });
    checkingId = checking.id;
    savingsId = savings.id;
    euroId = euro.id;
    const acceptanceAccounts = await Promise.all(
      ["Direct Path", "Staged Path", "MCP Path"].map((name) =>
        createAccount(first, {
          name,
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "0",
        }),
      ),
    );
    [directAccountId, stagedAccountId, mcpAccountId] = acceptanceAccounts.map(
      (account) => account.id,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it("isolates account and transaction IDs by tenant", async () => {
    expect(await listAccounts(second)).toEqual([]);
    await expect(
      getTransaction(second, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps import-batch provenance internal and tenant-scoped", async () => {
    const [otherBatch] = await getDb()
      .insert(importBatches)
      .values({
        userId: second.userId,
        fileName: "other-tenant.csv",
        fileHash: "other-tenant-import-batch",
        delimiter: ",",
        mapping: {},
        rowCount: 1,
      })
      .returning();

    await expect(
      createStage(first, {
        draft: {
          type: "deposit",
          date: "2026-07-14",
          payee: "Attempted cross-tenant provenance",
          description: "Attempted cross-tenant provenance",
          toAccountId: checkingId,
          amount: "1",
        },
        idempotencyKey: "cross-tenant-import-provenance",
        importBatchId: otherBatch.id,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });

    const linkedRows = await getDb().execute(sql`
      select count(*)::int as count
      from staged_transaction
      where user_id = ${first.userId}
        and import_batch_id = ${otherBatch.id}::uuid
    `);
    expect(Number(linkedRows.rows[0]?.count)).toBe(0);
  });

  it("commits deposits idempotently and produces native balances", async () => {
    const draft: TransactionDraft = {
      type: "deposit",
      date: "2026-07-15",
      payee: "Paycheck",
      description: "Paycheck",
      toAccountId: checkingId,
      amount: "1200.50",
    };
    const created = await createTransaction(first, draft, "integration-paycheck");
    const retried = await createTransaction(first, draft, "integration-paycheck");
    expect(retried.id).toBe(created.id);
    expect((await listAccounts(first)).find((item) => item.id === checkingId)?.balance).toBe(
      "1700.5",
    );
  });

  it("stores distinct amounts for a per-account FX transfer", async () => {
    const transaction = await createTransaction(
      first,
      {
        type: "transfer",
        date: "2026-07-16",
        payee: "Travel cash",
        description: "Travel cash",
        fromAccountId: checkingId,
        toAccountId: euroId,
        sourceAmount: "110",
        destinationAmount: "100",
      },
      "integration-fx-transfer",
    );
    expect(transaction).toMatchObject({
      sourceAmount: "110",
      destinationAmount: "100",
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
    });
  });

  it("rolls back an entire staged selection on a stale version", async () => {
    const firstStage = await createStage(first, {
      draft: {
        type: "transfer",
        date: "2026-07-17",
        payee: "Move to savings",
        description: "Move to savings",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        sourceAmount: "50",
      },
      idempotencyKey: "integration-stage-one",
    });
    const secondStage = await createStage(first, {
      draft: {
        type: "withdrawal",
        date: "2026-07-18",
        payee: "Groceries",
        description: "Groceries",
        fromAccountId: checkingId,
        amount: "75",
      },
      idempotencyKey: "integration-stage-two",
    });
    await expect(
      commitStages(first, {
        stagedIds: [firstStage.id, secondStage.id],
        expectedVersions: {
          [firstStage.id]: firstStage.version,
          [secondStage.id]: secondStage.version + 1,
        },
        idempotencyKey: "integration-bad-bulk",
        allowDuplicates: false,
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const preview = await commitStages(first, {
      stagedIds: [firstStage.id, secondStage.id],
      expectedVersions: {
        [firstStage.id]: firstStage.version,
        [secondStage.id]: secondStage.version,
      },
      idempotencyKey: "integration-good-bulk",
      allowDuplicates: false,
      dryRun: true,
    });
    expect(preview).toMatchObject({ valid: true, count: 2 });
  });

  it("groups summaries by currency and excludes transfers from cash flow", async () => {
    const summary = await getSummary(first, {
      start: "2026-07-01",
      end: "2026-07-31",
    });
    expect(summary.currencies.map((item) => item.currency)).toEqual(["EUR", "USD"]);
    expect(summary.currencies.find((item) => item.currency === "USD")).toMatchObject({
      deposits: "1200.5",
      withdrawals: "0",
      netCashFlow: "1200.5",
    });
  });

  it("writes scoped audit history", async () => {
    // The MCP tool promises this exact shape. A tool whose output schema does
    // not match its service fails validation on every call, which no other test
    // would notice because the service itself is fine.
    const audited = await listAuditEvents(first, { limit: 100 });
    expect(
      cursorPageResultSchema(auditEventResultSchema).safeParse({
        ...audited,
        items: audited.items.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })),
      }).success,
    ).toBe(true);

    const firstEvents = await listAuditEvents(first, { limit: 100 });
    const secondEvents = await listAuditEvents(second, { limit: 100 });
    expect(firstEvents.items.length).toBeGreaterThan(6);
    expect(secondEvents.items).toHaveLength(0);
    expect(firstEvents.items.every((event) => event.userId === first.userId)).toBe(true);
  });

  it("produces equivalent results through direct, staged, and MCP paths", async () => {
    const baseDraft = {
      type: "deposit" as const,
      date: "2026-07-25",
      payee: "Equivalent path deposit",
      description: "Equivalent path deposit",
      amount: "10.25",
    };
    await createTransaction(
      first,
      { ...baseDraft, toAccountId: directAccountId },
      "integration-direct-path",
    );

    const stage = await createStage(first, {
      draft: { ...baseDraft, toAccountId: stagedAccountId },
      idempotencyKey: "integration-staged-path",
    });
    await commitStages(first, {
      stagedIds: [stage.id],
      expectedVersions: { [stage.id]: stage.version },
      idempotencyKey: "integration-staged-path-commit",
      allowDuplicates: false,
      dryRun: false,
    });

    const mcpActor: Actor = { userId: first.userId, source: "mcp", clientId: "integration" };
    const mcpServer = createMcpServer(
      mcpActor,
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "integration-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const createdMcpAccount = await client.callTool({
      name: "create_account",
      arguments: {
        name: "MCP single-connection account",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
        idempotencyKey: "integration-mcp-account-create",
      },
    });
    expect(createdMcpAccount.isError).not.toBe(true);
    const retriedMcpAccount = await client.callTool({
      name: "create_account",
      arguments: {
        name: "MCP single-connection account",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
        idempotencyKey: "integration-mcp-account-create",
      },
    });
    expect(retriedMcpAccount.structuredContent).toEqual(createdMcpAccount.structuredContent);
    const mcpResult = await client.callTool({
      name: "create_transaction",
      arguments: {
        draft: { ...baseDraft, toAccountId: mcpAccountId },
        idempotencyKey: "integration-mcp-path",
      },
    });
    expect(mcpResult.isError).not.toBe(true);
    expect(mcpResult.structuredContent).toMatchObject({
      result: { type: "deposit", destinationAmount: "10.25" },
    });
    await client.close();
    await mcpServer.close();

    const pathAccounts = (await listAccounts(first)).filter((account) =>
      [directAccountId, stagedAccountId, mcpAccountId].includes(account.id),
    );
    expect(pathAccounts.map((account) => account.balance).sort()).toEqual([
      "10.25",
      "10.25",
      "10.25",
    ]);
    const events = (await listAuditEvents(first, { limit: 200 })).items.filter(
      (event) =>
        event.entityType === "transaction" &&
        ["create", "create_from_stage"].includes(event.operation),
    );
    expect(
      events.some((event) => event.actorSource === "web" && event.operation === "create"),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.actorSource === "web" && event.operation === "create_from_stage",
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.actorSource === "mcp" && event.clientId === "integration"),
    ).toBe(true);
  });

  it("issues and validates audience-bound RS256 MCP access tokens", async () => {
    await getDb().insert(oauthApplication).values({
      id: "integration-oauth-app",
      name: "Integration OAuth Client",
      clientId: "integration-oauth-client",
      redirectUrls: "http://127.0.0.1:7777/callback",
      type: "public",
      userId: first.userId,
    });
    await getDb()
      .insert(oauthAccessToken)
      .values({
        id: "integration-oauth-token",
        accessToken: "integration-opaque-access-token",
        refreshToken: "integration-opaque-refresh-token",
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenExpiresAt: new Date(Date.now() + 120_000),
        clientId: "integration-oauth-client",
        userId: first.userId,
        scopes: "openid ledger:read",
      });
    const token = await issueMcpAccessToken("integration-opaque-access-token");
    const verified = await jwtVerify(token, createLocalJWKSet(await getMcpJwks()), {
      algorithms: ["RS256"],
      issuer: "http://localhost:3000",
      audience: "http://localhost:3000/mcp",
    });
    expect(verified.payload).toMatchObject({
      sub: first.userId,
      client_id: "integration-oauth-client",
      scope: "openid ledger:read",
    });
    // A JWT is signed, not encrypted. Anything that handles one reads every
    // claim in it, so the payload must not carry a credential that works on its
    // own — only the row id the server exchanges for one.
    expect(JSON.stringify(verified.payload)).not.toContain("integration-opaque-access-token");
    expect(verified.payload.grant_id).toBe("integration-oauth-token");
    expect(await unwrapMcpAccessToken(token)).toBe("integration-opaque-access-token");
    const { default: app } = await import("../../src/server/api.js");
    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "jwt-integration", version: "1.0.0" },
      },
    });
    const authorized = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody,
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "simple-balance" } },
    });
    const opaqueRejected = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer integration-opaque-access-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody,
    });
    expect(opaqueRejected.status).toBe(401);
    const parts = token.split(".");
    const signature = parts[2];
    const replacement = signature[5] === "a" ? "b" : "a";
    const tampered = `${parts[0]}.${parts[1]}.${signature.slice(0, 5)}${replacement}${signature.slice(6)}`;
    expect(await unwrapMcpAccessToken(tampered)).toBeNull();
    const rejected = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tampered}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: initializeBody,
    });
    expect(rejected.status).toBe(401);

    const providerIdToken = await new SignJWT({
      nonce: "integration-nonce",
      email: "first-integration@example.com",
      auth_time: Date.now(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(first.userId)
      .setAudience("integration-oauth-client")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("integration-provider-secret"));
    const idToken = await resignMcpIdToken(providerIdToken);
    const verifiedIdToken = await jwtVerify(idToken, createLocalJWKSet(await getMcpJwks()), {
      algorithms: ["RS256"],
      issuer: "http://localhost:3000",
      audience: "integration-oauth-client",
    });
    expect(verifiedIdToken.payload).toMatchObject({
      sub: first.userId,
      nonce: "integration-nonce",
      email: "first-integration@example.com",
    });
    expect(Number(verifiedIdToken.payload.auth_time)).toBeLessThan(10_000_000_000);
  });
});
