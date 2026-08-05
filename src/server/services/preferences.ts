import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../../shared/domain.js";
import { currencyCodeSchema } from "../../shared/domain.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import { userPreferences } from "../db/schema.js";
import { serializeRow, writeAudit } from "./helpers.js";

export const preferenceSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Timezone is not recognized"),
  defaultCurrency: currencyCodeSchema,
});

export async function getPreferences(actor: Actor) {
  const [preferences] = await getDb()
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, actor.userId))
    .limit(1);
  // `chosen` is the difference between "this person picked UTC" and "nobody has
  // picked anything yet", which the browser needs in order to offer what it
  // knows without ever overriding a decision.
  if (preferences) return { ...preferences, chosen: true };
  return {
    userId: actor.userId,
    timezone: "UTC",
    defaultCurrency: "USD",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    chosen: false,
  };
}

/**
 * The stored shape needs both fields, but a caller changing only one should not
 * have to send the other back or risk overwriting it with a guess. What is left
 * out keeps whatever is there now.
 */
export const preferencePatchSchema = preferenceSchema.partial();

export async function setPreferences(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const patch = preferencePatchSchema.parse(input);
  const current = await getPreferences(actor);
  const parsed = preferenceSchema.parse({
    timezone: patch.timezone ?? current.timezone,
    defaultCurrency: patch.defaultCurrency ?? current.defaultCurrency,
  });
  // Takes a transaction rather than always opening one, like every other write
  // here. Opening its own inside a caller's would take a second connection out
  // of the pool and commit on its own terms.
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, actor.userId))
      .limit(1);
    const [preferences] = await tx
      .insert(userPreferences)
      .values({ userId: actor.userId, ...parsed })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...parsed, updatedAt: new Date() },
      })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "user_preferences",
      entityId: actor.userId,
      operation: before ? "update" : "create",
      before: before ? serializeRow(before) : undefined,
      after: serializeRow(preferences),
    });
    // The same shape the read returns, `chosen` included. Setting one is what
    // choosing means, and two shapes for one record would leave a caller
    // reading a field on one path that is missing on the other.
    return { ...serializeRow(preferences), chosen: true };
  });
}
