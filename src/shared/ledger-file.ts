/**
 * The Simple Balance file: one versioned JSON document holding everything a
 * person authored, so a whole ledger, or some of its accounts, can move between
 * a copy somebody hosts and the service, in either direction.
 *
 * It is called the ledger file in code and a Simple Balance file on screen, and
 * never an archive: archiving is what this product does to an account it
 * retires, and `tests/http-route-table.test.ts` refuses a path ending in
 * `/archive` for that reason.
 *
 * Shared, because the browser reads a file before it sends any of it — parses
 * it, checks every reference, counts what it holds and cuts it into parts — and
 * the server reads it again before writing. A rule the preview applies and the
 * server enforces has to be one function, or the page shows a file as fine that
 * the server then refuses.
 *
 * **The format token is a published contract.** Every later release reads every
 * token ever published, and a field added under this one is added as optional,
 * because somebody's file written today has to import into a copy upgraded in
 * three years. That is why the format already carries what only moving a whole
 * ledger needs — the deleted flag, archive instants and the balance checks —
 * although the release that introduced it only exports a file and adds one to
 * a ledger, and moving a ledger whole comes later.
 *
 * What it carries is what the person wrote and nothing a service derives:
 * postings, counter-accounts, rates, versions and timestamps stay behind, and
 * the copy a file lands in posts and stamps its own. A destination that copied
 * derived rows would be trusting another ledger's arithmetic; one that
 * recomputes them proves the file instead.
 */
import { z } from "zod";
import {
  accountCreateSchema,
  atMost,
  budgetEntrySetSchema,
  budgetPlanCreateSchema,
  categoryCreateSchema,
  categoryGroupCreateSchema,
  counterKinds,
  currencyCodeSchema,
  decimalStringSchema,
  isoDateSchema,
  MAX_BULK_SELECTION_ENTRIES,
  MAX_TRANSACTION_LEGS,
  oneLine,
  preferencesSchema,
  recurrenceCreateSchema,
  recurrenceLegSchema,
  recurrenceScheduleSchema,
  recurrenceShapeSchema,
  stageCreateSchema,
  stagedDraftSchema,
  templateNotificationSchema,
  transactionDraftSchema,
  transactionLegSchema,
  transactionTemplateCreateSchema,
  transactionTemplateDraftSchema,
  transactionTemplateLegSchema,
  userAccountTypes,
  uuid,
  type ValidationIssue,
} from "./domain.js";
import { normalizeHumanName } from "./names.js";
import { APP_VERSION } from "./version.js";

export const LEDGER_FILE_FORMAT = "simple-balance-ledger-1";

/** What a ledger file is served as. JSON is UTF-8 by definition; the charset is for whoever opens it. */
export const LEDGER_FILE_MEDIA_TYPE = "application/json; charset=utf-8";

/**
 * The most one part of a file may weigh when it is sent to be imported.
 *
 * Well under the roughly sixty mebibytes the CSV stage route and both bundled
 * proxies already carry, so a part fits through every terminator this
 * repository ships without one of them changing. Ten thousand typical entries
 * come to a few mebibytes, so on an ordinary ledger the row cap is what cuts a
 * part and this is the guard against a few enormous notes or staged rows.
 */
export const LEDGER_FILE_PART_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The most accounts one "Some accounts" export may name.
 *
 * The export is a `GET`, so the chosen ids travel in the query string, and the
 * nginx in front of the decomposed profile reads a request line into an 8 KiB
 * buffer by default. A UUID costs 39 bytes there once its comma is encoded, so
 * two hundred would just fit and leave nothing for a proxy that prefixes the
 * path. Half that is still far past what anybody picks by hand, and somebody
 * who wants more than this wants everything, which needs no ids at all.
 */
export const MAX_LEDGER_FILE_ACCOUNT_CHOICES = 100;

/**
 * The kinds of record a file can carry, which are the checkboxes the export
 * offers and the words `scope.kinds` records.
 *
 * `categories` brings the category groups with it, because a group exists to
 * hold categories. `deletedEntries` is a narrowing of `entries` rather than a
 * kind of its own record: a deleted entry is an entry voided by its reversal,
 * so it travels with the entries or not at all. `history` is the activity log,
 * offered so it can be kept and never read back, because no service can write
 * a past audit event and a file that could would let anybody forge one.
 */
export const ledgerFileKinds = [
  "preferences",
  "categories",
  "accounts",
  "entries",
  "deletedEntries",
  "templates",
  "recurrences",
  "budgets",
  "staged",
  "history",
] as const;
export type LedgerFileKind = (typeof ledgerFileKinds)[number];

/**
 * What the Export section ticks before anybody touches it: everything but the
 * activity history, which cannot be imported and is often larger than the
 * ledger it describes.
 */
export const defaultLedgerFileKinds: readonly LedgerFileKind[] = ledgerFileKinds.filter(
  (kind) => kind !== "history",
);

/**
 * The only kinds a "Some accounts" export may carry. Templates, recurring
 * transactions, budgets, staged rows, settings and history belong to the
 * ledger rather than to any account, so they travel with "Everything".
 */
const CHOSEN_ACCOUNT_KINDS: ReadonlySet<LedgerFileKind> = new Set<LedgerFileKind>([
  "accounts",
  "categories",
  "entries",
  "deletedEntries",
]);

/**
 * Whether a record travels whole or only so something else can name it.
 *
 * A reference is what keeps unchecking a kind from breaking the file: leave
 * accounts out and every entry still names both of its sides, each side
 * carrying the name, type and currency an import needs to find the account
 * that is already there, or to ask what to do about one that is not.
 */
export const ledgerRecordDetails = ["full", "reference"] as const;
export type LedgerRecordDetail = (typeof ledgerRecordDetails)[number];

/** Whether a file holds every account or the ones somebody chose. */
const ledgerFileAccountScopes = ["all", "chosen"] as const;
export type LedgerFileAccountScope = (typeof ledgerFileAccountScopes)[number];

/**
 * The sentence for a JSON number where money goes.
 *
 * Refused, never coerced. `JSON.parse` has already turned the digits into a
 * binary float by the time anything here sees them, so "0.1" written as a
 * number is already not 0.1, and a ledger that accepted it would be rounding
 * money on the way in and calling the result a faithful copy.
 */
const AMOUNT_IS_A_NUMBER =
  'A Simple Balance file writes every amount as a decimal string, such as "12.50". This one is a JSON number, which cannot hold money exactly, so the file is refused rather than rounded.';

/**
 * An amount position: the app's own decimal schema, behind a refusal of a JSON
 * number that names the rule rather than Zod's "expected string".
 *
 * A pipe rather than a refinement on the inner schema, so the schemas reused
 * here stay the exact ones the API validates with, and so a number stops at
 * this sentence instead of collecting a second complaint about its digits.
 *
 * An optional amount says `.optional()` outside the pipe, never only inside
 * it. Zod 4 reads whether a key may be absent off the input side, and the
 * input side here is `unknown`, which it treats as a key that must be there:
 * an inner `.optional()` alone made every template without an amount "missing"
 * one.
 */
const exactAmount = <T extends z.ZodType>(schema: T) =>
  z
    .unknown()
    .refine((value) => typeof value !== "number", { message: AMOUNT_IS_A_NUMBER, abort: true })
    .pipe(schema);

const SPLIT_TOO_LONG = { error: () => `A split has at most ${MAX_TRANSACTION_LEGS} legs` };

/**
 * How one record names another inside the file.
 *
 * A key rather than a uuid, because a uuid means one row in one deployment and
 * nothing anywhere else. The key is the record's name, so a file reads the way
 * the ledger does — `"from":"Checking"` — except where an older ledger holds
 * two names that fold together, which today's rules refuse and yesterday's
 * did not: the second is given a suffix by `assignLedgerKeys`, and its `name`
 * is left as it was. A key is also what an import's rename leaves alone, so
 * renaming an account on the way in touches no reference to it.
 */
