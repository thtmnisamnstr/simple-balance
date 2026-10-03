import { describe, expect, it } from "vitest";
import {
  recurrenceCreateSchema,
  recurrenceUpdateSchema,
  transactionTemplateCreateSchema,
  transactionTemplateUpdateSchema,
} from "../src/shared/domain.js";

/**
 * The header-injection defense, checked where it is rather than where it works.
 *
 * `operations.md` §A subject is one line calls this Binding and "already met by
 * accident of the schema": a recurrence or template name reaches
 * `recurrenceProposedMessage` and `templateReminderMessage` unescaped and lands
 * in a `Subject:` header, so a name carrying CR LF would end the header and
 * start writing its own — a `Bcc:`, a second `Subject:`, a body. Nothing in
 * `src/server/mail.ts` strips it. What closes the hole is `oneLine`
 * (`src/shared/domain.ts:326-330`), four hundred lines and one module away from
 * the mailer, refusing every character from U+0000 to U+001F and U+007F before
 * a name is ever stored.
 *
 * That distance is the whole reason this file exists. The guide says the
 * defense "is nowhere near the code it defends", and a property held at that
 * range is one a later edit relaxes — widening a name to accept a line break
 * for some unrelated field, say — with nothing anywhere going red. The subject
 * tests pin the shape of the subject and the cut; none of them pins what a name
 * may contain.
 *
 * Both halves of each pair, because the update schemas spell the name out again
 * rather than deriving it from the create schema, so a relaxation could land on
 * one and not the other.
 */

/**
 * CR LF is the injection proper. The bare CR and bare LF are here because
 * several mail transports normalize a lone one into the pair, so refusing only
 * the pair would be refusing the spelling rather than the attack. The tab is
 * the continuation character: a header line beginning with one folds onto the
 * previous header, which is how an injected line hides from a naive reader.
 */
const breaks = [
  ["CR LF", "Rent\r\nBcc: attacker@example.com"],
  ["bare LF", "Rent\nBcc: attacker@example.com"],
  ["bare CR", "Rent\rSubject: something else"],
  ["tab", "Rent\tfolded"],
  ["NUL", "Rent\u0000"],
  ["DEL", "Rent\u007F"],
] as const;

const shape = {
  type: "withdrawal",
  payee: "Landlord",
  fromAccountId: "11111111-1111-4111-8111-111111111111",
} as const;

const schedule = { frequency: "monthly", anchorDate: "2026-01-01" } as const;

describe("a name that reaches a mail subject cannot carry a line break", () => {
  for (const [spelling, name] of breaks) {
    it(`refuses a recurrence named with a ${spelling}`, () => {
      expect(
        recurrenceCreateSchema.safeParse({ name, shape, schedule, notifyOnCreate: true }).success,
      ).toBe(false);
      expect(recurrenceUpdateSchema.safeParse({ name, expectedVersion: 1 }).success).toBe(false);
    });

    it(`refuses a template named with a ${spelling}`, () => {
      expect(
        transactionTemplateCreateSchema.safeParse({ name, draft: { payee: "Landlord" } }).success,
      ).toBe(false);
      expect(transactionTemplateUpdateSchema.safeParse({ name, expectedVersion: 1 }).success).toBe(
        false,
      );
    });
  }

  /**
   * The counterpart, so the check above is refusing line breaks rather than
   * refusing everything. A name with punctuation, an accent and an emoji in it
   * is somebody's own text and goes through.
   */
  it("takes an ordinary name", () => {
    const name = "Café rent — flat 2 🏠";
    expect(
      recurrenceCreateSchema.safeParse({ name, shape, schedule, notifyOnCreate: true }).success,
    ).toBe(true);
    expect(
      transactionTemplateCreateSchema.safeParse({ name, draft: { payee: "Landlord" } }).success,
    ).toBe(true);
  });
});
