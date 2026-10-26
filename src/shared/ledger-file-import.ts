/**
 * Adding a Simple Balance file to a ledger that may already hold one: what a
 * file's records become here, what the person has to decide first, and the
 * request and replies that carry it.
 *
 * Shared, for the reason `AGENTS.md` gives first: a rule the browser previews
 * and the server enforces has to be one function, or the preview eventually
 * shows something the server refuses. The page runs `planLedgerFileAdd` over
 * the whole file each time somebody decides something, and the server runs it
 * again over each part, under the locks its writes will hold, before the first
 * write — and refuses with the very sentences the page showed.
 *
 * **What is decided here.** Records that are not transactions — groups,
 * categories, accounts, templates, recurring transactions, budgets — are
 * created right away when nothing like them is here. One that *is* already
 * here, under the same name once case and spacing are set aside, is the
 * person's to decide: use the one here, leave the file's out, or bring it in
 * under another name. Nothing is decided for them and nothing here is ever
 * overwritten. Transactions are not records in that sense: they go to Staged
 * like any import, and what decides each one is its origin, which the server
 * looks up. Moving a whole ledger straight into the books is a later step and
 * is not planned here.
 *
 * **Why records are compared in the file's own shape.** Whether a record here
 * is the same as the file's is asked of both in the form a file writes them —
 * the destination's records assembled by the very code that wrote the file. So
 * a record an earlier part of this import created reads as the same one when
 * the next part arrives, and importing a whole file a second time writes
 * nothing, without anybody keeping a list of what an import made.
 */
import { z } from "zod";
import {
  accountCreateSchema,
  atMost,
  budgetPlanCreateSchema,
  budgetPlanRefusal,
  categoryCreateSchema,
  categoryGroupCreateSchema,
  enter,
  idempotencyKeySchema,
  isoDateSchema,
  MAX_RECURRENCES,
  MAX_TRANSACTION_TEMPLATES,
  oneLine,
  recurrenceCreateSchema,
  themes,
  transactionTemplateCreateSchema,
  uuid,
  type CategoryKind,
} from "./domain.js";
import {
  LEDGER_FILE_FORMAT,
  LEDGER_FILE_PART_MAX_BYTES,
  ledgerFileSchema,
  ledgerRecordDetails,
  utf8Length,
  type LedgerFile,
  type LedgerFileAccount,
  type LedgerFileBudgetEntry,
  type LedgerFileBudgetPlan,
  type LedgerFileCategory,
  type LedgerFileEntry,
  type LedgerFileGroup,
  type LedgerFileRecurrence,
  type LedgerFileStagedRow,
  type LedgerFileTemplate,
  type LedgerRecordDetail,
} from "./ledger-file.js";
import { normalizeHumanName } from "./names.js";

/**
 * The kinds of record an import decides about, as a decision names them.
 *
 * Budgets are two kinds because they are decided differently: a plan is one
 * record, and the per-period amounts of one budget are decided together, since
 * asking somebody about each month of ten years one at a time is asking the
 * same question a hundred and twenty times.
 */
export const ledgerImportKinds = [
  "group",
  "category",
  "account",
  "template",
  "recurrence",
  "budget_plan",
  "budget_entry",
] as const;
export type LedgerImportKind = (typeof ledgerImportKinds)[number];

/**
 * What a record in the file meets here, before anybody has decided anything.
 *
 * - `create`: nothing here has its name, so it is created.
 * - `exists`: something here has its name and is the same in every field the
 *   file carries, so that one is used and nothing is written.
 * - `duplicate`: something here has its name and differs, or another record in
 *   the file has it too. The person decides.
 * - `refused`: it cannot come in as it stands — a recurring transaction whose
 *   account is not coming, a budget on a category that only takes income — and
 *   is left out with its reason. There is nothing to decide.
 * - `missing`: a reference, a record the file only names, that nothing here
 *   answers to. The person decides, except about a template, whose provenance
 *   is simply dropped.
 */
export const ledgerRecordOutcomes = [
  "create",
  "exists",
  "duplicate",
  "refused",
  "missing",
] as const;
export type LedgerRecordOutcome = (typeof ledgerRecordOutcomes)[number];

/**
 * What a person can decide.
 *
 * The first three answer a record the file carries whole that duplicates one
 * here; the last three a record the file only names. A new name is stated,
 * never invented: the importer chooses none on its own, because a name nobody
 * chose is a guess, and a guess never overwrites a decision.
 */
export const ledgerDecisionActions = [
  "use_existing",
  "skip",
  "rename",
  "match",
  "create",
  "leave_staged",
] as const;
export type LedgerDecisionAction = (typeof ledgerDecisionActions)[number];

/**
 * What becomes of a record once the decisions are in.
 *
 * `use` is a record here — the same one, one chosen, or one an earlier part of
 * this import made. `leave_staged` is a reference left to the review queue: the
 * entries naming it stage without that account, or carry the category by name
 * to be filed when they are committed. `drop` is a template reference nothing
 * answers to, which only ever named provenance. `undecided` is a question
 * still open, and a plan holding one is never carried out.
 */
export const ledgerPlannedActions = [
  "create",
  "use",
  "skip",
  "leave_staged",
  "drop",
  "refused",
  "undecided",
] as const;
export type LedgerPlannedAction = (typeof ledgerPlannedActions)[number];

/** What somebody says about the file's settings when this copy has chosen its own. */
export const ledgerPreferencesChoices = ["file", "keep"] as const;
export type LedgerPreferencesChoice = (typeof ledgerPreferencesChoices)[number];

/**
 * The most decisions one request may carry, and the most accounts it may ask
 * to arrive archived.
 *
 * A decision is at most one per record the file carries or names, and a file
 * with five thousand records in conflict has outgrown anything a person
 * decides one at a time. Both bound the request body as much as the work: the
 * server derives the import routes' body limit from them, so a request the
 * schema accepts is never one the transport turns away first.
 */
export const MAX_LEDGER_FILE_DECISIONS = 5_000;
export const MAX_LEDGER_FILE_ARRIVE_ARCHIVED = 1_000;

/**
 * How many parts one file may be cut into, as a part's own label says.
 *
 * A bound on a label rather than on any work: every part is capped on its own,
 * and the export that wrote the file is capped at a hundred thousand rows.
 */
export const MAX_LEDGER_FILE_PARTS = 1_000;

/**
 * A record's key as a decision names it. Longer than a file's own keys,
 * because a budget's is built from its target's key and the currency, period
 * and day that complete its identity.
 */
const decisionKeySchema = oneLine(
  z
    .string()
    .trim()
    .min(1, { error: () => "A key cannot be blank" })
    .max(400, atMost("A key", 400)),
).describe(
  "The record's key, exactly as the preview lists it: a record's key in the file, or the key the preview gives a budget.",
);

const decisionKindSchema = z
  .enum(ledgerImportKinds)
  .describe(
    "Which kind of record this decides about: group, category, account, template, recurrence, budget_plan, or budget_entry for the per-period amounts of one budget.",
  );

const newNameSchema = oneLine(
  z.string().trim().min(1, enter("a name")).max(160, atMost("A name", 160)),
);

/**
 * One decision about one record, keyed by its kind and its key.
 *
 * Every part of a file carries every record but one kind, so the same
 * decisions travel with every part. One about a record that needs none —
 * because an earlier part already created it — is passed over rather than
 * refused; one naming no record in the file is refused, because that is a key
 * somebody typed wrong. The kind a part carries only some of is a budget's
 * amounts, which the splitter cuts up like rows: a part without them has not
 * heard of a budget the part that holds them asks about, so a decision about
 * one is passed over there too, and a mistyped one surfaces as the real
 * budget's open question in the part that has it.
 */
export const ledgerFileDecisionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("use_existing")
          .describe(
            "Use the record of that name already here. Whatever the file files under its own lands under this one.",
          ),
      })
      .strict(),
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("skip")
          .describe(
            "Leave the file's record out. Entries naming a skipped account stage without it, ones naming a skipped category stage uncategorized, the categories in a skipped group come in without one, and a budget or recurring transaction that needed it is left out with its reason. For a budget's per-period amounts it leaves every one of them out, the new periods included.",
          ),
      })
      .strict(),
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("rename")
          .describe(
            "Bring the file's record in as a new one under another name. Everything in the file that names it follows it to the new name.",
          ),
        name: newNameSchema.describe(
          "The new name. Nothing of this kind here, or coming in with this file, may already go by it once case and spacing are set aside.",
        ),
      })
      .strict(),
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("match")
          .describe(
            "For a record the file only names: use this record here instead. An account has to be in the same currency.",
          ),
        id: uuid().describe("The id of the record here to use, from its list."),
      })
      .strict(),
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("create")
          .describe(
            "For a record the file only names: create it from what the file says about it. An account created this way opens at zero, so its balance is only what the file's entries move.",
          ),
        name: newNameSchema
          .optional()
          .describe("Another name to create it under, needed only when its own is taken here."),
        openingDate: isoDateSchema
          .optional()
          .describe(
            "For an account only: the day it opens, which is otherwise the earliest entry naming it in this part. A file sent in parts sends the earliest across every part, so the account opens on the same day whichever part creates it.",
          ),
      })
      .strict(),
    z
      .object({
        kind: decisionKindSchema,
        key: decisionKeySchema,
        action: z
          .literal("leave_staged")
          .describe(
            "For an account or a category the file only names: leave it for review. Entries naming an account stage without that side, and entries naming a category carry it by name to be filed when they are committed. A group cannot be left for review, since nothing staged names one; skip it instead.",
          ),
      })
      .strict(),
  ])
  .describe(
    "One decision about one record the preview says needs one. Send the same decisions with every part of a file.",
  );
export type LedgerFileDecision = z.infer<typeof ledgerFileDecisionSchema>;

/**
 * A file, or one part of one, as the text the export wrote.
 *
 * Text rather than structured content, for the reason the export tool returns
 * text: the bytes an import checks are the bytes that were exported, and an
 * agent passing a file on does not have to carry the whole format in a schema
 * to do it. The size is checked in UTF-8 here, because the part limit is what
 * the server's body limit for these routes is derived from.
 */
const ledgerFileTextSchema = z
  .string()
  .min(1, { error: () => "Choose a Simple Balance file" })
  .refine((text) => utf8Length(text) <= LEDGER_FILE_PART_MAX_BYTES, {
    error: () =>
      `One part of a Simple Balance file is at most ${LEDGER_FILE_PART_MAX_BYTES / (1024 * 1024)} MiB. A larger file goes in parts, each a file of its own, which the import page cuts for you.`,
  })
  .describe(
    `A Simple Balance file (${LEDGER_FILE_FORMAT}), or one part of one, exactly as export_ledger_file returned it. A part is at most 10,000 entries, staged rows and budget amounts together, which is what one export call returns, so a file from export_ledger_file is always one part.`,
  );

