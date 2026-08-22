import { createTransport, type Transporter } from "nodemailer";
import { getConfig, type MailSettings } from "./config.js";

/**
 * Outbound mail, and only when a deployment has somewhere to send it.
 *
 * Nothing here is stored. The connection is opened against whatever SMTP_HOST
 * names and pooled for the process, which keeps the promise that PostgreSQL is
 * the only thing this application persists anything in.
 */
let transport: Transporter | undefined;

/**
 * The transport, spelled out rather than left to a default.
 *
 * `SMTP_SSL=true` opens encrypted from the first byte, which is what port 465
 * expects. False starts in the clear on 587 and upgrades with STARTTLS, which
 * is what nearly every provider wants.
 *
 * Whether that upgrade is compulsory depends on there being something worth
 * protecting. With a username and password, `requireTLS` refuses to carry on
 * unencrypted, so credentials cannot go out in the open against a relay that
 * fails to offer the extension. Without them there is nothing to leak on the
 * way, and a relay on a trusted network that speaks no TLS at all still works;
 * nodemailer still upgrades whenever the server does offer it.
 */
export function smtpOptions(mail: MailSettings) {
  const authenticated = Boolean(mail.username && mail.password);
  return {
    host: mail.host,
    port: mail.port,
    secure: mail.ssl,
    requireTLS: !mail.ssl && authenticated,
    ...(authenticated
      ? { auth: { user: mail.username!, pass: mail.password! } }
      : {}),
    // Bounded on every leg. Nodemailer waits two minutes to connect and ten to
    // read by default; at the other end of that is somebody watching a sign-in
    // screen, so this gives up long before they do.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 2,
  };
}

function getTransport() {
  const mail = getConfig().mail;
  if (!mail) return undefined;
  transport ??= createTransport(smtpOptions(mail));
  return transport;
}

/** Whether this deployment can send mail at all. */
export function mailEnabled() {
  return Boolean(getConfig().mail);
}

/**
 * Opens a connection at startup so a wrong address is found by the operator
 * rather than by somebody locked out of their account.
 *
 * A refusal does not stop the server. The ledger is the thing people came for,
 * and it works whether or not mail does; what must not happen is failing in
 * silence, because verification is on whenever mail is configured and nobody
 * can sign up while it is quietly broken.
 */
export async function checkMailTransport() {
  const sender = getTransport();
  if (!sender) return true;
  try {
    await sender.verify();
    console.info(`Mail is configured. Sending as ${getConfig().mail!.from}`);
    return true;
  } catch (error) {
    console.error(
      "SMTP_HOST is set but the mail server refused the connection. " +
        "Password resets and address verification will not work, and because " +
        "verification is required whenever mail is configured, nobody will be " +
        "able to finish signing up until this is fixed.",
      error,
    );
    return false;
  }
}

export function closeMail() {
  transport?.close();
  transport = undefined;
}

type Message = {
  to: string;
  subject: string;
  body: string;
};

/**
 * Sends, and reports whether it worked rather than throwing.
 *
 * The callers are password reset and address verification. Neither may fail
 * loudly: a reset that answers differently for an address that exists and one
 * that does not tells a stranger which of the two they typed. So a refused
 * mail server is written to the log for the operator and the caller carries on
 * saying the same thing it says on success.
 */
export async function sendMail(message: Message) {
  const mail = getConfig().mail;
  const sender = getTransport();
  if (!mail || !sender) return false;
  try {
    await sender.sendMail({
      from: mail.from,
      // Only when it is somewhere else. Without the header a reply goes to the
      // sender, which is the right default when that address is read.
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
    return true;
  } catch (error) {
    console.error(
      `Could not send "${message.subject}". Check SMTP_HOST and MAIL_FROM.`,
      error,
    );
    return false;
  }
}

const signature = "\n\nIf you were not expecting this, you can ignore it.\n";

export function passwordResetMessage(url: string, appUrl: string) {
  return {
    subject: "Reset your Simple Balance password",
    body:
      "Somebody asked to reset the password for this address at " +
      `${appUrl}\n\nOpen this link to choose a new one:\n\n${url}\n\n` +
      "The link works once and expires in an hour." +
      signature,
  };
}

/**
 * What the scheduler proposed, for somebody who asked to be told.
 *
 * Names the rows and stops there. It does not say what they add up to, because a
 * proposed row is not money that has moved — it is waiting in the queue for
 * somebody to look at it, and a total in a mail reads like a statement.
 */
export function recurrenceProposedMessage(
  recurrenceName: string,
  occurrenceDates: string[],
  appUrl: string,
) {
  const one = occurrenceDates.length === 1;
  return {
    subject: one
      ? `${recurrenceName} is waiting on Staged transactions`
      : `${recurrenceName} has ${occurrenceDates.length} rows waiting on Staged transactions`,
    body:
      `Simple Balance proposed ${one ? "a transaction" : `${occurrenceDates.length} transactions`} ` +
      `from your recurring transaction "${recurrenceName}":\n\n` +
      occurrenceDates.map((date) => `  ${date}`).join("\n") +
      "\n\nNothing has been recorded yet. Review and commit it here:\n\n" +
      `${appUrl}/staged\n` +
      "\nYou asked for this when you set the recurring transaction up. Turn it " +
      "off on that transaction's edit screen.\n",
  };
}

/**
 * A nudge to make a transaction the person keeps a template for.
 *
 * A template is filled in by hand, so this can only ask. It carries no link that
 * writes anything: the whole point of a template is that somebody looks at it
 * and decides.
 */
export function templateReminderMessage(
  templateName: string,
  occurrenceDate: string,
  appUrl: string,
  repeats: boolean,
) {
  return {
    subject: `Reminder: ${templateName}`,
    body:
      `You asked to be reminded about "${templateName}" on ${occurrenceDate}.\n\n` +
      "The template is ready to fill in here:\n\n" +
      `${appUrl}/templates\n` +
      `\n${
        repeats
          ? "This reminder repeats. Change or turn it off on the template's edit screen."
          : "This was a one-off reminder, so there will not be another."
      }\n`,
  };
}

export function verificationMessage(url: string, appUrl: string) {
  return {
    subject: "Confirm your email address",
    body:
      `Somebody signed up at ${appUrl} with this address.\n\n` +
      `Open this link to confirm it is yours and finish setting up the account:\n\n${url}\n\n` +
      // Not "works once": unlike the reset link, which is spent on use, this
      // one is a signed token that simply stops being valid after its hour.
      // Opening it again only confirms an address that is already confirmed.
      "The link expires in an hour. Until it is used, the account cannot be " +
      "signed in to, and trying to sign in sends a fresh one." +
      signature,
  };
}
