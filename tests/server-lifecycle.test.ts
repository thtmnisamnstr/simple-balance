import { describe, expect, it, vi } from "vitest";
import {
  createGracefulShutdown,
  type DrainableServer,
} from "../src/server/server-lifecycle.js";

function shutdownHarness(
  closeResources: () => Promise<void> = vi.fn(async () => undefined),
) {
  let closeCallback: ((error?: Error) => void) | undefined;
  let deadlineCallback: (() => void) | undefined;
  const deadline = {
    clear: vi.fn(),
    unref: vi.fn(),
  };
  const server: DrainableServer = {
    close: vi.fn((callback) => {
      closeCallback = callback;
    }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
  const exit = vi.fn();
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const scheduleDeadline = vi.fn((callback: () => void) => {
    deadlineCallback = callback;
    return deadline;
  });
  const shutdown = createGracefulShutdown({
    server,
    closeResources,
    exit,
    logger,
    deadlineMs: 250,
    scheduleDeadline,
  });
  return {
    closeCallback: () => closeCallback,
    closeResources,
    deadline,
    deadlineCallback: () => deadlineCallback,
    exit,
    logger,
    scheduleDeadline,
    server,
    shutdown,
  };
}

describe("graceful server shutdown", () => {
  it("drains once, unreferences the deadline, and closes resources before exit", async () => {
    const harness = shutdownHarness();

    harness.shutdown("SIGTERM");
    expect(harness.server.close).toHaveBeenCalledTimes(1);
    expect(harness.server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(harness.scheduleDeadline).toHaveBeenCalledWith(
      expect.any(Function),
      250,
    );
    expect(harness.deadline.unref).toHaveBeenCalledTimes(1);

    harness.closeCallback()?.();
    harness.closeCallback()?.();
    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(0));

    expect(harness.closeResources).toHaveBeenCalledTimes(1);
    expect(harness.deadline.clear).toHaveBeenCalledTimes(1);
    expect(harness.server.closeAllConnections).not.toHaveBeenCalled();

    harness.shutdown("SIGINT");
    expect(harness.server.close).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
  });

  it("force-closes and exits when the drain deadline expires", () => {
    const harness = shutdownHarness();

    harness.shutdown("SIGTERM");
    harness.deadlineCallback()?.();
    harness.deadlineCallback()?.();

    expect(harness.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.deadline.clear).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.closeResources).not.toHaveBeenCalled();
  });

  it("treats a second signal as an immediate forced shutdown", () => {
    const harness = shutdownHarness();

    harness.shutdown("SIGTERM");
    harness.shutdown("SIGINT");
    harness.closeCallback()?.();

    expect(harness.server.close).toHaveBeenCalledTimes(1);
    expect(harness.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.closeResources).not.toHaveBeenCalled();
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("SIGINT received during shutdown"),
    );
  });

  it("keeps the deadline active while resources close and never exits twice", async () => {
    let resolveResources: (() => void) | undefined;
    const closeResources = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResources = resolve;
        }),
    );
    const harness = shutdownHarness(closeResources);

    harness.shutdown("SIGTERM");
    harness.closeCallback()?.();
    await vi.waitFor(() =>
      expect(harness.closeResources).toHaveBeenCalledTimes(1),
    );
    harness.deadlineCallback()?.();
    resolveResources?.();
    await Promise.resolve();

    expect(harness.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });
});
