import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
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
  recurrenceScheduleSchema,
  resolveEntrySide,
  templateNotificationSchema,
  type CategoryKind,
  type RecurrenceFrequencyName,
  type RecurrenceOrdinal,
  type RecurrenceSchedule,
  type TemplateNotification,
  type UserAccountType,
  type TransactionDraft,
  type TransactionTemplateDraft,
  type TransactionType,
} from "../shared/domain.js";
import {
  addDays,
  nextOccurrenceAfter,
  proposalFloorSwallows,
  scheduleCursor,
  type RecurrencePosition,
  weekdayOf,
} from "../shared/recurrence-dates.js";
import {
  api,
  ApiClientError,
  json,
  type Account,
  type AuthPublicOptions,
  type Category,
  type Recurrence,
  type StagedTransaction,
  type Transaction,
  type TransactionTemplate,
} from "./api.js";
import {
  Alert,
  Button,
  ErrorSummary,
  Field,
  Input,
  RequiredNote,
  Select,
  Textarea,
} from "./components.js";
import {
  compareMoney,
  formatDate,
  isNegativeMoney,
  isPositiveMoney,
  moneyRemainder,
} from "./money.js";
import {
  draftForTransactionForm,
  type RecurrenceShapeSeed,
  type TransactionFormLeg,
} from "./staged-draft.js";
import { currencyOptionLabel, currencyOptions } from "./select-options.js";
import { calendarDateInTimezone, useTimezone } from "./timezone.js";
import { newIdempotencyKey } from "./idempotency.js";
import { cleanHumanName, normalizeHumanName } from "../shared/names.js";

