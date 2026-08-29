import { z } from "zod";

/** Types a person can pick when creating an account. */
export const userAccountTypes = [
  "checking",
  "savings",
  "credit_card",
  "cash",
  "crypto_wallet",
  "loan",
  "investment",
  "other_asset",
  "other_liability",
] as const;

/**
 * Double-entry needs somewhere for the other half of a deposit or withdrawal to
 * land. Those counter-accounts are created by the server, never by a person, so
 * the stored enum carries one extra type the create form does not offer.
 */
export const accountTypes = [...userAccountTypes, "system"] as const;

export type UserAccountType = (typeof userAccountTypes)[number];
export type AccountType = (typeof accountTypes)[number];

/** Which side of the books a server-owned counter-account represents. */
export const systemAccountKinds = ["income", "expense", "exchange", "equity"] as const;
export type SystemAccountKind = (typeof systemAccountKinds)[number];

export const accountTypeLabels: Record<UserAccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit Card",
  cash: "Cash",
  crypto_wallet: "Crypto Wallet",
  loan: "Loan",
  investment: "Investment",
  other_asset: "Other Asset",
  other_liability: "Other Liability",
};

/**
 * The order account types are shown in, which is not the order the enum
 * declares them. The enum is stored in the database and cannot be reordered;
 * this is how a person reads down their accounts: what they hold, then what
 * they owe, then what is invested, then the catch-alls.
 */
export const accountTypeOrder: readonly UserAccountType[] = [
  "cash",
  "checking",
  "savings",
  "credit_card",
  "loan",
  "investment",
  "crypto_wallet",
  "other_asset",
  "other_liability",
];

/**
 * Accounts under a heading each, in `accountTypeOrder`, with empty headings
 * left out.
 *
 * The type is read as a plain string because the dashboard summary sends it as
 * one. A type this does not recognise is grouped under itself and sorted to the
 * end rather than dropped, so a new type shows up unstyled instead of
 * disappearing from the page.
 */
export function groupAccountsByType<T extends { type: string }>(
  accounts: readonly T[],
): { type: string; label: string; accounts: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const account of accounts) {
    const group = groups.get(account.type);
    if (group) group.push(account);
    else groups.set(account.type, [account]);
  }
  const rank = (type: string) => {
    const index = accountTypeOrder.indexOf(type as UserAccountType);
    return index === -1 ? accountTypeOrder.length : index;
  };
  return [...groups.entries()]
    .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
    .map(([type, items]) => ({
      type,
      label: accountTypeLabels[type as UserAccountType] ?? type,
      accounts: items,
    }));
}

export const liabilityAccountTypes = new Set<UserAccountType>([
  "credit_card",
  "loan",
  "other_liability",
]);

export const categoryKinds = ["income", "expense", "both"] as const;
export type CategoryKind = (typeof categoryKinds)[number];

export const transactionTypes = ["deposit", "withdrawal", "transfer"] as const;
export type TransactionType = (typeof transactionTypes)[number];

/**
 * Which side of the books the non-account half of an entry lands on, and
 * whether getting there reverses the direction it was entered in.
 *
 * A deposit normally credits income and a withdrawal normally debits expense.
 * A refund is the exception in both directions: thirty pounds back from the
 * shop is not income, and what should move is the spending it reverses. So the
 * kinds of the categories the entry names decide, and the direction is only the
 * default when nothing contradicts it. A `both` category contradicts nothing,
 * which is what makes it `both`.
 *
 * All the legs answer together, because they are shares of one movement. An
 * entry naming an income category and an expense category at once is refused
 * rather than split across two counter-accounts, because those would be two
 * movements and only one of them is the one somebody entered.
 *
 * One function, because the browser previews this and the server enforces it.
 * It returns a result rather than throwing so the form can put the refusal
 * beside the field while the service turns the same sentence into a 422.
 */
export type EntrySide =
  | { ok: true; counterKind: "income" | "expense"; reversal: boolean }
  | { ok: false; message: string };

export function resolveEntrySide(
  type: "deposit" | "withdrawal",
  namedKinds: Iterable<CategoryKind>,
): EntrySide {
  const kinds = new Set(namedKinds);
  const forward = type === "deposit" ? "income" : "expense";
  const reverse = type === "deposit" ? "expense" : "income";
  if (kinds.has(forward) && kinds.has(reverse)) {
    return {
      ok: false,
      message:
        type === "deposit"
          ? "A deposit is either income or a refund, not both. Enter it as two transactions."
          : "A withdrawal is either spending or income coming back, not both. Enter it as two transactions.",
    };
  }
  const reversal = kinds.has(reverse);
  return { ok: true, counterKind: reversal ? reverse : forward, reversal };
}

/**
 * Whether one category on one entry reverses it, which is the question a form
 * asks about the field somebody just changed. A transfer files under no
 * category at all, so nothing about it reverses.
 */
export function reversesEntry(type: TransactionType, kind: CategoryKind) {
  if (type === "transfer") return false;
  return type === "deposit" ? kind === "expense" : kind === "income";
}

/**
 * Which palette to paint, where `system` is a standing instruction rather than a
 * value: it means "whatever this machine is set to, including when that changes
 * at sunset", and it is what somebody has before they have chosen anything.
 *
 * The alternative was to detect the machine's setting once and store the answer,
 * which cannot work here and would have been worse if it could. It cannot work
 * because `chosen` is true for anybody who has ever saved a timezone, so the
 * detection would never fire for a single existing account — everyone already
 * using this would upgrade into a light app on a dark machine. And it would be
 * worse because a stored answer cannot be told apart from a decision, so the
 * app could either follow the machine or remember a choice, never both.
 */
export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];

/**
 * Who did it. A scheduler write is not a person at a screen, and saying it was
 * would be a false statement in an audit trail.
 */
export const actorSources = ["web", "mcp", "schedule"] as const;
export type ActorSource = (typeof actorSources)[number];

export const isoDateSchema = z
  .string()
  // Year 0000 round-trips through JavaScript's Date and is out of range for
  // PostgreSQL, so the check below passes it and the cast at the far end fails,
  // which the caller sees as an unexplained 500 for a four-digit typo.
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
  }, "Date is not valid")
  .describe("Calendar date as YYYY-MM-DD, for example 2026-03-14.");

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{2,12}$/, "Use an uppercase ISO currency code or supported crypto asset symbol")
  .describe(
    "Uppercase currency code, for example USD or EUR, or a crypto asset symbol such as BTC. An account's currency is fixed once it is in use.",
  );

export const decimalStringSchema = z
  .string()
  .regex(
    /^-?(?:0|[1-9]\d{0,25})(?:\.\d{1,18})?$/,
    "Use a decimal string with at most 26 integer and 18 fractional digits",
  )
  .describe(
    'Money as a decimal STRING, for example "1234.56". Never a JSON number: binary floating point cannot hold these values exactly. Up to 26 digits before the point and 18 after.',
  );

export const positiveDecimalStringSchema = decimalStringSchema
  .refine(
    (value) => !value.startsWith("-") && value !== "0" && !/^0\.0+$/.test(value),
    "Amount must be greater than zero",
  )
  .describe(
    'How much money moved, as a decimal string greater than zero, for example "42.50". Direction comes from the transaction type, so this is never negative.',
  );

/**
 * The version a caller last read, sent back so a write can refuse a stale one.
 *
 * Described once here rather than at each of the twelve places that take it,
 * because an agent meeting `expectedVersion` with no description has to guess
 * both where the number comes from and what to do when it is rejected, and
 * guessing wrong means retrying the same stale write in a loop.
 */
export const expectedVersionSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "The `version` you last read on this record. The write is refused with STALE_VERSION if it has moved since, which means somebody else changed it: read the record again and decide whether your change still applies. Never retry with the old number.",
  );

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .describe(
    "A key you choose to make this write safe to retry. Sending the same key again returns the original result instead of recording a second time. Use a fresh one per intended action, for example a UUID.",
  );

/**
 * Control characters a person cannot have meant to type. A NUL byte in
 * particular is rejected by PostgreSQL's own text encoding, so without this it
 * travels all the way to the driver and comes back as an unexplained server
 * error rather than as the invalid input it is.
 *
 * Line breaks and tabs are left alone for the fields where they read naturally.
 */
const forbiddenAnywhere = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const forbiddenOnOneLine = /[\u0000-\u001F\u007F]/u;

const oneLine = <T extends z.ZodString>(schema: T) =>
  schema.refine(
    (value) => !forbiddenOnOneLine.test(value),
    "Text cannot contain line breaks or control characters",
  );

const freeText = <T extends z.ZodString>(schema: T) =>
  schema.refine(
    (value) => !forbiddenAnywhere.test(value),
    "Text cannot contain control characters",
  );

/**
 * The most category legs one entry may be split into. A split is the whole of
 * the counter-account side of the entry rewritten as several postings, so the
 * cost of a large one is paid on every read of that entry, not just on the
 * write. Fifty is far past a receipt anybody itemises by hand and still small
 * enough that a hydrated page of them is a page.
 */
export const MAX_TRANSACTION_LEGS = 50;

/**
 * One category's share of a split entry.
 *
 * The list a request carries is the list the entry should end with, so identity
 * matters: a leg sent **without** an `id` is a new one, a leg sent **with** one
 * is that leg changed, and a leg **left out** is removed. Matching legs by
 * position or by value instead would make an edit that reorders two rows look
 * like an edit that rewrote both, which is the silent destruction Firefly III's
 * API documentation warns about.
 *
 * `amount` is unsigned. Direction belongs to the entry — every leg of a
 * withdrawal is money out — so a signed leg could only ever contradict it.
 */
const transactionLegSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The existing leg this entry of the list is about, so it is changed rather than replaced. Left out, the old leg is zeroed and a new one written, appending a reversal and a repost for money that never moved. A leg missing from the list is removed.",
      ),
    categoryId: z
      .string()
      .uuid()
      .optional()
      .nullable()
      .describe(
        "Which category this leg's share files under. It wins over this leg's categoryName, and the legs answer the direction question together, so an income category on one leg beside an expense category on another is refused.",
      ),
    categoryName: oneLine(z.string().trim().min(1).max(120))
      .optional()
      .nullable()
      .describe(
        'A category by name rather than by id for this leg, matched and created on the same terms as the entry-level categoryName. Ignored when this leg\'s categoryId is set, for example "Groceries".',
      ),
    amount: positiveDecimalStringSchema,
    note: freeText(z.string().trim().max(240))
      .optional()
      .nullable()
      .describe(
        "What this share of the entry was for, when the category alone does not say it. Nothing reads it back: search does not match it and nothing groups by it, so a distinction you want to report on belongs in a category.",
      ),
  })
  .strict();

type TransactionLegInput = z.infer<typeof transactionLegSchema>;

const legsField = z
  .array(transactionLegSchema)
  .min(2, "A split needs at least two legs")
  .max(MAX_TRANSACTION_LEGS)
  .optional()
  .describe(
    "Splits this entry across several categories. Each leg carries its own amount, and the legs must add up to the entry's amount. Omit it, or send a single categoryId, for an entry that belongs to one category.",
  );

/**
 * Legs and a single category are two ways of saying the same thing, so a
 * request carrying both is refused rather than merged: guessing which one the
 * caller meant would file money under a category they did not choose. Clearing
 * the single category alongside legs is not a conflict, because `null` says
 * what the legs already say.
 *
 * A transfer is refused a split outright. Both of its sides name an account, so
 * there is no counter-account side left over for categories to partition.
 *
 * Shared with templates, whose legs are a different shape, so this reads only
 * the fields both have.
 */
function checkLegs(
  draft: {
    type?: string;
    legs?: readonly unknown[];
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  if (draft.legs === undefined) return;
  if (draft.type === "transfer") {
    context.addIssue({
      code: "custom",
      path: ["legs"],
      message: "A transfer cannot be split by category",
    });
    return;
  }
  for (const field of ["categoryId", "categoryName"] as const) {
    if (draft[field] === undefined || draft[field] === null) continue;
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Send either a category or legs, not both",
    });
  }
}

/**
 * Naming one existing leg twice is refused for the same reason the identity
 * rule exists at all: the two entries disagree about what that leg should
 * become, and either answer silently discards the other. Templates are exempt
 * because their legs have no ids to collide.
 */
