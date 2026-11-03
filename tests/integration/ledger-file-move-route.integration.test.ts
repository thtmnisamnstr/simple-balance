import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgressDecoder, type ProgressFrame } from "../../src/shared/progress.js";

/**
 * The move over HTTP, signed in the way the browser is: the colon in its path,
 * the refusal a body that is no move request gets before anything streams, the
 * frames a move streams when asked — the transactions it writes, then the rows
 * it stages — and that the last of them is byte for byte the reply the plain
 * branch sends, or an error frame carrying the code the plain branch would.
 *
 * Over HTTP because what is at stake is the transport. The service suite
 * beside this one holds what a move does; it cannot see a status line.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_ledger_file_move_route_${process.pid}_${Date.now()}`;

type App = (typeof import("../../src/server/api.js"))["default"];
const BASE = "http://localhost:3000";
const EMAILS = ["move-from@example.test", "move-to@example.test"];

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

let admin: PgClient | undefined;
let app: App;
let closeDb: (() => Promise<void>) | undefined;
const cookies: string[] = [];
let file = "";

const request = (who: number, path: string, init: RequestInit = {}) =>
  app.request(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      cookie: cookies[who]!,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const post = (who: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(who, path, { method: "POST", body: JSON.stringify(body), headers });

async function readFrames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const decode = createProgressDecoder();
  const frames: ProgressFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    frames.push(...decode(decoder.decode(value, { stream: !done })));
    if (done) return frames;
  }
}

integration("the Simple Balance file's move over HTTP", () => {
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
    process.env.AUTH_SECRET = "ledger-file-move-route-secret-at-least-32-characters";
    process.env.ALLOWED_EMAILS = EMAILS.join(",");
    process.env.TRUST_PROXY = "true";

    vi.resetModules();
    const migrate = await import("../../src/server/db/migrate.js");
    await migrate.runMigrations();
    closeDb = (await import("../../src/server/db/client.js")).closeDb;
    app = (await import("../../src/server/api.js")).default;

    for (const email of EMAILS) {
      const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ name: email, email, password: "ledger-file-move-route-password" }),
      });
      expect(signUp.status).toBe(200);
      cookies.push(
        signUp.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; "),
      );
    }

    const created = async (path: string, body: unknown) => {
      const response = await post(0, path, body);
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return (await response.json()) as { id: string; version: number };
    };
    const checking = await created("/api/v1/accounts", {
      name: "Checking",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    const entries = [];
    for (let n = 1; n <= 3; n += 1) {
      entries.push(
        await created("/api/v1/transactions", {
          idempotencyKey: `move-route-entry-${n}`,
          draft: {
            type: "withdrawal",
            date: `2026-02-0${n}`,
            payee: `Shop ${n}`,
            description: null,
            fromAccountId: checking.id,
            amount: `${n}.00`,
          },
        }),
      );
    }
    // One of them deleted, so the move writes it and voids it again.
    const gone = entries[2]!;
    const deleted = await post(0, `/api/v1/transactions/${gone.id}/deleted`, {
      expectedVersion: gone.version,
      deleted: true,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const exported = await request(
      0,
      "/api/v1/ledger-file?kinds=accounts,categories,entries,deletedEntries",
    );
    expect(exported.status).toBe(200);
    file = await exported.text();
  }, 120_000);

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

  it("moves at a colon path, and the colon is not a parameter", async () => {
    const encoded = await post(1, "/api/v1/ledger-file%3Amove", {
      ledgerFile: file,
      fileName: "x.json",
      idempotencyKey: "move-route-encoded",
    });
    expect(encoded.status).toBe(404);
  });

  it("refuses a body that is no move before anything is streamed", async () => {
    const response = await post(
      1,
      "/api/v1/ledger-file:move",
      { ledgerFile: "", fileName: "x.json", idempotencyKey: "move-route-not-a-file" },
      { accept: "text/event-stream" },
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const unknown = await post(1, "/api/v1/ledger-file:move", {
      ledgerFile: file,
      fileName: "x.json",
      idempotencyKey: "move-route-stray-field",
      dryRun: true,
    });
    expect(unknown.status).toBe(422);
  });

  it("streams a move when asked, ending in the reply the plain branch sends", async () => {
    const body = {
      ledgerFile: file,
      fileName: "simple-balance.json",
      idempotencyKey: "move-route-streamed",
    };
    const streamed = await post(1, "/api/v1/ledger-file:move", body, {
      accept: "text/event-stream",
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("Content-Type")).toBe("text/event-stream");
    const frames = await readFrames(streamed);
    const terminal = frames.at(-1)!;
    expect(terminal.type, JSON.stringify(terminal)).toBe("result");
    const progress = frames.filter((frame) => frame.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const frame of progress) {
      expect(frame.event).toMatchObject({ phase: "posting", total: 3 });
    }
    expect(terminal.type === "result" ? terminal.value : null).toMatchObject({
      written: { entries: 2, deleted: 1 },
      balances: { checked: 1, notCompared: 0 },
    });

    // The same key again over the plain branch replays the part.
    const plain = await post(1, "/api/v1/ledger-file:move", body);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual(terminal.type === "result" ? terminal.value : null);

    // The moved entries are in the books, and say nothing of their origin.
    const listed = await request(1, "/api/v1/transactions");
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).toContain("Shop 1");
    expect(text).not.toContain("importOrigin");
  });

  it("ends a refused move in an error frame with the code the plain branch would send", async () => {
    // The ledger the file came from holds entries typed into it.
    const response = await post(
      0,
      "/api/v1/ledger-file:move",
      { ledgerFile: file, fileName: "simple-balance.json", idempotencyKey: "move-route-refused" },
      { accept: "text/event-stream" },
    );
    expect(response.status).toBe(200);
    const terminal = (await readFrames(response)).at(-1)!;
    expect(terminal.type).toBe("error");
    expect(terminal.type === "error" ? terminal.error.error.code : null).toBe("VALIDATION_ERROR");
    const plain = await post(0, "/api/v1/ledger-file:move", {
      ledgerFile: file,
      fileName: "simple-balance.json",
      idempotencyKey: "move-route-refused-plain",
    });
    expect(plain.status).toBe(422);
    expect(((await plain.json()) as { error: { message: string } }).error.message).toContain(
      "can only be added to it",
    );
  });
});