const keySchema = oneLine(
  z
    .string()
    .trim()
    .min(1, { error: () => "A key cannot be blank" })
    .max(160, atMost("A key", 160)),
);

/** An instant, RFC 3339 with its offset, which is what `common.md` makes every instant. */
const instantSchema = z.iso.datetime({
  offset: true,
  error: () => "Use an RFC 3339 instant, such as 2026-10-25T17:04:11.512Z",
});

const groupSchema = z
  .object({
    key: keySchema,
    name: categoryGroupCreateSchema.shape.name,
    detail: z.enum(ledgerRecordDetails),
    policy: categoryGroupCreateSchema.shape.policy,
  })
  .strict();

/**
 * A category, whole or as a reference. Both carry the kind, because the kind
 * is what decides whether an entry filed under it is income or a refund, and a
 * reference created on arrival with a guessed kind is the defect the CSV
 * import's per-file vote already has.
 */
const categorySchema = z.discriminatedUnion("detail", [
  z
    .object({
      key: keySchema,
      name: categoryCreateSchema.shape.name,
      detail: z.literal("full"),
      kind: categoryCreateSchema.shape.kind,
      group: keySchema.nullable(),
      archivedAt: instantSchema.nullable(),
    })
    .strict(),
  z
    .object({
      key: keySchema,
      name: categoryCreateSchema.shape.name,
      detail: z.literal("reference"),
      kind: categoryCreateSchema.shape.kind,
      group: keySchema.nullable(),
    })
    .strict(),
]);

const accountFields = accountCreateSchema.shape;

/**
 * An account, whole or as a reference.
 *
 * Three fields on a whole account are checks rather than data, and an import
 * compares rather than writes them. `balance` is what the postings said the
 * account held on `throughDate`, and an import that arrives at a different
 * figure refuses rather than leaving somebody a ledger that is quietly wrong;
 * it is only on the last part of a file sent in parts, which is the part an
 * import can check it after, and on no part of a file whose range starts after
 * `throughDate`, because an account rebuilt from the range holds nothing yet on
 * a day before it.
 *
 * `carriedForward` is on every whole account of a file whose entries start
 * partway through: what its postings summed to the day before the first day,
 * future-dated ones included, since those entries are not in the file either.
 * It is keyed to the range and not to the opening date, because nothing stops
 * an entry predating its account's opening — an account opened today and then
 * filled from last year's statements is the ordinary case — and money dated
 * before both the opening and the range is in the balance and in no entry. For
 * an account opened before the range the carry includes the opening, and a new
 * account opens on the first day at the carry; for one opened inside it the
 * carry is only that earlier money, posted on the first day beside the opening
 * on its own date.
 *
 * `inUse` says the account counted against a plan's limit where it came from,
 * and nothing reads it as a choice: what is frozen is worked out by the copy it
 * lands in, from that copy's own plan.
 */
const accountSchema = z.discriminatedUnion("detail", [
  z
    .object({
      key: keySchema,
      name: accountFields.name,
      detail: z.literal("full"),
      type: accountFields.type,
      currency: currencyCodeSchema,
      openingDate: isoDateSchema,
      openingBalance: exactAmount(decimalStringSchema),
      institution: accountFields.institution,
      notes: accountFields.notes,
      inBudget: z.boolean(),
      archivedAt: instantSchema.nullable(),
      inUse: z.boolean(),
      carriedForward: z
        .object({ date: isoDateSchema, amount: exactAmount(decimalStringSchema) })
        .strict()
        .nullable()
        .optional(),
      balance: exactAmount(decimalStringSchema).optional(),
    })
    .strict(),
  z
    .object({
      key: keySchema,
      name: accountFields.name,
      detail: z.literal("reference"),
      type: z.enum(userAccountTypes),
      currency: currencyCodeSchema,
    })
    .strict(),
]);

const templateDraftFields = transactionTemplateDraftSchema.shape;
const templateLegFields = transactionTemplateLegSchema.shape;

/**
 * A template's draft with its uuids replaced by keys: `from` and `to` for the
 * two account fields and `category` for a category picked rather than named.
 * Everything else is the template draft's own field schema, blank-means-absent
 * included, so a template that never mentioned a field still does not.
 */
const templateDraftSchema = z
  .object({
    type: templateDraftFields.type,
    date: templateDraftFields.date,
    from: keySchema.optional(),
    to: keySchema.optional(),
    amount: exactAmount(templateDraftFields.amount).optional(),
    destinationAmount: exactAmount(templateDraftFields.destinationAmount).optional(),
    payee: templateDraftFields.payee,
    description: templateDraftFields.description,
    category: keySchema.optional(),
    categoryName: templateDraftFields.categoryName,
    legs: z
      .array(
        z
          .object({
            category: keySchema.optional(),
            categoryName: templateLegFields.categoryName,
            amount: exactAmount(templateLegFields.amount).optional(),
            note: templateLegFields.note,
          })
          .strict(),
      )
      .min(2, "A split needs at least two legs")
      .max(MAX_TRANSACTION_LEGS, SPLIT_TOO_LONG)
      .optional(),
    notes: templateDraftFields.notes,
  })
  .strict();

/**
 * A template, whole or as a reference. A reference is how an entry made from a
 * template keeps that provenance in a file that leaves templates out: an import
 * maps it to a template of that name if there is one and drops it otherwise,
 * which is what a template deleted since already does to the entries it made.
 *
 * `notification` is the reminder, under the name the API gives it and with the
 * API's own schema, read-back fields and all, and one of those fields means
 * more here than it does there. `lastNotifiedDate`
 * is accepted and ignored by a write, because the scheduler owns it; in a file
 * it is the watermark an import seeds, so a one-time reminder the source has
 * already sent is not sent again by the copy it moves to.
 */
const templateSchema = z.discriminatedUnion("detail", [
  z
    .object({
      key: keySchema,
      name: transactionTemplateCreateSchema.shape.name,
      detail: z.literal("full"),
      draft: templateDraftSchema,
      notification: templateNotificationSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      key: keySchema,
      name: transactionTemplateCreateSchema.shape.name,
      detail: z.literal("reference"),
    })
    .strict(),
]);

const shapeFields = recurrenceShapeSchema.options[2].shape;
const recurrenceLegFields = recurrenceLegSchema.shape;

const recurrenceLeg = z
  .object({
    category: keySchema.optional(),
    categoryName: recurrenceLegFields.categoryName,
    amount: exactAmount(recurrenceLegFields.amount),
    note: recurrenceLegFields.note,
  })
  .strict();

/**
 * What a recurrence proposes, with keys for its uuids.
 *
 * Read with the stored-shape rules rather than the stricter ones a create
 * meets, deliberately. A recurrence made before a check existed is still a
 * recurrence somebody has, and refusing the whole file over it would cost them
 * everything else in it; an import skips that one recurrence with its reason
 * instead, which is the only place the stricter rule can be applied honestly.
 */
const recurrenceShapeCommon = {
  payee: shapeFields.payee,
  description: shapeFields.description,
  category: keySchema.optional(),
  categoryName: shapeFields.categoryName,
  categoryKind: shapeFields.categoryKind,
  legs: z
    .array(recurrenceLeg)
    .min(2, "A split needs at least two legs")
    .max(MAX_TRANSACTION_LEGS, SPLIT_TOO_LONG)
    .optional(),
  notes: shapeFields.notes,
};