function checkTransactionLegs(
  draft: {
    type: string;
    legs?: TransactionLegInput[];
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  checkLegs(draft, context);
  const named = draft.legs?.map((leg) => leg.id).filter((id) => id !== undefined);
  if (named && new Set(named).size !== named.length) {
    context.addIssue({
      code: "custom",
      path: ["legs"],
      message: "Leg IDs must be unique",
    });
  }
}

/**
 * What a transaction says about itself apart from when it happened and where it
 * came from. Split out so a recurrence can hold the same shape without a date,
 * which its occurrence supplies, and without the provenance fields it refuses.
 */
const transactionShapeCommon = {
  payee: oneLine(z.string().trim().min(1, "Payee is required").max(160)).describe(
    "Who the money went to or came from. Case and spacing are canonicalised to the spelling already in use; any other variation starts a second payee somebody has to merge later. It is part of the duplicate check.",
  ),
  description: freeText(z.string().trim().max(240))
    .optional()
    .nullable()
    .transform((value) => value || null)
    .describe(
      "A short line saying what this entry was, matched by the search filter alongside the payee and notes. Anything longer than a line belongs in notes.",
    ),
  categoryId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .describe(
      "Which category this entry files under. It wins over categoryName and is refused alongside legs. Its kind decides where the other half lands: an expense category on a deposit makes a refund, reducing that spending rather than adding income.",
    ),
  // Naming a category instead of picking one. The name is matched against the
  // categories this ledger already has, ignoring case and surrounding space, and
  // only creates one when nothing matches. That is the same rule a CSV import
  // follows, so typing "groceries" where "Groceries" exists files the entry
  // under the category already there rather than starting a second spelling of
  // it. Ignored when categoryId is given, since an id is already an answer.
  categoryName: oneLine(z.string().trim().min(1).max(120))
    .optional()
    .nullable()
    .describe(
      'A category by name rather than by id, matched case-insensitively against your existing categories and created only if it is genuinely new. Ignored when categoryId is set. Use this when you know what to call it but not its id, for example "Groceries".',
    ),
  // Which kind a category this entry has to create should be, when the entry's
  // own direction is the wrong guess.
  //
  // A deposit naming a category nobody has created yet would otherwise make an
  // income category, and a refund into a brand new spending category was
  // therefore impossible to record: the category came out as income, the
  // deposit credited it, and the spending it was reversing never moved. A CSV
  // import needs the same thing for a different reason, because a file decides
  // the kind from all its rows and then hands one row at a time to a commit
  // that can no longer see the others.
  //
  // Ignored when the category already exists, which keeps whatever kind it has,
  // and ignored when categoryId is given, since an id is already an answer.
  categoryKind: z
    .enum(categoryKinds)
    .optional()
    .nullable()
    .describe(
      'Which kind to create the category as when categoryName names one that does not exist yet. Left out, a deposit creates an income category and a withdrawal an expense one. Set it to "expense" on a deposit to record a refund into a spending category that is new, which is otherwise impossible to express. Ignored when the category already exists or when categoryId is set.',
    ),
  legs: legsField,
  notes: freeText(z.string().trim().max(4_000))
    .optional()
    .nullable()
    .describe(
      "Anything longer that should stay with the entry, such as a reference or the reason for it. Only the search filter reads it, so a category or payee written only here files the entry nowhere.",
    ),
};

const transactionCommon = {
  date: isoDateSchema,
  externalId: oneLine(z.string().trim().max(200))
    .optional()
    .nullable()
    .describe(
      "The reference this row carried in the file it was imported from, if any. It is what stops the same bank statement being imported twice, so treat it as bank-supplied text rather than as anything a person wrote — it arrives from outside this ledger and nothing here validates its meaning.",
    ),
  // Which template this was made from, kept so a template can report what came
  // of it. Provenance only: nothing reads it back into the entry.
  templateId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .describe(
      "The template this entry was started from, if any. Recorded so a template can report the transactions made from it; it changes nothing about the entry itself.",
    ),
  ...transactionShapeCommon,
};

const depositDraftSchema = z
  .object({
    type: z
      .literal("deposit")
      .describe(
        "Which way the money moved, and what else the draft needs: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both and sourceAmount. Direction lives here alone, so amounts are always positive; a transfer refuses legs, and a category on one is stored but never posted.",
      ),
    ...transactionCommon,
    toAccountId: z
      .string()
      .uuid()
      .describe(
        "Where the money landed: a deposit's account, or a transfer's destination. Its currency is the currency the money arrived in, so a transfer whose two accounts differ in currency is refused without destinationAmount.",
      ),
    amount: positiveDecimalStringSchema,
  })
  .superRefine(checkTransactionLegs);

const withdrawalDraftSchema = z
  .object({
    type: z
      .literal("withdrawal")
      .describe(
        "Which way the money moved, and what else the draft needs: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both and sourceAmount. Direction lives here alone, so amounts are always positive; a transfer refuses legs, and a category on one is stored but never posted.",
      ),
    ...transactionCommon,
    fromAccountId: z
      .string()
      .uuid()
      .describe(
        "Where the money came from: a withdrawal's account, or a transfer's source, whose currency sourceAmount is in. A transfer's two sides must differ, so moving money within one account is refused.",
      ),
    amount: positiveDecimalStringSchema,
  })
  .superRefine(checkTransactionLegs);

const transferDraftSchema = z
  .object({
    type: z
      .literal("transfer")
      .describe(
        "Which way the money moved, and what else the draft needs: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both and sourceAmount. Direction lives here alone, so amounts are always positive; a transfer refuses legs, and a category on one is stored but never posted.",
      ),
    ...transactionCommon,
    fromAccountId: z
      .string()
      .uuid()
      .describe(
        "Where the money came from: a withdrawal's account, or a transfer's source, whose currency sourceAmount is in. A transfer's two sides must differ, so moving money within one account is refused.",
      ),
    toAccountId: z
      .string()
      .uuid()
      .describe(
        "Where the money landed: a deposit's account, or a transfer's destination. Its currency is the currency the money arrived in, so a transfer whose two accounts differ in currency is refused without destinationAmount.",
      ),
    sourceAmount: positiveDecimalStringSchema.describe(
      "How much left fromAccountId, in that account's currency. On a cross-currency transfer it is only one side: destinationAmount says what arrived, and the rate is implied by the pair rather than given.",
    ),
    destinationAmount: positiveDecimalStringSchema
      .optional()
      .describe(
        "What arrived in toAccountId, in that account's currency, so a conversion records both real amounts rather than a rate. Required when the accounts differ in currency; on a same-currency transfer, omit it or match sourceAmount.",
      ),
  })
  .superRefine(checkTransactionLegs);

export const transactionDraftSchema = z.discriminatedUnion("type", [
  depositDraftSchema,
  withdrawalDraftSchema,
  transferDraftSchema,
]);

export type TransactionDraft = z.infer<typeof transactionDraftSchema>;

// Staging deliberately accepts incomplete normalized drafts so imported rows and
// agents can preserve/correct validation errors without affecting the ledger.
export /**
 * A proposed entry, which is allowed to be wrong.
 *
 * Every field is `unknown` and the object keeps whatever else it is given,
 * because a staged row is what a file or an agent proposed rather than
 * something the ledger has accepted: a date that is not a date and an amount
 * with a currency symbol both have to survive long enough for somebody to fix
 * them. That makes the descriptions do all the work here — the type says
 * nothing, so a field with no description tells an agent nothing at all.
 */
const stagedDraftSchema = z
  .object({
    type: z
      .unknown()
      .optional()
      .describe(
        "deposit, withdrawal or transfer, as on a committed entry. A row whose type cannot be read is staged with an issue rather than refused, and cannot be committed until it can.",
      ),
    date: z
      .unknown()
      .optional()
      .describe(
        "The day it happened, as YYYY-MM-DD once it is readable. A row keeps whatever the file said until somebody fixes it, so this may be any shape at all.",
      ),
    description: z
      .unknown()
      .optional()
      .describe("A short line saying what the entry was, as on a committed entry."),
    payee: z
      .unknown()
      .optional()
      .describe(
        "Who the money went to or came from. Canonicalised against the spelling this ledger already uses when the row is staged, not when it commits.",
      ),
    categoryId: z
      .unknown()
      .optional()
      .describe(
        "Which category this files under, if the proposal already knows. A staged row may name one instead, in the rawData the queue keeps.",
      ),
    notes: z.unknown().optional().describe("Anything longer that should stay with the entry."),
    externalId: z
      .unknown()
      .optional()
      .describe(
        "The reference the row carried in the file it came from. It is what stops a second import of the same statement staging the same rows twice.",
      ),
    fromAccountId: z
      .unknown()
      .optional()
      .describe("Where the money came from: a withdrawal's account, or a transfer's source."),
    toAccountId: z
      .unknown()
      .optional()
      .describe("Where the money landed: a deposit's account, or a transfer's destination."),
    amount: z
      .unknown()
      .optional()
      .describe(
        "How much, as a decimal string and always positive once readable. Direction is the type, not the sign.",
      ),
    sourceAmount: z
      .unknown()
      .optional()
      .describe("How much left the source account, in that account's currency, on a transfer."),
    destinationAmount: z
      .unknown()
      .optional()
      .describe(
        "What arrived in the destination account, in that account's currency. A cross-currency transfer cannot commit without it, which is the commonest reason a row waits here.",
      ),
    legs: z
      .unknown()
      .optional()
      .describe(
        "The split, if the proposal came with one. The legs have to add up to the amount before the row can commit, and a transfer may not carry any.",
      ),
  })
  .catchall(z.unknown());

export type StagedDraft = z.infer<typeof stagedDraftSchema>;

/**
 * The most templates one person may keep. The list is unpaginated and fetched
 * whenever the transaction form opens, and each row carries a JSON draft, so it
 * is heavier per row than the category list it otherwise resembles.
 */
export const MAX_TRANSACTION_TEMPLATES = 200;

/**
 * A field left blank is a field the template does not have. Storing `""` would
 * make "not saved" and "saved as nothing" the same value in the JSON, and the
 * form applying it could not tell which one the user meant.
 */
const blankToAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );

/**
 * The same rule for a list. `blankToAbsent` only recognises a blank string, so
 * an empty `legs` array would survive into storage as a template that says "I
 * was saved with no legs" rather than one that never mentioned legs at all.
 */
const emptyListToAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
    schema.optional(),
  );

/**
 * A leg of a template's split. Amounts are optional here and everything else
 * follows the rest of the template: a field the template does not carry is one
 * the form leaves as it found it.
 *
 * The amounts are decimal strings, never shares of the total. A template's own
 * amount is already optional, so proportions would be a second way of writing
 * money that only one of the two forms could ever resolve.
 *
 * Legs carry no id, because nothing resyncs a template: the stored list is the
 * whole of what it remembers, and the order is the order it was typed in.
 */
const transactionTemplateLegSchema = z
  .object({
    categoryId: blankToAbsent(z.string().uuid()).describe(
      "Which existing category this share of the split goes to. One that no longer resolves is cleared with a notice when the template is used, so the leg reads as unfinished rather than showing an empty picker holding a dead id.",
    ),
    categoryName: blankToAbsent(oneLine(z.string().trim().max(120))).describe(
      "Names this leg's category rather than picking one, matched ignoring case when somebody uses the template and created then if nothing matches. Ignored when this leg's categoryId is set.",
    ),
    amount: blankToAbsent(positiveDecimalStringSchema).describe(
      "This leg's share of the total, always positive. It may be left out, which a transaction's leg may not: a template can remember how the money is usually divided and leave the figures to the person, and the shares need only add up on submit.",
    ),
    note: blankToAbsent(freeText(z.string().trim().max(240))).describe(
      "A word about this share alone, distinct from the entry's own description and notes, which cover the whole transaction. Left out, the leg is prefilled without one.",
    ),
  })
  .strict();

const templateLegsField = z
  .array(transactionTemplateLegSchema)
  .min(2, "A split needs at least two legs")
  .max(MAX_TRANSACTION_LEGS);

/**
 * What a template remembers. These are the transaction form's own field names
 * rather than the posted draft's, because a template is a starting point for
 * that form and nothing else reads it.
 *
 * Every field is optional, including the type. Only the name identifies a
 * template, and a field it does not carry is one the form leaves as it found
 * it, rather than one it blanks.
 *
 * `externalId` is refused rather than ignored, and is the only one. It is the
 * reference a bank statement row was imported under, so copied into a template
 * it would be copied into every transaction made from it, and the next real
 * import of that row would be swallowed as one already seen. A date and a
 * category name are both stored: each can surprise a person using the template,
 * but each is visible in the form before anything is submitted.
 */
export const transactionTemplateDraftSchema = z
  .object({
    type: blankToAbsent(z.enum(transactionTypes)).describe(
      "Which kind of entry the form starts on. Left out, the template says nothing about direction and the person chooses each time, which is what a template about a payee rather than a movement wants; a stored type also decides which account side is worth keeping.",
    ),
    date: blankToAbsent(isoDateSchema),
    payee: blankToAbsent(oneLine(z.string().trim().max(160))).describe(
      "Who entries made from this are with, prefilled. Left out, the form keeps whatever is in the field already, so omit it deliberately for a template standing for a kind of spending rather than one shop.",
    ),
    fromAccountId: blankToAbsent(z.string().uuid()).describe(
      "The account the money leaves, prefilled, for a withdrawal or a transfer. Left out, the person chooses each time. Stored on a deposit template nothing ever reads it, and an account archived since is dropped with a notice when the template is used.",
    ),
    toAccountId: blankToAbsent(z.string().uuid()).describe(
      "The account the money arrives in, prefilled, for a deposit or a transfer. Left out, the person chooses each time. Stored on a withdrawal template nothing ever reads it, and an account archived since is dropped with a notice when the template is used.",
    ),
    amount: blankToAbsent(positiveDecimalStringSchema).describe(
      "The figure to prefill, always positive, since type says which way the money moves; on a transfer it is the amount leaving the source account. This is the usual field to leave out, which is what lets one template serve a bill that differs every month.",
    ),
    destinationAmount: blankToAbsent(positiveDecimalStringSchema).describe(
      "What arrives in the destination account, for a transfer template between two currencies where the two sides are different figures. Only a transfer has one: changing a template's type to anything else drops it, and a bulk edit refuses to set it on a row that is not a transfer.",
    ),
    categoryId: blankToAbsent(z.string().uuid()).describe(
      "Files every entry started from this under a category that already exists. Refused alongside legs, and an id that no longer resolves is cleared with a notice when somebody uses the template rather than prefilled invisibly.",
    ),
    categoryName: blankToAbsent(oneLine(z.string().trim().max(120))).describe(
      "Names the category rather than picking one, so a template can point at a category this ledger does not have yet: it is matched, ignoring case, only when somebody uses the template, and created then if nothing matches. Ignored when categoryId is set, and refused alongside legs.",
    ),
    legs: emptyListToAbsent(templateLegsField).describe(
      "Divides the counter-account side across several categories instead of a single categoryId or categoryName, which are refused alongside it, as is a split on a transfer. Unlike a transaction's legs these need not add up: amounts may be blank, and the division is checked only on submit.",
    ),
    description: blankToAbsent(freeText(z.string().trim().max(240))).describe(
      "The one-line description to prefill. Left out, the field is left as the form found it rather than blanked, so a template silent about the description will not wipe one off an entry being edited.",
    ),
    notes: blankToAbsent(freeText(z.string().trim().max(4_000))).describe(
      "The longer note to prefill, for something every entry made from this carries. Left out, the field keeps whatever the form already had, which is what you want when the note differs every time.",
    ),
  })
  .strict()
  .superRefine(checkLegs);

