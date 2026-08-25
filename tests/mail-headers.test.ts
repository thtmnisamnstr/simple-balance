import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every message this product sends says it was sent by a machine.
 *
 * RFC 3834 §5.2 asks for `Auto-Submitted: auto-generated` on machine-generated
 * mail, and §2 is why it matters: an automatic responder "SHOULD NOT" reply to
 * a message carrying the header with any value other than `no`. Without it a
 * vacation responder or a ticketing system can answer a password reset, and the
 * answer lands on `MAIL_FROM` — a mailbox nobody reads, now holding somebody's
 * reset link.
 */
const sent: Record<string, unknown>[] = [];

// The module imports { createTransport } by name, so the named export is what
// has to be replaced.
vi.mock("nodemailer", () => ({
  createTransport: () => ({
    sendMail: async (message: Record<string, unknown>) => {
      sent.push(message);
      return { messageId: "test" };
    },
  }),
}));

afterEach(() => {
  sent.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("outgoing mail", () => {
  it("declares itself auto-generated", async () => {
    vi.stubEnv("SMTP_HOST", "localhost");
    vi.stubEnv("SMTP_PORT", "2525");
    vi.stubEnv("MAIL_FROM", "ledger@example.com");
    const { sendMail } = await import("../src/server/mail.js");
    const delivered = await sendMail({
      to: "person@example.com",
      subject: "Reset your password",
      body: "Follow the link.",
    });

    expect(delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!["headers"]).toMatchObject({ "Auto-Submitted": "auto-generated" });
  });
});
