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
  type UserAccountType,
  type TransactionDraft,
  type TransactionTemplateDraft,
  type TransactionType,
} from "../shared/domain.js";
import {
  api,
  ApiClientError,
  json,
  type Account,
  type Category,
  type StagedTransaction,
  type Transaction,
  type TransactionTemplate,
} from "./api.js";
import {
  Alert,
  Button,
  Field,
  Input,
  isNegativeMoney,
  isPositiveMoney,
  Select,
  Textarea,
} from "./components.js";
import { draftForTransactionForm } from "./staged-draft.js";
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
  type: TransactionType;
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
  const [type, setType] = useState<TransactionType>(source.type ?? "withdrawal");
  const [payee, setPayee] = useState(source.payee ?? "");
  const [fromAccountId, setFromAccountId] = useState(source.fromAccountId ?? "");
  const [toAccountId, setToAccountId] = useState(source.toAccountId ?? "");
  const [amount, setAmount] = useState(source.amount ?? "");
  const [categoryId, setCategoryId] = useState(source.categoryId ?? "");
  const [categoryName, setCategoryName] = useState(
    categories.find((category) => category.id === source.categoryId)?.name ?? "",
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
      const draft: Record<string, string> = { type };
      const keep = (key: string, value: string) => {
        if (value.trim()) draft[key] = value.trim();
      };
      keep("payee", payee);
      if (type !== "deposit") keep("fromAccountId", fromAccountId);
      if (type !== "withdrawal") keep("toAccountId", toAccountId);
      keep("amount", amount);
      // Only an id. A typed name would create a category every time the
      // template was used.
      if (categoryId) draft.categoryId = categoryId;
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

      <Field label="Payee" hint="Leave blank to fill in each time.">
        <PayeeInput value={payee} onChange={setPayee} />
      </Field>

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

      <div className="two-columns">
        <Field label="Category" hint="Optional">
          <CategoryPicker
            categories={categories}
            type={type}
            categoryId={categoryId}
            categoryName={categoryName}
            onChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
          />
        </Field>
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
          A template holds a category you have already, so “{categoryName.trim()}”
          is not saved. Pick one from the list, or leave it blank and choose when
          you use the template.
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
  const [templateNotice, setTemplateNotice] = useState("");
  const queryClient = useQueryClient();
  // Read only. This form has no way to write a template, which is what makes
  // "changing this does not change the template" true rather than merely
  // intended.
  const templates = useQuery({
    queryKey: ["transaction-templates"],
    queryFn: () => api<TransactionTemplate[]>("/api/v1/transaction-templates"),
    enabled: !transaction && !staged,
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

  const resetCreateDraft = () => {
    const accountIds = defaultAccountIds(createType);
    setType(createType);
    setDate(calendarDateInTimezone(new Date(), timezone));
    setPayee(initialPayee ?? "");
    setDescription("");
    setCategoryId(initialCategoryId ?? "");
    setCategoryName(
      categories.find((category) => category.id === initialCategoryId)?.name ?? "",
    );
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
   * Every field is reset first and only then filled from the template, rather
   * than the template's keys being patched over whatever is there. Picking
   * "Rent" and then "Coffee" would otherwise leave Rent's amount attached to
   * Coffee, which is a wrong transaction one click from being committed.
   *
   * The date is always today. A template that remembered one would post
   * transactions dated months back every time it was used.
   */
  const applyTemplate = (template: TransactionTemplate | undefined) => {
    setSelectedTemplateId(template?.id ?? "");
    setTemplateNotice("");
    if (!template) {
      resetCreateDraft();
      return;
    }
    const draft = template.draft;
    const accountIds = defaultAccountIds(draft.type);
    const missing: string[] = [];

    setType(draft.type);
    setDate(calendarDateInTimezone(new Date(), timezone));
    setPayee(draft.payee ?? "");
    setDescription(draft.description ?? "");
    setNotes(draft.notes ?? "");
    setAmount(draft.amount ?? "");
    setDestinationAmount(draft.destinationAmount ?? "");

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
    setFromAccountId(resolveAccount(draft.fromAccountId, accountIds.fromAccountId));
    setToAccountId(resolveAccount(draft.toAccountId, accountIds.toAccountId));

    const category = draft.categoryId
      ? categories.find((entry) => entry.id === draft.categoryId)
      : undefined;
    const categoryFits =
      category &&
      (category.kind === "both"
        ? draft.type !== "transfer"
        : (draft.type === "deposit" && category.kind === "income") ||
          (draft.type === "withdrawal" && category.kind === "expense"));
    if (draft.categoryId && !categoryFits) missing.push("category");
    setCategoryId(categoryFits ? category!.id : "");
    setCategoryName(categoryFits ? category!.name : "");
    setCategoryPickerVersion((version) => version + 1);

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
        categoryId: categoryId || null,
        // Only when the field did not settle on one this ledger already has.
        // The server matches it case-insensitively and creates it only if it
        // is genuinely new.
        categoryName: categoryId ? null : categoryName.trim() || null,
        notes: notes || null,
        // Carried through rather than edited. This is the reference the row
        // arrived with from a bank file, and it is what stops the same
        // statement being imported twice. Dropping it on an edit would let the
        // next import bring the row back in as a new transaction.
        externalId: initial?.externalId || null,
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
      {!transaction && !staged && templates.data?.length ? (
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
        <Field label="Category" hint="Optional">
          <CategoryPicker
            key={categoryPickerVersion}
            categories={categories}
            type={type}
            categoryId={categoryId ?? ""}
            categoryName={categoryName}
            onChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <Input
            value={description ?? ""}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Additional details"
          />
        </Field>
      </div>
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
        <Button type="submit" loading={mutation.isPending}>
          {transaction || staged ? "Save changes" : mode === "stage" ? "Stage transaction" : "Commit transaction"}
        </Button>
      </div>
    </form>
  );
}