export type TransactionTemplateDraft = z.infer<typeof transactionTemplateDraftSchema>;

/**
 * Every selected template is named outright, with the version it was read at.
 *
 * The filtered-selection contract the ledger uses exists for rows the browser
 * has never loaded, which `MAX_TRANSACTION_TEMPLATES` makes impossible here:
 * the whole list is already in hand, so it can name every id and every version
 * honestly rather than describing them and asking the server to agree.
 */
export const transactionTemplateBulkSelectionSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z
              .string()
              .uuid()
              .describe(
                "Which row this entry of the selection is about. It has to exist and be yours: one that does not resolve fails the whole call rather than being passed over, so the rows changed always match the rows you named.",
              ),
            expectedVersion: expectedVersionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TRANSACTION_TEMPLATES)
      .describe(
        "Every template to change, each named with the version you last read for it. This is the whole selection: a duplicated id, an id that is not yours, or a version that has moved refuses the entire call rather than changing part of it.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = selection.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Template IDs must be unique",
      });
    }
  });

/**
 * A template field is blank on purpose, so a mass edit needs a third answer
 * beyond set and leave alone: `null` clears the field back to one the person
 * fills in when they use the template. An empty string is refused rather than
 * read as a clear, because blank and absent being different is the whole of
 * what a stored draft records.
 */
export const transactionTemplateBulkPatchSchema = z
  .object({
    type: z
      .enum(transactionTypes)
      .nullable()
      .optional()
      .describe(
        "The type every selected template opens the form as, or null to leave the choice to whoever uses it. Setting it drops the account side the new type never reads, and anything but a transfer drops destinationAmount; transfer is refused on a template already split.",
      ),
    date: isoDateSchema
      .nullable()
      .optional()
      .describe(
        "The date every selected template fills into the form, stored as typed and never moved on, so a fixed date quietly backdates every entry made from it months later. Null clears it, so the form starts on the day it is used.",
      ),
    payee: oneLine(z.string().trim().min(1).max(160))
      .nullable()
      .optional()
      .describe(
        "The payee every selected template fills into the form, or null to leave it blank for whoever uses it. An empty string is refused rather than read as that clear, because blank and absent are the whole of what a stored template records.",
      ),
    fromAccountId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "The account a withdrawal or transfer template draws from, or null to leave the form asking. Refused rather than dropped while any selected template is, or is being made into, a deposit, which has no source account.",
      ),
    toAccountId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "The account a deposit or transfer template pays into, or null to leave the form asking. Refused rather than dropped while any selected template is, or is being made into, a withdrawal, which has no destination account.",
      ),
    amount: positiveDecimalStringSchema
      .nullable()
      .optional()
      .describe(
        "The amount every selected template fills into the form, as an exact decimal string and always positive, since the type says which way the money goes. Null clears it, which is what a bill that differs every month wants.",
      ),
    destinationAmount: positiveDecimalStringSchema
      .nullable()
      .optional()
      .describe(
        "What arrives on the far side of a transfer between currencies, in the destination account's currency, so the pair records the rate actually paid. Refused on any selected template that is not a transfer, and setting type to anything else drops it.",
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "The category every selected template files under, or null to leave the choice to whoever uses it. Sent alongside legs it is dropped silently rather than refused, and it is refused outright when a selected template is already split.",
      ),
    categoryName: oneLine(z.string().trim().min(1).max(120))
      .nullable()
      .optional()
      .describe(
        "A category named rather than picked, stored as typed and matched only when the template is used, so nothing is created now and a template may name a category this ledger does not have. Dropped when legs is sent, and ignored where a categoryId is stored.",
      ),
    // Legs move as a whole list or not at all. "Add a leg to thirty templates"
    // has no meaning when each of the thirty splits a different total.
    legs: templateLegsField
      .nullable()
      .optional()
      .describe(
        "The split every selected template opens with, replaced as a whole list rather than added to. It clears any single category on those templates without saying so, null removes the split, and it is refused on a transfer template.",
      ),
    description: freeText(z.string().trim().min(1).max(240))
      .nullable()
      .optional()
      .describe(
        "The description every selected template fills into the form, or null to leave it blank. An empty string is refused rather than read as a clear, and it replaces rather than appends.",
      ),
    notes: freeText(z.string().trim().min(1).max(4_000))
      .nullable()
      .optional()
      .describe(
        "The notes every selected template fills into the form, or null to leave them blank. They are copied into every entry made from it, so anything true of one occasion only belongs on the entry.",
      ),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Choose at least one field to change",
  });

export const transactionTemplateBulkEditSchema = z
  .object({
    selection: transactionTemplateBulkSelectionSchema.describe(
      "Which rows to act on: either an explicit list with the version you read for each, or a filter plus the count and fingerprint a preview handed back. The filter form is refused if the matching set changed since the preview, so a row somebody added in between is never swept up silently.",
    ),
    patch: transactionTemplateBulkPatchSchema.describe(
      "The fields to set on every row in the selection. A key left out is left alone; a key set to null clears it. An empty string is refused rather than read as a clear, because the two mean different things and only one of them is ever what somebody meant.",
    ),
    idempotencyKey: idempotencyKeySchema,
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
      ),
  })
  .strict();

export const transactionTemplateBulkDeleteSchema = z
  .object({
    selection: transactionTemplateBulkSelectionSchema.describe(
      "Which rows to act on: either an explicit list with the version you read for each, or a filter plus the count and fingerprint a preview handed back. The filter form is refused if the matching set changed since the preview, so a row somebody added in between is never swept up silently.",
    ),
    idempotencyKey: idempotencyKeySchema,
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
      ),
  })
  .strict();

export const transactionTemplateBulkResultSchema = z
  .object({
    dryRun: z.boolean(),
    changedCount: z.number().int().nonnegative(),
    items: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export type TransactionTemplateBulkPatch = z.infer<typeof transactionTemplateBulkPatchSchema>;
export type TransactionTemplateBulkSelection = z.infer<
  typeof transactionTemplateBulkSelectionSchema
>;
export type TransactionTemplateBulkResult = z.infer<typeof transactionTemplateBulkResultSchema>;

export const accountCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)).describe(
    "What you call this account. Unique among your accounts.",
  ),
  type: z
    .enum(userAccountTypes)
    .describe(
      "What kind of account this is. credit_card, loan, and other_liability are money you owe; the rest are money you hold.",
    ),
  currency: currencyCodeSchema,
  openingDate: isoDateSchema.describe(
    "The day this account's history starts. The opening balance is recorded on this date, and transactions before it are not counted in a balance as of a later day.",
  ),
  openingBalance: decimalStringSchema.describe(
    'What the account held on its opening date, as a signed decimal string. Positive for money you hold. NEGATIVE for money you owe, so a credit card with 500 outstanding opens at "-500". Use "0" to start from nothing.',
  ),
  institution: oneLine(z.string().trim().max(160))
    .optional()
    .nullable()
    .describe(
      "The bank or provider this account is held with. A label for the person; nothing is derived from it.",
    ),
  notes: freeText(z.string().trim().max(2_000))
    .optional()
    .nullable()
    .describe(
      "Anything worth remembering about this account. A label for the person; nothing is derived from it.",
    ),
  inBudget: z
    .boolean()
    .optional()
    .describe(
      "Whether the money in this account is money the budget is about. On by default, including for credit cards: spending on a card empties an envelope, so leaving cards out would say there is more money to assign than there is. Turn it off for an account the budget should not see, such as a mortgage or a pension. It changes no balance and no report — only the figure for what is left to assign.",
    ),
});

export const accountUpdateSchema = accountCreateSchema
  .partial()
  .extend({ expectedVersion: expectedVersionSchema });

export const categoryCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)).describe(
    "What to call it. Matched against existing categories ignoring case and surrounding space, so a second spelling of one that exists is refused rather than created.",
  ),
  kind: z
    .enum(categoryKinds)
    .describe(
      'Whether this category is for money coming in, money going out, or both. It decides which side of the books an entry naming it posts to, and an entry running against it is a refund rather than a mistake. Prefer "income" or "expense": "both" agrees with whichever direction it is handed, which destroys the signal that makes a refund a refund.',
    ),
  groupId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "The group to file this category under, or null for none. One level only: a group holds categories and never other groups. Grouping changes nothing about how an entry posts — it is a way of reading categories together, on the budget page and nowhere else.",
    ),
});

export const categoryUpdateSchema = categoryCreateSchema
  .partial()
  .extend({ expectedVersion: expectedVersionSchema });

export const categoryMergeSchema = z.object({
  sourceCategoryIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .describe(
      "The categories to merge away. Their transactions and staged rows move to the target and the sources are removed.",
    ),
  targetCategoryId: z
    .string()
    .uuid()
    .describe("The category to keep. Everything filed under the sources ends up here."),
  expectedVersions: z
    .record(z.string(), z.number().int().positive())
    .describe(
      "The `version` you last read for each row, keyed by its id, so a row somebody else changed since is refused rather than silently overwritten. Every id in the selection needs an entry.",
    ),
  targetExpectedVersion: expectedVersionSchema.describe(
    "The `version` you last read on the category being kept, so a merge into a category somebody else changed is refused rather than applied blind.",
  ),
});

// Payees are intentionally derived from transaction text rather than stored in
// a separate table. Source names preserve their exact spelling so variants
// that differ only by case or whitespace can still be selected and merged.
export const payeeNameSchema = oneLine(z.string().min(1).max(160)).refine(
  (value) => value.trim().length > 0,
  "Payee is required",
);

export const payeeListQuerySchema = z.object({
  search: oneLine(z.string().trim().max(160))
    .optional()
    .describe("Match on the payee's name, ignoring case and surrounding space."),
});

