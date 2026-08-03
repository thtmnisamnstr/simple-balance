import { createServer, type Server } from "node:net";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);

type App = (typeof import("../../src/server/api.js"))["default"];

const BASE = "http://localhost:3000";
const setupToken = "reset-integration-setup-code-1";

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  SETUP_TOKEN: process.env.SETUP_TOKEN,
  TRUST_PROXY: process.env.TRUST_PROXY,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURITY: process.env.SMTP_SECURITY,
  MAIL_FROM: process.env.MAIL_FROM,
};

let nextClient = 0;
const fromNewClient = () => `198.51.100.${(nextClient += 1) % 250}`;

/**
 * A socket that accepts an SMTP conversation and remembers it.
 *
 * The point is not to be a mail server. It is to prove that a message was
 * handed over, to whom, and carrying which link, without the suite needing one
 * running anywhere.
 */
class RecordingSmtpServer {
  readonly messages: { to: string; body: string }[] = [];
  private server?: Server;
  port = 0;

  async start() {
    this.server = createServer((socket) => {
      let buffer = "";
      let recipient = "";
      let collecting = false;
      let body = "";
      socket.write("220 test ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\r\n");
        while (index !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (collecting) {
            if (line === ".") {
              collecting = false;
              this.messages.push({ to: recipient, body });
              body = "";
              socket.write("250 queued\r\n");
            } else {
              body += `${line}\n`;
            }
          } else {
            const command = line.toUpperCase();
            if (command.startsWith("EHLO") || command.startsWith("HELO")) {
              socket.write("250-test\r\n250 8BITMIME\r\n");
            } else if (command.startsWith("MAIL FROM")) {
              socket.write("250 ok\r\n");
            } else if (command.startsWith("RCPT TO")) {
              recipient = line.replace(/.*<|>.*/g, "");
              socket.write("250 ok\r\n");
            } else if (command === "DATA") {
              collecting = true;
              socket.write("354 go ahead\r\n");
            } else if (command === "QUIT") {
              socket.write("221 bye\r\n");
              socket.end();
            } else {
              socket.write("250 ok\r\n");
            }
          }
          index = buffer.indexOf("\r\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Waits for a message, because sending is deliberately off the request path. */
  async waitFor(to: string, matching: RegExp, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(
        (m) => m.to === to && matching.test(m.body),
      );
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `no message to ${to} matching ${matching}. Saw: ${JSON.stringify(
        this.messages.map((m) => m.to),
      )}`,
    );
  }
}

function linkFrom(body: string, path: string) {
  // Quoted-printable folds long lines with a trailing "=".
  const unfolded = body.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const match = unfolded.match(new RegExp(`http://\\S*${path}\\S*`));
  if (!match) throw new Error(`no ${path} link in: ${unfolded.slice(0, 400)}`);
  return match[0].replace(/[.,)\]]+$/, "");
}

let smtp: RecordingSmtpServer;
let adminClient: PgClient;
let databaseName: string;

// Each reload builds a fresh module graph with its own connection pool, and
// every one of them has to be closed or the database cannot be dropped.
const closers: (() => Promise<void>)[] = [];

async function loadApp(withMail: boolean): Promise<App> {
  if (withMail) {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURITY = "none";
    process.env.MAIL_FROM = "Simple Balance <balance@example.com>";
  } else {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURITY;
    delete process.env.MAIL_FROM;
  }
  vi.resetModules();
  const { closeDb } = await import("../../src/server/db/client.js");
  const { closeMail } = await import("../../src/server/mail.js");
  closers.push(async () => {
    await closeMail();
    await closeDb();
  });
  const { default: app } = await import("../../src/server/api.js");
  return app;
}

function post(app: App, path: string, body: unknown, cookie?: string) {
  return app.request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      origin: BASE,
      "content-type": "application/json",
      "x-forwarded-for": fromNewClient(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

integration("password reset and address verification", () => {
  let app: App;

  beforeAll(async () => {
    smtp = new RecordingSmtpServer();
    await smtp.start();

    databaseName = `simple_balance_reset_${process.pid}_${Date.now()}`;
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;

    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.DATABASE_POOL_SIZE = "5";
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = BASE;
    process.env.AUTH_SECRET = "reset-integration-secret-at-least-32-chars";
    process.env.ALLOWED_EMAILS = "*";
    process.env.SETUP_TOKEN = setupToken;
    process.env.TRUST_PROXY = "true";

    // Migrations run on the module graph as it stands now, which is a different
    // one from every graph loadApp builds later, and holds its own pool.
    const { runMigrations } = await import("../../src/server/db/migrate.js");
    const { closeDb } = await import("../../src/server/db/client.js");
    closers.push(closeDb);
    await runMigrations();
    app = await loadApp(false);
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    await smtp.stop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Everything below runs in order against one deployment, which starts with no
  // mail server and gains one part way through, the way a real one would.
  it("offers no reset, and asks nobody to confirm, with no mail server", async () => {
    const methods = (await (
      await app.request(`${BASE}/api/auth/methods`)
    ).json()) as Record<string, unknown>;
    expect(methods.passwordResetAvailable).toBe(false);
    expect(methods.emailVerificationRequired).toBe(false);

    const asking = await post(app, "/api/auth/request-password-reset", {
      email: "early@example.com",
      redirectTo: "/reset-password",
    });
    expect(asking.status).toBeGreaterThanOrEqual(400);
  });

  it("lets accounts made before there was a mail server sign in at once", async () => {
    for (const name of ["early", "earlier"]) {
      const signUp = await post(app, "/api/auth/sign-up/email", {
        name,
        email: `${name}@example.com`,
        password: `${name}-password-1234`,
        setupToken,
      });
      expect(signUp.status).toBe(200);
      const signIn = await post(app, "/api/auth/sign-in/email", {
        email: `${name}@example.com`,
        password: `${name}-password-1234`,
      });
      expect(signIn.status).toBe(200);
    }
  });

  it("keeps letting them in once a mail server is added", async () => {
    app = await loadApp(true);
    const methods = (await (
      await app.request(`${BASE}/api/auth/methods`)
    ).json()) as Record<string, unknown>;
    expect(methods.passwordResetAvailable).toBe(true);
    expect(methods.emailVerificationRequired).toBe(true);

    // The whole point of the change: turning mail on must not shut out the
    // people who were already here.
    for (const name of ["early", "earlier"]) {
      const signIn = await post(app, "/api/auth/sign-in/email", {
        email: `${name}@example.com`,
        password: `${name}-password-1234`,
      });
      expect(signIn.status, name).toBe(200);
    }
  });

  it("makes somebody new confirm the address before it works", async () => {
    const signUp = await post(app, "/api/auth/sign-up/email", {
      name: "Newcomer",
      email: "newcomer@example.com",
      password: "newcomer-password-1",
    });
    expect(signUp.status).toBe(200);
    expect((await signUp.json()).token).toBeNull();

    const blocked = await post(app, "/api/auth/sign-in/email", {
      email: "newcomer@example.com",
      password: "newcomer-password-1",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });

    const message = await smtp.waitFor("newcomer@example.com", /verify-email/);
    const link = linkFrom(message.body, "verify-email");
    const verified = await app.request(link);
    expect(verified.status).toBe(302);

    const allowed = await post(app, "/api/auth/sign-in/email", {
      email: "newcomer@example.com",
      password: "newcomer-password-1",
    });
    expect(allowed.status).toBe(200);
  });

  it("sends a reset link and changes the password with it", async () => {
    const asked = await post(app, "/api/auth/request-password-reset", {
      email: "newcomer@example.com",
      redirectTo: "/reset-password",
    });
    expect(asked.status).toBe(200);

    const message = await smtp.waitFor("newcomer@example.com", /reset-password/);
    const link = linkFrom(message.body, "reset-password");

    // The link goes through Better Auth, which checks the token and sends the
    // browser on to the page in this application that collects a new password.
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);
    const target = new URL(landing.headers.get("location")!, BASE);
    expect(target.pathname).toBe("/reset-password");
    const token = target.searchParams.get("token");
    expect(token).toBeTruthy();

    const changed = await post(app, "/api/auth/reset-password", {
      token,
      newPassword: "a-completely-new-password",
    });
    expect(changed.status).toBe(200);

    const old = await post(app, "/api/auth/sign-in/email", {
      email: "newcomer@example.com",
      password: "newcomer-password-1",
    });
    expect(old.status).toBe(401);

    const now = await post(app, "/api/auth/sign-in/email", {
      email: "newcomer@example.com",
      password: "a-completely-new-password",
    });
    expect(now.status).toBe(200);

    // One use only, or a message sitting in an inbox stays a way in forever.
    const again = await post(app, "/api/auth/reset-password", {
      token,
      newPassword: "yet-another-password",
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  // Asking about an address must not be a way to find out who has an account.
  it("answers the same for an address that has no account", async () => {
    const before = smtp.messages.length;
    const response = await post(app, "/api/auth/request-password-reset", {
      email: "nobody-at-all@example.com",
      redirectTo: "/reset-password",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(smtp.messages.length).toBe(before);
  });
});
