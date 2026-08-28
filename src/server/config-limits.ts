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
 * A bounded integer falls back to its default and says so, once, by name.
 *
 * The defect this fixes was the silence, not the fallback. A deployment that
 * meant `CSV_MAX_ROWS=1000` and typed `1O00` imported ten thousand rows and said
 * nothing, so the operator learned the number they set was never the number in
 * force only if they went looking.
 *
 * It warns rather than refusing, and that is a deliberate reversal. Refusing
 * reads better in a guide and is wrong here: a typo in a tuning knob would stop
 * a ledger from starting, and it would stop it *on upgrade*, on a value the
 * previous release accepted. Nobody types a cap wrong and wants their accounts
 * offline for it. The warning is what the operator needed; the outage was not.
 *
 * `DATABASE_POOL_SIZE` used to throw here on its own and now falls back with
 * the rest. That is strictly more permissive, so nothing that started before
 * fails to start now, and one rule across six variables is easier to hold than
 * five and an exception.
 *
 * Unset means the default and says nothing. An empty value means the same and
 * also says nothing, because `.env.example` ships blanks and a compose file
 * ships `${SETUP_TOKEN:-}`; warning about those would train everybody to ignore
 * the warning that matters.
 */
const warned = new Set<string>();

function boundedEnvironmentInteger(name: string, fallback: number, maximum: number) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const configured = Number(value);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
    // Once per name per process. These are read on a schedule as well as at
    // startup — `configuredRecurrenceTickSeconds` runs on every scheduler tick —
    // so warning on every read would fill a log with one mistake.
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(
        `${name} is set to ${JSON.stringify(value)}, which is not an integer between 1 and ${maximum}. ` +
          `Using ${fallback} instead. Fix the value or remove it; it is having no effect.`,
      );
    }
    return fallback;
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
 * Read every bounded integer once, at startup, so a typo is reported in front of
 * whoever just deployed rather than on the first CSV import or the first
 * scheduler tick — which for a tick interval could be minutes later and in a
 * different container's log, and for a variable nothing on the deployment
 * exercises, never at all. `getConfig()` calls this, so every entrypoint reaches
 * it before it serves anything, rather than resting on the accident that made
 * `DATABASE_POOL_SIZE` work: a query that happened to run before the listener
 * opened.
 *
 * It reports; it does not refuse. See `boundedEnvironmentInteger` for why, which
 * is the upgrade rule rather than a softer view of typos.
 */
export function assertConfiguredLimits() {
  configuredCsvMaxBytes();
  configuredCsvMaxRows();
  configuredDatabasePoolSize();
  configuredRecurrenceTickSeconds();
  configuredRecurrenceCatchUpLimit();
  configuredRecurrenceClaimLimit();
}