export const payeeSummarySchema = z.object({
  name: payeeNameSchema,
  normalizedName: z.string().min(1).max(500),
  transactionCount: z.number().int().nonnegative(),
  stagedTransactionCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const payeeDuplicateGroupSchema = z.object({
  normalizedName: z.string().min(1).max(500),
  count: z.number().int().min(2),
  payees: z.array(payeeSummarySchema).min(2),
});

export const payeeMergeSchema = z
  .object({
    sourcePayees: z
      .array(payeeNameSchema)
      .min(1)
      .max(100)
      .describe(
        "The payee spellings to merge away. Every entry naming one is rewritten to the target.",
      ),
    targetPayee: payeeNameSchema.describe(
      "The spelling to keep. Every entry naming one of the sources is rewritten to this.",
    ),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const payeeMergeResultSchema = z.object({
  targetPayee: payeeNameSchema.describe(
    "The spelling to keep. Every entry naming one of the sources is rewritten to this.",
  ),
  mergedSourcePayees: z.array(payeeNameSchema).min(1),
  updatedTransactionCount: z.number().int().nonnegative(),
  updatedStagedTransactionCount: z.number().int().nonnegative(),
});

export type PayeeSummary = z.infer<typeof payeeSummarySchema>;
export type PayeeDuplicateGroup = z.infer<typeof payeeDuplicateGroupSchema>;
export type PayeeMergeResult = z.infer<typeof payeeMergeResultSchema>;

export const directTransactionCreateSchema = z.object({
  draft: transactionDraftSchema.describe(
    "The entry itself: what moved, when, between which accounts, and under which category. Amounts are always positive — which way the money went is the draft's `type`.",
  ),
  idempotencyKey: idempotencyKeySchema,
  allowDuplicate: z
    .boolean()
    .default(false)
    .describe(
      "Write the entry even though one with the same payee, amount and date already exists nearby. Leave it false and read the refusal first: the duplicate check is what stops a statement being imported twice.",
    ),
});

export const transactionUpdateSchema = z.object({
  draft: transactionDraftSchema.describe(
    "The entry itself: what moved, when, between which accounts, and under which category. Amounts are always positive — which way the money went is the draft's `type`.",
  ),
  expectedVersion: expectedVersionSchema,
  allowDuplicate: z
    .boolean()
    .default(false)
    .describe(
      "Write the entry even though one with the same payee, amount and date already exists nearby. Leave it false and read the refusal first: the duplicate check is what stops a statement being imported twice.",
    ),
});

export const versionedMutationSchema = z.object({
  expectedVersion: expectedVersionSchema,
});

export const transactionDeletedMutationSchema = versionedMutationSchema.extend({
  deleted: z
    .boolean()
    .describe(
      "True to delete, false to restore. Deleting posts the entry's reversal rather than erasing it, so it nets to zero and can be put back; restoring posts it again.",
    ),
  allowDuplicate: z
    .boolean()
    .default(false)
    .describe(
      "Write the entry even though one with the same payee, amount and date already exists nearby. Leave it false and read the refusal first: the duplicate check is what stops a statement being imported twice.",
    ),
});

export const stageCreateSchema = z
  .object({
    draft: stagedDraftSchema.describe(
      "The proposed entry. Unlike a committed transaction this may be incomplete or unreadable in places — a row imported from a bank file is staged as it arrived, issues and all, because that is the row somebody opened the queue to repair.",
    ),
    idempotencyKey: idempotencyKeySchema,
    rawData: z
      .record(z.string(), z.unknown())
      .optional()
      .nullable()
      .describe(
        "The original row this draft was read from, kept beside it so somebody repairing the row can see what actually arrived. Nothing reads it back into the entry.",
      ),
  })
  .strict();

/**
 * The most rows one bulk selection may carry. Every bulk request that lists ids
 * is capped here, and the HTTP body limit for those routes is derived from it,
 * so raising the cap cannot leave the transport rejecting payloads the schemas
 * accept.
 */
export const MAX_BULK_SELECTION_ENTRIES = 10_000;

export const stageUpdateSchema = z.object({
  draft: stagedDraftSchema.describe(
    "The proposed entry. Unlike a committed transaction this may be incomplete or unreadable in places — a row imported from a bank file is staged as it arrived, issues and all, because that is the row somebody opened the queue to repair.",
  ),
  expectedVersion: expectedVersionSchema,
});

/**
 * Strict for the reason `bulkDeleteStageSchema` below is: HTTP used to drop an
 * unrecognised key that MCP refused by name, and this is the route that puts
 * money in the books.
 */
export const commitStageSchema = z.object({
  stagedIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_BULK_SELECTION_ENTRIES)
    .describe(
      "The staged rows to act on, named explicitly. There is no filter form here: this is all-or-nothing, so the caller says exactly which rows.",
    ),
  expectedVersions: z
    .record(z.string(), z.number().int().positive())
    .describe(
      "The `version` you last read for each row, keyed by its id, so a row somebody else changed since is refused rather than silently overwritten. Every id in the selection needs an entry.",
    ),
  idempotencyKey: idempotencyKeySchema,
  allowDuplicates: z
    .boolean()
    .default(false)
    .describe(
      "Write rows that look like entries already in the ledger. Leave it false and read the refusal first: the duplicate check is what stops the same statement landing twice.",
    ),
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
    ),
});

/**
 * Open, like every other shared schema, and strict only at the tool boundary.
 *
 * An agent naming `expectedVersion` where the field is `expectedVersions` is
 * refused with the field named, because the MCP registration wraps this in
 * `.strict()`. Over HTTP the key is dropped and the request reads as one that
 * named no versions — worse, and deliberately left that way for now: making the
 * shared schema strict narrows what an existing caller may send, and a release
 * does not take something away from a client that had it. It goes in a release
 * that can carry the change, which `AGENTS.md` describes.
 */
export const bulkDeleteStageSchema = z.object({
  stagedIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_BULK_SELECTION_ENTRIES)
    .describe(
      "The staged rows to act on, named explicitly. There is no filter form here: this is all-or-nothing, so the caller says exactly which rows.",
    ),
  expectedVersions: z
    .record(z.string(), z.number().int().positive())
    .describe(
      "The `version` you last read for each row, keyed by its id, so a row somebody else changed since is refused rather than silently overwritten. Every id in the selection needs an entry.",
    ),
  // The last bulk route to get one. Every other bulk write lets a caller ask
  // what would happen before doing it; this one made you find out by doing it,
  // which is the wrong way round for the operation that removes rows.
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
    ),
});

export const dateRangeSchema = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
});

/**
 * How far apart two dates can be and still describe the same money moving.
 *
 * A statement row and the same purchase entered by hand rarely land on one day:
 * the bank posts when it settles. Three days either side covers that without
 * making a weekly shop of the same amount look like a repeat of last week's.
 */
export const LIKELY_DUPLICATE_DAYS = 3;

export const reportNames = [
  "net-worth",
  "income-expense",
  "categories",
  "cash-flow",
  "balance-sheet",
  "trial-balance",
] as const;
export type ReportName = (typeof reportNames)[number];

export const reportBuckets = ["none", "week", "month", "quarter", "year"] as const;
export type ReportBucket = (typeof reportBuckets)[number];

/**
 * The periods a budget can run on.
 *
 * Declared as report buckets rather than merely resembling them. A limit and
 * the spending it is compared against have to land on one grid, and the only
 * way to be sure of that is for the budget to be unable to name a period the
 * report engine cannot bucket by. `satisfies` is what enforces it: add a period
 * here that is not a bucket and this stops compiling.
 *
 * `none` is deliberately absent. A budget over all of time is not a budget.
 * Pay-cycle and 4-4-5 periods are absent too, and that is a decision rather
 * than an oversight: two of the three envelope products that lead this field
 * refuse them as well.
 */
export const budgetPeriodUnits = [
  "week",
  "month",
  "quarter",
  "year",
] as const satisfies readonly ReportBucket[];
export type BudgetPeriodUnit = (typeof budgetPeriodUnits)[number];

/**
 * How a plan's per-period amount is arrived at.
 *
 * Stored, and never asked for. There is no method chooser in this product and
 * the word does not appear on the page: a budget with a target and a date is a
 * sinking fund because of what it says, not because somebody picked "sinking
 * fund" from a list. The column exists so the check constraints can hold the
 * parameters to the shape they belong to, and so a reader of the row can tell
 * which arithmetic produced the figure.
 *
 * Each rule is named by the parameter it needs and by nothing else: a lookback
 * is a trailing average, a percentage of the last period is an incremental
 * budget, a percentage of income is a share of what came in. Two of them at
 * once is refused, because the row would have to decide which one it meant.
 */
/**
 * Whether a group's budget stands on its own or is what its members add up to.
 *
 * Declared on the group because both are defensible and picking one silently is
 * the failure: Monarch's group budget stands alone and hledger's is the sum of
 * its children, and a person who expects one and gets the other has a page of
 * figures that are all wrong in the same direction.
 */
export const budgetGroupPolicies = ["standalone", "sum_of_children"] as const;
export type BudgetGroupPolicy = (typeof budgetGroupPolicies)[number];

/**
 * A group somebody names, with the one decision that cannot be silent.
 *
 * The name is normalised the way a category's is, so "Fixed costs" and "fixed
 * costs" are one group rather than two that split a budget between them.
 */
export const categoryGroupCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(
        "What the group is called, as somebody would write it. Compared without case or spacing, so two spellings of one name are one group.",
      ),
    policy: z
      .enum(budgetGroupPolicies)
      .describe(
        "Whether the group holds a budget of its own (standalone) or is whatever its categories add up to (sum_of_children). It has no default because both are defensible and being given the other one silently makes every figure on the page wrong in the same direction.",
      ),
  })
  .strict();

export const categoryGroupUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional().describe("A new name. Left alone if absent."),
    policy: z
      .enum(budgetGroupPolicies)
      .optional()
      .describe(
        "Change how the group is budgeted. Moving to sum_of_children while the group has a budget of its own is refused, because that budget would stop being read and nothing would say so.",
      ),
    expectedVersion: expectedVersionSchema,
  })
  .strict();

export const budgetAmountRules = [
  "fixed",
  "sinking_fund",
  "trailing_average",
  "incremental",
  "percent_of_income",
] as const;
export type BudgetAmountRule = (typeof budgetAmountRules)[number];

/**
 * A budget may be zero, which is a real budget meaning "anything here is over".
 * It may not be negative. Without this the value travelled all the way to the
 * table's check constraint and came back as a 500 with a stack trace, for what
 * is only ever a mistyped amount.
 */
const budgetAmountSchema = decimalStringSchema.refine(
  (value) => !value.trimStart().startsWith("-"),
  { message: "A budget cannot be negative. Use zero to budget nothing." },
);

const budgetTarget = {
  categoryId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "The category this budget is about. One budget per category, currency and period length. Send this or groupId, never both.",
    ),
  groupId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "The category group this budget is about, for a group that holds a budget of its own. A group budgeted as whatever its categories add up to is refused, because it already has an amount and a second one would have an equal claim to be the group's.",
    ),
  currency: currencyCodeSchema,
  periodUnit: z
    .enum(budgetPeriodUnits)
    .describe(
      "The length of one budget period. Both ends of the plan's window snap to the start of a period of this length, so a stored period start is the period's name rather than an arbitrary date.",
    ),
};

/**
 * A boolean that arrived as a query string.
 *
 * Exported because five routes used to compare `=== "true"` by hand, which
 * silently reads `?includeArchived=yes` as false: the caller asked for
 * something, was not refused, and got the opposite. This refuses anything that
 * is not `true` or `false`, which is the behaviour a caller can learn from.
 *
 * The budget report was a sixth. It kept its own `=== "true"` in the transport
 * for two flags that default to **on**, so `?includeArchived=1` turned them off
 * without saying so — and on that report, off means every penny spent through a
 * closed account silently leaves the figures. The default is the only thing
 * that differed, so it is a parameter now rather than a reason to hand-roll it.
 */
export const queryBoolean = (whenAbsent: boolean) =>
  z
    .union([
      z.boolean(),
      z.literal("true").transform(() => true),
      z.literal("false").transform(() => false),
    ])
    .default(whenAbsent);

export const queryBooleanSchema = queryBoolean(false);

/**
 * A standing budget for one category, per period, in one currency.
 *
 * There is no amount spanning currencies here and there is nowhere to put one.
 * A budget is a vector the way net worth is, because this ledger holds no
 * exchange rate that is not the rate some transfer actually got, and a
 * converted total would be the one figure on the page nobody could check.
 */
/**
 * What a budget does with the difference at the end of a period.
 *
 * Shared by create and update so the two cannot drift, and written as one
 * object because the three fields are one decision. Off, this is a limit that
 * starts again every period. On, it is an envelope: what was not spent belongs
 * to the next period and what was overspent is owed by it. A target turns the
 * same machinery into a sinking fund, which funds itself over the periods
 * between now and the date it is needed.
 */
const budgetRule = {
  lookbackPeriods: z
    .number()
    .int()
    .min(1)
    .max(24)
    .nullable()
    .optional()
    .describe(
      "Budget the average of what was actually spent over this many finished periods, rather than a fixed amount. The current period is never part of its own average. Send null to go back to a fixed amount. Refused alongside percentOfPrevious or percentOfIncome, because a budget can only be worked out one way.",
    ),
  percentOfPrevious: decimalStringSchema
    .nullable()
    .optional()
    .describe(
      "Budget the previous period's amount plus this percentage — 3 for three per cent more each period, 0 to repeat it, a negative number to taper. The first period of the window uses the plain amount as its base. Send null to go back to a fixed amount.",
    ),
  percentOfIncome: decimalStringSchema
    .nullable()
    .optional()
    .describe(
      "Budget this percentage of the income that arrived in the previous whole period. The previous one rather than this one, because a share of a period that has not finished is a figure that changes every time you look at it. Send null to go back to a fixed amount.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe(
      "Which budgets are funded first when a period's income will not cover them all. Lower goes first, the way nice does, and everything defaults to zero, which is every budget equal. It changes no limit: what it decides is the funded figure the report works out for each row.",
    ),
};

const budgetCarry = {
  rollover: z
    .boolean()
    .optional()
    .describe(
      "Carry the difference into the next period: what is left over is added to it, and an overspend is subtracted from it as a debt. Off, which is the default, means every period starts again at the amount. This stores nothing per period — the carry is worked out from the same plans, entries and postings the figures already come from.",
    ),
  rolloverCap: decimalStringSchema
    .nullable()
    .optional()
    .describe(
      "The most that may be carried in either direction, or null for no limit. It is symmetric: a fund nobody has drawn on for three years and a category three thousand in debt to itself are the same runaway. Only meaningful with rollover on.",
    ),
  targetAmount: decimalStringSchema
    .nullable()
    .optional()
    .describe(
      "Turn this budget into a sinking fund saving up for this much. The amount for each period is worked out rather than fixed: what is still needed, divided by the periods left before targetDate. Requires targetDate and rollover, since a fund that does not keep what it saved saves nothing.",
    ),
  targetDate: isoDateSchema
    .nullable()
    .optional()
    .describe(
      "The date the target amount is needed by. Requires targetAmount. Once the fund is full, or the date has passed, the amount for each period is nothing.",
    ),
};

/**
 * The rules that hold the carry fields to each other.
 *
 * Refused here rather than by a check constraint: the constraint arrives as a
 * 500 with a stack trace for what is only ever an incomplete form, and the
 * sentence somebody reads should say which of the two halves is missing.
 *
 * Written as three predicates applied by hand at each schema rather than as a
 * wrapper around both. A wrapper would have to be generic over the schema it
 * refines, and a generic wrapper returns a plain `ZodType` — which drops
 * `.extend()`, and `src/server/mcp.ts` extends both of these to add an
 * idempotency key.
 */
