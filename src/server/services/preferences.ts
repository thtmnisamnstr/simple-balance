import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../../shared/domain.js";
import { currencyCodeSchema } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import { userPreferences } from "../db/schema.js";
import { serializeRow, writeAudit } from "./helpers.js";

const preferenceSchema = z.object({
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

export async function setPreferences(actor: Actor, input: unknown) {
  const parsed = preferenceSchema.parse(input);
  return getDb().transaction(async (tx) => {
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
    return preferences;
  });
}