/** What the preview reads: the file, and nothing decided yet. */
export const ledgerFilePreviewInputSchema = z.object({ ledgerFile: ledgerFileTextSchema }).strict();

/**
 * Adding one part of a file to this ledger.
 *
 * Every part carries every record, so `decisions`, `arriveArchived` and
 * `preferences` are the same on every part, and a part they do not apply to
 * passes over them. `idempotencyKey` is one per part: a retry of a part
 * replays it, and the next part is a different request.
 */
export const ledgerFileAddInputSchema = z
  .object({
    ledgerFile: ledgerFileTextSchema,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .describe(
        "What the file was called. Recorded on the import batch its entries stage under, so somebody can tell one import from another later.",
      ),
    idempotencyKey: idempotencyKeySchema,
    part: z
      .object({
        index: z.number().int().min(1).describe("Which part this is, counting from 1."),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEDGER_FILE_PARTS)
          .describe("How many parts the file was cut into."),
      })
      .strict()
      .refine((part) => part.index <= part.count, {
        error: () => "A part's number cannot be more than the number of parts",
        path: ["index"],
      })
      .default({ index: 1, count: 1 })
      .describe(
        "Which part of the file this is. Left out, the file is one part. Each part is applied on its own and all at once; the file as a whole is not.",
      ),
    decisions: z
      .array(ledgerFileDecisionSchema)
      .max(MAX_LEDGER_FILE_DECISIONS)
      .default([])
      .describe(
        "What to do with each record the preview says needs a decision. A new record is created, and one already here in the same form is used, with nothing to decide.",
      ),
    arriveArchived: z
      .array(decisionKeySchema)
      .max(MAX_LEDGER_FILE_ARRIVE_ARCHIVED)
      .default([])
      .describe(
        "Keys of new accounts to create archived, so they use no place on a plan that limits how many accounts are in use. Needed when the preview says more accounts are coming than there are places; none is chosen for you. Their entries still stage, and wait in Staged until the account is restored into a free place. Accounts archived where the file came from arrive archived anyway.",
      ),
    preferences: z
      .enum(ledgerPreferencesChoices)
      .optional()
      .describe(
        "file or keep. Needed only when this copy has chosen its own regional settings and the file's differ. file replaces the timezone, default currency and theme chosen here, and the timezone decides what today means, so confirm it with the person; keep leaves them alone. Where nothing was chosen here the file's are used, and otherwise this is passed over.",
      ),
  })
  .strict();
export type LedgerFileAddInput = z.infer<typeof ledgerFileAddInputSchema>;

const keyIdsSchema = z.record(z.string(), uuid());

/**
 * The destination's own records in the form a file writes them, with the id
 * each key stands for. The server builds this with the exporter's own
 * assembly, so a record here and a record in a file are compared shape for
 * shape.
 *
 * `inUse` on an account is whether it holds a place right now, which is what
 * the arithmetic of places counts. `limit` is how many places the plan in
 * force keeps, or null where nothing limits them.
 */
export const ledgerFileHereSchema = z
  .object({
    groups: ledgerFileSchema.shape.groups,
    categories: ledgerFileSchema.shape.categories,
    accounts: ledgerFileSchema.shape.accounts,
    templates: ledgerFileSchema.shape.templates,
    recurrences: ledgerFileSchema.shape.recurrences,
    budgets: ledgerFileSchema.shape.budgets,
    ids: z
      .object({
        group: keyIdsSchema,
        category: keyIdsSchema,
        account: keyIdsSchema,
        template: keyIdsSchema,
        recurrence: keyIdsSchema,
      })
      .strict(),
    limit: z.number().int().positive().nullable(),
    preferences: z
      .object({
        chosen: z
          .boolean()
          .describe(
            "Whether somebody here chose these settings rather than being given the defaults. The file's are applied only where nobody did, unless preferences says file.",
          ),
        timezone: z.string(),
        defaultCurrency: z.string(),
        theme: z.enum(themes),
      })
      .strict(),
  })
  .strict()
  .describe(
    "This ledger's own records, in the form a Simple Balance file writes them, with the id each key stands for: what every record in the file is compared with.",
  );
export type LedgerFileHere = z.infer<typeof ledgerFileHereSchema>;

/**
 * What one preview reads from the database. Everything else a preview says is
 * worked out from the file and this, by `planLedgerFileAdd`, on both ends.
 */
export const ledgerFileFactsSchema = z
  .object({
    here: ledgerFileHereSchema,
    rows: z
      .object({
        alreadyHere: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Live entries in the file whose origin is already in this ledger — as an entry, deleted ones included, or as a row waiting in Staged — which are skipped rather than staged again.",
          ),
        stagedAlreadyHere: z
          .number()
          .int()
          .nonnegative()
          .describe("Staged rows in the file whose origin is already here, skipped the same way."),
      })
      .strict(),
    move: z
      .object({
        qualifies: z
          .boolean()
          .describe(
            "Whether every entry and waiting staged row in this ledger came from a Simple Balance file, which is when a whole ledger may be moved straight into the books. Adding is the only import offered today.",
          ),
        reason: z
          .string()
          .nullable()
          .describe("Why it does not qualify, as a sentence, or null when it does."),
      })
      .strict(),
  })
  .strict();
export type LedgerFileFacts = z.infer<typeof ledgerFileFactsSchema>;

const problemCount = z.number().int().nonnegative().optional();

/**
 * A problem with a request, the record it is about when it is about one, and
 * every number its sentence says, as a field (http.md: a client should never
 * have to parse a sentence to learn a number).
 */
const planProblemSchema = z
  .object({
    field: z.string(),
    message: z.string(),
    kind: z.enum(ledgerImportKinds).optional(),
    key: z.string().optional(),
    limit: problemCount.describe("The most the ledger or the plan keeps."),
    current: problemCount.describe("How many it holds now."),
    arriving: problemCount.describe("New accounts that would take a place."),
    needed: problemCount.describe("How many of those have to arrive archived."),
    chosen: problemCount.describe("How many are named in arriveArchived."),
    more: problemCount.describe("How many the file brings."),
    over: problemCount.describe("How many past the limit that would be."),
    conflict: problemCount.describe("Budget periods that already hold a different amount here."),
  })
  .strict();
export type LedgerFilePlanProblem = z.infer<typeof planProblemSchema>;
type ProblemNumbers = Omit<LedgerFilePlanProblem, "field" | "message" | "kind" | "key">;

const plannedRecordSchema = z
  .object({
    kind: z.enum(ledgerImportKinds),
    key: z.string().describe("The key a decision names this record by."),
    name: z.string(),
    detail: z
      .enum(ledgerRecordDetails)
      .describe("Whether the file carries the record whole, or only names it."),
    outcome: z.enum(ledgerRecordOutcomes),
    existing: z
      .object({ key: z.string(), id: uuid(), name: z.string() })
      .strict()
      .nullable()
      .describe("The record here it is the same as or collides with, when there is one."),
    copy: z
      .object({ key: z.string(), id: uuid(), name: z.string() })
      .strict()
      .nullable()
      .describe(
        "For a record that collides by name: the one record here under another name that is the same as the file's in every field, which is what an earlier import brought in renamed. Bringing the file's in under that name uses it rather than making a second copy.",
      ),
    choices: z
      .array(z.enum(ledgerDecisionActions))
      .describe("The decisions it takes, and empty when it needs none."),
    message: z.string().nullable(),
    rows: z
      .number()
      .int()
      .nonnegative()
      .describe("Entries and staged rows in the file that name it."),
    action: z.enum(ledgerPlannedActions),
    importName: z
      .string()
      .nullable()
      .describe("The name it is created or used under here, or null when it is not coming in."),
    id: uuid()
      .nullable()
      .describe(
        "The record here it resolves to, or the one created for it once a part has added it.",
      ),
    arrivesArchived: z.boolean(),
    periods: z
      .object({
        create: z.number().int().nonnegative(),
        exists: z.number().int().nonnegative(),
        conflict: z.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .describe(
        "For a budget's per-period amounts: how many are new, already here, and different here.",
      ),
  })
  .strict();
export type LedgerFilePlannedRecord = z.infer<typeof plannedRecordSchema>;

/**
 * What adding a file would do, and what still stops it.
 *
 * `ok` is false while any problem is listed, and a request with a problem
 * writes nothing at all. Each problem is a sentence somebody can act on, about
 * a record by kind and key where it is about one.
 */
export const ledgerFilePlanSchema = z
  .object({
    ok: z.boolean(),
    problems: z.array(planProblemSchema),
    records: z.array(plannedRecordSchema),
    counts: z
      .record(z.enum(ledgerImportKinds), z.record(z.enum(ledgerPlannedActions), z.number().int()))
      .describe(
        "For each kind, how many of its records each action takes: what the preview's table adds up. A budget's per-period amounts are counted one period at a time.",
      ),
    places: z
      .object({
        limit: z.number().int().positive().nullable(),
        inUse: z.number().int().nonnegative(),
        arriving: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "New accounts that would take a place, before any is chosen to arrive archived.",
          ),
        needed: z
          .number()
          .int()
          .nonnegative()
          .describe("How many of those have to arrive archived for the rest to fit."),
        chosen: z
          .number()
          .int()
          .nonnegative()
          .describe("How many of those are named in arriveArchived."),
      })
      .strict(),
    preferences: z
      .object({
        inFile: z.boolean(),
        chosenHere: z.boolean(),
        differs: z.boolean(),
        action: z.enum(["apply", "keep", "none", "undecided"]),
      })
      .strict(),
    rows: z
      .object({
        entries: z.number().int().nonnegative(),
        deleted: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Deleted entries in the file, which adding never brings: a row in Staged cannot be voided money.",
          ),
        staged: z.number().int().nonnegative(),
        alreadyHere: z.number().int().nonnegative(),
        stagedAlreadyHere: z.number().int().nonnegative(),
        toStage: z.number().int().nonnegative(),
        postedAsDiffers: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Entries whose other half will land on the other side of the books from where it landed in the ledger they came from, because a category's kind changed after they were written.",
          ),
      })
      .strict(),
  })
  .strict();
export type LedgerFilePlan = z.infer<typeof ledgerFilePlanSchema>;

/** The preview: what was read about the destination, and the plan with nothing decided yet. */
export const ledgerFilePreviewSchema = ledgerFileFactsSchema.extend({ plan: ledgerFilePlanSchema });
export type LedgerFilePreview = z.infer<typeof ledgerFilePreviewSchema>;

