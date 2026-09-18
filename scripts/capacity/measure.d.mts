/** Types for `measure.mjs`. See `cohorts.d.mts` for why these exist. */
export function percentile(sorted: number[], p: number): number | undefined;
export function buildWheel(mix: { kind: string; percent: number }[]): string[];
export function errorsIn(statuses: Map<number, number>): number;
