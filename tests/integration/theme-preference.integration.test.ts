import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { auditEvents, user, userPreferences } from "../../src/server/db/schema.js";
import {
  getPreferences,
  setPreferences,
} from "../../src/server/services/preferences.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("theme_preference");

const chooser: Actor = { userId: "theme-chooser", source: "web" };
const settled: Actor = { userId: "theme-settled", source: "web" };
const agent: Actor = { userId: "theme-chooser", source: "mcp" };

/**
 * The theme is stored, so it is worth proving it is stored — but the reason this
 * file exists is the third state. `system` has to mean "keep following the
 * machine", which is only true if nothing ever writes a detected value over it,
 * and if it survives being the default for every account that existed before the
 * column did.
 */
integration("which theme an account is set to", () => {
  beforeAll(async () => {
    await database.create();
    for (const [id, name] of [
      [chooser.userId, "Theme Chooser"],
      [settled.userId, "Theme Settled"],
    ] as const) {
      await getDb().insert(user).values({
        id,
        name,
        email: `${id}@example.com`,
        emailVerified: true,
      });
    }
  });

  afterAll(async () => {
    await database.drop();
  });

  it("starts every account following the machine", async () => {
    // Read before anything is written: the answer is synthesised, and it has to
    // agree with the column default or a fresh account reads one thing and then
    // changes on its first save.
    const before = await getPreferences(chooser);
    expect(before.theme).toBe("system");
    expect(before.chosen).toBe(false);
  });

  it("gives an account that predates the column the same answer", async () => {
    // What the migration does to somebody who already had a preferences row.
    // The default is constant, so PostgreSQL fills it without a table rewrite,
    // and "follow the machine" is the honest value to fill it with — nothing
    // knows what machine they are on.
    await setPreferences(settled, { timezone: "Europe/London" });
    const stored = await getPreferences(settled);
    expect(stored.theme).toBe("system");
    expect(stored.chosen).toBe(true);
  });

  for (const theme of ["light", "dark", "system"] as const) {
    it(`remembers ${theme}`, async () => {
      const saved = await setPreferences(chooser, { theme });
      expect(saved.theme).toBe(theme);
      expect((await getPreferences(chooser)).theme).toBe(theme);
    });
  }

  it("refuses a theme that is not one of the three", async () => {
    await expect(setPreferences(chooser, { theme: "midnight" })).rejects.toThrow();
    // And leaves what was there, rather than half-writing.
    expect((await getPreferences(chooser)).theme).toBe("system");
  });

  it("changes the theme without disturbing the other preferences", async () => {
    await setPreferences(chooser, { timezone: "Asia/Tokyo", defaultCurrency: "JPY" });
    await setPreferences(chooser, { theme: "dark" });
    const stored = await getPreferences(chooser);
    // The conflict clause names only the fields the call was given, so a field it
    // was not given is never part of the statement.
    expect(stored).toMatchObject({
      timezone: "Asia/Tokyo",
      defaultCurrency: "JPY",
      theme: "dark",
    });
  });

  it("lets an agent set it, and records who did", async () => {
    await setPreferences(agent, { theme: "light" });
    const events = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, chooser.userId));
    const fromAgent = events.filter((event) => event.actorSource === "mcp");
    expect(fromAgent.length).toBeGreaterThan(0);
    expect((fromAgent.at(-1)!.after as { theme?: string }).theme).toBe("light");
  });

  it("will not let a browser's guess overwrite a theme somebody chose", async () => {
    // The adoption path exists so a new account can be handed the timezone the
    // browser knows. It must never reach the theme of an account that has
    // already chosen one — and because it is scoped to the row, it never fires
    // for any account with preferences at all, which is why nothing detects a
    // theme in the first place.
    //
    // Two things stop it independently: the early return before any write, and
    // the do-nothing conflict clause on the insert. So this passes with either
    // one removed and fails only when both are, which is worth knowing before
    // treating it as cover for a change to one of them.
    await setPreferences(chooser, { theme: "dark" });
    const attempted = await setPreferences(chooser, {
      timezone: "UTC",
      defaultCurrency: "USD",
      theme: "light",
      ifUnchosen: true,
    });
    expect(attempted.theme).toBe("dark");
    expect((await getPreferences(chooser)).theme).toBe("dark");
    const [row] = await getDb()
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, chooser.userId));
    expect(row!.theme).toBe("dark");
  });
});
