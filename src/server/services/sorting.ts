import { type SQL, sql } from "drizzle-orm";
import type { SortDirection } from "../../shared/domain.js";

/**
 * How a list is ordered, and whether that ordering can be resumed by a cursor.
 *
 * A keyset cursor needs the sorted value to live on the row it pages through.
 * Ordering by something reached from another table, such as an account or
 * category name, cannot be resumed that way, so those orderings page by number
 * instead and say so by offering no cursor.
 */
export type SortPlan<Row> = {
  orderBy: SQL[];
  keyset: ((value: string, id: string) => SQL) | null;
  cursorValue: ((row: Row) => string) | null;
  /**
   * Checks that a cursor's remembered value is the shape this ordering compares
   * against, before it becomes a bound parameter.
   *
   * A cursor is something the caller hands back, so its contents are as
   * untrusted as anything else they send. The value is compared against a date
   * or a numeric column, and PostgreSQL answers a value it cannot read with an
   * error, which surfaces as an unexplained 500 rather than as the invalid
   * cursor it is. Orderings compared as text need nothing here.
   */
  parseCursorValue?: (value: string) => void;
};

/**
 * One term of an ORDER BY.
 *
 * `nulls last` is only for keys that can actually be null. Asking for it on a
 * key that cannot costs a great deal: a btree read backwards produces
 * DESC NULLS FIRST, so `desc nulls last` does not match the index and Postgres
 * falls back to sorting the whole table. On the default newest-first view that
 * is the difference between reading an index and scanning the ledger.
 */
export function ordered(
  expression: SQL,
  direction: SortDirection,
  nullable = false,
) {
  if (!nullable) {
    return direction === "asc" ? sql`${expression} asc` : sql`${expression} desc`;
  }
  return direction === "asc"
    ? sql`${expression} asc nulls last`
    : sql`${expression} desc nulls last`;
}

/**
 * The tuple comparison that resumes a keyset walk: strictly past the boundary
 * value, or level with it and strictly past the boundary row.
 */
export function keysetAfter(
  expression: SQL,
  id: SQL,
  direction: SortDirection,
) {
  return (value: string, boundaryId: string) =>
    direction === "asc"
      ? sql`(${expression}, ${id}) > (${value}, ${boundaryId}::uuid)`
      : sql`(${expression}, ${id}) < (${value}, ${boundaryId}::uuid)`;
}