type BudgetCarryFields = {
  rollover?: boolean | undefined;
  rolloverCap?: string | null | undefined;
  targetAmount?: string | null | undefined;
  targetDate?: string | null | undefined;
};

/** Zero or below, read off the text rather than by parsing to a float. */
const decimalIsNegativeOrZero = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) return true;
  return /^\+?0*(\.0*)?$/.test(trimmed);
};

const carryHalves = (value: BudgetCarryFields) =>
  (value.targetAmount == null) === (value.targetDate == null);
const carryHalvesMessage = {
  message:
    "A sinking fund needs both an amount to save and a date to have it by. Send both, or neither.",
  path: ["targetDate"],
};

const sinkingFundRolls = (value: BudgetCarryFields) =>
  value.targetAmount == null || value.rollover !== false;
const sinkingFundRollsMessage = {
  message:
    "A sinking fund has to carry what it saved into the next period, so rollover cannot be off.",
  path: ["rollover"],
};

const targetIsPositive = (value: BudgetCarryFields) =>
  value.targetAmount == null || !decimalIsNegativeOrZero(value.targetAmount);
const targetIsPositiveMessage = {
  message: "A sinking fund's target has to be more than nothing.",
  path: ["targetAmount"],
};

const capIsNotNegative = (value: BudgetCarryFields) =>
  value.rolloverCap == null || !value.rolloverCap.trimStart().startsWith("-");
const oneTarget = (value: { categoryId?: string | undefined; groupId?: string | undefined }) =>
  (value.categoryId === undefined) !== (value.groupId === undefined);
const oneTargetMessage = {
  message: "A budget is about a category or a group. Send exactly one of categoryId and groupId.",
  path: ["categoryId"],
};

const capIsNotNegativeMessage = {
  message: "A carry cap cannot be negative. It applies in both directions.",
  path: ["rolloverCap"],
};

type BudgetRuleFields = {
  lookbackPeriods?: number | null | undefined;
  percentOfPrevious?: string | null | undefined;
  percentOfIncome?: string | null | undefined;
  targetAmount?: string | null | undefined;
};

/**
 * One way of working out the amount, or none.
 *
 * Each rule is named by the parameter it needs, so two parameters is a row that
 * cannot say which arithmetic it meant. The target belongs in the count: a
 * sinking fund is a derived amount too, and a fund with a trailing average
 * beside it is the same contradiction one story later.
 */
const oneRuleAtMost = (value: BudgetRuleFields) =>
  [
    value.lookbackPeriods,
    value.percentOfPrevious,
    value.percentOfIncome,
    value.targetAmount,
  ].filter((parameter) => parameter != null).length <= 1;
const oneRuleAtMostMessage = {
  message:
    "A budget works out its amount one way. Send a lookback, a percentage of the last period, a percentage of income, or a savings target — not two of them.",
  path: ["lookbackPeriods"],
};

const percentagesAreNumbers = (value: BudgetRuleFields) =>
  [value.percentOfPrevious, value.percentOfIncome].every(
    (percent) => percent == null || /^[+-]?\d+(\.\d+)?$/.test(percent.trim()),
  );
const percentagesAreNumbersMessage = {
  message: "A percentage is a plain number, such as 3 or 12.5. Leave the per-cent sign out.",
  path: ["percentOfIncome"],
};

const incomeShareIsAShare = (value: BudgetRuleFields) =>
  value.percentOfIncome == null || Number(value.percentOfIncome) >= 0;
const incomeShareIsAShareMessage = {
  message: "A share of income cannot be negative.",
  path: ["percentOfIncome"],
};

export const budgetPlanCreateSchema = z
  .object({
    ...budgetTarget,
    amount: budgetAmountSchema,
    activeFrom: isoDateSchema,
    activeTo: isoDateSchema
      .nullable()
      .optional()
      .describe(
        "The last period this budget applies to, named by any date inside it: the value is snapped back to that period's first day, and the budget covers the whole of it. Present and null ends an open-ended budget; absent leaves whatever is there alone.",
      ),
    ...budgetCarry,
    ...budgetRule,
  })
  .strict()
  .refine((value) => value.activeTo == null || value.activeTo >= value.activeFrom, {
    message: "A budget cannot end before it starts.",
    path: ["activeTo"],
  })
  .refine(carryHalves, carryHalvesMessage)
  .refine(sinkingFundRolls, sinkingFundRollsMessage)
  .refine(targetIsPositive, targetIsPositiveMessage)
  .refine(capIsNotNegative, capIsNotNegativeMessage)
  .refine(oneRuleAtMost, oneRuleAtMostMessage)
  .refine(percentagesAreNumbers, percentagesAreNumbersMessage)
  .refine(incomeShareIsAShare, incomeShareIsAShareMessage)
  .refine(oneTarget, oneTargetMessage);

export const budgetPlanUpdateSchema = z
  .object({
    amount: budgetAmountSchema.optional(),
    activeFrom: isoDateSchema.optional(),
    // Present and null ends the plan, absent leaves it alone. The distinction
    // is the one the templates already draw, so it reads the same way here.
    activeTo: isoDateSchema
      .nullable()
      .optional()
      .describe(
        "The last period this budget applies to, named by any date inside it: the value is snapped back to that period's first day, and the budget covers the whole of it. Present and null ends an open-ended budget; absent leaves whatever is there alone.",
      ),
    ...budgetCarry,
    ...budgetRule,
    expectedVersion: expectedVersionSchema,
  })
  .strict()
  // The same four rules as a create, and they read the patch rather than the
  // row: a field left out keeps what the row already had, so the service fills
  // the gaps from the stored plan and re-checks the pair. What is caught here
  // is a patch that is wrong on its own terms — a target amount with no date
  // beside it, a fund told not to roll over.
  .refine(carryHalves, carryHalvesMessage)
  .refine(sinkingFundRolls, sinkingFundRollsMessage)
  .refine(targetIsPositive, targetIsPositiveMessage)
  .refine(capIsNotNegative, capIsNotNegativeMessage)
  .refine(oneRuleAtMost, oneRuleAtMostMessage)
  .refine(percentagesAreNumbers, percentagesAreNumbersMessage)
  .refine(incomeShareIsAShare, incomeShareIsAShareMessage);

/** One period's amount, overriding whatever a plan would have said. */
export const budgetEntrySetSchema = z
  .object({
    ...budgetTarget,
    periodStart: isoDateSchema,
    amount: budgetAmountSchema,
    // Absent on the first set, required to change one that is already there.
    expectedVersion: expectedVersionSchema.optional(),
  })
  .strict()
  .refine(oneTarget, oneTargetMessage);

export const budgetReportQuerySchema = z
  .object({
    start: isoDateSchema.optional(),
    end: isoDateSchema.optional(),
    periodUnit: z
      .enum(budgetPeriodUnits)
      .default("month")
      .describe(
        "Report one row per period of this length. A range picks which periods to show; it never slices one in half, so spending is always counted over whole periods.",
      ),
    // On, unlike every other report, and deliberately. Elsewhere an archived
    // account's balance is genuinely closed out, so leaving it in would double
    // count. A budget compares spending against a limit that was never scoped
    // to an account, so money spent on a card since closed is money the budget
    // covered: filtering it makes a budget spent to the penny read as underspent.
    includeArchived: queryBoolean(true).describe(
      "Include spending that went through an account you have since closed. On by default, and unlike every other report: a budget was never scoped to an account, so money spent on a card you have closed is money the budget covered, and leaving it out makes a budget spent to the penny read as underspent.",
    ),
    // Spending in categories nobody budgeted. On by default, because the
    // question "where did the rest go" is the one a budget raises, and a page
    // that answered it only when asked would be hiding the gap. Turn it off to
    // see the budget alone.
    includeUnbudgeted: queryBoolean(true).describe(
      "Include categories with no budget set, so spending that nobody planned for is visible rather than quietly absent. Their limit comes back null.",
    ),
  })
  .strict();

/** How a report treats time: a period's own movement, or the balance it ends on. */
export const reportAccumulations = ["change", "historical"] as const;
export type ReportAccumulation = (typeof reportAccumulations)[number];

/**
 * Which accounts hold money that can be spent without selling something first.
 * Cash flow is the only report that needs the distinction, and it takes it from
 * the type the person already chose rather than from a second thing to declare.
 */
export const cashAccountTypes = ["checking", "savings", "cash"] as const;

/**
 * A ledger with a long history asked for weekly buckets is a request for
 * thousands of columns nobody can read and a response nobody wants to hold in
 * memory. Refused with the coarser bucket named, rather than served slowly.
 */
export const MAX_REPORT_BUCKETS = 600;

/**
 * How far back a rollover carry is folded before the periods being reported.
 *
 * A carry depends on every period since the budget started, so a budget running
 * since 2019 asked for one month in 2026 is eighty periods of arithmetic to
 * answer a question about one. That is fine and it is also unbounded, which is
 * the shape of a page that gets slower every month it exists.
 *
 * So the fold has a bound, and a report that hit it says so rather than
 * quietly reporting a carry that started from nothing in the middle of a
 * budget's life. Ten years of months, two and a half of weeks: long enough that
 * nobody meets it by accident, short enough that the query behind it stays one
 * indexed scan.
 */
export const MAX_ROLLOVER_PERIODS = 120;

/**
 * The most postings one register will list. Refused rather than truncated: a
 * register is read to find the row a balance went wrong on, and one cut short
 * would close on a balance its own last row does not reach.
 */
export const MAX_REGISTER_ENTRIES = 10_000;

export const reportNameSchema = z.enum(reportNames).describe("Which report to run.");

export const reportQuerySchema = dateRangeSchema.extend({
  report: reportNameSchema,
  bucket: z
    .enum(reportBuckets)
    .optional()
    .describe(
      "Group the report by day, week, month, quarter or year. Defaults to whatever suits the range asked for.",
    ),
});

export const sortDirections = ["asc", "desc"] as const;
export type SortDirection = (typeof sortDirections)[number];

/** Every column the transaction list puts on screen can order it. */
const transactionSortFields = ["date", "payee", "account", "category", "amount"] as const;
export type TransactionSortField = (typeof transactionSortFields)[number];

/** Same rule for the staged queue. */
const stageSortFields = ["date", "payee", "account", "category", "status", "amount"] as const;
export type StageSortField = (typeof stageSortFields)[number];

export const listQuerySchema = dateRangeSchema.extend({
  // Described because these five were the worst case on the whole agent
  // surface: a list published `sort`, `direction`, `cursor`, `page` and `limit`
  // with nothing on any of them, which are exactly the five an agent has to
  // guess at. They are shared by every list, so one description each covers the
  // lot.
  sort: z
    .enum(transactionSortFields)
    .default("date")
    .describe(
      "Which column to order by. Ordering is presentation only and never changes which rows match.",
    ),
  direction: z
    .enum(sortDirections)
    .default("desc")
    .describe('Ascending or descending. Defaults to newest first ("desc").'),
  cursor: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Resume token from a previous page, taken from `nextCursor`. It records the ordering it was issued for and is refused under another, so re-read from page 1 after changing `sort` or `direction`. Some orderings cannot be resumed and offer no cursor; page through those by number instead.",
    ),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(1)
    .describe(
      "1-based page number, for orderings that offer no cursor. Ignored when `cursor` is sent.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Rows per page, 1 to 200. Defaults to 50."),
  accountId: z.string().uuid().optional().describe("Only rows touching this account."),
  categoryId: z.string().uuid().optional().describe("Only rows filed under this category."),
  templateId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Only rows started from this template. Provenance only; a deleted template leaves its rows alone.",
    ),
  payee: oneLine(z.string().trim().min(1).max(160))
    .optional()
    .describe("Only rows whose payee matches, ignoring case and surrounding space."),
  type: z
    .enum(transactionTypes)
    .optional()
    .describe("Only deposits, only withdrawals, or only transfers."),
  currency: currencyCodeSchema
    .optional()
    .describe(
      "Only rows that touch this currency on either side, so a conversion matches under both the currency it left and the one it arrived in.",
    ),
  search: oneLine(z.string().trim().max(200))
    .optional()
    .describe(
      "Free text matched against the payee, the description and the notes, ignoring case. It narrows the rows; it is not a filter on one named field.",
    ),
  includeDeleted: queryBooleanSchema.describe(
    "Show entries that have been deleted. A deleted entry is not erased — its reversal is posted, so it already nets to zero — and it stays visible here so it can be restored.",
  ),
});

// Bulk filter selections deliberately omit pagination. They describe the
// complete current view, while explicit selections carry the optimistic
// versions shown to the user on the current page. Leaving `page` in would scope
// a fingerprinted selection to whichever page happened to be open.
// Order is presentation, not scope. Leaving it in would make two requests that
// select the same rows look like different selections to the fingerprint.
const bulkTransactionFilterSchema = listQuerySchema
  .omit({ cursor: true, page: true, limit: true, sort: true, direction: true })
  .strict();

