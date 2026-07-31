import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  forwardRef,
  useEffect,
  useId,
  useRef,
} from "react";
import type { DatePreset } from "./date-range.js";
import { useDateRange } from "./date-range.js";

/**
 * A checkbox that can also render the mixed state, which React does not expose
 * as a prop. Selection headers use it to show that only part of the list below
 * them is selected.
 */
export function SelectionCheckbox({
  indeterminate = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }) {
  const checkbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={checkbox} type="checkbox" {...props} />;
}

export function Button({
  children,
  variant = "primary",
  loading,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={loading || props.disabled}
      className={`button button-${variant} ${className}`}
    >
      {loading ? <LoaderCircle size={16} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: PropsWithChildren<{ label: string; hint?: string; error?: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input(props, ref) {
  return <input ref={ref} {...props} className={`input ${props.className ?? ""}`} />;
});

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select {...props} className={`input select ${props.className ?? ""}`} />
      <ChevronDown size={15} aria-hidden />
    </span>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea ${props.className ?? ""}`} />;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) dialog.current.showModal();
    if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="modal-card">
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

const presets: { value: DatePreset; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "year-to-date", label: "Year to date" },
  { value: "last-30", label: "Last 30 days" },
  { value: "last-90", label: "Last 90 days" },
  { value: "all-time", label: "All time" },
  { value: "custom", label: "Custom" },
];

export function DateRangeBar() {
  const { start, end, preset, setPreset, setRange } = useDateRange();
  return (
    <div className="date-bar" aria-label="Visible date range">
      <div className="date-bar-title">
        <CalendarDays size={17} />
        <span>Viewing</span>
      </div>
      <Select
        aria-label="Date preset"
        value={preset}
        onChange={(event) => setPreset(event.target.value as DatePreset)}
      >
        {presets.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Start date"
        type="date"
        value={start}
        onChange={(event) =>
          setRange({ start: event.target.value, end, preset: "custom" })
        }
      />
      <span className="date-separator">to</span>
      <Input
        aria-label="End date"
        type="date"
        value={end}
        onChange={(event) =>
          setRange({ start, end: event.target.value, preset: "custom" })
        }
      />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Alert({
  kind = "error",
  children,
}: PropsWithChildren<{ kind?: "error" | "success" | "info" }>) {
  const Icon = kind === "success" ? CheckCircle2 : AlertCircle;
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "green" | "red" | "amber" | "blue" }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function formatMoney(
  amount: string,
  currency: string,
  locales?: string | string[],
) {
  try {
    const match = /^(-?)(\d+)(?:\.(\d{1,18}))?$/.exec(amount);
    if (!match) return `${amount} ${currency}`;

    const [, sign, integer, fraction = ""] = match;
    const baseFormatter = new Intl.NumberFormat(locales, {
      style: "currency",
      currency,
    });
    const fractionDigits = Math.max(
      baseFormatter.resolvedOptions().minimumFractionDigits ?? 0,
      fraction.length,
    );
    const template = new Intl.NumberFormat(locales, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).formatToParts(sign ? -1n : 1n);
    const groupedInteger = new Intl.NumberFormat(locales, {
      useGrouping: true,
      maximumFractionDigits: 0,
    })
      .formatToParts(BigInt(integer))
      .filter((part) => part.type === "integer" || part.type === "group")
      .map((part) => part.value)
      .join("");
    const digitFormatter = new Intl.NumberFormat(locales, {
      useGrouping: false,
      maximumFractionDigits: 0,
    });
    const localizedFraction = [...fraction.padEnd(fractionDigits, "0")]
      .map((digit) => digitFormatter.format(BigInt(digit)))
      .join("");

    let insertedInteger = false;
    return template
      .map((part) => {
        if (part.type === "integer" || part.type === "group") {
          if (insertedInteger) return "";
          insertedInteger = true;
          return groupedInteger;
        }
        if (part.type === "fraction") {
          return localizedFraction;
        }
        return part.value;
      })
      .join("");
  } catch {
    return `${amount} ${currency}`;
  }
}

export function isNegativeMoney(amount: string) {
  return amount.startsWith("-") && !/^-?0(?:\.0+)?$/.test(amount);
}

export function isPositiveMoney(amount: string) {
  return !amount.startsWith("-") && !/^0(?:\.0+)?$/.test(amount);
}

export function moneyRatioPercent(amount: string, maximum: string) {
  const parse = (value: string) => {
    const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value);
    return match ? { integer: match[1], fraction: match[2] ?? "" } : null;
  };
  const numerator = parse(amount);
  const denominator = parse(maximum);
  if (!numerator || !denominator) return "4";

  const scale = Math.max(numerator.fraction.length, denominator.fraction.length);
  const units = (value: { integer: string; fraction: string }) =>
    BigInt(`${value.integer}${value.fraction.padEnd(scale, "0")}`);
  const denominatorUnits = units(denominator);
  if (denominatorUnits === 0n) return "4";

  const hundredthsOfPercent = (units(numerator) * 10_000n) / denominatorUnits;
  const bounded = hundredthsOfPercent > 10_000n ? 10_000n : hundredthsOfPercent;
  const visible = bounded < 400n ? 400n : bounded;
  const whole = visible / 100n;
  const fraction = (visible % 100n)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

export function useSubmit<T>(
  handler: (event: FormEvent<HTMLFormElement>) => Promise<T>,
) {
  return handler;
}