const recurrenceShape = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("deposit"),
      to: keySchema,
      amount: exactAmount(shapeFields.amount).optional(),
      ...recurrenceShapeCommon,
    })
    .strict(),
  z
    .object({
      type: z.literal("withdrawal"),
      from: keySchema,
      amount: exactAmount(shapeFields.amount).optional(),
      ...recurrenceShapeCommon,
    })
    .strict(),
  z
    .object({
      type: z.literal("transfer"),
      from: keySchema,
      to: keySchema,
      amount: exactAmount(shapeFields.amount).optional(),
      destinationAmount: exactAmount(shapeFields.destinationAmount).optional(),
      ...recurrenceShapeCommon,
    })
    .strict(),
]);

/**
 * A recurrence and its watermark.
 *
 * `lastOccurrenceDate` is the recurrence's own column under the name its read
 * view already gives it: the last occurrence it decided, proposed or passed
 * over by a policy. An import starts the copy proposing after it, so moving on
 * a day that is itself an occurrence does not propose it a second time, and
 * never before the day it lands, which is the no-backfill a create already has.
 */
const recurrenceSchema = z
  .object({
    key: keySchema,
    name: recurrenceCreateSchema.shape.name,
    shape: recurrenceShape,
    schedule: recurrenceScheduleSchema,
    notifyOnCreate: z.boolean(),
    lastOccurrenceDate: isoDateSchema.nullable(),
  })
  .strict();

const planFields = budgetPlanCreateSchema.shape;

/**
 * Which budget a plan or an amount is about: a category or a group by key,
 * never both, and the currency and period length that complete its identity.
 * `amount_rule` is absent on purpose, because it is derived from which
 * parameter a row sets and is never asked for.
 */
const budgetTarget = {
  category: keySchema.optional(),
  group: keySchema.optional(),
  currency: planFields.currency,
  periodUnit: planFields.periodUnit,
};

const budgetPlanSchema = z
  .object({
    ...budgetTarget,
    amount: exactAmount(planFields.amount),
    activeFrom: planFields.activeFrom,
    activeTo: planFields.activeTo,
    rollover: planFields.rollover,
    rolloverCap: exactAmount(planFields.rolloverCap).optional(),
    targetAmount: exactAmount(planFields.targetAmount).optional(),
    targetDate: planFields.targetDate,
    lookbackPeriods: planFields.lookbackPeriods,
    percentOfPrevious: exactAmount(planFields.percentOfPrevious).optional(),
    percentOfIncome: exactAmount(planFields.percentOfIncome).optional(),
    priority: planFields.priority,
  })
  .strict();

const budgetEntrySchema = z
  .object({
    ...budgetTarget,
    periodStart: budgetEntrySetSchema.shape.periodStart,
    amount: exactAmount(budgetEntrySetSchema.shape.amount),
  })
  .strict();

const depositFields = transactionDraftSchema.options[0].shape;
const transferFields = transactionDraftSchema.options[2].shape;

/** One category's share of a split entry. A null category is a share filed nowhere. */
const entryLeg = z
  .object({
    category: keySchema.nullable(),
    amount: exactAmount(transactionLegSchema.shape.amount),
    note: transactionLegSchema.shape.note,
  })
  .strict();

const entryLegs = z
  .array(entryLeg)
  .min(2, "A split needs at least two legs")
  .max(MAX_TRANSACTION_LEGS, SPLIT_TOO_LONG);

/**
 * What every entry carries whatever its type.
 *
 * `id` is the entry's **origin**: the id it was first written under, which is
 * its own id or, for an entry that itself arrived in a ledger file, the origin
 * it arrived with. It is identity and nothing else. An import never writes it
 * as a primary key; it uses it to recognize the same entry arriving twice —
 * a transfer in two accounts' files, or a ledger moved away and back — and
 * skips the second rather than flagging it, because two entries with one
 * origin are one entry. Two coffees bought the same morning have two origins,
 * so neither is mistaken for the other.
 *
 * The description is the template draft's, blank-means-absent, rather than the
 * entry draft's, which turns absent into null: written out on every line of a
 * hundred-thousand-entry file, that null is two megabytes of nothing.
 *
 * `deleted` is present only when it is true. A deleted entry is voided by its
 * reversal and nets to zero in every balance, so it changes no figure, but it
 * is history, and it is what keeps an account or a category that held it from
 * being deleted.
 */
const entryCommon = {
  id: uuid(),
  date: isoDateSchema,
  payee: depositFields.payee,
  description: templateDraftFields.description,
  notes: depositFields.notes,
  externalId: depositFields.externalId,
  template: keySchema.optional(),
  deleted: z.literal(true).optional(),
};

/**
 * `postedAs` is which counter-account the entry's postings actually hit, and it
 * is written only where that differs from what `resolveEntrySide` would say from
 * the kinds the file gives its categories. That happens when a category was
 * widened to `both` after a refund was filed under it: widening reposts nothing,
 * so the refund still debits Expenses where it was written, and the same entry
 * written fresh against a `both` category would credit Income. An import
 * reports the difference rather than reproducing it, because overriding the
 * side would be a second rule beside the one that decides it.
 */
const postedAs = z.enum(counterKinds).optional();

const entrySchema = z.discriminatedUnion("type", [
  z
    .object({
      id: entryCommon.id,
      type: z.literal("deposit"),
      date: entryCommon.date,
      to: keySchema,
      amount: exactAmount(depositFields.amount),
      payee: entryCommon.payee,
      description: entryCommon.description,
      category: keySchema.optional(),
      legs: entryLegs.optional(),
      notes: entryCommon.notes,
      externalId: entryCommon.externalId,
      template: entryCommon.template,
      deleted: entryCommon.deleted,
      postedAs,
    })
    .strict(),
  z
    .object({
      id: entryCommon.id,
      type: z.literal("withdrawal"),
      date: entryCommon.date,
      from: keySchema,
      amount: exactAmount(depositFields.amount),
      payee: entryCommon.payee,
      description: entryCommon.description,
      category: keySchema.optional(),
      legs: entryLegs.optional(),
      notes: entryCommon.notes,
      externalId: entryCommon.externalId,
      template: entryCommon.template,
      deleted: entryCommon.deleted,
      postedAs,
    })
    .strict(),
  // Both amounts, always, including where the currencies match. A conversion
  // is a transfer whose two amounts differ, and its rate is implied by them
  // rather than stored, so a file that carried one amount and a rate would be
  // carrying a derived figure instead of the two that actually moved.
  z
    .object({
      id: entryCommon.id,
      type: z.literal("transfer"),
      date: entryCommon.date,
      from: keySchema,
      to: keySchema,
      sourceAmount: exactAmount(transferFields.sourceAmount),
      destinationAmount: exactAmount(transferFields.sourceAmount),
      payee: entryCommon.payee,
      description: entryCommon.description,
      category: keySchema.optional(),
      notes: entryCommon.notes,
      externalId: entryCommon.externalId,
      template: entryCommon.template,
      deleted: entryCommon.deleted,
    })
    .strict(),
]);

const stagedFields = stagedDraftSchema.shape;

/**
 * An amount on a staged row, which may be anything at all except a number.
 *
 * A staged row is allowed to be wrong — that is what the queue is for — so a
 * value that is not yet a decimal survives here for somebody to fix. A JSON
 * number does not, for the reason every other amount refuses one: it is money
 * already rounded by the time anything reads it.
 */
const stagedAmount = z
  .unknown()
  .refine((value) => typeof value !== "number", { message: AMOUNT_IS_A_NUMBER, abort: true });

/**
 * A pending staged row's draft, with keys for the references it could resolve.
 *
 * Every other field keeps the staged draft's own anything-goes schema, because
 * the row is unfinished work and its mistakes are part of it. Strict all the
 * same, and that is the one departure from the queue's own schema: a staged
 * draft keeps whatever keys it is given, and one of those could be a uuid from
 * the ledger it came from, which means nothing anywhere else and is the one
 * kind of value this file never carries.
 */
