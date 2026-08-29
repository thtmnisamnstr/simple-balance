import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Target } from "lucide-react";
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
  type BudgetReportRow,
  type Category,
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
  Modal,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useConfirm,
} from "../components.js";
import { useDateRange } from "../date-range.js";
import { compareMoney, formatDate, formatMoney, isNegativeMoney, moneyUnits } from "../money.js";

const periodUnits: { value: BudgetPeriodUnitName; label: string }[] = [
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
];

/**
 * The period a stored date names, written the way somebody would say it.
 *
 * Both ends of a window are stored as the first day of a period, so printing
 * one raw says "to 1 June" about a budget that covers all of June, and a budget
 * covering exactly one month reads as a single day. The date is right; it is
 * the name of a period rather than a boundary, so it is rendered as one.
 */
function periodName(unit: BudgetPeriodUnitName, isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const at = new Date(Date.UTC(year!, month! - 1, day!));
  const month_ = at.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  if (unit === "month") return month_;
  if (unit === "year") return String(year);
  if (unit === "quarter") return `Q${Math.floor((month! - 1) / 3) + 1} ${year}`;
  return `week of ${formatDate(isoDate)}`;
}

const unitNoun: Record<BudgetPeriodUnitName, string> = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/**
 * How far through a limit the spending has got, as a width.
 *
 * Clamped at a hundred, because a bar that runs off the panel says less than
 * one that is full beside a number saying how far over. The number is always
 * there and is what anybody reads; the bar is the glance.
 */
function fillPercent(limit: string, actual: string) {
  // Scaled units rather than Number, because these are money. The float only
  // appears at the very end, where the answer is a CSS width and lossiness is
  // the same lossiness a pixel already is. `moneyRatioPercent` is the wrong
  // helper here: it floors at four percent so a chart bar stays visible, and a
  // budget nobody has spent against must read as nothing, not as a sliver.
  const cap = moneyUnits(limit);
  const spent = moneyUnits(actual);
  if (spent === null || spent <= 0n) return 0;
  if (cap === null || cap <= 0n) return 100;
  const hundredths = (spent * 10_000n) / cap;
  return Math.min(100, Number(hundredths) / 100);
}

/**
 * What the row is doing, as a word.
 *
 * A word rather than only a colour, because colour alone fails anybody who
 * cannot separate the two and it fails everybody in a printout. The bar takes
 * its colour from this, so the two can never disagree.
 */
function rowState(row: BudgetReportRow, partial = false) {
  if (row.limit === null || row.remaining === null) return "unbudgeted" as const;
  // Compared as money rather than as floats. Which side of a limit somebody is
  // on is a decision, and eighteen fractional digits do not survive a float.
  if (isNegativeMoney(row.remaining)) return "over" as const;
  // Spent exactly the limit is neither over nor nearly there. Saying "nearly"
  // to somebody who has spent all of it is the sort of small wrongness that
  // makes a person stop trusting the rest of the page.
  if (compareMoney(row.remaining, "0") === 0) return "spent" as const;
  // While a period is still running, "within budget" is a claim about a month
  // that has not finished. Over is still over, and spent is still spent, but
  // there is nothing to say yet about the rest.
  if (partial) return "running" as const;
  if (fillPercent(row.limit, row.actual) >= 80) return "close" as const;
  return "within" as const;
}

const stateLabel = {
  running: "So far",
  over: "Over",
  spent: "All spent",
  close: "Nearly there",
  within: "Within budget",
  unbudgeted: "No budget",
} as const;

const stateTone = {
  running: "blue",
  over: "red",
  spent: "amber",
  close: "amber",
  within: "green",
  unbudgeted: "neutral",
} as const;

