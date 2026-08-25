import { describe, expect, it } from "vitest";
import {
  recurrenceCreateSchema,
  recurrenceScheduleSchema,
  recurrenceSchedulePatchSchema,
  recurrenceShapeSchema,
  recurrenceUpdateSchema,
} from "../src/shared/domain.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const categoryId = "33333333-3333-4333-8333-333333333333";

const shape = (over: Record<string, unknown> = {}) => ({
  type: "withdrawal" as const,
  payee: "Landlord",
  fromAccountId: accountId,
  ...over,
});

const schedule = (over: Record<string, unknown> = {}) => ({
  frequency: "monthly" as const,
  anchorDate: "2026-01-01",
  ...over,
});

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message).join(" | ") ?? "";

describe("what a recurrence remembers", () => {
  /**
   * The electricity bill recurs and its amount does not. A proposal missing one
   * lands in the queue flagged, which is the point of proposing rather than
   * posting.
   */
  it("accepts a shape with no amount", () => {
    expect(recurrenceShapeSchema.safeParse(shape()).success).toBe(true);
  });

  it("refuses the provenance fields a proposal must never carry", () => {
    for (const field of ["externalId", "templateId", "date"]) {
      const result = recurrenceShapeSchema.safeParse(
        shape({ [field]: field === "date" ? "2026-01-01" : "anything" }),
      );
      expect(result.success, field).toBe(false);
    }
  });

  /**
   * Legs are how a total is divided. A division with a part missing is not
   * something somebody can complete from the queue, so it is refused up front
   * rather than proposed and left unusable.
   */
  it("refuses a split with no amount for its legs to divide", () => {
    const split = shape({
      legs: [
        { categoryId, amount: "60.00" },
        { categoryName: "Household", amount: "40.00" },
      ],
    });
    expect(messages(recurrenceShapeSchema.safeParse(split))).toContain(
      "needs an amount for its legs to divide",
    );
    expect(recurrenceShapeSchema.safeParse({ ...split, amount: "100.00" }).success).toBe(true);
  });

  /**
   * A recurrence replays the same division on every occurrence, so one that
   * does not balance is not one bad row, it is a queue that fills with rows
   * carrying the same complaint and no way to commit any of them.
   */
  it("refuses a split whose legs do not add up to the amount", () => {
    const split = (amount: string, parts: [string, string]) =>
      recurrenceShapeSchema.safeParse(
        shape({
          amount,
          legs: [
            { categoryId, amount: parts[0] },
            { categoryName: "Household", amount: parts[1] },
          ],
        }),
      );

    expect(split("100.00", ["60.00", "40.00"]).success).toBe(true);
    expect(messages(split("100.00", ["60.00", "39.99"]))).toContain("must add up");
    expect(messages(split("100.00", ["60.00", "40.01"]))).toContain("must add up");
    // Compared exactly, not as floating point: 0.1 + 0.2 is 0.3 here.
    expect(split("0.30", ["0.10", "0.20"]).success).toBe(true);
    // Trailing zeros are the same number, and different scales still line up.
    expect(split("100", ["60.000", "40"]).success).toBe(true);
    expect(
      split("1000000000000000000000000.000000000000000001", [
        "1000000000000000000000000",
        "0.000000000000000001",
      ]).success,
    ).toBe(true);
  });

  it("keeps the split refusals the ledger already applies", () => {
    const legs = [
      { categoryId, amount: "60.00" },
      { categoryName: "Household", amount: "40.00" },
    ];
    expect(
      recurrenceShapeSchema.safeParse(shape({ amount: "100.00", categoryId, legs })).success,
    ).toBe(false);
    expect(
      recurrenceShapeSchema.safeParse({
        type: "transfer",
        payee: "Moving money",
        fromAccountId: accountId,
        toAccountId: otherAccountId,
        amount: "100.00",
        legs,
      }).success,
    ).toBe(false);
  });
});

