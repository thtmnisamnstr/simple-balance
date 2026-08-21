import {
  isoDateSchema,
  transactionTypes,
  type StagedDraft,
  type TransactionTemplateDraft,
  type TransactionType,
} from "../shared/domain.js";

type StageAccount = {
  id: string;
  name: string;
  currency: string;
};

/**
 * A leg while it is being typed. Every value is a string, including the amount,
 * because a half-typed "12." is a real state of the form and turning it into a
 * number would round it or throw it away.
 *
 * `id` is empty for a leg the person has just added, which is exactly what the
 * wire means by a leg without one.
 */
export type TransactionFormLeg = {
  id: string;
  categoryId: string;
  categoryName: string;
  amount: string;
  note: string;
};

export type TransactionFormDraft = {
  type: TransactionType;
  date: string;
  description: string;
  payee: string;
  categoryId: string;
  // A staged draft may name its category by name and no id: an agent staged it
  // that way, or a CSV import deferred the category to commit. Read here so
  // opening the row in the form does not write null over the only answer it has.
  categoryName: string;
  legs: TransactionFormLeg[];
  notes: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  destinationAmount: string;
  // Not shown or edited, only carried. This is the reference a row arrived with
  // from a bank file, and it is what keeps a second import of the same
  // statement from bringing the row back in as a new transaction.
  externalId: string;
  // Carried the same way, so editing a staged row keeps the record of which
  // template it came from.
  templateId: string;
};

/**
 * What a row offers a new recurrence, before the person edits it.
 *
 * Loose where `RecurrenceShape` is strict: a row can be missing an account or a
 * payee the shape requires, and the form is where that is filled in. Sending it
 * as it stands is what the contract refuses.
 */
export type RecurrenceShapeSeed = {
  type: TransactionType;
  payee?: string;
  fromAccountId?: string;
  toAccountId?: string;
  amount?: string;
  categoryId?: string;
  categoryName?: string;
  legs?: {
    categoryId?: string;
    categoryName?: string;
    amount?: string;
    note?: string;
  }[];
  description?: string;
  notes?: string;
};

export function stagedString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stagedType(value: unknown): TransactionType | null {
  if (typeof value !== "string") return null;
  return transactionTypes.find((type) => type === value) ?? null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The legs a stored draft carries, as form values.
 *
 * A draft that is not a split has none, and a leg the draft cannot be read as
 * is left out rather than guessed at: a queue row with an unreadable split is
 * repaired by typing it again, not by inventing amounts for it.
 */
export function stagedLegs(value: unknown): TransactionFormLeg[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isUnknownRecord).map((leg) => ({
    id: stagedString(leg.id),
    categoryId: stagedString(leg.categoryId),
    categoryName: stagedString(leg.categoryName),
    amount: stagedString(leg.amount),
    note: stagedString(leg.note),
  }));
}

export function draftForTransactionForm(input: unknown): TransactionFormDraft {
  const draft = isUnknownRecord(input) ? input : {};
  const type = stagedType(draft.type) ?? "withdrawal";
  const rawDate = stagedString(draft.date);

  return {
    type,
    date: isoDateSchema.safeParse(rawDate).success ? rawDate : "",
    description: stagedString(draft.description),
    payee: stagedString(draft.payee),
    categoryId: stagedString(draft.categoryId),
    categoryName: stagedString(draft.categoryName),
    legs: stagedLegs(draft.legs),
    notes: stagedString(draft.notes),
    fromAccountId: stagedString(draft.fromAccountId),
    toAccountId: stagedString(draft.toAccountId),
    amount:
      type === "transfer"
        ? stagedString(draft.sourceAmount)
        : stagedString(draft.amount),
    destinationAmount:
      type === "transfer" ? stagedString(draft.destinationAmount) : "",
    externalId: stagedString(draft.externalId),
    templateId: stagedString(draft.templateId),
  };
}

export function summarizeStagedDraft(
  draft: StagedDraft,
  accounts: StageAccount[],
) {
  const type = stagedType(draft.type);
  if (type === "deposit") {
    const account = accounts.find(
      (item) => item.id === stagedString(draft.toAccountId),
    );
    return {
      account: account?.name ?? "Unknown account",
      amount: stagedString(draft.amount),
      currency: account?.currency ?? "",
    };
  }
  if (type === "withdrawal") {
    const account = accounts.find(
      (item) => item.id === stagedString(draft.fromAccountId),
    );
    return {
      account: account?.name ?? "Unknown account",
      amount: stagedString(draft.amount),
      currency: account?.currency ?? "",
    };
  }
  if (type === "transfer") {
    const source = accounts.find(
      (item) => item.id === stagedString(draft.fromAccountId),
    );
    const destination = accounts.find(
      (item) => item.id === stagedString(draft.toAccountId),
    );
    return {
      account: `${source?.name ?? "Unknown"} → ${destination?.name ?? "Unknown"}`,
      amount: stagedString(draft.sourceAmount),
      currency: source?.currency ?? "",
    };
  }
  return { account: "Unknown account", amount: "", currency: "" };
}


