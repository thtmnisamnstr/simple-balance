import { createTransport, type Transporter } from "nodemailer";
import { getConfig, type MailSettings } from "./config.js";
import { mailMessages } from "./metrics.js";
import { log } from "./log.js";

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
    ...(authenticated ? { auth: { user: mail.username!, pass: mail.password! } } : {}),
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
    log.info(`Mail is configured. Sending as ${getConfig().mail!.from}`);
    return true;
  } catch (error) {
    log.error(
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
  /**
   * What this message is, for the log and nowhere else.
   *
   * Never the subject: a subject carries a recurrence or template name somebody
   * wrote, and `account-deletion.ts` already settled that personal text does not
   * go in this process's log. A fixed phrase says which message failed without
   * saying whose it was. Required rather than optional, so a new kind of message
   * has to decide; every builder below returns one, and a caller holding the row
   * it is sending for can name it by setting the field after the spread.
   */
  about: string;
};

/**
 * What a failed send may say: what the relay refused, and nothing about who it
 * was for.
 *
 * Nodemailer's error carries `envelope` and `rejected`, both holding the
 * recipient's address, and for a password reset that address is whatever a
 * stranger typed into a form this product deliberately answers the same way
 * either way. These four fields are what tells an operator whether the relay is
 * unreachable, refusing their credentials, or refusing this one message.
 * `response` is the relay's own sentence and may quote the address inside it;
 * that is the relay talking, and without it a broken relay has to be reproduced
 * by hand.
 */
function smtpFailure(error: unknown) {
  const { code, command, responseCode, response } = error as {
    code?: unknown;
    command?: unknown;
    responseCode?: unknown;
    response?: unknown;
  };
  return { code, command, responseCode, response };
}

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
  // Counted, not ignored. A deployment with no mail server is a supported one,
  // and the number that distinguishes it from a broken relay is how many
  // messages were skipped rather than attempted.
  if (!mail || !sender) {
    mailMessages.inc({ outcome: "skipped" });
    return false;
  }
  try {
    await sender.sendMail({
      from: mail.from,
      // Only when it is somewhere else. Without the header a reply goes to the
      // sender, which is the right default when that address is read.
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      to: message.to,
      subject: message.subject,
      text: message.body,
      // RFC 3834 §5.2. Every message this product sends is machine-generated,
      // and §2 says an automatic responder should not reply to a message
      // carrying this header with any value other than "no". Without it a
      // vacation responder or a ticketing system can answer a password reset,
      // and the answer lands on MAIL_FROM or MAIL_REPLY_TO — a mailbox nobody
      // reads, holding somebody's reset link.
      headers: { "Auto-Submitted": "auto-generated" },
    });
    mailMessages.inc({ outcome: "sent" });
    // What was sent, never who it went to. `message.about` is the kind — "the
    // password reset", "the reminder" — which is what the failure line beside
    // this one already uses and for the same reason: an address in a log is
    // somebody's identity written down somewhere they did not agree to.
    log.debug(`Sent ${message.about}.`);
    return true;
  } catch (error) {
    // Not the subject, which is a name somebody wrote, and not the error whole,
    // which carries `envelope` and `rejected` holding the address.
    log.error(
      `Could not send ${message.about}. Check SMTP_HOST and MAIL_FROM.`,
      smtpFailure(error),
    );
    mailMessages.inc({ outcome: "failed" });
    return false;
  }
}

/**
 * The most of a name a subject line carries.
 *
 * A recurrence or template name may be 120 characters (`recurrenceCreateSchema`
 * and `transactionTemplateCreateSchema`), and a mail client's list shows the
 * first few dozen. Cutting here rather than at the schema keeps the name whole
 * everywhere it is shown in full and shortens only the one place that cannot
 * show it.
 */
const SUBJECT_NAME_LIMIT = 60;

/**
 * Sliced by code point rather than by UTF-16 unit, so the cut never lands
 * between the halves of a surrogate pair and leaves a subject ending in a
 * replacement character.
 */
const forSubject = (name: string) => {
  const points = Array.from(name);
  if (points.length <= SUBJECT_NAME_LIMIT) return name;
  return `${points
    .slice(0, SUBJECT_NAME_LIMIT - 1)
    .join("")
    .trimEnd()}…`;
};

const signature = "\n\nIf you were not expecting this, you can ignore it.\n";

export function passwordResetMessage(url: string, appUrl: string) {
  return {
    about: "a password reset",
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
    about: "a recurrence proposal notice",
    // The fixed part first, and the count with it, because both are what a
    // truncating list still shows. The name goes last and cut, because it is the
    // only part that can be 120 characters long.
    subject: `Staged: ${occurrenceDates.length} ${one ? "row" : "rows"} from ${forSubject(recurrenceName)}`,
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
    about: "a template reminder",
    subject: `Reminder: ${forSubject(templateName)}`,
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
    about: "an address confirmation",
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