const stagedDraftFileSchema = z
  .object({
    type: stagedFields.type,
    date: stagedFields.date,
    from: keySchema.nullable().optional(),
    to: keySchema.nullable().optional(),
    amount: stagedAmount.optional(),
    sourceAmount: stagedAmount.optional(),
    destinationAmount: stagedAmount.optional(),
    payee: stagedFields.payee,
    description: stagedFields.description,
    category: keySchema.nullable().optional(),
    categoryName: stagedFields.categoryName,
    categoryKind: stagedFields.categoryKind,
    legs: z
      .array(
        z
          .object({
            category: keySchema.nullable().optional(),
            categoryName: z.unknown().optional(),
            categoryKind: z.unknown().optional(),
            amount: stagedAmount.optional(),
            note: z.unknown().optional(),
          })
          .strict(),
      )
      .nullable()
      .optional(),
    notes: stagedFields.notes,
    externalId: stagedFields.externalId,
    template: keySchema.nullable().optional(),
  })
  .strict();

/** A row waiting in Staged transactions, with the origin it is recognized by on a second import. */
const stagedRowSchema = z
  .object({
    id: uuid(),
    draft: stagedDraftFileSchema,
    rawData: stageCreateSchema.shape.rawData,
  })
  .strict();

/**
 * One activity-log event, as stored, for keeping rather than for reading back.
 *
 * Loose where everything else is strict, and on purpose. No import ever reads
 * this, so a copy refusing a whole file because a newer one logged a field it
 * does not know would be losing somebody's ledger over a section nothing uses.
 * It is the one place source ids travel, because the log is about them.
 */
const historyEventSchema = z.looseObject({
  createdAt: instantSchema,
  actorSource: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  operation: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

/**
 * What the export was asked for, recorded so an import can tell a kind that was
 * left out from one the ledger simply had none of.
 */
const scopeSchema = z
  .object({
    kinds: z.array(z.enum(ledgerFileKinds)).min(1, "Name at least one kind of record"),
    accounts: z.enum(ledgerFileAccountScopes),
    start: isoDateSchema.nullable(),
    end: isoDateSchema.nullable(),
  })
  .strict();

/**
 * The shape of a `simple-balance-ledger-1` file.
 *
 * This is the structure alone. Whether every reference names a key that is
 * there, whether keys are unique, whether the sections agree with the scope —
 * those are `parseLedgerFile`'s, which runs this first and then reads the
 * whole parsed file at once, because a rule about two records needs both of
 * them to have parsed. Reach for `parseLedgerFile` rather than this.
 *
 * Every record uses the field names of the API's own create schema, with a
 * uuid reference `xId` becoming `x` and naming a key, and the field schemas are
 * the API's own: a value the file accepts is a value a create accepts. The two
 * account sides are the one departure, `from` and `to` rather than
 * `fromAccount` and `toAccount`, because they are on every line of the file and
 * a side can only ever name an account.
 */
export const ledgerFileSchema = z
  .object({
    format: z.literal(LEDGER_FILE_FORMAT),
    exportedAt: instantSchema,
    // The day the balance checks describe: today where the person lives, or
    // the range's last day when that is earlier.
    throughDate: isoDateSchema,
    producer: z
      .object({
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Use a release version, such as 0.3.0"),
      })
      .strict(),
    scope: scopeSchema,
    // Null when the export left settings out, and when the person had never
    // chosen any: defaults nobody picked are not a decision another copy should
    // take on as one.
    preferences: preferencesSchema.strict().nullable(),
    groups: z.array(groupSchema),
    categories: z.array(categorySchema),
    accounts: z.array(accountSchema),
    templates: z.array(templateSchema),
    recurrences: z.array(recurrenceSchema),
    budgets: z
      .object({ plans: z.array(budgetPlanSchema), entries: z.array(budgetEntrySchema) })
      .strict(),
    entries: z.array(entrySchema),
    staged: z.array(stagedRowSchema),
    history: z.array(historyEventSchema).optional(),
  })
  .strict();

export type LedgerFile = z.infer<typeof ledgerFileSchema>;
export type LedgerFileGroup = LedgerFile["groups"][number];
export type LedgerFileCategory = LedgerFile["categories"][number];
export type LedgerFileAccount = LedgerFile["accounts"][number];
export type LedgerFileTemplate = LedgerFile["templates"][number];
export type LedgerFileRecurrence = LedgerFile["recurrences"][number];
export type LedgerFileBudgetPlan = LedgerFile["budgets"]["plans"][number];
export type LedgerFileBudgetEntry = LedgerFile["budgets"]["entries"][number];
export type LedgerFileEntry = LedgerFile["entries"][number];
export type LedgerFileStagedRow = LedgerFile["staged"][number];

/**
 * A file read, or the sentences saying why it could not be.
 *
 * A result rather than a throw, for the reason `resolveEntrySide` returns one:
 * the import page renders these beside the file somebody chose, and the server
 * turns the same list into a 422. Each `field` is a dotted path into the file,
 * counting records from zero, so `entries.12.from` is the thirteenth entry —
 * of the file as it was given, before the entries are sorted, because that is
 * the line somebody opening it would have to find.
 */
export type LedgerFileParse =
  | { ok: true; file: LedgerFile }
  | { ok: false; issues: ValidationIssue[] };

/**
 * How many problems a refusal lists before it summarizes the rest.
 *
 * A file whose every amount was written as a number has one problem a hundred
 * thousand times, and a list that long is a response nobody reads and a page
 * that will not render. The first few say what is wrong.
 */
const MAX_REPORTED_PROBLEMS = 50;

const FORMAT_PATTERN = /^simple-balance-ledger-(\d+)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Read a ledger file from the text somebody chose or sent.
 *
 * Text rather than bytes, because both callers have text: the browser's
 * `File.text()` and a request body. A file that is not JSON at all is far more
 * often a CSV chosen in the wrong place, or a download that stopped partway,
 * than anything else, so the sentence says both.
 */
export function parseLedgerFileText(text: string): LedgerFileParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refusal(
      "",
      "This is not a Simple Balance file: it could not be read as JSON. A CSV export goes through the CSV import instead, and a file that was cut short has to be exported again.",
    );
  }
  return parseLedgerFile(value);
}

/**
 * Read a ledger file that is already a JavaScript value.
 *
 * The format token is read first and on its own, because it decides which
 * reader applies, and a file from a newer release should be told so in one
 * sentence rather than in a list of every field this copy does not know. Each
 * token ever published gets a reader here, and a later token's reader upgrades
 * what it reads to the newest shape, so everything after this function sees
 * one shape.
 *
 * Entries come back sorted by date and then origin, whatever order the file
 * had them in: the order carries no meaning, and the splitter and the
 * serializer both rely on it.
 */
