import { describe, expect, it, vi } from "vitest";
import {
  createRecurrenceScheduler,
  FIRST_TICK_DELAY_MS,
  FIRST_TICK_JITTER_MS,
  STOP_GRACE_MS,
  type RecurrenceSchedulerOptions,
} from "../src/server/recurrence-scheduler.js";
import type { TickSummary } from "../src/server/services/recurrences.js";

const nothing: TickSummary = {
  examined: 0,
  proposed: 0,
  failed: 0,
  notified: 0,
  capped: false,
};

function schedulerHarness(options: Partial<RecurrenceSchedulerOptions> = {}) {
  const armed: { delay: number; fire: () => void; timer: ReturnType<typeof timerFor> }[] =
    [];
  const timerFor = () => ({ clear: vi.fn(), unref: vi.fn() });
  const schedule = vi.fn((callback: () => void, delay: number) => {
    const timer = timerFor();
    armed.push({ delay, fire: callback, timer });
    return timer;
  });
  const logger = { info: vi.fn(), error: vi.fn() };
  const runTick = vi.fn(async () => nothing);
  // Stubbed, or the default reaches the real sweep and the real database. It
  // would be swallowed by the loop's own guard, which is exactly why leaving it
  // out would make these tests pass while proving nothing about it.
  const runReminders = vi.fn(async () => ({ examined: 0, sent: 0, failed: 0 }));
  const scheduler = createRecurrenceScheduler({
    enabled: true,
    tickSeconds: 60,
    runTick,
    runReminders,
    schedule,
    jitter: () => 0,
    logger,
    ...options,
  });
  const fireLast = async () => {
    armed.at(-1)!.fire();
    await vi.waitFor(() => expect(armed.length).toBeGreaterThan(1));
  };
  return { armed, fireLast, logger, runTick, runReminders, schedule, scheduler };
}

