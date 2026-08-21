import { and, eq, sql } from "drizzle-orm";
import type { RecurrenceFrequencyName } from "../../shared/domain.js";
import {
  addDays,
  calendarDayIn,
  clockTimeIn,
  nextOccurrenceAfter,
  type RecurrenceMonthPolicy,
  type RecurrencePosition,
  type RecurrenceWeekendPolicy,
} from "../../shared/recurrence-dates.js";
import { getConfig } from "../config.js";
import {
  configuredRecurrenceCatchUpLimit,
  configuredRecurrenceClaimLimit,
} from "../config-limits.js";
import { getDb } from "../db/client.js";
import {
  templateNotifications,
  transactionTemplates,
  user,
} from "../db/schema.js";
import {
  mailEnabled,
  recurrenceProposedMessage,
  sendMail,
  templateReminderMessage,
} from "../mail.js";

/**
 * A reminder's rule, which is a recurrence's with one addition: `frequency` may
 * be null, and that means it happens once.
 */
export type NotificationRule = {
  frequency: RecurrenceFrequencyName | null;
  interval: number;
  anchorDate: string;
  monthPolicy: RecurrenceMonthPolicy;
  weekendPolicy: RecurrenceWeekendPolicy;
  position: RecurrencePosition | null;
};

/**
 * How far ahead to look past occurrences a policy passed over.
 *
 * A monthly rule on the 31st with `skip` misses seven months of a year, and a
 * weekend policy of `skip` can miss several in a row for a weekly rule that
 * lands on a Saturday. Beyond a year of consecutive skips there is no schedule
 * left to speak of, and the bound is what stops a rule nobody can satisfy
 * spinning inside a scheduler tick.
 */
const MAX_SKIPPED_LOOKAHEAD = 400;

export type NotificationOccurrence = {
  /** The instance's identity in the schedule, which the watermark records. */
  occurrenceDate: string;
  /** The day the mail goes, which a weekend policy can move. */
  sendDate: string;
};

/**
 * The next reminder this rule owes after `cursor`, or null when it owes none.
 *
 * A one-off owes exactly one, on its anchor, and nothing afterwards — which is
 * what a null return means and what leaves `nextNotificationDate` null so the
 * scheduler stops looking at the row.
 */
export function nextNotificationAfter(
  rule: NotificationRule,
  cursor: string | null,
): NotificationOccurrence | null {
  if (rule.frequency === null) {
    if (cursor !== null) return null;
    return { occurrenceDate: rule.anchorDate, sendDate: rule.anchorDate };
  }
  // The day before the anchor, so the anchor itself is the first thing owed. The
  // shared helper is strictly-after by design, because for a recurrence the
  // cursor is always something already decided.
  let after = cursor ?? addDays(rule.anchorDate, -1);
  const repeating = { ...rule, frequency: rule.frequency };
  for (let step = 0; step < MAX_SKIPPED_LOOKAHEAD; step += 1) {
    const occurrence = nextOccurrenceAfter(repeating, after);
    if (occurrence.postedDate !== null) {
      return {
        occurrenceDate: occurrence.occurrenceDate,
        sendDate: occurrence.postedDate,
      };
    }
    after = occurrence.occurrenceDate;
  }
  return null;
}

export const notificationRuleOf = (row: {
  frequency: RecurrenceFrequencyName | null;
  interval: number;
  anchorDate: string;
  monthPolicy: RecurrenceMonthPolicy;
  weekendPolicy: RecurrenceWeekendPolicy;
  positionOrdinal: number | null;
  positionWeekday: number | null;
}): NotificationRule => ({
  frequency: row.frequency,
  interval: row.interval,
  anchorDate: row.anchorDate,
  monthPolicy: row.monthPolicy,
  weekendPolicy: row.weekendPolicy,
  position:
    row.positionOrdinal !== null && row.positionWeekday !== null
      ? {
          ordinal: row.positionOrdinal as RecurrencePosition["ordinal"],
          weekday: row.positionWeekday,
        }
      : null,
});

/**
 * Whether a reminder dated `sendDate` at `notifyAt` has come round yet, on this
 * person's clock.
 *
 * The date on its own is not enough — that is the whole difference between this
 * and a recurrence — so a reminder set for the evening does not go out at one in
 * the morning to somebody who asked for eight.
 */
export function notificationIsDue(
  sendDate: string,
  notifyAt: string,
  today: string,
  nowTime: string,
) {
  if (sendDate < today) return true;
  return sendDate === today && nowTime >= notifyAt;
}

/**
 * The address to write to, and null when there is nobody to write to.
 *
 * An unverified address is written to anyway. Verification exists so a stranger
 * cannot claim somebody else's address at sign-up; this is mail to an account
 * that already exists, asked for from inside it, and a deployment with
 * verification off has no unverified state to speak of.
 */
