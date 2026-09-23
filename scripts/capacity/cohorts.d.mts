/**
 * Types for `cohorts.mjs`, which is plain ESM because it is run by `node`
 * directly, the way `scripts/set-version.mjs` is.
 *
 * `tests/capacity-schedule.test.ts` imports it under `strict`, and an untyped
 * import there is an `any` that would quietly make every assertion in that file
 * vacuous. The declarations are deliberately the whole shape rather than a
 * convenience subset, so a field added to the module without being added here
 * fails to compile at its first use rather than typing as `any`.
 */
export interface Cohort {
  name: string;
  users: number;
  accounts: number;
  transactions: number;
  currencies: string[];
}

export const COHORTS: Cohort[];
export const EDIT_EVERY: number;
export const VOID_RESTORE_EVERY: number;
export const POSTINGS_PER_TRANSACTION: number;
export const TOTAL_USERS: number;
export const TOTAL_ACCOUNTS: number;
export const TOTAL_TRANSACTIONS: number;
export const TOTAL_POSTINGS: number;
export function scaled(scale: number): Cohort[];
