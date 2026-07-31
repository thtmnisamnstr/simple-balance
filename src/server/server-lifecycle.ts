export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

export type DrainableServer = {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

type Deadline = {
  clear: () => void;
  unref: () => void;
};

type ShutdownLogger = {
  info: (message: string) => void;
  error: (message: string, error?: unknown) => void;
};

export type GracefulShutdownOptions = {
  server: DrainableServer;
  closeResources: () => Promise<void>;
  exit: (code: number) => void;
  logger?: ShutdownLogger;
  deadlineMs?: number;
  scheduleDeadline?: (callback: () => void, milliseconds: number) => Deadline;
};

function defaultScheduleDeadline(
  callback: () => void,
  milliseconds: number,
): Deadline {
  const timer = setTimeout(callback, milliseconds);
  return {
    clear: () => clearTimeout(timer),
    unref: () => timer.unref(),
  };
}

export function createGracefulShutdown({
  server,
  closeResources,
  exit,
  logger = console,
  deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
  scheduleDeadline = defaultScheduleDeadline,
}: GracefulShutdownOptions) {
  let state: "running" | "draining" | "finished" = "running";
  let deadline: Deadline | undefined;
  let completion: Promise<void> | undefined;
  let forceClosed = false;
  const hasFinished = () => state === "finished";

  const forceCloseConnections = () => {
    if (forceClosed) return;
    forceClosed = true;
    try {
      server.closeAllConnections?.();
    } catch (error) {
      logger.error("Failed to force-close HTTP connections", error);
    }
  };

  const forceExit = (reason: string) => {
    if (state === "finished") return;
    state = "finished";
    deadline?.clear();
    forceCloseConnections();
    logger.error(reason);
    exit(1);
  };

  const complete = (serverError?: Error) => {
    if (completion || state === "finished") return;
    completion = (async () => {
      let exitCode = serverError ? 1 : 0;
      if (serverError) {
        logger.error("HTTP server reported an error while closing", serverError);
      }
      try {
        await closeResources();
      } catch (error) {
        exitCode = 1;
        logger.error("Failed to close server resources", error);
      }
      if (hasFinished()) return;
      state = "finished";
      deadline?.clear();
      exit(exitCode);
    })();
  };

  return (signal: string) => {
    if (state === "finished") return;
    if (state === "draining") {
      forceExit(`${signal} received during shutdown; forcing exit`);
      return;
    }

    state = "draining";
    logger.info(`${signal} received, shutting down`);
    deadline = scheduleDeadline(
      () =>
        forceExit(
          `Graceful shutdown exceeded ${deadlineMs}ms; forcing exit`,
        ),
      deadlineMs,
    );
    deadline.unref();

    try {
      server.close((error) => complete(error));
      server.closeIdleConnections?.();
    } catch (error) {
      complete(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