async function recipientOf(userId: string) {
  const [row] = await getDb()
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Tell somebody the scheduler proposed from their recurrence.
 *
 * Reports whether anything was sent rather than throwing, and every reason for
 * not sending is a quiet one: mail is a courtesy on top of a schedule that has
 * already done its work, and a deployment with no SMTP must not have its
 * scheduler fail on every tick.
 */
export async function notifyRecurrenceProposed(
  userId: string,
  proposed: { recurrenceName: string; occurrenceDates: string[] },
) {
  if (!mailEnabled() || !proposed.occurrenceDates.length) return false;
  const recipient = await recipientOf(userId);
  if (!recipient) return false;
  const message = recurrenceProposedMessage(
    proposed.recurrenceName,
    proposed.occurrenceDates,
    getConfig().baseUrl,
  );
  return sendMail({ to: recipient.email, ...message });
}

export type NotificationTickSummary = {
  examined: number;
  sent: number;
  failed: number;
};

/**
 * One pass over every template reminder that has come round, for everybody.
 *
 * The same shape as the recurrence sweep and for the same reasons: a prefilter
 * that over-selects by a day because a calendar date is "today" somewhere from
 * UTC-12 to UTC+14, the claim taken row by row with `skip locked` so replicas
 * divide the work instead of queueing behind each other, and one row's failure
 * never ending the sweep.
 */
export async function runDueNotifications(
  stopped: () => boolean = () => false,
): Promise<NotificationTickSummary> {
  const due = await getDb().execute<{
    id: string;
    user_id: string;
    timezone: string;
  }>(sql`
    select n.id,
           n.user_id,
           coalesce(p.timezone, 'UTC') as timezone
      from ${templateNotifications} n
      left join user_preferences p on p.user_id = n.user_id
     where n.next_notification_date is not null
       and n.next_notification_date <= ((now() at time zone 'UTC')::date + 1)
     order by n.next_notification_date, n.user_id, n.id
     limit ${configuredRecurrenceClaimLimit()}
  `);

  let examined = 0;
  let sent = 0;
  let failed = 0;
  for (const row of due.rows) {
    if (stopped()) break;
    examined += 1;
    // Read out here rather than inside the transaction, so a one-connection
    // deployment cannot deadlock on a preference lookup it already holds a
    // connection for.
    const now = new Date();
    const timezone = String(row.timezone);
    try {
      const owed = await claimDueNotification(
        String(row.id),
        String(row.user_id),
        calendarDayIn(now, timezone),
        clockTimeIn(now, timezone),
      );
      if (owed && (await deliver(String(row.user_id), owed))) sent += 1;
    } catch (error) {
      // One reminder must never end the sweep, for the same reason one
      // recurrence must not: this loop serves every tenant at once and runs the
      // most overdue first, so a row that throws every time is first every time.
      failed += 1;
      console.error(`Template reminder ${row.id} could not be sent`, error);
    }
  }
  return { examined, sent, failed };
}

type OwedReminder = {
  templateName: string;
  occurrenceDate: string;
  repeats: boolean;
};

/**
 * Advance the watermark, and say what to write about.
 *
 * The watermark moves in the same transaction that claims the row, before
 * anything is sent. That way a mail server that is refusing connections costs
 * one missed reminder rather than one per tick forever, which is the trade the
 * password reset path already makes: a message is a courtesy, and a queue of
 * retries nobody can see is worse than a gap.
 *
 * A backlog collapses to its most recent occurrence. Somebody coming back from
 * a week of downtime wants to know they were meant to do this, not to read seven
 * copies of it.
 */
async function claimDueNotification(
  id: string,
  userId: string,
  today: string,
  nowTime: string,
): Promise<OwedReminder | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        notification: templateNotifications,
        templateName: transactionTemplates.name,
      })
      .from(templateNotifications)
      .innerJoin(
        transactionTemplates,
        eq(transactionTemplates.id, templateNotifications.templateId),
      )
      .where(
        and(
          eq(templateNotifications.id, id),
          eq(templateNotifications.userId, userId),
        ),
      )
      .for("update", { skipLocked: true });
    if (!row) return null;

    const rule = notificationRuleOf(row.notification);
    const limit = configuredRecurrenceCatchUpLimit();
    let cursor = row.notification.lastNotifiedDate;
    let owed: NotificationOccurrence | null = null;
    for (let step = 0; step < limit; step += 1) {
      const next = nextNotificationAfter(rule, cursor);
      if (!next) break;
      if (!notificationIsDue(next.sendDate, row.notification.notifyAt, today, nowTime)) {
        break;
      }
      owed = next;
      cursor = next.occurrenceDate;
    }
    if (!owed) return null;

    const following = nextNotificationAfter(rule, cursor);
    await tx
      .update(templateNotifications)
      .set({
        lastNotifiedDate: owed.occurrenceDate,
        nextNotificationDate: following?.sendDate ?? null,
        // Not the version. A watermark moving is not a change to what somebody
        // configured, and bumping it would make every open form stale for a
        // reason nobody can see.
        updatedAt: new Date(),
      })
      .where(eq(templateNotifications.id, row.notification.id));

    return {
      templateName: row.templateName,
      occurrenceDate: owed.occurrenceDate,
      repeats: rule.frequency !== null,
    };
  });
}

async function deliver(userId: string, owed: OwedReminder) {
  if (!mailEnabled()) return false;
  const recipient = await recipientOf(userId);
  if (!recipient) return false;
  const message = templateReminderMessage(
    owed.templateName,
    owed.occurrenceDate,
    getConfig().baseUrl,
    owed.repeats,
  );
  return sendMail({ to: recipient.email, ...message });
}

/** For a caller writing the row: where the schedule starts from. */
export function firstNotificationDate(rule: NotificationRule) {
  return nextNotificationAfter(rule, null)?.sendDate ?? null;
}

