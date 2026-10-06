import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `AGENTS.md`: "Keep migrations safe under the advisory lock and fail readiness
 * on migration failure." Both entrypoints await `runMigrations()` before
 * `serve()`, so a migration that fails is a process that never listens, never
 * answers `/health/ready`, and exits non-zero.
 *
 * Every other startup test stands `runMigrations` in as a success, so the half
 * of the rule that matters — what happens when it is not — was asserted by
 * nothing. A reordering that served first and migrated after would have opened
 * readiness against a schema the build does not expect, with every test green.
 */
const seen = vi.hoisted(() => ({ served: 0, migrations: 0, scheduled: 0 }));

vi.mock("@hono/node-server", () => ({
  serve: () => {
    seen.served += 1;
    return {};
  },
}));
vi.mock("../src/server/db/migrate.js", () => ({
  runMigrations: async () => {
    seen.migrations += 1;
    throw new Error("relation already exists");
  },
}));
vi.mock("../src/server/db/client.js", () => ({ closeDb: async () => {}, getDb: () => ({}) }));
vi.mock("../src/server/recurrence-scheduler.js", () => ({
  createRecurrenceScheduler: () => {
    seen.scheduled += 1;
    return { enabled: true, stop: async () => {} };
  },
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  seen.served = 0;
  seen.migrations = 0;
  seen.scheduled = 0;
  // Both entrypoints report a failed start through this field, and vitest
  // reads it when the run ends, so one left set would fail a green run.
  process.exitCode = 0;
});

async function start(entrypoint: string) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process, "on").mockImplementation(() => process);
  await import(entrypoint);
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
}

describe("a start whose migration fails", () => {
  it.each([
    ["the API", "../src/server/index.js"],
    ["the scheduler", "../src/server/scheduler.js"],
  ])("never lets %s listen, and exits non-zero", async (_name, entrypoint) => {
    await start(entrypoint);
    expect(seen.migrations).toBe(1);
    expect(seen.served).toBe(0);
    expect(seen.scheduled).toBe(0);
  });
});
