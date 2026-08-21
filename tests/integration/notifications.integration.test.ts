import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import {
  auditEvents,
  templateNotifications,
  transactionTemplates,
  user,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { runDueNotifications } from "../../src/server/services/notifications.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import {
  createRecurrence,
  getRecurrence,
  runDueRecurrences,
  updateRecurrence,
} from "../../src/server/services/recurrences.js";
import {
  bulkDeleteTransactionTemplates,
  bulkEditTransactionTemplates,
  createTransactionTemplate,
  deleteTransactionTemplate,
  getTransactionTemplate,
  updateTransactionTemplate,
} from "../../src/server/services/transaction-templates.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The mailer is replaced rather than pointed at a server. What these tests are
 * about is which messages the scheduler decides to send and how often, and a real
 * SMTP conversation would only add a way for them to fail for reasons that have
 * nothing to do with that.
 */
const sent: { to: string; subject: string; body: string }[] = [];
vi.mock("../../src/server/mail.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/server/mail.js")>();
  return {
    ...real,
    mailEnabled: () => true,
    sendMail: async (message: { to: string; subject: string; body: string }) => {
      sent.push(message);
      return true;
    },
  };
});

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("notifications");
const actor: Actor = { userId: "notify-user", source: "web" };
const other: Actor = { userId: "notify-other", source: "web" };

let checkingId = "";

/** Pinned, because everything here turns on the day and the hour it is. */
const at = (instant: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
};

/** Every audit row written about one template, oldest first. */
const auditFor = async (templateId: string) =>
  getDb()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, templateId))
    .orderBy(auditEvents.createdAt);

const reminderRow = async (templateId: string) => {
  const [row] = await getDb()
    .select()
    .from(templateNotifications)
    .where(eq(templateNotifications.templateId, templateId));
  return row ?? null;
};

