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

/** Only the plural is irregular enough to be worth a second map. */
const unitNounPlural: Record<BudgetPeriodUnitName, string> = {
  week: "Weeks",
  month: "Months",
  quarter: "Quarters",
  year: "Years",
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
  // Against what there was to spend, which for an envelope is its limit plus
  // what it carried in. `remaining` already counts the carry, so a bar drawn
  // against the bare limit disagreed with the word beside it: a category that
  // had rolled money forward showed "nearly there" while its own figure said
  // most of the money was still available.
  if (fillPercent(row.available ?? row.limit, row.actual) >= 80) return "close" as const;
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
          // in either position while the two behaviours differ by every penny
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
          amount: targetAmount === "" && rule !== "average" && rule !== "income" ? amount : "0",
          currency,
          periodUnit,
          activeFrom,
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
  // Its own vocabulary, and deliberately: a projection is not a balance, and
  // the panel that shows one says "projected" everywhere the rest of the page
  // says "spent".
  const [forecastPeriods, setForecastPeriods] = useState("6");
  const [forecastBasis, setForecastBasis] = useState<Forecast["basis"]>("recurring");
  const forecast = useQuery({
    queryKey: ["forecast", periodUnit, forecastPeriods, forecastBasis],
    queryFn: () =>
      api<Forecast>(
        `/api/v1/forecast?${queryString({
          periodUnit,
          periods: forecastPeriods,
          basis: forecastBasis,
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
        {/* The guide has promised this since the first budget shipped and the
            page never had it: the API took `includeUnbudgeted` and only an
            agent could send it. */}
        <label className="date-bar-check">
          <input
            type="checkbox"
            checked={includeUnbudgeted}
            onChange={(event) => setIncludeUnbudgeted(event.target.checked)}
          />
          Show categories with no budget
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
          {targetAmount === "" && rule !== "average" && rule !== "income" ? (
            <Field
              label="Amount"
              hint={rule === "step" ? "The first period's amount, before the increase." : undefined}
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
                <option value="fixed">The amount above, every period</option>
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
          <Field label="Saving up for (optional)">
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
          {target.startsWith("group:") ? null : (
            <Field
              label="Funded first (optional)"
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
          // Same rule as the carry columns: the funded figure appears only
          // where somebody set an order, so a ledger that never did is not told
          // its budgets are unfunded because income landed in another period.
          const ranked = period.unfunded !== null;
          return (
            <div className="panel" key={`${period.periodStart}:${period.currency}`}>
              <div className="panel-header">
                <h3>
                  {periodName(periodUnit, period.periodStart)}, {period.currency}
                  {period.partial ? " (so far)" : ""}
                </h3>
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
              </div>
              {period.groups.length > 0 ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <caption className="sr-only">
                      Groups for {period.start} to {period.end} in {period.currency}
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
                          </th>
                          <td className="align-right money">
                            {group.limit === null ? "—" : formatMoney(group.limit, period.currency)}
                          </td>
                          <td className="align-right money">
                            {formatMoney(group.actual, period.currency)}
                          </td>
                          <td className="align-right money">
                            {group.remaining === null
                              ? "—"
                              : formatMoney(group.remaining, period.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
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
                          {ranked ? (
                            <td className="align-right money">
                              {row.funded === null ? "—" : formatMoney(row.funded, period.currency)}
                            </td>
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
                                      width: `${fillPercent(row.available ?? row.limit, row.actual)}%`,
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
          <h3>What happens next</h3>
          <span className="subtle">
            Projected from your recurring transactions. Nothing here has happened yet, and none of
            it is a balance.
          </span>
        </div>
        <div className="date-bar">
          <Field label={`${unitNounPlural[periodUnit]} ahead`}>
            <Select
              value={forecastPeriods}
              onChange={(event) => setForecastPeriods(event.target.value)}
            >
              {["3", "6", "12", "24"].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Counting">
            <Select
              value={forecastBasis}
              onChange={(event) => setForecastBasis(event.target.value as Forecast["basis"])}
            >
              <option value="recurring">Recurring transactions only</option>
              <option value="recurring_and_budgets">Recurring plus what budgets intend</option>
            </Select>
          </Field>
        </div>
        {forecast.isError ? (
          <Alert kind="error">
            The projection could not be worked out, so nothing below is a projection of anything.{" "}
            {(forecast.error as Error).message}
          </Alert>
        ) : forecast.isPending ? (
          <Skeleton height={120} />
        ) : (forecast.data?.currencies ?? []).length === 0 ? (
          <p className="settings-note">
            Nothing to project yet. A forecast comes from recurring transactions, so set one up and
            this fills in.
          </p>
        ) : (
          (forecast.data?.currencies ?? []).map((currency) => (
            <div className="table-wrap" key={currency.currency}>
              <table className="data-table">
                <caption className="sr-only">
                  Projected balances in {currency.currency}, from {forecast.data?.from}
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
      </div>

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
                        : "Worked out"}
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
                        Change {plan.targetName}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => remove.ask(plan, () => deletePlan.mutate(plan))}
                      >
                        Delete {plan.targetName}
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
        title={editing ? `Budget for ${editing.targetName}` : "Budget"}
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
        {editing && editing.amountRule !== "fixed" && editing.amountRule !== "incremental" ? (
          <p className="settings-note">
            {editing.amountRule === "sinking_fund"
              ? `This one is saving ${formatMoney(editing.targetAmount ?? "0", editing.currency)} by ${periodName(editing.periodUnit, editing.targetDate ?? editing.activeFrom)}, and works out its own amount each ${unitNoun[editing.periodUnit]}.`
              : editing.amountRule === "trailing_average"
                ? `This one budgets the average of the last ${editing.lookbackPeriods} ${unitNoun[editing.periodUnit]}s, so it works out its own amount and there is nothing here to type.`
                : `This one takes ${editing.percentOfIncome}% of the income before it, so it works out its own amount and there is nothing here to type.`}{" "}
            Delete it and set a plain budget if that is not what you want.
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
                    <th scope="row">{entry.targetName}</th>
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
                        Remove {entry.targetName} override
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
          remove.value ? `Delete the ${remove.value.targetName} budget?` : "Delete this budget?"
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