const bulkTransactionIdSelectionSchema = z
  .object({
    mode: z
      .literal("ids")
      .describe(
        'Which of the two ways of naming rows this selection uses: "ids" names each row with the version you read for it, "filter" describes a view the server resolves. Use "filter" only with the count and fingerprint a preview handed back.',
      ),
    items: z
      .array(
        z
          .object({
            id: z
              .string()
              .uuid()
              .describe(
                "Which row this entry of the selection is about. It has to exist and be yours: one that does not resolve fails the whole call rather than being passed over, so the rows changed always match the rows you named.",
              ),
            expectedVersion: expectedVersionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BULK_SELECTION_ENTRIES)
      .describe(
        "The rows to act on, each with the version you last read for it, and the whole of what will change. A duplicated id, an id that is not yours, or a version that has moved refuses the entire call rather than changing part of it.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = selection.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Transaction IDs must be unique",
      });
    }
  });

const bulkTransactionFilterSelectionSchema = z
  .object({
    mode: z
      .literal("filter")
      .describe(
        'Which of the two ways of naming rows this selection uses: "ids" names each row with the version you read for it, "filter" describes a view the server resolves. Use "filter" only with the count and fingerprint a preview handed back.',
      ),
    filter: bulkTransactionFilterSchema.describe(
      "The same filters the matching list route takes. Preview it first: the preview returns the count and the fingerprint a write has to send back.",
    ),
    excludedIds: z
      .array(z.string().uuid())
      .max(MAX_BULK_SELECTION_ENTRIES)
      .default([])
      .describe(
        'Rows to leave out of an otherwise-matching filter, so somebody can say "all of these except those" without listing the rest.',
      ),
    expectedCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_BULK_SELECTION_ENTRIES)
      .describe(
        "How many rows the preview said this filter matched. The write is refused if the filter now matches a different number, so a row added, deleted or edited into the view since the preview stops the call instead of being swept up.",
      ),
    expectedFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "The fingerprint the preview returned for this exact set, covering every row's id and version rather than just the count. Checked when the selection is read and again under lock, so a row changed in between fails the whole call.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded transaction IDs must be unique",
      });
    }
  });

export const bulkTransactionSelectionSchema = z.discriminatedUnion("mode", [
  bulkTransactionIdSelectionSchema,
  bulkTransactionFilterSelectionSchema,
]);

export const bulkTransactionFilterSelectionRequestSchema = z
  .object({
    filter: bulkTransactionFilterSchema.describe(
      "The same filters the matching list route takes. Preview it first: the preview returns the count and the fingerprint a write has to send back.",
    ),
    excludedIds: z
      .array(z.string().uuid())
      .max(MAX_BULK_SELECTION_ENTRIES)
      .default([])
      .describe(
        'Rows to leave out of an otherwise-matching filter, so somebody can say "all of these except those" without listing the rest.',
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded transaction IDs must be unique",
      });
    }
  });

export const bulkTransactionSelectionSnapshotSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    activeCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
    splitCount: z.number().int().nonnegative(),
    currencies: z.array(currencyCodeSchema),
  })
  .strict();

const bulkTransactionPatchSchema = z
  .object({
    date: isoDateSchema
      .optional()
      .describe(
        "Moves every selected entry to this date. The correction is appended at the new date rather than written over the old postings, so any balance read between the two changes. A date after today counts toward no balance or cash flow until it arrives.",
      ),
    payee: z
      .string()
      .trim()
      .min(1, "Payee is required")
      .max(160)
      .optional()
      .describe(
        'Renames the payee on every selected row to this one, canonicalised against the spellings you already use, so "tesco" files under "Tesco". Not a search and replace: rows that had different payees all end up with this one.',
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "Files every selected entry under this category, or under none when null. A selection holding a split is refused, and so is a category whose kind runs against an entry's direction: that would make those entries refunds for rows nobody looked at.",
      ),
    accountId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Moves every selected entry to this account, on the side its type reads: destination for a deposit, source for a withdrawal. A selection holding a transfer is refused, and so is an account in another currency, since a bulk edit never re-denominates money.",
      ),
    description: z
      .string()
      .trim()
      .max(240)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value))
      .describe(
        "Replaces the description on every selected row; null, or an empty string, clears it. It overwrites rather than appends, so whatever each row said is gone. Leave the key out to keep what is there.",
      ),
    notes: z
      .string()
      .trim()
      .max(4_000)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value))
      .describe(
        "Replaces the working notes on every selected row; null, or an empty string, clears them. Nothing is appended, so a long note on one row is lost to a short one applied across the selection.",
      ),
    type: z
      .enum(["deposit", "withdrawal"])
      .optional()
      .describe(
        "Flips every selected entry between deposit and withdrawal, keeping its amount and carrying its account to the side the new type reads. A selection holding a transfer or a split is refused: flipping direction under several legs would make every one a refund.",
      ),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Choose at least one field to update",
  });

export const bulkTransactionEditSchema = z
  .object({
    selection: bulkTransactionSelectionSchema.describe(
      "Which rows to act on: either an explicit list with the version you read for each, or a filter plus the count and fingerprint a preview handed back. The filter form is refused if the matching set changed since the preview, so a row somebody added in between is never swept up silently.",
    ),
    patch: bulkTransactionPatchSchema.describe(
      "The fields to set on every row in the selection. A key left out is left alone; a key set to null clears it. An empty string is refused rather than read as a clear, because the two mean different things and only one of them is ever what somebody meant.",
    ),
    idempotencyKey: idempotencyKeySchema,
    allowDuplicates: z
      .boolean()
      .default(false)
      .describe(
        "Write rows that look like entries already in the ledger. Leave it false and read the refusal first: the duplicate check is what stops the same statement landing twice.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
      ),
  })
  .strict();

/** Named so an agent can tell the two selection shapes apart without guessing. */
export const bulkTransactionDeleteSchema = z
  .object({
    selection: bulkTransactionSelectionSchema.describe(
      "Which rows to act on: either an explicit list with the version you read for each, or a filter plus the count and fingerprint a preview handed back. The filter form is refused if the matching set changed since the preview, so a row somebody added in between is never swept up silently.",
    ),
    idempotencyKey: idempotencyKeySchema,
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
      ),
  })
  .strict();

const bulkTransactionEditItemSchema = z
  .object({
    id: z.string().uuid(),
    previousVersion: z.number().int().positive(),
    nextVersion: z.number().int().positive(),
    type: z.enum(transactionTypes),
    date: isoDateSchema,
    payee: payeeNameSchema,
  })
  .strict();

export const bulkTransactionEditResultSchema = z
  .object({
    updatedCount: z.number().int().nonnegative(),
    dryRun: z.boolean(),
    selectionCount: z.number().int().nonnegative(),
    selectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    activeCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
    // Defaulted because this result is replayed out of an idempotency
    // record, and one written before splits existed carries no count. A
    // retry spanning the upgrade has to return the original answer, which
    // is the whole point of the key.
    splitCount: z.number().int().nonnegative().default(0),
    currencies: z.array(currencyCodeSchema),
    itemsTruncated: z.boolean(),
    items: z.array(bulkTransactionEditItemSchema),
  })
  .strict();

export type BulkTransactionFilter = z.infer<typeof bulkTransactionFilterSchema>;
export type BulkTransactionSelectionSnapshot = z.infer<
  typeof bulkTransactionSelectionSnapshotSchema
>;
export type BulkTransactionPatch = z.infer<typeof bulkTransactionPatchSchema>;
export type BulkTransactionEditInput = z.infer<typeof bulkTransactionEditSchema>;
export type BulkTransactionEditResult = z.infer<typeof bulkTransactionEditResultSchema>;

/**
 * `currency` and `includeDeleted` are dropped rather than inherited. A draft
 * carries no currency of its own, and a staged row is in the queue or gone
 * rather than deleted, so both would be accepted and then ignored.
 */
export const stageListQuerySchema = listQuerySchema
  .omit({ currency: true, includeDeleted: true })
  .extend({
    sort: z
      .enum(stageSortFields)
      .default("date")
      .describe(
        "Which column to order by. Ordering is presentation only and never changes which rows match.",
      ),
    importBatchId: z.string().uuid().optional().describe("Only rows from this CSV import."),
    recurrenceId: z.string().uuid().optional().describe("Only rows proposed by this recurrence."),
    validity: z
      .enum(["valid", "invalid", "duplicate"])
      .optional()
      .describe(
        "Only rows that would commit cleanly, only rows with an issue, or only rows that look like something already in the ledger.",
      ),
  });

/**
 * Only the fields `stageFilterConditions` actually applies, with the paging and
 * ordering that describe a view rather than scope it taken out.
 *
 * `.strict()` is the load-bearing part: a filter this cannot honour is an error
 * rather than a key quietly dropped, because a selection resolves twice and an
 * ignored filter makes the count and the fingerprint agree about the wrong set.
 */
export const bulkStageFilterSchema = stageListQuerySchema
  .omit({
    cursor: true,
    page: true,
    limit: true,
    sort: true,
    direction: true,
  })
  .strict();

const bulkStageIdSelectionSchema = z
  .object({
    mode: z
      .literal("ids")
      .describe(
        'Which of the two ways of naming rows this selection uses: "ids" names each row with the version you read for it, "filter" describes a view the server resolves. Use "filter" only with the count and fingerprint a preview handed back.',
      ),
    items: z
      .array(
        z
          .object({
            id: z
              .string()
              .uuid()
              .describe(
                "Which row this entry of the selection is about. It has to exist and be yours: one that does not resolve fails the whole call rather than being passed over, so the rows changed always match the rows you named.",
              ),
            expectedVersion: expectedVersionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BULK_SELECTION_ENTRIES)
      .describe(
        "The rows to act on, each with the version you last read for it, and the whole of what will change. A duplicated id, an id that is not yours, or a version that has moved refuses the entire call rather than changing part of it.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    const ids = selection.items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Staged transaction IDs must be unique",
      });
    }
  });

const bulkStageFilterSelectionSchema = z
  .object({
    mode: z
      .literal("filter")
      .describe(
        'Which of the two ways of naming rows this selection uses: "ids" names each row with the version you read for it, "filter" describes a view the server resolves. Use "filter" only with the count and fingerprint a preview handed back.',
      ),
    filter: bulkStageFilterSchema.describe(
      "The same filters the matching list route takes. Preview it first: the preview returns the count and the fingerprint a write has to send back.",
    ),
    excludedIds: z
      .array(z.string().uuid())
      .max(MAX_BULK_SELECTION_ENTRIES)
      .default([])
      .describe(
        'Rows to leave out of an otherwise-matching filter, so somebody can say "all of these except those" without listing the rest.',
      ),
    expectedCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_BULK_SELECTION_ENTRIES)
      .describe(
        "How many rows the preview said this filter matched. The write is refused if the filter now matches a different number, so a row added, deleted or edited into the view since the preview stops the call instead of being swept up.",
      ),
    expectedFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "The fingerprint the preview returned for this exact set, covering every row's id and version rather than just the count. Checked when the selection is read and again under lock, so a row changed in between fails the whole call.",
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded staged transaction IDs must be unique",
      });
    }
  });

export const bulkStageSelectionSchema = z.discriminatedUnion("mode", [
  bulkStageIdSelectionSchema,
  bulkStageFilterSelectionSchema,
]);

export const bulkStageFilterSelectionRequestSchema = z
  .object({
    filter: bulkStageFilterSchema.describe(
      "The same filters the matching list route takes. Preview it first: the preview returns the count and the fingerprint a write has to send back.",
    ),
    excludedIds: z
      .array(z.string().uuid())
      .max(MAX_BULK_SELECTION_ENTRIES)
      .default([])
      .describe(
        'Rows to leave out of an otherwise-matching filter, so somebody can say "all of these except those" without listing the rest.',
      ),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.excludedIds).size !== selection.excludedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["excludedIds"],
        message: "Excluded staged transaction IDs must be unique",
      });
    }
  });

export const bulkStageSelectionSnapshotSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    invalidCount: z.number().int().nonnegative(),
    duplicateCount: z.number().int().nonnegative(),
    transferCount: z.number().int().nonnegative(),
    splitCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `null` clears a field; leaving one out leaves it alone. Account and type are
 * refused for a transfer, which has two sides and no single account to move,
 * exactly as they are on committed rows.
 */
const bulkStagePatchSchema = z
  .object({
    date: isoDateSchema
      .optional()
      .describe(
        "Sets the draft date on every selected row. Nothing posts, so no balance moves; this is the date the row carries when it is committed, and one dated ahead of today counts toward nothing until that day.",
      ),
    payee: z
      .string()
      .trim()
      .min(1, "Payee is required")
      .max(160)
      .optional()
      .describe(
        'Renames the payee on every selected row to this one, canonicalised against the spellings you already use, so "tesco" files under "Tesco". Not a search and replace: rows that had different payees all end up with this one.',
      ),
    categoryId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "Files every selected draft under this category, or under none when null. A selection holding a split is refused, and with ledger:write, moving the last row off a category also removes that category when nothing else refers to it.",
      ),
    accountId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Sets the account on every selected draft, on the side its type reads. A selection holding a transfer is refused, and so is a row that does not yet say which way the money went unless you set type in the same patch.",
      ),
    description: z
      .string()
      .trim()
      .max(240)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value))
      .describe(
        "Replaces the description on every selected row; null, or an empty string, clears it. It overwrites rather than appends, so whatever each row said is gone. Leave the key out to keep what is there.",
      ),
    notes: z
      .string()
      .trim()
      .max(4_000)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value))
      .describe(
        "Replaces the working notes on every selected row; null, or an empty string, clears them. Nothing is appended, so a long note on one row is lost to a short one applied across the selection.",
      ),
    type: z
      .enum(["deposit", "withdrawal"])
      .optional()
      .describe(
        "Flips every selected draft between deposit and withdrawal, carrying whatever account it had to the side the new type reads. A selection holding a transfer or a split is refused. Set it with accountId to finish a row that never said which way the money went.",
      ),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Choose at least one field to update",
  });