integration("scheduled notifications", () => {
  beforeAll(async () => {
    await database.create();
    await getDb()
      .insert(user)
      .values([
        {
          id: actor.userId,
          name: "Notify",
          email: "notify@example.com",
          emailVerified: true,
        },
        {
          id: other.userId,
          name: "Other",
          email: "other@example.com",
          emailVerified: true,
        },
      ]);
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "5000",
      })
    ).id;
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await getDb().delete(templateNotifications);
    await getDb().delete(transactionTemplates);
    await getDb().delete(auditEvents);
  });

  afterAll(async () => {
    await database.drop();
  });

  const template = async (
    name: string,
    notification: unknown,
    who: Actor = actor,
  ) =>
    createTransactionTemplate(who, {
      name,
      draft: { type: "withdrawal", payee: "Landlord", amount: "1200" },
      notification,
    });

  describe("a recurrence that was asked to say so", () => {
    let seed = 0;
    const recurrence = async (notifyOnCreate: boolean) =>
      createRecurrence(actor, {
        name: `Rent ${(seed += 1)}`,
        shape: {
          type: "withdrawal",
          payee: "Landlord",
          fromAccountId: checkingId,
          amount: "1200",
        },
        schedule: { frequency: "daily", interval: 1, anchorDate: "2026-01-01" },
        notifyOnCreate,
      });

    it("writes when it proposes, and says what it proposed", async () => {
      const created = await recurrence(true);
      const summary = await runDueRecurrences();

      expect(summary.proposed).toBeGreaterThan(0);
      expect(summary.notified).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("notify@example.com");
      expect(sent[0]!.subject).toContain(created.name);
      expect(sent[0]!.body).toContain("/staged");
    });

    it("says nothing when it was not asked to", async () => {
      await recurrence(false);
      const summary = await runDueRecurrences();

      expect(summary.proposed).toBeGreaterThan(0);
      expect(summary.notified).toBe(0);
      expect(sent).toHaveLength(0);
    });

    /**
     * The second tick has nothing left to propose, so it must have nothing to
     * say either. A message per tick would arrive every five minutes forever.
     */
    it("says nothing on a tick that proposes nothing", async () => {
      await recurrence(true);
      await runDueRecurrences();
      sent.length = 0;

      const summary = await runDueRecurrences();

      expect(summary.proposed).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it("can be turned on and off after the fact", async () => {
      const created = await recurrence(false);
      const off = await getRecurrence(actor, created.id);
      expect(off.notifyOnCreate).toBe(false);

      const updated = await updateRecurrence(actor, created.id, {
        notifyOnCreate: true,
        expectedVersion: off.version,
      });
      expect(updated.notifyOnCreate).toBe(true);
      expect((await getRecurrence(actor, created.id)).notifyOnCreate).toBe(true);
    });
  });

  describe("a reminder that happens once", () => {
    it("waits for the hour it was asked for, then goes exactly once", async () => {
      at("2026-05-10T06:00:00Z");
      const created = await template("Quarterly tax", {
        anchorDate: "2026-05-10",
        time: "09:00",
      });
      expect(created.notification).toMatchObject({
        repeats: false,
        frequency: null,
        nextNotificationDate: "2026-05-10",
      });

      // Before nine, so nothing is owed yet.
      expect(await runDueNotifications()).toMatchObject({ sent: 0 });
      expect(sent).toHaveLength(0);

      at("2026-05-10T09:00:00Z");
      expect(await runDueNotifications()).toMatchObject({ examined: 1, sent: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe("Reminder: Quarterly tax");
      expect(sent[0]!.body).toContain("/templates");
      expect(sent[0]!.body).toContain("one-off");

      // Nothing further is owed, and the scheduler stops looking.
      const row = await reminderRow(created.id);
      expect(row!.lastNotifiedDate).toBe("2026-05-10");
      expect(row!.nextNotificationDate).toBeNull();

      at("2026-06-01T09:00:00Z");
      sent.length = 0;
      expect(await runDueNotifications()).toMatchObject({ examined: 0, sent: 0 });
      expect(sent).toHaveLength(0);
    });

    it("refuses the fields a one-off cannot use", async () => {
      await expect(
        template("Nonsense", {
          anchorDate: "2026-05-10",
          time: "09:00",
          interval: 3,
        }),
      ).rejects.toThrow();
    });
  });

  describe("a reminder that repeats", () => {
    it("advances one occurrence at a time", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Water bill", {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-05-01",
        time: "07:30",
      });
      expect(created.notification).toMatchObject({
        repeats: true,
        nextNotificationDate: "2026-05-01",
      });

      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toContain("repeats");
      expect(await reminderRow(created.id)).toMatchObject({
        lastNotifiedDate: "2026-05-01",
        nextNotificationDate: "2026-06-01",
      });

      // Same day again: nothing more is owed until the next occurrence.
      sent.length = 0;
      expect(await runDueNotifications()).toMatchObject({ sent: 0 });

      at("2026-06-01T07:30:00Z");
      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
      expect(await reminderRow(created.id)).toMatchObject({
        lastNotifiedDate: "2026-06-01",
        nextNotificationDate: "2026-07-01",
      });
    });

    /**
     * Coming back from downtime must not mean one message per missed occurrence.
     * Somebody wants to know they were meant to do this, not to read a week of
     * copies of it.
     */
    it("collapses a backlog into one message", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Daily nudge", {
        frequency: "daily",
        interval: 1,
        anchorDate: "2026-05-01",
        time: "07:00",
      });

      at("2026-05-08T08:00:00Z");
      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(1);
      // The most recent one it owed, not the oldest.
      expect(sent[0]!.body).toContain("2026-05-08");
      expect(await reminderRow(created.id)).toMatchObject({
        lastNotifiedDate: "2026-05-08",
        nextNotificationDate: "2026-05-09",
      });
    });

    it("moves a weekend occurrence the way its policy says", async () => {
      // 2026-05-02 is a Saturday.
      at("2026-05-01T08:00:00Z");
      const created = await template("Weekly review", {
        frequency: "weekly",
        interval: 1,
        anchorDate: "2026-05-02",
        weekendPolicy: "next_business_day",
        time: "07:00",
      });

      expect(await reminderRow(created.id)).toMatchObject({
        nextNotificationDate: "2026-05-04",
      });
      // Saturday itself owes nothing, because the mail goes on the Monday.
      at("2026-05-02T08:00:00Z");
      expect(await runDueNotifications()).toMatchObject({ sent: 0 });
      at("2026-05-04T07:00:00Z");
      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
    });
  });

  /**
   * Two schedulers read the same due list, so the row has to be CLAIMED rather
   * than merely read — otherwise both sweeps decide the same reminder is owed and
   * the person gets it twice. This went uncaught once: the lock was removed by
   * accident and every other test still passed.
   *
   * Held from another transaction rather than by racing two sweeps, because two
   * sweeps in one process do not reliably overlap inside the window that matters:
   * whichever gets there second finds the watermark already moved and correctly
   * has nothing to do, whether a lock was taken or not. A row somebody else is
   * holding is the same situation seen from the outside, and it is deterministic.
   *
   * A sweep that reads the row without claiming it does not fail an assertion
   * here — it blocks on this lock when it tries to move the watermark, so the
   * regression shows up as this test timing out and taking the rest of the file
   * with it. Loud either way, which is the point.
   */
  it("passes over a reminder another sweep is holding", { timeout: 8_000 }, async () => {
    at("2026-05-10T09:00:00Z");
    const created = await template("Contended", {
      anchorDate: "2026-05-10",
      time: "08:00",
    });

    await getDb().transaction(async (tx) => {
      await tx
        .select()
        .from(templateNotifications)
        .where(eq(templateNotifications.templateId, created.id))
        .for("update");

      // Skipped, not waited for and not sent twice.
      expect(await runDueNotifications()).toMatchObject({ examined: 1, sent: 0 });
      expect(sent).toHaveLength(0);
    });

    // Released, so the next sweep picks it up exactly once.
    expect(await runDueNotifications()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  /**
   * The reminder watermark records what has been sent and nothing else, so a
   * sweep with nowhere to send must not move it. The form tells people a reminder
   * is saved and waits for a mail server; this is that promise.
   */
  it("leaves the schedule alone when the deployment cannot send mail", async () => {
    at("2026-05-10T09:00:00Z");
    const created = await template("Waiting on SMTP", {
      anchorDate: "2026-05-10",
      time: "08:00",
    });

    const mail = await import("../../src/server/mail.js");
    const enabled = vi.spyOn(mail, "mailEnabled").mockReturnValue(false);
    try {
      expect(await runDueNotifications()).toMatchObject({ examined: 0, sent: 0 });
      expect(sent).toHaveLength(0);
      expect(await reminderRow(created.id)).toMatchObject({
        lastNotifiedDate: null,
        nextNotificationDate: "2026-05-10",
      });
    } finally {
      enabled.mockRestore();
    }

    // Still owed once there is somewhere to send it.
    expect(await runDueNotifications()).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  describe("whose clock it runs on", () => {
    it("uses the person's timezone rather than the server's", async () => {
      await setPreferences(actor, { timezone: "Asia/Tokyo" });
      try {
        // 23:00 UTC is already the next morning in Tokyo, so a reminder set for
        // the 11th at 08:00 is owed even though UTC is still on the 10th.
        at("2026-05-10T23:00:00Z");
        await template("Tokyo morning", {
          anchorDate: "2026-05-11",
          time: "08:00",
        });

        expect(await runDueNotifications()).toMatchObject({ sent: 1 });
        expect(sent).toHaveLength(1);
      } finally {
        await setPreferences(actor, { timezone: "UTC" });
      }
    });
  });

  describe("the reminder's life alongside its template", () => {
    it("is replaced whole when the template is saved with a new one", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Rates", {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-05-01",
        time: "09:00",
      });

      const updated = await updateTransactionTemplate(actor, created.id, {
        notification: { anchorDate: "2026-06-15", time: "18:45" },
        expectedVersion: created.version,
      });

      expect(updated.notification).toMatchObject({
        repeats: false,
        frequency: null,
        anchorDate: "2026-06-15",
        time: "18:45",
        nextNotificationDate: "2026-06-15",
      });
      expect(await getDb().select().from(templateNotifications)).toHaveLength(1);
    });

    /**
     * The row is replaced whole on every save, so without carrying the watermark
     * a reminder already sent is owed again the moment somebody edits the payee.
     */
    it("does not re-send what has gone when the template is saved again", async () => {
      at("2026-05-01T09:00:00Z");
      const created = await template("Rent notice", {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-05-01",
        time: "08:00",
      });
      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
      sent.length = 0;

      // The same reminder, sent back unchanged alongside an edit to the draft.
      const saved = await updateTransactionTemplate(actor, created.id, {
        draft: { type: "withdrawal", payee: "New landlord", amount: "1300" },
        notification: {
          frequency: "monthly",
          interval: 1,
          anchorDate: "2026-05-01",
          time: "08:00",
        },
        expectedVersion: created.version,
      });

      expect(saved.notification).toMatchObject({
        lastNotifiedDate: "2026-05-01",
        nextNotificationDate: "2026-06-01",
      });
      expect(await runDueNotifications()).toMatchObject({ sent: 0 });
      expect(sent).toHaveLength(0);
    });

    it("starts afresh when the schedule itself changes", async () => {
      at("2026-05-01T09:00:00Z");
      const created = await template("Moved", {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-05-01",
        time: "08:00",
      });
      await runDueNotifications();
      sent.length = 0;

      const moved = await updateTransactionTemplate(actor, created.id, {
        notification: {
          frequency: "monthly",
          interval: 1,
          anchorDate: "2026-05-01",
          // The one thing that changed, and enough to mean a different schedule.
          time: "21:00",
        },
        expectedVersion: created.version,
      });

      expect(moved.notification).toMatchObject({
        lastNotifiedDate: null,
        nextNotificationDate: "2026-05-01",
      });
      // Owed again, but at the new hour rather than the old one.
      expect(await runDueNotifications()).toMatchObject({ sent: 0 });
      at("2026-05-01T21:00:00Z");
      expect(await runDueNotifications()).toMatchObject({ sent: 1 });
    });

    it("is kept by an update that says nothing about it", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Insurance", {
        anchorDate: "2026-05-20",
        time: "09:00",
      });

      const renamed = await updateTransactionTemplate(actor, created.id, {
        name: "Insurance renewal",
        expectedVersion: created.version,
      });

      expect(renamed.name).toBe("Insurance renewal");
      expect(renamed.notification).toMatchObject({ anchorDate: "2026-05-20" });
    });

    it("is removed by saving null", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Gym", {
        anchorDate: "2026-05-20",
        time: "09:00",
      });

      const cleared = await updateTransactionTemplate(actor, created.id, {
        notification: null,
        expectedVersion: created.version,
      });

      expect(cleared.notification).toBeNull();
      expect(await reminderRow(created.id)).toBeNull();
    });

    it("goes when the template goes", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Passing", {
        anchorDate: "2026-05-20",
        time: "09:00",
      });

      await deleteTransactionTemplate(actor, created.id, created.version);

      expect(await getDb().select().from(templateNotifications)).toHaveLength(0);
    });

    it("comes back with the template it belongs to", async () => {
      at("2026-05-01T08:00:00Z");
      const created = await template("Readable", {
        frequency: "yearly",
        interval: 1,
        anchorDate: "2026-05-20",
        time: "09:15",
      });

      const read = await getTransactionTemplate(actor, created.id);
      expect(read.notification).toMatchObject({
        frequency: "yearly",
        repeats: true,
        time: "09:15",
      });
    });
  });

  /**
   * The audit log is append-only, so a snapshot that records the wrong thing
   * cannot be corrected later — it can only be contradicted. `templateView`
   * defaults the reminder to null, which in a record does not read as "nobody
   * asked about it" but as "this template had no reminder", and every path that
   * did not pass one was writing that about templates that did.
   */
  describe("what the audit log records about a reminder", () => {
    const selection = (id: string, version: number) => ({
      items: [{ id, expectedVersion: version }],
    });

    it("keeps it on both sides of a bulk edit that did not touch it", async () => {
      at("2026-06-01T08:00:00Z");
      const created = await template("Bulk edited", {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-06-20",
        time: "07:30",
      });

      await bulkEditTransactionTemplates(actor, {
        selection: selection(created.id, created.version),
        patch: { payee: "Someone else" },
        idempotencyKey: "audit-bulk-edit",
      });

      const [, edit] = await auditFor(created.id);
      expect(edit!.operation).toBe("bulk_edit");
      expect(edit!.before).toMatchObject({ notification: { time: "07:30" } });
      expect(edit!.after).toMatchObject({ notification: { time: "07:30" } });
    });

    it("records the one a bulk delete took away with it", async () => {
      at("2026-06-01T08:00:00Z");
      const created = await template("Bulk deleted", {
        anchorDate: "2026-06-20",
        time: "07:45",
      });

      await bulkDeleteTransactionTemplates(actor, {
        selection: selection(created.id, created.version),
        idempotencyKey: "audit-bulk-delete",
      });

      const [, removal] = await auditFor(created.id);
      expect(removal!.operation).toBe("bulk_delete");
      expect(removal!.before).toMatchObject({ notification: { time: "07:45" } });
      expect(removal!.after).toBeNull();
    });

    it("records the one a delete took away with it", async () => {
      at("2026-06-01T08:00:00Z");
      const created = await template("Deleted", {
        anchorDate: "2026-06-20",
        time: "07:15",
      });

      await deleteTransactionTemplate(actor, created.id, created.version);

      const [, removal] = await auditFor(created.id);
      expect(removal!.operation).toBe("delete");
      expect(removal!.before).toMatchObject({ notification: { time: "07:15" } });
    });

    it("still says null when there really was no reminder", async () => {
      at("2026-06-01T08:00:00Z");
      const created = await createTransactionTemplate(actor, {
        name: "No reminder",
        draft: { type: "withdrawal", payee: "Landlord", amount: "1200" },
      });

      await deleteTransactionTemplate(actor, created.id, created.version);

      const [, removal] = await auditFor(created.id);
      expect(removal!.before).toMatchObject({ notification: null });
    });
  });

  describe("tenants", () => {
    it("writes to the person whose reminder it is", async () => {
      at("2026-05-10T09:00:00Z");
      await template("Mine", { anchorDate: "2026-05-10", time: "08:00" }, actor);
      await template("Theirs", { anchorDate: "2026-05-10", time: "08:00" }, other);

      expect(await runDueNotifications()).toMatchObject({ examined: 2, sent: 2 });
      expect(sent.map((message) => `${message.to} ${message.subject}`).sort()).toEqual([
        "notify@example.com Reminder: Mine",
        "other@example.com Reminder: Theirs",
      ]);
    });
  });
});
