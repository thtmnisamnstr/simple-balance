import { MAX_BULK_SELECTION_ENTRIES } from "../shared/domain.js";

export const DEFAULT_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_CONFIGURATION_BYTES = 100 * 1024 * 1024;
/**
 * One import stages at most what one mass action can then commit, edit or
 * delete. A larger import produced a queue that could only be cleared a
 * selection at a time, which is a cap doing damage rather than protecting
 * anything. Lowering it with CSV_MAX_ROWS is a deployment's business; asking
 * for more than the bulk cap refuses to start, because the extra rows could
 * only ever have staged a queue no single action clears.
 */
export const DEFAULT_CSV_MAX_ROWS = MAX_BULK_SELECTION_ENTRIES;
export const MAX_CSV_CONFIGURATION_ROWS = MAX_BULK_SELECTION_ENTRIES;

/**
 * The most rows one export writes, and deliberately not the import cap.
 *
 * They are answers to different questions. The import cap is a fact about what
 * one mass action can then clear — ten thousand rows is the number a commit, a
 * mass edit and a mass delete all share, so a file that stages more than one
 * action can clear is a cap doing damage. The export is the exit, and capping
 * the exit at what one import can take would mean a forty-thousand-row ledger
 * cannot leave this product whole, which is a worse failure than a file its own
 * importer asks you to split.
 *
 * So the gap stays, and what closes it is both refusals naming the remedy
 * rather than either number moving.
 */
export const CSV_EXPORT_MAX_ROWS = 100_000;
export const DEFAULT_DATABASE_POOL_SIZE = 10;
export const MAX_DATABASE_POOL_SIZE = 100;
export const DEFAULT_RECURRENCE_TICK_SECONDS = 300;
export const MAX_RECURRENCE_TICK_SECONDS = 3_600;
export const DEFAULT_RECURRENCE_CATCH_UP_LIMIT = 50;
export const MAX_RECURRENCE_CATCH_UP_LIMIT = 500;
export const DEFAULT_RECURRENCE_CLAIM_LIMIT = 500;
export const MAX_RECURRENCE_CLAIM_LIMIT = 5_000;

/**
 * A bounded integer refuses rather than falling back, and names itself when it
 * does.
 *
 * Falling back was the failure with no symptom, which is the argument
 * `config.ts` already makes about `RECURRENCE_SCHEDULER`: a deployment that
 * meant `CSV_MAX_ROWS=1000` and typed `1O00` imported ten thousand rows and
 * said nothing, and the operator learned the number they set was never the
 * number in force only if they went looking. Unset is the one thing that means
 * "the default"; an empty value is a value somebody wrote, and it is not a
 * number.
 */
function boundedEnvironmentInteger(name: string, fallback: number, maximum: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const configured = Number(value);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return configured;
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
  return boundedEnvironmentInteger(
    "DATABASE_POOL_SIZE",
    DEFAULT_DATABASE_POOL_SIZE,
    MAX_DATABASE_POOL_SIZE,
  );
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

/**
 * Reads every bounded integer once, at startup, so a wrong one is a process
 * that will not start rather than a limit nobody ever sees.
 *
 * Refusing is only half the rule: each of these is otherwise read at the moment
 * it is wanted — `CSV_MAX_ROWS` inside an import, the recurrence limits inside a
 * tick — which is hours or days after the operator who set it stopped watching,
 * and for a variable nothing on the deployment happens to exercise, never.
 * `getConfig()` calls this, so every entrypoint reaches it before it serves
 * anything, the way `DATABASE_POOL_SIZE` was only reached by the accident of a
 * query running before the listener opened.
 */
export function assertConfiguredLimits() {
  configuredCsvMaxBytes();
  configuredCsvMaxRows();
  configuredDatabasePoolSize();
  configuredRecurrenceTickSeconds();
  configuredRecurrenceCatchUpLimit();
  configuredRecurrenceClaimLimit();
}
