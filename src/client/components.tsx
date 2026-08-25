import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SortDirection } from "../shared/domain.js";
import type { DatePreset } from "./date-range.js";
import { useDateRange } from "./date-range.js";

export type SortState<Field extends string> = {
  field: Field;
  direction: SortDirection;
};

/**
 * Which way a column should go when it is first clicked. Text reads naturally
 * from A, while dates and amounts are nearly always wanted largest first.
 */
export type SortLean = "ascending" | "descending";

/**
 * A column heading that orders the list. Clicking the active column turns it
 * around; clicking another takes it over at that column's natural direction.
 *
 * `aria-sort` on the header and the wording in the button label are what a
 * screen reader announces, so the current order is audible rather than only
 * visible in the arrow.
 */
export function SortableHeader<Field extends string>({
  field,
  label,
  sort,
  onSort,
  lean = "ascending",
  className,
}: {
  field: Field;
  label: string;
  sort: SortState<Field>;
  onSort: (next: SortState<Field>) => void;
  lean?: SortLean;
  className?: string;
}) {
  const active = sort.field === field;
  const direction = active ? sort.direction : lean === "descending" ? "desc" : "asc";
  const next: SortState<Field> = active
    ? { field, direction: sort.direction === "asc" ? "desc" : "asc" }
    : { field, direction };
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    // Every sortable column is a column header, and saying so is what lets a
    // screen reader announce "Payee, column 2" while walking a row. One
    // attribute here covers every sortable column in the product, which is why
    // the fix belongs in this component rather than at each table.
    <th
      scope="col"
      className={className}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={`sort-header ${active ? "sorted" : ""}`}
        onClick={() => onSort(next)}
      >
        <span>{label}</span>
        <Icon size={13} aria-hidden="true" />
        <span className="sr-only">
          {active
            ? `Sorted ${sort.direction === "asc" ? "ascending" : "descending"}. Activate to sort ${next.direction === "asc" ? "ascending" : "descending"}.`
            : `Activate to sort by ${label}.`}
        </span>
      </button>
    </th>
  );
}

/**
 * The same ordering control for lists that are not tables and so have no
 * headings to click.
 */
export function SortMenu<Field extends string>({
  fields,
  sort,
  onSort,
  label = "Sort by",
}: {
  fields: readonly { field: Field; label: string }[];
  sort: SortState<Field>;
  onSort: (next: SortState<Field>) => void;
  label?: string;
}) {
  const id = useId();
  const active = fields.find((entry) => entry.field === sort.field);
  return (
    <div className="sort-menu">
      <label htmlFor={id}>{label}</label>
      <Select
        id={id}
        value={sort.field}
        onChange={(event) =>
          onSort({ field: event.target.value as Field, direction: sort.direction })
        }
      >
        {fields.map((entry) => (
          <option key={entry.field} value={entry.field}>
            {entry.label}
          </option>
        ))}
      </Select>
      <button
        type="button"
        className="sort-direction"
        onClick={() =>
          onSort({
            field: sort.field,
            direction: sort.direction === "asc" ? "desc" : "asc",
          })
        }
      >
        {sort.direction === "asc" ? (
          <ArrowUp size={14} aria-hidden="true" />
        ) : (
          <ArrowDown size={14} aria-hidden="true" />
        )}
        <span className="sr-only">
          {`${active?.label ?? "Sort"} is ${sort.direction === "asc" ? "ascending" : "descending"}. Activate to reverse it.`}
        </span>
      </button>
    </div>
  );
}

/**
 * Orders rows in the browser, for lists the server returns whole. Text compares
 * the way a person reads it, so "Zoe" follows "apple" rather than preceding it,
 * and blanks always settle at the end whichever way the sort runs.
 */
export function compareForSort(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  direction: SortDirection,
) {
  const leftBlank = left === null || left === undefined || left === "";
  const rightBlank = right === null || right === undefined || right === "";
  if (leftBlank || rightBlank) {
    return leftBlank && rightBlank ? 0 : leftBlank ? 1 : -1;
  }
  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction === "asc" ? order : -order;
}

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

