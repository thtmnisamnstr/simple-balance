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
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SortDirection } from "../shared/domain.js";
import { PROGRESS_VERB, type ProgressEvent } from "../shared/progress.js";
import { errorMessages } from "./api.js";
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
  disabledReason,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  /**
   * Why this button is disabled, in words, beside itself.
   *
   * A submit disabled on a computed predicate is the one control that can go
   * completely silent: nothing has been typed wrongly, so there is no field
   * error, and nothing has been submitted, so there is no summary. Six of them
   * shipped and one had a sentence — the split remainder line, which is the
   * model this generalises.
   *
   * Rendered only while `disabled` is true and `loading` is not, because a
   * button that is working already says so and a reason for that state would
   * be a second answer to a question already answered.
   *
   * Wired with `aria-describedby` rather than left as a neighbouring
   * paragraph: a sighted person reads what is next to the button, and somebody
   * on a screen reader is told the button's name and its state and then has to
   * go looking. The description is what makes "disabled" say why.
   */
  disabledReason?: string;
}) {
  const reasonId = useId();
  const explained = Boolean(disabledReason) && Boolean(props.disabled) && !loading;
  const button = (
    // A spinner is a picture of waiting, which is nothing at all to somebody who
    // cannot see it. `aria-busy` says the control is working and the `.sr-only`
    // word says so in text, because a disabled button otherwise goes silent at
    // exactly the moment a person most wants to know their click landed.
    <button
      {...props}
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
      aria-describedby={explained ? reasonId : props["aria-describedby"]}
      className={`button button-${variant} ${className}`}
    >
      {loading ? <LoaderCircle size={16} className="animate-spin" /> : null}
      {loading ? <span className="sr-only">Working…</span> : null}
      {children}
    </button>
  );
  // Always wrapped, and the wrapper is `display: contents` until there is a
  // reason to show. Wrapping conditionally was the obvious version and it
  // remounts the button every time the reason appears or disappears — which
  // means a focused disabled button loses focus at the moment it becomes
  // usable, the exact defect 13.3 is about. One element in the tree, out of
  // layout when it has nothing to lay out.
  return (
    <span className="button-with-reason">
      {button}
      {explained ? (
        <small className="button-reason" id={reasonId}>
          {disabledReason}
        </small>
      ) : null}
    </span>
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

/**
 * Every sentence a submit failure carried, at the top of the form, with focus.
 *
 * Focus is moved with a ref because nothing reloads. GOV.UK's summary works on
 * the assumption that a page load has already put the person at the top of the
 * document; a single-page app never does, which is exactly what was missing —
 * the message was announced by `role="alert"` and then left up to fifty split
 * rows (`MAX_TRANSACTION_LEGS`) above the button that had just been pressed.
 *
 * `role="alert"` sits on an inner div, following GOV.UK Frontend's own markup,
 * so the live region can mount empty and be populated later while the container
 * around it is what takes focus.
 */
export function ErrorSummary({
  error,
  level = 3,
  children,
}: {
  error: unknown;
  level?: 2 | 3;
  children?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  // The failure itself is the dependency, not the sentences it produced. Two
  // things rule the sentences out. A repeat of a refusal nobody has yet
  // satisfied carries the identical wording, so a person who presses the button
  // again is left at the bottom of the form with nothing having moved; and the
  // pending render that would otherwise blank the set does not commit, because
  // React batches the mutation's `pending` and `error` updates into one render —
  // there is no moment at which the summary is empty. TanStack Query's
  // `failureCount` is no use either: it is reset to 0 on every `mutate()`, so it
  // reads 1 after the second failure exactly as it did after the first. A fresh
  // refusal is a fresh object, which is the one thing that always differs.
  useEffect(() => {
    if (!error) return;
    container.current?.focus();
  }, [error]);
  const messages = errorMessages(error);
  if (!messages.length) return null;
  // Defaults to 3 rather than GOV.UK's fixed 2 because every call site is inside
  // `Modal`, whose title is already an `<h2>` and is the dialog's accessible
  // name; a second `<h2>` in the body reads as a peer section of the dialog
  // rather than as content in it. Same reasoning as `EmptyState`.
  const Heading = level === 2 ? "h2" : "h3";
  // Plain defence against a refusal carrying an unbounded list. No call site
  // reaches it today.
  const shown = messages.slice(0, 10);
  const rest = messages.length - shown.length;
  return (
    <div ref={container} tabIndex={-1} className="alert alert-error error-summary">
      <div role="alert">
        <Heading className="error-summary-title">There is a problem</Heading>
        {shown.length === 1 ? (
          <p>{shown[0]}</p>
        ) : (
          <ul>
            {shown.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        )}
        {rest > 0 ? <p>{`And ${rest} more.`}</p> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * What a `Field` tells the control inside it.
 *
 * Through context rather than by cloning the child. `Field` is used at 96 sites
 * and its children are arbitrary JSX — an `<Input>`, a `<Select>`, a
 * `CategoryPicker` that renders one three levels down — so `cloneElement` would
 * reach the first case and silently miss the rest. A context reaches all of
 * them, wires nothing at the call sites, and costs a `useId` per field.
 *
 * `null` means "there is no single control here to point at": that is the
 * `as="group"` case, where the label belongs to the group and each control
 * inside carries its own name.
 */
type FieldWiring = { id: string; describedBy: string | undefined; invalid: boolean } | null;

const FieldContext = createContext<FieldWiring>(null);

/**
 * A label, a hint, an error, and one control that all three point at.
 *
 * **Binding, SC 1.3.1 and SC 4.1.2.** This was wrong in three ways at once and
 * each was a failure of one of those criteria rather than a preference.
 *
 * It associated its label by *wrapping* the control. W3C's forms tutorial asks
 * for explicit `for`/`id`, and there was exactly one `htmlFor` in the whole
 * client. The wrapper stays — it is what makes the label clickable and what all
 * the CSS is written against — and now carries `htmlFor` naming the control's
 * own `id`, so the association is stated rather than inferred from nesting.
 *
 * Its hint rendered *after* the control, with no `id` and nothing pointing at
 * it, so a screen reader read the label and the control and never the sentence
 * explaining what to type. GOV.UK's order is label, hint, error, input, all
 * wired by `aria-describedby`, and that is the order here. Nothing in WCAG
 * decides where a hint sits; what is Binding is that the control points at it.
 *
 * And it had no error slot at all — zero `aria-invalid` anywhere in the client.
 * A field that is wrong now says so in three places that agree: the sentence,
 * `aria-invalid` on the control, and `aria-describedby` naming the sentence.
 */
export function Field({
  label,
  hint,
  error,
  as,
  children,
}: PropsWithChildren<{
  label: string;
  hint?: string;
  error?: string;
  /**
   * `"group"` for a composite: `CategoryLegs` renders up to fifty rows of three
   * inputs, and a wrapping `<label>` binds to the first of them, so legs two
   * onward had no accessible name while the amounts beside them did. A group
   * names the whole thing and leaves each control to name itself.
   */
  as?: "group";
}>) {
  const base = useId();
  const controlId = `${base}-control`;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    // A `<div>` rather than a wrapping `<label>`, and the hint and the error
    // outside the label rather than inside it. This is not tidiness: a name
    // computed from `<label for>` is the label element's *entire* text content,
    // so a hint inside the label becomes part of the control's name — "Amount
    // Up to eighteen decimal places" — instead of its description. The old
    // markup got away with it because the hint was not associated at all.
    //
    // The cost is that clicking the field's whitespace no longer focuses the
    // control; clicking the label still does, which is what GOV.UK ships and
    // what a `<label for>` is for.
    <div
      className="field"
      {...(as === "group" ? { role: "group", "aria-labelledby": `${base}-label` } : {})}
    >
      {as === "group" ? (
        <span className="field-label" id={`${base}-label`}>
          {label}
        </span>
      ) : (
        <label className="field-label" htmlFor={controlId}>
          {label}
        </label>
      )}
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={errorId}>
          {error}
        </span>
      ) : null}
      <FieldContext.Provider
        value={as === "group" ? null : { id: controlId, describedBy, invalid: Boolean(error) }}
      >
        {children}
      </FieldContext.Provider>
    </div>
  );
}

/**
 * The wiring one control takes from the `Field` around it.
 *
 * A prop the caller passed always wins: the queue's inline cells label
 * themselves, and a control outside a `Field` gets nothing, which is the same
 * as before.
 */
function fieldProps(
  own: {
    id?: string | undefined;
    "aria-describedby"?: string | undefined;
    // The DOM type admits "grammar" and "spelling" as well, which nothing here
    // uses; the parameter takes what the attribute takes so a caller passing
    // one still wins over the Field.
    "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  },
  field: FieldWiring,
) {
  if (!field) return {};
  return {
    ...(own.id === undefined ? { id: field.id } : {}),
    ...(own["aria-describedby"] === undefined && field.describedBy
      ? { "aria-describedby": field.describedBy }
      : {}),
    ...(own["aria-invalid"] === undefined && field.invalid ? { "aria-invalid": true } : {}),
  };
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    const field = useContext(FieldContext);
    return (
      <input
        ref={ref}
        {...fieldProps(props, field)}
        {...props}
        className={`input ${props.className ?? ""}`}
      />
    );
  },
);

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useContext(FieldContext);
  return (
    <span className="select-wrap">
      <select
        {...fieldProps(props, field)}
        {...props}
        className={`input select ${props.className ?? ""}`}
      />
      <ChevronDown size={15} aria-hidden />
    </span>
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useContext(FieldContext);
  return (
    <textarea
      {...fieldProps(props, field)}
      {...props}
      className={`input textarea ${props.className ?? ""}`}
    />
  );
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
      {/* The actions sit in the title row rather than beside the whole block,
          so a description that wraps to two lines cannot move them. That was
          the difference between Recurring and Templates, and nothing on either
          page said so. */}
      <div className="page-heading">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h1>{title}</h1>
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {description ? <p>{description}</p> : null}
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
  level = 3,
}: {
  /**
   * Required, and it used to be optional with three of the sixteen sites
   * omitting it. An empty state is the whole of what somebody sees on a page
   * that answered their question with nothing, and the three that had no icon
   * were a heading and a sentence floating in a card — which reads as a page
   * that failed to load rather than as an answer.
   */
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
  /**
   * The heading level, because a component that hard-codes one misstates the
   * document wherever it is used. `<h3>` is right under a page `<h1>` and a
   * section `<h2>`, and wrong where the empty state *is* the page's content —
   * the duplicate review's "nothing left to review" is the answer to the whole
   * screen, not a subsection of it. Same reasoning as `ErrorSummary`'s.
   */
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <Heading>{title}</Heading>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Alert({
  kind = "error",
  takeFocus = false,
  children,
}: PropsWithChildren<{ kind?: "error" | "success" | "info"; takeFocus?: boolean }>) {
  const Icon = kind === "success" ? CheckCircle2 : AlertCircle;
  const box = useRef<HTMLDivElement>(null);
  /**
   * Where focus goes when the control that started the work has gone.
   *
   * `web.md` 13.3 asks for focus to land somewhere deliberate after an action,
   * and a bulk action is the case with nowhere obvious: the button somebody
   * pressed is inside the selection bar, and finishing the work unmounts the
   * bar. Focus fell to `<body>`, so the next Tab started from the top of the
   * page — past the skip link and the whole sidebar — to get back to a list
   * they were in the middle of.
   *
   * It lands on the sentence saying what happened, which is both the thing they
   * want to read and the place their next Tab should start from. `role="status"`
   * already announces it to a screen reader; this is for the sighted keyboard
   * user, who is announced nothing.
   *
   * Opt-in, because most alerts render beside a control that still exists and
   * moving focus away from it would be the defect rather than the fix.
   */
  useEffect(() => {
    if (takeFocus) box.current?.focus();
  }, [takeFocus, children]);
  return (
    <div
      ref={box}
      className={`alert alert-${kind}`}
      role={kind === "error" ? "alert" : "status"}
      {...(takeFocus ? { tabIndex: -1 } : {})}
    >
      <Icon size={17} />
      <div>{children}</div>
    </div>
  );
}

/**
 * A muted paragraph: the sentence under a control that says what it means.
 *
 * A component rather than a class because the class was `.settings-note`, named
 * after the page it was born on and then used 26 times across eight files —
 * `App.tsx`, `forms.tsx` and six pages, none of them Settings. `web.md` 6.3
 * asks for a class to be named for its component and not for a page, and
 * offered two ways out: rename it, or make the paragraph real. This is the
 * second, which also puts it in 6.1's inventory, where the duplicate check has
 * something to fire against next time somebody writes a muted `<p>` by hand.
 *
 * No props beyond its children. Every one of the 26 was the same element with
 * the same class and nothing else, which is what made it a component rather
 * than a utility.
 */
export function Note({ children }: PropsWithChildren) {
  return <p className="note">{children}</p>;
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "green" | "red" | "amber" | "blue" }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * How far a long write has got, for work whose end is already counted.
 *
 * A native `<progress>` rather than a div wearing `role="progressbar"`: the
 * element computes `aria-valuenow`, `aria-valuemin` and `aria-valuemax` from
 * its own attributes, and a hand-declared role is how three inputs came to
 * promise a combobox that was not there.
 *
 * Never rendered without a value. A bare `<progress>` is indeterminate and
 * animates in every engine, and the blanket reduced-motion rule at the foot of
 * the stylesheet would freeze it into a static bar that says nothing — which is
 * the defect the button's spinner already has, not one to reproduce.
 *
 * The bar is paired with words, always, and the words are the accessible name.
 * A picture of waiting is nothing at all to somebody who cannot see it.
 */
export function ProgressBar({ label, value, max }: { label: string; value: number; max: number }) {
  const labelId = useId();
  return (
    <div className="progress-row">
      <progress className="progress-meter" value={value} max={max} aria-labelledby={labelId} />
      <span id={labelId}>{label}</span>
    </div>
  );
}

/**
 * The sentence that goes beside the bar, in one place so two pages cannot word
 * it differently.
 *
 * The house count form: both figures grouped, the past participle from the
 * phase vocabulary, sentence case, no full stop. These are the true figures for
 * the phase in flight — the bar itself is weighted across phases, and a weight
 * is an estimate, so the numbers a person reads are never the estimated ones.
 */
export const progressLabel = (event: ProgressEvent) =>
  `${event.done.toLocaleString()} of ${event.total.toLocaleString()} ${PROGRESS_VERB[event.phase]}`;
