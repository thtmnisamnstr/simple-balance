import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * How long the relay took over a message, and only over a message a relay was
 * handed.
 *
 * `mail_messages_total` says how many went and how many failed, and the two
 * failures an operator most needs told apart look the same in it: a relay that
 * refuses the credentials answers at once, and one that is not there at all
 * holds the sender for the transport's whole bound — which, at the other end of
 * a password reset, is somebody watching a spinner. The skip is the other half:
 * a deployment with no relay is a supported one, and timing its skips would put
 * it in the fastest bucket, reading as a relay that answers instantly.
 */
const relay = vi.hoisted(() => ({
  answer: async (): Promise<unknown> => ({}),
}));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail: () => relay.answer() }),
}));

const pause = (milliseconds: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

/** Sends one message through the real `sendMail` and reads what it published. */
async function sendOne(configured: boolean) {
  vi.stubEnv("SMTP_HOST", configured ? "localhost" : "");
  vi.stubEnv("SMTP_PORT", "2525");
  vi.stubEnv("MAIL_FROM", configured ? "ledger@example.com" : "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  // Fresh with the module that records into it, so the counts start at zero.
  const { sendMail } = await import("../src/server/mail.js");
  const { mailMessages, mailSendDuration } = await import("../src/server/metrics.js");
  const delivered = await sendMail({
    to: "person@example.com",
    about: "a password reset",
    subject: "Reset your Simple Balance password",
    body: "Open this link to choose a new one.",
  });
  const timed = (await mailSendDuration.get()).values;
  const read = (suffix: string) =>
    timed.find(
      (sample) => sample.metricName === `simple_balance_mail_send_duration_seconds${suffix}`,
    )?.value;
  return {
    delivered,
    timedCount: read("_count"),
    timedSeconds: read("_sum") ?? 0,
    outcomes: Object.fromEntries(
      (await mailMessages.get()).values.map((sample) => [sample.labels.outcome, sample.value]),
    ),
  };
}

describe("how long the relay took", () => {
  it("times a message the relay accepted, for as long as the relay took", async () => {
    relay.answer = async () => {
      await pause(75);
      return {};
    };

    const sent = await sendOne(true);

    expect(sent.delivered).toBe(true);
    expect(sent.outcomes).toEqual({ sent: 1 });
    expect(sent.timedCount).toBe(1);
    // Seventy-five milliseconds of relay, read as at least fifty: the timer is
    // around the send, and not around the counter after it.
    expect(sent.timedSeconds).toBeGreaterThanOrEqual(0.05);
  });

  it("times a message the relay refused, which is the half worth timing", async () => {
    relay.answer = async () => {
      await pause(75);
      throw Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" });
    };

    const refused = await sendOne(true);

    expect(refused.delivered).toBe(false);
    expect(refused.outcomes).toEqual({ failed: 1 });
    expect(refused.timedCount).toBe(1);
    expect(refused.timedSeconds).toBeGreaterThanOrEqual(0.05);
  });

  it("times nothing where no relay is configured, and counts the message as skipped", async () => {
    relay.answer = async () => {
      throw new Error("a deployment with no relay reached the transport");
    };

    const skipped = await sendOne(false);

    expect(skipped.delivered).toBe(false);
    // The skip counted where it belongs, beside the histogram it stays out of:
    // an empty histogram on its own is also what an unwired one looks like.
    expect(skipped.outcomes).toEqual({ skipped: 1 });
    expect(skipped.timedCount).toBe(0);
  });
});
