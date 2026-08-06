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

export type TransactionFormDraft = {
  type: TransactionType;
  date: string;
  description: string;
  payee: string;
  categoryId: string;
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
  const categoryId = keep(draft.categoryId);
  if (categoryId) template.categoryId = categoryId;
  const description = keep(draft.description);
  if (description) template.description = description;
  const notes = keep(draft.notes);
  if (notes) template.notes = notes;
  return template;
}
