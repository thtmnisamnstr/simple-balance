/**
 * Every advisory lock the application takes, named in one place.
 *
 * PostgreSQL advisory locks share a single namespace across the database, so
 * two features that pick the same number silently become one lock. That is not
 * a compile error and it is not a test failure; it shows up as one feature
 * mysteriously waiting on an unrelated one. The MCP signing key and the
 * first-account claim were both 724202608 until this file existed, which meant
 * an anonymous request for a signing key could turn a sign-up into "setup is
 * already in progress".
 *
 * Add new locks here and nowhere else.
 */
export const MIGRATION_LOCK = 724_202_607;
export const LOCAL_BOOTSTRAP_LOCK = 724_202_608;
export const MCP_SIGNING_KEY_LOCK = 724_202_609;
/**
 * Held for a whole scheduler tick, on a connection of its own, so one replica
 * walks the due recurrences while the others wait. Per-transaction locks cannot
 * do this: they release at every commit, and the tick commits once per
 * recurrence.
 */
export const RECURRENCE_SCHEDULER_LOCK = 724_202_610;