/** Page numbers around the current page, with gaps collapsed to an ellipsis. */
function pageWindow(page: number, totalPages: number): (number | "gap")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const near = [page - 1, page, page + 1].filter((value) => value > 1 && value < totalPages);
  const shown = [...new Set([1, ...near, totalPages])].sort((a, b) => a - b);
  return shown.flatMap((value, index) =>
    index > 0 && value - shown[index - 1]! > 1 ? (["gap", value] as (number | "gap")[]) : [value],
  );
}

export function Pagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
  itemLabel,
  busy = false,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemLabel: string;
  busy?: boolean;
}) {
  if (!totalCount) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalCount);
  return (
    <nav className="pagination" aria-label={`${itemLabel} pages`}>
      <p className="pagination-summary" aria-live="polite">
        {`Showing ${first}–${last} of ${totalCount} ${itemLabel}`}
      </p>
      {totalPages > 1 ? (
        <div className="pagination-pages">
          <button
            type="button"
            className="pagination-step"
            aria-label="Previous page"
            disabled={page <= 1 || busy}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          {pageWindow(page, totalPages).map((entry, index) =>
            entry === "gap" ? (
              <span key={`gap-${index}`} className="pagination-gap" aria-hidden>
                &hellip;
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className="pagination-page"
                aria-label={`Page ${entry}`}
                aria-current={entry === page ? "page" : undefined}
                disabled={busy}
                onClick={() => onPageChange(entry)}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            className="pagination-step"
            aria-label="Next page"
            disabled={page >= totalPages || busy}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      ) : null}
    </nav>
  );
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
    // A spinner is a picture of waiting, which is nothing at all to somebody who
    // cannot see it. `aria-busy` says the control is working and the `.sr-only`
    // word says so in text, because a disabled button otherwise goes silent at
    // exactly the moment a person most wants to know their click landed.
    <button
      {...props}
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
      className={`button button-${variant} ${className}`}
    >
      {loading ? <LoaderCircle size={16} className="animate-spin" /> : null}
      {loading ? <span className="sr-only">Working…</span> : null}
      {children}
    </button>
  );
}

/**
 * The standing instruction for a form: what is required, said once.
 *
 * This product marks the optional fields rather than the required ones, which
 * is a coherent scheme and the less cluttered of the two — but only if it is
 * stated, because a person meeting an unmarked field has no way to know which
 * scheme they are in. W3C puts an instruction covering a whole form before the
 * form, which is where this goes.
 *
 * It is a sentence rather than a legend or an asterisk key because there is no
 * asterisk to explain: nothing here is starred.
 */
export function RequiredNote() {
  return <p className="required-note">Every field is required unless it says otherwise.</p>;
}

export function Field({
  label,
  hint,
  children,
}: PropsWithChildren<{ label: string; hint?: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={`input ${props.className ?? ""}`} />;
  },
);

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

/**
 * The overflow menu on a row, as a native disclosure.
 *
 * The popover is positioned fixed rather than absolute, which the accounts
 * cards do not need but a table row does: `.table-card` scrolls horizontally,
 * and an absolutely positioned popover inside it is clipped by that scroll
 * container and cannot be read. The trade is that a fixed popover does not
 * travel with the page, so it closes on scroll and resize rather than drifting
 * away from the row it belongs to.
 *
 * Deliberately not `role="menu"`. Those roles promise a screen reader arrow-key
 * navigation, and a roving tabindex exists nowhere else in this client. A
 * disclosure that behaves like a disclosure is honest; menu roles without the
 * keyboard behaviour they imply are worse than none.
 */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const close = (returnFocus = false) => {
    if (!details.current?.open) return;
    details.current.open = false;
    if (returnFocus) summary.current?.focus();
  };

  useEffect(() => {
    const element = details.current;
    if (!element) return;
    const onToggle = () => {
      if (!element.open || !summary.current) {
        setAnchor(null);
        return;
      }
      const rect = summary.current.getBoundingClientRect();
      setAnchor({ top: rect.bottom + 5, right: window.innerWidth - rect.right });
    };
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: Event) => {
      if (!details.current?.contains(event.target as Node)) close();
    };
    const onReflow = () => close();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    // Capturing, so a scroll inside the table is caught as well as the page's.
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [anchor]);

  return (
    <details className="menu" ref={details}>
      {/* The role and expanded state are spelled out rather than left to the
          browser's own mapping for a summary, which assistive technology does
          not report consistently. What it does natively is exactly this. */}
      <summary ref={summary} role="button" aria-expanded={Boolean(anchor)} aria-label={label}>
        <MoreHorizontal size={18} />
      </summary>
      {/* A keyboard user activating one of the buttons inside dispatches a
          click that bubbles to here, so this handler already serves them; the
          div is a catcher for its children's events, not a control of its own.
          Both rules read it as a mouse-only affordance. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="menu-popover row-menu-popover"
        style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
        // Choosing something closes the menu. Without this it stays open behind
        // whatever the choice opened, and is still there afterwards.
        onClick={() => close()}
      >
        {children}
      </div>
    </details>
  );
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
        {children ? <div className="modal-body">{children}</div> : null}
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

/**
 * Asks before something irreversible happens, in the app's own dialog rather
 * than the browser's. The browser's box cannot say what is about to be deleted
 * beyond a line of text, cannot be read by anything styling the page, and on
 * some platforms offers to suppress itself entirely, which would silently
 * approve every later deletion.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children ?? null}
    </Modal>
  );
}

/**
 * Holds what a confirmation is about while its dialog is open, so the caller
 * writes `ask(thing, run)` instead of threading its own open flag and payload
 * through component state.
 */
export function useConfirm<T>() {
  const [pending, setPending] = useState<{ value: T; run: () => void } | null>(null);
  return {
    value: pending?.value ?? null,
    open: pending !== null,
    ask: (value: T, run: () => void) => setPending({ value, run }),
    cancel: () => setPending(null),
    confirm: () => {
      pending?.run();
      setPending(null);
    },
  };
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
        onChange={(event) => setRange({ start: event.target.value, end, preset: "custom" })}
      />
      <span className="date-separator">to</span>
      <Input
        aria-label="End date"
        type="date"
        value={end}
        onChange={(event) => setRange({ start, end: event.target.value, preset: "custom" })}
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

/**
 * One toggleable field in a mass edit: the checkbox that opts the field in, and
 * whatever control sets its value.
 *
 * The wrapper and the toggle are identical for every field on both screens; the
 * controls are not, because a committed row and a staged one offer different
 * accounts and refuse for different reasons. So the shared part is here and the
 * control stays at the call site.
 */
export function BulkEditToggle({
  label,
  enabled,
  onToggle,
  disabled = false,
  children,
}: PropsWithChildren<{
  label: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}>) {
  return (
    <div className={enabled ? "bulk-edit-field enabled" : "bulk-edit-field"}>
      <label className="bulk-edit-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {children}
    </div>
  );
}

/**
 * Stands in for content while it loads. Without it the empty state shows first,
 * so a page with plenty of data still greets you with "nothing here yet" for as
 * long as the request takes.
 *
 * The shimmer is `aria-hidden`, because a picture of a paragraph is not a
 * paragraph. That left a gap when the loading sentences this replaced were
 * retired: they said "Loading accounts…" out loud and the shimmer said nothing,
 * so somebody using a screen reader met silence where the page had been. The
 * `label` is that sentence, kept, in a live region that announces once.
 *
 * Pass `label` on the first skeleton of a group and leave it off the rest — a
 * list of eight rows should say "Loading transactions…" once, not eight times.
 */
export function Skeleton({ height = 16, label }: { height?: number; label?: string }) {
  return (
    <>
      <span className="skeleton" style={{ height, width: "100%" }} aria-hidden="true" />
      {label ? (
        <span className="sr-only" role="status">
          {label}
        </span>
      ) : null}
    </>
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
