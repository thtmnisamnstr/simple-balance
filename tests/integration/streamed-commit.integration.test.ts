import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProgressDecoder, type ProgressFrame } from "../../src/shared/progress.js";

/**
 * The two things a streamed reply must be, proved over a real socket.
 *
 * It must be optional: a client that does not ask gets exactly what it got
 * before, byte for byte, and that is the whole of the compatibility promise
 * this design rests on. And it must be atomic still: the status line goes out
 * with the first frame, so a refusal arriving at row two thousand can only be a
 * frame — and the books have to be untouched when it does.
 *
 * Over HTTP rather than against the service, because everything at stake is in
 * the transport: which header was sent, which content type came back, whether
 * the frames arrived before the response finished, and whether the terminal
 * frame carries what the plain route would have.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_streamed_${process.pid}_${Date.now()}`;

type App = (typeof import("../../src/server/api.js"))["default"];
const BASE = "http://localhost:3000";

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

let admin: PgClient;
let app: App;
let closeDb: () => Promise<void>;
let cookie = "";
/** The signed-up user's id, for the one case that calls a service directly. */
let ownerId = "";

const request = (path: string, init: RequestInit = {}) =>
  app.request(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, { method: "POST", body: JSON.stringify(body), headers });

/** Reads every frame off a streamed reply, in the order they arrived. */
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

let accountId = "";
let nextRow = 0;