export function parseLedgerFile(value: unknown): LedgerFileParse {
  const format = isRecord(value) ? value.format : undefined;
  if (format !== LEDGER_FILE_FORMAT) {
    const published = typeof format === "string" ? FORMAT_PATTERN.exec(format) : null;
    if (published && Number(published[1]) > 1) {
      return refusal(
        "format",
        `This file was made by a newer Simple Balance (${format}). Upgrade this copy to import it.`,
      );
    }
    return refusal(
      "format",
      `This is not a Simple Balance file: it does not say it is one. A Simple Balance file starts with "format": "${LEDGER_FILE_FORMAT}".`,
    );
  }

  const parsed = ledgerFileSchema.safeParse(value, { reportInput: true });
  if (!parsed.success) {
    const issues = parsed.error.issues.map(describeIssue);
    const producer = isRecord(value) && isRecord(value.producer) ? value.producer.version : null;
    // A newer release may add an optional field under this same token, which
    // this copy's strict reader refuses by name. That refusal is right — a field
    // nobody here understands could change what the rest means — but the remedy
    // is an upgrade, and saying only "not part of the format" would read as a
    // damaged file.
    if (typeof producer === "string" && compareVersions(producer, APP_VERSION) > 0) {
      issues.unshift({
        field: "producer.version",
        message: `This file was made by Simple Balance ${producer}, which is newer than this copy (${APP_VERSION}), and it holds something this copy cannot read. Upgrade this copy to import it.`,
      });
    }
    return { ok: false, issues: capped(issues) };
  }

  const problems = ledgerFileProblems(parsed.data);
  if (problems.length) return { ok: false, issues: capped(problems) };
  return { ok: true, file: { ...parsed.data, entries: sortEntries(parsed.data.entries) } };
}

function refusal(field: string, message: string): LedgerFileParse {
  return { ok: false, issues: [{ field, message }] };
}

function capped(issues: ValidationIssue[]): ValidationIssue[] {
  if (issues.length <= MAX_REPORTED_PROBLEMS) return issues;
  const more = issues.length - MAX_REPORTED_PROBLEMS;
  return [
    ...issues.slice(0, MAX_REPORTED_PROBLEMS),
    { field: "", message: `There are ${more.toLocaleString("en-US")} more problems like these.` },
  ];
}

/**
 * Zod's issue as a sentence about a file.
 *
 * Most of the messages here are the API's own, written for a form, and they
 * read well enough about a file too. Three of Zod's defaults do not: a field the
 * file lacks, a field the format has no place for, and a record whose `type` or
 * `detail` is not one the format knows.
 */
function describeIssue(issue: z.core.$ZodIssue): ValidationIssue {
  const field = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    const names = issue.keys.map((key) => `"${key}"`).join(", ");
    return {
      field,
      message: `${names} ${issue.keys.length === 1 ? "is" : "are"} not part of a Simple Balance file (${LEDGER_FILE_FORMAT}).`,
    };
  }
  if (issue.code === "invalid_type" && issue.input === undefined) {
    return { field, message: "This is missing." };
  }
  if (issue.code === "invalid_union" && issue.discriminator !== undefined) {
    return {
      field,
      message: `This ${issue.discriminator} is not one a Simple Balance file knows.`,
    };
  }
  return { field, message: issue.message };
}

/**
 * Release versions in order, by their three numbers. A prerelease suffix is
 * ignored: it only ever names a build of the release whose numbers it carries.
 */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) =>
    (version.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let at = 0; at < 3; at++) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** By date, then by origin, compared as code units so no locale reorders them. */
function compareEntries(left: LedgerFileEntry, right: LedgerFileEntry): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

const sortEntries = (entries: readonly LedgerFileEntry[]) => [...entries].sort(compareEntries);

/**
 * Every rule about the file as a whole, which no one record can check alone.
 *
 * Keys are unique within a kind under the rule every service matches names by,
 * so two records an import would match to one record cannot both arrive. Every
 * reference names a key of the right kind that is in the file, whole or as a
 * reference, because a dangling one could only be resolved by guessing. And the
 * sections agree with the scope: a kind the export left out carries nothing
 * whole, and a ranged file's entries and carried-forward balances agree with
 * its range, which is what its balance checks rest on.
 *
 * Exported for the tests that hold each rule to its sentence. Callers want
 * `parseLedgerFile`, which runs the schema first.
 */
function ledgerFileProblems(file: LedgerFile): ValidationIssue[] {
  const problems: ValidationIssue[] = [];
  const refuse = (field: string, message: string) => problems.push({ field, message });

  const keyed = <T extends { key: string }>(
    records: readonly T[],
    section: string,
    label: string,
  ) => {
    const byKey = new Map<string, T>();
    const folded = new Map<string, string>();
    records.forEach((record, at) => {
      const fold = normalizeHumanName(record.key);
      const earlier = folded.get(fold);
      if (earlier !== undefined) {
        refuse(
          `${section}.${at}.key`,
          `Another ${label} in this file already has the key "${earlier}", once case and spacing are set aside. Each ${label} needs a key of its own.`,
        );
      } else folded.set(fold, record.key);
      byKey.set(record.key, record);
    });
    return byKey;
  };
  const groups = keyed(file.groups, "groups", "category group");
  const categories = keyed(file.categories, "categories", "category");
  const accounts = keyed(file.accounts, "accounts", "account");
  const templates = keyed(file.templates, "templates", "template");
  keyed(file.recurrences, "recurrences", "recurring transaction");

  const naming =
    (byKey: ReadonlyMap<string, unknown>, label: string) =>
    (key: string | null | undefined, field: string) => {
      if (key === undefined || key === null || byKey.has(key)) return;
      refuse(field, `No ${label} in this file has the key "${key}".`);
    };
  const group = naming(groups, "category group");
  const category = naming(categories, "category");
  const account = naming(accounts, "account");
  const template = naming(templates, "template");

  file.categories.forEach((record, at) => group(record.group, `categories.${at}.group`));

  file.templates.forEach((record, at) => {
    if (record.detail !== "full") return;
    const path = `templates.${at}`;
    account(record.draft.from, `${path}.draft.from`);
    account(record.draft.to, `${path}.draft.to`);
    category(record.draft.category, `${path}.draft.category`);
    record.draft.legs?.forEach((leg, legAt) =>
      category(leg.category, `${path}.draft.legs.${legAt}.category`),
    );
    // The notification schema takes this as any string, because a write ignores it.
    // A file seeds a watermark from it, so here it is held to being a date, in
    // the date schema's own words.
    const sent = record.notification?.lastNotifiedDate;
    const sentDate = sent === undefined || sent === null ? null : isoDateSchema.safeParse(sent);
    if (sentDate && !sentDate.success) {
      refuse(`${path}.notification.lastNotifiedDate`, sentDate.error.issues[0]!.message);
    }
  });

  file.recurrences.forEach((record, at) => {
    const shape = record.shape;
    const path = `recurrences.${at}.shape`;
    if (shape.type !== "deposit") account(shape.from, `${path}.from`);
    if (shape.type !== "withdrawal") account(shape.to, `${path}.to`);
    category(shape.category, `${path}.category`);
    shape.legs?.forEach((leg, legAt) => category(leg.category, `${path}.legs.${legAt}.category`));
  });

  // A plan and an amount are each one row per budget and period, which is a
  // unique key in the database, so a file holding two could only ever import
  // one of them and would have to guess which.
  const budgetRows = <T extends LedgerFileBudgetPlan | LedgerFileBudgetEntry>(
    records: readonly T[],
    section: string,
    period: (record: T) => string,
    label: string,
  ) => {
    const seen = new Set<string>();
    records.forEach((record, at) => {
      if ((record.category === undefined) === (record.group === undefined)) {
        refuse(
          `${section}.${at}.category`,
          "A budget is about a category or a group. Name exactly one.",
        );
        return;
      }
      category(record.category, `${section}.${at}.category`);
      group(record.group, `${section}.${at}.group`);
      const target =
        record.category !== undefined ? `category:${record.category}` : `group:${record.group}`;
      const identity = [target, record.currency, record.periodUnit, period(record)].join("|");
      if (seen.has(identity)) {
        refuse(`${section}.${at}`, `This file already has ${label} for this budget and period.`);
      }
      seen.add(identity);
    });
  };
  budgetRows(file.budgets.plans, "budgets.plans", (plan) => plan.activeFrom, "a plan");
  budgetRows(file.budgets.entries, "budgets.entries", (entry) => entry.periodStart, "an amount");

  // Origins are one identity across the books and the queue: an entry and a
  // staged row sharing one would be one entry in two places, and an import
  // would write whichever it met first and skip the other.
  const origins = new Map<string, string>();
  const origin = (id: string, field: string, what: string) => {
    const earlier = origins.get(id);
    if (earlier !== undefined) {
      refuse(
        `${field}.id`,
        `${earlier} in this file already has the id ${id}. An id names one entry.`,
      );
    } else origins.set(id, what);
  };

  const kinds = new Set(file.scope.kinds);
  const { start, end } = file.scope;
  file.entries.forEach((entry, at) => {
    const path = `entries.${at}`;
    origin(entry.id, path, "An entry");
    if (entry.type !== "deposit") account(entry.from, `${path}.from`);
    if (entry.type !== "withdrawal") account(entry.to, `${path}.to`);
    category(entry.category, `${path}.category`);
    template(entry.template, `${path}.template`);
    if (entry.type !== "transfer" && entry.legs !== undefined) {
      entry.legs.forEach((leg, legAt) => category(leg.category, `${path}.legs.${legAt}.category`));
      if (entry.category !== undefined) {
        refuse(
          `${path}.legs`,
          "An entry is filed under one category or split into legs, not both.",
        );
      }
    }
    if (entry.deleted && !kinds.has("deletedEntries")) {
      refuse(
        `${path}.deleted`,
        "This file's scope leaves deleted entries out, so it cannot carry one.",
      );
    }
    if ((start !== null && entry.date < start) || (end !== null && entry.date > end)) {
      refuse(`${path}.date`, "This entry is dated outside the range the file says it covers.");
    }
  });

  file.staged.forEach((row, at) => {
    const path = `staged.${at}`;
    origin(row.id, path, "A staged row");
    account(row.draft.from, `${path}.draft.from`);
    account(row.draft.to, `${path}.draft.to`);
    category(row.draft.category, `${path}.draft.category`);
    template(row.draft.template, `${path}.draft.template`);
    row.draft.legs?.forEach((leg, legAt) =>
      category(leg.category, `${path}.draft.legs.${legAt}.category`),
    );
  });

  scopeProblems(file, kinds, refuse);
  return problems;
}

