import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `errors.md` 4.1: a check constraint has a Zod twin, and the twin names the
 * field.
 *
 * Binding. What the database would refuse, the schema refuses first, as a 422
 * naming the field — because the constraint's own refusal arrives as a 500 with
 * a stack trace for what is only ever a mistyped value. It has been broken
 * twice in ways the guide records: the budget percent rules validated the floor
 * while the constraint capped both ends, so a mistyped `10000` passed Zod and
 * died on the check; and the control-character refinements existed for most
 * text fields while a NUL in a bulk patch travelled all the way to a jsonb
 * write PostgreSQL refuses.
 *
 * The guide marks it `human` and says precisely how much of it a program can
 * do: "a program can enumerate the check constraints in `src/server/db/schema.
 * ts` but cannot prove a refinement is the same predicate". So that is the
 * split here. The enumeration is mechanical and the pairing is a register — the
 * half a program can refuse is a constraint nobody has paired with anything,
 * which is what a new constraint added without a twin looks like.
 *
 * What the register cannot do, and does not pretend to: say that
 * `budgetPlanCreateSchema` really caps the percentage at the same two numbers
 * the constraint does. That stays the `why` column and a reader.
 */

/**
 * A constraint with no twin is a real answer, not a gap, when nothing a caller
 * sends reaches the column. Each of these says which of those it is.
 */
type Twin =
  /** The shared symbol carrying the refusal, and what the pairing rests on. */
  | { readonly zod: string; readonly why: string }
  /** No request can set these columns, so there is nothing to refuse earlier. */
  | { readonly serverWritten: string };

const SERVER_ASSIGNED_VERSION =
  "The column is the row's own version, assigned 1 on insert and bumped by the service. `expectedVersionSchema` is the nearest thing to a twin and refuses a caller's number below 1 — which is the whole of what a request can put anywhere near this column.";

const TWINS: Readonly<Record<string, Twin>> = {
  // Currencies. One regex, one schema, four tables.
  user_preferences_default_currency_check: {
    zod: "currencyCodeSchema",
    why: "The same `^[A-Z]{2,12}$`, which is deliberately wider than ISO 4217 so a crypto asset fits.",
  },
  ledger_account_currency_check: {
    zod: "currencyCodeSchema",
    why: "An account's currency is chosen once, on the create form, and never changes.",
  },
  budget_plan_currency_check: {
    zod: "currencyCodeSchema",
    why: "A budget is in one currency, named on the plan.",
  },
  budget_entry_currency_check: {
    zod: "currencyCodeSchema",
    why: "The override's own currency, same schema as the plan's.",
  },
  posting_currency_check: {
    serverWritten:
      "A posting's currency is taken from the account it is against. No request names it, and nothing but the ledger services writes a posting at all.",
  },

  // Versions.
  ledger_account_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  category_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  category_group_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  ledger_transaction_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  staged_transaction_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  transaction_template_version_check: {
    zod: "expectedVersionSchema",
    why: SERVER_ASSIGNED_VERSION,
  },
  recurrence_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  budget_plan_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },
  budget_entry_version_check: { zod: "expectedVersionSchema", why: SERVER_ASSIGNED_VERSION },

  // A transaction and its legs.
  ledger_transaction_payee_check: {
    zod: "transactionDraftSchema",
    why: "`oneLine` over a trimmed 1-to-160 string, matching `char_length(trim(payee)) between 1 and 160`. `oneLine` is the half the NUL defect was about: the length was checked and the control characters were not.",
  },
  ledger_transaction_description_check: {
    zod: "transactionDraftSchema",
    why: "`freeText` capped at 240, nullable on both sides.",
  },
  ledger_transaction_shape_check: {
    zod: "transactionDraftSchema",
    why: "The discriminated union is the twin: a deposit carries only the destination side, a withdrawal only the source, a transfer both. The constraint spells the same three cases in SQL.",
  },
  ledger_transaction_split_check: {
    zod: "transactionDraftSchema",
    why: "Two to `MAX_TRANSACTION_LEGS` legs, no category on the parent, never a transfer — and the constraint reads `MAX_TRANSACTION_LEGS` out of the same constant rather than repeating the number.",
  },
  transaction_leg_amount_check: {
    zod: "transactionDraftSchema",
    why: "A leg's amount is non-negative rather than positive, because a leg is zeroed rather than deleted.",
  },
  transaction_leg_note_check: {
    zod: "transactionDraftSchema",
    why: "`freeText` capped at 240, the same cap the entry's own description has.",
  },
  transaction_leg_ordinal_check: {
    serverWritten:
      "The ordinal is the leg's position in the array the request sent, numbered by the service. A caller sends an order, never an index.",
  },

  // Postings, which no request ever reaches.
  posting_leg_origin_check: {
    serverWritten:
      "A posting naming a leg must name that leg's transaction. Both columns are written by the ledger services from a draft that has already been validated.",
  },
  posting_origin_check: {
    serverWritten:
      "Exactly one of three origins: a transaction, an account opening, an account closing. Nothing outside the services constructs a posting.",
  },
  posting_amount_check: {
    serverWritten:
      "A posting of zero moves nothing and is never written: an edit that changes nothing about the movement writes nothing at all. The amount is computed, never sent.",
  },

  // The staged queue's own state.
  staged_transaction_recurrence_check: {
    serverWritten:
      "A row proposed by a recurrence carries both the recurrence and the occurrence date; one written any other way carries neither. Both are provenance the sweep writes, and no create schema offers either.",
  },
  staged_transaction_recurrence_import_check: {
    serverWritten:
      "A proposal has no import batch, because it came from a schedule rather than a file. Both columns are provenance.",
  },
  staged_transaction_status_check: {
    serverWritten:
      "`status` and its two companion columns are the queue's state machine — staged, deleted, committed — moved only by the staging service. A request asks for a transition, never for a status.",
  },

  // Templates and their reminders.
  transaction_template_name_check: {
    zod: "transactionTemplateCreateSchema",
    why: "A trimmed 1-to-120 name, which is also what makes a second submit fail on the unique index rather than duplicating.",
  },
  template_notification_interval_check: {
    zod: "templateNotificationSchema",
    why: "1 to `MAX_RECURRENCE_INTERVAL`, and the constraint reads that constant rather than repeating 366.",
  },
  template_notification_notify_at_check: {
    zod: "clockTimeSchema",
    why: "`HH:MM` on a 24-hour clock, the same regex on both sides. Nothing finer than a minute, because a reminder is read when somebody next looks at their mail.",
  },
  template_notification_position_check: {
    zod: "templateNotificationSchema",
    why: '"The second Tuesday" needs both halves or neither, which the schema states as a pair.',
  },
  template_notification_position_frequency_check: {
    zod: "templateNotificationSchema",
    why: "An ordinal weekday only means something monthly or yearly.",
  },
  template_notification_once_check: {
    zod: "templateNotificationSchema",
    why: "A one-off reminder repeats on no interval and sits on no ordinal weekday.",
  },

  // Recurrences.
  recurrence_name_check: {
    zod: "recurrenceCreateSchema",
    why: "A trimmed 1-to-120 name, the same shape a template's has.",
  },
  recurrence_interval_check: {
    zod: "recurrenceScheduleSchema",
    why: "1 to `MAX_RECURRENCE_INTERVAL`, from the shared constant on both sides.",
  },
  recurrence_position_check: {
    zod: "recurrenceScheduleSchema",
    why: "The ordinal pair again, plus the ranges: first through fourth or last, and a weekday 0 to 6.",
  },
  recurrence_cursor_floor_check: {
    serverWritten:
      "The next occurrence never falls before the date the recurrence proposes from. Both columns are the sweep's cursor.",
  },
  recurrence_cursor_watermark_check: {
    serverWritten:
      "The watermark only ever moves forward, which is the rule that stops a recurrence proposing the same occurrence twice. Written by the sweep alone.",
  },

  // Budgets.
  budget_plan_target_check: {
    zod: "budgetPlanCreateSchema",
    why: "A budget is about a category or a group and never both, which the schema states as the same exclusive-or.",
  },
  budget_plan_amount_check: {
    zod: "budgetPlanCreateSchema",
    why: "Non-negative: zero budgets nothing, and the refusal says so rather than describing a constraint.",
  },
  budget_plan_window_check: {
    zod: "budgetPlanCreateSchema",
    why: "A window that ends before it starts covers no period at all.",
  },
  budget_plan_rollover_cap_check: {
    zod: "budgetPlanCreateSchema",
    why: "A cap is non-negative and applies in both directions, which is what its own message says.",
  },
  budget_plan_target_amount_check: {
    zod: "budgetPlanCreateSchema",
    why: "A savings target of zero is not a target.",
  },
  budget_plan_target_pair_check: {
    zod: "budgetPlanCreateSchema",
    why: "An amount and a date, or neither. `0019` added the constraint and the schema pairs them in the same shape.",
  },
  budget_plan_rule_check: {
    zod: "budgetPlanCreateSchema",
    why: "`amount_rule` is derived from the row rather than asked for, so the twin is the schema's own rule that a plan carries one rule's parameter and no other.",
  },
  budget_plan_sinking_rollover_check: {
    zod: "budgetPlanCreateSchema",
    why: "Turning rollover off on a fund is refused rather than silently emptying it, which is the schema's refusal in the same words.",
  },
  budget_plan_lookback_check: {
    zod: "budgetPlanCreateSchema",
    why: "A trailing average has a lookback and nothing else does, which `oneRuleAtMost` states from the other direction.",
  },
  budget_plan_percent_check: {
    zod: "budgetPlanCreateSchema",
    why: "The two percentage rules carry a percentage and no other rule does.",
  },
  budget_plan_lookback_range_check: {
    zod: "budgetPlanCreateSchema",
    why: "One to twenty-four periods, which is the range the trailing average reads back over.",
  },
  budget_plan_percent_range_check: {
    zod: "budgetPlanCreateSchema",
    why: "The pair the guide names as the defect: a share of income is 0 to 1000, a step is -100 to 1000, and the schema now caps BOTH ends of both. Capping the floor alone is what let a mistyped 10000 die on the constraint.",
  },
  budget_entry_target_check: {
    zod: "budgetEntrySetSchema",
    why: "A category or a group, the same exclusive-or as the plan's.",
  },
  budget_entry_amount_check: {
    zod: "budgetEntrySetSchema",
    why: "Non-negative, the same floor the plan's amount has.",
  },

  // Hashes the server computes.
  idempotency_record_request_hash_check: {
    serverWritten:
      "A SHA-256 of the request, computed here. The caller sends a key and never a hash.",
  },
  billing_operation_request_hash_check: {
    serverWritten:
      "The same hash over a billing request, computed the same way and never sent by anybody.",
  },

  // Counters.
  import_batch_row_count_check: {
    serverWritten:
      "How many rows the file staged, counted after staging them rather than taken from the request.",
  },
};

const schema = sourceFiles("src/server/db").find((file) => file.path.endsWith("/schema.ts"))!;
const shared = sourceFiles("src/shared");

describe("every check constraint", () => {
  const constraints = [...schema.code.matchAll(/check\(\s*"([a-z_0-9]+)"/g)].map(
    (match) => match[1]!,
  );

  it("is paired with something, in both directions", () => {
    // A schema this could no longer read would report no constraints and pair
    // all of them perfectly.
    expect(constraints.length, "the schema parsed").toBeGreaterThan(40);
    expect(new Set(constraints).size, "constraint names are unique").toBe(constraints.length);

    expect(
      constraints.filter((name) => !(name in TWINS)).sort(),
      "a new constraint needs a twin, or the argument for having none",
    ).toEqual([]);
    expect(
      Object.keys(TWINS)
        .filter((name) => !constraints.includes(name))
        .sort(),
      "a pairing outlived its constraint",
    ).toEqual([]);
  });

  it("names a twin that exists, or argues at length for having none", () => {
    const missing: string[] = [];
    for (const [name, twin] of Object.entries(TWINS)) {
      if ("serverWritten" in twin) {
        // Length rather than presence, because the whole value of this register
        // is that an entry costs an argument. A one-word reason is how a
        // register stops meaning anything.
        if (twin.serverWritten.length < 60) missing.push(`${name}: the reason is too thin`);
        continue;
      }
      if (twin.why.length < 40) missing.push(`${name}: the reason is too thin`);
      // The symbol, not just the string: a schema given another name leaves the
      // pairing pointing at nothing, and a register that can point at nothing
      // is prose.
      const declared = shared.some((file) =>
        new RegExp(`\\b(?:const|function) ${twin.zod}\\b`).test(file.code),
      );
      if (!declared) missing.push(`${name}: src/shared declares no ${twin.zod}`);
    }
    expect(missing, "every pairing points at a schema that is there").toEqual([]);
  });
});