/**
 * Changing many staged rows at once, on the same terms as committed ones.
 *
 * The selection is the same shape and carries the same guarantees: a list of
 * ids each with the version it was read at, or "everything matching this view"
 * with a count and a fingerprint of the exact set. What differs is what is being
 * changed. A staged row is a draft rather than an entry in the books, so nothing
 * here moves money; it rewrites the draft and revalidates it, and the queue
 * shows what would happen at commit.
 */
export const bulkStageEditSchema = z
  .object({
    selection: bulkStageSelectionSchema.describe(
      "Which rows to act on: either an explicit list with the version you read for each, or a filter plus the count and fingerprint a preview handed back. The filter form is refused if the matching set changed since the preview, so a row somebody added in between is never swept up silently.",
    ),
    patch: bulkStagePatchSchema.describe(
      "The fields to set on every row in the selection. A key left out is left alone; a key set to null clears it. An empty string is refused rather than read as a clear, because the two mean different things and only one of them is ever what somebody meant.",
    ),
    idempotencyKey: idempotencyKeySchema,
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Validate the whole request and report what would happen without writing anything. Ask first when you are unsure; a bulk write is all-or-nothing and there is no per-row report afterwards.",
      ),
  })
  .strict();

const bulkStageEditItemSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    issueCount: z.number().int().nonnegative(),
    possiblyDuplicate: z.boolean(),
  })
  .strict();

export const bulkStageEditResultSchema = z
  .object({
    dryRun: z.boolean(),
    updatedCount: z.number().int().nonnegative(),
    // What the queue will look like afterwards, which is the thing somebody is
    // usually editing in bulk to change.
    validCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    items: z.array(bulkStageEditItemSchema),
  })
  .strict();

export type BulkStagePatch = z.infer<typeof bulkStagePatchSchema>;
export type BulkStageEditResult = z.infer<typeof bulkStageEditResultSchema>;

/**
 * The codes a service raises through `AppError`: the ledger understood what was
 * asked and refused it.
 */
export const serviceErrorCodes = [
  "VALIDATION_ERROR",
  "DUPLICATE",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "STALE_VERSION",
  "UNAUTHORIZED",
  "REAUTHENTICATION_REQUIRED",
  "INTERNAL_ERROR",
] as const;

/**
 * The codes the transport refuses with, before any route runs and before there
 * is an actor to refuse. Kept as their own list rather than folded into the one
 * above, because `AppError` is typed on that one alone: a service able to raise
 * `CROSS_ORIGIN_REQUEST` would be describing something that cannot have
 * happened to it, and a tool result can never carry one either. Published all
 * the same — a caller reads these off `/api/v1` in the same envelope as the
 * rest, and all five sat on the wire in no enumeration at all for a while,
 * because nothing constrained what a refusal was allowed to name.
 */
export const transportErrorCodes = [
  "CROSS_ORIGIN_REQUEST",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "INVALID_CONTENT_LENGTH",
  "REQUEST_BODY_NOT_ALLOWED",
] as const;

/** Every code a caller can be handed, from either half. This is the contract. */
export const apiErrorCodes = [...serviceErrorCodes, ...transportErrorCodes] as const;

export type ServiceErrorCode = (typeof serviceErrorCodes)[number];
export type TransportErrorCode = (typeof transportErrorCodes)[number];
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export type Actor = {
  userId: string;
  source: ActorSource;
  clientId?: string;
};

export type ValidationIssue = {
  field: string;
  message: string;
};

/** A cursor window. Used where callers only ever stream forward. */
export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

/** A cursor window that also knows where it sits in the whole result set. */
export type PaginatedPage<T> = Page<T> & {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  /**
   * Whether this ordering can be resumed with a cursor.
   *
   * `nextCursor` is null for two different reasons — the last page, or an
   * ordering with no keyset to resume from — and a caller could not tell them
   * apart. This says which, on every page.
   */
  cursorAvailable: boolean;
};

export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequencyName = (typeof recurrenceFrequencies)[number];
export const recurrenceMonthPolicies = ["last_day", "skip"] as const;
export const recurrenceWeekendPolicies = [
  "allow",
  "skip",
  "previous_business_day",
  "next_business_day",
] as const;
/**
 * Which relative days of the month a schedule may name. -1 is the last one, and
 * there is deliberately no fifth: a month has four of some weekdays and five of
 * others, so an ordinal of 5 would silently mean different things in different
 * months. Anybody who wants the fifth means the last.
 *
 * The position schema below and the picker in the browser both derive from
 * this, so the list exists once rather than in three places that can drift.
 */
export const recurrenceOrdinals = [1, 2, 3, 4, -1] as const;
export type RecurrenceOrdinal = (typeof recurrenceOrdinals)[number];

/**
 * The most recurrences one person may keep. Unlike a template, each of these is
 * a standing instruction: one anchored years ago proposes rows every tick until
 * it catches up, so an uncapped list is a queue-flooding amplifier reachable by
 * anything holding ledger:write.
 */
export const MAX_RECURRENCES = 200;
export const MAX_RECURRENCE_INTERVAL = 366;

/**
 * One category's share of a recurring split. Unlike a template's leg the amount
 * is required: legs are how the total is divided, and a division with a part
 * missing is not something a person can complete from the queue.
 */
const recurrenceLegSchema = z
  .object({
    categoryId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Which category this leg's share files under. It wins over this leg's categoryName, and the legs answer the direction question together, so an income category on one leg beside an expense category on another is refused.",
      ),
    categoryName: oneLine(z.string().trim().min(1).max(120))
      .optional()
      .describe(
        'A category by name rather than by id for this leg, for example "Groceries", matched and created on the same terms as the entry-level categoryName. Ignored when this leg\'s categoryId is set.',
      ),
    amount: positiveDecimalStringSchema.describe(
      "This leg's share of the total. Every occurrence proposes the same division, so the legs have to add up to the amount rather than being adjusted per row.",
    ),
    note: freeText(z.string().trim().max(240))
      .optional()
      .describe(
        "What this share of the entry was for, when the category alone does not say it. Nothing reads it back: search does not match it and nothing groups by it, so a distinction you want to report on belongs in a category.",
      ),
  })
  .strict();

function checkRecurrenceShape(
  shape: {
    type?: string;
    legs?: readonly unknown[];
    amount?: string;
    categoryId?: string | null;
    categoryName?: string | null;
  },
  context: z.RefinementCtx,
) {
  checkLegs(shape, context);
  if (!shape.legs?.length) return;
  if (shape.amount === undefined) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "A split recurrence needs an amount for its legs to divide",
    });
    return;
  }
  // Checked here and not left to the ledger, because a recurrence is replayed.
  // A template's legs may be blank and a transaction's split is refused once,
  // at the point somebody is looking; a recurrence whose legs do not add up
  // proposes a row nobody can commit on every occurrence it ever reaches, and
  // the only symptom is a queue that fills with rows carrying the same
  // complaint.
  const legs = shape.legs as readonly { amount?: string }[];
  const amounts = legs.map((leg) => leg.amount);
  if (amounts.every((amount): amount is string => typeof amount === "string")) {
    if (!sumsExactly(amounts, shape.amount)) {
      context.addIssue({
        code: "custom",
        path: ["legs"],
        message:
          "A split's legs must add up to the recurrence's amount. Every occurrence it proposes carries the same division, so one that does not balance can never be committed.",
      });
    }
  }
}

/**
 * Whether the parts add up to the whole, exactly.
 *
 * Compared as integers scaled to the longest fraction, because binary floating
 * point cannot hold these values and a split a hundredth of a penny out is
 * still one that will not commit. The schema bounds every value to a leading
 * integer part and at most 18 decimal places, so there is always something to
 * the left of the point and BigInt cannot overflow.
 */
function sumsExactly(parts: readonly string[], whole: string) {
  const places = (value: string) => {
    const point = value.indexOf(".");
    return point < 0 ? 0 : value.length - point - 1;
  };
  const scale = Math.max(places(whole), ...parts.map(places));
  const asInteger = (value: string) => {
    const [integer = "0", fraction = ""] = value.split(".");
    return BigInt(integer + fraction.padEnd(scale, "0"));
  };
  return parts.reduce((total, part) => total + asInteger(part), 0n) === asInteger(whole);
}

const recurrenceShapeFields = {
  ...transactionShapeCommon,
  legs: z
    .array(recurrenceLegSchema)
    .min(2, "A split needs at least two legs")
    .max(MAX_TRANSACTION_LEGS)
    .optional()
    .describe(
      "The split this proposes, replayed on every occurrence. The legs have to add up to the amount, because a division that does not balance proposes a row nobody can commit, over and over. A transfer may not carry any.",
    ),
};

/**
 * What a recurrence remembers about the transaction it proposes.
 *
 * The amount is optional because the electricity bill recurs and its amount does
 * not. A proposal missing one lands in the queue flagged, which is the point:
 * somebody types the number and commits it.
 *
 * There is no date, because the occurrence supplies it. `externalId` is refused
 * rather than ignored, for the reason a template refuses it: copied onto every
 * proposal, the next real import of that bank row would be swallowed as one
 * already seen.
 */
export const recurrenceShapeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z
        .literal("deposit")
        .describe(
          "Which way the money moves on every occurrence: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both. Direction lives here alone, so the amount is always positive, and a transfer carries no legs.",
        ),
      ...recurrenceShapeFields,
      toAccountId: z
        .string()
        .uuid()
        .describe(
          "Where the money landed: a deposit's account, or a transfer's destination. Its currency is the currency the money arrived in, so a transfer whose two accounts differ in currency is refused without destinationAmount.",
        ),
      amount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
  z
    .object({
      type: z
        .literal("withdrawal")
        .describe(
          "Which way the money moves on every occurrence: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both. Direction lives here alone, so the amount is always positive, and a transfer carries no legs.",
        ),
      ...recurrenceShapeFields,
      fromAccountId: z
        .string()
        .uuid()
        .describe(
          "Where the money came from: a withdrawal's account, or a transfer's source, whose currency sourceAmount is in. A transfer's two sides must differ, so moving money within one account is refused.",
        ),
      amount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
  z
    .object({
      type: z
        .literal("transfer")
        .describe(
          "Which way the money moves on every occurrence: a deposit names toAccountId, a withdrawal fromAccountId, a transfer both. Direction lives here alone, so the amount is always positive, and a transfer carries no legs.",
        ),
      ...recurrenceShapeFields,
      fromAccountId: z
        .string()
        .uuid()
        .describe(
          "Where the money came from: a withdrawal's account, or a transfer's source, whose currency sourceAmount is in. A transfer's two sides must differ, so moving money within one account is refused.",
        ),
      toAccountId: z
        .string()
        .uuid()
        .describe(
          "Where the money landed: a deposit's account, or a transfer's destination. Its currency is the currency the money arrived in, so a transfer whose two accounts differ in currency is refused without destinationAmount.",
        ),
      amount: positiveDecimalStringSchema.optional(),
      destinationAmount: positiveDecimalStringSchema.optional(),
    })
    .strict()
    .superRefine(checkRecurrenceShape),
]);

export type RecurrenceShape = z.infer<typeof recurrenceShapeSchema>;

const recurrenceAnchorDateSchema = isoDateSchema.refine(
  (value) => value >= "1900-01-01" && value <= "2999-12-31",
  "Anchor the schedule to a date between 1900 and 2999",
);

/** "The second Tuesday", "the last Friday". */
const recurrencePositionSchema = z
  .object({
    ordinal: z
      .literal(recurrenceOrdinals)
      .describe(
        "Which one in the month the position names: 1 to 4 from the start, or -1 for the last. There is no fifth, because a 5 would mean a different date in months with only four of that weekday, and anybody wanting the fifth means the last.",
      ),
    weekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .describe(
        "Which day of the week the ordinal counts, 0 for Sunday to 6 for Saturday. An off-by-one is not refused, it just moves every occurrence a day, so check the nextOccurrenceDate a read reports before leaving it.",
      ),
  })
  .strict()
  .describe(
    "A relative day of the month, such as the second Tuesday or the last Friday. Ordinal -1 is the last one; weekday 0 is Sunday. Monthly and yearly only.",
  );

function checkSchedule(
  schedule: {
    frequency: string;
    interval: number;
    weekendPolicy: string;
    position?: unknown;
  },
  context: z.RefinementCtx,
) {
  // Two nominal occurrences collide when a policy can move them onto one date,
  // and the moves are up to two days: Saturday goes forward two to Monday and
  // Sunday back two to Friday. So a daily schedule of interval one OR two
  // collides, and nothing else does; an exhaustive sweep of every frequency,
  // interval and anchor weekday finds collisions in exactly those two. The
  // queue refuses to commit a selection holding rows that alike, so either
  // makes a queue nobody can clear in one go.
  const movesToABusinessDay =
    schedule.weekendPolicy === "previous_business_day" ||
    schedule.weekendPolicy === "next_business_day";
  if (schedule.frequency === "daily" && schedule.interval <= 2 && movesToABusinessDay) {
    context.addIssue({
      code: "custom",
      path: ["weekendPolicy"],
      message:
        "A daily schedule of one or two days moved onto a business day puts two occurrences on the same date, and Staged transactions refuses to commit rows that alike. Use allow or skip, or make the interval three days or more.",
    });
  }
  // A weekly rule's relative day is already the weekday of its anchor, and a
  // daily one has no month to count within.
  if (schedule.position && (schedule.frequency === "daily" || schedule.frequency === "weekly")) {
    context.addIssue({
      code: "custom",
      path: ["position"],
      message:
        schedule.frequency === "weekly"
          ? "A weekly schedule already repeats on the weekday of its anchor date, so it needs no relative day"
          : "A daily schedule has no month to count a relative day within",
    });
  }
}