/**
 * The sections against the scope that produced them.
 *
 * Only one direction is a rule: a kind left out carries nothing whole. The other
 * — a kind that was asked for has something in it — cannot be, because a ledger
 * may have no budgets at all, and a part of a file sent in parts carries its
 * staged rows only at the end.
 */
function scopeProblems(
  file: LedgerFile,
  kinds: ReadonlySet<LedgerFileKind>,
  refuse: (field: string, message: string) => void,
) {
  const { scope } = file;
  if (kinds.size !== scope.kinds.length) refuse("scope.kinds", "Name each kind of record once.");
  if (kinds.has("deletedEntries") && !kinds.has("entries")) {
    refuse(
      "scope.kinds",
      "Deleted entries travel with the entries, so a scope naming them names entries too.",
    );
  }
  if (scope.accounts === "chosen") {
    if (!kinds.has("accounts")) {
      refuse("scope.kinds", "A file of chosen accounts carries those accounts.");
    }
    for (const kind of kinds) {
      if (CHOSEN_ACCOUNT_KINDS.has(kind)) continue;
      refuse(
        "scope.kinds",
        `A file of chosen accounts carries accounts, categories and entries, not ${kind}.`,
      );
    }
  }
  if (
    (scope.start !== null || scope.end !== null) &&
    !kinds.has("entries") &&
    !kinds.has("history")
  ) {
    refuse(
      "scope.start",
      "A date range narrows the entries and the activity history, so a scope with one names one of them.",
    );
  }
  if (scope.start !== null && scope.end !== null && scope.end < scope.start) {
    refuse("scope.end", "The range cannot end before it starts.");
  }
  if (scope.end !== null && file.throughDate > scope.end) {
    refuse("throughDate", "The balance checks cannot describe a day after the range ends.");
  }

  const leftOut = (section: string, label: string) =>
    refuse(section, `This file's scope leaves ${label} out, so it cannot carry any.`);
  if (!kinds.has("preferences") && file.preferences !== null) leftOut("preferences", "settings");
  if (!kinds.has("entries") && file.entries.length) leftOut("entries", "entries");
  if (!kinds.has("recurrences") && file.recurrences.length) {
    leftOut("recurrences", "recurring transactions");
  }
  if (!kinds.has("budgets") && (file.budgets.plans.length || file.budgets.entries.length)) {
    leftOut("budgets", "budgets");
  }
  if (!kinds.has("staged") && file.staged.length) leftOut("staged", "staged rows");
  if (!kinds.has("history") && file.history !== undefined) {
    leftOut("history", "the activity history");
  }

  // Whole records against references. A kind that was exported is exported
  // whole, so a reference to one of its records means the exporter missed it;
  // a kind that was not is only ever named. Chosen accounts are the exception
  // the scope itself describes: the accounts on the far side of a transfer are
  // references beside the whole ones somebody picked.
  const detail = (
    records: readonly { detail: LedgerRecordDetail }[],
    section: string,
    whole: boolean,
    label: string,
  ) =>
    records.forEach((record, at) => {
      if (whole && record.detail === "reference") {
        refuse(
          `${section}.${at}.detail`,
          `This file exports ${label} whole, so none of them is a reference.`,
        );
      }
      if (!whole && record.detail === "full") {
        refuse(
          `${section}.${at}.detail`,
          `This file's scope leaves ${label} out, so it carries them only as references.`,
        );
      }
    });
  detail(file.groups, "groups", kinds.has("categories"), "categories");
  detail(file.categories, "categories", kinds.has("categories"), "categories");
  detail(file.templates, "templates", kinds.has("templates"), "templates");
  const rangedEntries = scope.start !== null && kinds.has("entries");
  file.accounts.forEach((account, at) => {
    const path = `accounts.${at}`;
    if (!kinds.has("accounts") && account.detail === "full") {
      refuse(
        `${path}.detail`,
        "This file's scope leaves accounts out, so it carries them only as references.",
      );
    }
    if (kinds.has("accounts") && scope.accounts === "all" && account.detail === "reference") {
      refuse(
        `${path}.detail`,
        "This file exports every account whole, so none of them is a reference.",
      );
    }
    if (account.detail !== "full") return;
    const carried = account.carriedForward ?? null;
    // Every whole account of a file whose entries start partway through
    // carries what it held the day before, whatever its opening date: money
    // dated before the first day is in no entry, and an entry may predate its
    // account's opening. Leaving any account without one leaves the balance
    // check at the end describing money the file never carried.
    if (rangedEntries) {
      if (carried === null) {
        refuse(
          `${path}.carriedForward`,
          "An account in a file whose entries start partway through needs the balance it carried into the range.",
        );
      } else if (carried.date !== scope.start) {
        refuse(
          `${path}.carriedForward.date`,
          "A balance is carried forward to the first day of the range.",
        );
      }
    } else if (carried !== null) {
      refuse(
        `${path}.carriedForward`,
        "Only a file whose entries start partway through carries a balance forward.",
      );
    }
    // A range that starts after the day the checks describe: an account
    // rebuilt from it opens on the first day and holds nothing before then, so
    // no import of the file could ever reach a balance on that earlier day.
    if (scope.start !== null && file.throughDate < scope.start && account.balance !== undefined) {
      refuse(
        `${path}.balance`,
        "A range that starts after the balance check's day has no balance to check yet.",
      );
    }
  });
}