export default function BudgetsPage({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const { start, end } = useDateRange();
  const [periodUnit, setPeriodUnit] = useState<BudgetPeriodUnitName>("month");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Defaults to counting it, matching the server: a budget's limit was never
  // scoped to an account, so money spent on a card since closed is money the
  // budget covered.
  const [includeArchived, setIncludeArchived] = useState(true);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  // Somebody with one currency should never have to type it. It is still a
  // field rather than a fixed value, because a ledger holding two currencies
  // budgets in both and there is no total across them to fall back on.
  const [currency, setCurrency] = useState(session.preferences.defaultCurrency);
  const [activeFrom, setActiveFrom] = useState("");
  // Three fields and one checkbox, because they are one decision: what happens
  // to the difference at the end of a period. The words "envelope", "sinking
  // fund" and "rollover budget" appear nowhere — a budget is what it says it
  // is, and naming the method would make it a mode somebody has to pick.
  const [rollover, setRollover] = useState(false);
  const [rolloverCap, setRolloverCap] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const remove = useConfirm<BudgetPlan>();
  const [editing, setEditing] = useState<BudgetPlan | null>(null);
  const [override, setOverride] = useState<{
    categoryId: string;
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

  const report = useQuery({
    queryKey: ["budgets", "report", start, end, periodUnit, includeArchived],
    queryFn: () =>
      api<BudgetReport>(
        `/api/v1/budget-report?${queryString({
          start,
          end,
          periodUnit,
          // Always sent, both ways. `queryString` drops a falsy value, so
          // sending only "true" meant unchecked sent nothing and fell through
          // to the server default, which is now true: the box changed nothing
          // in either position while the two behaviours differ by every penny
          // spent through a closed account.
          includeArchived: includeArchived ? "true" : "false",
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
          categoryId,
          // A fund works out its own figure each period, so the amount box is
          // hidden and zero is what the server is told. Sending what was typed
          // would be a number nothing reads.
          amount: targetAmount === "" ? amount : "0",
          currency,
          periodUnit,
          activeFrom,
          rollover,
          ...(rollover && rolloverCap !== "" ? { rolloverCap } : {}),
          ...(targetAmount !== "" ? { targetAmount, targetDate } : {}),
        }),
      ),
    onSuccess: (plan) => {
      setError("");
      setNotice(
        `Budgeting ${formatMoney(plan.amount, plan.currency)} for ${plan.categoryName} every ${unitNoun[plan.periodUnit]}, from ${formatDate(plan.activeFrom)}.`,
      );
      setCategoryId("");
      setAmount("");
      setRolloverCap("");
      setTargetAmount("");
      setTargetDate("");
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
          categoryId: override!.categoryId,
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
    onSuccess: () => {
      setError("");
      setOverride(null);
      invalidate();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const deletePlan = useMutation({
    mutationFn: (plan: BudgetPlan) =>
      api<{ id: string }>(`/api/v1/budget-plans/${plan.id}`, {
        ...json({ expectedVersion: plan.version }),
        method: "DELETE",
      }),
    onSuccess: () => {
      setError("");
      invalidate();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  // Only categories that can carry spending. An income category has nothing for
  // a limit to be compared against, and the server refuses one, so offering it
  // here would be a refusal nobody could see the cause of.
  const budgetable = (categories.data ?? []).filter(
    (category) => category.kind !== "income" && !category.archivedAt,
  );

  const entryFor = (categoryId: string | null, currency: string, periodStart: string) =>
    (entries.data ?? []).find(
      (entry) =>
        entry.categoryId === categoryId &&
        entry.currency === currency &&
        entry.periodUnit === periodUnit &&
        entry.periodStart === periodStart,
    ) ?? null;

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

  return (
    <div className="page">
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
      <div className="date-bar" aria-label="Budget view">
        <div className="date-bar-title">
          <Target size={17} />
          <span>Budgeting by</span>
        </div>
        <Select
          aria-label="Budget period"
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
        <label className="date-bar-check">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Count spending through closed accounts
        </label>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Set a budget</h3>
        </div>
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
          <Field label="Category">
            <Select
              required
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Choose a category</option>
              {budgetable.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          {targetAmount === "" ? (
            <Field label="Amount">
              <Input
                required
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="200.00"
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
          <Field label="Saving up for (optional)">
            <Input
              inputMode="decimal"
              value={targetAmount}
              onChange={(event) => {
                setTargetAmount(event.target.value);
                // A fund keeps what it saves or it is not saving. Turning the
                // carry on here rather than refusing the form later is the
                // difference between a rule and an obstacle.
                if (event.target.value !== "") setRollover(true);
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
          <label className="date-bar-check">
            <input
              type="checkbox"
              checked={rollover}
              disabled={targetAmount !== ""}
              onChange={(event) => setRollover(event.target.checked)}
            />
            Carry what is left over into the next {unitNoun[periodUnit]}
          </label>
          {rollover ? (
            <Field label="Most to carry (optional)">
              <Input
                inputMode="decimal"
                value={rolloverCap}
                onChange={(event) => setRolloverCap(event.target.value)}
                placeholder="No limit"
              />
            </Field>
          ) : null}
          <Button type="submit" loading={createPlan.isPending}>
            Set budget
          </Button>
        </form>
        <p className="settings-note">
          One budget covers every {unitNoun[periodUnit]} from the date it starts, so there is
          nothing to set again next {unitNoun[periodUnit]}. To change it later without rewriting
          what past {unitNoun[periodUnit]}s intended, end this one and start another.
        </p>
        <p className="settings-note">
          {targetAmount === ""
            ? rollover
              ? `What this ${unitNoun[periodUnit]} does not spend is added to the next one, and anything overspent is taken off it. Nothing is stored ${unitNoun[periodUnit]} by ${unitNoun[periodUnit]}: the figures are worked out from what you budgeted and what you spent, so turning this off leaves nothing behind.`
              : `Each ${unitNoun[periodUnit]} starts again at the amount. Tick the box to carry the difference forward instead.`
            : `Each ${unitNoun[periodUnit]} puts aside what is still needed, divided by the ${unitNoun[periodUnit]}s left before the date. There is no amount to type: the figure changes as the fund fills up, and stops once it is full.`}
        </p>
      </div>

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
          The budget figures could not be loaded, so nothing below is a report of anything.{" "}
          {(report.error as Error).message}
        </Alert>
      ) : report.isPending ? (
        <div className="panel">
          <Skeleton height={140} />
        </div>
      ) : periods.length === 0 ? (
        <EmptyState
          icon={<Target size={20} />}
          title="Nothing budgeted in this range"
          body="Set a budget above, or widen the dates."
        />
      ) : (
        periods.map((period) => {
          // The carry columns appear only where something carries. A table of
          // dashes says a budget has a feature it does not have, and every
          // ledger that has never ticked the box would grow two of them.
          const carries = period.rows.some((row) => row.carriedIn !== null);
          return (
            <div className="panel" key={`${period.periodStart}:${period.currency}`}>
              <div className="panel-header">
                <h3>
                  {periodName(periodUnit, period.periodStart)}, {period.currency}
                  {period.partial ? " (so far)" : ""}
                </h3>
                <span className="subtle">
                  {formatMoney(period.budgeted, period.currency)} budgeted.{" "}
                  {carries
                    ? `${formatMoney(period.carriedIn, period.currency)} carried in, ${formatMoney(period.available, period.currency)} available. `
                    : ""}
                  {formatMoney(period.spent, period.currency)} spent in total, budgeted or not.
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="sr-only">
                    Budget against spending for {period.start} to {period.end} in {period.currency}
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
                            {row.category}{" "}
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
                          <td className="align-right money">
                            {formatMoney(row.actual, period.currency)}
                          </td>
                          <td className="align-right money">
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
                                      width: `${fillPercent(row.limit, row.actual)}%`,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="align-right">
                            {row.categoryId === null ? null : (
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  const existing = entryFor(
                                    row.categoryId,
                                    period.currency,
                                    period.periodStart,
                                  );
                                  setOverride({
                                    categoryId: row.categoryId!,
                                    category: row.category,
                                    currency: period.currency,
                                    periodStart: period.periodStart,
                                    existing,
                                  });
                                  setOverrideAmount(existing?.amount ?? row.limit ?? "");
                                }}
                              >
                                {row.source === "entry"
                                  ? "Change this " + unitNoun[periodUnit]
                                  : "Just this " + unitNoun[periodUnit]}
                              </Button>
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
        <p className="settings-note">
          Carried-in figures were worked out from {formatDate(report.data.rollover.from)} onward.
          {report.data.rollover.clipped
            ? " That is as far back as this page looks, so the carry starts from nothing there rather than from the beginning of the budget."
            : ""}
        </p>
      ) : null}

      <div className="panel">
        <div className="panel-header">
          <h3>Standing budgets</h3>
        </div>
        {plans.isError ? (
          <Alert kind="error">
            The standing budgets could not be loaded, so this is not a list of them.{" "}
            {(plans.error as Error).message}
          </Alert>
        ) : plans.isPending ? (
          <Skeleton height={80} />
        ) : (plans.data ?? []).length === 0 ? (
          <p className="settings-note">No standing budgets yet.</p>
        ) : (
          <div className="table-wrap">
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
                      {plan.categoryName}{" "}
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
                      ) : null}
                    </th>
                    <td className="align-right money">
                      {plan.amountRule === "sinking_fund"
                        ? "Worked out"
                        : formatMoney(plan.amount, plan.currency)}
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
                    <td className="align-right">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditing(plan);
                          setEditAmount(plan.amount);
                          setEditActiveTo(plan.activeTo ?? "");
                          setEditRollover(plan.rollover);
                          setEditRolloverCap(plan.rolloverCap ?? "");
                        }}
                      >
                        Change {plan.categoryName}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => remove.ask(plan, () => deletePlan.mutate(plan))}
                      >
                        Delete {plan.categoryName}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={editing !== null}
        title={editing ? `Budget for ${editing.categoryName}` : "Budget"}
        description="Changing the amount changes every period this budget covers, past ones included. To leave what earlier periods intended alone, give it an end date and set a new budget starting after it."
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={editPlan.isPending}
              onClick={() => {
                startAttempt();
                if (editing) editPlan.mutate(editing);
              }}
            >
              Save budget
            </Button>
          </>
        }
      >
        {error ? <Alert kind="error">{error}</Alert> : null}
        {editing?.amountRule === "sinking_fund" ? (
          <p className="settings-note">
            This one is saving {formatMoney(editing.targetAmount ?? "0", editing.currency)} by{" "}
            {periodName(editing.periodUnit, editing.targetDate ?? editing.activeFrom)}, and works
            out its own amount each {unitNoun[editing.periodUnit]}. Delete it and set a plain budget
            if that is not what you want.
          </p>
        ) : (
          <>
            <Field label="Amount">
              <Input
                inputMode="decimal"
                value={editAmount}
                onChange={(event) => setEditAmount(event.target.value)}
              />
            </Field>
            <label className="date-bar-check">
              <input
                type="checkbox"
                checked={editRollover}
                onChange={(event) => setEditRollover(event.target.checked)}
              />
              Carry what is left over into the next {unitNoun[editing?.periodUnit ?? periodUnit]}
            </label>
            {editRollover ? (
              <Field label="Most to carry" hint="Leave blank for no limit.">
                <Input
                  inputMode="decimal"
                  value={editRolloverCap}
                  onChange={(event) => setEditRolloverCap(event.target.value)}
                />
              </Field>
            ) : null}
          </>
        )}
        <Field label="Ends after" hint="Leave blank to keep running.">
          <Input
            type="date"
            value={editActiveTo}
            onChange={(event) => setEditActiveTo(event.target.value)}
          />
        </Field>
      </Modal>

      {entries.isError ? (
        <Alert kind="error">
          Single-period amounts could not be loaded, so any that exist are not shown and the rows
          above may be overridden without saying so. {(entries.error as Error).message}
        </Alert>
      ) : null}
      {(entries.data ?? []).length > 0 ? (
        <div className="panel">
          <div className="panel-header">
            <h3>Single periods</h3>
          </div>
          {/* Listed because an override set in one period was invisible from
              every other, so it could be created and then lost: the figure it
              changed was somewhere nobody was looking. */}
          <div className="table-wrap">
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
                    <th scope="row">{entry.categoryName}</th>
                    <td className="align-right money">
                      {formatMoney(entry.amount, entry.currency)}
                    </td>
                    <td>{periodName(entry.periodUnit, entry.periodStart)}</td>
                    <td className="align-right">
                      <Button
                        variant="ghost"
                        loading={clearEntry.isPending}
                        onClick={() => clearEntry.mutate(entry)}
                      >
                        Remove {entry.categoryName} override
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Modal
        open={override !== null}
        title={
          override
            ? `${override.category}, ${periodName(periodUnit, override.periodStart)}`
            : "Budget one period"
        }
        description={`An amount for this ${unitNoun[periodUnit]} alone. The standing budget is left exactly as it is, and every other ${unitNoun[periodUnit]} still follows it.`}
        onClose={() => setOverride(null)}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOverride(null)}>
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
            <Button
              type="button"
              loading={setEntry.isPending}
              onClick={() => {
                startAttempt();
                setEntry.mutate();
              }}
            >
              Save
            </Button>
          </>
        }
      >
        {/* Inside the dialog, because a modal is a focus trap: an alert
            rendered on the page behind it is unreachable and unannounced, so
            every refusal of this form was invisible. */}
        {error ? <Alert kind="error">{error}</Alert> : null}
        <Field label="Amount" hint={`Applies to this ${unitNoun[periodUnit]} only.`}>
          <Input
            inputMode="decimal"
            value={overrideAmount}
            onChange={(event) => setOverrideAmount(event.target.value)}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={remove.open}
        title={
          remove.value ? `Delete the ${remove.value.categoryName} budget?` : "Delete this budget?"
        }
        confirmLabel="Delete budget"
        onConfirm={remove.confirm}
        onCancel={remove.cancel}
      >
        It wrote nothing to the books, so deleting it changes no balance and no report. This page
        simply stops comparing against it.
      </ConfirmDialog>
    </div>
  );
}