/**
 * What a row offers a new template, before the person edits it.
 *
 * Three things a transaction carries are deliberately dropped rather than
 * offered: its date, because a template always means today; its category name,
 * because only an id is stored; and its `externalId`, because that is the
 * reference a bank statement row was imported under, and copying it into a
 * template would copy it into every transaction made from the template, so the
 * next real import of that row would be swallowed as one already seen.
 */
export function templateDraftFromDraft(
  draft: Partial<TransactionFormDraft>,
): Partial<TransactionTemplateDraft> {
  const keep = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const type =
    draft.type === "deposit" || draft.type === "withdrawal" || draft.type === "transfer"
      ? draft.type
      : "withdrawal";
  const template: Partial<TransactionTemplateDraft> = { type };
  const payee = keep(draft.payee);
  if (payee) template.payee = payee;
  if (type !== "deposit") {
    const from = keep(draft.fromAccountId);
    if (from) template.fromAccountId = from;
  }
  if (type !== "withdrawal") {
    const to = keep(draft.toAccountId);
    if (to) template.toAccountId = to;
  }
  const amount = keep(draft.amount);
  if (amount) template.amount = amount;
  // Legs are carried explicitly. `keep` only recognises strings, so a split
  // saved as a template would quietly become a template with no category at
  // all, on a surface nobody would think to check.
  const legs = (draft.legs ?? []).filter(
    (leg) => keep(leg.categoryId) ?? keep(leg.categoryName) ?? keep(leg.amount),
  );
  // A transfer moves money between two accounts and files nothing under a
  // category, so its legs are never carried — the same guard the shape converter
  // below applies, and the same one both forms apply.
  if (type !== "transfer" && legs.length >= 2) {
    template.legs = legs.map((leg) => ({
      ...(keep(leg.categoryId) ? { categoryId: keep(leg.categoryId) } : {}),
      ...(!keep(leg.categoryId) && keep(leg.categoryName)
        ? { categoryName: keep(leg.categoryName) }
        : {}),
      ...(keep(leg.amount) ? { amount: keep(leg.amount) } : {}),
      ...(keep(leg.note) ? { note: keep(leg.note) } : {}),
    }));
  } else {
    const categoryId = keep(draft.categoryId);
    if (categoryId) template.categoryId = categoryId;
  }
  const description = keep(draft.description);
  if (description) template.description = description;
  const notes = keep(draft.notes);
  if (notes) template.notes = notes;
  return template;
}

/**
 * What a row offers a new recurrence, before the person edits it.
 *
 * The same three things a template drops are dropped here, and the contract
 * refuses two of them outright rather than ignoring them: the date, because the
 * occurrence supplies it; the bank's own reference, because copying it onto
 * every proposal would make the next real import of that statement row look
 * like one already seen; and a leg's id, which belongs to the transaction the
 * leg is part of.
 *
 * A category named rather than cited is kept, which is where this parts company
 * with the template converter: a recurrence shape can hold a name and match it
 * on each occurrence, so dropping it would lose the only answer a staged row
 * filed by name has.
 *
 * The received amount of a cross-currency transfer is dropped as well, since a
 * rate fixed once is wrong by the second occurrence. Each proposal waits in the
 * queue for that number instead.
 */
export function recurrenceShapeFromDraft(
  draft: Partial<TransactionFormDraft>,
): RecurrenceShapeSeed {
  const keep = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const type =
    draft.type === "deposit" || draft.type === "withdrawal" || draft.type === "transfer"
      ? draft.type
      : "withdrawal";
  const shape: RecurrenceShapeSeed = { type };
  const payee = keep(draft.payee);
  if (payee) shape.payee = payee;
  if (type !== "deposit") {
    const from = keep(draft.fromAccountId);
    if (from) shape.fromAccountId = from;
  }
  if (type !== "withdrawal") {
    const to = keep(draft.toAccountId);
    if (to) shape.toAccountId = to;
  }
  const amount = keep(draft.amount);
  if (amount) shape.amount = amount;
  const legs = (draft.legs ?? []).filter(
    (leg) => keep(leg.categoryId) ?? keep(leg.categoryName) ?? keep(leg.amount),
  );
  if (type !== "transfer" && legs.length >= 2) {
    shape.legs = legs.map((leg) => ({
      ...(keep(leg.categoryId) ? { categoryId: keep(leg.categoryId) } : {}),
      ...(!keep(leg.categoryId) && keep(leg.categoryName)
        ? { categoryName: keep(leg.categoryName) }
        : {}),
      ...(keep(leg.amount) ? { amount: keep(leg.amount) } : {}),
      ...(keep(leg.note) ? { note: keep(leg.note) } : {}),
    }));
  } else {
    const categoryId = keep(draft.categoryId);
    if (categoryId) shape.categoryId = categoryId;
    else {
      const categoryName = keep(draft.categoryName);
      if (categoryName) shape.categoryName = categoryName;
    }
  }
  const description = keep(draft.description);
  if (description) shape.description = description;
  const notes = keep(draft.notes);
  if (notes) shape.notes = notes;
  return shape;
}