export const recurrenceScheduleSchema = z
  .object({
    frequency: z
      .enum(recurrenceFrequencies)
      .describe(
        "How often it comes round, counted from anchorDate, each occurrence proposing a staged row rather than posting anything. Monthly and yearly count from the anchor and never from the occurrence before, so one anchored on the 31st gives February the 28th and March the 31st.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECURRENCE_INTERVAL)
      .default(1)
      .describe(
        "How many frequency units between occurrences, so 2 on a weekly schedule is every fortnight. A daily interval of one or two is refused with a business-day weekend policy: the move would put two occurrences on one date, which the queue will not commit.",
      ),
    anchorDate: recurrenceAnchorDateSchema,
    monthPolicy: z
      .enum(recurrenceMonthPolicies)
      .default("last_day")
      .describe(
        "What a monthly or yearly schedule does when the anchor's day is missing from the target month: last_day proposes the last it has, skip proposes nothing that month. Daily, weekly and positioned schedules never reach it.",
      ),
    weekendPolicy: z
      .enum(recurrenceWeekendPolicies)
      .default("allow")
      .describe(
        "Where an occurrence landing on a Saturday or Sunday goes: allow leaves it, skip proposes nothing, previous_business_day moves it to the Friday, next_business_day to the Monday. Only the proposed row's date moves, so the schedule never drifts.",
      ),
    position: recurrencePositionSchema
      .nullable()
      .optional()
      .describe(
        "Lands a monthly or yearly schedule on a relative day, the second Tuesday or the last Friday, and the anchor's day number is then not read at all. Daily and weekly schedules refuse it, and monthPolicy never applies to one.",
      ),
  })
  .strict()
  .superRefine(checkSchedule);

export type RecurrenceSchedule = z.infer<typeof recurrenceScheduleSchema>;

/**
 * The stored schedule needs every field, but a caller changing only the
 * frequency must not have to send the policies back or risk overwriting them
 * with a default. What is left out keeps whatever is stored, and the merged
 * result goes back through the full schema, so every refusal still applies.
 */
export const recurrenceSchedulePatchSchema = z
  .object({
    frequency: z
      .enum(recurrenceFrequencies)
      .optional()
      .describe(
        "How often it comes round, counted from anchorDate, each occurrence proposing a staged row rather than posting anything. Monthly and yearly count from the anchor and never from the occurrence before, so one anchored on the 31st gives February the 28th and March the 31st.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECURRENCE_INTERVAL)
      .optional()
      .describe(
        "How many frequency units between occurrences, so 2 on a weekly schedule is every fortnight. A daily interval of one or two is refused with a business-day weekend policy: the move would put two occurrences on one date, which the queue will not commit.",
      ),
    anchorDate: recurrenceAnchorDateSchema.optional(),
    monthPolicy: z
      .enum(recurrenceMonthPolicies)
      .optional()
      .describe(
        "What a monthly or yearly schedule does when the anchor's day is missing from the target month: last_day proposes the last it has, skip proposes nothing that month. Daily, weekly and positioned schedules never reach it.",
      ),
    weekendPolicy: z
      .enum(recurrenceWeekendPolicies)
      .optional()
      .describe(
        "Where an occurrence landing on a Saturday or Sunday goes: allow leaves it, skip proposes nothing, previous_business_day moves it to the Friday, next_business_day to the Monday. Only the proposed row's date moves, so the schedule never drifts.",
      ),
    position: recurrencePositionSchema
      .nullable()
      .optional()
      .describe(
        "Lands a monthly or yearly schedule on a relative day, the second Tuesday or the last Friday, and the anchor's day number is then not read at all. Daily and weekly schedules refuse it, and monthPolicy never applies to one.",
      ),
  })
  .strict();

/**
 * A time of day, as the person's own clock reads it.
 *
 * `HH:MM` and nothing finer. A reminder is a thing somebody reads when they next
 * look at their mail, so seconds would be a precision the delivery cannot keep
 * and the scheduler's tick interval would make a lie of.
 */
export const clockTimeSchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use a time of day as HH:MM, from 00:00 to 23:59")
  .describe(
    'A time of day in the person\'s own timezone, as "HH:MM" on a 24-hour clock, for example "08:30".',
  );

/**
 * When to remind somebody to make a transaction from a template.
 *
 * The schedule is a recurrence's, with a time added, and with one thing a
 * recurrence has no need for: `frequency` may be null, which is a single
 * reminder on the anchor date rather than a repeating one. A template is a thing
 * somebody fills in by hand, and half the reason to be reminded of one is a
 * payment that happens once.
 *
 * The fields a one-off cannot use are refused rather than ignored, the same way
 * a position on a daily schedule is: silently dropping an interval somebody
 * typed is how a reminder ends up arriving on a day nobody chose.
 */
export const templateNotificationSchema = z
  .object({
    frequency: z
      .enum(recurrenceFrequencies)
      .nullable()
      .default(null)
      .describe(
        "How often the reminder repeats, on the same schedules a recurrence offers. Null, the default, is a single reminder on anchorDate; only a frequency makes one repeat, and a one-off refuses an interval, a policy or a position rather than reading it as a repeat.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECURRENCE_INTERVAL)
      .optional()
      .describe(
        "How many frequency units between reminders, so 3 on a monthly frequency is quarterly. A reminder with no frequency accepts only the stored default 1 and refuses any other value, rather than dropping an interval somebody typed.",
      ),
    anchorDate: recurrenceAnchorDateSchema,
    monthPolicy: z
      .enum(recurrenceMonthPolicies)
      .optional()
      .describe(
        "What a monthly or yearly reminder does when the anchor's day is missing from the target month: last_day sends on the last it has, skip sends nothing. A positioned reminder never reaches it, and one with no frequency accepts only the default last_day.",
      ),
    weekendPolicy: z
      .enum(recurrenceWeekendPolicies)
      .optional()
      .describe(
        "Where a reminder due on a Saturday or Sunday goes: allow leaves it, skip sends none, previous_business_day moves it to the Friday, next_business_day to the Monday. Only the send date moves, and a reminder with no frequency accepts only the default allow.",
      ),
    position: recurrencePositionSchema
      .nullable()
      .optional()
      .describe(
        "Lands a monthly or yearly reminder on the second Tuesday or the last Friday, and the anchor's day number is then not read. Daily and weekly frequencies refuse it, and a reminder with no frequency accepts only null.",
      ),
    time: clockTimeSchema,
    /**
     * The three fields a read reports and a write cannot set, accepted and then
     * ignored so a reminder can be sent back the way it came.
     *
     * `.strict()` below refuses anything else, which is what catches a typo. But
     * it also refused a caller its own output: an agent reads a template, changes
     * the time, and sends the object back — the only way it can, having no form
     * to fill in — and was told `repeats` was an unrecognised key. `repeats` is
     * `frequency !== null` restated, and the two dates are watermarks the
     * scheduler owns, so there is nothing here worth refusing.
     */
    repeats: z
      .boolean()
      .optional()
      .describe(
        "Whether this reminder repeats, which is frequency not being null said again. Accepted and ignored, so a stored reminder can be read, changed and sent straight back; setting it true does not make a one-off repeat.",
      ),
    lastNotifiedDate: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The occurrence the last reminder went out for, which the scheduler owns. Accepted and ignored, so setting it neither suppresses a reminder nor replays one; what moves it is changing the rule, which starts the watermark afresh.",
      ),
    nextNotificationDate: z
      .string()
      .nullable()
      .optional()
      .describe(
        "When the next reminder is owed, worked out by the scheduler from the rule. Accepted and ignored, so it cannot bring a reminder forward or hold one back; null means nothing further is owed, which for a single reminder means it has gone.",
      ),
  })
  .strict()
  .describe(
    'An emailed reminder to make this transaction, or null for none. `frequency` null is a single reminder on `anchorDate`; a frequency repeats it on the same schedules a recurrence offers. `time` is "HH:MM" on this person\'s own clock. A reminder that happens once refuses an `interval`, a policy or a `position` that asks for a repeat, rather than ignoring it; sending back the stored defaults it reads is fine, so a read-modify-write of a one-off works. On an update, leaving this out keeps whatever is stored and null removes it; a value replaces the whole rule. Needs a deployment with SMTP configured, which `whoami` reports.',
  )
  .superRefine((notification, context) => {
    if (notification.frequency === null) {
      // What is refused is a value that CONTRADICTS happening once, not the
      // presence of the field. The stored columns are all NOT NULL with
      // defaults, so a reminder read back always carries interval 1, `last_day`
      // and `allow` — and refusing those made the object this very schema
      // returns unsendable. An agent that read a template, changed the time and
      // sent it back got three 422 issues about fields it never touched; the
      // browser was spared only because it rebuilds the object and omits them.
      //
      // A default carries no meaning, so it is accepted and ignored. Anything
      // else is somebody asking for a repeat without saying so.
      const MEANINGLESS: Record<string, unknown> = {
        interval: 1,
        monthPolicy: "last_day",
        weekendPolicy: "allow",
        position: null,
      };
      for (const field of ["interval", "monthPolicy", "weekendPolicy", "position"] as const) {
        const value = notification[field];
        if (value !== undefined && value !== null && value !== MEANINGLESS[field]) {
          context.addIssue({
            code: "custom",
            path: [field],
            message:
              "A reminder that happens once needs only its date and time. Choose a frequency to repeat it.",
          });
        }
      }
      return;
    }
    checkSchedule(
      {
        frequency: notification.frequency,
        interval: notification.interval ?? 1,
        weekendPolicy: notification.weekendPolicy ?? "allow",
        position: notification.position,
      },
      context,
    );
  });

export type TemplateNotification = z.infer<typeof templateNotificationSchema>;

export const transactionTemplateCreateSchema = z.object({
  name: oneLine(z.string().trim().min(1).max(120)).describe(
    "What to call this template, so a person can pick it out later. Not shown on the entries made from it.",
  ),
  draft: transactionTemplateDraftSchema.describe(
    "The entry to prefill, with anything that varies left blank — an amount left out is asked for each time the template is used.",
  ),
  /** A reminder to make this one. Null, or left out, is no reminder. */
  notification: templateNotificationSchema
    .nullable()
    .optional()
    .describe(
      "An optional reminder to use this template, by email. Null clears it. A deployment with no mail server stores the setting and sends nothing.",
    ),
});

/**
 * `notification` left out keeps whatever is stored and null removes it, which is
 * why it cannot be made optional by `.partial()` alone: an update that says
 * nothing about the reminder must not be read as asking to delete it.
 */
export const transactionTemplateUpdateSchema = transactionTemplateCreateSchema
  .partial()
  .extend({ expectedVersion: expectedVersionSchema });

/**
 * Whether to send an email when the scheduler proposes from this recurrence.
 *
 * Not part of the schedule: the schedule decides when a row is proposed, and
 * this decides whether anybody hears about it. Folded in, changing the notice
 * would look like changing the dates.
 */
const recurrenceNotifySchema = z
  .boolean()
  .describe(
    "Email when this recurrence adds a row to Staged transactions. The mail names what was proposed and links to the queue; it never commits anything. Needs a deployment with SMTP configured.",
  );

export const recurrenceCreateSchema = z
  .object({
    name: oneLine(z.string().trim().min(1).max(120)).describe(
      "What to call this recurrence, so a person can pick it out of a list later. Not shown on the entries it proposes.",
    ),
    shape: recurrenceShapeSchema.describe(
      "The entry to propose each time, without a date — the occurrence supplies that. Amounts may be left blank for something whose figure changes.",
    ),
    schedule: recurrenceScheduleSchema.describe(
      "When it comes round: how often, from when, and what to do when an occurrence lands on a weekend or in a month too short to hold it.",
    ),
    notifyOnCreate: recurrenceNotifySchema.default(false),
  })
  .strict();

export const recurrenceUpdateSchema = z
  .object({
    name: oneLine(z.string().trim().min(1).max(120))
      .optional()
      .describe(
        "What to call this recurrence, so a person can pick it out of a list later. Not shown on the entries it proposes.",
      ),
    shape: recurrenceShapeSchema
      .optional()
      .describe(
        "What each occurrence proposes. Sent whole rather than field by field: leave a field out of the shape and the proposal leaves it out too, which is how an amount that varies is asked for each time.",
      ),
    schedule: recurrenceSchedulePatchSchema
      .optional()
      .describe(
        "When it comes round. Sent whole, like the shape: a schedule missing a field is a schedule that no longer has it, rather than one that kept it.",
      ),
    notifyOnCreate: recurrenceNotifySchema.optional(),
    expectedVersion: expectedVersionSchema,
  })
  .strict();
