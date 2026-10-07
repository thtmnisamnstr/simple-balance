import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCog, Pencil, Repeat, Target, Trash2, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  api,
  json,
  queryString,
  type BudgetPeriodUnitName,
  type Account,
  type BudgetEntry,
  type BudgetPlan,
  type BudgetReport,
  type Category,
  type CategoryGroup,
  type Forecast,
  type Session,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DateRangeBar,
  EmptyState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  RequiredNote,
  Select,
  Skeleton,
  useConfirm,
} from "../components.js";
import { useDateRange } from "../date-range.js";
import { Link, useLocation } from "../router.js";
import {
  fillPercent,
  periodName,
  rowState,
  stateLabel,
  stateTone,
  unitNoun,
  unitNounPlural,
} from "../budget-display.js";
import {
  amountForInput,
  compareMoney,
  formatDate,
  formatMoney,
  isNegativeMoney,
  moneyLabel,
} from "../money.js";

const periodUnits: { value: BudgetPeriodUnitName; label: string }[] = [
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
];

/**
 * The name of the button that sets one period's amount, which says the row and
 * the period because the icon says neither.
 *
 * It was a text button reading "Just this month" — no verb, a "just", and the
 * same words on every row, so a screen reader's list of buttons was forty
 * identical entries — in a table whose standing budgets above it already used
 * icons named for their row (`web.md` 9.8).
 */
const overrideLabel = (overridden: boolean, name: string, period: string) =>
  `${overridden ? "Change" : "Set"} the amount for ${name} in ${period}`;

