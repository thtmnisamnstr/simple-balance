import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgressDecoder, type ProgressFrame } from "../../src/shared/progress.js";

/**
 * The two routes that read a Simple Balance file back, over the real app and
 * signed in the way the browser is: the colon in their paths, the refusal a
 * body that is no add request gets before anything streams, the frames an add
 * streams when asked, and that the last of them is byte for byte the reply the
 * plain branch sends.
 *
 * Over HTTP because what is at stake is the transport. The service suite
 * beside this one holds what an add does; it cannot see a status line.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_ledger_file_add_route_${process.pid}_${Date.now()}`;

type App = (typeof import("../../src/server/api.js"))["default"];
const BASE = "http://localhost:3000";
const EMAILS = ["from@example.test", "to@example.test"];

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

integration("the Simple Balance file's preview and add over HTTP", () => {
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
    process.env.AUTH_SECRET = "ledger-file-add-route-secret-at-least-32-characters";
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
        body: JSON.stringify({ name: email, email, password: "ledger-file-add-route-password" }),
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
      return (await response.json()) as { id: string };
    };
    const checking = await created("/api/v1/accounts", {
      name: "Checking",
      type: "checking",
      currency: "EUR",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    for (let n = 1; n <= 3; n += 1) {
      await created("/api/v1/transactions", {
        idempotencyKey: `route-entry-${n}`,
        draft: {
          type: "withdrawal",
          date: `2026-02-0${n}`,
          payee: `Shop ${n}`,
          description: null,
          fromAccountId: checking.id,
          amount: `${n}.00`,
        },
      });
    }
    const exported = await request(0, "/api/v1/ledger-file?kinds=accounts,categories,entries");
    expect(exported.status).toBe(200);
    file = await exported.text();
  }, 120_000);

  afterAll(async () => {
    // The pool the app opened, from the module instance it was loaded with
    // after the reset, rather than the one a static import would name.
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

  it("previews at a colon path, and the colon is not a parameter", async () => {
    const response = await post(1, "/api/v1/ledger-file:preview", { ledgerFile: file });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as {
      plan: { ok: boolean; rows: { toStage: number } };
    };
    expect(preview.plan).toMatchObject({ ok: true, rows: { toStage: 3 } });

    const encoded = await post(1, "/api/v1/ledger-file%3Apreview", { ledgerFile: file });
    expect(encoded.status).toBe(404);
  });

  it("refuses a body that is no file before anything is streamed", async () => {
    const response = await post(
      1,
      "/api/v1/ledger-file:add",
      { ledgerFile: "", fileName: "x.json", idempotencyKey: "route-not-a-file" },
      { accept: "text/event-stream" },
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const notJson = await post(1, "/api/v1/ledger-file:preview", { ledgerFile: "a,b,c\n1,2,3" });
    expect(notJson.status).toBe(422);
    const body = (await notJson.json()) as { error: { code: string; details: { issues: [] } } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it("streams an add when asked, ending in the reply the plain branch sends", async () => {
    const add = {
      ledgerFile: file,
      fileName: "simple-balance.json",
      idempotencyKey: "route-add-streamed",
    };
    const streamed = await post(1, "/api/v1/ledger-file:add", add, {
      accept: "text/event-stream",
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("Content-Type")).toBe("text/event-stream");
    expect(streamed.headers.get("Cache-Control")).toBe("no-store");
    const frames = await readFrames(streamed);
    const terminal = frames.at(-1)!;
    expect(terminal.type).toBe("result");
    const progress = frames.filter((frame) => frame.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const frame of progress) {
      expect(frame.event).toMatchObject({ phase: "staging", total: 3 });
    }

    // The same key again over the plain branch replays the part, which is the
    // reply the stream ended in.
    const plain = await post(1, "/api/v1/ledger-file:add", add);
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual(terminal.type === "result" ? terminal.value : null);
  });

  /**
   * The rows the add staged carry their origin, and the entries typed in the
   * ledger they came from have none; neither is in what the routes send,
   * because no form acts on it and a field published by accident is one only
   * a deprecation can take back.
   */
  it("sends no origin in a staged row or an entry", async () => {
    const staged = await request(1, "/api/v1/staged-transactions");
    expect(staged.status).toBe(200);
    const queue = await staged.text();
    expect((JSON.parse(queue) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect(queue).not.toContain("importOrigin");
    const entries = await request(0, "/api/v1/transactions");
    expect(entries.status).toBe(200);
    expect(await entries.text()).not.toContain("importOrigin");
  });

  it("ends a refused add in an error frame with the code the plain branch would send", async () => {
    const response = await post(
      1,
      "/api/v1/ledger-file:add",
      {
        ledgerFile: file,
        fileName: "simple-balance.json",
        idempotencyKey: "route-add-refused",
        decisions: [{ kind: "account", key: "Nowhere", action: "skip" }],
      },
      { accept: "text/event-stream" },
    );
    expect(response.status).toBe(200);
    const terminal = (await readFrames(response)).at(-1)!;
    expect(terminal.type).toBe("error");
    expect(terminal.type === "error" ? terminal.error.error.code : null).toBe("VALIDATION_ERROR");
  });
});
