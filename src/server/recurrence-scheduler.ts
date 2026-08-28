import { getConfig } from "./config.js";
import { configuredRecurrenceTickSeconds } from "./config-limits.js";
import { runDueNotifications, type NotificationTickSummary } from "./services/notifications.js";
import { runDueRecurrences, type TickSummary } from "./services/recurrences.js";
import { log } from "./log.js";
import {
  recurrenceOccurrences,
  reminderSweeps,
  schedulerTickDuration,
  schedulerTicks,
} from "./metrics.js";

/**
 * How long after the process starts listening the first tick fires.
 *
 * Short, so a container restarted after downtime shows its backlog straight
 * away rather than an interval later, and after `serve()` has returned so a slow
 * first tick can never delay a readiness probe.
 */
export const FIRST_TICK_DELAY_MS = 5_000;

/**
 * Spread over the first tick so a rolling restart does not have every replica
 * read the same due list in the same millisecond. They would still divide the
 * work, each skipping what another holds, but they would all pay for the scan
 * and most would come away with the leavings.
 */
export const FIRST_TICK_JITTER_MS = 15_000;

/**
 * How long `stop()` waits for a tick already in flight.
 *
 * Under the shutdown deadline, because overrunning it force-exits the process
 * with a non-zero code. A tick torn off mid-transaction rolls back whole and
 * the next start resumes from the watermark, so waiting longer buys nothing.
 */
export const STOP_GRACE_MS = 5_000;

type Timer = { clear: () => void; unref: () => void };

/**
 * Injectable so a test can read what was said, and defaulted to `log` rather
 * than to `console` — see the same note in `server-lifecycle.ts`. A default of
 * `console` is a `LOG_LEVEL` gate this module simply is not behind.
 *
 * `debug` is here because a tick that found nothing due is worth a line and is
 * not worth an operator's `info` log every five minutes: at the default level a
 * quiet schedule says nothing, and at `debug` it says it looked.
 */
type SchedulerLogger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

export type RecurrenceScheduler = { enabled: boolean; stop: () => Promise<void> };

export type RecurrenceSchedulerOptions = {
  enabled?: boolean;
  tickSeconds?: number;
  runTick?: (stopped: () => boolean) => Promise<TickSummary>;
  /**
   * Typed by what it returns, not as `unknown`, since a tick now counts it.
   * The three numbers are the sweep's whole report and a caller substituting a
   * fake has to produce them, which is what stops a test's stub and the real
   * sweep drifting into meaning different things.
   */
  runReminders?: (stopped: () => boolean) => Promise<NotificationTickSummary>;
  schedule?: (callback: () => void, milliseconds: number) => Timer;
  jitter?: () => number;
  logger?: SchedulerLogger;
};

function defaultSchedule(callback: () => void, milliseconds: number): Timer {
  const timer = setTimeout(callback, milliseconds);
  return { clear: () => clearTimeout(timer), unref: () => timer.unref() };
}