/**
 * What one part did: the plan it carried out, with the id of every record it
 * created filled in, beside what it staged.
 */
export const ledgerFileAddResultSchema = z
  .object({
    part: z.object({ index: z.number().int(), count: z.number().int() }).strict(),
    importBatchId: uuid()
      .nullable()
      .describe(
        "The batch this part's rows were staged under, which Staged can be filtered by. Null when the part staged nothing.",
      ),
    staged: z
      .number()
      .int()
      .nonnegative()
      .describe("Rows this part put in Staged: its entries, and its own staged rows."),
    needsReview: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Of those, rows staged with an issue — an account left for review, an archived account or category, a possible duplicate — which need somebody before they can be committed.",
      ),
    budgetEntries: z
      .object({
        created: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict(),
    plan: ledgerFilePlanSchema,
  })
  .strict();
export type LedgerFileAddResult = z.infer<typeof ledgerFileAddResultSchema>;

// ---------------------------------------------------------------------------
// Keys for the records that have no name of their own.
// ---------------------------------------------------------------------------

type BudgetTarget = { kind: "category"; key: string } | { kind: "group"; key: string };

const budgetTargetOf = (row: { category?: string; group?: string }): BudgetTarget =>
  row.category !== undefined
    ? { kind: "category", key: row.category }
    : { kind: "group", key: row.group ?? "" };

/**
 * The key a budget's per-period amounts are decided under: what it is about,
 * in which currency, by which period. Every amount of one budget shares it.
 */
export function ledgerBudgetKey(
  row: Pick<LedgerFileBudgetEntry, "category" | "group" | "currency" | "periodUnit">,
): string {
  const target = budgetTargetOf(row);
  return `${target.kind}:${target.key}|${row.currency}|${row.periodUnit}`;
}

/** A plan's key: its budget's, and the first period it covers, which together make it one. */
export function ledgerBudgetPlanKey(plan: LedgerFileBudgetPlan): string {
  return `${ledgerBudgetKey(plan)}|${plan.activeFrom}`;
}

// ---------------------------------------------------------------------------
// Money as text, without a float anywhere.
// ---------------------------------------------------------------------------

const SCALE = 18;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string in the form the API writes one: no trailing zeros, no point
 * with nothing after it, and no negative zero. Two amounts are the same amount
 * exactly when this makes them the same text, which is what lets a figure read
 * back from the database — `12.500000000000000000` — be compared with the
 * `12.5` a file carries. Anything that is not a decimal comes back as it was.
 */
export function canonicalDecimalText(value: string): string {
  const match = DECIMAL.exec(value.trim());
  if (!match) return value;
  const [, sign, whole, fraction = ""] = match;
  const integer = whole!.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  const text = decimals ? `${integer}.${decimals}` : integer;
  return text === "0" ? "0" : `${sign}${text}`;
}

const toUnits = (value: string): bigint => {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Not a decimal string: ${value}`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > SCALE) throw new Error(`More than ${SCALE} decimal places: ${value}`);
  const units = BigInt(whole! + fraction.padEnd(SCALE, "0"));
  return sign ? -units : units;
};

const fromUnits = (units: bigint): string => {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(SCALE + 1, "0");
  return canonicalDecimalText(
    `${negative ? "-" : ""}${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`,
  );
};

/**
 * Two decimal strings added exactly, in integer units of the ledger's own
 * eighteen places, so no binary float holds money on the way. The same way
 * `sumsExactly` in `domain.ts` checks a split, for the same reason.
 */
export function addDecimalText(left: string, right: string): string {
  return fromUnits(toUnits(left) + toUnits(right));
}

const subtractDecimalText = (left: string, right: string): string =>
  fromUnits(toUnits(left) - toUnits(right));

// ---------------------------------------------------------------------------
// A file's records as the API's own create inputs.
// ---------------------------------------------------------------------------

/**
 * What a key resolves to when something is written: the id of a record here,
 * a category to file by name when an entry is committed, or nothing.
 */
export type LedgerRefTarget = { id: string } | { name: string; kind: CategoryKind } | null;
/** The kinds of record something in a file can name, and so the ones a key resolves for. */
export type LedgerReferenceKind = "group" | "category" | "account" | "template";
export type LedgerRefResolver = (kind: LedgerReferenceKind, key: string) => LedgerRefTarget;

const idOf = (target: LedgerRefTarget): string | undefined =>
  target !== null && "id" in target ? target.id : undefined;

const present = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === undefined || value === null ? {} : { [key]: value }) as Partial<Record<K, V>>;

const named = (value: unknown) => value !== undefined && value !== null;

/**
 * A category named by key, as the fields a draft files it with: its id, or —
 * for one left for review — its name and the kind a commit should create it
 * as, which is the `categoryKind` rule in `AGENTS.md`: the direction alone gets
 * a new refund category wrong. Nothing when the draft already names a
 * category by name of its own, which a draft may, and which wins only where no
 * id is given. `withKind` is false for a template, whose draft has no kind.
 */
function categoryFields(
  key: string | null | undefined,
  ref: LedgerRefResolver,
  withKind: boolean,
  alreadyNamed: boolean,
): Record<string, unknown> {
  if (key === undefined || key === null) return {};
  const target = ref("category", key);
  if (target === null) return {};
  if ("id" in target) return { categoryId: target.id };
  if (alreadyNamed) return {};
  return withKind
    ? { categoryName: target.name, categoryKind: target.kind }
    : { categoryName: target.name };
}

const accountId = (ref: LedgerRefResolver, key: string | null | undefined) =>
  key === undefined || key === null ? undefined : idOf(ref("account", key));

/**
 * The day and the figure an account opens with here.
 *
 * Without a carried-forward balance, the file's own. With one — a file whose
 * entries start partway through — an account opened before the range opens on
 * its first day at what it held the day before, which is what the format's
 * standard says. One opened inside the range keeps its own opening day, and the
 * money dated before the range, which no entry carries, is added to its
 * opening balance. An account has one opening, so of the two figures one has
 * to move, and moving the money keeps the day the person sees on the account
 * and makes every balance from it on — the check at the end included — exact.
 * What it gives up is the stretch between the range's start and the opening,
 * where the account shows the range's entries without that earlier money, and
 * only an account whose money predates its own opening has one.
 */
export function ledgerAccountOpening(account: Extract<LedgerFileAccount, { detail: "full" }>): {
  openingDate: string;
  openingBalance: string;
} {
  const carried = account.carriedForward ?? null;
  if (carried === null) {
    return {
      openingDate: account.openingDate,
      openingBalance: canonicalDecimalText(account.openingBalance),
    };
  }
  if (account.openingDate < carried.date) {
    return { openingDate: carried.date, openingBalance: canonicalDecimalText(carried.amount) };
  }
  return {
    openingDate: account.openingDate,
    openingBalance: addDecimalText(account.openingBalance, carried.amount),
  };
}

const entryAccounts = (entry: LedgerFileEntry): string[] =>
  entry.type === "deposit"
    ? [entry.to]
    : entry.type === "withdrawal"
      ? [entry.from]
      : [entry.from, entry.to];

/**
 * The day an account created from a reference opens, at zero: the earliest
 * live row in the file that names it, or the file's own last day when none
 * does. A reference carries no opening of its own, so the account's balance
 * is only ever what the entries move, and the preview says so.
 */
export function ledgerReferenceOpeningDate(file: LedgerFile, key: string): string {
  let earliest: string | null = null;
  const consider = (date: unknown) => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (earliest === null || date < earliest) earliest = date;
  };
  for (const entry of file.entries) {
    if (!entry.deleted && entryAccounts(entry).includes(key)) consider(entry.date);
  }
  for (const row of file.staged) {
    if (row.draft.from === key || row.draft.to === key) consider(row.draft.date);
  }
  return earliest ?? file.throughDate;
}

export function ledgerGroupInput(group: LedgerFileGroup, name: string) {
  return { name, policy: group.policy };
}

export function ledgerCategoryInput(
  category: LedgerFileCategory,
  name: string,
  ref: LedgerRefResolver,
) {
  return {
    name,
    kind: category.kind,
    groupId: category.group === null ? null : (idOf(ref("group", category.group)) ?? null),
  };
}

/**
 * `openingDate` is the one a decision sent, for an account the file only
 * names: the page works it out over the whole file, because the part that
 * creates the account need not hold the entry that names it first.
 */
export function ledgerAccountInput(
  account: LedgerFileAccount,
  name: string,
  file: LedgerFile,
  openingDate?: string,
) {
  if (account.detail === "reference") {
    return {
      name,
      type: account.type,
      currency: account.currency,
      openingDate: openingDate ?? ledgerReferenceOpeningDate(file, account.key),
      openingBalance: "0",
    };
  }
  return {
    name,
    type: account.type,
    currency: account.currency,
    ...ledgerAccountOpening(account),
    ...present("institution", account.institution),
    ...present("notes", account.notes),
    inBudget: account.inBudget,
  };
}

/** A draft's or a shape's legs with their category keys turned into what files them here. */
function legsFor<T extends { category?: string | null; categoryName?: unknown }>(
  legs: readonly T[],
  ref: LedgerRefResolver,
  withKind: boolean,
) {
  return legs.map(({ category, ...leg }) => ({
    ...leg,
    ...categoryFields(category, ref, withKind, named(leg.categoryName)),
  }));
}

/**
 * A template as `createTransactionTemplate` takes it, with the reminder's
 * watermark beside it rather than inside it: a create ignores the field, and
 * the server seeds it through the import's own option, so a one-time reminder
 * the source already sent is not sent again.
 *
 * A reference that resolves to nothing is left out of the draft, which is what
 * a template naming a deleted account already looks like.
 */
export function ledgerTemplateInput(
  template: Extract<LedgerFileTemplate, { detail: "full" }>,
  name: string,
  ref: LedgerRefResolver,
) {
  const { from, to, category, legs, ...rest } = template.draft;
  const draft = {
    ...rest,
    ...present("fromAccountId", accountId(ref, from)),
    ...present("toAccountId", accountId(ref, to)),
    ...categoryFields(category, ref, false, named(rest.categoryName)),
    ...(legs === undefined ? {} : { legs: legsFor(legs, ref, false) }),
  };
  const notification = template.notification ?? null;
  if (notification === null) {
    return { input: { name, draft, notification: null }, lastNotifiedDate: null };
  }
  const {
    lastNotifiedDate,
    repeats: _repeats,
    nextNotificationDate: _next,
    ...rule
  } = notification;
  return {
    input: { name, draft, notification: rule },
    lastNotifiedDate: lastNotifiedDate ?? null,
  };
}

/**
 * A recurring transaction as `createRecurrence` takes it, with the last
 * occurrence it decided beside it: the import starts it proposing after that
 * day, and never before the day it lands, so arriving on a day that is itself
 * an occurrence does not propose it twice.
 */
export function ledgerRecurrenceInput(
  recurrence: LedgerFileRecurrence,
  name: string,
  ref: LedgerRefResolver,
) {
  const { category, legs, ...rest } = recurrence.shape;
  const { from, to, ...fields } = rest as typeof rest & { from?: string; to?: string };
  const shape = {
    ...fields,
    ...present("fromAccountId", accountId(ref, from)),
    ...present("toAccountId", accountId(ref, to)),
    ...categoryFields(category, ref, true, named(fields.categoryName)),
    ...(legs === undefined ? {} : { legs: legsFor(legs, ref, false) }),
  };
  return {
    input: {
      name,
      shape,
      schedule: recurrence.schedule,
      notifyOnCreate: recurrence.notifyOnCreate,
    },
    lastOccurrenceDate: recurrence.lastOccurrenceDate,
  };
}

function budgetTargetIds(row: { category?: string; group?: string }, ref: LedgerRefResolver) {
  return row.category !== undefined
    ? { categoryId: idOf(ref("category", row.category)) }
    : { groupId: idOf(ref("group", row.group ?? "")) };
}

/** A plan as `createBudgetPlan` takes it. `amount_rule` is derived there and never sent. */
export function ledgerBudgetPlanInput(plan: LedgerFileBudgetPlan, ref: LedgerRefResolver) {
  const { category: _category, group: _group, ...fields } = plan;
  return { ...budgetTargetIds(plan, ref), ...fields };
}

/** One period's amount as `setBudgetEntry` takes it: a new row, so no version. */
export function ledgerBudgetEntryInput(entry: LedgerFileBudgetEntry, ref: LedgerRefResolver) {
  const { category: _category, group: _group, ...fields } = entry;
  return { ...budgetTargetIds(entry, ref), ...fields };
}

/**
 * An entry as the staged draft it arrives as: complete wherever every
 * reference resolves — both sides of a transfer included, so a transfer in two
 * accounts' files stages whole the first time and is skipped by its origin the
 * second — and partial, keeping every side that is known, where one does not.
 * Both amounts of a transfer travel, so a conversion arrives with the two
 * figures that actually moved and its rate is worked out here.
 *
 * Never called for a deleted entry, which adding does not bring.
 */
export function ledgerEntryDraft(
  entry: LedgerFileEntry,
  ref: LedgerRefResolver,
): Record<string, unknown> {
  const common = {
    type: entry.type,
    date: entry.date,
    payee: entry.payee,
    ...present("description", entry.description),
    ...present("notes", entry.notes),
    ...present("externalId", entry.externalId),
    ...present(
      "templateId",
      entry.template === undefined ? undefined : idOf(ref("template", entry.template)),
    ),
  };
  if (entry.type === "transfer") {
    return {
      ...common,
      ...present("fromAccountId", accountId(ref, entry.from)),
      ...present("toAccountId", accountId(ref, entry.to)),
      sourceAmount: entry.sourceAmount,
      destinationAmount: entry.destinationAmount,
      ...categoryFields(entry.category, ref, true, false),
    };
  }
  return {
    ...common,
    ...(entry.type === "deposit"
      ? present("toAccountId", accountId(ref, entry.to))
      : present("fromAccountId", accountId(ref, entry.from))),
    amount: entry.amount,
    ...categoryFields(entry.category, ref, true, false),
    ...(entry.legs === undefined
      ? {}
      : {
          legs: entry.legs.map((leg) => ({
            ...(leg.category === null
              ? { categoryId: null }
              : categoryFields(leg.category, ref, true, false)),
            amount: leg.amount,
            ...present("note", leg.note),
          })),
        }),
  };
}

/**
 * A staged row from the file as the staged draft it waits as again: every
 * field the queue kept, with its keys turned back into ids where they resolve
 * and left out where they do not, which is what the row would hold had the
 * record been deleted while it waited.
 */
export function ledgerStagedDraft(
  row: LedgerFileStagedRow,
  ref: LedgerRefResolver,
): Record<string, unknown> {
  const { from, to, category, template, legs, ...rest } = row.draft;
  return {
    ...rest,
    ...present("fromAccountId", accountId(ref, from)),
    ...present("toAccountId", accountId(ref, to)),
    ...categoryFields(category, ref, true, named(rest.categoryName)),
    ...present(
      "templateId",
      template === undefined || template === null ? undefined : idOf(ref("template", template)),
    ),
    ...(legs === undefined || legs === null ? {} : { legs: legsFor(legs, ref, true) }),
  };
}

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

type Named = "group" | "category" | "account" | "template" | "recurrence";

const LABEL: Record<LedgerImportKind, string> = {
  group: "category group",
  category: "category",
  account: "account",
  template: "template",
  recurrence: "recurring transaction",
  budget_plan: "budget",
  budget_entry: "budget",
};

const A_LABEL: Record<Named, string> = {
  group: "a category group",
  category: "a category",
  account: "an account",
  template: "a template",
  recurrence: "a recurring transaction",
};

/** Each kind's own name rule, so a new name is refused in the sentence a create would give. */
const NAME_SCHEMA: Record<Named, z.ZodType<string>> = {
  group: categoryGroupCreateSchema.shape.name,
  category: categoryCreateSchema.shape.name,
  account: accountCreateSchema.shape.name,
  template: transactionTemplateCreateSchema.shape.name,
  recurrence: recurrenceCreateSchema.shape.name,
};

const CHOICE_WORDS: Record<LedgerDecisionAction, string> = {
  use_existing: "use the one here",
  skip: "leave the file's out",
  rename: "bring it in under another name",
  match: "use one here instead",
  create: "create it",
  leave_staged: "leave what names it for review in Staged",
};

/**
 * A budget's amounts are many periods under one question, so "the one here"
 * is the amounts here for the periods that differ, and leaving the file's out
 * is all of them, the new ones too.
 */
const BUDGET_AMOUNT_WORDS: Partial<Record<LedgerDecisionAction, string>> = {
  use_existing: "keep the amounts here and add the new ones",
  skip: "leave all of the file's amounts out",
};

const choiceWords = (kind: LedgerImportKind, choice: LedgerDecisionAction) =>
  (kind === "budget_entry" ? BUDGET_AMOUNT_WORDS[choice] : undefined) ?? CHOICE_WORDS[choice];

/** The words a category's kind is said in. */
const KIND_WORDS: Record<CategoryKind, string> = {
  income: "only income",
  expense: "only spending",
  both: "income and spending",
};

/** "a, b or c", the way a sentence here names a short list. */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const fold = (name: string) => normalizeHumanName(name);
const foldOrNull = (name: string | null | undefined) =>
  name === null || name === undefined ? null : fold(name);
const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    ? null
    : value;

type HereEntry = { kind: Named; key: string; name: string; id: string; record: unknown };

type Planned = LedgerFilePlannedRecord & {
  /** The file's record, for the comparisons and the inputs. */
  record: unknown;
  hereEntry: HereEntry | null;
};

const recordId = (kind: string, key: string) => `${kind}\u0000${key}`;

/**
 * Stable text for a comparison: keys in order, absent and null alike. Two
 * records are the same exactly when this is.
 */
function comparable(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (node === undefined || node === null) return null;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as object).sort()) {
        const child = walk((node as Record<string, unknown>)[key]);
        if (child !== null) out[key] = child;
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

const SIDES = new Set(["to", "from"]);
const MONEY_FIELDS = new Set([
  "amount",
  "destinationAmount",
  "sourceAmount",
  "rolloverCap",
  "targetAmount",
  "percentOfPrevious",
  "percentOfIncome",
]);

type Names = { account(key: string): string | null; category(key: string): string | null };

/**
 * A draft or a shape with every reference turned into the folded name of what
 * it resolves to and every amount into canonical text, so the file's record
 * and the one here compare by what they mean rather than by their keys, which
 * two ledgers assign independently.
 */
function portable(node: Record<string, unknown>, names: Names): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(node)) {
    if (SIDES.has(field)) {
      out[field] = typeof value === "string" ? foldOrNull(names.account(value)) : null;
    } else if (field === "category") {
      out[field] = typeof value === "string" ? foldOrNull(names.category(value)) : null;
    } else if (field === "legs" && Array.isArray(value)) {
      out[field] = value.map((leg) => portable(leg as Record<string, unknown>, names));
    } else if (MONEY_FIELDS.has(field) && typeof value === "string") {
      out[field] = canonicalDecimalText(value);
    } else {
      out[field] = blank(value);
    }
  }
  return out;
}

/** A reminder's rule without the three fields the scheduler owns. */
function reminderRule(notification: unknown) {
  if (notification === undefined || notification === null) return null;
  const {
    lastNotifiedDate: _sent,
    nextNotificationDate: _next,
    repeats: _repeats,
    ...rule
  } = notification as Record<string, unknown>;
  return rule;
}

export type LedgerFilePlanInput = {
  /** The file, or the part of one, being planned. */
  readonly file: LedgerFile;
  readonly facts: LedgerFileFacts;
  readonly decisions?: readonly LedgerFileDecision[];
  readonly arriveArchived?: readonly string[];
  readonly preferences?: LedgerPreferencesChoice | undefined;
};

/** One period's budget amount: written, or passed over. */
export type LedgerBudgetEntryAction = "create" | "skip";

export type LedgerFilePlanned = {
  /** The plan as the preview and the result carry it. */
  readonly plan: LedgerFilePlan;
  /** One period's budget amount: whether it is written or passed over. */
  budgetEntryAction(entry: LedgerFileBudgetEntry): LedgerBudgetEntryAction;
  /**
   * What a key resolves to while a part is being written: a record here, a
   * record this write created — looked up in `created`, keyed by
   * `ledgerCreatedKey` — a category left to be filed by name, or nothing.
   */
  resolve(
    kind: LedgerReferenceKind,
    key: string,
    created: ReadonlyMap<string, string>,
  ): LedgerRefTarget;
};

/**
 * The key a created record's id is kept under while a part is written, so
 * `resolve` finds what an earlier step of the same write made.
 */
export function ledgerCreatedKey(kind: LedgerImportKind, key: string): string {
  return recordId(kind, key);
}

/**
 * What adding this file would do to this ledger, given what somebody has
 * decided so far.
 *
 * Pure, and the same on both ends. The page calls it over the whole file each
 * time a choice changes; the server calls it over one part under the locks
 * the writes will hold, then carries out exactly what it says, or refuses
 * with its problems. A plan with a problem is never carried out in part.
 *
 * Records are planned in the order they can name each other — groups,
 * categories, accounts, templates, recurring transactions, then budgets —
 * because whether a category here is the same as the file's depends on what
 * its group became, and whether a budget can come at all depends on what its
 * category did.
 */
export function planLedgerFileAdd(input: LedgerFilePlanInput): LedgerFilePlanned {
  const { file, facts } = input;
  const here = facts.here;
  const problems: LedgerFilePlanProblem[] = [];
  const problem = (
    field: string,
    message: string,
    kind?: LedgerImportKind,
    key?: string,
    numbers: ProblemNumbers = {},
  ) =>
    problems.push({
      field,
      message,
      ...(kind === undefined ? {} : { kind }),
      ...(key === undefined ? {} : { key }),
      ...numbers,
    });

  // Decisions, one per record, by kind and key.
  const decisions = new Map<string, { decision: LedgerFileDecision; at: number }>();
  (input.decisions ?? []).forEach((decision, at) => {
    const id = recordId(decision.kind, decision.key);
    if (decisions.has(id)) {
      problem(
        `decisions.${at}`,
        `Decide once for each record: there is already a decision about the ${LABEL[decision.kind]} "${decision.key}".`,
        decision.kind,
        decision.key,
      );
      return;
    }
    decisions.set(id, { decision, at });
  });

  // The destination, by folded name, by key and by id.
  const hereEntries = (kind: Named, records: readonly { key: string; name: string }[]) =>
    records.map((record) => ({
      kind,
      key: record.key,
      name: record.name,
      id: here.ids[kind][record.key] ?? "",
      record: record as unknown,
    }));
  const hereList: Record<Named, HereEntry[]> = {
    group: hereEntries("group", here.groups),
    category: hereEntries("category", here.categories),
    account: hereEntries("account", here.accounts),
    template: hereEntries("template", here.templates),
    recurrence: hereEntries("recurrence", here.recurrences),
  };
  const index = (kind: Named) => {
    const byFold = new Map<string, HereEntry>();
    const byKey = new Map<string, HereEntry>();
    const byId = new Map<string, HereEntry>();
    for (const entry of hereList[kind]) {
      if (!byFold.has(fold(entry.name))) byFold.set(fold(entry.name), entry);
      byKey.set(entry.key, entry);
      if (entry.id) byId.set(entry.id, entry);
    }
    return { byFold, byKey, byId };
  };
  const hereIndex: Record<Named, ReturnType<typeof index>> = {
    group: index("group"),
    category: index("category"),
    account: index("account"),
    template: index("template"),
    recurrence: index("recurrence"),
  };
  const hereName = (kind: Named, key: string | null | undefined) =>
    key === null || key === undefined ? null : (hereIndex[kind].byKey.get(key)?.name ?? null);

  // Rows in the file naming each record, each row once.
  const rowsNaming = new Map<string, number>();
  const count = (kind: Named, keys: Iterable<string | null | undefined>) => {
    for (const key of new Set(keys)) {
      if (key === null || key === undefined) continue;
      const id = recordId(kind, key);
      rowsNaming.set(id, (rowsNaming.get(id) ?? 0) + 1);
    }
  };
  for (const entry of file.entries) {
    count("account", entryAccounts(entry));
    count("category", [
      entry.category,
      ...(entry.type === "transfer" ? [] : (entry.legs ?? []).map((leg) => leg.category)),
    ]);
    count("template", [entry.template]);
  }
  for (const row of file.staged) {
    count("account", [row.draft.from, row.draft.to]);
    count("category", [row.draft.category, ...(row.draft.legs ?? []).map((leg) => leg.category)]);
    count("template", [row.draft.template]);
  }

  const planned = new Map<string, Planned>();
  const plannedOf = (kind: LedgerImportKind, key: string) => planned.get(recordId(kind, key));
  /** The name a record goes by here once this import is done, or null when it is not coming. */
  const importNameOf = (kind: Named, key: string | null | undefined) => {
    if (key === null || key === undefined) return null;
    const record = plannedOf(kind, key);
    return record && (record.action === "use" || record.action === "create")
      ? record.importName
      : null;
  };
  const incomingNames: Names = {
    account: (key) => importNameOf("account", key),
    category: (key) => importNameOf("category", key),
  };
  const hereNames: Names = {
    account: (key) => hereName("account", key),
    category: (key) => hereName("category", key),
  };

  const add = (
    kind: LedgerImportKind,
    key: string,
    name: string,
    detail: LedgerRecordDetail,
    record: unknown,
  ): Planned => {
    const created: Planned = {
      kind,
      key,
      name,
      detail,
      outcome: "create",
      existing: null,
      copy: null,
      choices: [],
      message: null,
      rows: rowsNaming.get(recordId(kind, key)) ?? 0,
      action: "create",
      importName: name,
      id: null,
      arrivesArchived: false,
      periods: null,
      record,
      hereEntry: null,
    };
    planned.set(recordId(kind, key), created);
    return created;
  };
  const existing = (entry: HereEntry) => ({ key: entry.key, id: entry.id, name: entry.name });
  const use = (record: Planned, entry: HereEntry) => {
    record.action = "use";
    record.id = entry.id;
    record.importName = entry.name;
    record.hereEntry = entry;
  };
  const open = (record: Planned) => {
    record.action = "undecided";
    record.importName = null;
    record.id = null;
  };
  const refuse = (record: Planned, message: string) => {
    record.outcome = "refused";
    record.action = "refused";
    record.choices = [];
    record.importName = null;
    record.id = null;
    record.message = message;
  };

  /**
   * The decision a duplicate or a missing reference needs, or null with the
   * problem said. A record that needs none never asks, and so passes over
   * whatever was sent about it: that is what lets the same decisions travel
   * with every part. A budget's amounts are the one exception, below, where
   * "leave them all out" is honored in a part that did not ask.
   */
  const decide = (
    record: Planned,
    numbers: ProblemNumbers = {},
  ): { decision: LedgerFileDecision; at: number } | null => {
    if (!record.choices.length) return null;
    const found = decisions.get(recordId(record.kind, record.key));
    const offer = orList(record.choices.map((choice) => choiceWords(record.kind, choice)));
    if (!found) {
      open(record);
      problem(
        "decisions",
        `${record.message} Choose whether to ${offer}.`,
        record.kind,
        record.key,
        numbers,
      );
      return null;
    }
    if (!record.choices.includes(found.decision.action)) {
      open(record);
      problem(
        `decisions.${found.at}.action`,
        `The ${LABEL[record.kind]} "${record.name}" cannot take that decision. Choose whether to ${offer}.`,
        record.kind,
        record.key,
        numbers,
      );
      return null;
    }
    return found;
  };

  /** A name a decision gave, held to the kind's own rule. */
  const badName = (record: Planned, name: string, at: number): boolean => {
    const parsed = NAME_SCHEMA[record.kind as Named].safeParse(name);
    if (parsed.success) return false;
    open(record);
    problem(`decisions.${at}.name`, parsed.error.issues[0]!.message, record.kind, record.key);
    return true;
  };

  type Same = (incoming: Planned, here: HereEntry) => boolean;
  /** How the record here differs from the file's, as the whole sentence, or null for "it differs". */
  type Differs = (incoming: Planned, here: HereEntry) => string | null;
  type Source = { key: string; name: string; detail: LedgerRecordDetail };

  /**
   * The one record here, under another name, that is the same as the file's
   * in every field: what an earlier import brought in renamed. Records carry
   * no origin, so this is the only way an import resumed from a fresh check —
   * with the decisions it was sent with gone — can find the copy it made
   * rather than suggest a third. Only where exactly one answers, because two
   * records alike in every field are a coincidence nobody should be steered
   * between.
   */
  const copyOf = (kind: Named, record: Planned, same: Same) => {
    const name = fold(record.name);
    const alike = hereList[kind].filter(
      (entry) => entry.id && fold(entry.name) !== name && same(record, entry),
    );
    return alike.length === 1 ? existing(alike[0]!) : null;
  };

  const planWhole = (kind: Named, records: readonly Source[], same: Same, differs?: Differs) => {
    const seen = new Set<string>();
    for (const source of records) {
      if (source.detail !== "full") continue;
      const record = add(kind, source.key, source.name, "full", source);
      const name = fold(source.name);
      const match = hereIndex[kind].byFold.get(name);
      if (seen.has(name)) {
        record.outcome = "duplicate";
        record.choices = ["skip", "rename"];
        record.message = `Another ${LABEL[kind]} in this file is also called "${source.name}" once case and spacing are set aside.`;
      } else if (match !== undefined) {
        record.existing = existing(match);
        if (same(record, match)) {
          record.outcome = "exists";
          use(record, match);
        } else {
          record.outcome = "duplicate";
          const theirs = (match.record as { currency?: string }).currency;
          const ours = (source as { currency?: string }).currency;
          const otherCurrency = kind === "account" && theirs !== ours;
          // A recurring transaction is never named by anything else in a
          // file, so using the one here and leaving the file's out are the
          // same thing, and only one of them is offered.
          record.choices =
            otherCurrency || kind === "recurrence"
              ? ["skip", "rename"]
              : ["use_existing", "skip", "rename"];
          record.message = otherCurrency
            ? `There is already an account called "${match.name}" here, in ${theirs}, and the file's is in ${ours}, so the two cannot be one account.`
            : (differs?.(record, match) ??
              `There is already ${A_LABEL[kind]} called "${match.name}" here, and it differs from the file's.`);
        }
      }
      seen.add(name);
      if (record.outcome !== "duplicate") continue;
      record.copy = copyOf(kind, record, same);
      const found = decide(record);
      if (found === null) continue;
      const { decision, at } = found;
      if (decision.action === "use_existing") {
        use(record, match!);
      } else if (decision.action === "skip") {
        record.action = "skip";
        record.importName = null;
      } else if (decision.action === "rename") {
        if (badName(record, decision.name, at)) continue;
        if (fold(decision.name) === name) {
          open(record);
          problem(
            `decisions.${at}.name`,
            `A new name for "${source.name}" has to differ from it once case and spacing are set aside.`,
            kind,
            source.key,
          );
          continue;
        }
        record.action = "create";
        record.importName = decision.name.trim();
        // Here under the new name already, and the same in every field: an
        // earlier part of this import created it there, and this part uses it.
        const taken = hereIndex[kind].byFold.get(fold(decision.name));
        if (taken === undefined) continue;
        if (same(record, taken)) {
          use(record, taken);
        } else {
          open(record);
          problem(
            `decisions.${at}.name`,
            `There is already ${A_LABEL[kind]} called "${taken.name}" here. Choose another name.`,
            kind,
            source.key,
          );
        }
      }
    }
  };

  const planReferences = (kind: Exclude<Named, "recurrence">, records: readonly Source[]) => {
    const wholeNames = new Set(
      [...planned.values()]
        .filter((record) => record.kind === kind && record.detail === "full" && record.importName)
        .map((record) => fold(record.importName!)),
    );
    for (const source of records) {
      if (source.detail !== "reference") continue;
      const record = add(kind, source.key, source.name, "reference", source);
      const name = fold(source.name);
      const match = hereIndex[kind].byFold.get(name);
      const reference = source as Source & { currency?: string; kind?: CategoryKind };
      const theirs =
        (match?.record as { currency?: string; kind?: CategoryKind } | undefined) ?? {};
      record.outcome = "missing";
      record.message = `This file names ${A_LABEL[kind]} "${source.name}", which is not here.`;
      if (wholeNames.has(name)) {
        // Another record this file carries whole goes by the same name, and
        // where the file came from they were two records. The one here may be
        // that other one, made by an earlier part, so it is not assumed to be
        // this one.
        record.message = `This file names ${A_LABEL[kind]} "${source.name}" that is not the one it carries whole under the same name.`;
      } else if (
        match !== undefined &&
        kind === "account" &&
        theirs.currency !== reference.currency
      ) {
        record.existing = existing(match);
        record.message = `The file's account "${source.name}" is in ${reference.currency}, and the one called that here is in ${theirs.currency}, so it cannot be used.`;
      } else if (match !== undefined) {
        record.outcome = "exists";
        record.existing = existing(match);
        record.message = null;
        use(record, match);
        if (kind === "category" && theirs.kind !== reference.kind) {
          record.message = `"${match.name}" takes ${KIND_WORDS[theirs.kind!]} here and ${KIND_WORDS[reference.kind!]} where the file came from. Entries filed under it are posted by the kind it has here.`;
        }
        continue;
      }
      if (kind === "template") {
        // A template is only ever provenance on an entry, and an entry naming
        // a template nothing answers to is what a deleted template leaves
        // behind anyway, so there is nothing to ask.
        record.action = "drop";
        record.importName = null;
        record.message = `No template here is called "${source.name}", so the entries made from it arrive without saying so.`;
        continue;
      }
      // "Use one here" only where something here could be chosen: of this
      // kind, and for an account in the reference's own currency, the only
      // match the decision below accepts. An import never removes a record
      // here, so a later part offers whatever an earlier one did.
      const answerable = [...hereIndex[kind].byId.values()].some(
        (entry) =>
          kind !== "account" ||
          (entry.record as { currency?: string }).currency === reference.currency,
      );
      // A group is named only by categories, and nothing staged names one, so
      // there is no review to leave it to: left out, its categories come in
      // without a group, and the record says so before anybody chooses.
      const last = kind === "group" ? "skip" : "leave_staged";
      record.choices = answerable ? ["match", "create", last] : ["create", last];
      if (kind === "group") {
        record.message = `${record.message} Left out, the categories in it come in without a group.`;
      }
      const found = decide(record);
      if (found === null) continue;
      const { decision, at } = found;
      if (decision.action === "leave_staged" || decision.action === "skip") {
        record.action = decision.action;
        record.importName = null;
      } else if (decision.action === "match") {
        const chosen = hereIndex[kind].byId.get(decision.id);
        const chosenCurrency = (chosen?.record as { currency?: string } | undefined)?.currency;
        if (chosen === undefined) {
          open(record);
          problem(`decisions.${at}.id`, `No ${LABEL[kind]} here has that id.`, kind, source.key);
        } else if (kind === "account" && chosenCurrency !== reference.currency) {
          open(record);
          problem(
            `decisions.${at}.id`,
            `"${chosen.name}" is in ${chosenCurrency}, and the file's "${source.name}" is in ${reference.currency}. Choose an account in ${reference.currency}.`,
            kind,
            source.key,
          );
        } else {
          use(record, chosen);
        }
      } else if (decision.action === "create") {
        if (decision.name !== undefined && badName(record, decision.name, at)) continue;
        const wanted = decision.name?.trim() ?? source.name;
        record.action = "create";
        record.importName = wanted;
        if (kind === "account") {
          // Said once it is chosen, beside the choice, because a reference
          // carries no opening and the balance it ends on is what decides
          // whether somebody wanted this or the account's own details.
          record.message = `${record.message} Created from its name alone, it opens at zero on the day of the first entry naming it, so its balance is only what this file's entries move. Add a file carrying the account's details first to bring its opening.`;
        }
        const taken = hereIndex[kind].byFold.get(fold(wanted));
        if (taken === undefined) continue;
        // A reference is only its name, and an account's currency besides, so
        // one here under the chosen name that agrees is the one an earlier
        // part of this import created.
        const takenCurrency = (taken.record as { currency?: string }).currency;
        if (kind !== "account" || takenCurrency === reference.currency) {
          use(record, taken);
        } else {
          open(record);
          problem(
            `decisions.${at}.name`,
            `There is already ${A_LABEL[kind]} called "${taken.name}" here. Choose another name.`,
            kind,
            source.key,
          );
        }
      }
    }
  };

  /** Names being created are one per record within a kind, once case and spacing are set aside. */
  const clashes = (kind: Named) => {
    const taken = new Set<string>();
    for (const record of planned.values()) {
      if (record.kind !== kind || record.action !== "create" || record.importName === null)
        continue;
      const name = fold(record.importName);
      if (!taken.has(name)) {
        taken.add(name);
        continue;
      }
      const wanted = record.importName;
      open(record);
      problem(
        "decisions",
        `Another ${LABEL[kind]} in this file is coming in as "${wanted}". Choose another name for "${record.name}".`,
        kind,
        record.key,
      );
    }
  };

  planWhole("group", file.groups, (incoming, at) => {
    return (incoming.record as LedgerFileGroup).policy === (at.record as LedgerFileGroup).policy;
  });
  planReferences("group", file.groups);
  clashes("group");

  planWhole("category", file.categories, (incoming, at) => {
    const ours = incoming.record as LedgerFileCategory;
    const theirs = at.record as LedgerFileCategory;
    return (
      ours.kind === theirs.kind &&
      foldOrNull(importNameOf("group", ours.group)) === foldOrNull(hereName("group", theirs.group))
    );
  });
  planReferences("category", file.categories);
  clashes("category");

  type FullAccount = Extract<LedgerFileAccount, { detail: "full" }>;
  /** What differs between the file's account and one here in its currency, in the order a form shows them. */
  const accountDifferences = (ours: FullAccount, theirs: FullAccount) => {
    const opening = ledgerAccountOpening(ours);
    const hereOpening = {
      openingDate: theirs.openingDate,
      openingBalance: canonicalDecimalText(theirs.openingBalance),
    };
    const openingDiffers =
      opening.openingDate !== hereOpening.openingDate ||
      opening.openingBalance !== hereOpening.openingBalance;
    const fields = [
      ours.type === theirs.type ? null : "its type",
      openingDiffers ? "its opening" : null,
      blank(ours.institution) === blank(theirs.institution) ? null : "its institution",
      blank(ours.notes) === blank(theirs.notes) ? null : "its notes",
      ours.inBudget === theirs.inBudget ? null : "whether the budget is about the money in it",
    ].filter((field) => field !== null);
    return { fields, opening, hereOpening, openingDiffers };
  };
  planWhole(
    "account",
    file.accounts,
    (incoming, at) =>
      (incoming.record as FullAccount).currency === (at.record as FullAccount).currency &&
      accountDifferences(incoming.record as FullAccount, at.record as FullAccount).fields.length ===
        0,
    // The opening is the difference that decides a balance, and "it differs"
    // hid it at the moment somebody chose: using the one here keeps its own,
    // so the file's opening never arrives and no later check says so. Both
    // openings are said, and what the gap between them does, rather than a
    // balance, because the account here may hold entries of its own.
    (incoming, at) => {
      const { fields, opening, hereOpening, openingDiffers } = accountDifferences(
        incoming.record as FullAccount,
        at.record as FullAccount,
      );
      const currency = (at.record as FullAccount).currency;
      const differs = `There is already an account called "${at.name}" here, and it differs from the file's in ${andList(fields)}.`;
      if (!openingDiffers) return differs;
      const gap = subtractDecimalText(opening.openingBalance, hereOpening.openingBalance);
      const keeps =
        gap === "0"
          ? "Using the one here keeps its own opening day"
          : gap.startsWith("-")
            ? `Using the one here keeps its own opening, which is ${gap.slice(1)} ${currency} more than the file's`
            : `Using the one here keeps its own opening, so the ${gap} ${currency} more that the file's opens with does not come with it`;
      return `${differs} Here it opens on ${hereOpening.openingDate} at ${hereOpening.openingBalance} ${currency}, and the file's on ${opening.openingDate} at ${opening.openingBalance} ${currency}. ${keeps}; bringing it in under another name keeps the file's.`;
    },
  );
  planReferences("account", file.accounts);
  clashes("account");

  /** A category left for review, as what files a draft under it: its name and kind. */
  const leftForReview: LedgerRefResolver = (kind, key) => {
    const record = plannedOf(kind, key);
    return record?.action === "leave_staged" && kind === "category"
      ? { name: record.name, kind: (record.record as LedgerFileCategory).kind }
      : null;
  };
  /**
   * A draft or a shape the way the write files it under a category left for
   * review — by name, through the very `categoryFields` the write calls —
   * with every other key left as the file has it. Compared in this form,
   * because that is the form the record here was created in: a template an
   * earlier part made carries `categoryName`, and the file's key for a
   * category that is not coming in names nothing, so compared raw the two
   * would differ and every later part would ask a question the preview never
   * had.
   */
  const asFiled = (node: Record<string, unknown>, withKind: boolean): Record<string, unknown> => {
    const { category, legs, ...rest } = node;
    const byName = typeof category === "string" && leftForReview("category", category) !== null;
    return {
      ...rest,
      ...(byName
        ? categoryFields(category, leftForReview, withKind, named(rest.categoryName))
        : category === undefined
          ? {}
          : { category }),
      ...(Array.isArray(legs)
        ? { legs: legs.map((leg) => asFiled(leg as Record<string, unknown>, false)) }
        : {}),
    };
  };

  planWhole("template", file.templates, (incoming, at) => {
    const ours = incoming.record as Extract<LedgerFileTemplate, { detail: "full" }>;
    const theirs = at.record as Extract<LedgerFileTemplate, { detail: "full" }>;
    return (
      comparable(portable(asFiled(ours.draft, false), incomingNames)) ===
        comparable(portable(theirs.draft, hereNames)) &&
      comparable(reminderRule(ours.notification)) === comparable(reminderRule(theirs.notification))
    );
  });
  planReferences("template", file.templates);
  clashes("template");

  planWhole(
    "recurrence",
    file.recurrences.map((record) => ({ ...record, detail: "full" as const })),
    (incoming, at) => {
      const ours = incoming.record as LedgerFileRecurrence;
      const theirs = at.record as LedgerFileRecurrence;
      return (
        comparable(portable(asFiled(ours.shape, true), incomingNames)) ===
          comparable(portable(theirs.shape, hereNames)) &&
        comparable(ours.schedule) === comparable(theirs.schedule) &&
        ours.notifyOnCreate === theirs.notifyOnCreate
      );
    },
  );

  // While planning, anything that will exist resolves to an id of its own, so
  // a create input can be held to its schema before a record it names has
  // been written. Distinct per record, because a transfer between two new
  // accounts would otherwise read as a transfer from an account to itself.
  const placeholders = new Map<string, string>();
  const planning: LedgerRefResolver = (kind, key) => {
    const record = plannedOf(kind, key);
    if (!record) return null;
    if (record.action === "use") return { id: record.id! };
    if (record.action === "create") {
      const id = recordId(kind, key);
      if (!placeholders.has(id)) {
        const n = (placeholders.size + 1).toString(16).padStart(12, "0");
        placeholders.set(id, `00000000-0000-4000-8000-${n}`);
      }
      return { id: placeholders.get(id)! };
    }
    return leftForReview(kind, key);
  };
  const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "it does not fit";
  for (const record of planned.values()) {
    if (record.action !== "create" || record.detail !== "full") continue;
    if (record.kind === "account") {
      const parsed = accountCreateSchema.safeParse(
        ledgerAccountInput(record.record as LedgerFileAccount, record.importName!, file),
      );
      if (!parsed.success)
        refuse(record, `It cannot come in as it is: ${firstIssue(parsed.error)}`);
    } else if (record.kind === "template") {
      const built = ledgerTemplateInput(
        record.record as Extract<LedgerFileTemplate, { detail: "full" }>,
        record.importName!,
        planning,
      );
      const parsed = transactionTemplateCreateSchema.safeParse(built.input);
      if (!parsed.success)
        refuse(record, `It cannot come in as it is: ${firstIssue(parsed.error)}`);
    } else if (record.kind === "recurrence") {
      const source = record.record as LedgerFileRecurrence;
      const shape = source.shape as { from?: string; to?: string };
      // An account still being asked about is not one that is not coming:
      // saying so would state as settled what the open question decides, and
      // that question already keeps the plan from being carried out.
      const waiting = [shape.from, shape.to].find(
        (key) => key !== undefined && plannedOf("account", key)?.action === "undecided",
      );
      if (waiting !== undefined) {
        open(record);
        record.message = `It waits on what you choose for its account "${plannedOf("account", waiting)!.name}".`;
        continue;
      }
      const gone = [shape.from, shape.to].find(
        (key) => key !== undefined && importNameOf("account", key) === null,
      );
      if (gone !== undefined) {
        refuse(
          record,
          `Its account "${plannedOf("account", gone)?.name ?? gone}" is not coming in, so it is left out.`,
        );
        continue;
      }
      const built = ledgerRecurrenceInput(source, record.importName!, planning);
      const parsed = recurrenceCreateSchema.safeParse(built.input);
      if (!parsed.success)
        refuse(record, `It cannot come in as it is: ${firstIssue(parsed.error)}`);
    }
  }
  clashes("recurrence");

  // -------------------------------------------------------------------------
  // Budgets, after everything they can be about.
  // -------------------------------------------------------------------------

  /** Why a budget on this target cannot come in, or null when it can. */
  const targetRefusal = (target: BudgetTarget, what: string): string | null => {
    const record = plannedOf(target.kind, target.key);
    const name = record?.importName ?? record?.name ?? target.key;
    if (!record || (record.action !== "use" && record.action !== "create")) {
      return `"${name}" is not coming in, so ${what} left out.`;
    }
    const source = (record.action === "use" ? record.hereEntry!.record : record.record) as {
      kind?: CategoryKind;
      policy?: string;
    };
    if (target.kind === "category" && source.kind === "income") {
      return `"${name}" takes only income, which has no spending to budget, so ${what} left out.`;
    }
    if (target.kind === "group" && source.policy === "sum_of_children") {
      return `"${name}" is budgeted as whatever its categories add up to, so ${what} left out.`;
    }
    return null;
  };
  /** Where a budget lands: a record here by its key, or one of this file's being created. */
  const landsOn = (target: BudgetTarget) => {
    const record = plannedOf(target.kind, target.key)!;
    return record.action === "use"
      ? `here:${target.kind}:${record.hereEntry!.key}`
      : `file:${target.kind}:${target.key}`;
  };
  const hereLanding = (row: { category?: string; group?: string }) => {
    const target = budgetTargetOf(row);
    return `here:${target.kind}:${target.key}`;
  };
  const targetName = (target: BudgetTarget) => {
    const record = plannedOf(target.kind, target.key);
    return record?.importName ?? record?.name ?? target.key;
  };
  const planFields = (plan: LedgerFileBudgetPlan) => {
    const { category: _category, group: _group, ...fields } = plan;
    return comparable(portable(fields, incomingNames));
  };
  const overlaps = (
    left: { activeFrom: string; activeTo?: string | null },
    right: { activeFrom: string; activeTo?: string | null },
  ) =>
    !(left.activeTo != null && left.activeTo < right.activeFrom) &&
    !(right.activeTo != null && right.activeTo < left.activeFrom);
  /**
   * The sentence for a budget whose category or group is still an open
   * question, or null. Not a refusal: what it is about may yet come in, and
   * the question keeps the plan from being carried out until it is answered.
   */
  const targetWaiting = (target: BudgetTarget): string | null => {
    const record = plannedOf(target.kind, target.key);
    return record?.action === "undecided"
      ? `It waits on what you choose for "${record.name}".`
      : null;
  };
  const herePlans = here.budgets.plans.map((plan) => ({ plan, landing: hereLanding(plan) }));
  const placedPlans: { landing: string; plan: LedgerFileBudgetPlan }[] = [];

  for (const plan of file.budgets.plans) {
    const target = budgetTargetOf(plan);
    const record = add(
      "budget_plan",
      ledgerBudgetPlanKey(plan),
      `${targetName(target)} (${plan.currency}, by ${plan.periodUnit}) from ${plan.activeFrom}`,
      "full",
      plan,
    );
    record.importName = null;
    const waiting = targetWaiting(target);
    if (waiting !== null) {
      open(record);
      record.message = waiting;
      continue;
    }
    const refusal = targetRefusal(target, "its budget is");
    if (refusal !== null) {
      refuse(record, refusal);
      continue;
    }
    const landing = landsOn(target);
    const alike = (other: LedgerFileBudgetPlan) =>
      other.currency === plan.currency &&
      other.periodUnit === plan.periodUnit &&
      overlaps(other, plan);
    if (placedPlans.some((other) => other.landing === landing && alike(other.plan))) {
      refuse(
        record,
        `Another budget in this file covers some of the same periods for "${targetName(target)}", so this one is left out.`,
      );
      continue;
    }
    const clash = herePlans.find((other) => other.landing === landing && alike(other.plan));
    if (clash !== undefined && planFields(clash.plan) === planFields(plan)) {
      placedPlans.push({ landing, plan });
      record.outcome = "exists";
      record.action = "use";
      continue;
    }
    // Every rule a create holds a budget to, so the preview never says ready
    // for one the server then refuses with the whole part: the format reads
    // a plan's fields and none of the rules between them, and an edited or
    // foreign file can break any of those. Asked only of one that would be
    // created, since one already here is used as it is.
    const parsed = budgetPlanCreateSchema.safeParse(ledgerBudgetPlanInput(plan, planning));
    const broken = parsed.success
      ? budgetPlanRefusal({
          amount: parsed.data.amount,
          rollover: parsed.data.rollover ?? false,
          rolloverCap: parsed.data.rolloverCap ?? null,
          targetAmount: parsed.data.targetAmount ?? null,
          priority: parsed.data.priority ?? 0,
          isGroup: target.kind === "group",
        })
      : { message: firstIssue(parsed.error) };
    if (broken !== null) {
      refuse(record, `It cannot come in as it is: ${broken.message}`);
      continue;
    }
    placedPlans.push({ landing, plan });
    if (clash === undefined) continue;
    record.outcome = "duplicate";
    record.choices = ["skip"];
    record.message = `"${targetName(target)}" already has a different budget here for some of the same periods, so the file's cannot come in beside it.`;
    if (decide(record) !== null) record.action = "skip";
  }

  const hereAmounts = new Map(
    here.budgets.entries.map((entry) => [
      `${hereLanding(entry)}|${entry.currency}|${entry.periodUnit}|${entry.periodStart}`,
      canonicalDecimalText(entry.amount),
    ]),
  );
  const entryActions = new Map<string, LedgerBudgetEntryAction>();
  const entryIdentity = (entry: LedgerFileBudgetEntry) =>
    `${ledgerBudgetKey(entry)}|${entry.periodStart}`;
  const byBudget = new Map<string, LedgerFileBudgetEntry[]>();
  for (const entry of file.budgets.entries) {
    const key = ledgerBudgetKey(entry);
    byBudget.set(key, [...(byBudget.get(key) ?? []), entry]);
  }
  const filled = new Set<string>();
  for (const [key, entries] of byBudget) {
    const first = entries[0]!;
    const target = budgetTargetOf(first);
    const record = add(
      "budget_entry",
      key,
      `${targetName(target)} (${first.currency}, by ${first.periodUnit})`,
      "full",
      first,
    );
    record.importName = null;
    const waiting = targetWaiting(target);
    if (waiting !== null) {
      // Counted once, as undecided, rather than period by period: nothing is
      // known yet about where its periods land.
      open(record);
      record.message = waiting;
      continue;
    }
    const periods = { create: 0, exists: 0, conflict: 0 };
    record.periods = periods;
    const refusal = targetRefusal(target, "its budget amounts are");
    if (refusal !== null) {
      refuse(record, refusal);
      continue;
    }
    const landing = landsOn(target);
    for (const entry of entries) {
      const slot = `${landing}|${entry.currency}|${entry.periodUnit}|${entry.periodStart}`;
      const there = hereAmounts.get(slot);
      if (
        filled.has(slot) ||
        (there !== undefined && there !== canonicalDecimalText(entry.amount))
      ) {
        periods.conflict += 1;
        entryActions.set(entryIdentity(entry), "skip");
      } else if (there !== undefined) {
        periods.exists += 1;
        entryActions.set(entryIdentity(entry), "skip");
      } else {
        periods.create += 1;
        entryActions.set(entryIdentity(entry), "create");
      }
      filled.add(slot);
    }
    const leaveAllOut = () => {
      record.action = "skip";
      for (const entry of entries) entryActions.set(entryIdentity(entry), "skip");
    };
    if (periods.conflict === 0) {
      record.outcome = periods.create === 0 ? "exists" : "create";
      record.action = periods.create === 0 ? "use" : "create";
      // The one answer honored without a question, and only for this kind:
      // one budget's amounts can straddle parts, so the part holding its new
      // periods may meet nothing here while the part holding the rest asked,
      // and "leave all of them out" has to mean all of them in every part.
      if (decisions.get(recordId("budget_entry", key))?.decision.action === "skip") leaveAllOut();
      continue;
    }
    record.outcome = "duplicate";
    // A real choice only while there are new periods to bring: with none,
    // the file's can only be left out, and that is asked as one answer to
    // acknowledge rather than dressed as two.
    record.choices = periods.create ? ["use_existing", "skip"] : ["skip"];
    const differ = `"${targetName(target)}" already has different amounts here for ${periods.conflict} of the file's periods, so the file's cannot come in for those.`;
    record.message = periods.create
      ? `${differ} Its ${periods.create} new ${periods.create === 1 ? "period comes" : "periods come"} in beside the ones here, unless the file's amounts are all left out.`
      : `${differ} It has no others, so none of its amounts come in.`;
    const found = decide(record, { conflict: periods.conflict });
    if (found === null) continue;
    if (found.decision.action === "skip") leaveAllOut();
    else record.action = "create";
  }

  // -------------------------------------------------------------------------
  // What a record here is like, places, settings, caps, stray decisions.
  // -------------------------------------------------------------------------

  for (const record of planned.values()) {
    if (record.action !== "use" || record.hereEntry === null || record.message !== null) continue;
    const theirs = record.hereEntry.record as { archivedAt?: string | null; inUse?: boolean };
    if (record.kind !== "account" && record.kind !== "category") continue;
    if (theirs.archivedAt != null) {
      record.message = `"${record.importName}" is archived here, so the entries that name it wait in Staged until it is restored.`;
    } else if (record.kind === "account" && theirs.inUse === false) {
      record.message = `"${record.importName}" is frozen here, so the entries that name it wait in Staged until it is back in use.`;
    }
  }
  // A category archived where it came from arrives in use, unlike an account:
  // a row filed under an archived category cannot be committed, and a category
  // takes no place, so nothing is saved by making somebody restore it first.
  for (const record of planned.values()) {
    if (record.kind !== "category" || record.action !== "create" || record.detail !== "full") {
      continue;
    }
    if ((record.record as { archivedAt?: string | null }).archivedAt == null) continue;
    record.message ??=
      "It was archived where it came from. It arrives in use so the entries filed under it can be committed; archive it again once they are.";
  }

  const chosenArchived = new Set(input.arriveArchived ?? []);
  const accountKeys = new Set(file.accounts.map((account) => account.key));
  for (const key of chosenArchived) {
    if (!accountKeys.has(key)) {
      problem("arriveArchived", `No account in this file has the key "${key}".`, "account", key);
    }
  }
  let arriving = 0;
  let chosen = 0;
  for (const record of planned.values()) {
    if (record.kind !== "account" || record.action !== "create") continue;
    const source = record.record as LedgerFileAccount;
    if (source.detail === "full" && source.archivedAt !== null) {
      record.arrivesArchived = true;
      record.message ??=
        "It was archived where it came from, so it arrives archived and uses no place. The entries that name it wait in Staged until it is restored.";
      continue;
    }
    arriving += 1;
    if (chosenArchived.has(record.key)) {
      record.arrivesArchived = true;
      chosen += 1;
    }
  }
  const inUse = here.accounts.filter(
    (account) => account.detail === "full" && account.inUse,
  ).length;
  const limit = here.limit;
  const needed = limit === null ? 0 : Math.max(0, arriving - Math.max(0, limit - inUse));
  if (chosen < needed) {
    problem(
      "arriveArchived",
      `A free plan keeps ${limit} accounts in use, and this ledger has ${inUse}. This file brings ${arriving} more, so choose at least ${needed} of them to arrive archived${chosen ? ` — ${chosen} so far` : ""} — or upgrade under Settings.`,
      undefined,
      undefined,
      { limit: limit!, current: inUse, arriving, needed, chosen },
    );
  }

  const theirs = here.preferences;
  const ours = file.preferences;
  const differs =
    ours !== null &&
    (ours.timezone !== theirs.timezone ||
      ours.defaultCurrency !== theirs.defaultCurrency ||
      ours.theme !== theirs.theme);
  let preferences: LedgerFilePlan["preferences"]["action"] = "none";
  if (ours !== null && !theirs.chosen) preferences = "apply";
  else if (differs && input.preferences === "file") preferences = "apply";
  else if (differs && input.preferences === "keep") preferences = "keep";
  else if (differs) {
    preferences = "undecided";
    problem(
      "preferences",
      "This copy has its own regional settings, and the file's differ. Choose whether to use the file's or keep this copy's.",
    );
  }

  const cap = (kind: "template" | "recurrence", max: number, label: string) => {
    const already = kind === "template" ? here.templates.length : here.recurrences.length;
    const coming = [...planned.values()].filter(
      (record) => record.kind === kind && record.action === "create",
    );
    const more = coming.length;
    const over = already + more - max;
    if (over <= 0) return;
    // Only moves that work: a new record takes no decision, so "leave some
    // out" is open only for one the preview asks about and was told to copy.
    const copies = coming.filter((record) => record.choices.includes("skip")).length;
    problem(
      "decisions",
      `A ledger keeps at most ${max} ${label}. This one has ${already} and the file brings ${more} more, so delete at least ${over} here first${copies ? `, or leave out some of the ${copies} the preview asks about instead of bringing them in under another name` : ""}.`,
      kind,
      undefined,
      { limit: max, current: already, more, over },
    );
  };
  cap("template", MAX_TRANSACTION_TEMPLATES, "templates");
  cap("recurrence", MAX_RECURRENCES, "recurring transactions");

  for (const [id, { decision, at }] of decisions) {
    if (planned.has(id)) continue;
    // A budget's amounts are the one record a part carries only some of, so a
    // part without them has not heard of a key the part holding them asks
    // about. A mistyped key changes nothing, and the budget it meant still
    // asks in the part that holds it.
    if (decision.kind === "budget_entry") continue;
    problem(
      `decisions.${at}.key`,
      `No ${LABEL[decision.kind]} in this file has the key "${decision.key}".`,
      decision.kind,
      decision.key,
    );
  }

  const deleted = file.entries.filter((entry) => entry.deleted).length;
  const live = file.entries.length - deleted;
  const alreadyHere = Math.min(facts.rows.alreadyHere, live);
  const stagedAlreadyHere = Math.min(facts.rows.stagedAlreadyHere, file.staged.length);
  const zero = () =>
    Object.fromEntries(ledgerPlannedActions.map((action) => [action, 0])) as Record<
      LedgerPlannedAction,
      number
    >;
  const counts = Object.fromEntries(ledgerImportKinds.map((kind) => [kind, zero()])) as Record<
    LedgerImportKind,
    Record<LedgerPlannedAction, number>
  >;
  for (const record of planned.values()) {
    const tally = counts[record.kind];
    if (record.periods === null) {
      tally[record.action] += 1;
      continue;
    }
    if (record.action === "refused") {
      tally.refused += byBudget.get(record.key)?.length ?? 0;
      continue;
    }
    tally[record.action === "skip" ? "skip" : "create"] += record.periods.create;
    tally.use += record.periods.exists;
    tally[record.action === "undecided" ? "undecided" : "skip"] += record.periods.conflict;
  }
  const plan: LedgerFilePlan = {
    ok: problems.length === 0,
    problems,
    records: [...planned.values()].map(({ record: _record, hereEntry: _here, ...view }) => view),
    counts,
    places: { limit, inUse, arriving, needed, chosen },
    preferences: {
      inFile: ours !== null,
      chosenHere: theirs.chosen,
      differs,
      action: preferences,
    },
    rows: {
      entries: file.entries.length,
      deleted,
      staged: file.staged.length,
      alreadyHere,
      stagedAlreadyHere,
      toStage: live - alreadyHere + file.staged.length - stagedAlreadyHere,
      postedAsDiffers: file.entries.filter(
        (entry) => !entry.deleted && entry.type !== "transfer" && entry.postedAs !== undefined,
      ).length,
    },
  };

  return {
    plan,
    budgetEntryAction: (entry) => entryActions.get(entryIdentity(entry)) ?? "skip",
    resolve: (kind, key, created) => {
      const record = plannedOf(kind, key);
      if (!record) return null;
      if (record.action === "use") return { id: record.id! };
      if (record.action === "create") {
        const id = created.get(recordId(kind, key));
        return id === undefined ? null : { id };
      }
      return leftForReview(kind, key);
    },
  };
}