export default function BudgetsPage({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const { start, end } = useDateRange();
  const [periodUnit, setPeriodUnit] = useState<BudgetPeriodUnitName>("month");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** What a row action in the single-periods table did, said where focus reaches it. */
  const [rowOutcome, setRowOutcome] = useState("");
  // A row's refusal, named and beside the row outcome rather than in the "Set a
  // budget" panel, which is where the shared `error` renders and which the
  // press did not come from.
  const [rowRefusal, setRowRefusal] = useState("");
  // Defaults to counting it, matching the server: a budget's limit was never
  // scoped to an account, so money spent on a card since closed is money the
  // budget covered.
  const [includeArchived, setIncludeArchived] = useState(true);
  // On, like the server's default: the question a budget raises is where the
  // rest went, and a page that answered it only when asked would be hiding the
  // gap.
  const [includeUnbudgeted, setIncludeUnbudgeted] = useState(true);
  // One box for both kinds of target, because a budget is about one thing and
  // asking which kind first would be a mode. The value carries its own kind.
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  // Somebody with one currency should never have to type it. It is still a
  // field rather than a fixed value, because a ledger holding two currencies
  // budgets in both and there is no total across them to fall back on.
  const [currency, setCurrency] = useState(session.preferences.defaultCurrency);
  const [activeFrom, setActiveFrom] = useState("");
  const [activeTo, setActiveTo] = useState("");
  // Three fields and one checkbox, because they are one decision: what happens
  // to the difference at the end of a period. The words "envelope", "sinking
  // fund" and "rollover budget" appear nowhere — a budget is what it says it
  // is, and naming the method would make it a mode somebody has to pick.
  const [rollover, setRollover] = useState(false);
  const [rolloverCap, setRolloverCap] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  // One select and one box, because the rules are alternatives rather than a
  // set of switches. The select is not a "method": each option names what it
  // does to the amount, and picking one is what makes the budget that kind.
  const [rule, setRule] = useState<"fixed" | "average" | "step" | "income">("fixed");
  const [ruleValue, setRuleValue] = useState("");
  const [priority, setPriority] = useState("");
  const remove = useConfirm<BudgetPlan>();
  const [editing, setEditing] = useState<BudgetPlan | null>(null);
  const [override, setOverride] = useState<{
    // A category, or a group that holds a budget of its own. A group budgeted
    // as its categories added up has nothing to override, and offers nothing.
    target: { categoryId: string } | { groupId: string };
    category: string;
    currency: string;
    periodStart: string;
    existing: BudgetEntry | null;
  } | null>(null);
  const [overrideAmount, setOverrideAmount] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editActiveTo, setEditActiveTo] = useState("");
  const [editRollover, setEditRollover] = useState(false);
  const [editRolloverCap, setEditRolloverCap] = useState("");
  const [editPriority, setEditPriority] = useState("");

  /**
   * Four fields of the report this page deliberately does not render, named
   * here so the next reader can tell restraint from oversight (§11.9).
   *
   * `asOf` — the day the summary actually stopped at. Every period already
   * carries `partial`, which the tables render as "(so far)", and a second
   * date beside it invites the reading that the two could disagree.
   * `carriedOut` on a row and on a group — what this period hands to the next.
   * It is the next period's `carriedIn`, which is rendered, so showing both
   * prints one number twice under two names in adjacent tables.
   * `priority` and `funded` on a group row — the funding order is a
   * category-level decision here; a group is reported as a subtotal of the
   * categories beside it, and both figures are rendered on those.
   */
  const report = useQuery({
    queryKey: ["budgets", "report", start, end, periodUnit, includeArchived, includeUnbudgeted],
    queryFn: () =>
      api<BudgetReport>(
        `/api/v1/budget-report?${queryString({
          start,
          end,
          periodUnit,
          // Always sent, both ways. `queryString` drops a falsy value, so
          // sending only "true" meant unchecked sent nothing and fell through
          // to the server default, which is now true: the box changed nothing
          // in either position while the two behaviors differ by every penny
          // spent through a closed account.
          includeArchived: includeArchived ? "true" : "false",
          // Both ways for the same reason.
          includeUnbudgeted: includeUnbudgeted ? "true" : "false",
        })}`,
      ),
  });
  const plans = useQuery({
    queryKey: ["budgets", "plans"],
    queryFn: () => api<BudgetPlan[]>("/api/v1/budget-plans"),
  });
  // The overrides themselves, so a row can say which entry it is looking at
  // without the report having to carry an id it exists only to hand back. They
  // are the exception rather than the rule, so this list is short.
  const entries = useQuery({
    queryKey: ["budgets", "entries"],
    queryFn: () => api<BudgetEntry[]>("/api/v1/budget-entries"),
  });
  const accounts = useQuery({
    queryKey: ["accounts", "list"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  const categories = useQuery({
    queryKey: ["categories", "list"],
    queryFn: () => api<Category[]>("/api/v1/categories"),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["budgets"] });
    // The projection reads the budgets too, and it is on the same page: leaving
    // it alone meant "budgets intend" and the projected balance sat there
    // describing a budget that had just been changed.
    void queryClient.invalidateQueries({ queryKey: ["forecast"] });
  };

  // Cleared whenever anything is attempted, so a success from a minute ago
  // cannot sit above the refusal of the thing just tried.
  const startAttempt = () => {
    setError("");
    setNotice("");
  };

  const createPlan = useMutation({
    mutationFn: () =>
      api<BudgetPlan>(
        "/api/v1/budget-plans",
        json({
          ...(target.startsWith("group:")
            ? { groupId: target.slice("group:".length) }
            : { categoryId: target.slice("category:".length) }),
          // Zero wherever the amount box is hidden, which is every rule that
          // works the figure out for itself. Sending an empty box would be
          // refused by the schema for a field the person was never shown, and
          // sending what was typed before they switched rules would be a number
          // nothing reads. An incremental budget is the exception: its first
          // period steps up from exactly this amount.
          amount: targetAmount === "" && rule !== "income" ? amount : "0",
          currency,
          periodUnit,
          activeFrom,
          ...(activeTo !== "" ? { activeTo } : {}),
          rollover,
          ...(rollover && rolloverCap !== "" ? { rolloverCap } : {}),
          ...(targetAmount !== "" ? { targetAmount, targetDate } : {}),
          // Sent as a number only when it is one. `Number("three")` is NaN,
          // which JSON writes as null, which the schema reads as "clear the
          // rule" — so a typo quietly became a fixed budget of nothing.
          ...(rule === "average" && ruleValue !== "" && Number.isInteger(Number(ruleValue))
            ? { lookbackPeriods: Number(ruleValue) }
            : {}),
          ...(rule === "step" && ruleValue !== "" ? { percentOfPrevious: ruleValue } : {}),
          ...(rule === "income" && ruleValue !== "" ? { percentOfIncome: ruleValue } : {}),
          ...(priority !== "" ? { priority: Number(priority) } : {}),
        }),
      ),
    onSuccess: (plan) => {
      setError("");
      setNotice(
        `Budgeting ${formatMoney(plan.amount, plan.currency)} for ${plan.targetName} every ${unitNoun[plan.periodUnit]}, from ${formatDate(plan.activeFrom)}.`,
      );
      setTarget("");
      setAmount("");
      setActiveTo("");
      // Everything that decides what kind of budget this is, because the next
      // one is a different budget. A checkbox that survived the create made the
      // one after it carry silently.
      setRollover(false);
      setRolloverCap("");
      setTargetAmount("");
      setTargetDate("");
      setRule("fixed");
      setRuleValue("");
      setPriority("");
      invalidate();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const editPlan = useMutation({
    mutationFn: (plan: BudgetPlan) =>
      api<BudgetPlan>(`/api/v1/budget-plans/${plan.id}`, {
        ...json({
          amount: editAmount,
          // An empty field means no end date, which is a clear rather than a
          // skip, so it travels as null. Absent would leave the old end in
          // place and the form would look as though it had done nothing.
          activeTo: editActiveTo === "" ? null : editActiveTo,
          rollover: editRollover,
          // Same three-way patch, and the same reason: a cap somebody cleared
          // has to travel as null or the old one stays.
          rolloverCap: editRollover && editRolloverCap !== "" ? editRolloverCap : null,
          // Blank is unranked, which is zero rather than absent: absent would
          // leave a rank somebody had just cleared in place. Category budgets
          // only, as on the create form, because a group's rank is never read.
          ...(plan.categoryId === null
            ? {}
            : { priority: editPriority === "" ? 0 : Number(editPriority) }),
          expectedVersion: plan.version,
        }),
        method: "PUT",
      }),
    onSuccess: () => {
      setError("");
      setEditing(null);
      invalidate();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const setEntry = useMutation({
    mutationFn: () =>
      api<BudgetEntry>("/api/v1/budget-entries", {
        ...json({
          ...("groupId" in override!.target
            ? { groupId: override!.target.groupId }
            : { categoryId: override!.target.categoryId }),
          currency: override!.currency,
          periodUnit,
          periodStart: override!.periodStart,
          amount: overrideAmount,
          ...(override!.existing ? { expectedVersion: override!.existing.version } : {}),
        }),
        method: "PUT",
      }),
    onSuccess: () => {
      setError("");
      setOverride(null);
      invalidate();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const clearEntry = useMutation({
    mutationFn: (entry: BudgetEntry) =>
      api<{ id: string }>(`/api/v1/budget-entries/${entry.id}`, {
        ...json({ expectedVersion: entry.version }),
        method: "DELETE",
      }),
    // The last outcome is about the last press: left up, it sat beside the next
    // one's refusal, and a repeat of the same sentence was neither announced
    // nor given focus by an alert already showing it.
    onMutate: () => {
      setRowOutcome("");
      setRowRefusal("");
    },
    onSuccess: (_result, entry) => {
      /*
       * 13.3, and the shape `web.md` 9.8 names. Removing an override takes its
       * own row out of the single-periods table, so the button that did it goes
       * with the row and focus falls to `<body>`. The `{notice}` above is a
       * different alert for a different action — it reports a standing budget
       * beside the form that made one, which is why it is registered in
       * `tests/success-alert-focus.test.ts` as leaving focus alone.
       */
      setRowOutcome(`Override for ${entry.targetName} removed.`);
      setError("");
      setOverride(null);
      invalidate();
    },
    // Pressed inside the override dialog, the refusal belongs in the dialog,
    // which is still open; pressed on a row, it belongs beside the rows.
    onError: (cause: Error, entry) =>
      override
        ? setError(cause.message)
        : setRowRefusal(`Override for ${entry.targetName} was not removed. ${cause.message}`),
  });

  const deletePlan = useMutation({
    mutationFn: (plan: BudgetPlan) =>
      api<{ id: string }>(`/api/v1/budget-plans/${plan.id}`, {
        ...json({ expectedVersion: plan.version }),
        method: "DELETE",
      }),
    // The row and its trash icon go together, so focus fell to `<body>` and
    // nothing said the budget had gone — `common.md`'s own worked example is
    // "Delete budget", then "Budget deleted", and the second half was never
    // shown (`web.md` 13.3).
    onMutate: () => {
      setRowOutcome("");
      setRowRefusal("");
    },
    onSuccess: (_result, plan) => {
      setRowOutcome(`Budget for ${plan.targetName} deleted. The books are exactly as they were.`);
      setError("");
      invalidate();
    },
    onError: (cause: Error, plan) =>
      setRowRefusal(`Budget for ${plan.targetName} was not deleted. ${cause.message}`),
  });

  // Only categories that can carry spending. An income category has nothing for
  // a limit to be compared against, and the server refuses one, so offering it
  // here would be a refusal nobody could see the cause of.
  // Its own vocabulary, and deliberately: a projection is not a balance, and
  // the panel that shows one says "projected" everywhere the rest of the page
  // says "spent".
  const [forecastPeriods, setForecastPeriods] = useState("6");
  // History, not schedules, because a schedule is the one thing a new ledger has
  // none of: a household with four months of real spending and no recurrences
  // saw $0.00 in both money columns and no way to tell that from a household
  // that spends nothing. The wire default stays "recurring" — this is the page
  // choosing what to ask for, not a change to what an unchanged request returns.
  const [forecastLookback, setForecastLookback] = useState("3");
  const [forecastBasis, setForecastBasis] = useState<Forecast["basis"]>("recurring_and_history");
  const forecast = useQuery({
    queryKey: ["forecast", periodUnit, forecastPeriods, forecastBasis, forecastLookback],
    queryFn: () =>
      api<Forecast>(
        `/api/v1/forecast?${queryString({
          periodUnit,
          periods: forecastPeriods,
          basis: forecastBasis,
          lookback: forecastLookback,
        })}`,
      ),
  });
  const groups = useQuery({
    queryKey: ["category-groups"],
    queryFn: () => api<CategoryGroup[]>("/api/v1/category-groups"),
  });
  const budgetable = (categories.data ?? []).filter(
    (category) => category.kind !== "income" && !category.archivedAt,
  );

  const entryFor = (
    target: { categoryId: string } | { groupId: string },
    currency: string,
    periodStart: string,
  ) =>
    (entries.data ?? []).find(
      (entry) =>
        ("groupId" in target
          ? entry.groupId === target.groupId
          : entry.categoryId === target.categoryId) &&
        entry.currency === currency &&
        entry.periodUnit === periodUnit &&
        entry.periodStart === periodStart,
    ) ?? null;

  /**
   * The one-period dialog, opened on whatever row asked for it.
   *
   * A group that holds a budget of its own is overridden the way a category
   * is; the tool always could, and the page offered it only on category rows,
   * so an agent had a move its owner did not.
   */
  const openOverride = (
    target: { categoryId: string } | { groupId: string },
    name: string,
    period: { currency: string; periodStart: string },
    limit: string | null,
  ) => {
    const existing = entryFor(target, period.currency, period.periodStart);
    setError("");
    setOverride({
      target,
      category: name,
      currency: period.currency,
      periodStart: period.periodStart,
      existing,
    });
    // At the currency's decimals, as every edit field opens a stored amount
    // (`web.md` 10.2): both arrive canonical, so $12.50 opened as "12.5".
    const seed = existing?.amount ?? limit;
    setOverrideAmount(seed ? amountForInput(seed, period.currency) : "");
  };

  // A budget can only ever be compared against spending in a currency this
  // ledger actually holds, so those are the only ones offered. Free text let
  // somebody type DOLLARS, get a 201, and never see the budget again.
  const currencyChoices = [
    ...new Set([
      session.preferences.defaultCurrency,
      ...(accounts.data ?? []).map((account) => account.currency),
    ]),
  ].sort();

  const periods = report.data?.periods ?? [];

  // Empty means every figure is zero, in every period of every currency — not
  // "the server sent no currencies", which it always does for anybody with an
  // account.
  const forecastIsEmpty = (forecast.data?.currencies ?? []).every((currency) =>
    currency.periods.every(
      (period) =>
        period.occurrences === 0 &&
        compareMoney(period.expectedIncome, "0") === 0 &&
        compareMoney(period.expectedSpending, "0") === 0,
    ),
  );

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Budgets"
        description="What each category was allowed, and what it actually spent. Nothing here changes a balance."
      />

      <DateRangeBar />

      {/* The period is a property of the view and of every budget on it, so it
          sits beside the range rather than inside the create form, where
          changing it silently rebuilt the report below and looked like editing
          a field. */}
      {/* The group and the control inside it must not share a name: two things
          answering to "Budget period" is ambiguous to anything navigating by
          accessible name, and a browser test found it by matching both. */}
      <div className="option-bar" role="group" aria-label="Budget view">
        <div className="option-bar-title">
          <Target size={17} />
          <span>Budgeting by</span>
        </div>
        {/* Named by the words beside it, as the forecast bar's selects are: the
            name was "Budget period" under a visible "Budgeting by", so a voice
            user saying what they could see named nothing (SC 2.5.3). */}
        <Select
          aria-label="Budgeting by"
          value={periodUnit}
          onChange={(event) => setPeriodUnit(event.target.value as BudgetPeriodUnitName)}
        >
          {periodUnits.map((unit) => (
            <option key={unit.value} value={unit.value}>
              {unit.label}
            </option>
          ))}
        </Select>
        {/* Counted by default, unlike every other report, because a budget's
            limit was never scoped to an account: leaving out a closed card
            makes a budget spent to the penny read as underspent. The box is
            here so somebody can ask the other question. */}
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Count spending through archived accounts
        </label>
        {/* The guide has promised this since the first budget shipped and the
            page never had it: the API took `includeUnbudgeted` and only an
            agent could send it. */}
        <label className="check-label">
          <input
            type="checkbox"
            checked={includeUnbudgeted}
            onChange={(event) => setIncludeUnbudgeted(event.target.checked)}
          />
          Show categories with no budget
        </label>
      </div>

      {rowRefusal ? <Alert takeFocus>{rowRefusal}</Alert> : null}
      {rowOutcome ? (
        <Alert kind="success" takeFocus>
          {rowOutcome}
        </Alert>
      ) : null}

      <section className="panel">
        <header className="panel-header">
          <h2>Set a budget</h2>
        </header>
        {error && editing === null && override === null ? (
          <Alert kind="error">{error}</Alert>
        ) : null}
        {notice ? <Alert kind="success">{notice}</Alert> : null}
        <form
          className="budget-form"
          onSubmit={(event) => {
            event.preventDefault();
            startAttempt();
            createPlan.mutate();
          }}
        >
          {/* `web.md` 8.4: three fields here say they are optional, and what an
              unmarked one means is said once, as on every other form. */}
          <RequiredNote />
          <Field label="Category or group">
            <Select required value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Choose what to budget</option>
              {budgetable.map((category) => (
                <option key={category.id} value={`category:${category.id}`}>
                  {category.name}
                </option>
              ))}
              {/* Only the groups that hold a budget of their own. A group that
                  adds up its categories already has an amount, and offering it
                  here would ask for a second one with an equal claim. */}
              {(groups.data ?? [])
                .filter((group) => group.policy === "standalone")
                .map((group) => (
                  <option key={group.id} value={`group:${group.id}`}>
                    {group.name} (group)
                  </option>
                ))}
            </Select>
          </Field>
          {targetAmount === "" && rule !== "income" ? (
            <Field
              label={moneyLabel("Amount", currency)}
              hint={
                rule === "step"
                  ? "The first period's amount. The increase starts from the one after."
                  : rule === "average"
                    ? "Used until there are finished periods to average."
                    : undefined
              }
            >
              <Input
                required
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="200.00"
              />
            </Field>
          ) : null}
          {targetAmount === "" ? (
            <Field label="Amount decided by">
              <Select
                value={rule}
                onChange={(event) => {
                  setRule(event.target.value as typeof rule);
                  setRuleValue("");
                }}
              >
                <option value="fixed">The amount, every period</option>
                <option value="average">What the last few periods spent</option>
                <option value="step">The last period, plus a percentage</option>
                <option value="income">A share of the income before it</option>
              </Select>
            </Field>
          ) : null}
          {targetAmount === "" && rule !== "fixed" ? (
            <Field
              label={
                rule === "average"
                  ? `${unitNounPlural[periodUnit]} to average`
                  : rule === "step"
                    ? "Increase each period by (%)"
                    : "Share of income (%)"
              }
            >
              <Input
                required
                // A whole number of periods where the rule counts periods, so
                // the browser refuses "three" rather than the server refusing it
                // after the fact.
                {...(rule === "average"
                  ? { type: "number", min: 1, max: 24, step: 1 }
                  : { inputMode: "decimal" as const })}
                value={ruleValue}
                onChange={(event) => setRuleValue(event.target.value)}
                placeholder={rule === "average" ? "3" : "10"}
              />
            </Field>
          ) : null}
          <Field label="Currency">
            <Select required value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {currencyChoices.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starting">
            <Input
              required
              type="date"
              value={activeFrom}
              onChange={(event) => setActiveFrom(event.target.value)}
            />
          </Field>
          {/* An agent could set a budget with an end and a person had to set it
              and then edit it, which is the same budget reached in two steps
              and a field only the tool offered. */}
          <Field label="Ends after" optional hint="Leave blank to keep running.">
            <Input
              type="date"
              value={activeTo}
              onChange={(event) => setActiveTo(event.target.value)}
            />
          </Field>
          <Field label={moneyLabel("Saving up for", currency)} optional>
            <Input
              inputMode="decimal"
              value={targetAmount}
              onChange={(event) => {
                setTargetAmount(event.target.value);
                // A fund keeps what it saves or it is not saving. Turning the
                // carry on here rather than refusing the form later is the
                // difference between a rule and an obstacle. The other rules go
                // with it for the same reason: a budget works its amount out
                // one way, and the select that chose the other one is now
                // hidden, so leaving it set would send two and be refused with
                // nothing on screen to fix.
                if (event.target.value !== "") {
                  setRollover(true);
                  setRule("fixed");
                  setRuleValue("");
                }
              }}
              placeholder="600.00"
            />
          </Field>
          {targetAmount === "" ? null : (
            <Field label="Needed by">
              <Input
                required
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
              />
            </Field>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={rollover}
              disabled={targetAmount !== ""}
              onChange={(event) => setRollover(event.target.checked)}
            />
            Carry what is left over into the next {unitNoun[periodUnit]}
          </label>
          {rollover ? (
            <Field
              label={moneyLabel("Most to carry", currency)}
              optional
              hint="Leave blank for no limit."
            >
              <Input
                inputMode="decimal"
                value={rolloverCap}
                onChange={(event) => setRolloverCap(event.target.value)}
                placeholder="No limit"
              />
            </Field>
          ) : null}
          {target.startsWith("group:") ? null : (
            <Field
              label="Funded first"
              optional
              hint="Lower goes first when a period's income will not cover everything. Leave blank for unranked, which is funded last."
            >
              <Input
                inputMode="numeric"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                placeholder="1"
              />
            </Field>
          )}
          <Button type="submit" loading={createPlan.isPending}>
            Set budget
          </Button>
        </form>
        <Note>
          One budget covers every {unitNoun[periodUnit]} from the date it starts, so there is
          nothing to set again next {unitNoun[periodUnit]}. To change it later without rewriting
          what past {unitNoun[periodUnit]}s intended, end this one and start another.
        </Note>
        <Note>
          {targetAmount === ""
            ? rollover
              ? `What this ${unitNoun[periodUnit]} does not spend is added to the next one, and anything overspent is taken off it. Nothing is stored ${unitNoun[periodUnit]} by ${unitNoun[periodUnit]}: the figures are worked out from what you budgeted and what you spent, so turning this off leaves nothing behind.`
              : `Each ${unitNoun[periodUnit]} starts again at the amount. Check the box to carry the difference forward instead.`
            : `Each ${unitNoun[periodUnit]} puts aside what is still needed, divided by the ${unitNoun[periodUnit]}s left before the date. There is no amount to type: the figure changes as the fund fills up, and stops once it is full.`}
        </Note>
      </section>

      <section className="panel">
        <header className="panel-header">
          <h2>Standing budgets</h2>
        </header>
        {plans.isError ? (
          <Alert kind="error">
            The standing budgets could not be loaded, so this is not a list of them.{" "}
            {(plans.error as Error).message}
          </Alert>
        ) : plans.isPending ? (
          <Skeleton height={80} label="Loading standing budgets…" />
        ) : (plans.data ?? []).length === 0 ? (
          <EmptyState
            compact
            icon={Repeat}
            title="No standing budgets yet"
            body="A standing budget repeats from the date it starts, so there is nothing to set again next period."
          />
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Standing budgets">
            <table className="data-table">
              <caption className="sr-only">Standing budgets</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="align-right">
                    Amount
                  </th>
                  <th scope="col">Every</th>
                  <th scope="col">Runs</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(plans.data ?? []).map((plan) => (
                  <tr key={plan.id}>
                    <th scope="row">
                      {plan.targetName}{" "}
                      {plan.amountRule === "sinking_fund" ? (
                        <Badge tone="neutral">
                          Saving {formatMoney(plan.targetAmount ?? "0", plan.currency)} by{" "}
                          {periodName(plan.periodUnit, plan.targetDate ?? plan.activeFrom)}
                        </Badge>
                      ) : plan.rollover ? (
                        <Badge tone="neutral">
                          Carries over
                          {plan.rolloverCap
                            ? `, up to ${formatMoney(plan.rolloverCap, plan.currency)}`
                            : ""}
                        </Badge>
                      ) : null}{" "}
                      {plan.amountRule === "trailing_average" ? (
                        <Badge tone="neutral">
                          Average of {plan.lookbackPeriods} {unitNoun[plan.periodUnit]}
                          {plan.lookbackPeriods === 1 ? "" : "s"}
                        </Badge>
                      ) : plan.amountRule === "incremental" ? (
                        <Badge tone="neutral">+{plan.percentOfPrevious}% each period</Badge>
                      ) : plan.amountRule === "percent_of_income" ? (
                        <Badge tone="neutral">{plan.percentOfIncome}% of income</Badge>
                      ) : null}{" "}
                      {plan.priority === 0 ? null : (
                        <Badge tone="neutral">Funded {plan.priority}</Badge>
                      )}
                    </th>
                    <td className="align-right money">
                      {plan.amountRule === "fixed" || plan.amountRule === "incremental"
                        ? formatMoney(plan.amount, plan.currency)
                        : "Calculated"}
                    </td>
                    <td>{unitNoun[plan.periodUnit]}</td>
                    <td>
                      {periodName(plan.periodUnit, plan.activeFrom)}
                      {plan.activeTo
                        ? plan.activeTo === plan.activeFrom
                          ? " only"
                          : ` to ${periodName(plan.periodUnit, plan.activeTo)}`
                        : " onward"}
                    </td>
                    {/* Icon buttons naming their row, which is what every
                        other list here does. These were text buttons reading
                        "Change Groceries" and "Delete Groceries" in a row whose
                        first cell already said Groceries, so the actions column
                        was the widest on the table and said the same word
                        three times. The name a screen reader needs is still
                        there; it is in the label rather than on screen. */}
                    <td className="row-actions">
                      <button
                        type="button"
                        aria-label={`Change the budget for ${plan.targetName}`}
                        onClick={() => {
                          setError("");
                          setEditing(plan);
                          setEditAmount(amountForInput(plan.amount, plan.currency));
                          setEditActiveTo(plan.activeTo ?? "");
                          setEditRollover(plan.rollover);
                          setEditRolloverCap(
                            plan.rolloverCap ? amountForInput(plan.rolloverCap, plan.currency) : "",
                          );
                          setEditPriority(plan.priority === 0 ? "" : String(plan.priority));
                        }}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete the budget for ${plan.targetName}`}
                        onClick={() => remove.ask(plan, () => deletePlan.mutate(plan))}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={editing !== null}
        title={editing ? `Budget for ${editing.targetName}` : "Budget"}
        description="Changing the amount changes every period this budget covers, past ones included. To leave what earlier periods intended alone, give it an end date and set a new budget starting after it."
        onClose={() => {
          setError("");
          setEditing(null);
        }}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError("");
                setEditing(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" form="budget-edit" loading={editPlan.isPending}>
              Save budget
            </Button>
          </>
        }
      >
        {/* A form, so Enter submits from any field — every other field-bearing
            dialog here is one, and this was two of the three that were not.
            `form-grid` is what gives the fields their gap; without it they
            touched, which is how the missing form looked from outside. */}
        <form
          id="budget-edit"
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            startAttempt();
            if (editing) editPlan.mutate(editing);
          }}
        >
          {error ? <Alert kind="error">{error}</Alert> : null}
          <RequiredNote />
          {editing &&
          editing.amountRule !== "fixed" &&
          editing.amountRule !== "incremental" &&
          editing.amountRule !== "trailing_average" ? (
            <Note>
              {editing.amountRule === "sinking_fund"
                ? `This one is saving ${formatMoney(editing.targetAmount ?? "0", editing.currency)} by ${periodName(editing.periodUnit, editing.targetDate ?? editing.activeFrom)}, and works out its own amount each ${unitNoun[editing.periodUnit]}.`
                : `This one takes ${editing.percentOfIncome}% of the income before it, so it works out its own amount and there is nothing here to type.`}{" "}
              Delete it and set a plain budget if that is not what you want.
            </Note>
          ) : (
            <>
              {/* Required in fact and unmarked, with a marked sibling two
                  fields away — which is what makes it a slip rather than a
                  decision. 8.3's point is that the native half needs nothing:
                  no form here sets `noValidate`, so the browser blocks the
                  submit, focuses the field and says why, for one word. */}
              <Field label={moneyLabel("Amount", editing?.currency)}>
                <Input
                  required
                  inputMode="decimal"
                  value={editAmount}
                  onChange={(event) => setEditAmount(event.target.value)}
                />
              </Field>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={editRollover}
                  onChange={(event) => setEditRollover(event.target.checked)}
                />
                Carry what is left over into the next {unitNoun[editing?.periodUnit ?? periodUnit]}
              </label>
              {editRollover ? (
                <Field
                  label={moneyLabel("Most to carry", editing?.currency)}
                  optional
                  hint="Leave blank for no limit."
                >
                  <Input
                    inputMode="decimal"
                    value={editRolloverCap}
                    onChange={(event) => setEditRolloverCap(event.target.value)}
                  />
                </Field>
              ) : null}
            </>
          )}
          {editing?.categoryId == null ? null : (
            <Field
              label="Funded first"
              optional
              hint="Lower goes first when a period's income will not cover everything. Leave blank for unranked, which is funded last."
            >
              <Input
                inputMode="numeric"
                value={editPriority}
                onChange={(event) => setEditPriority(event.target.value)}
                placeholder="1"
              />
            </Field>
          )}
          <Field label="Ends after" optional hint="Leave blank to keep running.">
            <Input
              type="date"
              value={editActiveTo}
              onChange={(event) => setEditActiveTo(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={remove.open}
        title={
          remove.value ? `Delete the ${remove.value.targetName} budget?` : "Delete this budget?"
        }
        confirmLabel="Delete budget"
        onConfirm={remove.confirm}
        onCancel={remove.cancel}
      >
        It wrote nothing to the books, so deleting it changes no balance and no report. This page
        stops comparing against it.
      </ConfirmDialog>

      {(entries.data ?? []).length > 0 ? (
        <section className="panel">
          <header className="panel-header">
            <h2>Single periods</h2>
          </header>
          {/* Listed because an override set in one period was invisible from
              every other, so it could be created and then lost: the figure it
              changed was somewhere nobody was looking. */}
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Amounts set for one period"
          >
            <table className="data-table">
              <caption className="sr-only">
                Amounts set for one period, overriding the standing budget
              </caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="align-right">
                    Amount
                  </th>
                  <th scope="col">Period</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(entries.data ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{entry.targetName}</th>
                    <td className="align-right money">
                      {formatMoney(entry.amount, entry.currency)}
                    </td>
                    <td>{periodName(entry.periodUnit, entry.periodStart)}</td>
                    {/* The same icon the standing-budget table above uses,
                        for the reason its comment gives: a text button naming
                        the row made the actions column the widest on the table
                        and said the name twice. */}
                    <td className="row-actions">
                      <button
                        type="button"
                        aria-label={`Remove the override for ${entry.targetName}`}
                        disabled={clearEntry.isPending}
                        onClick={() => clearEntry.mutate(entry)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <Modal
        open={override !== null}
        title={
          override
            ? `${override.category}, ${periodName(periodUnit, override.periodStart)}`
            : "Budget one period"
        }
        description={`An amount for this ${unitNoun[periodUnit]} alone. The standing budget is left exactly as it is, and every other ${unitNoun[periodUnit]} still follows it.`}
        onClose={() => {
          setError("");
          setOverride(null);
        }}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError("");
                setOverride(null);
              }}
            >
              Cancel
            </Button>
            {override?.existing ? (
              <Button
                type="button"
                variant="danger"
                loading={clearEntry.isPending}
                onClick={() => override.existing && clearEntry.mutate(override.existing)}
              >
                Use the standing budget
              </Button>
            ) : null}
            <Button type="submit" form="budget-override" loading={setEntry.isPending}>
              Save override
            </Button>
          </>
        }
      >
        {/* Inside the dialog, because a modal is a focus trap: an alert
            rendered on the page behind it is unreachable and unannounced, so
            every refusal of this form was invisible. */}
        {error ? <Alert kind="error">{error}</Alert> : null}
        {/* A form, for the same reason as the dialog above: one amount field,
            and Enter did nothing in it. */}
        <form
          id="budget-override"
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            startAttempt();
            setEntry.mutate();
          }}
        >
          <Field
            label={moneyLabel("Amount", override?.currency)}
            hint={`Applies to this ${unitNoun[periodUnit]} only.`}
          >
            <Input
              required
              inputMode="decimal"
              value={overrideAmount}
              onChange={(event) => setOverrideAmount(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      {(report.data?.otherPeriodUnits ?? []).length > 0 ? (
        <Alert kind="info">
          You also budget by{" "}
          {(report.data?.otherPeriodUnits ?? []).map((u) => unitNoun[u]).join(", ")}. Those budgets
          are not in the figures below, because a budget belongs to one period. Change "Budgeting
          by" above to see them.
        </Alert>
      ) : null}

      {report.isError ? (
        <Alert kind="error">
          The budget figures could not be loaded, so nothing here is a report of anything.{" "}
          {(report.error as Error).message}
        </Alert>
      ) : report.isPending ? (
        <section className="panel">
          <Skeleton height={140} label="Loading budget figures…" />
        </section>
      ) : periods.length === 0 ? (
        <EmptyState
          icon={Target}
          title="Nothing budgeted in this range"
          body="Set a budget above, or widen the dates."
        />
      ) : (
        periods.map((period) => {
          // The carry columns appear only where something carries. A table of
          // dashes says a budget has a feature it does not have, and every
          // ledger that has never checked the box would grow two of them.
          const carries = period.rows.some((row) => row.carriedIn !== null);
          // Same rule as the carry columns: the funded figure appears only
          // where somebody set an order, so a ledger that never did is not told
          // its budgets are unfunded because income landed in another period.
          const ranked = period.unfunded !== null;
          return (
            <div className="panel" key={`${period.periodStart}:${period.currency}`}>
              <header className="panel-header">
                <h2>
                  {periodName(periodUnit, period.periodStart)}, {period.currency}
                  {period.partial ? " (so far)" : ""}
                </h2>
                <span className="subtle">
                  {/* Named as the categories' total, because a group's own
                      budget is beside the rows rather than in them: adding both
                      would count the same money twice, and a bare "budgeted"
                      beside a group table showing another figure reads as a
                      disagreement. */}
                  {formatMoney(period.budgeted, period.currency)} budgeted across the categories.{" "}
                  {carries
                    ? `${formatMoney(period.carriedIn, period.currency)} carried in, ${formatMoney(period.available, period.currency)} available. `
                    : ""}
                  {formatMoney(period.spent, period.currency)} spent in total, budgeted or not.
                  {ranked
                    ? ` ${formatMoney(period.income, period.currency)} came in, leaving ${formatMoney(period.unfunded ?? "0", period.currency)} of the budget unfunded.`
                    : ""}
                  {period.toAssign === null ? null : (
                    <>
                      {" "}
                      <strong>
                        {formatMoney(period.toAssign, period.currency)} left to assign
                      </strong>
                      , out of {formatMoney(period.perimeter, period.currency)} in the accounts this
                      budget is about. It sits below your bank balance because envelopes have
                      already claimed the rest, and because accounts can be left out.
                    </>
                  )}
                </span>
              </header>
              {period.groups.length > 0 ? (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={`Groups for ${formatDate(period.start)} to ${formatDate(period.end)}`}
                >
                  <table className="data-table">
                    <caption className="sr-only">
                      {/* Formatted, like every other date a person reads
                          (`common.md` §Dates and times). These five read
                          `2026-06-01` to a screen reader while the visible
                          heading on the same panel read "June 2026" —
                          `periodName` just above — so the two surfaces of one
                          panel disagreed, and the one that disagreed was the
                          one nobody looks at. `formatDate` rather than
                          `periodName` because `start` and `end` are the
                          period's span and may be clipped, so the span is the
                          honest thing to show and only its writing was
                          wrong. */}
                      Groups for {formatDate(period.start)} to {formatDate(period.end)} in{" "}
                      {period.currency}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Group</th>
                        <th scope="col" className="align-right">
                          Budget
                        </th>
                        <th scope="col" className="align-right">
                          Spent
                        </th>
                        <th scope="col" className="align-right">
                          Remaining
                        </th>
                        <th scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {period.groups.map((group) => (
                        <tr key={group.groupId}>
                          <th scope="row">
                            {group.name}{" "}
                            <Badge tone="neutral">
                              {group.policy === "sum_of_children" ? "Adds up" : "Own budget"}
                            </Badge>
                            {group.source === "entry" ? (
                              <>
                                {" "}
                                <Badge tone="neutral">This {unitNoun[periodUnit]} only</Badge>
                              </>
                            ) : null}
                          </th>
                          <td className="align-right money">
                            {group.limit === null ? "—" : formatMoney(group.limit, period.currency)}
                          </td>
                          <td className="align-right money">
                            {formatMoney(group.actual, period.currency)}
                          </td>
                          {/* Marked when it is negative, like every other
                              computed total in the product. Budgets rendered
                              seventeen money cells and never once used the
                              class, on the one page where "am I over?" is the
                              only question — so the figure was the one element
                              on the row not saying what its badge and its bar
                              already said. */}
                          <td
                            className={`align-right money ${
                              group.remaining !== null && isNegativeMoney(group.remaining)
                                ? "money-negative"
                                : ""
                            }`}
                          >
                            {group.remaining === null
                              ? "—"
                              : formatMoney(group.remaining, period.currency)}
                          </td>
                          <td className="row-actions">
                            {/* Only a group with a budget of its own has an
                                amount to override; one that adds up its
                                categories is overridden through them. */}
                            {group.policy === "sum_of_children" ? null : (
                              <button
                                type="button"
                                aria-label={overrideLabel(
                                  group.source === "entry",
                                  group.name,
                                  periodName(periodUnit, period.periodStart),
                                )}
                                onClick={() =>
                                  openOverride(
                                    { groupId: group.groupId },
                                    group.name,
                                    period,
                                    group.limit,
                                  )
                                }
                              >
                                <CalendarCog size={16} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label={`Budget against spending for ${formatDate(
                  period.start,
                )} to ${formatDate(period.end)}`}
              >
                <table className="data-table">
                  <caption className="sr-only">
                    Budget against spending for {formatDate(period.start)} to{" "}
                    {formatDate(period.end)} in {period.currency}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col" className="align-right">
                        Budget
                      </th>
                      {carries ? (
                        <>
                          <th scope="col" className="align-right">
                            Carried in
                          </th>
                          <th scope="col" className="align-right">
                            Available
                          </th>
                        </>
                      ) : null}
                      {ranked ? (
                        <th scope="col" className="align-right">
                          Funded
                        </th>
                      ) : null}
                      <th scope="col" className="align-right">
                        Spent
                      </th>
                      <th scope="col" className="align-right">
                        Remaining
                      </th>
                      <th scope="col">Progress</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {period.rows.map((row) => {
                      const state = rowState(row, period.partial);
                      return (
                        <tr key={`${row.categoryId ?? "unfiled"}`}>
                          <th scope="row">
                            {/* §11.10: the row names a category the app has a
                                page for, and "why is this one over?" is the
                                question this table provokes. Unfiled spending
                                has no id and stays plain text. */}
                            {row.categoryId ? (
                              <Link
                                to={{
                                  pathname: `/categories/${row.categoryId}`,
                                  search: location.search,
                                }}
                              >
                                {row.category}
                              </Link>
                            ) : (
                              // Spending filed under no category, muted as the
                              // register and the queue show the same word.
                              <span className="subtle">{row.category}</span>
                            )}{" "}
                            {row.source === "entry" ? (
                              <Badge tone="neutral">This {unitNoun[periodUnit]} only</Badge>
                            ) : null}
                          </th>
                          <td className="align-right money">
                            {row.limit === null ? "—" : formatMoney(row.limit, period.currency)}
                          </td>
                          {carries ? (
                            <>
                              <td className="align-right money">
                                {row.carriedIn === null
                                  ? "—"
                                  : formatMoney(row.carriedIn, period.currency)}
                              </td>
                              <td className="align-right money">
                                {row.available === null
                                  ? "—"
                                  : formatMoney(row.available, period.currency)}
                              </td>
                            </>
                          ) : null}
                          {ranked ? (
                            <td className="align-right money">
                              {row.funded === null ? "—" : formatMoney(row.funded, period.currency)}
                            </td>
                          ) : null}
                          <td className="align-right money">
                            {formatMoney(row.actual, period.currency)}
                          </td>
                          <td
                            className={`align-right money ${
                              row.remaining !== null && isNegativeMoney(row.remaining)
                                ? "money-negative"
                                : ""
                            }`}
                          >
                            {row.remaining === null
                              ? "—"
                              : formatMoney(row.remaining, period.currency)}
                          </td>
                          <td>
                            <div className="budget-progress">
                              <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                              {row.limit === null ? null : (
                                <div
                                  className="budget-bar"
                                  data-state={state}
                                  role="img"
                                  aria-label={`${formatMoney(
                                    row.actual,
                                    period.currency,
                                  )} of ${formatMoney(row.limit, period.currency)} spent`}
                                >
                                  <span
                                    style={{
                                      width: `${fillPercent(row.available ?? row.limit, row.actual)}%`,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="row-actions">
                            {row.categoryId === null ? null : (
                              <button
                                type="button"
                                aria-label={overrideLabel(
                                  row.source === "entry",
                                  row.category,
                                  periodName(periodUnit, period.periodStart),
                                )}
                                onClick={() =>
                                  openOverride(
                                    { categoryId: row.categoryId! },
                                    row.category,
                                    period,
                                    row.limit,
                                  )
                                }
                              >
                                <CalendarCog size={16} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
      {report.data?.rollover ? (
        <Note>
          Carried-in figures were worked out from {formatDate(report.data.rollover.from)} onward.
          {report.data.rollover.clipped
            ? " That is as far back as this page looks, so the carry starts from nothing there rather than from the beginning of the budget."
            : ""}
        </Note>
      ) : null}

      {entries.isError ? (
        <Alert kind="error">
          Single-period amounts could not be loaded, so any that exist are not shown and the rows
          above may be overridden without saying so. {(entries.error as Error).message}
        </Alert>
      ) : null}

      <section className="panel">
        <header className="panel-header">
          <h2>What happens next</h2>
          <span className="subtle">
            {forecastBasis === "recurring"
              ? "Projected from your recurring transactions."
              : forecastBasis === "recurring_and_budgets"
                ? "Projected from your recurring transactions and what your budgets intend."
                : "Projected from your recurring transactions and what recent months actually did."}{" "}
            Nothing here has happened yet, and none of it is a balance.
          </span>
        </header>
        {/* Bare controls with their own labels, like every other view control in
            the app. A `Field` stacks a label above and made this bar half again
            as tall as the one at the top of the page — §7.6. */}
        <div className="option-bar" role="group" aria-label="Projection options">
          <div className="option-bar-title">
            <span>{unitNounPlural[periodUnit]} ahead</span>
          </div>
          <Select
            aria-label={`${unitNounPlural[periodUnit]} ahead`}
            value={forecastPeriods}
            onChange={(event) => setForecastPeriods(event.target.value)}
          >
            {["3", "6", "12", "24"].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </Select>
          <div className="option-bar-title">
            <span>Counting</span>
          </div>
          <Select
            aria-label="Counting"
            value={forecastBasis}
            onChange={(event) => setForecastBasis(event.target.value as Forecast["basis"])}
          >
            <option value="recurring_and_history">Recurring plus what you usually spend</option>
            <option value="recurring">Recurring transactions only</option>
            <option value="recurring_and_budgets">Recurring plus what budgets intend</option>
          </Select>
          {/* Only where it changes anything. `lookback` is the window the
              history basis averages over and the other two never read it, so
              offering it beside them would be a control that does nothing —
              and leaving it off the page entirely would make it a request field
              only an agent could set, which is the defect this page just fixed
              one section up for `groupId`. */}
          {forecastBasis === "recurring_and_history" ? (
            <>
              <div className="option-bar-title">
                <span>Averaged over</span>
              </div>
              <Select
                aria-label="Averaged over"
                value={forecastLookback}
                onChange={(event) => setForecastLookback(event.target.value)}
              >
                {["3", "6", "12"].map((count) => (
                  <option key={count} value={count}>
                    {count} {unitNoun[periodUnit]}s
                  </option>
                ))}
              </Select>
            </>
          ) : null}
        </div>
        {forecast.isError ? (
          <Alert kind="error">
            The projection could not be worked out, so nothing here is a projection of anything.{" "}
            {(forecast.error as Error).message}
          </Alert>
        ) : forecast.isPending ? (
          <Skeleton height={120} label="Loading the projection…" />
        ) : forecastIsEmpty ? (
          /* Tested on the figures, not on whether a currency came back. Anybody
             who owns an account has a currency, so the old test never fired:
             a ledger with nothing to project showed a table of zeroes and no
             sentence saying why. */
          <EmptyState
            compact
            icon={TrendingUp}
            title="Nothing to project yet"
            body={
              forecastBasis === "recurring"
                ? "This basis counts recurring transactions alone, and there are none. Set one up, or count what you usually spend instead."
                : forecastBasis === "recurring_and_budgets"
                  ? "This basis counts recurring transactions and budgets, and there are neither."
                  : "There is no spending or income behind this yet — a finished period has to have something in it before an average means anything."
            }
          />
        ) : (
          (forecast.data?.currencies ?? []).map((currency) => (
            <div
              className="table-wrap"
              key={currency.currency}
              tabIndex={0}
              role="region"
              aria-label={`Projected balances in ${currency.currency}`}
            >
              <table className="data-table">
                {/* On screen, not only to a screen reader. One of these per
                    currency stacks up as identical tables of figures, and with
                    the caption hidden nothing visible said which money each
                    one was counting. */}
                <caption className="table-caption">
                  Projected balances in {currency.currency}
                  {forecast.data ? `, from ${formatDate(forecast.data.from)}` : ""}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{unitNoun[periodUnit]}</th>
                    <th scope="col" className="align-right">
                      Expected in
                    </th>
                    <th scope="col" className="align-right">
                      Expected out
                    </th>
                    <th scope="col" className="align-right">
                      Budgets intend
                    </th>
                    {/* Only under the pessimistic basis, where the figure is
                        part of the arithmetic on screen: it is the slice of
                        each budget no recurrence covers, which is exactly what
                        that basis adds to the spending column. */}
                    {forecastBasis === "recurring_and_budgets" ? (
                      <th scope="col" className="align-right">
                        Of that, unscheduled
                      </th>
                    ) : null}
                    {/* The same rule one basis over: under the history basis
                        this is the part of the two money columns that came from
                        an average rather than from a date, and a reader who
                        cannot separate the two cannot tell a projection from a
                        schedule. */}
                    {forecastBasis === "recurring_and_history" ? (
                      <th scope="col" className="align-right">
                        Of that, typical
                      </th>
                    ) : null}
                    <th scope="col" className="align-right">
                      Scheduled
                    </th>
                    <th scope="col" className="align-right">
                      Projected balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {currency.periods.map((period) => (
                    <tr key={period.periodStart}>
                      <th scope="row">{periodName(periodUnit, period.periodStart)}</th>
                      <td className="align-right money">
                        {formatMoney(period.expectedIncome, currency.currency)}
                      </td>
                      <td className="align-right money">
                        {formatMoney(period.expectedSpending, currency.currency)}
                      </td>
                      <td className="align-right money">
                        {formatMoney(period.budgetedSpending, currency.currency)}
                      </td>
                      {forecastBasis === "recurring_and_budgets" ? (
                        <td className="align-right money">
                          {formatMoney(period.uncoveredBudget, currency.currency)}
                        </td>
                      ) : null}
                      {forecastBasis === "recurring_and_history" ? (
                        <td className="align-right money">
                          {formatMoney(period.typicalSpending, currency.currency)} out,{" "}
                          {formatMoney(period.typicalIncome, currency.currency)} in
                        </td>
                      ) : null}
                      <td className="align-right">{period.occurrences}</td>
                      <td className="align-right money">
                        {formatMoney(period.projectedBalance, currency.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
        {(forecast.data?.unprojectable ?? []).length > 0 ? (
          <Alert kind="info">
            {(forecast.data?.unprojectable ?? []).map((entry) => entry.name).join(", ")} could not
            be projected, so the figures above are short by whatever they are worth. A recurring
            transaction with no amount proposes a row for you to fill in rather than a figure
            anything can project.
          </Alert>
        ) : null}
        {(forecast.data?.otherPeriodUnits ?? []).length > 0 ? (
          <Alert kind="info">
            You also budget by {(forecast.data?.otherPeriodUnits ?? []).join(" and ")}, and this
            projection reads only {unitNoun[periodUnit].toLowerCase()}ly budgets. Change "Budgeting
            by" above to see what the others intend.
          </Alert>
        ) : null}
      </section>
    </>
  );
}