export function createRecurrenceScheduler(
  options: RecurrenceSchedulerOptions = {},
): RecurrenceScheduler {
  const {
    enabled = getConfig().recurrenceSchedulerEnabled,
    tickSeconds = configuredRecurrenceTickSeconds(),
    runTick = runDueRecurrences,
    runReminders = runDueNotifications,
    schedule = defaultSchedule,
    jitter = () => Math.random() * FIRST_TICK_JITTER_MS,
    logger = log,
  } = options;

  if (!enabled) return { enabled: false, stop: async () => {} };

  let stopping = false;
  let timer: Timer | undefined;
  let inFlight: Promise<unknown> | undefined;

  const arm = (milliseconds: number) => {
    if (stopping) return;
    timer = schedule(() => void cycle(), milliseconds);
    // Never the reason a finished process stays open.
    timer.unref();
  };

  const cycle = async () => {
    const running = (async () => {
      const stopTimer = schedulerTickDuration.startTimer();
      try {
        const summary = await runTick(() => stopping);
        // The three numbers a tick produces, each as its own outcome rather
        // than three metrics: examined without proposed is a schedule that is
        // running and finding nothing due, which is the healthy case and looks
        // identical to a broken one in a count of proposals alone.
        recurrenceOccurrences.inc({ outcome: "examined" }, summary.examined);
        recurrenceOccurrences.inc({ outcome: "proposed" }, summary.proposed);
        recurrenceOccurrences.inc({ outcome: "failed" }, summary.failed);
        recurrenceOccurrences.inc({ outcome: "notified" }, summary.notified);
        if (summary.capped) recurrenceOccurrences.inc({ outcome: "capped" });
        // Reminders ride the same tick rather than a loop of their own. They are
        // due on a schedule of the same shape, read by a query of the same shape,
        // and a second timer would be a second thing to configure, a second
        // thing to shut down, and a second thing to notice had stopped.
        //
        // After the proposals, so a recurrence that proposes and a template that
        // reminds on one day arrive in that order. Its own try, because a
        // reminder that fails must not cost the proposals their catch-up signal.
        let sent = 0;
        let sweepFailed = 0;
        try {
          const reminders = await runReminders(() => stopping);
          reminderSweeps.inc({ outcome: "examined" }, reminders.examined);
          reminderSweeps.inc({ outcome: "sent" }, reminders.sent);
          reminderSweeps.inc({ outcome: "failed" }, reminders.failed);
          sent = reminders.sent;
          sweepFailed = reminders.failed;
        } catch (error) {
          reminderSweeps.inc({ outcome: "swept_failed" });
          logger.error("Template reminder sweep failed", error);
        }
        // Said out loud, and not only counted.
        //
        // `/metrics` is off unless a deployment asks for it, so without this a
        // working scheduler and a stopped one produce identical logs — which is
        // the failure this whole feature exists to avoid, one level up. The
        // level splits on whether anything happened: a tick that proposed a row,
        // sent a reminder or failed at either is `info` and belongs in an
        // ordinary log, and a tick that found nothing due is `debug`, because
        // most of them find nothing due and an operator did not ask to hear
        // about it every five minutes.
        //
        // Counts and no identities. Which recurrence proposed what is the audit
        // trail's business and the ledger's; this line is about whether the
        // schedule is running.
        const acted = summary.proposed + summary.notified + summary.failed + sent + sweepFailed;
        const line =
          `Scheduler tick: examined ${summary.examined} recurrence${summary.examined === 1 ? "" : "s"}, ` +
          `proposed ${summary.proposed}, failed ${summary.failed}, notified ${summary.notified}; ` +
          `sent ${sent} reminder${sent === 1 ? "" : "s"}, ${sweepFailed} failed` +
          (summary.capped ? "; capped, so the next tick follows immediately" : "");
        if (acted > 0) logger.info(line);
        else logger.debug(line);
        // A recurrence that filled its catch-up cap has strictly advanced its
        // watermark, so coming straight back drains a backlog at full speed and
        // still terminates. Everything else waits out the interval.
        schedulerTicks.inc({ outcome: "ok" });
        return summary.capped;
      } catch (error) {
        schedulerTicks.inc({ outcome: "failed" });
        // A tick that throws must not take the process with it and must not
        // stop the next one. A database that is down comes back; a loop that
        // died does not, and a silently stopped scheduler is the whole failure
        // this feature exists to avoid.
        logger.error("Recurrence scheduler tick failed", error);
        return false;
      } finally {
        stopTimer();
      }
    })();
    inFlight = running;
    const capped = await running;
    if (inFlight === running) inFlight = undefined;
    arm(capped ? 0 : tickSeconds * 1000);
  };

  arm(FIRST_TICK_DELAY_MS + jitter());

  return {
    enabled: true,
    stop: async () => {
      stopping = true;
      timer?.clear();
      // Bounded and never rejecting. `complete()` exits 1 if closeResources
      // throws, and a second signal during draining force-exits without waiting
      // at all: neither is something a scheduler should be able to cause.
      await Promise.race([
        inFlight ?? Promise.resolve(),
        new Promise((resolve) => {
          const bound = setTimeout(resolve, STOP_GRACE_MS);
          bound.unref();
        }),
      ]).catch(() => undefined);
    },
  };
}