/** `count` staged rows, and the commit body that would commit them. */
async function stageRows(count: number) {
  const rows: { id: string; version: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    nextRow += 1;
    const response = await post("/api/v1/staged-transactions", {
      idempotencyKey: `staged-row-${nextRow}`,
      draft: {
        type: "withdrawal",
        // Distinct amounts, because two identical rows in one commit are
        // refused as duplicates of each other and this is not that test.
        date: "2026-07-30",
        payee: `Streamed ${nextRow}`,
        fromAccountId: accountId,
        amount: `${nextRow}.00`,
      },
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as { id: string; version: number };
    rows.push(row);
  }
  return {
    stagedIds: rows.map((row) => row.id),
    expectedVersions: Object.fromEntries(rows.map((row) => [row.id, row.version])),
    allowDuplicates: false,
    dryRun: false,
  };
}

const committedCount = async () => {
  const response = await request("/api/v1/transactions?limit=1");
  return ((await response.json()) as { totalCount: number }).totalCount;
};

integration("a commit that reports its own progress", () => {
  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(connection!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.DATABASE_POOL_SIZE = "1";
    process.env.NODE_ENV = "development";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = BASE;
    process.env.AUTH_SECRET = "streamed-commit-secret-at-least-32-characters";
    process.env.ALLOWED_EMAILS = "streamed@example.test";
    process.env.TRUST_PROXY = "true";

    vi.resetModules();
    const migrate = await import("../../src/server/db/migrate.js");
    await migrate.runMigrations();
    const client = await import("../../src/server/db/client.js");
    closeDb = client.closeDb;
    app = (await import("../../src/server/api.js")).default;

    const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Streamed",
        email: "streamed@example.test",
        password: "streamed-commit-password",
      }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    ownerId = ((await signUp.json()) as { user: { id: string } }).user.id;

    const account = await post("/api/v1/accounts", {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    expect(account.status).toBe(201);
    accountId = ((await account.json()) as { id: string }).id;
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

  it("answers a caller that did not ask exactly as it did before", async () => {
    const body = await stageRows(2);
    const response = await post("/api/v1/staged-transactions/commit", {
      ...body,
      idempotencyKey: "plain-commit-key",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    // The two headers a streamed reply adds must be absent here, or "opt in"
    // would be a description of the body alone.
    expect(response.headers.get("X-Accel-Buffering")).toBeNull();
    expect(await response.json()).toEqual({
      committed: body.stagedIds.map((stagedId) => ({
        stagedId,
        transactionId: expect.any(String),
      })),
    });
  });

  it("reports each phase, then ends in the reply the plain route would have sent", async () => {
    const body = await stageRows(3);
    const response = await post(
      "/api/v1/staged-transactions/commit",
      { ...body, idempotencyKey: "streamed-commit-key" },
      { accept: "text/event-stream" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    // `no-store` survives. Hono's own SSE helper sets `no-cache` instead, which
    // would put somebody's ledger in a shared cache and break the rule
    // `/api/v1` keeps without exception.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const frames = await readFrames(response);
    const terminal = frames.at(-1)!;
    expect(terminal.type).toBe("result");
    // Byte for byte what the other branch returns, which is what makes this a
    // second representation rather than a second contract.
    expect(terminal.type === "result" ? terminal.value : null).toEqual({
      committed: body.stagedIds.map((stagedId) => ({
        stagedId,
        transactionId: expect.any(String),
      })),
    });
    // Every frame before the last says which row a loop is on and nothing else,
    // and there is at least one: a reply that reported nothing and then
    // answered would pass every other assertion here.
    expect(frames.slice(0, -1).every((frame) => frame.type === "progress")).toBe(true);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      if (frame.type !== "progress") continue;
      expect(frame.event.done).toBeLessThanOrEqual(frame.event.total);
      expect(frame.event.total).toBe(3);
    }
  });

  it("writes nothing when a refusal arrives mid-stream, and says which code it was", async () => {
    const body = await stageRows(3);
    const before = await committedCount();
    const response = await post(
      "/api/v1/staged-transactions/commit",
      {
        ...body,
        // One row described as a version it is not. The commit is atomic, so
        // this refuses the whole batch — the case a bar makes visible and the
        // case where "nothing was committed" has to be true.
        expectedVersions: { ...body.expectedVersions, [body.stagedIds[2]!]: 99 },
        idempotencyKey: "streamed-refusal-key",
      },
      { accept: "text/event-stream" },
    );

    // 200, because the status line went out with the first frame and there is
    // no way back. The refusal is the last frame instead.
    expect(response.status).toBe(200);
    const frames = await readFrames(response);
    const terminal = frames.at(-1)!;
    expect(terminal.type).toBe("error");
    expect(terminal.type === "error" ? terminal.error.error.code : null).toBe("STALE_VERSION");
    expect(await committedCount()).toBe(before);

    // And the rows are still in the queue, untouched, which is the half a
    // transaction count cannot see.
    const queue = await request(
      `/api/v1/staged-transactions?status=staged&search=${encodeURIComponent("Streamed")}`,
    );
    const staged = (await queue.json()) as { items: { id: string; status: string }[] };
    for (const id of body.stagedIds) {
      expect(staged.items.find((row) => row.id === id)?.status).toBe("staged");
    }
  });

  it("walks the three phases in order, every row of each", async () => {
    // Against the service rather than the socket, because the pump coalesces:
    // over HTTP only the latest snapshot is ever sent, so a fast commit shows
    // one frame and a test on the wire could not tell a phase that reported
    // every row from one that reported none. This is where the sequence is
    // decidable, and it is the sequence the bar is drawn from.
    const { commitStages } = await import("../../src/server/services/staging.js");
    const body = await stageRows(3);
    const seen: { phase: string; done: number; total: number }[] = [];
    await commitStages(
      { userId: ownerId, source: "web" },
      { ...body, idempotencyKey: "phase-sequence-key" },
      undefined,
      { onProgress: (event) => seen.push({ ...event }) },
    );

    expect(seen).toEqual([
      { phase: "validating", done: 1, total: 3 },
      { phase: "validating", done: 2, total: 3 },
      { phase: "validating", done: 3, total: 3 },
      { phase: "duplicates", done: 1, total: 3 },
      { phase: "duplicates", done: 2, total: 3 },
      { phase: "duplicates", done: 3, total: 3 },
      { phase: "posting", done: 1, total: 3 },
      { phase: "posting", done: 2, total: 3 },
      { phase: "posting", done: 3, total: 3 },
    ]);
  });

  it("reports a CSV stage the same way, and stages nothing extra for it", async () => {
    const rows = Array.from(
      { length: 4 },
      (_, index) => `2026-07-30,Imported ${index},-${index + 1}.00`,
    );
    const response = await post(
      "/api/v1/csv/stage",
      {
        csv: ["date,payee,amount", ...rows].join("\n"),
        fileName: "streamed.csv",
        idempotencyKey: "streamed-stage-key",
        defaultAccountId: accountId,
        mapping: { date: "date", payee: "payee", amount: "amount" },
        dateFormat: "YMD",
        decimalSeparator: ".",
        dryRun: false,
      },
      { accept: "text/event-stream" },
    );

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const frames = await readFrames(response);
    const reported = frames.filter((frame) => frame.type === "progress");
    expect(reported.length).toBeGreaterThan(0);
    // One phase, because an import's per-row cost is one loop: everything
    // before it resolves the file as a whole.
    expect(
      reported.every(
        (frame) => (frame.type === "progress" ? frame.event.phase : null) === "staging",
      ),
    ).toBe(true);
    const terminal = frames.at(-1)!;
    expect(terminal.type).toBe("result");
    expect((terminal as { value: { rowCount: number } }).value.rowCount).toBe(4);
  });
});