describe("the schedule", () => {
  it("fills in the interval and both policies", () => {
    const parsed = recurrenceScheduleSchema.parse(schedule());
    expect(parsed).toMatchObject({
      interval: 1,
      monthPolicy: "last_day",
      weekendPolicy: "allow",
    });
  });

  /**
   * Friday, Saturday and Sunday all collapse onto one posted date, and the queue
   * refuses to commit a selection holding rows that alike, so the whole batch
   * fails rather than one row being flagged.
   */
  it("refuses a daily schedule pushed onto a business day", () => {
    // Interval two collides as well: Saturday moves forward two days onto the
    // Monday that is the next occurrence, and Sunday back two onto the Friday
    // that was the last one. Three days apart is the first gap a two-day move
    // cannot close.
    for (const interval of [1, 2]) {
      for (const weekendPolicy of ["previous_business_day", "next_business_day"]) {
        const result = recurrenceScheduleSchema.safeParse(
          schedule({ frequency: "daily", interval, weekendPolicy }),
        );
        expect(result.success, `${interval} ${weekendPolicy}`).toBe(false);
        expect(messages(result)).toContain("Staged transactions refuses");
      }
    }
  });

  it("allows the same daily schedule with a policy that cannot collide", () => {
    for (const weekendPolicy of ["allow", "skip"]) {
      expect(
        recurrenceScheduleSchema.safeParse(
          schedule({ frequency: "daily", interval: 1, weekendPolicy }),
        ).success,
        weekendPolicy,
      ).toBe(true);
    }
    expect(
      recurrenceScheduleSchema.safeParse(
        schedule({
          frequency: "daily",
          interval: 3,
          weekendPolicy: "previous_business_day",
        }),
      ).success,
    ).toBe(true);
  });

  it("takes a relative day of the month, and refuses one where it has no meaning", () => {
    expect(
      recurrenceScheduleSchema.safeParse(schedule({ position: { ordinal: 2, weekday: 2 } }))
        .success,
    ).toBe(true);
    expect(
      recurrenceScheduleSchema.safeParse(
        schedule({ frequency: "yearly", position: { ordinal: -1, weekday: 5 } }),
      ).success,
    ).toBe(true);
    expect(
      messages(
        recurrenceScheduleSchema.safeParse(
          schedule({ frequency: "weekly", position: { ordinal: 2, weekday: 2 } }),
        ),
      ),
    ).toContain("weekday of its anchor date");
    expect(
      recurrenceScheduleSchema.safeParse(
        schedule({ frequency: "daily", position: { ordinal: 2, weekday: 2 } }),
      ).success,
    ).toBe(false);
  });

  it("refuses a fifth ordinal, which means different things in different months", () => {
    expect(
      recurrenceScheduleSchema.safeParse(schedule({ position: { ordinal: 5, weekday: 2 } }))
        .success,
    ).toBe(false);
  });
});

describe("changing one part of a schedule", () => {
  /**
   * `.partial()` only reaches top-level keys, so a nested schedule carrying
   * defaults would silently reset the awkward-date policies somebody chose the
   * moment they changed the frequency.
   */
  it("leaves out what the caller did not send, rather than defaulting it", () => {
    const parsed = recurrenceUpdateSchema.parse({
      schedule: { frequency: "weekly" },
      expectedVersion: 1,
    });
    expect(parsed.schedule).toEqual({ frequency: "weekly" });
    expect(parsed.schedule).not.toHaveProperty("monthPolicy");
    expect(parsed.schedule).not.toHaveProperty("weekendPolicy");
    expect(parsed.schedule).not.toHaveProperty("interval");
  });

  it("still refuses a merged result the full schema would not accept", () => {
    const stored = recurrenceScheduleSchema.parse(
      schedule({ frequency: "weekly", weekendPolicy: "previous_business_day" }),
    );
    const patch = recurrenceSchedulePatchSchema.parse({
      frequency: "daily",
      interval: 1,
    });
    expect(recurrenceScheduleSchema.safeParse({ ...stored, ...patch }).success).toBe(false);
  });

  it("requires an expected version", () => {
    expect(recurrenceUpdateSchema.safeParse({ name: "Rent" }).success).toBe(false);
  });
});

describe("creating one", () => {
  it("needs a name, a shape and a schedule", () => {
    expect(
      recurrenceCreateSchema.safeParse({
        name: "Rent",
        shape: shape({ amount: "1200.00" }),
        schedule: schedule(),
      }).success,
    ).toBe(true);
    expect(
      recurrenceCreateSchema.safeParse({ name: "", shape: shape(), schedule: schedule() }).success,
    ).toBe(false);
  });
});
