import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../../shared/domain.js";
import { currencyCodeSchema, themes } from "../../shared/domain.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import { userPreferences } from "../db/schema.js";
import { validationError } from "./errors.js";
import { serializeRow, writeAudit, type Executor } from "./helpers.js";

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
    }, "Timezone is not recognized")
    .describe(
      "An IANA timezone name such as Europe/London. It decides what today means everywhere a date is worked out: which day an open-ended range stops at, and which day an entry dated today lands on.",
    ),
  defaultCurrency: currencyCodeSchema.describe(
    "The currency a new account and a new entry start in. It is a default and nothing else: it changes no figure already recorded, and the person may change it whenever they like.",
  ),
  theme: z
    .enum(themes)
    .describe(
      "system, light or dark. `system` follows the person's own machine and is the only one that keeps following it when they change it. Set it only when asked to: it is what their screen looks like and you cannot see it.",
    ),
});

/**
 * What a person gets before they have chosen anything. One copy, because the
 * read synthesises them for a missing row and a partial write has to insert
 * the same ones for the field it was not given.
 */
const unchosenPreferences = {
  timezone: "UTC",
  defaultCurrency: "USD",
  theme: "system",
} as const;

/**
 * Takes an executor because a caller inside a transaction must not reach into
 * the pool for a second connection. On a one-connection pool that waits for a
 * connection its own open transaction is holding, which is a deadlock that only
 * appears under a small pool and then never resolves.
 */
export async function getPreferences(actor: Actor, executor: Executor = getDb()) {
  const [preferences] = await executor
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
    ...unchosenPreferences,
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

/**
 * Whether this write is a guess that must lose to a decision.
 *
 * The browser offers the timezone and currency it can detect, and that offer is
 * conditional: only while nobody has chosen. Deciding that on the client means
 * deciding it against the session it loaded with, which may already be stale —
 * somebody changing the timezone in Settings on another tab, or on a phone,
 * while a page is open is enough to have their choice overwritten by a guess.
 *
 * So the condition travels with the write and is checked where the row is, in
 * the same transaction that would do the writing.
 *
 * Read off the input separately from the values, so a browser reporting a zone
 * this server's ICU does not know cannot turn a write that was never going to
 * happen into a 422.
 *
 * Deliberately not part of `preferencePatchSchema`, which is the MCP tool's
 * input contract: an agent has no browser locale and nothing to be tentative
 * about.
 */
const adoptionSchema = z.object({ ifUnchosen: z.boolean().optional() });

export async function setPreferences(actor: Actor, input: unknown, transaction?: DbTransaction) {
  const { ifUnchosen } = adoptionSchema.parse(input && typeof input === "object" ? input : {});
  // Takes a transaction rather than always opening one, like every other write
  // here. Opening its own inside a caller's would take a second connection out
  // of the pool and commit on its own terms.
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, actor.userId))
      .limit(1)
      .for("update");

    // Somebody has already chosen, so the guess loses and writes nothing: not
    // the values, not `updatedAt`, and no audit event, because nothing happened.
    if (ifUnchosen && before) return { ...serializeRow(before), chosen: true };

    const patch = preferencePatchSchema.parse(input);
    // An empty patch asks for nothing and its only effect would be to record a
    // decision nobody made: it writes a defaults row and flips `chosen` to true,
    // which permanently stops the browser offering the timezone it detected.
    if (!Object.keys(patch).length) {
      throw validationError("Choose at least one preference to change");
    }
    // Merged by PostgreSQL, not here. Reading the row first and writing back
    // both fields made every partial change a read-modify-write: two callers
    // each setting a different field both read the same row and the second one
    // to commit wrote the first one's field back to what it had been.
    //
    // The conflict clause names only the fields this call was given, so a field
    // it was not given is never part of the statement and cannot be
    // overwritten. The insert still needs both, because a row that does not
    // exist yet has no other side to take them from.
    const inserted = preferenceSchema.parse({
      timezone: patch.timezone ?? unchosenPreferences.timezone,
      defaultCurrency: patch.defaultCurrency ?? unchosenPreferences.defaultCurrency,
      theme: patch.theme ?? unchosenPreferences.theme,
    });

    if (ifUnchosen) {
      // `for update` locks nothing on a row that is not there, so two first
      // writers both reach here. Do-nothing rather than do-update, and whoever
      // arrives second reads back what the first one chose.
      const [created] = await tx
        .insert(userPreferences)
        .values({ userId: actor.userId, ...inserted })
        .onConflictDoNothing({ target: userPreferences.userId })
        .returning();
      if (!created) {
        const [current] = await tx
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.userId, actor.userId))
          .limit(1);
        return { ...serializeRow(current!), chosen: true };
      }
      await writeAudit(tx, actor, {
        entityType: "user_preferences",
        entityId: actor.userId,
        operation: "create",
        after: serializeRow(created),
      });
      return { ...serializeRow(created), chosen: true };
    }

    const [preferences] = await tx
      .insert(userPreferences)
      .values({ userId: actor.userId, ...inserted })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...patch, updatedAt: new Date() },
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
