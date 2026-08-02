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
};

/** Ascending puts blanks last; descending puts them last too, so a sort never leads with nothing. */
export function ordered(expression: SQL, direction: SortDirection) {
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
