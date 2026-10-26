import { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultLedgerFileKinds,
  ledgerFileQueryString,
  parseLedgerFileText,
} from "../../src/shared/ledger-file.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * `GET /api/v1/ledger-file` over the real app, signed in the way the browser
 * is: what the download carries in its headers, which refusals come back as
 * which status, and that the file is the one `export_ledger_file` hands an
 * agent.
 *
 * Over HTTP rather than against the service, because what is at stake is the
 * transport — the query string a page builds, the media type, the dated name a
 * browser saves the file under — and the service suite cannot see any of it.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_ledger_file_route_${process.pid}_${Date.now()}`;

type App = (typeof import("../../src/server/api.js"))["default"];
type Mcp = typeof import("../../src/server/mcp.js");
const BASE = "http://localhost:3000";
// Fourteen hours ahead of UTC, so for most of every day its date is not the
// server's, and a file dated by the server clock would be caught here.
const TIMEZONE = "Pacific/Kiritimati";

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

let admin: PgClient;
let app: App;
let mcp: Mcp;
let closeDb: () => Promise<void>;
let cookie = "";
let ownerId = "";
let checkingId = "";
let savingsId = "";

const request = (path: string, init: RequestInit = {}, withCookie = true) =>
  app.request(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      ...(withCookie ? { cookie } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const post = async (path: string, body: unknown, method = "POST") => {
  const response = await request(path, { method, body: JSON.stringify(body) });
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return (await response.json()) as { id: string };
};

const withoutInstant = (text: string) => text.replace(/"exportedAt": "[^"]+"/, "");

integration("the Simple Balance file as a download", () => {
  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(connection!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.NODE_ENV = "development";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = BASE;
    process.env.AUTH_SECRET = "ledger-file-route-secret-at-least-32-characters";
    process.env.ALLOWED_EMAILS = "ledger-file@example.test";
    process.env.TRUST_PROXY = "true";

    vi.resetModules();
    const migrate = await import("../../src/server/db/migrate.js");
    await migrate.runMigrations();
    const client = await import("../../src/server/db/client.js");
    closeDb = client.closeDb;
    app = (await import("../../src/server/api.js")).default;
    mcp = await import("../../src/server/mcp.js");

    const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ledger File",
        email: "ledger-file@example.test",
        password: "ledger-file-route-password",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    ownerId = ((await signUp.json()) as { user: { id: string } }).user.id;

    await post(
      "/api/v1/preferences",
      { timezone: TIMEZONE, defaultCurrency: "EUR", theme: "system" },
      "PUT",
    );
    const open = (name: string) =>
      post("/api/v1/accounts", {
        name,
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "100",
      });
    checkingId = (await open("Checking")).id;
    savingsId = (await open("Savings")).id;
    const groceries = await post("/api/v1/categories", { name: "Groceries", kind: "expense" });
    await post("/api/v1/transactions", {
      idempotencyKey: "route-groceries",
      draft: {
        type: "withdrawal",
        date: "2026-02-02",
        payee: "Rewe",
        fromAccountId: checkingId,
        amount: "20.00",
        categoryId: groceries.id,
      },
    });
    await post("/api/v1/transactions", {
      idempotencyKey: "route-transfer",
      draft: {
        type: "transfer",
        date: "2026-02-03",
        payee: "To savings",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        sourceAmount: "30.00",
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await closeDb?.();
    } finally {
      try {
        await admin?.query(`drop database if exists "${databaseName}"`);
      } finally {
        await admin?.end();
        for (const [key, value] of Object.entries(originalEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });

  it("serves the file as JSON, as an attachment dated where the person lives", async () => {
    const query = ledgerFileQueryString({ kinds: [...defaultLedgerFileKinds] });
    const response = await request(`/api/v1/ledger-file?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="simple-balance-${todayIn(TIMEZONE)}.json"`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const parsed = parseLedgerFileText(await response.text());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.accounts.map((account) => account.key)).toEqual(["Checking", "Savings"]);
    expect(parsed.file.entries).toHaveLength(2);
  });

  it("names a file of chosen accounts as one, from the query string the page builds", async () => {
    const query = ledgerFileQueryString({
      kinds: ["accounts", "entries"],
      accountIds: [checkingId, savingsId],
      start: "2026-02-01",
      end: "2026-02-28",
    });
    expect(query).toContain("kinds=accounts%2Centries");
    const response = await request(`/api/v1/ledger-file?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="simple-balance-accounts-${todayIn(TIMEZONE)}.json"`,
    );
    const parsed = parseLedgerFileText(await response.text());
    expect(parsed.ok && parsed.file.scope).toEqual({
      kinds: ["accounts", "entries"],
      accounts: "chosen",
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("hands an agent the same file the browser downloads", async () => {
    const selection = { kinds: [...defaultLedgerFileKinds] };
    const download = await (
      await request(`/api/v1/ledger-file?${ledgerFileQueryString(selection)}`)
    ).text();

    const server = mcp.createMcpServer(
      { userId: ownerId, source: "mcp", clientId: "ledger-file-route" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "ledger-file-route", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.listTools();
      const reply = await client.callTool({ name: "export_ledger_file", arguments: selection });
      expect(JSON.stringify(reply)).not.toContain("Output validation error");
      expect(reply.isError).toBeFalsy();
      const { ledgerFile, fileName } = (
        reply.structuredContent as { result: { ledgerFile: string; fileName: string } }
      ).result;
      expect(withoutInstant(ledgerFile)).toBe(withoutInstant(download));
      expect(fileName).toBe(`simple-balance-${todayIn(TIMEZONE)}.json`);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses what the selection does not allow, naming the field", async () => {
    const unknownKind = await request("/api/v1/ledger-file?kinds=accounts,ledger");
    expect(unknownKind.status).toBe(422);
    expect(await unknownKind.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [expect.objectContaining({ field: "kinds.1" })] },
    });

    // A parameter nobody defined is refused by name rather than ignored, so a
    // misspelled filter is never an export of everything.
    const stray = await request("/api/v1/ledger-file?kinds=entries&accountId=x");
    expect(stray.status).toBe(422);
    expect(JSON.stringify(await stray.json())).toContain("accountId");

    const nothing = await request("/api/v1/ledger-file?kinds=");
    expect(nothing.status).toBe(422);
  });

  it("does not find an account that is not the person's", async () => {
    const stranger = "00000000-0000-4000-8000-000000000999";
    const response = await request(`/api/v1/ledger-file?kinds=accounts&accountIds=${stranger}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Account not found", details: { accountId: stranger } },
    });
  });

  it("answers nobody who is not signed in", async () => {
    const response = await request("/api/v1/ledger-file?kinds=accounts", {}, false);
    expect(response.status).toBe(401);
  });
});