/**
 * Keys for a list of names, in the order given: each name is its own key, and
 * a name that folds onto an earlier one gets the first free suffix, " (2)",
 * " (3)" and so on.
 *
 * Every name that is the first of its fold is reserved before any suffix is
 * handed out, so a suffix never takes a name somebody actually used:
 * "Checking", "checking" and "Checking (2)" come out as "Checking",
 * "checking (3)" and "Checking (2)". Give the names in a stable order — the
 * order they were created in — so the same ledger exports the same keys.
 */
export function assignLedgerKeys(names: readonly string[]): string[] {
  const first = new Map<string, number>();
  names.forEach((name, at) => {
    const fold = normalizeHumanName(name);
    if (!first.has(fold)) first.set(fold, at);
  });
  const taken = new Set(first.keys());
  return names.map((name, at) => {
    if (first.get(normalizeHumanName(name)) === at) return name;
    for (let suffix = 2; ; suffix++) {
      const candidate = `${name} (${suffix})`;
      const fold = normalizeHumanName(candidate);
      if (taken.has(fold)) continue;
      taken.add(fold);
      return candidate;
    }
  });
}

/** The rows one part may carry, which is what the ten-thousand-row cap counts. */
export function ledgerFileRowCount(
  file: Pick<LedgerFile, "entries" | "staged" | "budgets">,
): number {
  return file.entries.length + file.staged.length + file.budgets.entries.length;
}

/**
 * The records one part creates or matches before its first row: groups,
 * categories, accounts, templates, recurring transactions and budget plans.
 *
 * Bounded on their own at the same ten thousand, rather than counted into the
 * rows. Every part carries every record, so a row cap that counted them would
 * shrink each part by the records' size and stop an export of ten thousand
 * entries being one part; and left unbounded, a part of nothing but records is
 * one transaction creating any number of them under every namespace lock.
 */
export function ledgerFileRecordCount(
  file: Pick<
    LedgerFile,
    "groups" | "categories" | "accounts" | "templates" | "recurrences" | "budgets"
  >,
): number {
  return (
    file.groups.length +
    file.categories.length +
    file.accounts.length +
    file.templates.length +
    file.recurrences.length +
    file.budgets.plans.length
  );
}

/** The order the top level is written in, which is the order it is read in. */
const SECTIONS = [
  "format",
  "exportedAt",
  "throughDate",
  "producer",
  "scope",
  "preferences",
  "groups",
  "categories",
  "accounts",
  "templates",
  "recurrences",
  "budgets",
  "entries",
  "staged",
  "history",
] as const satisfies readonly (keyof LedgerFile)[];

/** A list at some depth: empty on one line, otherwise one record per line. */
function rows(items: readonly unknown[], indent: string): string {
  if (!items.length) return "[]";
  return `[\n${items.map((item) => `${indent}  ${JSON.stringify(item)}`).join(",\n")}\n${indent}]`;
}

/**
 * The file as text: the top level indented, and every record on a line of its
 * own.
 *
 * Neither of the two obvious layouts. Fully indented, one entry is fifteen lines
 * and a ledger is a file no editor scrolls; on one line, a diff of two exports
 * is one changed line of forty megabytes. One record per line is what lets
 * somebody open the file, find an entry by searching for its payee, and read
 * it whole.
 *
 * Entries are written by date and then origin, and keys within a record in the
 * order the schema declares them, which is the order `parseLedgerFile` hands
 * them back in. So a parsed file serializes to the bytes it was read from, and
 * two exports of an unchanged ledger differ only in when they were made.
 */
export function serializeLedgerFile(file: LedgerFile): string {
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const value = file[section];
    if (value === undefined) continue;
    let text: string;
    if (section === "budgets") {
      text = `{\n    "plans": ${rows(file.budgets.plans, "    ")},\n    "entries": ${rows(file.budgets.entries, "    ")}\n  }`;
    } else if (section === "entries") {
      text = rows(sortEntries(file.entries), "  ");
    } else if (Array.isArray(value)) {
      text = rows(value, "  ");
    } else {
      text = JSON.stringify(value);
    }
    lines.push(`  ${JSON.stringify(section)}: ${text}`);
  }
  return `{\n${lines.join(",\n")}\n}\n`;
}

/**
 * How large one part may be, in rows, in bytes and in records. Tests make them
 * small. Records default to the cap rows share, which is what the server holds
 * each part to.
 */
export type LedgerFilePartLimits = { maxRows: number; maxBytes: number; maxRecords?: number };

const DEFAULT_PART_LIMITS: LedgerFilePartLimits = {
  maxRows: MAX_BULK_SELECTION_ENTRIES,
  maxBytes: LEDGER_FILE_PART_MAX_BYTES,
  maxRecords: MAX_BULK_SELECTION_ENTRIES,
};

export type LedgerFileSplit = { ok: true; parts: LedgerFile[] } | { ok: false; message: string };

/**
 * The bytes a string takes as UTF-8, counted rather than encoded, because the
 * splitter asks it of every row in a file that may hold a hundred thousand.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one character of four bytes, so count the pair once.
      bytes += 4;
      at++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * What a row costs beyond its own JSON once it is written into a list: up to
 * six spaces of indent, a comma and a newline. Rounded up, so the estimate can
 * only overstate a part, never understate it past the limit a server enforces.
 */
const ROW_OVERHEAD = 8;
/** What a list costs once it holds anything, against the `[]` it is when empty. */
const LIST_OVERHEAD = 16;

/**
 * Cut a file into parts an import can take one at a time.
 *
 * One import is at most ten thousand rows, the number every bulk action in this
 * product shares, so a ledger larger than that is applied in parts, each one
 * atomic on its own. The file stays one file to the person: this is what the
 * import page does with it, and what `AGENTS.md`'s cap list calls a ledger-file
 * part.
 *
 * - **Every part carries every record** — settings, groups, categories,
 *   accounts, templates, recurrences and budget plans. They are small, an
 *   import matches rather than duplicates them, and it means any part can be
 *   applied on its own, including the second one after the browser closed
 *   during the first.
 * - **Entries go in date order**, so a part never names a day earlier than
 *   one the part before it already wrote.
 * - **Budget amounts and staged rows come after every entry**, and so fill the
 *   last part or parts.
 * - **The balance checks travel only in the last part**, because a balance as
 *   of the file's last day is only true once every entry before it is in.
 * - **History is in no part**, because no import reads it.
 *
 * A file small enough to be one part comes back as one part. The only
 * refusals are a records section with more records than a part may carry or
 * too large for a part to hold, and a single row too large, which no row cut
 * can cure.
 */
