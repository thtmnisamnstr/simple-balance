import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  accountTypeLabels,
  userAccountTypes,
  liabilityAccountTypes,
  MAX_TRANSACTION_LEGS,
  recurrenceOrdinals,
  type RecurrenceFrequencyName,
  type RecurrenceOrdinal,
  type UserAccountType,
  type TransactionDraft,
  type TransactionTemplateDraft,
  type TransactionType,
} from "../shared/domain.js";
import {
  addDays,
  laterOf,
  nextOccurrenceAfter,
  weekdayOf,
  type RecurrencePosition,
} from "../shared/recurrence-dates.js";
import {
  api,
  ApiClientError,
  json,
  type Account,
  type Category,
  type Recurrence,
  type StagedTransaction,
  type Transaction,
  type TransactionTemplate,
} from "./api.js";
import {
  Alert,
  Button,
  Field,
  formatDate,
  Input,
  isNegativeMoney,
  isPositiveMoney,
  moneyRemainder,
  Select,
  Textarea,
} from "./components.js";
import {
  draftForTransactionForm,
  type TransactionFormLeg,
} from "./staged-draft.js";
import { currencyOptionLabel, currencyOptions } from "./select-options.js";
import { calendarDateInTimezone, useTimezone } from "./timezone.js";
import { newIdempotencyKey } from "./idempotency.js";