describe("the recurrence scheduler loop", () => {
  it("arms the first tick soon after start, and unreferences every timer", async () => {
    const harness = schedulerHarness();

    expect(harness.scheduler.enabled).toBe(true);
    expect(harness.armed).toHaveLength(1);
    expect(harness.armed[0]!.delay).toBe(FIRST_TICK_DELAY_MS);
    expect(harness.armed[0]!.timer.unref).toHaveBeenCalledTimes(1);

    await harness.fireLast();
    expect(harness.armed[1]!.timer.unref).toHaveBeenCalledTimes(1);
  });

  /**
   * Every replica reaching for the same lock in the same millisecond after a
   * rolling restart leaves one working and the rest woken for nothing.
   */
  it("spreads the first tick over a window rather than firing on the dot", () => {
    const spread = new Set(
      Array.from({ length: 8 }, (_, index) => {
        const harness = schedulerHarness({
          jitter: () => (index / 8) * FIRST_TICK_JITTER_MS,
        });
        return harness.armed[0]!.delay;
      }),
    );
    expect(spread.size).toBe(8);
    expect(Math.max(...spread)).toBeLessThan(
      FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS,
    );
  });

  /**
   * Re-armed after the tick resolves rather than on an interval, so a tick
   * slower than the interval runs less often instead of stacking behind itself.
   */
  it("waits for the tick to finish before arming the next one", async () => {
    let release: (summary: TickSummary) => void = () => {};
    const harness = schedulerHarness({
      runTick: () => new Promise<TickSummary>((resolve) => (release = resolve)),
    });

    harness.armed[0]!.fire();
    await Promise.resolve();
    expect(harness.armed).toHaveLength(1);

    release(nothing);
    await vi.waitFor(() => expect(harness.armed).toHaveLength(2));
    expect(harness.armed[1]!.delay).toBe(60_000);
  });

  it("comes straight back when a tick stopped at its catch-up cap", async () => {
    const harness = schedulerHarness({
      runTick: vi.fn(async () => ({
        examined: 1,
        proposed: 1,
        failed: 0,
        notified: 0,
        capped: true,
      })),
    });

    await harness.fireLast();
    expect(harness.armed[1]!.delay).toBe(0);
  });

  it("logs a failing tick and keeps ticking", async () => {
    const harness = schedulerHarness({
      runTick: vi.fn(async () => {
        throw new Error("database is away");
      }),
    });

    await harness.fireLast();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "Recurrence scheduler tick failed",
      expect.any(Error),
    );
    expect(harness.armed[1]!.delay).toBe(60_000);
  });

  it("tells a running tick to stop, and waits for it", async () => {
    let observed: boolean | undefined;
    let release: (summary: TickSummary) => void = () => {};
    let finished = false;
    const harness = schedulerHarness({
      runTick: (stopped) =>
        new Promise<TickSummary>((resolve) => {
          release = (summary) => {
            observed = stopped();
            finished = true;
            resolve(summary);
          };
        }),
    });

    harness.armed[0]!.fire();
    await Promise.resolve();
    const stopping = harness.scheduler.stop();
    expect(finished).toBe(false);

    release(nothing);
    await stopping;
    expect(observed).toBe(true);
    expect(finished).toBe(true);
    expect(harness.armed[0]!.timer.clear).toHaveBeenCalledTimes(1);
    expect(harness.armed).toHaveLength(1);
  });

  /**
   * Shutdown exits non-zero if closing resources throws, and a scheduler is
   * never a good enough reason for a container to report a failed stop.
   */
  it("resolves when the in-flight tick rejects", async () => {
    let reject: (error: Error) => void = () => {};
    const harness = schedulerHarness({
      runTick: () => new Promise<TickSummary>((_, no) => (reject = no)),
    });

    harness.armed[0]!.fire();
    await Promise.resolve();
    const stopping = harness.scheduler.stop();
    reject(new Error("torn off mid-transaction"));
    await expect(stopping).resolves.toBeUndefined();
  });

  it("gives up on a tick that outlasts the grace period", async () => {
    vi.useFakeTimers();
    try {
      const harness = schedulerHarness({ runTick: () => new Promise<TickSummary>(() => {}) });
      harness.armed[0]!.fire();
      await Promise.resolve();

      const stopping = harness.scheduler.stop();
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms nothing at all when it is switched off", async () => {
    const harness = schedulerHarness({ enabled: false });

    expect(harness.scheduler.enabled).toBe(false);
    expect(harness.schedule).not.toHaveBeenCalled();
    await expect(harness.scheduler.stop()).resolves.toBeUndefined();
    expect(harness.runTick).not.toHaveBeenCalled();
    expect(harness.runReminders).not.toHaveBeenCalled();
  });

  it("sweeps template reminders on the same tick, after the proposals", async () => {
    const order: string[] = [];
    const harness = schedulerHarness({
      runTick: vi.fn(async () => {
        order.push("propose");
        return nothing;
      }),
      runReminders: vi.fn(async () => {
        order.push("remind");
        return { examined: 0, sent: 0, failed: 0 };
      }),
    });

    await harness.fireLast();

    expect(order).toEqual(["propose", "remind"]);
  });

  /**
   * The two sweeps share a tick, so neither may be able to stop the other. A
   * reminder that throws must not cost the proposals their catch-up signal, and
   * proposals that throw must not stop reminders being tried next time round.
   */
  it("keeps ticking when the reminder sweep throws", async () => {
    const harness = schedulerHarness({
      runTick: vi.fn(async () => ({ ...nothing, capped: true })),
      runReminders: vi.fn(async () => {
        throw new Error("no mail server");
      }),
    });

    await harness.fireLast();

    expect(harness.logger.error).toHaveBeenCalledWith(
      "Template reminder sweep failed",
      expect.any(Error),
    );
    // Still zero, which is the catch-up signal surviving a failed reminder.
    expect(harness.armed.at(-1)!.delay).toBe(0);
  });

  it("still sweeps reminders when a tick has nothing to propose", async () => {
    const harness = schedulerHarness();

    await harness.fireLast();

    expect(harness.runReminders).toHaveBeenCalledTimes(1);
  });
});
