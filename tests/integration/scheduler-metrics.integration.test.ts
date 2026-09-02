import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The scheduler's own `/metrics`, driven rather than read.
 *
 * `operations.md`, the chart's README and the CHANGELOG all say both entrypoints
 * answer, and that a split deployment scraping only the API is watching the
 * process that does none of the scheduled work. Every other metrics test drives
 * the API app, and the one check this half had read `src/server/scheduler.ts`
 * as text and asserted three strings appeared in it — which would have passed on
 * a file that could not start.
 *
 * So this one starts it. `src/server/scheduler.ts` calls `main()` at import and
 * runs migrations, which is why it cannot be a unit test: importing it into a
 * test process would take over that process, and there is nothing to migrate
 * without a database.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_sched_metrics_${process.pid}_${Date.now()}`;

/** A port nothing is listening on, asked of the kernel rather than guessed. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

integration("the scheduler process", () => {
  let admin: PgClient;
  let child: ReturnType<typeof spawn>;
  let port: number;
  const output: string[] = [];

  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(connection!);
    url.pathname = `/${databaseName}`;
    port = await freePort();
    child = spawn("npx", ["tsx", "src/server/scheduler.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: url.toString(),
        PORT: String(port),
        METRICS_ENABLED: "true",
        NODE_ENV: "development",
        // The tick is forced on by this entrypoint and cannot be turned off, so
        // it is pushed to the far end of what the bound allows. A sweep running
        // underneath the scrape would not break anything; it would just be work
        // this test never asked for.
        RECURRENCE_TICK_SECONDS: "3600",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

    // Migrations run before the listener opens, so this is a real wait rather
    // than a formality on a first-run database.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`the scheduler exited with ${child.exitCode}: ${output.join("")}`);
      }
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/health/ready`);
        if (probe.ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`never became ready: ${output.join("")}`);
      await delay(250);
    }
  }, 120_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    // Long enough for the graceful shutdown to drain and close the pool, so the
    // drop below is not racing a live connection.
    for (let waited = 0; child && child.exitCode === null && waited < 20_000; waited += 100) {
      await delay(100);
    }
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  }, 60_000);

  it("serves its own metrics, labelled as the scheduler", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    // The label is the whole point. Both processes expose the same metric names,
    // so without it a split deployment's two scrapes collide and a proposal
    // counter reads as though the API were proposing.
    expect(text).toContain('component="scheduler"');
    expect(text).toContain("simple_balance_build_info");
    expect(text).toContain("nodejs_eventloop_lag_seconds");
  });

  it("still answers the probes a Deployment configures", async () => {
    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(ready.status).toBe(200);
  });

  it("serves nothing else, so a Service pointed here by mistake cannot work", async () => {
    const api = await fetch(`http://127.0.0.1:${port}/api/v1/accounts`);
    // Not 401. A pod running this entrypoint has no API mounted at all, which
    // is what keeps a misrouted Service from quietly half-working.
    expect(api.status).toBe(404);
  });
});
