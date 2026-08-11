import { MAX_BULK_SELECTION_ENTRIES } from "../shared/domain.js";

export const DEFAULT_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_CONFIGURATION_BYTES = 100 * 1024 * 1024;
/**
 * One import stages at most what one mass action can then commit, edit or
 * delete. A larger import produced a queue that could only be cleared a
 * selection at a time, which is a cap doing damage rather than protecting
 * anything. Lowering it with CSV_MAX_ROWS is a deployment's business; raising
 * it past the bulk cap only moves the refusal further along.
 */
export const DEFAULT_CSV_MAX_ROWS = MAX_BULK_SELECTION_ENTRIES;
export const MAX_CSV_CONFIGURATION_ROWS = MAX_BULK_SELECTION_ENTRIES;
export const DEFAULT_DATABASE_POOL_SIZE = 10;
export const MAX_DATABASE_POOL_SIZE = 100;
export const DEFAULT_RECURRENCE_TICK_SECONDS = 300;
export const MAX_RECURRENCE_TICK_SECONDS = 3_600;
export const DEFAULT_RECURRENCE_CATCH_UP_LIMIT = 50;
export const MAX_RECURRENCE_CATCH_UP_LIMIT = 500;
export const DEFAULT_RECURRENCE_CLAIM_LIMIT = 500;
export const MAX_RECURRENCE_CLAIM_LIMIT = 5_000;

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  maximum: number,
) {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(configured) &&
    configured >= 1 &&
    configured <= maximum
    ? configured
    : fallback;
}

export function configuredCsvMaxBytes() {
  return boundedEnvironmentInteger(
    "CSV_MAX_BYTES",
    DEFAULT_CSV_MAX_BYTES,
    MAX_CSV_CONFIGURATION_BYTES,
  );
}

export function configuredCsvMaxRows() {
  return boundedEnvironmentInteger(
    "CSV_MAX_ROWS",
    DEFAULT_CSV_MAX_ROWS,
    MAX_CSV_CONFIGURATION_ROWS,
  );
}

export function configuredDatabasePoolSize() {
  const configured = Number(
    process.env.DATABASE_POOL_SIZE ?? DEFAULT_DATABASE_POOL_SIZE,
  );
  if (
    !Number.isSafeInteger(configured) ||
    configured < 1 ||
    configured > MAX_DATABASE_POOL_SIZE
  ) {
    throw new Error(
      `DATABASE_POOL_SIZE must be an integer between 1 and ${MAX_DATABASE_POOL_SIZE}`,
    );
  }
  return configured;
}

export function configuredRecurrenceTickSeconds() {
  return boundedEnvironmentInteger(
    "RECURRENCE_TICK_SECONDS",
    DEFAULT_RECURRENCE_TICK_SECONDS,
    MAX_RECURRENCE_TICK_SECONDS,
  );
}

/**
 * Most occurrences one recurrence catches up in one tick.
 *
 * Nothing is dropped by the cap. A tick that hits it has moved the watermark by
 * exactly what it proposed, and the scheduler comes straight back rather than
 * waiting out the interval, so a long backlog drains in bounded transactions
 * instead of one enormous one.
 */
export function configuredRecurrenceCatchUpLimit() {
  return boundedEnvironmentInteger(
    "RECURRENCE_CATCH_UP_LIMIT",
    DEFAULT_RECURRENCE_CATCH_UP_LIMIT,
    MAX_RECURRENCE_CATCH_UP_LIMIT,
  );
}

export function configuredRecurrenceClaimLimit() {
  return boundedEnvironmentInteger(
    "RECURRENCE_CLAIM_LIMIT",
    DEFAULT_RECURRENCE_CLAIM_LIMIT,
    MAX_RECURRENCE_CLAIM_LIMIT,
  );
}
