import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What a failed send is allowed to say about the person it was for: nothing.
 *
 * Two things used to reach the log. The subject, which for a scheduled message
 * is a recurrence or template name somebody wrote, and the nodemailer error
 * whole, which carries `envelope` and `rejected` holding the recipient's
 * address. For a password reset that address is whatever a stranger typed into
 * a form this product deliberately answers the same way either way, so the log
 * was the one place the answer differed. `account-deletion.ts` settled the
 * policy first: counts, never addresses.
 */
const refusal = () =>
  Object.assign(new Error("Relay refused"), {
    code: "EENVELOPE",
    command: "RCPT TO",
    responseCode: 550,
    response: "550 5.1.1 recipient rejected",
    envelope: { from: "ledger@example.com", to: ["person@example.com"] },
    rejected: ["person@example.com"],
  });

vi.mock("nodemailer", () => ({
  createTransport: () => ({
    sendMail: async () => {
      throw refusal();
    },
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function failToSend() {
  vi.stubEnv("SMTP_HOST", "localhost");
  vi.stubEnv("SMTP_PORT", "2525");
  vi.stubEnv("MAIL_FROM", "ledger@example.com");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const { sendMail } = await import("../src/server/mail.js");
  const delivered = await sendMail({
    to: "person@example.com",
    about: "a template reminder",
    subject: "Reminder: Quarterly tax",
    body: "The template is ready to fill in.",
  });
  return { delivered, call: logged.mock.calls[0] ?? [] };
}

describe("a send the relay refuses", () => {
  it("names what failed rather than what it said", async () => {
    const { call } = await failToSend();

    expect(String(call[0])).toContain("a template reminder");
    expect(String(call[0])).not.toContain("Quarterly tax");
  });

  it("keeps the recipient's address out of the log", async () => {
    const { call } = await failToSend();

    expect(Object.keys(call[1] as object)).toEqual(["code", "command", "responseCode", "response"]);
    expect(call[1]).toMatchObject({ code: "EENVELOPE", responseCode: 550 });
  });

  it("still answers the caller the way a successful send does", async () => {
    // The reason `sendMail` reports rather than throws: a password reset that
    // behaves differently for an address that exists tells a stranger which of
    // the two they typed.
    const { delivered } = await failToSend();

    expect(delivered).toBe(false);
  });
});
