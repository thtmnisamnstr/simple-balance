import { defineConfig } from "@playwright/test";

/**
 * The browser tier.
 *
 * Everything else in this repository tests below the browser: services called
 * directly, transports over an in-memory pair, components in jsdom. All of it
 * passed while the budgets page had a checkbox that did nothing and a form that
 * offered a category combination the server refuses, because jsdom renders
 * markup and does not run a browser.
 *
 * Three processes, which is the documented development setup rather than
 * anything invented for tests: PostgreSQL, the API on 3000, and Vite on 5173
 * proxying `/api` to it. Vite serves the client because the API only serves the
 * built bundle in production, and production marks its cookies secure, which no
 * session over plain http would survive.
 *
 * `BROWSER_DATABASE_URL` is required rather than defaulted. A browser run
 * writes real rows through the real API, and defaulting it to a development
 * database would eventually delete somebody's ledger to make a test pass.
 */
const database = process.env.BROWSER_DATABASE_URL;
if (!database) {
  throw new Error(
    "BROWSER_DATABASE_URL is required. Point it at a throwaway database: the suite signs up, writes transactions and reads them back through the real API.",
  );
}

const api = {
  DATABASE_URL: database,
  APP_BASE_URL: "http://localhost:5173",
  PORT: "3000",
  AUTH_MODE: "local",
  AUTH_SECRET: "browser-tier-secret-long-enough-for-the-config-validator-0",
  NODE_ENV: "development",
  // Anyone may register, so the first-run setup code is not required. That code
  // only ever covers an address the allow list would turn away.
  ALLOWED_EMAILS: "*",
  // Nothing here waits on a schedule, and a sweep running underneath a test
  // would write staged rows it did not ask for.
  RECURRENCE_SCHEDULER: "false",
};

export default defineConfig({
  testDir: "tests/browser",
  // One worker. These specs share one database and one signed-up account, and
  // parallel workers racing the same ledger is a source of failures that look
  // like defects and are not.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx src/server/index.ts",
      url: "http://localhost:3000/health/ready",
      reuseExistingServer: false,
      timeout: 120_000,
      env: api,
    },
    {
      command: "npx vite --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
