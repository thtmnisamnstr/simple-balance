/** Types for `verify.mjs`. See `cohorts.d.mts` for why these exist. */
import type { Client } from "pg";

export interface VerifyResult {
  /** The description of every check that did not hold. Empty means it balances. */
  failures: string[];
  counts: {
    users: string;
    accounts: string;
    transactions: string;
    postings: string;
    size: string;
  };
}

/**
 * Runs every balance check against a seeded database and returns what failed.
 *
 * Takes a connected client rather than a URL so a caller already inside a
 * transaction or a test harness can hand over the connection it has.
 */
export function verify(client: Client): Promise<VerifyResult>;