export function splitLedgerFile(
  file: LedgerFile,
  limits: LedgerFilePartLimits = DEFAULT_PART_LIMITS,
): LedgerFileSplit {
  // Every part carries every record, so no row cut can bring a part under
  // this, and it is refused up front in the words the byte check uses.
  if (ledgerFileRecordCount(file) > (limits.maxRecords ?? MAX_BULK_SELECTION_ENTRIES)) {
    return {
      ok: false,
      message: `This file holds ${ledgerFileRecordCount(file).toLocaleString("en-US")} accounts, categories, groups, templates, recurring transactions and budgets, and one part of an import holds at most ${(limits.maxRecords ?? MAX_BULK_SELECTION_ENTRIES).toLocaleString("en-US")}. Every part carries all of them, so it cannot be sent in parts.`,
    };
  }
  const { history: _history, ...records } = file;
  const empty: LedgerFile = {
    ...records,
    budgets: { plans: file.budgets.plans, entries: [] },
    entries: [],
    staged: [],
  };
  // Measured with the balances in, and every part is held to it, so the last
  // part — the only one that carries them — cannot be the one that overflows.
  const room = limits.maxBytes - utf8Length(serializeLedgerFile(empty)) - LIST_OVERHEAD * 3;
  if (room <= 0) {
    return {
      ok: false,
      message:
        "This file's accounts, categories, templates and other records are larger on their own than one part of an import may be, so it cannot be sent in parts.",
    };
  }

  type Bucket = {
    entries: LedgerFileEntry[];
    budgetEntries: LedgerFileBudgetEntry[];
    staged: LedgerFileStagedRow[];
    rows: number;
    bytes: number;
  };
  const bucket = (): Bucket => ({ entries: [], budgetEntries: [], staged: [], rows: 0, bytes: 0 });
  const buckets: Bucket[] = [];
  let current = bucket();
  const place = <T>(row: T, into: (target: Bucket) => T[]) => {
    const bytes = utf8Length(JSON.stringify(row)) + ROW_OVERHEAD;
    if (bytes > room) return false;
    if (current.rows >= limits.maxRows || current.bytes + bytes > room) {
      buckets.push(current);
      current = bucket();
    }
    into(current).push(row);
    current.rows += 1;
    current.bytes += bytes;
    return true;
  };
  const tooLarge = (what: string): LedgerFileSplit => ({
    ok: false,
    message: `${what} is larger than one part of an import may be once the file's records are added, so this file cannot be sent in parts.`,
  });

  for (const entry of sortEntries(file.entries)) {
    if (!place(entry, (target) => target.entries)) {
      return tooLarge(`The entry dated ${entry.date} with ${entry.payee}`);
    }
  }
  for (const entry of file.budgets.entries) {
    if (!place(entry, (target) => target.budgetEntries)) {
      return tooLarge(`The budget amount for the period starting ${entry.periodStart}`);
    }
  }
  for (const row of file.staged) {
    if (!place(row, (target) => target.staged)) return tooLarge("One staged row");
  }
  buckets.push(current);

  // Earlier parts carry the accounts without their checks: the figures are
  // only true once the last part is in, and an import checks whatever balance
  // a part carries.
  const unchecked = file.accounts.map((account) => {
    if (account.detail !== "full") return account;
    const { balance: _balance, ...rest } = account;
    return rest;
  });
  const last = buckets.length - 1;
  return {
    ok: true,
    parts: buckets.map((part, at) => ({
      ...empty,
      accounts: at === last ? file.accounts : unchecked,
      budgets: { plans: file.budgets.plans, entries: part.budgetEntries },
      entries: part.entries,
      staged: part.staged,
    })),
  };
}

/**
 * What somebody asks an export for. One schema for the page, the route and the
 * tool, so an agent can ask for exactly what the page can and nothing more.
 *
 * There is no separate detail level, because each of the page's choices is
 * already a combination of these: "account details only" is `accounts` without
 * `entries`, "with all their transactions" adds `entries`, and "in a date
 * range" adds `start` and `end` as well.
 */
export const ledgerFileSelectionSchema = z
  .object({
    kinds: z
      .array(z.enum(ledgerFileKinds))
      .min(1, "Choose at least one kind of record to export")
      .describe(
        "Which kinds of record the file carries whole: preferences (the regional defaults and appearance from Settings: timezone, default currency and theme), categories (with their groups), accounts, entries (committed transactions), deletedEntries (deleted entries, which net to zero; needs entries), templates (with their reminders), recurrences, budgets (plans and per-period amounts), staged (rows waiting in Staged transactions) and history (the activity log, which no import reads back). A record of a kind left out still travels as a reference, by name, wherever something in the file names it. The browser's Export section, on Import and export, starts with every kind but history.",
      ),
    accountIds: z
      .array(uuid())
      .min(1, "Choose at least one account, or leave the accounts out to export them all")
      .max(MAX_LEDGER_FILE_ACCOUNT_CHOICES, {
        error: () =>
          `Choose at most ${MAX_LEDGER_FILE_ACCOUNT_CHOICES} accounts, or leave them out to export every one`,
      })
      .optional()
      .describe(
        "Export only these accounts, whole, with the entries that touch them — a transfer between two of them once, and the account on the far side of any other as a reference. Left out, every account is exported. With accounts chosen, kinds may name only accounts, categories, entries and deletedEntries, and categories narrows to the ones the exported entries name.",
      ),
    start: isoDateSchema
      .optional()
      .describe(
        "The first day the file covers: entries dated from it, and activity history from the start of it where the person lives. With entries, every whole account carries what its postings held the day before as carriedForward, whenever it was opened, so a file covering a range still adds up. Needs entries or history in kinds.",
      ),
    end: isoDateSchema
      .optional()
      .describe(
        "The last day the file covers, for entries and activity history alike. Left out, every entry is included, future-dated ones too. Each account's balance check is as of this day or today, whichever is earlier, and is left out when the range starts after today, because nothing in it has happened yet.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    const kinds = new Set(selection.kinds);
    const refuse = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (kinds.size !== selection.kinds.length) refuse("kinds", "Name each kind of record once");
    if (kinds.has("deletedEntries") && !kinds.has("entries")) {
      refuse("kinds", "Deleted entries travel with the entries, so ask for entries too");
    }
    if (
      (selection.start !== undefined || selection.end !== undefined) &&
      !kinds.has("entries") &&
      !kinds.has("history")
    ) {
      refuse(
        "start",
        "A date range narrows the entries and the activity history, so ask for one of them",
      );
    }
    if (
      selection.start !== undefined &&
      selection.end !== undefined &&
      selection.end < selection.start
    ) {
      refuse("end", "The range cannot end before it starts");
    }
    if (selection.accountIds === undefined) return;
    if (new Set(selection.accountIds).size !== selection.accountIds.length) {
      refuse("accountIds", "Choose each account once");
    }
    if (!kinds.has("accounts"))
      refuse("kinds", "Exporting chosen accounts needs accounts in kinds");
    for (const kind of kinds) {
      if (CHOSEN_ACCOUNT_KINDS.has(kind)) continue;
      refuse(
        "kinds",
        `Chosen accounts travel with their categories and entries; ${kind} travel with an export of everything`,
      );
    }
  });

export type LedgerFileSelection = z.infer<typeof ledgerFileSelectionSchema>;

/**
 * A selection as the query string the export route reads.
 *
 * Lists are comma-separated rather than repeated, because Hono keeps only the
 * first of a repeated parameter and `http.md` says so: `?kinds=a&kinds=b`
 * would quietly export `a` alone.
 */
export function ledgerFileQueryString(selection: LedgerFileSelection): string {
  const params = new URLSearchParams({ kinds: selection.kinds.join(",") });
  if (selection.accountIds) params.set("accountIds", selection.accountIds.join(","));
  if (selection.start) params.set("start", selection.start);
  if (selection.end) params.set("end", selection.end);
  return params.toString();
}

/**
 * The query string back into a selection for `ledgerFileSelectionSchema` to
 * judge. Only the two lists are split; anything else passes through untouched
 * so the strict schema can refuse a parameter nobody defined, by name, rather
 * than this dropping it.
 */
export function parseLedgerFileQuery(
  query: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const split = (value: string) =>
    value.trim() === "" ? [] : value.split(",").map((item) => item.trim());
  const { kinds, accountIds, ...rest } = query;
  return {
    ...rest,
    ...(kinds !== undefined ? { kinds: split(kinds) } : {}),
    ...(accountIds !== undefined ? { accountIds: split(accountIds) } : {}),
  };
}

/**
 * The name a downloaded file is saved under, dated by the day where the person
 * lives — the caller passes `todayIn(timezone)` — so a file made at nine in the
 * morning in Auckland does not carry yesterday's date.
 */
export function ledgerFileName(today: string, accounts: LedgerFileAccountScope): string {
  return accounts === "chosen"
    ? `simple-balance-accounts-${today}.json`
    : `simple-balance-${today}.json`;
}
