import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src/server/services/helpers.js";

/**
 * The refusal a unique origin index raises, read the way PostgreSQL and Citus
 * each spell it.
 *
 * A single node names the index; a Citus cluster names the shard's copy of it,
 * with the shard's number after the name, and that is the copy that refused.
 * The import's two origin indexes are matched by what their names start with,
 * so a refusal on a cluster is told in the same sentence as on one node rather
 * than surfacing as a bare 500.
 */
describe("a unique violation, by the index it names", () => {
  const drizzleWrapped = (code: string, constraint: string) =>
    Object.assign(new Error("Failed query"), { cause: { code, constraint } });

  it("is found on the driver's error beneath Drizzle's", () => {
    expect(
      isUniqueViolation(
        drizzleWrapped("23505", "transaction_user_import_origin_unique"),
        "transaction_user_import_origin_unique",
      ),
    ).toBe(true);
  });

  it("is found under the shard's name on a Citus cluster", () => {
    expect(
      isUniqueViolation(
        drizzleWrapped("23505", "transaction_user_import_origin_unique_102220"),
        "transaction_user_import_origin_unique",
      ),
    ).toBe(true);
  });

  it("is found on an error the driver raised directly", () => {
    expect(
      isUniqueViolation(
        { code: "23505", constraint: "staged_user_import_origin_unique" },
        "staged_user_import_origin_unique",
      ),
    ).toBe(true);
  });

  it("is not some other index's, or some other refusal", () => {
    expect(
      isUniqueViolation(
        drizzleWrapped("23505", "staged_recurrence_occurrence_unique"),
        "staged_user_import_origin_unique",
      ),
    ).toBe(false);
    expect(
      isUniqueViolation(
        drizzleWrapped("23503", "transaction_user_import_origin_unique"),
        "transaction_user_import_origin_unique",
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "transaction_user_import_origin_unique")).toBe(
      false,
    );
    expect(isUniqueViolation(null, "transaction_user_import_origin_unique")).toBe(false);
  });
});
