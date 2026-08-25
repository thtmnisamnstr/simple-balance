import { describe, expect, it } from "vitest";
import { recurrenceProposedMessage, templateReminderMessage } from "../src/server/mail.js";

/**
 * A subject is read in a list, not in a window.
 *
 * A mail client shows the first few dozen characters of it, so whatever comes
 * first is the whole message for most of the people who get one. A recurrence
 * or template name may be 120 characters, which is roughly twice that, so a
 * subject that opens with the name is a subject whose meaning is what got
 * truncated.
 */
const base = "https://ledger.example.com";

describe("what a scheduled message calls itself", () => {
  it("leads with the fixed part", () => {
    expect(recurrenceProposedMessage("Rent", ["2026-01-01"], base).subject).toBe(
      "Staged: 1 row from Rent",
    );
    expect(
      recurrenceProposedMessage("Rent", ["2026-01-01", "2026-02-01", "2026-03-01"], base).subject,
    ).toBe("Staged: 3 rows from Rent");
    expect(templateReminderMessage("Rent", "2026-01-01", base, true).subject).toBe(
      "Reminder: Rent",
    );
  });

  it("cuts a name a subject cannot show", () => {
    // The schema maximum, so this is the longest name that can reach a subject.
    const name = "N".repeat(120);
    const { subject } = templateReminderMessage(name, "2026-01-01", base, false);
    const shown = subject.slice("Reminder: ".length);

    expect(Array.from(shown)).toHaveLength(60);
    expect(shown.endsWith("…")).toBe(true);
    expect(subject).not.toContain("N".repeat(60));
  });

  it("leaves a name it can show whole", () => {
    const name = "N".repeat(60);
    expect(templateReminderMessage(name, "2026-01-01", base, false).subject).toBe(
      `Reminder: ${name}`,
    );
  });

  it("does not cut a character in half", () => {
    // Every one of these is a surrogate pair, so a cut counted in UTF-16 units
    // would land inside one and the subject would end in a replacement
    // character rather than in an ellipsis.
    const name = "🧾".repeat(70);
    const { subject } = recurrenceProposedMessage(name, ["2026-01-01"], base);

    expect(subject).toContain(`${"🧾".repeat(59)}…`);
    expect(subject.replaceAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")).not.toMatch(
      /[\uD800-\uDFFF]/u,
    );
  });
});
