import { getConfig } from "./config.js";
import { configuredRecurrenceTickSeconds } from "./config-limits.js";
import { RECURRENCE_SCHEDULER_LOCK } from "./db/advisory-locks.js";
import { getSchedulerLockPool } from "./db/client.js";
import { runDueRecurrences, type TickSummary } from "./services/recurrences.js";

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
 * reach for the same lock in the same millisecond, leaving one working and the
 * rest to have woken for nothing.
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

type SchedulerLogger = {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

export type RecurrenceScheduler = { enabled: boolean; stop: () => Promise<void> };

export type RecurrenceSchedulerOptions = {
  enabled?: boolean;
  tickSeconds?: number;
  runTick?: (stopped: () => boolean) => Promise<TickSummary>;
  schedule?: (callback: () => void, milliseconds: number) => Timer;
  jitter?: () => number;
  logger?: SchedulerLogger;
};

function defaultSchedule(callback: () => void, milliseconds: number): Timer {
  const timer = setTimeout(callback, milliseconds);
  return { clear: () => clearTimeout(timer), unref: () => timer.unref() };
}

/**
 * Take the tick lock, or find out somebody else has it.
 *
 * Session level and on a connection of its own, because the tick commits once
 * per recurrence and a transaction-scoped lock would release at every one of
 * those commits. A replica that loses returns immediately rather than queueing:
 * the holder is doing exactly the work this one would have done, so waiting for
 * it only means running a second pass over rows already dealt with.
 */
export async function tickUnderLock(
  stopped: () => boolean = () => false,
): Promise<TickSummary> {
  const client = await getSchedulerLockPool().connect();
  let held = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [RECURRENCE_SCHEDULER_LOCK],
    );
    held = rows[0]?.locked === true;
    if (!held) return { examined: 0, proposed: 0, failed: 0, capped: false };
    return await runDueRecurrences(stopped);
  } finally {
    try {
      if (held) {
        await client.query("select pg_advisory_unlock($1)", [
          RECURRENCE_SCHEDULER_LOCK,
        ]);
      }
    } finally {
      // A replica killed mid-tick ends its session and PostgreSQL drops the
      // lock with it. No lease, no heartbeat, nothing to reap.
      client.release();
    }
  }
}

export function createRecurrenceScheduler(
  options: RecurrenceSchedulerOptions = {},
): RecurrenceScheduler {
  const {
    enabled = getConfig().recurrenceSchedulerEnabled,
    tickSeconds = configuredRecurrenceTickSeconds(),
    runTick = tickUnderLock,
    schedule = defaultSchedule,
    jitter = () => Math.random() * FIRST_TICK_JITTER_MS,
    logger = console,
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
      try {
        const summary = await runTick(() => stopping);
        // A recurrence that filled its catch-up cap has strictly advanced its
        // watermark, so coming straight back drains a backlog at full speed and
        // still terminates. Everything else waits out the interval.
        return summary.capped;
      } catch (error) {
        // A tick that throws must not take the process with it and must not
        // stop the next one. A database that is down comes back; a loop that
        // died does not, and a silently stopped scheduler is the whole failure
        // this feature exists to avoid.
        logger.error("Recurrence scheduler tick failed", error);
        return false;
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
