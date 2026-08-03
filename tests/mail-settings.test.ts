import { describe, expect, it } from "vitest";
import { parseMailSettings } from "../src/server/config.js";
import { smtpOptions } from "../src/server/mail.js";

/**
 * Whether a deployment can send mail decides whether anybody can reset a
 * password, and whether a new account has to confirm its address before it
 * works. So the interesting cases are the ones where a mistake leaves an
 * operator believing they configured something they did not.
 */
describe("reading the mail settings", () => {
  it("is off when nothing is set", () => {
    expect(parseMailSettings({})).toBeUndefined();
  });

  it("refuses half a configuration, in either direction", () => {
    expect(() => parseMailSettings({ SMTP_HOST: "smtp.example.com" })).toThrow(
      /must be set together/,
    );
    expect(() => parseMailSettings({ MAIL_FROM: "b@example.com" })).toThrow(
      /must be set together/,
    );
  });

  it("defaults to submission over STARTTLS", () => {
    expect(
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "balance@example.com",
      }),
    ).toMatchObject({ port: 587, security: "starttls" });
  });

  it("defaults to the implicit TLS port when asked for TLS", () => {
    expect(
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        SMTP_SECURITY: "TLS",
        MAIL_FROM: "balance@example.com",
      }),
    ).toMatchObject({ port: 465, security: "tls" });
  });

  it("takes a name on the from address, and rejects what a mail client would", () => {
    expect(
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "Simple Balance <balance@example.com>",
      }),
    ).toMatchObject({ from: "Simple Balance <balance@example.com>" });
    for (const bad of ["balance", "balance@", "@example.com", "a b@example"]) {
      expect(() =>
        parseMailSettings({ SMTP_HOST: "smtp.example.com", MAIL_FROM: bad }),
      ).toThrow(/MAIL_FROM/);
    }
  });

  it("takes a reply address, and leaves it unset when nobody gave one", () => {
    const base = { SMTP_HOST: "smtp.example.com", MAIL_FROM: "b@example.com" };
    expect(parseMailSettings(base)?.replyTo).toBeUndefined();
    expect(
      parseMailSettings({ ...base, MAIL_REPLY_TO: "  support@example.com " })
        ?.replyTo,
    ).toBe("support@example.com");
    expect(
      parseMailSettings({
        ...base,
        MAIL_REPLY_TO: "Simple Balance <support@example.com>",
      })?.replyTo,
    ).toBe("Simple Balance <support@example.com>");
    for (const bad of ["support", "support@", "@example.com"]) {
      expect(() =>
        parseMailSettings({ ...base, MAIL_REPLY_TO: bad }),
      ).toThrow(/MAIL_REPLY_TO/);
    }
  });

  it("refuses a username without its password, and the reverse", () => {
    const base = { SMTP_HOST: "smtp.example.com", MAIL_FROM: "b@example.com" };
    expect(() => parseMailSettings({ ...base, SMTP_USERNAME: "u" })).toThrow(
      /without SMTP_PASSWORD/,
    );
    expect(() => parseMailSettings({ ...base, SMTP_PASSWORD: "p" })).toThrow(
      /without SMTP_USERNAME/,
    );
  });

  // Sending a password to a relay that offers no encryption at all is the one
  // combination worth stopping outright rather than warning about.
  it("refuses a password over an unencrypted connection", () => {
    expect(() =>
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "b@example.com",
        SMTP_SECURITY: "none",
        SMTP_USERNAME: "u",
        SMTP_PASSWORD: "p",
      }),
    ).toThrow(/clear/);
  });

  it("keeps a password containing URL punctuation intact", () => {
    // The reason these are separate settings rather than one URL: a password
    // pasted from a console is not percent-encoded and should not have to be.
    const settings = parseMailSettings({
      SMTP_HOST: "smtp.example.com",
      MAIL_FROM: "b@example.com",
      SMTP_USERNAME: "postmaster@example.com",
      SMTP_PASSWORD: "p@ss/word?with#punctuation",
    });
    expect(settings?.password).toBe("p@ss/word?with#punctuation");
  });
});

describe("turning those settings into a connection", () => {
  const settings = (over: Record<string, string> = {}) =>
    parseMailSettings({
      SMTP_HOST: "smtp.example.com",
      MAIL_FROM: "b@example.com",
      ...over,
    })!;

  // Without requireTLS, nodemailer carries on unencrypted whenever a relay
  // fails to advertise STARTTLS, which is how credentials end up in the open.
  it("makes the STARTTLS upgrade compulsory rather than hoped for", () => {
    expect(smtpOptions(settings())).toMatchObject({
      secure: false,
      requireTLS: true,
      port: 587,
    });
  });

  it("opens encrypted for implicit TLS", () => {
    expect(smtpOptions(settings({ SMTP_SECURITY: "tls" }))).toMatchObject({
      secure: true,
      requireTLS: false,
      port: 465,
    });
  });

  it("passes credentials through, and omits auth entirely without them", () => {
    expect(
      smtpOptions(settings({ SMTP_USERNAME: "u", SMTP_PASSWORD: "p" })),
    ).toMatchObject({ auth: { user: "u", pass: "p" } });
    expect(smtpOptions(settings())).not.toHaveProperty("auth");
  });

  it("gives up long before the caller does", () => {
    const options = smtpOptions(settings());
    expect(options.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(20_000);
  });
});