/**
 * The facts read for every part of one file, as the facts for the file.
 *
 * Every part carries every record and was read against the same ledger, so the
 * destination is taken from the first; only the rows differ from part to part,
 * and those are added up. The page then plans the whole file against this, so
 * what it shows is what every part together will do.
 */
export function mergeLedgerFileFacts(parts: readonly LedgerFileFacts[]): LedgerFileFacts {
  const [first] = parts;
  if (first === undefined) throw new Error("There is no preview to merge");
  return {
    ...first,
    rows: {
      alreadyHere: parts.reduce((total, part) => total + part.rows.alreadyHere, 0),
      stagedAlreadyHere: parts.reduce((total, part) => total + part.rows.stagedAlreadyHere, 0),
    },
  };
}

/**
 * A name to offer for a copy, shown when somebody chooses to bring a record in
 * under another name and sent only if they keep it: the first of "Name (2)",
 * "Name (3)" and so on that nothing here or in the file already goes by, which
 * is the suffix the export gives a key.
 */
export function suggestLedgerRename(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(fold));
  used.add(fold(name));
  for (let suffix = 2; ; suffix++) {
    const candidate = `${name} (${suffix})`;
    if (!used.has(fold(candidate))) return candidate;
  }
}

/**
 * Whether two rows are two entries rather than one entry twice, by origin.
 *
 * Only when both carry one from a Simple Balance file and they differ: two
 * coffees bought the same morning are two origins and never duplicates of
 * each other. A row without an origin — typed here, or read from a CSV — is
 * compared by the duplicate check as it always was, because nothing else can
 * tell the two apart.
 */
export function importOriginsDiffer(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return typeof left === "string" && typeof right === "string" && left !== right;
}
