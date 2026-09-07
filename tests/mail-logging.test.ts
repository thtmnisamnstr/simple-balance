import { globSync, readFileSync } from "node:fs";
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

/**
 * The same rule one level up: nothing hands a caught error to `log.error`.
 *
 * `log.failure` is where the narrowing lives (`src/server/log.ts`). It drops a
 * database error's bound parameters — one of which is the OAuth access token
 * the MCP token endpoint looks a grant up by, and the rest of which are
 * somebody's payees and amounts — and it falls back to logging the error whole
 * when there is nothing to narrow, so it is never the worse choice. `log.error`
 * is for a sentence this product wrote.
 *
 * `observability.md` writes this check out in prose and nobody had run it. It
 * found one site: `mail.ts` passed the caught `sender.verify()` error whole,
 * and every other `catch` in `src/server` already used `log.failure`.
 */
describe("an error somebody caught", () => {
  it("reaches the log only through the call that narrows it", async () => {
    const offenders: string[] = [];
    for (const relative of globSync("src/server/**/*.ts")) {
      // `log.failure` is the narrowing, and calls `log.error` by definition.
      if (relative.endsWith("/log.ts")) continue;
      const source = readFileSync(relative, "utf8");
      const caught = new Set(
        [...source.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!),
      );
      if (caught.size === 0) continue;
      for (const call of source.matchAll(/log\.error\(/g)) {
        // Balanced to the closing paren, because an argument list wraps.
        let depth = 0;
        let end = call.index + call[0].length - 1;
        do {
          const character = source[end];
          if (character === "(") depth += 1;
          if (character === ")") depth -= 1;
          end += 1;
        } while (depth > 0 && end < source.length);
        const args = topLevelArguments(source.slice(call.index + call[0].length, end - 1));
        const bare = args.find((argument) => caught.has(argument));
        if (bare === undefined) continue;
        const line = source.slice(0, call.index).split("\n").length;
        offenders.push(`${relative}:${line} passes ${bare} whole`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** An argument list split on the commas that are not inside anything. */
function topLevelArguments(text: string) {
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      found.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  found.push(text.slice(start).trim());
  return found;
}
