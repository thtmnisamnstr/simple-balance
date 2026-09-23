/**
 * Types for `entry-key.mjs`, which is plain ESM because `build.mjs` imports it
 * and `build.mjs` is plain ESM. See `scripts/capacity/cohorts.d.mts` for why a
 * module a strict test imports has to be typed rather than left as `any`.
 */
export declare function entryKey(today: Date, monthsAgo: number, entryIndex: number): string;