// Keys for legs the server has not named yet. A counter, not an id: it only
// has to be unique within one page's lifetime, and it exists so a removed
// middle row does not re-key the rows behind it.
let legKeySeed = 0;
const nextLegKey = () => `leg-${(legKeySeed += 1)}`;

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
  const [liabilityBalanceKind, setLiabilityBalanceKind] = useState<"owed" | "credit">(
    account && liabilityAccountTypes.has(account.type) && isPositiveMoney(account.openingBalance)
      ? "credit"
      : "owed",
  );
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [notes, setNotes] = useState(account?.notes ?? "");
  // On by default, and on for a card. A card is inside the budget's perimeter
  // because spending on one empties an envelope; leaving cards out would say
  // there is more money to assign than there is.
  const [inBudget, setInBudget] = useState(account?.inBudget ?? true);

  const changeAccountType = (nextType: UserAccountType) => {
    const wasLiability = liabilityAccountTypes.has(type);
    const willBeLiability = liabilityAccountTypes.has(nextType);

    if (wasLiability && !willBeLiability) {
      const magnitude = openingBalance.replace(/^-/, "");
      setOpeningBalance(
        liabilityBalanceKind === "owed" && isPositiveMoney(magnitude) ? `-${magnitude}` : magnitude,
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
        inBudget,
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
      // Budgets and the forecast read the same postings; without these two
      // the Budgets page showed pre-mutation figures for its staleTime.
      await queryClient.invalidateQueries({ queryKey: ["budgets"] });
      await queryClient.invalidateQueries({ queryKey: ["forecast"] });
      onDone();
    },
  });

  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <ErrorSummary error={mutation.error} />
      <RequiredNote />
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
            onChange={(event) => changeAccountType(event.target.value as UserAccountType)}
          >
            {userAccountTypes.map((value) => (
              <option key={value} value={value}>
                {accountTypeLabels[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency or crypto asset" hint="Fixed once this account is in use">
          <Select required value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {currencyOptions(currency).map((option) => (
              <option key={option} value={option}>
                {currencyOptionLabel(option)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className={liabilityAccountTypes.has(type) ? "three-columns" : "two-columns"}>
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
              onChange={(event) => setLiabilityBalanceKind(event.target.value as "owed" | "credit")}
            >
              <option value="owed">Amount owed</option>
              <option value="credit">Credit balance</option>
            </Select>
          </Field>
        ) : null}
        <Field label={liabilityAccountTypes.has(type) ? "Starting amount" : "Opening balance"}>
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
      <label className="date-bar-check">
        <input
          type="checkbox"
          checked={inBudget}
          onChange={(event) => setInBudget(event.target.checked)}
        />
        The budget is about the money in this account
      </label>
      <p className="settings-note">
        On for everything by default, cards included: spending on a card empties an envelope, so
        leaving cards out would say there is more money to assign than there is. Turn it off for
        something the budget should not see, such as a pension. It changes no balance and no report.
      </p>
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
      api<string[]>(`/api/v1/payees/suggestions?search=${encodeURIComponent(value.trim())}`),
    placeholderData: (previous) => previous,
  });
  const matching = (candidate: string) =>
    payees.data?.find(
      (suggestion) => normalizeHumanName(suggestion) === normalizeHumanName(candidate),
    );
  return (
    <>
      <Input
        autoFocus={autoFocus}
        required={required}
        list={listId}
        value={value}
        onChange={(event) => onChange(matching(event.target.value) ?? event.target.value)}
        onBlur={() => onChange(matching(value) ?? value.trim().replace(/\s+/gu, " "))}
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

/**
 * The transaction type, as one control rather than three copies of it.
 *
 * Two shapes, because there are two behaviours. A template may hold no type at
 * all, and clicking the chosen one again is how somebody says so — which a radio
 * cannot express, since a radio has no way to become unset. That shape is a group
 * of toggles reporting `aria-pressed`.
 *
 * Where a type is always set it is a real radio group, and a real radio group
 * owes the keyboard more than a row of buttons does: the group is one tab stop
 * rather than three, and the arrows move the choice inside it. These were three
 * buttons each claiming `role="radio"` with none of that, so a screen reader was
 * told to expect arrow keys that did nothing and the tab key walked through every
 * option on the way past.
 */
/**
 * The accounts a select may offer.
 *
 * Live ones, plus any archived account this record already points at, and both
 * halves matter. Offering every archived account lets somebody choose one the
 * write will refuse: the rule on the server is that an archived reference is
 * kept, never newly made, so rerouting to a closed account fails on save with
 * "One or more accounts are unavailable". Offering none of them hides the account
 * an existing record already uses, and a select whose value matches no option
 * renders blank while still holding the id — which reads as an empty required
 * field that somehow submits.
 *
 * One rule in one place because there were three, and they had already drifted:
 * two filtered archived accounts out and the third did not, so the same closed
 * account was offered on one screen and hidden on another.
 */
function selectableAccounts(accounts: Account[], ...referenced: (string | undefined)[]) {
  const kept = new Set(referenced.filter((id): id is string => Boolean(id)));
  return accounts.filter((account) => !account.archivedAt || kept.has(account.id));
}

type TransactionTypeChoiceProps =
  // Only the shape that permits no type can report one, so the two are separate
  // rather than one signature widened to fit both. A caller whose state cannot
  // hold "" is then not asked to handle it.
  | {
      allowNone: true;
      value: TransactionType | "";
      onChange: (type: TransactionType | "") => void;
    }
  | {
      allowNone?: false;
      value: TransactionType;
      onChange: (type: TransactionType) => void;
    };

function TransactionTypeChoice(props: TransactionTypeChoiceProps) {
  const { value, allowNone = false } = props;
  const onChange = props.onChange as (type: TransactionType | "") => void;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosenIndex = transactionTypeOptions.findIndex((option) => option.type === value);

  const moveTo = (index: number) => {
    const count = transactionTypeOptions.length;
    const next = ((index % count) + count) % count;
    onChange(transactionTypeOptions[next]!.type);
    // Selection follows focus, which is what a radio group does, so the focus has
    // to travel with it or the next arrow press starts from where it was.
    buttons.current[next]?.focus();
  };

  const STEPS: Record<string, number> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEPS[event.key];
    if (step) {
      event.preventDefault();
      moveTo((chosenIndex < 0 ? 0 : chosenIndex) + step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(transactionTypeOptions.length - 1);
    }
  };

  return (
    // The handler and the interactive role arrive together, both gated on the
    // same `allowNone`, so the element carrying a key handler is always a
    // radiogroup. The rule reads the two attributes separately and cannot see
    // that they agree.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="transaction-type-grid"
      role={allowNone ? "group" : "radiogroup"}
      aria-label="Transaction type"
      onKeyDown={allowNone ? undefined : onKeyDown}
    >
      {transactionTypeOptions.map((option, index) => {
        const Icon = option.icon;
        const chosen = value === option.type;
        return (
          <button
            type="button"
            key={option.type}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            className={`transaction-type ${chosen ? "selected" : ""}`}
            {...(allowNone
              ? { "aria-pressed": chosen }
              : {
                  role: "radio",
                  "aria-checked": chosen,
                  // One tab stop for the whole group: the chosen option, or the
                  // first when nothing is chosen yet.
                  tabIndex: chosen || (chosenIndex < 0 && index === 0) ? 0 : -1,
                })}
            onClick={() => onChange(allowNone && chosen ? "" : option.type)}
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
  );
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
  categoryId,
  categoryName,
  onChange,
}: {
  categories: Category[];
  categoryId: string;
  categoryName: string;
  onChange: (categoryId: string, categoryName: string) => void;
}) {
  const listId = useId();
  const compatible = useMemo(
    () =>
      // Kind no longer narrows this list. A category that runs against the
      // direction is a refund rather than a mistake, and hiding it was how the
      // picker made one impossible to enter. What it costs is that the list is
      // longer; what the filter cost was a whole shape of entry.
      categories.filter((category) => !category.archivedAt || category.id === categoryId),
    [categories, categoryId],
  );

  const normalized = normalizeHumanName(categoryName);
  // What the server will actually store. The hint below is a preview of the
  // result, so it has to be the server's own function rather than a
  // hand-rolled near-match: without the NFKC step this previewed a ligature
  // the server would not store.
  const cleaned = cleanHumanName(categoryName);
  // Deliberately every category, not just the ones matching the direction. A
  // name filed under the other side still names something that exists, and an
  // entry running against it is a refund: the server files it against that
  // category and leaves the category's kind alone. Filtering here is what made
  // a refund impossible to enter.
  const existing = categories.find((category) => normalizeHumanName(category.name) === normalized);

  return (
    <div className="category-picker">
      <Input
        list={listId}
        value={categoryName}
        onChange={(event) => {
          const next = event.target.value;
          // Matching by name keeps the spelling already in the ledger, so the
          // field shows what the entry will actually be filed under. Live
          // categories only: an archived one's id is refused by a create,
          // while its NAME revives it by design — so a typed name that only
          // an archived category answers to must travel as the name.
          const match = categories.find(
            (category) =>
              !category.archivedAt &&
              normalizeHumanName(category.name) === normalizeHumanName(next),
          );
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
  categoryId,
  categoryName,
  onCategoryChange,
  legs,
  onLegsChange,
  total,
  requireBalance = true,
}: {
  categories: Category[];
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
    formKey: nextLegKey(),
    categoryId: "",
    categoryName: "",
    amount: "",
    note: "",
  });
  const replace = (index: number, changes: Partial<TransactionFormLeg>) =>
    onLegsChange(legs.map((leg, at) => (at === index ? { ...leg, ...changes } : leg)));

  if (!legs.length) {
    return (
      <div className="category-legs">
        <CategoryPicker
          categories={categories}
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
              { id: "", formKey: nextLegKey(), categoryId, categoryName, amount: total, note: "" },
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
        <div className="category-leg" key={leg.id || leg.formKey}>
          <CategoryPicker
            categories={categories}
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
 * Whether this deployment can send mail, for the two forms that offer to send
 * some. Undefined until it is known, so neither claims anything before it is.
 *
 * A hook rather than the query written out in both places: the reminder form and
 * the recurrence form are two halves of one feature, and the first version of
 * this warned in one of them and not the other.
 */
function useNotificationsAvailable() {
  const options = useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<AuthPublicOptions>("/api/auth/methods"),
    retry: false,
  });
  return options.data ? options.data.notificationsAvailable : undefined;
}

/**
 * The dates a reminder will actually send on, the way the schedule section of a
 * recurrence previews its own.
 *
 * Seeded from the day before the anchor, which is what the scheduler does, so
 * the anchor itself is the first thing owed and the list starts where somebody
 * expects. Unlike a recurrence there is no floor: a reminder anchored in the
 * past is somebody asking to be told about something they have already missed,
 * and the sweep collapses that backlog into one message.
 */
function reminderSendDates(
  rule: TemplateNotification,
): { occurrenceDate: string; postedDate: string | null }[] {
  // A one-off owes exactly one, on its anchor, and refuses the policies that
  // could move it.
  if (rule.frequency === null) {
    return [{ occurrenceDate: rule.anchorDate, postedDate: rule.anchorDate }];
  }
  // Built out rather than spread: the contract leaves these optional, and the
  // defaults here are the ones the stored row carries, so the preview walks
  // exactly the schedule the scheduler will.
  const repeating = {
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
    anchorDate: rule.anchorDate,
    monthPolicy: rule.monthPolicy ?? "last_day",
    weekendPolicy: rule.weekendPolicy ?? "allow",
    position: rule.position ?? null,
  };
  const dates: { occurrenceDate: string; postedDate: string | null }[] = [];
  let cursor = addDays(rule.anchorDate, -1);
  try {
    for (let attempts = 0; dates.length < 5 && attempts < 60; attempts += 1) {
      const next = nextOccurrenceAfter(repeating, cursor);
      cursor = next.occurrenceDate;
      dates.push(next);
    }
  } catch {
    return [];
  }
  return dates;
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
  const timezone = useTimezone();
  // A shared `name` is what makes a set of radios one group to the browser: the
  // arrows move between them and the group is one tab stop rather than several.
  // It comes from useId so two instances of this form on one page stay separate
  // groups — a constant would merge them and choosing in one would clear the
  // other.
  const repeatGroup = useId();
  const monthDayGroup = useId();
  const source = template?.draft ?? initialDraft ?? {};
  const reminder = template?.notification ?? null;
  const [name, setName] = useState(template?.name ?? "");
  const [reminding, setReminding] = useState(reminder !== null);
  const [reminderRepeats, setReminderRepeats] = useState(reminder?.repeats ?? false);
  const [reminderFrequency, setReminderFrequency] = useState<RecurrenceFrequencyName>(
    reminder?.frequency ?? "monthly",
  );
  const [reminderInterval, setReminderInterval] = useState(String(reminder?.interval ?? 1));
  const [reminderDate, setReminderDate] = useState(
    reminder?.anchorDate ?? calendarDateInTimezone(new Date(), timezone),
  );
  const [reminderTime, setReminderTime] = useState(reminder?.time ?? "09:00");
  const [reminderMonthPolicy, setReminderMonthPolicy] = useState(
    reminder?.monthPolicy ?? "last_day",
  );
  const [reminderWeekendPolicy, setReminderWeekendPolicy] = useState(
    reminder?.weekendPolicy ?? "allow",
  );
  const [reminderByPosition, setReminderByPosition] = useState(reminder?.position != null);
  const [reminderOrdinal, setReminderOrdinal] = useState<RecurrencePosition["ordinal"]>(
    (reminder?.position?.ordinal as RecurrencePosition["ordinal"]) ?? 1,
  );
  const [reminderWeekday, setReminderWeekday] = useState(reminder?.position?.weekday ?? 1);
  const notificationsAvailable = useNotificationsAvailable();
  const reminderPositional = reminderFrequency === "monthly" || reminderFrequency === "yearly";
  const reminderUsesPosition = reminderPositional && reminderByPosition;
  // The server's own contract rather than a second copy of it here, the same way
  // the recurrence form checks its schedule: a form that validates its own
  // fields is a weaker rule that disagrees at the edges.
  // Built once and checked once. It used to be written out twice — once here to
  // validate and once in the mutation to submit — so the two could drift and what
  // was sent was never the object that had been checked.
  const reminderInput = reminding
    ? {
        frequency: reminderRepeats ? reminderFrequency : null,
        ...(reminderRepeats
          ? {
              interval: reminderInterval.trim() === "" ? 1 : Number(reminderInterval),
              monthPolicy: reminderMonthPolicy,
              weekendPolicy: reminderWeekendPolicy,
              position: reminderUsesPosition
                ? { ordinal: reminderOrdinal, weekday: reminderWeekday }
                : null,
            }
          : {}),
        anchorDate: reminderDate,
        time: reminderTime,
      }
    : null;
  const parsedReminder = reminderInput ? templateNotificationSchema.safeParse(reminderInput) : null;
  // A daily reminder of one or two days moved on to a business day would land two
  // occurrences on one date, which the shared contract refuses. The recurrence
  // form disables the two options rather than letting somebody pick a refusal.
  const reminderBusinessDayBlocked =
    reminderRepeats &&
    reminderFrequency === "daily" &&
    !(Number.isInteger(Number(reminderInterval)) && Number(reminderInterval) >= 3);
  const [type, setType] = useState<TransactionType | "">(source.type ?? "");
  const [date, setDate] = useState(source.date ?? "");
  const [payee, setPayee] = useState(source.payee ?? "");
  const [fromAccountId, setFromAccountId] = useState(source.fromAccountId ?? "");
  const [toAccountId, setToAccountId] = useState(source.toAccountId ?? "");
  const [amount, setAmount] = useState(source.amount ?? "");
  const [destinationAmount, setDestinationAmount] = useState(source.destinationAmount ?? "");
  const [categoryId, setCategoryId] = useState(source.categoryId ?? "");
  const [categoryName, setCategoryName] = useState(
    categories.find((category) => category.id === source.categoryId)?.name ??
      source.categoryName ??
      "",
  );
  const [legs, setLegs] = useState<TransactionFormLeg[]>(() =>
    (source.legs ?? []).map((leg) => ({
      id: "",
      formKey: nextLegKey(),
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

  // The same rule the transaction form applies. Only a transfer clears the
  // category now: it files under none at all. A deposit or a withdrawal keeps
  // whatever was chosen, because a category running against the direction is a
  // refund and clearing it would delete the very thing somebody selected.
  useEffect(() => {
    if (categoryId && type === "transfer") {
      // A change to what is stored, not a value derived from the type. Derived,
      // switching to Transfer and back would hand the category back, and the
      // draft would go on carrying one the form has stopped showing.
      // oxlint-disable-next-line react/set-state-in-effect
      setCategoryId("");
      setCategoryName("");
    }
  }, [categoryId, type]);

  // Clearing the interval to retype it must not leave a now-blocked policy
  // selected, which would be a refusal nobody could see the cause of.
  useEffect(() => {
    if (reminderBusinessDayBlocked && reminderWeekendPolicy.endsWith("business_day")) {
      // Stored for the same reason. Once the interval that forbade the policy is
      // gone the choice stays where this put it, which is what makes the note
      // explaining the reset true; a derivation would quietly restore it.
      // oxlint-disable-next-line react/set-state-in-effect
      setReminderWeekendPolicy("allow");
    }
  }, [reminderBusinessDayBlocked, reminderWeekendPolicy]);

  // Worked out during render rather than memoised. The only honest dependency
  // is the parse result, which `safeParse` rebuilds every render, so a
  // `useMemo` keyed on it would never hit - and this one got around that by
  // stringifying the parsed rule, which costs more than the five dates it was
  // saving. Keying on the fields instead is the alternative that looks cheaper
  // and is not: it is what the recurrence preview did, and it went stale.
  const reminderPreview = parsedReminder?.success ? reminderSendDates(parsedReminder.data) : [];

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
      // Only a transfer has a received side. Without this line the form
      // rebuilt the draft from what it showed and silently erased the
      // destination amount of a cross-currency transfer template every time
      // anything else about it was saved — a field the MCP surface could set
      // and the browser then lost, which is the parity defect one level down.
      if (type === "transfer") keep("destinationAmount", destinationAmount);
      // Legs and a single category cannot both be stored, so whichever side the
      // form is showing is the one that is saved. A template leg may name only
      // a category: its amount is filled in when the template is used.
      const kept = legs.filter(
        (leg) => leg.categoryId || leg.categoryName.trim() || leg.amount.trim(),
      );
      // Never for a transfer, so legs left behind by switching type are not sent
      // for a type that cannot hold them. A template with no type at all keeps
      // them, because it has not said it is a transfer.
      if (type !== "transfer" && kept.length >= 2) {
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
      const body = { name: name.trim(), draft, notification: reminderInput };
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

  const accountOptions = selectableAccounts(accounts, fromAccountId, toAccountId);
  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        // A reminder the shared contract refuses is not submitted, so the
        // refusal shows beside the field rather than as a server error naming a
        // rule the form was offering.
        if (name.trim() && parsedReminder?.success !== false) mutation.mutate();
      }}
    >
      <ErrorSummary error={mutation.error} />
      <RequiredNote />
      <Field label="Template name" hint="What you will pick it out by later.">
        <Input
          autoFocus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Weekly shop"
        />
      </Field>

      {/* Clicking the chosen one again unsaves it, which is how a template holds
          no type at all — so these are toggles, not radios. */}
      <TransactionTypeChoice allowNone value={type} onChange={setType} />
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
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
      </div>

      {type !== "deposit" ? (
        <Field label={type === "transfer" ? "From account" : "Account"}>
          <Select value={fromAccountId} onChange={(event) => setFromAccountId(event.target.value)}>
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
          <Select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
            <option value="">Leave blank</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.currency}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="Amount" hint="Leave blank when it differs every time.">
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
        />
      </Field>

      {type === "transfer" ? (
        <Field
          label="Amount received"
          hint="For a transfer between currencies: what arrives on the other side. Leave blank when both accounts share a currency, or to fill it in each time."
        >
          <Input
            inputMode="decimal"
            value={destinationAmount}
            onChange={(event) => setDestinationAmount(event.target.value)}
            placeholder="0.00"
            pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
          />
        </Field>
      ) : null}

      {type === "transfer" ? null : (
        <Field label="Category" hint="Optional">
          <CategoryLegs
            categories={categories}
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

      <fieldset className="form-fieldset">
        <legend>Reminder</legend>
        <label className="check-label">
          <input
            type="checkbox"
            checked={reminding}
            disabled={mutation.isPending}
            onChange={(event) => setReminding(event.target.checked)}
          />
          Email me to make this transaction
        </label>
        {/* Directly under the checkbox it explains. It used to sit at the very
            bottom, after every schedule field, where it read as a footnote to
            the weekend policy rather than as what the setting above does. */}
        <p className="settings-note">
          A reminder only asks. It never records anything, because a template is something you fill
          in yourself.
        </p>

        {reminding ? (
          <>
            <div className="radio-row" role="radiogroup" aria-label="How often">
              <label className="check-label">
                <input
                  type="radio"
                  name={repeatGroup}
                  checked={!reminderRepeats}
                  onChange={() => setReminderRepeats(false)}
                />
                Once
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  name={repeatGroup}
                  checked={reminderRepeats}
                  onChange={() => setReminderRepeats(true)}
                />
                Repeatedly
              </label>
            </div>

            {reminderRepeats ? (
              <div className="two-columns">
                <Field label="Repeats">
                  <Select
                    value={reminderFrequency}
                    onChange={(event) =>
                      setReminderFrequency(event.target.value as RecurrenceFrequencyName)
                    }
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </Select>
                </Field>
                <Field
                  label={`Every N ${FREQUENCY_UNITS[reminderFrequency]}s`}
                  hint="1 means every one."
                >
                  <Input
                    type="number"
                    min={1}
                    max={366}
                    value={reminderInterval}
                    onChange={(event) => setReminderInterval(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            <div className="two-columns">
              <Field
                label={reminderRepeats ? "Starting" : "Send on"}
                hint={
                  reminderRepeats
                    ? "The first date, and the one every later date is counted from."
                    : "The day to send it."
                }
              >
                <Input
                  type="date"
                  required
                  value={reminderDate}
                  onChange={(event) => setReminderDate(event.target.value)}
                />
              </Field>
              <Field label="Send at" hint="Your own clock, not the server's.">
                <Input
                  type="time"
                  required
                  value={reminderTime}
                  onChange={(event) => setReminderTime(event.target.value)}
                />
              </Field>
            </div>

            {reminderRepeats && reminderPositional ? (
              <>
                <div
                  className="radio-row"
                  role="radiogroup"
                  aria-label="Day of the month to remind on"
                >
                  <label className="check-label">
                    <input
                      type="radio"
                      name={monthDayGroup}
                      checked={!reminderByPosition}
                      onChange={() => setReminderByPosition(false)}
                    />
                    On day {Number(reminderDate.slice(8, 10)) || 1} of the month
                  </label>
                  <label className="check-label">
                    <input
                      type="radio"
                      name={monthDayGroup}
                      checked={reminderByPosition}
                      onChange={() => setReminderByPosition(true)}
                    />
                    On a relative day
                  </label>
                </div>
                {reminderByPosition ? (
                  <div className="two-columns">
                    <Field label="Which one to remind on">
                      <Select
                        value={String(reminderOrdinal)}
                        onChange={(event) =>
                          setReminderOrdinal(
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
                    <Field label="Day to remind on">
                      <Select
                        value={String(reminderWeekday)}
                        onChange={(event) => setReminderWeekday(Number(event.target.value))}
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
                      value={reminderMonthPolicy}
                      onChange={(event) =>
                        setReminderMonthPolicy(event.target.value as Recurrence["monthPolicy"])
                      }
                    >
                      <option value="last_day">Use the last day of that month</option>
                      <option value="skip">Skip that month</option>
                    </Select>
                  </Field>
                )}
              </>
            ) : null}

            {reminderRepeats ? (
              <Field
                label="When it lands on a weekend"
                hint="A business day here means Monday to Friday. Public holidays are not modelled."
              >
                <Select
                  value={reminderWeekendPolicy}
                  onChange={(event) =>
                    setReminderWeekendPolicy(event.target.value as Recurrence["weekendPolicy"])
                  }
                >
                  <option value="allow">Send it on the weekend</option>
                  <option value="skip">Skip it</option>
                  <option value="previous_business_day" disabled={reminderBusinessDayBlocked}>
                    Send it on the Friday
                  </option>
                  <option value="next_business_day" disabled={reminderBusinessDayBlocked}>
                    Send it on the Monday
                  </option>
                </Select>
              </Field>
            ) : null}
            {reminderBusinessDayBlocked ? (
              <p className="settings-note">
                A daily reminder of one or two days moved on to a business day would land two on the
                same date. Make the interval three days or more to use those two.
              </p>
            ) : null}

            {reminderPreview.length ? (
              <div className="recurrence-preview">
                <span className="recurrence-preview-label">
                  {reminderRepeats ? "Next five" : "Sends on"}
                </span>
                <ul>
                  {reminderPreview.map((one) => (
                    <li key={one.occurrenceDate}>
                      {one.postedDate ? (
                        <>
                          {formatDate(one.postedDate)} at {reminderTime}
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
            {parsedReminder && !parsedReminder.success ? (
              <Alert>{parsedReminder.error.issues[0]!.message}</Alert>
            ) : null}
            {notificationsAvailable === false ? (
              <Alert kind="info">
                This deployment has no mail server configured, so the reminder will be saved and
                nothing will be sent until one is.
              </Alert>
            ) : null}
          </>
        ) : null}
      </fieldset>

      {categoryName.trim() && !categoryId ? (
        <Alert kind="info">
          “{categoryName.trim()}” is saved as a name rather than a category you already have, and is
          matched when you use the template. If nothing matches then, it is created.
        </Alert>
      ) : null}

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
          ? (accounts.find((account) => account.id !== primaryAccountId)?.id ?? "")
          : primaryAccountId,
    };
  };
  const initialFormType = initial?.type ?? createType;
  const initialAccountIds = defaultAccountIds(initialFormType);
  const [type, setType] = useState<TransactionType>(initialFormType);
  const [date, setDate] = useState(initial?.date ?? calendarDateInTimezone(new Date(), timezone));
  const [description, setDescription] = useState(initial?.description ?? "");
  const [payee, setPayee] = useState(initial?.payee ?? initialPayee ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? initialCategoryId ?? "");
  const [categoryName, setCategoryName] = useState(
    () =>
      categories.find(
        (category) => category.id === (initial?.categoryId ?? initialCategoryId ?? ""),
      )?.name ??
      // The name the draft carried, for a row filed by name and no id. Falling
      // through to "" wrote null over it on the next save, and the row then
      // committed uncategorised.
      initial?.categoryName ??
      "",
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
  const [destinationAmount, setDestinationAmount] = useState(initial?.destinationAmount ?? "");
  const [mode, setMode] = useState<"commit" | "stage">(initialMode);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  const [resetAfterSave, setResetAfterSave] = useState(false);
  const [categoryPickerVersion, setCategoryPickerVersion] = useState(0);
  /**
   * Which kind a category named here should be created as.
   *
   * Only ever consulted for a name this ledger does not have yet, and only for
   * a deposit or a withdrawal. Empty means "whatever the direction implies",
   * which is what the server does on its own; setting it is how somebody says
   * this deposit is a refund of spending rather than income, in one step, on
   * the entry that is establishing the category.
   *
   * Without it the browser could file a refund against a category that already
   * existed but could not create one, so a refund into a brand new spending
   * category was the one entry the MCP could record and this form could not.
   */
  const [categoryKind, setCategoryKind] = useState<CategoryKind | "">("");
  const categoryKindGroup = useId();
  const [repeatNotice, setRepeatNotice] = useState("");

  const modeGroup = useId();
  // Every account except a closed one, and a closed one this transaction already
  // points at — which an edit must keep offering or saving it would reroute the
  // entry somewhere else. This select used to offer all of them, including closed
  // accounts nothing referenced, and the write refuses those.
  const accountOptions = selectableAccounts(accounts, fromAccountId, toAccountId);
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
        (category) => category.id === (initial?.categoryId ?? initialCategoryId ?? ""),
      )?.name ??
      initial?.categoryName ??
      "",
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
  // Seeding state from a query that had not resolved at mount, which is the one
  // copy `docs/standards/code/client.md` §1.1 allows. The defaults above read
  // `accounts[0]` while the list is still empty, so without this the form opens
  // on a fresh session with no account chosen and the select showing nothing.
  // Only ever fills a blank: from here the field is the person's to change.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (!fromAccountId && accounts[0]) setFromAccountId(accounts[0].id);
    if (!toAccountId && accounts[0]) setToAccountId(accounts[0].id);
  }, [accounts, fromAccountId, toAccountId]);

  // Only a transfer clears the category, because only a transfer files under
  // none. Against-the-direction is a refund, not a mismatch.
  useEffect(() => {
    if (categoryId && type === "transfer") {
      // The template form's twin, and stored for the same reason: derived, the
      // category would come back on switching away from Transfer, and the save
      // that followed would file the entry under one the form had already
      // forgotten. Nothing reads it while the type is Transfer - the picker is
      // not rendered and the submit carries `initial`'s category through - so
      // the clear is only ever about what comes back afterwards.
      // oxlint-disable-next-line react/set-state-in-effect
      setCategoryId("");
      setCategoryName("");
    }
  }, [categoryId, type]);

  // Both options are named after the direction, so a choice made under one type
  // does not carry to another: "a refund of money you spent" is not on offer
  // for a withdrawal, and leaving the state set would go on sending expense on
  // an entry whose form never said so.
  useEffect(() => {
    // Every route into a new type resets it - the picker, a template being
    // applied, the reset after saving another - so this belongs on the change
    // rather than in the one handler somebody would remember to update. The
    // choice itself has to survive every render where the type has not moved,
    // which is what stops it being derived.
    // oxlint-disable-next-line react/set-state-in-effect
    setCategoryKind("");
  }, [type]);

  /**
   * The name the picker shows, for a category chosen somewhere other than this
   * field - editing an existing transaction, or a link that prefills one.
   *
   * Worked out during render rather than copied into the state behind the field,
   * because an id and a name are not two facts to keep in step: while an id is
   * set the category list decides the name, and typing clears the id in the same
   * change, so the typed text takes over the moment there is no id. As state it
   * was a copy that lagged the categories query by a render, and the effect that
   * kept it up to date could not name the state it read without re-running on
   * every keystroke.
   *
   * Only the field needs it, and everywhere else the two already agree. The
   * submit sends a name only when `categoryId` is empty. `namedKinds` below
   * carries the name alongside the id but resolves by id first, and only falls
   * back to the name when the id names nothing this list has - which is the
   * same case this derivation falls back in.
   */
  const shownCategoryName =
    (categoryId ? categories.find((category) => category.id === categoryId)?.name : undefined) ??
    categoryName;

  const source = accounts.find((account) => account.id === fromAccountId);
  const destination = accounts.find((account) => account.id === toAccountId);
  const crossCurrency =
    type === "transfer" && source && destination && source.currency !== destination.currency;
  // A transfer has no counter-account side to partition, so its legs are never
  // sent even if switching type left some behind in the form.
  const splitting = type !== "transfer" && legs.length >= 2;
  // Whether the picker is on screen, which is not the same question as whether
  // the entry may carry a category. A transfer may carry one — it has no
  // counter-account side to file, so nothing shows it — and clearing what is
  // stored just because the form does not render it destroys a category on an
  // edit that never touched it.
  const showsCategoryPicker = !splitting && type !== "transfer";
  const splitSettled =
    !splitting ||
    moneyRemainder(
      amount,
      legs.map((leg) => leg.amount || "0"),
    ) === "0";

  /**
   * The side of the books this entry will land on, previewed.
   *
   * `AGENTS.md` says the browser previews this rule and the services enforce
   * it, and for a while only the second half was true: the form happily offered
   * a split with one income leg and one expense leg, which the server refuses
   * with a 422 nobody could have predicted from the screen. One function, so
   * the sentence here is the sentence the service would have thrown.
   */
  /**
   * Every category this entry will actually be filed under.
   *
   * Which ones those are depends on whether it is a split, and it has to be
   * the same set the submit handler sends: a split sends its legs and drops
   * the single picker, and one that is not a split does the reverse. Reading
   * both at once let a name left behind in the single picker by switching to a
   * split still count towards the preview below.
   */
  const namedCategories = splitting
    ? legs.map((leg) => ({ id: leg.categoryId, name: leg.categoryName }))
    : [{ id: categoryId, name: categoryName }];

  /**
   * What each of those is, as far as the form can tell.
   *
   * By id first, then by name, because a name that matches a category this
   * ledger already has names that category whether or not an id came with it.
   * Matching on id alone read a staged draft's category name — which arrives
   * without one — as a category about to be created.
   */
  const namedKinds = namedCategories.map(({ id, name }) => {
    const known =
      categories.find((category) => category.id === id) ??
      (name.trim()
        ? categories.find(
            (category) => normalizeHumanName(category.name) === normalizeHumanName(name),
          )
        : undefined);
    if (known) return { kind: known.kind, existing: true, name };
    if (name.trim()) return { kind: undefined, existing: false, name };
    return { kind: undefined, existing: true, name };
  });

  // Names with no category behind them yet, which is the only case where the
  // choice below has anything to decide.
  const newCategoryNames = namedKinds
    .filter((entry) => !entry.existing)
    .map((entry) => entry.name.trim());

  // The kind a name with nothing behind it will be created as: what was chosen
  // if anything was, and the entry's own direction otherwise, which is what the
  // server falls back to.
  const newCategoryKind: CategoryKind = categoryKind || (type === "deposit" ? "income" : "expense");

  const entrySide =
    type === "transfer"
      ? null
      : resolveEntrySide(
          type,
          namedKinds
            // A name with no category behind it yet will be created by the
            // server under the kind chosen below, so it counts as that kind.
            // Leaving it out made the form approve a split naming an existing
            // income category and a new one, which the server then refused with
            // a 422 the screen had not predicted.
            .map((entry) => entry.kind ?? (entry.existing ? undefined : newCategoryKind))
            .filter((kind): kind is CategoryKind => Boolean(kind)),
        );
  const entrySideError = entrySide && !entrySide.ok ? entrySide.message : "";

  /**
   * Forget a received amount that says nothing, and only that one.
   *
   * A same-currency transfer must balance, so its received amount is always a
   * copy of the sent amount: it carries no rate, and revealing it on a new
   * cross-currency pair would submit a rate nobody typed. One that differs from
   * the sent amount is a real rate — a staged row restored from a CSV carries
   * 100.00 out and 92.00 in before either account has been picked — and
   * clearing that would destroy the only copy of it in the app.
   *
   * Cleared on the account change rather than in an effect on `crossCurrency`,
   * because that flag is also false while the account list is still loading and
   * an effect would wipe a stored amount on a transient render. Here the list is
   * known to be populated: somebody just chose from it.
   */
  const forgetEchoedReceivedAmount = () => {
    if (!destinationAmount) return;
    if (compareMoney(destinationAmount, amount) === 0) setDestinationAmount("");
  };

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
    setCategoryName(categories.find((category) => category.id === initialCategoryId)?.name ?? "");
    // The kind chosen for a brand-new category is about the entry that named
    // it, never the next one: left standing, the next entry's new category
    // silently defaulted to the refund direction somebody chose last time.
    setCategoryKind("");
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
      // Every kind fits a deposit or a withdrawal now, one of them as a refund.
      // A transfer fits none, because it files under no category.
      return nextType === "transfer" ? undefined : category;
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
            formKey: nextLegKey(),
            categoryId: category?.id ?? "",
            categoryName: category?.name ?? (leg.categoryId ? "" : (leg.categoryName ?? "")),
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
    } else if (previous.has("categoryId") || previous.has("categoryName") || previous.has("legs")) {
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
        // A split says which categories the money went to, one per leg, so the
        // single category goes out cleared rather than alongside them. A
        // transfer keeps whatever it arrived with, carried through the way
        // externalId and templateId are: the picker is not rendered for one, and
        // "not shown" is not a reason to erase it.
        //
        // Switching the type to Transfer therefore also stops a name typed into
        // a picker that is now gone from creating a category on save.
        categoryId: splitting
          ? null
          : showsCategoryPicker
            ? categoryId || null
            : initial?.categoryId || null,
        // Only when the field did not settle on one this ledger already has.
        // The server matches it case-insensitively and creates it only if it
        // is genuinely new.
        categoryName: splitting
          ? null
          : showsCategoryPicker
            ? categoryId
              ? null
              : categoryName.trim() || null
            : initial?.categoryId
              ? null
              : initial?.categoryName || null,
        // Only ever about a name with nothing behind it, so it is sent only
        // when one is in play and somebody chose against the direction. The
        // server ignores it otherwise, but sending it regardless would put a
        // field in the audit trail that decided nothing.
        ...(categoryKind && newCategoryNames.length > 0 ? { categoryKind } : {}),
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
                // Only when the field that sets it is on screen. Between two
                // accounts in one currency there is no received amount to
                // state, and sending the one left in state made every edit of
                // the sent amount fail the zero-sum check against a number
                // nothing could reach.
                ...(crossCurrency && destinationAmount ? { destinationAmount } : {}),
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
        queryClient.invalidateQueries({ queryKey: ["budgets"] }),
        queryClient.invalidateQueries({ queryKey: ["forecast"] }),
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
      <ErrorSummary error={mutation.error}>
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
      </ErrorSummary>
      <RequiredNote />
      {templates.data?.length ? (
        <Field
          label="Start from a template"
          hint="Optional. Anything you change here stays here; the template is not touched."
        >
          <Select
            value={selectedTemplateId}
            onChange={(event) =>
              applyTemplate(templates.data?.find((entry) => entry.id === event.target.value))
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
      <TransactionTypeChoice
        value={type}
        onChange={(next) => {
          setType(next);
          if (transaction || staged || !next) return;
          const primaryAccountId = initialAccountId ?? accounts[0]?.id ?? "";
          if (next === "withdrawal") {
            setFromAccountId(primaryAccountId);
          } else if (next === "deposit") {
            setToAccountId(primaryAccountId);
          } else {
            setFromAccountId(primaryAccountId);
            setToAccountId(accounts.find((account) => account.id !== primaryAccountId)?.id ?? "");
          }
        }}
      />
      <div className="two-columns">
        <Field label="Date">
          <Input
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>
        <Field label="Payee">
          {/* The component, not a copy of it: PayeeInput's own comment says a
              second copy would be a second answer to "what counts as the same
              payee", and this form carried that second copy byte for byte. */}
          <PayeeInput autoFocus required value={payee} onChange={setPayee} />
        </Field>
      </div>
      {type !== "deposit" ? (
        <Field label={type === "transfer" ? "From account" : "Account"}>
          <Select
            required
            value={fromAccountId}
            onChange={(event) => {
              setFromAccountId(event.target.value);
              forgetEchoedReceivedAmount();
            }}
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
            onChange={(event) => {
              setToAccountId(event.target.value);
              forgetEchoedReceivedAmount();
            }}
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
            categoryId={categoryId ?? ""}
            categoryName={shownCategoryName}
            onCategoryChange={(nextId, nextName) => {
              setCategoryId(nextId);
              setCategoryName(nextName);
            }}
            legs={legs}
            onLegsChange={setLegs}
            total={amount}
          />
          {newCategoryNames.length > 0 ? (
            <div
              className="radio-row"
              role="radiogroup"
              aria-label={
                newCategoryNames.length === 1
                  ? `What kind of category ${newCategoryNames[0]} is`
                  : "What kind of category these are"
              }
            >
              <label className="check-label">
                <input
                  type="radio"
                  name={categoryKindGroup}
                  checked={newCategoryKind === (type === "deposit" ? "income" : "expense")}
                  onChange={() => setCategoryKind("")}
                />
                {type === "deposit" ? "Money you earned" : "Money you spent"}
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  name={categoryKindGroup}
                  checked={newCategoryKind === (type === "deposit" ? "expense" : "income")}
                  onChange={() => setCategoryKind(type === "deposit" ? "expense" : "income")}
                />
                {type === "deposit"
                  ? "A refund of money you spent"
                  : "Paying back money you earned"}
              </label>
            </div>
          ) : null}
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
                name={modeGroup}
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
                name={modeGroup}
                checked={mode === "stage"}
                onChange={() => setMode("stage")}
              />
              <span>
                <strong>Stage for review</strong>
                <small>Keep it out of balances until approved</small>
              </span>
            </label>
          </fieldset>
          <fieldset className="repeat-entry-options" aria-label="Repeat transaction entry">
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
      {entrySideError ? <Alert kind="error">{entrySideError}</Alert> : null}
      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          loading={mutation.isPending}
          disabled={!splitSettled || Boolean(entrySideError)}
        >
          {transaction || staged
            ? "Save changes"
            : mode === "stage"
              ? "Stage transaction"
              : "Commit transaction"}
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
  const every = schedule.interval === 1 ? `Every ${unit}` : `Every ${schedule.interval} ${unit}s`;
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
 * The next five dates a recurrence will actually propose on.
 *
 * The floor is the scheduler's own: it proposes nothing dated before the day the
 * recurrence may first reach back to, so a policy that moves an occurrence
 * backwards over that line produces no row. Showing it here would promise a date
 * no tick will ever write.
 */
function recurrenceProposalDates(
  rule: RecurrenceSchedule,
  watermark: { proposesFrom: string; lastOccurrenceDate: string | null },
): { occurrenceDate: string; postedDate: string | null }[] {
  const dates: { occurrenceDate: string; postedDate: string | null }[] = [];
  let cursor = scheduleCursor(watermark);
  try {
    for (let attempts = 0; dates.length < 5 && attempts < 60; attempts += 1) {
      const next = nextOccurrenceAfter(rule, cursor);
      cursor = next.occurrenceDate;
      // A skipped occurrence stays: the list says so, and "your 31st schedule
      // skips February" is worth seeing. Only a date the floor will swallow is
      // dropped, because that one is a promise no tick will keep.
      if (!proposalFloorSwallows(next.postedDate, watermark.proposesFrom)) dates.push(next);
    }
  } catch {
    return [];
  }
  return dates;
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
  initialShape,
  initialAnchorDate,
  onDone,
}: {
  accounts: Account[];
  categories: Category[];
  recurrence?: Recurrence;
  initialShape?: RecurrenceShapeSeed;
  initialAnchorDate?: string;
  onDone: () => void;
}) {
  const timezone = useTimezone();
  // A shared `name` is what makes a set of radios one group to the browser: the
  // arrows move between them and the group is one tab stop rather than several.
  // It comes from useId so two instances of this form on one page stay separate
  // groups — a constant would merge them and choosing in one would clear the
  // other.
  const monthDayGroup = useId();
  const today = calendarDateInTimezone(new Date(), timezone);
  const shape = recurrence?.shape ?? initialShape;
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
  // The received side of a cross-currency transfer, which the schema has
  // accepted since 0.1.4 and this form did not offer. An agent could pin it and
  // a person could not, which is the parity defect `AGENTS.md` names, and the
  // form argued the opposite in an alert: that the amount received is not
  // something a schedule can know. Both are true — usually it cannot, and a
  // standing order at an agreed rate can — so the field is here and optional,
  // and the alert says what leaving it blank does.
  const [destinationAmount, setDestinationAmount] = useState(
    (shape && "destinationAmount" in shape ? (shape.destinationAmount ?? "") : "") || "",
  );
  const [categoryId, setCategoryId] = useState(shape?.categoryId ?? "");
  const [categoryKind, setCategoryKind] = useState<CategoryKind | "">("");
  const categoryKindGroup = useId();
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
      formKey: nextLegKey(),
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
  // A row's own date, when it seeds one. The anchor is what fixes the day of
  // the month and the weekday a schedule repeats on, so rent paid on the 1st
  // anchored to whatever today happens to be would quietly become a schedule
  // for a different day, agreeing with itself in the preview.
  const [anchorDate, setAnchorDate] = useState(
    recurrence?.anchorDate ?? (initialAnchorDate || today),
  );
  const [monthPolicy, setMonthPolicy] = useState(recurrence?.monthPolicy ?? "last_day");
  const [weekendPolicy, setWeekendPolicy] = useState(recurrence?.weekendPolicy ?? "allow");
  const [byPosition, setByPosition] = useState(recurrence?.positionOrdinal != null);
  const [ordinal, setOrdinal] = useState<RecurrencePosition["ordinal"]>(
    (recurrence?.positionOrdinal as RecurrencePosition["ordinal"]) ?? 1,
  );
  const [weekday, setWeekday] = useState(recurrence?.positionWeekday ?? 1);
  const [notifyOnCreate, setNotifyOnCreate] = useState(recurrence?.notifyOnCreate ?? false);
  const notificationsAvailable = useNotificationsAvailable();
  const queryClient = useQueryClient();

  const positional = frequency === "monthly" || frequency === "yearly";
  const usesPosition = positional && byPosition;
  // The whole schedule through the contract the server parses, rather than one
  // field at a time. A form that checks its own fields is a second, weaker copy
  // of that contract: `Number(interval) || 1` admitted -1, which is a schedule
  // whose occurrences never advance and a preview that never returns.
  const parsedSchedule = recurrenceScheduleSchema.safeParse({
    frequency,
    interval: interval.trim() === "" ? 1 : Number(interval),
    anchorDate,
    monthPolicy,
    weekendPolicy,
    position: usesPosition ? { ordinal, weekday } : null,
  });
  const intervalNumber =
    Number.isInteger(Number(interval)) && Number(interval) >= 1 ? Number(interval) : null;
  // A weekend policy moves a date up to two days, so a daily schedule of one
  // or two days can put two occurrences on one date. The queue refuses to
  // commit rows that alike, so the server refuses the combination outright.
  // Disabling it here says so before the refusal does.
  //
  // An interval that cannot be read yet counts as blocked rather than allowed:
  // clearing the field to retype it would otherwise unlock the two options and
  // take away the note explaining them, and typing 1 back would silently reset
  // whichever one had been picked.
  const businessDayBlocked =
    frequency === "daily" && (intervalNumber === null || intervalNumber <= 2);

  useEffect(() => {
    if (businessDayBlocked && weekendPolicy.endsWith("business_day")) {
      // The reminder form's twin, and stored for the same reason: the reset has
      // to hold once the interval that forbade the policy is gone, or typing 3
      // back would silently return a schedule nobody asked for a second time.
      // oxlint-disable-next-line react/set-state-in-effect
      setWeekendPolicy("allow");
    }
  }, [businessDayBlocked, weekendPolicy]);

  // The same rule the transaction form applies. A category that cannot cover
  // this kind of entry is refused once per occurrence, at commit, rather than
  // here, so carrying one over would produce a queue of rows nobody can commit
  // and no explanation of why.
  useEffect(() => {
    // Only the two types that file an entry under a category. A transfer keeps
    // whatever it arrived with, the way the transaction form and a CSV round
    // trip do: the picker is hidden for a transfer rather than emptied, so
    // clearing here would delete a category somebody chose on purpose, and on
    // the edit path it would delete one already saved.
    // An archived category is refused on every occurrence, at commit, whatever
    // the type. A row filed under one still shows its name, and the picker
    // keeps a category that is already selected, so seeded it reads exactly
    // like a live one and nothing would say otherwise until the queue did,
    // once per proposal, forever.
    //
    // Kind is the type's own rule and only the two that file under a category
    // have one. A transfer keeps whatever it arrived with, the way the
    // transaction form and a CSV round trip do: its picker is hidden rather
    // than emptied, so clearing on kind would delete a category somebody chose
    // on purpose, and on the edit path one already saved.
    const usable = (category: Category) => !category.archivedAt;
    const selected = categories.find((category) => category.id === categoryId);
    if (selected && !usable(selected)) {
      // Synchronising with the categories query: archiving happens on another
      // page and arrives here on a refetch. Cleared rather than derived because
      // somebody now has to choose again, and a name derived away on render
      // would leave the field looking merely empty on the next save.
      // oxlint-disable-next-line react/set-state-in-effect
      setCategoryId("");
      setCategoryName("");
    }
    // A split's legs each carry their own category and are refused at commit
    // exactly as the single one is.
    const keptLegs = legs.map((leg) => {
      const legCategory = categories.find((one) => one.id === leg.categoryId);
      return legCategory && !usable(legCategory)
        ? { ...leg, categoryId: "", categoryName: "" }
        : leg;
    });
    if (keptLegs.some((leg, index) => leg !== legs[index])) setLegs(keptLegs);
  }, [categories, categoryId, legs, type]);

  // The watermark the scheduler will seek from, not one derived from the anchor.
  // A positioned rule's first occurrence can fall earlier in the anchor's month,
  // so seeding from the anchor previewed a first date the scheduler would skip
  // straight past.
  const previewWatermark = recurrence
    ? { proposesFrom: recurrence.proposesFrom, lastOccurrenceDate: recurrence.lastOccurrenceDate }
    : { proposesFrom: today, lastOccurrenceDate: null };
  // Worked out during render rather than memoised, for the reason the reminder
  // preview is. The dependency array named the fields the schedule is built from
  // rather than the parse result it reads, and those are not the same set:
  // `intervalNumber` is null for an interval of "abc" and null again for a blank
  // field, while only the blank one parses, so typing over either with the other
  // left whichever list was already on screen.
  const preview = parsedSchedule.success
    ? recurrenceProposalDates(parsedSchedule.data, previewWatermark)
    : [];

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
          ...(crossCurrency && trimmed(destinationAmount)
            ? { destinationAmount: trimmed(destinationAmount) }
            : {}),
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
          // Only where it decides something: a name that already exists keeps
          // the kind it has, so sending one there would be noise.
          ...(categoryKind && newCategoryNames.length > 0 ? { categoryKind } : {}),
        },
        schedule: parsedSchedule.data,
        notifyOnCreate,
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

  const accountOptions = selectableAccounts(accounts, fromAccountId, toAccountId);
  const accountReady = type === "deposit" ? toAccountId : fromAccountId;
  const transferReady = type !== "transfer" || (fromAccountId && toAccountId);
  // A rate belongs to the day it was got, so a recurrence does not keep one.
  // The received amount is the one field a proposal cannot carry, and saying so
  // here beats a queue of rows refused for a reason stated once per row.
  const sendingAccount = accounts.find((account) => account.id === fromAccountId);
  const receivingAccount = accounts.find((account) => account.id === toAccountId);
  // Both have to be found. An archived account is not in this list, and
  // comparing what two misses returned made a genuinely mixed pair look like a
  // matched one, while one miss made a matched pair look mixed.
  const crossCurrency =
    type === "transfer" &&
    Boolean(sendingAccount) &&
    Boolean(receivingAccount) &&
    sendingAccount!.currency !== receivingAccount!.currency;
  // A recurrence's legs are required and must add up, unlike a template's,
  // because the same division is replayed on every occurrence: one that does
  // not balance proposes a row nobody can commit, over and over.
  const splitting = type !== "transfer" && legs.length >= 2;
  /**
   * Category names this ledger does not have yet, and what kind to make them.
   *
   * The same question `TransactionForm` asks, for the same reason and with the
   * same words: a recurring refund into a spending category nobody has created
   * yet would otherwise be filed as income, once a month, for ever. The schema
   * has carried `categoryKind` since the refund work; only this form did not
   * ask, so an agent could set it and a person could not.
   */
  const namedForKind = splitting
    ? legs.map((leg) => ({ id: leg.categoryId, name: leg.categoryName }))
    : [{ id: categoryId, name: categoryName }];
  const newCategoryNames = namedForKind
    .filter(({ id, name }) => {
      if (!name.trim()) return false;
      const known =
        categories.find((category) => category.id === id) ??
        categories.find(
          (category) => normalizeHumanName(category.name) === normalizeHumanName(name),
        );
      return !known;
    })
    .map(({ name }) => name.trim());
  const newCategoryKind: CategoryKind = categoryKind || (type === "deposit" ? "income" : "expense");
  // The same rule TransactionForm previews, for a harsher reason: a one-off
  // mixed split is refused once at the moment somebody is looking, while a
  // recurrence that saved cleanly proposes an uncommittable row every
  // occurrence for ever. One function, so the sentence here is the sentence
  // the commit would eventually throw.
  const entrySide =
    type === "transfer"
      ? null
      : resolveEntrySide(
          type,
          namedForKind
            .map(({ id, name }) => {
              const known =
                categories.find((category) => category.id === id) ??
                (name.trim()
                  ? categories.find(
                      (category) => normalizeHumanName(category.name) === normalizeHumanName(name),
                    )
                  : undefined);
              if (known) return known.kind;
              return name.trim() ? newCategoryKind : undefined;
            })
            .filter((kind): kind is CategoryKind => Boolean(kind)),
        );
  const entrySideError = entrySide && !entrySide.ok ? entrySide.message : "";
  const splitSettled =
    !splitting ||
    moneyRemainder(
      amount,
      legs.map((leg) => leg.amount || "0"),
    ) === "0";
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
    legsComplete &&
    !entrySideError &&
    parsedSchedule.success,
  );

  return (
    <form
      className="form-grid"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) mutation.mutate();
      }}
    >
      <ErrorSummary error={mutation.error} />
      <RequiredNote />
      <Field label="Name" hint="What you will pick it out by later.">
        <Input
          autoFocus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Rent"
        />
      </Field>

      <TransactionTypeChoice value={type} onChange={setType} />

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

      <div className={crossCurrency ? "two-columns" : ""}>
        <Field
          label={
            crossCurrency && sendingAccount ? `Amount sent (${sendingAccount.currency})` : "Amount"
          }
          hint="Leave blank when it differs every time. Each proposal then waits on Staged transactions for a number."
        >
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
          />
        </Field>
        {crossCurrency ? (
          <Field
            label={`Amount received (${receivingAccount!.currency})`}
            hint="Optional. Leave blank unless the rate is agreed in advance."
          >
            <Input
              inputMode="decimal"
              value={destinationAmount}
              onChange={(event) => setDestinationAmount(event.target.value)}
              placeholder="0.00"
              pattern="(0|[1-9][0-9]{0,25})(\.[0-9]{1,18})?"
            />
          </Field>
        ) : null}
      </div>

      {type === "transfer" ? null : (
        <Field label="Category" hint="Optional">
          <CategoryLegs
            categories={categories}
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
          {newCategoryNames.length > 0 ? (
            <div
              className="radio-row"
              role="radiogroup"
              aria-label={
                newCategoryNames.length === 1
                  ? `What kind of category ${newCategoryNames[0]} is`
                  : "What kind of category these are"
              }
            >
              <label className="check-label">
                <input
                  type="radio"
                  name={categoryKindGroup}
                  checked={newCategoryKind === (type === "deposit" ? "income" : "expense")}
                  onChange={() => setCategoryKind("")}
                />
                {type === "deposit" ? "Money you earned" : "Money you spent"}
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  name={categoryKindGroup}
                  checked={newCategoryKind === (type === "deposit" ? "expense" : "income")}
                  onChange={() => setCategoryKind(type === "deposit" ? "expense" : "income")}
                />
                {type === "deposit"
                  ? "A refund of money you spent"
                  : "Paying back money you earned"}
              </label>
            </div>
          ) : null}
        </Field>
      )}

      <fieldset className="form-fieldset">
        <legend>Schedule</legend>
        <div className="two-columns">
          <Field label="Repeats">
            <Select
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as RecurrenceFrequencyName)}
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
                  name={monthDayGroup}
                  checked={!byPosition}
                  onChange={() => setByPosition(false)}
                />
                On day {Number(anchorDate.slice(8, 10)) || 1} of the month
              </label>
              <label className="check-label">
                <input
                  type="radio"
                  name={monthDayGroup}
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
                      setOrdinal(Number(event.target.value) as RecurrencePosition["ordinal"])
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
            A daily schedule of one or two days moved onto a business day puts two occurrences on
            the same date, and Staged transactions refuses to commit rows that alike. Make the
            interval three days or more to use those two.
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

      {crossCurrency ? (
        <Alert kind="info">
          These two accounts hold different currencies. Leave the amount received blank and each
          proposal waits in the queue for it, which is what you want while the rate moves. Fill it
          in only where the rate is agreed in advance: every occurrence then proposes that same
          figure.
        </Alert>
      ) : null}
      <fieldset className="form-fieldset">
        <legend>Notifications</legend>
        <label className="check-label">
          <input
            type="checkbox"
            checked={notifyOnCreate}
            disabled={mutation.isPending}
            onChange={(event) => setNotifyOnCreate(event.target.checked)}
          />
          Email me when this proposes a transaction
        </label>
        <p className="settings-note">
          Sent when the scheduler adds rows to Staged transactions, not when you commit them. One
          message per proposal, however many rows it holds.
        </p>
        {notifyOnCreate && notificationsAvailable === false ? (
          <Alert kind="info">
            This deployment has no mail server configured, so the setting will be saved and nothing
            will be sent until one is.
          </Alert>
        ) : null}
      </fieldset>

      <Alert kind="info">
        A recurrence adds a row to Staged transactions and posts nothing. Each proposal is an
        ordinary staged row you check and commit.
      </Alert>

      {entrySideError ? <Alert kind="error">{entrySideError}</Alert> : null}
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
