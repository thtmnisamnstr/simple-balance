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

  it("defaults to submission on 587, where STARTTLS does the encrypting", () => {
    expect(
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "balance@example.com",
      }),
    ).toMatchObject({ port: 587, ssl: false });
  });

  it("moves to the implicit TLS port when asked for SSL", () => {
    expect(
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        SMTP_SSL: "TRUE",
        MAIL_FROM: "balance@example.com",
      }),
    ).toMatchObject({ port: 465, ssl: true });
  });

  it("refuses an SMTP_SSL that is not true or false", () => {
    expect(() =>
      parseMailSettings({
        SMTP_HOST: "smtp.example.com",
        MAIL_FROM: "balance@example.com",
        SMTP_SSL: "yes",
      }),
    ).toThrow();
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
  it("will not send a password to a relay that refuses to encrypt", () => {
    expect(
      smtpOptions(settings({ SMTP_USERNAME: "u", SMTP_PASSWORD: "p" })),
    ).toMatchObject({ secure: false, requireTLS: true, port: 587 });
  });

  // A relay on a trusted network with nothing to authenticate has nothing to
  // leak on the way, and some of them speak no TLS at all.
  it("does not insist on encryption when there is no password to protect", () => {
    expect(smtpOptions(settings())).toMatchObject({
      secure: false,
      requireTLS: false,
    });
  });

  it("opens encrypted for implicit TLS", () => {
    expect(smtpOptions(settings({ SMTP_SSL: "true" }))).toMatchObject({
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