export function AccountForm({
  account,
  defaultCurrency,
  onDone,
}: {
  account?: Account;
  defaultCurrency: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const timezone = useTimezone();
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<UserAccountType>(account?.type ?? "checking");
  const [currency, setCurrency] = useState(account?.currency ?? defaultCurrency);
  const [openingDate, setOpeningDate] = useState(
    account?.openingDate ?? calendarDateInTimezone(new Date(), timezone),
  );
  const [openingBalance, setOpeningBalance] = useState(() => {
    if (!account) return "0";
    return liabilityAccountTypes.has(account.type)
      ? account.openingBalance.replace(/^-/, "")
      : account.openingBalance;
  });
  const [liabilityBalanceKind, setLiabilityBalanceKind] = useState<
    "owed" | "credit"
  >(
    account &&
      liabilityAccountTypes.has(account.type) &&
      isPositiveMoney(account.openingBalance)
      ? "credit"
      : "owed",
  );
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [notes, setNotes] = useState(account?.notes ?? "");

  const changeAccountType = (nextType: UserAccountType) => {
    const wasLiability = liabilityAccountTypes.has(type);
    const willBeLiability = liabilityAccountTypes.has(nextType);

    if (wasLiability && !willBeLiability) {
      const magnitude = openingBalance.replace(/^-/, "");
      setOpeningBalance(
        liabilityBalanceKind === "owed" && isPositiveMoney(magnitude)
          ? `-${magnitude}`
          : magnitude,
      );
    } else if (!wasLiability && willBeLiability) {
      if (isNegativeMoney(openingBalance)) {
        setLiabilityBalanceKind("owed");
      } else if (isPositiveMoney(openingBalance)) {
        setLiabilityBalanceKind("credit");
      }
      setOpeningBalance(openingBalance.replace(/^-/, ""));
    }

    setType(nextType);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const liability = liabilityAccountTypes.has(type);
      const openingMagnitude = openingBalance.replace(/^-/, "");
      const signedOpening =
        liability && liabilityBalanceKind === "owed"
          ? isPositiveMoney(openingMagnitude)
            ? `-${openingMagnitude}`
            : openingMagnitude
          : liability
            ? openingMagnitude
            : openingBalance;
      const payload = {
        name,
        type,
        currency: currency.toUpperCase(),
        openingDate,
        openingBalance: signedOpening,
        institution: institution || null,
        notes: notes || null,
        ...(account ? { expectedVersion: account.version } : {}),
      };
      return account
        ? api<Account>(`/api/v1/accounts/${account.id}`, {
            ...json(payload),
            method: "PUT",
          })
        : api<Account>("/api/v1/accounts", json(payload));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["summary"] });
      onDone();
    },
  });

  return (
    <form
      id="account-form"
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}
      <Field label="Account name">
        <Input
          autoFocus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Everyday checking"
        />
      </Field>
      <div className="two-columns">
        <Field label="Account type">
          <Select
            value={type}
            onChange={(event) =>
              changeAccountType(event.target.value as UserAccountType)
            }
          >
            {userAccountTypes.map((value) => (
              <option key={value} value={value}>
                {accountTypeLabels[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency or crypto asset" hint="Fixed once this account is in use">
          <Select
            required
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencyOptions(currency).map((option) => (
              <option key={option} value={option}>
                {currencyOptionLabel(option)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div
        className={
          liabilityAccountTypes.has(type) ? "three-columns" : "two-columns"
        }
      >
        <Field label="Opening date">
          <Input
            type="date"
            required
            value={openingDate}
            onChange={(event) => setOpeningDate(event.target.value)}
          />
        </Field>
        {liabilityAccountTypes.has(type) ? (
          <Field label="Starting balance type">
            <Select
              value={liabilityBalanceKind}
              onChange={(event) =>
                setLiabilityBalanceKind(event.target.value as "owed" | "credit")
              }
            >
              <option value="owed">Amount owed</option>
              <option value="credit">Credit balance</option>
            </Select>
          </Field>
        ) : null}
        <Field
          label={
            liabilityAccountTypes.has(type)
              ? "Starting amount"
              : "Opening balance"
          }
        >
          <Input
            inputMode="decimal"
            required
            value={openingBalance}
            onChange={(event) => setOpeningBalance(event.target.value)}
            pattern={
              liabilityAccountTypes.has(type)
                ? "(0|[1-9][0-9]{0,25})(\\.[0-9]{1,18})?"
                : "-?(0|[1-9][0-9]{0,25})(\\.[0-9]{1,18})?"
            }
          />
        </Field>
      </div>
      <Field label="Institution" hint="Optional">
        <Input
          value={institution}
          onChange={(event) => setInstitution(event.target.value)}
          placeholder="Your bank or card issuer"
        />
      </Field>
      <Field label="Notes" hint="Optional">
        <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} />
      </Field>
      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {account ? "Save account" : "Create account"}
        </Button>
      </div>
    </form>
  );
}


/**
 * The payee field, with the suggestions and the snap-to-existing-spelling
 * behaviour that keeps a ledger from growing three spellings of one shop. Its
 * own component because the template editor needs exactly this and a second
 * copy would be a second answer to "what counts as the same payee".
 */
function PayeeInput({
  value,
  onChange,
  required = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const payees = useQuery({
    queryKey: ["payees", "suggestions", value.trim().toLowerCase()],
    queryFn: () =>
      api<string[]>(
        `/api/v1/payees/suggestions?search=${encodeURIComponent(value.trim())}`,
      ),
    placeholderData: (previous) => previous,
  });
  const matching = (candidate: string) =>
    payees.data?.find(
      (suggestion) =>
        normalizeAutocompleteValue(suggestion) ===
        normalizeAutocompleteValue(candidate),
    );
  return (
    <>
      <Input
        autoFocus={autoFocus}
        required={required}
        list={listId}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        value={value}
        onChange={(event) => onChange(matching(event.target.value) ?? event.target.value)}
        onBlur={() =>
          onChange(matching(value) ?? value.trim().replace(/\s+/gu, " "))
        }
        placeholder="Merchant, employer, person…"
      />
      <datalist id={listId}>
        {payees.data?.map((suggestion) => (
          <option key={suggestion} value={suggestion} />
        ))}
      </datalist>
    </>
  );
}

export function draftFromTransaction(transaction: Transaction): TransactionDraft {
  const common = {
    date: transaction.date,
    description: transaction.description ?? null,
    payee: transaction.payee,
    categoryId: transaction.categoryId,
    // Each leg carries the id it has to be sent back under, or editing one
    // would replace it with a new leg and retire the one it stood for.
    ...(transaction.legs.length
      ? {
          legs: transaction.legs.map((leg) => ({
            id: leg.id,
            categoryId: leg.categoryId,
            amount: leg.amount,
            note: leg.note,
          })),
        }
      : {}),
    notes: transaction.notes,
    externalId: transaction.externalId,
  };
  if (transaction.type === "deposit") {
    return {
      type: "deposit",
      toAccountId: transaction.destinationAccountId!,
      amount: transaction.destinationAmount!,
      ...common,
    };
  }
  if (transaction.type === "withdrawal") {
    return {
      type: "withdrawal",
      fromAccountId: transaction.sourceAccountId!,
      amount: transaction.sourceAmount!,
      ...common,
    };
  }
  return {
    type: "transfer",
    fromAccountId: transaction.sourceAccountId!,
    toAccountId: transaction.destinationAccountId!,
    sourceAmount: transaction.sourceAmount!,
    destinationAmount: transaction.destinationAmount!,
    ...common,
  };
}

const transactionTypeOptions: {
  type: TransactionType;
  label: string;
  icon: typeof ArrowDownLeft;
  description: string;
}[] = [
  {
    type: "withdrawal",
    label: "Withdrawal",
    icon: ArrowUpRight,
    description: "Money spent or removed",
  },
  {
    type: "deposit",
    label: "Deposit",
    icon: ArrowDownLeft,
    description: "Money received or added",
  },
  {
    type: "transfer",
    label: "Transfer",
    icon: ArrowLeftRight,
    description: "Move money between accounts",
  },
];

function normalizeCategoryName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizeAutocompleteValue(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Naming a category rather than creating one first.
 *
 * There is no button here. What the person typed travels with the transaction
 * and the server settles it on save: an existing name matches whatever its
 * capitalization, and only a genuinely new one becomes a new category. That is
 * also why the field is controlled from above rather than holding its own copy
 * of the text, which used to be discarded every time the category list
 * refetched.
 */
function CategoryPicker({
  categories,
  type,
  categoryId,
  categoryName,
  onChange,
}: {
  categories: Category[];
  type: TransactionType | "";
  categoryId: string;
  categoryName: string;
  onChange: (categoryId: string, categoryName: string) => void;
}) {
  const listId = useId();
  const compatible = useMemo(
    () =>
      categories.filter((category) => {
        if (category.archivedAt && category.id !== categoryId) return false;
        return (
          !type ||
          category.kind === "both" ||
          (type === "deposit" && category.kind === "income") ||
          (type === "withdrawal" && category.kind === "expense")
        );
      }),
    [categories, categoryId, type],
  );

  const normalized = normalizeCategoryName(categoryName);
  // What the server will actually store: trimmed, with runs of space collapsed.
  // The hint below is a preview of the result, so it has to show that rather
  // than the raw keystrokes.
  const cleaned = categoryName.trim().replace(/\s+/g, " ");
  // Deliberately every category, not just the compatible ones. A name that
  // belongs to a category filed under the other side still names something
  // that exists, and the server widens that category rather than refusing the
  // entry or starting a second spelling of it.
  const existing = categories.find(
    (category) => normalizeCategoryName(category.name) === normalized,
  );

  return (
    <div className="category-picker">
      <Input
        list={listId}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        value={categoryName}
        onChange={(event) => {
          const next = event.target.value;
          const match = categories.find(
            (category) =>
              normalizeCategoryName(category.name) ===
              normalizeCategoryName(next),
          );
          // Matching by name keeps the spelling already in the ledger, so the
          // field shows what the entry will actually be filed under.
          onChange(match?.id ?? "", match?.name ?? next);
        }}
        placeholder="Type to search or add"
      />
      <datalist id={listId}>
        {compatible.map((category) => (
          <option key={category.id} value={category.name} />
        ))}
      </datalist>
      {normalized && !existing ? (
        <small>Saving will add “{cleaned}” as a new category.</small>
      ) : null}
      {normalized && existing && !categoryId ? (
        <small>Will use your existing “{existing.name}”.</small>
      ) : null}
    </div>
  );
}


/**
 * The category side of the form: one picker, or one row per share of a split.
 *
 * A split is only ever two legs or more. Removing the second one folds the
 * remaining category back into the single picker, so "one leg is not a split"
 * is as true of what is on screen as it is of what is stored.
 *
 * The remainder is worked out in scaled integers rather than through Number,
 * because it decides whether the form may be submitted: with floats a receipt
 * of 33.33 + 33.33 + 33.34 against 100 could come out a hair short and refuse
 * a split that adds up perfectly well.
 */
function CategoryLegs({
  categories,
  type,
  categoryId,
  categoryName,
  onCategoryChange,
  legs,
  onLegsChange,
  total,
  requireBalance = true,
}: {
  categories: Category[];
  type: TransactionType | "";
  categoryId: string;
  categoryName: string;
  onCategoryChange: (categoryId: string, categoryName: string) => void;
  legs: TransactionFormLeg[];
  onLegsChange: (legs: TransactionFormLeg[]) => void;
  total: string;
  // A template's amounts are optional by design, so its split is not asked to
  // add up to anything until it is used.
  requireBalance?: boolean;
}) {
  const blank = (): TransactionFormLeg => ({
    id: "",
    categoryId: "",
    categoryName: "",
    amount: "",
    note: "",
  });
  const replace = (index: number, changes: Partial<TransactionFormLeg>) =>
    onLegsChange(
      legs.map((leg, at) => (at === index ? { ...leg, ...changes } : leg)),
    );

  if (!legs.length) {
    return (
      <div className="category-legs">
        <CategoryPicker
          categories={categories}
          type={type}
          categoryId={categoryId}
          categoryName={categoryName}
          onChange={onCategoryChange}
        />
        <button
          type="button"
          className="link-button"
          onClick={() => {
            // The category already chosen becomes the first leg, carrying the
            // whole amount, so splitting starts from what is on screen rather
            // than from nothing.
            onCategoryChange("", "");
            onLegsChange([
              { id: "", categoryId, categoryName, amount: total, note: "" },
              blank(),
            ]);
          }}
        >
          Split across categories
        </button>
      </div>
    );
  }

  const remainder = moneyRemainder(
    total,
    legs.map((leg) => leg.amount || "0"),
  );
  const settled = remainder === "0";

  return (
    <div className="category-legs">
      {legs.map((leg, index) => (
        <div className="category-leg" key={leg.id || `new-${index}`}>
          <CategoryPicker
            categories={categories}
            type={type}
            categoryId={leg.categoryId}
            categoryName={leg.categoryName}
            onChange={(nextId, nextName) =>
              replace(index, { categoryId: nextId, categoryName: nextName })
            }
          />
          <Input
            inputMode="decimal"
            value={leg.amount}
            onChange={(event) => replace(index, { amount: event.target.value })}
            placeholder="0.00"
            pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
            aria-label={`Amount for split ${index + 1}`}
          />
          <Input
            value={leg.note}
            onChange={(event) => replace(index, { note: event.target.value })}
            placeholder="Note"
            aria-label={`Note for split ${index + 1}`}
          />
          <button
            type="button"
            className="link-button"
            aria-label={`Remove split ${index + 1}`}
            onClick={() => {
              const rest = legs.filter((_, at) => at !== index);
              if (rest.length >= 2) {
                onLegsChange(rest);
                return;
              }
              // Down to one share, which is not a split. The category that
              // survives goes back into the single picker rather than being
              // dropped along with the row.
              const [only] = rest;
              onCategoryChange(only?.categoryId ?? "", only?.categoryName ?? "");
              onLegsChange([]);
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="category-legs-footer">
        <button
          type="button"
          className="link-button"
          onClick={() => onLegsChange([...legs, blank()])}
          disabled={legs.length >= MAX_TRANSACTION_LEGS}
        >
          Add a category
        </button>
        <small
          className={
            settled || !requireBalance
              ? "category-legs-remainder settled"
              : "category-legs-remainder"
          }
        >
          {!requireBalance
            ? "Amounts are optional. Leave one blank to fill it in each time."
            : remainder === null
              ? "Enter an amount for the transaction and for each category."
              : settled
                ? "The split adds up."
                : `${remainder} left to assign.`}
        </small>
      </div>
    </div>
  );
}

/**
 * Editing what a template remembers.
 *
 * Its own form rather than the transaction form with pieces switched off,
 * because what it collects genuinely differs: every field may be left blank, no
 * date is recorded at all, and nothing here can be committed or staged. The two
 * pieces that carry real behaviour - the payee suggestions and the category
 * matching - are shared components, so the rules that matter cannot drift
 * between them.
 *
 * The rule the whole form turns on: a field left blank is not saved. It is
 * filled in when the template is used.
 */
export function TemplateForm({
  accounts,
  categories,
  template,
  initialDraft,
  onDone,
}: {
  accounts: Account[];
  categories: Category[];
  template?: TransactionTemplate;
  initialDraft?: Partial<TransactionTemplateDraft>;
  onDone: () => void;
}) {
  const source = template?.draft ?? initialDraft ?? {};
  const [name, setName] = useState(template?.name ?? "");
  const [type, setType] = useState<TransactionType | "">(source.type ?? "");
  const [date, setDate] = useState(source.date ?? "");
  const [payee, setPayee] = useState(source.payee ?? "");
  const [fromAccountId, setFromAccountId] = useState(source.fromAccountId ?? "");
  const [toAccountId, setToAccountId] = useState(source.toAccountId ?? "");
  const [amount, setAmount] = useState(source.amount ?? "");
  const [categoryId, setCategoryId] = useState(source.categoryId ?? "");
  const [categoryName, setCategoryName] = useState(
    categories.find((category) => category.id === source.categoryId)?.name ?? "",
  );
  const [legs, setLegs] = useState<TransactionFormLeg[]>(() =>
    (source.legs ?? []).map((leg) => ({
      id: "",
      categoryId: leg.categoryId ?? "",
      categoryName:
        categories.find((category) => category.id === leg.categoryId)?.name ??
        leg.categoryName ??
        "",
      amount: leg.amount ?? "",
      note: leg.note ?? "",
    })),
  );
  const [description, setDescription] = useState(source.description ?? "");
  const [notes, setNotes] = useState(source.notes ?? "");
  const queryClient = useQueryClient();

  // The same rule the transaction form applies: a category that cannot cover
  // this kind of entry is dropped rather than carried into every use of the
  // template.
  useEffect(() => {
    const selected = categories.find((category) => category.id === categoryId);
    if (
      selected &&
      selected.kind !== "both" &&
      ((type === "deposit" && selected.kind !== "income") ||
        (type === "withdrawal" && selected.kind !== "expense") ||
        type === "transfer")
    ) {
      setCategoryId("");
      setCategoryName("");
    }
  }, [categories, categoryId, type]);

  const mutation = useMutation({
    mutationFn: () => {
      // Built by leaving out what is blank rather than sending empty strings,
      // so "not saved" and "saved as nothing" cannot be confused later.
      const draft: Record<string, unknown> = {};
      const keep = (key: string, value: string) => {
        if (value.trim()) draft[key] = value.trim();
      };
      const trimmed = (value: string) => (value.trim() ? value.trim() : undefined);
      keep("type", type);
      keep("date", date);
      keep("payee", payee);
      if (type !== "deposit") keep("fromAccountId", fromAccountId);
      if (type !== "withdrawal") keep("toAccountId", toAccountId);
      keep("amount", amount);
      // Legs and a single category cannot both be stored, so whichever side the
      // form is showing is the one that is saved. A template leg may name only
      // a category: its amount is filled in when the template is used.
      const kept = legs.filter(
        (leg) => leg.categoryId || leg.categoryName.trim() || leg.amount.trim(),
      );
      if (kept.length >= 2) {
        draft.legs = kept.map((leg) => ({
          ...(leg.categoryId
            ? { categoryId: leg.categoryId }
            : trimmed(leg.categoryName)
              ? { categoryName: trimmed(leg.categoryName) }
              : {}),
          ...(trimmed(leg.amount) ? { amount: trimmed(leg.amount) } : {}),
          ...(trimmed(leg.note) ? { note: trimmed(leg.note) } : {}),
        }));
      } else if (categoryId) draft.categoryId = categoryId;
      else keep("categoryName", categoryName);
      keep("description", description);
      keep("notes", notes);
      const body = { name: name.trim(), draft };
      return template
        ? api<TransactionTemplate>(`/api/v1/transaction-templates/${template.id}`, {
            ...json({ ...body, expectedVersion: template.version }),
            method: "PUT",
          })
        : api<TransactionTemplate>("/api/v1/transaction-templates", json(body));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["transaction-templates"] });
      onDone();
    },
  });

  const accountOptions = accounts.filter((account) => !account.archivedAt);
  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) mutation.mutate();
      }}
    >
      <Field
        label="Template name"
        hint="What you will pick it out by later."
      >
        <Input
          autoFocus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Weekly shop"
        />
      </Field>

      <div className="transaction-type-grid" role="radiogroup" aria-label="Transaction type">
        {transactionTypeOptions.map((option) => {
          const Icon = option.icon;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={type === option.type}
              key={option.type}
              className={`transaction-type ${type === option.type ? "selected" : ""}`}
              // Clicking the chosen one again unsaves it, which is how a
              // template holds no type at all.
              onClick={() => setType(type === option.type ? "" : option.type)}
            >
              <Icon size={19} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          );
        })}
      </div>
      {type ? (
        <p className="settings-note">
          Chosen again to leave the type out, so it is picked each time.
        </p>
      ) : (
        <p className="settings-note">
          No type saved, so it is picked each time you use this template.
        </p>
      )}

      <div className="two-columns">
        <Field label="Payee" hint="Leave blank to fill in each time.">
          <PayeeInput value={payee} onChange={setPayee} />
        </Field>
        <Field label="Date" hint="Leave blank to use the day you apply it.">
          <Input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>
      </div>

      {type !== "deposit" ? (
        <Field label={type === "transfer" ? "From account" : "Account"}>
          <Select
            value={fromAccountId}
            onChange={(event) => setFromAccountId(event.target.value)}
          >
            <option value="">Leave blank</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {type !== "withdrawal" ? (
        <Field label={type === "transfer" ? "To account" : "Account"}>
          <Select
            value={toAccountId}
            onChange={(event) => setToAccountId(event.target.value)}
          >
            <option value="">Leave blank</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field
        label="Amount"
        hint="Leave blank when it differs every time."
      >
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
        />
      </Field>

      {type === "transfer" ? null : (
        <Field label="Category" hint="Optional">
          <CategoryLegs
            categories={categories}
            type={type}
            categoryId={categoryId}
            categoryName={categoryName}
            onCategoryChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
            legs={legs}
            onLegsChange={setLegs}
            total={amount}
            requireBalance={false}
          />
        </Field>
      )}
      <div className="two-columns">
        <Field label="Description" hint="Optional">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Additional details"
          />
        </Field>
      </div>
      <Field label="Notes" hint="Optional">
        <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>

      {categoryName.trim() && !categoryId ? (
        <Alert kind="info">
          “{categoryName.trim()}” is saved as a name rather than a category you
          already have, and is matched when you use the template. If nothing
          matches then, it is created.
        </Alert>
      ) : null}
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!name.trim()}>
          {template ? "Save template" : "Save as template"}
        </Button>
      </div>
    </form>
  );
}

export function TransactionForm({
  accounts,
  categories,
  transaction,
  staged,
  initialAccountId,
  initialCategoryId,
  initialPayee,
  initialType,
  initialMode = "commit",
  onDone,
}: {
  accounts: Account[];
  categories: Category[];
  transaction?: Transaction;
  staged?: StagedTransaction;
  initialAccountId?: string;
  initialCategoryId?: string;
  initialPayee?: string;
  initialType?: TransactionType;
  initialMode?: "commit" | "stage";
  onDone: () => void;
}) {
  const timezone = useTimezone();
  const initial = useMemo(
    () =>
      transaction
        ? draftForTransactionForm(draftFromTransaction(transaction))
        : staged
          ? draftForTransactionForm(staged.draft)
          : null,
    [transaction, staged],
  );
  const createType = initialType ?? "withdrawal";
  const defaultAccountIds = (nextType: TransactionType) => {
    const primaryAccountId = initialAccountId ?? accounts[0]?.id ?? "";
    return {
      fromAccountId: primaryAccountId,
      toAccountId:
        nextType === "transfer"
          ? accounts.find((account) => account.id !== primaryAccountId)?.id ?? ""
          : primaryAccountId,
    };
  };
  const initialFormType = initial?.type ?? createType;
  const initialAccountIds = defaultAccountIds(initialFormType);
  const [type, setType] = useState<TransactionType>(
    initialFormType,
  );
  const [date, setDate] = useState(
    initial?.date ?? calendarDateInTimezone(new Date(), timezone),
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? initialPayee ?? "");
  const [categoryId, setCategoryId] = useState(
    initial?.categoryId ?? initialCategoryId ?? "",
  );
  const [categoryName, setCategoryName] = useState(
    () =>
      categories.find(
        (category) =>
          category.id === (initial?.categoryId ?? initialCategoryId ?? ""),
      )?.name ?? "",
  );
  // A stored leg carries an id, not a name, and the picker shows the name, so
  // it is looked up here the same way the single category's is.
  const [legs, setLegs] = useState<TransactionFormLeg[]>(() =>
    (initial?.legs ?? []).map((leg) => ({
      ...leg,
      categoryName:
        leg.categoryName ||
        (categories.find((category) => category.id === leg.categoryId)?.name ?? ""),
    })),
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [fromAccountId, setFromAccountId] = useState(
    initial?.fromAccountId || initialAccountIds.fromAccountId,
  );
  const [toAccountId, setToAccountId] = useState(
    initial?.toAccountId || initialAccountIds.toAccountId,
  );
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [destinationAmount, setDestinationAmount] = useState(
    initial?.destinationAmount ?? "",
  );
  const [mode, setMode] = useState<"commit" | "stage">(initialMode);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  const [resetAfterSave, setResetAfterSave] = useState(false);
  const [categoryPickerVersion, setCategoryPickerVersion] = useState(0);
  const [repeatNotice, setRepeatNotice] = useState("");
  const payeeListId = useId();
  const submissionIdempotencyKey = useRef(newIdempotencyKey());
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  // What the form held before any template was picked, so applying one can put
  // back the fields it says nothing about.
  // Which fields the last chosen template set, so choosing another puts those
  // back rather than leaving the first one's values behind.
  const templateApplied = useRef<Set<string>>(new Set());
  const templateBaseline = useRef({
    type: initialFormType,
    date: initial?.date ?? calendarDateInTimezone(new Date(), timezone),
    payee: initial?.payee ?? initialPayee ?? "",
    description: initial?.description ?? "",
    notes: initial?.notes ?? "",
    categoryId: initial?.categoryId ?? initialCategoryId ?? "",
    categoryName:
      categories.find(
        (category) =>
          category.id === (initial?.categoryId ?? initialCategoryId ?? ""),
      )?.name ?? "",
    fromAccountId: initial?.fromAccountId || initialAccountIds.fromAccountId,
    toAccountId: initial?.toAccountId || initialAccountIds.toAccountId,
    amount: initial?.amount ?? "",
    destinationAmount: initial?.destinationAmount ?? "",
  });
  const [templateNotice, setTemplateNotice] = useState("");
  const queryClient = useQueryClient();
  // Read only. This form has no way to write a template, which is what makes
  // "changing this does not change the template" true rather than merely
  // intended.
  const templates = useQuery({
    queryKey: ["transaction-templates"],
    queryFn: () => api<TransactionTemplate[]>("/api/v1/transaction-templates"),
  });
  const payees = useQuery({
    queryKey: ["payees", "suggestions", payee.trim().toLowerCase()],
    queryFn: () =>
      api<string[]>(
        `/api/v1/payees/suggestions?search=${encodeURIComponent(payee.trim())}`,
      ),
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!fromAccountId && accounts[0]) setFromAccountId(accounts[0].id);
    if (!toAccountId && accounts[0]) setToAccountId(accounts[0].id);
  }, [accounts, fromAccountId, toAccountId]);

  useEffect(() => {
    const selectedCategory = categories.find(
      (category) => category.id === categoryId,
    );
    if (
      selectedCategory &&
      selectedCategory.kind !== "both" &&
      ((type === "deposit" && selectedCategory.kind !== "income") ||
        (type === "withdrawal" && selectedCategory.kind !== "expense") ||
        type === "transfer")
    ) {
      setCategoryId("");
      setCategoryName("");
    }
  }, [categories, categoryId, type]);

  // A category chosen somewhere other than this field - editing an existing
  // transaction, or a link that prefills one - still has to show its name.
  useEffect(() => {
    if (!categoryId) return;
    const selected = categories.find((category) => category.id === categoryId);
    if (selected && selected.name !== categoryName) setCategoryName(selected.name);
  }, [categories, categoryId]);

  const source = accounts.find((account) => account.id === fromAccountId);
  const destination = accounts.find((account) => account.id === toAccountId);
  const crossCurrency =
    type === "transfer" &&
    source &&
    destination &&
    source.currency !== destination.currency;
  // A transfer has no counter-account side to partition, so its legs are never
  // sent even if switching type left some behind in the form.
  const splitting = type !== "transfer" && legs.length >= 2;
  const splitSettled = !splitting || moneyRemainder(amount, legs.map((leg) => leg.amount || "0")) === "0";

  const resetCreateDraft = () => {
    // The picker and the record of what it set go back with everything else, or
    // the next entry starts under a template it is no longer showing.
    setSelectedTemplateId("");
    setTemplateNotice("");
    templateApplied.current = new Set();
    const accountIds = defaultAccountIds(createType);
    setType(createType);
    setDate(calendarDateInTimezone(new Date(), timezone));
    setPayee(initialPayee ?? "");
    setDescription("");
    setCategoryId(initialCategoryId ?? "");
    setCategoryName(
      categories.find((category) => category.id === initialCategoryId)?.name ?? "",
    );
    setLegs([]);
    setCategoryPickerVersion((version) => version + 1);
    setNotes("");
    setFromAccountId(accountIds.fromAccountId);
    setToAccountId(accountIds.toAccountId);
    setAmount("");
    setDestinationAmount("");
  };

  /**
   * Fill the form in from a template.
   *
   * Only the fields the template carries are applied. A field it says nothing
   * about keeps whatever is in the form, which on an edit is the transaction's
   * own value and after typing is what was typed.
   *
   * The exception is a field the previously chosen template set, which goes
   * back to what the form held before any template. Without that, picking
   * "Rent" and then "Coffee" would leave Rent's amount attached to Coffee,
   * which is a wrong transaction one click from being committed.
   */
  const applyTemplate = (template: TransactionTemplate | undefined) => {
    setSelectedTemplateId(template?.id ?? "");
    setTemplateNotice("");
    const base = templateBaseline.current;
    const previous = templateApplied.current;
    const draft = template?.draft ?? {};
    const missing: string[] = [];

    const take = <T,>(
      key: keyof TransactionTemplateDraft,
      value: T | undefined,
      restore: T,
      set: (next: T) => void,
    ) => {
      if (value !== undefined) set(value);
      else if (previous.has(key)) set(restore);
    };

    const nextType = draft.type ?? (previous.has("type") ? base.type : type);
    const accountIds = defaultAccountIds(nextType);

    setType(nextType);
    take("date", draft.date, base.date, setDate);
    take("payee", draft.payee, base.payee, setPayee);
    take("description", draft.description, base.description, setDescription);
    take("notes", draft.notes, base.notes, setNotes);
    take("amount", draft.amount, base.amount, setAmount);
    take(
      "destinationAmount",
      draft.destinationAmount,
      base.destinationAmount,
      setDestinationAmount,
    );

    // An account is taken only if it is still one the select can show.
    // Otherwise the field holds an id with no matching option: it looks empty,
    // passes the browser's own required check, and posts money to an account
    // the person cannot see.
    const resolveAccount = (id: string | undefined, fallback: string) => {
      if (!id) return fallback;
      if (accounts.some((account) => account.id === id && !account.archivedAt)) {
        return id;
      }
      missing.push("account");
      return fallback;
    };
    for (const side of ["fromAccountId", "toAccountId"] as const) {
      const set = side === "fromAccountId" ? setFromAccountId : setToAccountId;
      const current = side === "fromAccountId" ? fromAccountId : toAccountId;
      const restore = base[side] || accountIds[side];
      if (draft[side] !== undefined) set(resolveAccount(draft[side], restore));
      else if (previous.has(side)) set(restore);
      else if (!current) set(accountIds[side]);
    }

    // A split template replaces the whole category side, because legs and a
    // single category cannot both be sent. Amounts are optional on a template
    // leg, so a blank one stays blank and the remainder line asks for it.
    // The same rule both branches need: a category the picker cannot show must
    // not be carried in behind an empty-looking field.
    const usable = (id: string | undefined) => {
      const category = categories.find((entry) => entry.id === id);
      if (!category) return undefined;
      const fits =
        category.kind === "both"
          ? nextType !== "transfer"
          : (nextType === "deposit" && category.kind === "income") ||
            (nextType === "withdrawal" && category.kind === "expense");
      return fits ? category : undefined;
    };

    if (draft.legs?.length) {
      setCategoryId("");
      setCategoryName("");
      setLegs(
        draft.legs.map((leg) => {
          // A leg holding a dead id shows a blank picker, so the split reads as
          // merely unfinished rather than wrong. Cleared and named instead,
          // which is what the single-category branch below already does.
          const category = leg.categoryId ? usable(leg.categoryId) : undefined;
          if (leg.categoryId && !category) missing.push("category");
          return {
            id: "",
            categoryId: category?.id ?? "",
            categoryName: category?.name ?? (leg.categoryId ? "" : leg.categoryName ?? ""),
            amount: leg.amount ?? "",
            note: leg.note ?? "",
          };
        }),
      );
    } else if (draft.categoryId) {
      setLegs([]);
      const category = usable(draft.categoryId);
      if (!category) missing.push("category");
      setCategoryId(category?.id ?? "");
      setCategoryName(category?.name ?? "");
    } else if (draft.categoryName) {
      // A name rather than an id, matched or created on submit the way a typed
      // one is. Nothing is looked up here, so a template can name a category
      // this ledger does not have yet.
      setLegs([]);
      setCategoryId("");
      setCategoryName(draft.categoryName);
    } else if (
      previous.has("categoryId") ||
      previous.has("categoryName") ||
      previous.has("legs")
    ) {
      setLegs([]);
      setCategoryId(base.categoryId);
      setCategoryName(base.categoryName);
    }
    setCategoryPickerVersion((version) => version + 1);
    templateApplied.current = new Set(Object.keys(draft));

    if (missing.length) {
      setTemplateNotice(
        `This template's ${[...new Set(missing)].join(" and ")} is no longer available. Choose again before saving.`,
      );
    }
  };

  const mutation = useMutation<unknown, Error, boolean | undefined>({
    mutationFn: async (forceDuplicate = false) => {
      setRepeatNotice("");
      const duplicateAllowed = allowDuplicate || forceDuplicate;
      const common = {
        date,
        payee,
        description: description || null,
        // A split says which categories the money went to, one per leg, so
        // the single category goes out cleared rather than alongside them.
        categoryId: splitting ? null : categoryId || null,
        // Only when the field did not settle on one this ledger already has.
        // The server matches it case-insensitively and creates it only if it
        // is genuinely new.
        categoryName: splitting || categoryId ? null : categoryName.trim() || null,
        ...(splitting
          ? {
              legs: legs.map((leg) => ({
                ...(leg.id ? { id: leg.id } : {}),
                categoryId: leg.categoryId || null,
                categoryName: leg.categoryId ? null : leg.categoryName.trim() || null,
                amount: leg.amount,
                note: leg.note.trim() || null,
              })),
            }
          : {}),
        notes: notes || null,
        // Carried through rather than edited. This is the reference the row
        // arrived with from a bank file, and it is what stops the same
        // statement being imported twice. Dropping it on an edit would let the
        // next import bring the row back in as a new transaction.
        externalId: initial?.externalId || null,
        // Provenance, kept so a template can report what came of it. The
        // template last applied wins, and an entry that never had one keeps
        // whatever it arrived with rather than losing it on an edit.
        templateId: selectedTemplateId || initial?.templateId || null,
      };
      const draft: TransactionDraft =
        type === "deposit"
          ? { type, toAccountId, amount, ...common }
          : type === "withdrawal"
            ? { type, fromAccountId, amount, ...common }
            : {
                type,
                fromAccountId,
                toAccountId,
                sourceAmount: amount,
                ...(crossCurrency || destinationAmount
                  ? { destinationAmount: destinationAmount || amount }
                  : {}),
                ...common,
              };

      if (transaction) {
        return api(`/api/v1/transactions/${transaction.id}`, {
          ...json({
            draft,
            expectedVersion: transaction.version,
            allowDuplicate: duplicateAllowed,
          }),
          method: "PUT",
        });
      }
      if (staged) {
        return api(`/api/v1/staged-transactions/${staged.id}`, {
          ...json({ draft, expectedVersion: staged.version }),
          method: "PUT",
        });
      }
      if (mode === "stage") {
        return api("/api/v1/staged-transactions", {
          ...json({
            draft,
            idempotencyKey: submissionIdempotencyKey.current,
          }),
        });
      }
      return api("/api/v1/transactions", {
        ...json({
          draft,
          idempotencyKey: submissionIdempotencyKey.current,
          allowDuplicate: duplicateAllowed,
        }),
      });
    },
    onSuccess: async () => {
      submissionIdempotencyKey.current = newIdempotencyKey();
      setAllowDuplicate(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        // Naming a category or a payee that does not exist yet creates it, so
        // the lists that show them are out of date the moment this returns.
        queryClient.invalidateQueries({ queryKey: ["categories"] }),
        queryClient.invalidateQueries({ queryKey: ["payees"] }),
      ]);
      if (!transaction && !staged && createAnother) {
        if (resetAfterSave) resetCreateDraft();
        setRepeatNotice(
          mode === "stage"
            ? "Transaction staged. Create another when ready."
            : "Transaction committed. Create another when ready.",
        );
        return;
      }
      onDone();
    },
  });

  return (
    <form
      className="form-grid"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        mutation.mutate(undefined);
      }}
    >
      {mutation.error ? (
        <Alert>
          {mutation.error.message}
          {mutation.error instanceof ApiClientError &&
          mutation.error.code === "DUPLICATE" &&
          !allowDuplicate &&
          !staged ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setAllowDuplicate(true);
                mutation.mutate(true);
              }}
            >
              Commit anyway
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {templates.data?.length ? (
        <Field
          label="Start from a template"
          hint="Optional. Anything you change here stays here; the template is not touched."
        >
          <Select
            value={selectedTemplateId}
            onChange={(event) =>
              applyTemplate(
                templates.data?.find(
                  (entry) => entry.id === event.target.value,
                ),
              )
            }
          >
            <option value="">No template</option>
            {templates.data.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {templateNotice ? <Alert kind="info">{templateNotice}</Alert> : null}
      <div className="transaction-type-grid" role="radiogroup" aria-label="Transaction type">
          {transactionTypeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={type === option.type}
                key={option.type}
                className={`transaction-type ${type === option.type ? "selected" : ""}`}
                onClick={() => {
                  setType(option.type);
                  if (transaction || staged) return;
                  const primaryAccountId =
                    initialAccountId ?? accounts[0]?.id ?? "";
                  if (option.type === "withdrawal") {
                    setFromAccountId(primaryAccountId);
                  } else if (option.type === "deposit") {
                    setToAccountId(primaryAccountId);
                  } else {
                    setFromAccountId(primaryAccountId);
                    setToAccountId(
                      accounts.find(
                        (account) => account.id !== primaryAccountId,
                      )?.id ?? "",
                    );
                  }
                }}
              >
                <Icon size={19} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            );
          })}
      </div>
      <div className="two-columns">
        <Field label="Date">
          <Input type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Payee">
          <Input
            autoFocus
            required
            list={payeeListId}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={payeeListId}
            value={payee}
            onChange={(event) => {
              const next = event.target.value;
              const match = payees.data?.find(
                (candidate) =>
                  normalizeAutocompleteValue(candidate) ===
                  normalizeAutocompleteValue(next),
              );
              setPayee(match ?? next);
            }}
            onBlur={() => {
              const match = payees.data?.find(
                (candidate) =>
                  normalizeAutocompleteValue(candidate) ===
                  normalizeAutocompleteValue(payee),
              );
              setPayee(match ?? payee.trim().replace(/\s+/gu, " "));
            }}
            placeholder="Merchant, employer, person…"
          />
          <datalist id={payeeListId}>
            {payees.data?.map((value) => <option key={value} value={value} />)}
          </datalist>
        </Field>
      </div>
      {type !== "deposit" ? (
        <Field label={type === "transfer" ? "From account" : "Account"}>
          <Select required value={fromAccountId} onChange={(event) => setFromAccountId(event.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {type !== "withdrawal" ? (
        <Field label={type === "transfer" ? "To account" : "Account"}>
          <Select required value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
            <option value="">Choose an account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className={crossCurrency ? "two-columns" : ""}>
        <Field
          label={
            type === "transfer"
              ? `Amount sent${source ? ` (${source.currency})` : ""}`
              : `Amount${
                  (type === "deposit" ? destination : source)
                    ? ` (${(type === "deposit" ? destination : source)!.currency})`
                    : ""
                }`
          }
        >
          <Input
            required
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
          />
        </Field>
        {crossCurrency ? (
          <Field
            label={`Amount received${destination ? ` (${destination.currency})` : ""}`}
            hint="The implied rate is saved with the transfer"
          >
            <Input
              required
              inputMode="decimal"
              value={destinationAmount}
              onChange={(event) => setDestinationAmount(event.target.value)}
              placeholder="0.00"
              pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
            />
          </Field>
        ) : null}
      </div>
      <div className="two-columns">
        <Field label="Description" hint="Optional">
          <Input
            value={description ?? ""}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Additional details"
          />
        </Field>
      </div>
      {type === "transfer" ? null : (
        <Field label="Category" hint="Optional">
          <CategoryLegs
            key={categoryPickerVersion}
            categories={categories}
            type={type}
            categoryId={categoryId ?? ""}
            categoryName={categoryName}
            onCategoryChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
            legs={legs}
            onLegsChange={setLegs}
            total={amount}
          />
        </Field>
      )}
      <Field label="Notes" hint="Optional">
        <Textarea rows={3} value={notes ?? ""} onChange={(event) => setNotes(event.target.value)} />
      </Field>
      {!transaction && !staged ? (
        <>
          <fieldset className="commit-choice">
            <legend>What should happen next?</legend>
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "commit"}
                onChange={() => setMode("commit")}
              />
              <span>
                <strong>Commit now</strong>
                <small>Include it in balances immediately</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                checked={mode === "stage"}
                onChange={() => setMode("stage")}
              />
              <span>
                <strong>Stage for review</strong>
                <small>Keep it out of balances until approved</small>
              </span>
            </label>
          </fieldset>
          <fieldset
            className="repeat-entry-options"
            aria-label="Repeat transaction entry"
          >
            <label className="check-label">
              <input
                type="checkbox"
                checked={createAnother}
                disabled={mutation.isPending}
                onChange={(event) => {
                  setCreateAnother(event.target.checked);
                  if (!event.target.checked) setResetAfterSave(false);
                }}
              />
              After saving/staging, return to create another
            </label>
            {createAnother ? (
              <label className="check-label repeat-entry-reset">
                <input
                  type="checkbox"
                  checked={resetAfterSave}
                  disabled={mutation.isPending}
                  onChange={(event) => setResetAfterSave(event.target.checked)}
                />
                Reset after saving/staging
              </label>
            ) : null}
          </fieldset>
        </>
      ) : null}
      {repeatNotice ? <Alert kind="success">{repeatNotice}</Alert> : null}
      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!splitSettled}
        >
          {transaction || staged ? "Save changes" : mode === "stage" ? "Stage transaction" : "Commit transaction"}
        </Button>
      </div>
    </form>
  );
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Ordered by the shared list, so the picker cannot offer an ordinal the schema
// refuses or miss one it accepts.
const ORDINAL_LABELS: Record<RecurrenceOrdinal, string> = {
  1: "First",
  2: "Second",
  3: "Third",
  4: "Fourth",
  [-1]: "Last",
};
const ORDINAL_NAMES = recurrenceOrdinals.map((value) => ({
  value,
  label: ORDINAL_LABELS[value],
}));

const FREQUENCY_UNITS: Record<RecurrenceFrequencyName, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** How a schedule reads in a sentence, for the list and the form's summary. */
export function scheduleSentence(schedule: {
  frequency: RecurrenceFrequencyName;
  interval: number;
  anchorDate: string;
  positionOrdinal?: number | null;
  positionWeekday?: number | null;
}) {
  const unit = FREQUENCY_UNITS[schedule.frequency];
  const every =
    schedule.interval === 1 ? `Every ${unit}` : `Every ${schedule.interval} ${unit}s`;
  if (schedule.positionOrdinal != null && schedule.positionWeekday != null) {
    const ordinal = ORDINAL_NAMES.find(
      (one) => one.value === schedule.positionOrdinal,
    )?.label.toLowerCase();
    return `${every}, on the ${ordinal} ${WEEKDAY_NAMES[schedule.positionWeekday]}`;
  }
  if (schedule.frequency === "weekly") {
    return `${every}, on ${WEEKDAY_NAMES[weekdayOf(schedule.anchorDate)]}`;
  }
  if (schedule.frequency === "monthly" || schedule.frequency === "yearly") {
    return `${every}, on day ${Number(schedule.anchorDate.slice(8, 10))}`;
  }
  return every;
}

/**
 * A standing instruction, and its own form for the reason a template has one.
 *
 * It collects a shape with no date, because the schedule supplies that, and a
 * schedule whose awkward-date policies only make sense for some frequencies.
 * The preview is computed with the same arithmetic the scheduler runs, so what
 * it shows is what will actually be proposed rather than a second opinion.
 */
export function RecurrenceForm({
  accounts,
  categories,
  recurrence,
  onDone,
}: {
  accounts: Account[];
  categories: Category[];
  recurrence?: Recurrence;
  onDone: () => void;
}) {
  const timezone = useTimezone();
  const today = calendarDateInTimezone(new Date(), timezone);
  const shape = recurrence?.shape;
  const [name, setName] = useState(recurrence?.name ?? "");
  const [type, setType] = useState<TransactionType>(shape?.type ?? "withdrawal");
  const [payee, setPayee] = useState(shape?.payee ?? "");
  const [fromAccountId, setFromAccountId] = useState(
    (shape && "fromAccountId" in shape ? shape.fromAccountId : "") || "",
  );
  const [toAccountId, setToAccountId] = useState(
    (shape && "toAccountId" in shape ? shape.toAccountId : "") || "",
  );
  const [amount, setAmount] = useState(shape?.amount ?? "");
  const [categoryId, setCategoryId] = useState(shape?.categoryId ?? "");
  // A stored shape may name its category rather than cite one, the way a CSV
  // import or an agent leaves it. Seeding from the id alone dropped the name on
  // the floor, and saving then wrote the recurrence back with no category.
  const [categoryName, setCategoryName] = useState(
    categories.find((category) => category.id === shape?.categoryId)?.name ??
      shape?.categoryName ??
      "",
  );
  const [legs, setLegs] = useState<TransactionFormLeg[]>(() =>
    (shape?.legs ?? []).map((leg) => ({
      id: "",
      categoryId: leg.categoryId ?? "",
      categoryName:
        categories.find((category) => category.id === leg.categoryId)?.name ??
        leg.categoryName ??
        "",
      amount: leg.amount ?? "",
      note: leg.note ?? "",
    })),
  );
  const [description, setDescription] = useState(shape?.description ?? "");
  const [notes, setNotes] = useState(shape?.notes ?? "");
  const [frequency, setFrequency] = useState<RecurrenceFrequencyName>(
    recurrence?.frequency ?? "monthly",
  );
  const [interval, setInterval] = useState(String(recurrence?.interval ?? 1));
  const [anchorDate, setAnchorDate] = useState(recurrence?.anchorDate ?? today);
  const [monthPolicy, setMonthPolicy] = useState(
    recurrence?.monthPolicy ?? "last_day",
  );
  const [weekendPolicy, setWeekendPolicy] = useState(
    recurrence?.weekendPolicy ?? "allow",
  );
  const [byPosition, setByPosition] = useState(
    recurrence?.positionOrdinal != null,
  );
  const [ordinal, setOrdinal] = useState<RecurrencePosition["ordinal"]>(
    (recurrence?.positionOrdinal as RecurrencePosition["ordinal"]) ?? 1,
  );
  const [weekday, setWeekday] = useState(recurrence?.positionWeekday ?? 1);
  const queryClient = useQueryClient();

  const positional = frequency === "monthly" || frequency === "yearly";
  const usesPosition = positional && byPosition;
  const intervalNumber = Number(interval) || 1;
  // A weekend policy moves a date up to two days, so a daily schedule of one
  // or two days can put two occurrences on one date. The queue refuses to
  // commit rows that alike, so the server refuses the combination outright.
  // Disabling it here says so before the refusal does.
  const businessDayBlocked = frequency === "daily" && intervalNumber <= 2;

  useEffect(() => {
    if (businessDayBlocked && weekendPolicy.endsWith("business_day")) {
      setWeekendPolicy("allow");
    }
  }, [businessDayBlocked, weekendPolicy]);

  const preview = useMemo(() => {
    if (!anchorDate) return [];
    const rule = {
      frequency,
      interval: intervalNumber,
      anchorDate,
      monthPolicy,
      weekendPolicy,
      position: usesPosition ? { ordinal, weekday } : null,
    };
    const dates = [];
    let cursor = addDays(laterOf(anchorDate, today), -1);
    try {
      for (let index = 0; index < 5; index += 1) {
        const next = nextOccurrenceAfter(rule, cursor);
        dates.push(next);
        cursor = next.occurrenceDate;
      }
    } catch {
      return [];
    }
    return dates;
  }, [
    anchorDate,
    frequency,
    intervalNumber,
    monthPolicy,
    ordinal,
    today,
    usesPosition,
    weekday,
    weekendPolicy,
  ]);

  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = (value: string) => (value.trim() ? value.trim() : undefined);
      // Whatever is on screen, not a filtered subset of it: `ready` above has
      // already refused a split with a blank row, so anything less than the
      // whole list here would be silently posting a different division.
      const kept = splitting ? legs : [];
      const body = {
        name: name.trim(),
        shape: {
          type,
          payee: payee.trim(),
          ...(type !== "deposit" ? { fromAccountId } : {}),
          ...(type !== "withdrawal" ? { toAccountId } : {}),
          ...(trimmed(amount) ? { amount: trimmed(amount) } : {}),
          ...(kept.length >= 2
            ? {
                legs: kept.map((leg) => ({
                  ...(leg.categoryId
                    ? { categoryId: leg.categoryId }
                    : { categoryName: trimmed(leg.categoryName) }),
                  amount: trimmed(leg.amount),
                  ...(trimmed(leg.note) ? { note: trimmed(leg.note) } : {}),
                })),
              }
            : categoryId
              ? { categoryId }
              : trimmed(categoryName)
                ? { categoryName: trimmed(categoryName) }
                : {}),
          ...(trimmed(description) ? { description: trimmed(description) } : {}),
          ...(trimmed(notes) ? { notes: trimmed(notes) } : {}),
        },
        schedule: {
          frequency,
          interval: intervalNumber,
          anchorDate,
          monthPolicy,
          weekendPolicy,
          position: usesPosition ? { ordinal, weekday } : null,
        },
      };
      return recurrence
        ? api<Recurrence>(`/api/v1/recurrences/${recurrence.id}`, {
            ...json({ ...body, expectedVersion: recurrence.version }),
            method: "PUT",
          })
        : api<Recurrence>("/api/v1/recurrences", json(body));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurrences"] });
      onDone();
    },
  });

  const accountOptions = accounts.filter((account) => !account.archivedAt);
  const accountReady = type === "deposit" ? toAccountId : fromAccountId;
  const transferReady = type !== "transfer" || (fromAccountId && toAccountId);
  // A recurrence's legs are required and must add up, unlike a template's,
  // because the same division is replayed on every occurrence: one that does
  // not balance proposes a row nobody can commit, over and over.
  const splitting = type !== "transfer" && legs.length >= 2;
  const splitSettled =
    !splitting ||
    moneyRemainder(amount, legs.map((leg) => leg.amount || "0")) === "0";
  // Every leg of a split has to name a category and an amount, or the save
  // silently posts fewer legs than are on screen. A row left blank used to be
  // dropped, which took the split below two and sent no category at all.
  const legsComplete =
    !splitting ||
    legs.every((leg) => (leg.categoryId || leg.categoryName.trim()) && leg.amount.trim());
  const ready = Boolean(
    name.trim() &&
      payee.trim() &&
      accountReady &&
      transferReady &&
      splitSettled &&
      legsComplete,
  );

  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) mutation.mutate();
      }}
    >
      <Field label="Name" hint="What you will pick it out by later.">
        <Input
          autoFocus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Rent"
        />
      </Field>

      <div className="transaction-type-grid" role="radiogroup" aria-label="Transaction type">
        {transactionTypeOptions.map((option) => {
          const Icon = option.icon;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={type === option.type}
              key={option.type}
              className={`transaction-type ${type === option.type ? "selected" : ""}`}
              onClick={() => setType(option.type)}
            >
              <Icon size={19} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          );
        })}
      </div>

      <Field label="Payee">
        <PayeeInput value={payee} onChange={setPayee} />
      </Field>

      {type !== "deposit" ? (
        <Field label={type === "transfer" ? "From account" : "Account"}>
          <Select
            required
            value={fromAccountId}
            onChange={(event) => setFromAccountId(event.target.value)}
          >
            <option value="">Choose an account</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {type !== "withdrawal" ? (
        <Field label={type === "transfer" ? "To account" : "Account"}>
          <Select
            required
            value={toAccountId}
            onChange={(event) => setToAccountId(event.target.value)}
          >
            <option value="">Choose an account</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field
        label="Amount"
        hint="Leave blank when it differs every time. Each proposal then waits in the review queue for a number."
      >
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
        />
      </Field>

      {type === "transfer" ? null : (
        <Field label="Category" hint="Optional">
          <CategoryLegs
            categories={categories}
            type={type}
            categoryId={categoryId}
            categoryName={categoryName}
            onCategoryChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
            legs={legs}
            onLegsChange={setLegs}
            total={amount}
          />
        </Field>
      )}

      <fieldset className="form-fieldset">
        <legend>Schedule</legend>
        <div className="two-columns">
          <Field label="Repeats">
            <Select
              value={frequency}
              onChange={(event) =>
                setFrequency(event.target.value as RecurrenceFrequencyName)
              }
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
          <Field label={`Every N ${FREQUENCY_UNITS[frequency]}s`} hint="1 means every one.">
            <Input
              type="number"
              min={1}
              max={366}
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Starting"
          hint="The first candidate date, and the one every later date is counted from. Nothing dated before today is ever proposed."
        >
          <Input
            type="date"
            required
            value={anchorDate}
            onChange={(event) => setAnchorDate(event.target.value)}
          />
        </Field>

        {positional ? (
          <>
            <div className="radio-row" role="radiogroup" aria-label="Day of the month">
              <label className="check-label">
                <input
                  type="radio"
                  checked={!byPosition}
                  onChange={() => setByPosition(false)}
                />
                On day {Number(anchorDate.slice(8, 10)) || 1} of the month
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  checked={byPosition}
                  onChange={() => setByPosition(true)}
                />
                On a relative day
              </label>
            </div>
            {byPosition ? (
              <div className="two-columns">
                <Field label="Which one">
                  <Select
                    value={String(ordinal)}
                    onChange={(event) =>
                      setOrdinal(
                        Number(event.target.value) as RecurrencePosition["ordinal"],
                      )
                    }
                  >
                    {ORDINAL_NAMES.map((one) => (
                      <option key={one.value} value={one.value}>
                        {one.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Day">
                  <Select
                    value={String(weekday)}
                    onChange={(event) => setWeekday(Number(event.target.value))}
                  >
                    {WEEKDAY_NAMES.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : (
              <Field label="When the month is too short">
                <Select
                  value={monthPolicy}
                  onChange={(event) =>
                    setMonthPolicy(event.target.value as Recurrence["monthPolicy"])
                  }
                >
                  <option value="last_day">Use the last day of that month</option>
                  <option value="skip">Skip that month</option>
                </Select>
              </Field>
            )}
          </>
        ) : null}

        <Field
          label="When it lands on a weekend"
          hint="A business day here means Monday to Friday. Public holidays are not modelled."
        >
          <Select
            value={weekendPolicy}
            onChange={(event) =>
              setWeekendPolicy(event.target.value as Recurrence["weekendPolicy"])
            }
          >
            <option value="allow">Propose it on the weekend</option>
            <option value="skip">Skip it</option>
            <option value="previous_business_day" disabled={businessDayBlocked}>
              Move it back to the Friday
            </option>
            <option value="next_business_day" disabled={businessDayBlocked}>
              Move it on to the Monday
            </option>
          </Select>
        </Field>
        {businessDayBlocked ? (
          <p className="settings-note">
            A daily schedule of one or two days moved onto a business day puts
            two occurrences on the same date, and the review queue refuses to
            commit rows that alike. Make the interval three days or more to use
            those two.
          </p>
        ) : null}

        {preview.length ? (
          <div className="recurrence-preview">
            <span className="recurrence-preview-label">Next five</span>
            <ul>
              {preview.map((one) => (
                <li key={one.occurrenceDate}>
                  {one.postedDate ? (
                    <>
                      {formatDate(one.postedDate)}
                      {one.postedDate === one.occurrenceDate ? null : (
                        <small> moved from {formatDate(one.occurrenceDate)}</small>
                      )}
                    </>
                  ) : (
                    <small>{formatDate(one.occurrenceDate)} skipped</small>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </fieldset>

      <Field label="Description" hint="Optional">
        <Input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Additional details"
        />
      </Field>
      <Field label="Notes" hint="Optional">
        <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </Field>

      <Alert kind="info">
        A recurrence proposes into the review queue and posts nothing. Each
        proposal is an ordinary staged row you check and commit.
      </Alert>
      {mutation.error ? <Alert>{mutation.error.message}</Alert> : null}

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending} disabled={!ready}>
          {recurrence ? "Save recurrence" : "Create recurrence"}
        </Button>
      </div>
    </form>
  );
}
