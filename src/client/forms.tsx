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

function draftFromTransaction(transaction: Transaction): TransactionDraft {
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

function CategoryPicker({
  categories,
  type,
  categoryId,
  onChange,
}: {
  categories: Category[];
  type: TransactionType;
  categoryId: string;
  onChange: (categoryId: string) => void;
}) {
  const listId = useId();
  const queryClient = useQueryClient();
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
    [categories, type],
  );
  const selected = categories.find((category) => category.id === categoryId);
  const [value, setValue] = useState(selected?.name ?? "");

  useEffect(() => {
    const next = categories.find((category) => category.id === categoryId);
    setValue(next?.name ?? "");
  }, [categories, categoryId]);

  const normalized = normalizeCategoryName(value);
  const exact = compatible.find(
    (category) => normalizeCategoryName(category.name) === normalized,
  );
  const createMutation = useMutation({
    mutationFn: () =>
      api<Category>(
        "/api/v1/categories",
        json({
          name: value.trim().replace(/\s+/g, " "),
          kind:
            type === "deposit"
              ? "income"
              : type === "withdrawal"
                ? "expense"
                : "both",
        }),
      ),
    onSuccess: async (category) => {
      onChange(category.id);
      setValue(category.name);
      await queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onError: (error) => {
      if (!(error instanceof ApiClientError) || error.code !== "DUPLICATE") return;
      const details = error.details as { duplicateCategoryId?: string } | undefined;
      if (!details?.duplicateCategoryId) return;
      const duplicateCategory = categories.find(
        (category) => category.id === details.duplicateCategoryId,
      );
      if (duplicateCategory) {
        onChange(duplicateCategory.id);
        setValue(duplicateCategory.name);
      }
    },
  });

  return (
    <div className="category-picker">
      <div className="inline-input-action">
        <Input
          list={listId}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            const match = compatible.find(
              (category) =>
                normalizeCategoryName(category.name) ===
                normalizeCategoryName(next),
            );
            setValue(match?.name ?? next);
            onChange(match?.id ?? "");
          }}
          placeholder="Type to search or add"
        />
        <datalist id={listId}>
          {compatible.map((category) => (
            <option key={category.id} value={category.name} />
          ))}
        </datalist>
        {normalized && !exact ? (
          <Button
            type="button"
            variant="secondary"
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Add “{value.trim()}”
          </Button>
        ) : null}
      </div>
      {createMutation.error ? (
        <small className="field-error">{createMutation.error.message}</small>
      ) : null}
      {value && !categoryId && !createMutation.isPending ? (
        <small>Select a suggestion or add this as a new category.</small>
      ) : null}
    </div>
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
  const submissionIdempotencyKey = useRef(crypto.randomUUID());
  const queryClient = useQueryClient();
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
    }
  }, [categories, categoryId, type]);

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
    setCategoryPickerVersion((version) => version + 1);
    setNotes("");
    setFromAccountId(accountIds.fromAccountId);
    setToAccountId(accountIds.toAccountId);
    setAmount("");
    setDestinationAmount("");
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
        notes: notes || null,
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
      submissionIdempotencyKey.current = crypto.randomUUID();
      setAllowDuplicate(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["transactions"] }),
        queryClient.invalidateQueries({ queryKey: ["staged"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
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
            onChange={setCategoryId}
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
