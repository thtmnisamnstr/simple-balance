export const DEFAULT_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_CONFIGURATION_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CSV_MAX_ROWS = 25_000;
export const MAX_CSV_CONFIGURATION_ROWS = 1_000_000;
export const DEFAULT_DATABASE_POOL_SIZE = 10;
export const MAX_DATABASE_POOL_SIZE = 100;

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
