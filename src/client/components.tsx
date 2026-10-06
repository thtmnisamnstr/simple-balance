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
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  Search,
  X,
} from "lucide-react";
import {
  type ComponentType,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SortDirection } from "../shared/domain.js";
import { APP_NAME } from "../shared/version.js";
import { PROGRESS_VERB, type ProgressEvent } from "../shared/progress.js";
import { errorIssues } from "./api.js";
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
 *
 * Each field carries the `lean` a `SortableHeader` would, and choosing a field
 * starts it there. It used to keep whatever direction the last field had, so
 * Balance on Accounts and Committed on Categories and Payees started
 * smallest-first while the same kind of column in a table started largest-first
 * (`web.md` 9.4).
 */
export function SortMenu<Field extends string>({
  fields,
  sort,
  onSort,
  label = "Sort by",
}: {
  fields: readonly { field: Field; label: string; lean?: SortLean }[];
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
        onChange={(event) => {
          const chosen = fields.find((entry) => entry.field === event.target.value);
          if (!chosen) return;
          onSort({ field: chosen.field, direction: chosen.lean === "descending" ? "desc" : "asc" });
        }}
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
  /**
   * Where focus goes when the page turn lands.
   *
   * `disabled={busy}` sits on every control here, and a disabled element
   * cannot hold focus — so the browser blurs the button the moment the request
   * starts, and a keyboard reader who pressed Next was dropped on `<body>` and
   * had to tab from the top of the document to get back to the list. 13.3's
   * focus move is keyed on the pathname alone, deliberately, so nothing
   * catches this: paging changes no path. It is the same shape as a bulk
   * action — a control whose own success unmounts or disables it — and the
   * only one of them no per-page edit can reach, because the control belongs
   * to this component.
   *
   * Templates is the one list that paged correctly, and only because it pages
   * in the browser and passes no `busy` at all.
   */
  const pressed = useRef<string | null>(null);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (busy || !pressed.current) return;
    const want = bar.current?.querySelector<HTMLButtonElement>(
      `[data-page-control="${pressed.current}"]`,
    );
    pressed.current = null;
    // Next on the last page has just become disabled and cannot take focus,
    // so the page number that is now current takes it instead — which is
    // where the reader is.
    if (want && !want.disabled) want.focus();
    else bar.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }, [busy, page]);
  if (!totalCount) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalCount);
  const turn = (to: number, control: string) => {
    pressed.current = control;
    onPageChange(to);
  };
  return (
    <nav ref={bar} className="pagination" aria-label={`${itemLabel} pages`}>
      <p className="pagination-summary" aria-live="polite">
        {`Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(totalCount)} ${itemLabel}`}
      </p>
      {totalPages > 1 ? (
        <div className="pagination-pages">
          <button
            type="button"
            className="pagination-step"
            aria-label="Previous page"
            data-page-control="previous"
            disabled={page <= 1 || busy}
            onClick={() => turn(page - 1, "previous")}
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
                data-page-control={`page-${entry}`}
                disabled={busy}
                onClick={() => turn(entry, `page-${entry}`)}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            className="pagination-step"
            aria-label="Next page"
            data-page-control="next"
            disabled={page >= totalPages || busy}
            onClick={() => turn(page + 1, "next")}
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
   * model this generalizes.
   *
   * Rendered only while `disabled` is true and `loading` is not, because a
   * button that is working already says so and a reason for that state would
   * be a second answer to a question already answered.
   *
   * Wired with `aria-describedby` rather than left as a neighboring
   * paragraph: a sighted person reads what is next to the button, and somebody
   * on a screen reader is told the button's name and its state and then has to
   * go looking. The description is what makes "disabled" say why. Added to
   * a description the caller gave rather than replacing it: the plan tab's pay
   * button is described by the renewal terms, and it is disabled while
   * Stripe's form loads, which is exactly when somebody is reading them.
   */
  disabledReason?: string;
}) {
  const reasonId = useId();
  const explained = Boolean(disabledReason) && Boolean(props.disabled) && !loading;
  const { onClick } = props;
  const button = (
    // A spinner is a picture of waiting, which is nothing at all to somebody who
    // cannot see it. `aria-busy` says the control is working and the `.sr-only`
    // word says so in text, because a disabled button otherwise goes silent at
    // exactly the moment a person most wants to know their click landed.
    //
    // Working is `aria-disabled`, never `disabled`, whatever the caller passed
    // beside `loading`. A browser blurs an element it disables, so a button that
    // disabled itself for its own request let go of focus the moment it was
    // pressed and the answer arrived with focus on `<body>` — the question
    // web.md 13.3 left open. The click is swallowed here instead, and
    // `preventDefault` is what also stops a form's implicit submission, which
    // the browser delivers as a click on this button.
    <button
      {...props}
      disabled={loading ? false : props.disabled}
      aria-disabled={loading || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      aria-busy={loading || undefined}
      aria-describedby={
        [explained ? reasonId : null, props["aria-describedby"]].filter(Boolean).join(" ") ||
        undefined
      }
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
 * One form's refusal, shared by its summary and its fields.
 *
 * Per form rather than per page, because two forms are often open at once — a
 * dialog over the list behind it — and both have a `payee`. `ids` is where each
 * `Field` puts the element a summary line should take somebody to, keyed by
 * the request path it claims; a `useId` is opaque, so knowing a path would not
 * give the id without it.
 */
type FormErrorScope = {
  issues: { path: string | null; message: string }[];
  ids: Map<string, string>;
};

const FormErrorContext = createContext<FormErrorScope | null>(null);

/** A field named `draft.legs` speaks for `draft.legs.2.amount` as well. */
const claimsPath = (name: string, path: string | null) =>
  path !== null && (path === name || path.startsWith(`${name}.`));

/**
 * Wraps a form so the refusal its submit got reaches both halves of GOV.UK's
 * contract: every sentence in the summary at the top, linked, and each one again
 * beside the field it is about. The fields say which request paths are theirs
 * with `Field`'s `name`; a sentence no field claims stays in the summary alone,
 * which is where a duplicate-name conflict or a network failure belongs.
 */
export function FormErrors({ error, children }: { error: unknown; children: ReactNode }) {
  // One map for the form's lifetime, which the fields write into from effects.
  const [ids] = useState(() => new Map<string, string>());
  const scope = useMemo(() => ({ issues: errorIssues(error), ids }), [error, ids]);
  return <FormErrorContext.Provider value={scope}>{children}</FormErrorContext.Provider>;
}

/**
 * A `<form>` that is its own refusal's scope: `FormErrors` around the element,
 * so a form takes part by naming its error rather than by wrapping its body.
 */
export function Form({
  error,
  ...props
}: React.FormHTMLAttributes<HTMLFormElement> & { error: unknown }) {
  return (
    <FormErrors error={error}>
      <form {...props} />
    </FormErrors>
  );
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
  const scope = useContext(FormErrorContext);
  const issues = errorIssues(error);
  if (!issues.length) return null;
  // The element a line takes somebody to: the field that claimed its path, if
  // one did. Looked up at render, after every field below has registered.
  const targetOf = (path: string | null) => {
    if (!scope || path === null) return null;
    for (const [name, id] of scope.ids) if (claimsPath(name, path)) return id;
    return null;
  };
  // Focus rather than a fragment, so nothing is written into the address and a
  // dialog's own history stays as it was. The control inside the field, which
  // for a group of controls is the first of them.
  const goTo = (id: string) => {
    const field = document.getElementById(id);
    const control =
      field?.querySelector<HTMLElement>("input, select, textarea, button") ?? field ?? null;
    control?.focus();
  };
  const line = (issue: { path: string | null; message: string }) => {
    const target = targetOf(issue.path);
    return target ? (
      <a
        href={`#${target}`}
        onClick={(event) => {
          event.preventDefault();
          goTo(target);
        }}
      >
        {issue.message}
      </a>
    ) : (
      issue.message
    );
  };
  // Defaults to 3 rather than GOV.UK's fixed 2 because every call site is inside
  // `Modal`, whose title is already an `<h2>` and is the dialog's accessible
  // name; a second `<h2>` in the body reads as a peer section of the dialog
  // rather than as content in it. Same reasoning as `EmptyState`.
  const Heading = level === 2 ? "h2" : "h3";
  // Plain defense against a refusal carrying an unbounded list. No call site
  // reaches it today.
  const shown = issues.slice(0, 10);
  const rest = issues.length - shown.length;
  return (
    <div ref={container} tabIndex={-1} className="alert alert-error error-summary">
      <div role="alert">
        <Heading className="error-summary-title">There is a problem</Heading>
        {shown.length === 1 ? (
          <p>{line(shown[0]!)}</p>
        ) : (
          <ul>
            {shown.map((issue, index) => (
              <li key={`${index}-${issue.path ?? ""}-${issue.message}`}>{line(issue)}</li>
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
 * Through context rather than by cloning the child. `Field` wraps every form
 * field in the app (`web.md` 8.1 keeps the count) and its children are
 * arbitrary JSX — an `<Input>`, a `<Select>`, a `CategoryPicker` that renders
 * one three levels down — so `cloneElement` would reach the first case and
 * silently miss the rest. A context reaches all of them, wires nothing at the
 * call sites, and costs a `useId` per field.
 *
 * `null` means "there is no single control here to point at": that is the
 * `as="group"` case, where the label belongs to the group and each control
 * inside carries its own name.
 */
type FieldWiring = {
  id: string | undefined;
  describedBy: string | undefined;
  invalid: boolean;
} | null;

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
  name,
  optional = false,
  as,
  children,
}: PropsWithChildren<{
  label: string;
  hint?: string;
  error?: string;
  /**
   * The request path or paths this field's value is sent as — `name`,
   * `draft.payee`, both `draft.amount` and `draft.sourceAmount` for an amount
   * that is either. Inside `FormErrors`, a server sentence about one of them is
   * shown here as the field's error and the summary links to it. A path covers
   * the paths below it, so `draft.legs` speaks for every leg.
   */
  name?: string | readonly string[];
  /**
   * Said in the HINT, never in the label.
   *
   * 8.4 settles that a form states one scheme and marks the exceptions to it;
   * 8.1 settles that a name computed from `<label for>` is the label's entire
   * text. Put together, "(optional)" written into a label becomes part of the
   * control's accessible NAME — "Saving up for (optional)" is then what a
   * voice user has to say to reach it (SC 2.5.3). Three fields on Budgets did
   * exactly that while thirteen elsewhere said it in the hint, so the word is
   * a prop now and the slot is not a per-page decision.
   */
  optional?: boolean;
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
  const scope = useContext(FormErrorContext);
  const names = name === undefined ? [] : typeof name === "string" ? [name] : name;
  const nameKey = names.join(" ");
  useEffect(() => {
    if (!scope || !nameKey) return;
    const claimed = nameKey.split(" ");
    for (const path of claimed) scope.ids.set(path, `${base}-field`);
    return () => {
      for (const path of claimed) {
        if (scope.ids.get(path) === `${base}-field`) scope.ids.delete(path);
      }
    };
  }, [scope, nameKey, base]);
  // A sentence the field itself computed wins: it is about what is on screen
  // now, where the server's is about what was last sent.
  const served = scope
    ? scope.issues
        .filter((issue) => names.some((path) => claimsPath(path, issue.path)))
        .map((issue) => issue.message)
    : [];
  const shownError = error ?? (served.length ? [...new Set(served)].join(" ") : undefined);
  // "Optional." leads, because it is the shorter claim and the one a reader
  // scanning a column of fields is looking for.
  const hintText = optional ? (hint ? `Optional. ${hint}` : "Optional.") : hint;
  const hintId = hintText ? `${base}-hint` : undefined;
  const errorId = shownError ? `${base}-error` : undefined;
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
      id={`${base}-field`}
      // A group has no single control to point at its hint and error, so the
      // group itself does: a sentence about the whole composite is read when
      // focus enters it, rather than sitting beside fifty controls none of
      // which names it.
      {...(as === "group"
        ? { role: "group", "aria-labelledby": `${base}-label`, "aria-describedby": describedBy }
        : {})}
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
      {hintText ? (
        <span className="field-hint" id={hintId}>
          {hintText}
        </span>
      ) : null}
      {shownError ? (
        <span className="field-error" id={errorId}>
          {shownError}
        </span>
      ) : null}
      <FieldContext.Provider
        value={as === "group" ? null : { id: controlId, describedBy, invalid: Boolean(shownError) }}
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
    ...(own.id === undefined && field.id !== undefined ? { id: field.id } : {}),
    ...(own["aria-describedby"] === undefined && field.describedBy
      ? { "aria-describedby": field.describedBy }
      : {}),
    ...(own["aria-invalid"] === undefined && field.invalid ? { "aria-invalid": true } : {}),
  };
}

/**
 * The `aria-describedby` for a control that has a sentence of its own to add to
 * what its `Field` already says.
 *
 * A control passed its own `aria-describedby` loses the Field's, because a
 * caller's prop wins (`fieldProps`). The category picker has a line of its own
 * — "Saving will add … as a new category" — that was rendered beside its input
 * and pointed at by nothing (`web.md` 8.1); passing it alone would have cut
 * the field's hint and error off instead. So the two are joined here.
 */
export function useFieldDescribedBy(own: string | undefined) {
  const field = useContext(FieldContext);
  return [field?.describedBy, own].filter(Boolean).join(" ") || undefined;
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
 * The search box in a filter bar: the icon, and one bare control that names
 * itself.
 *
 * Six pages pasted the same three elements, and with nothing holding them the
 * same they disagreed on the one thing that is not cosmetic: two passed
 * `type="search"` and four left the default. WebKit and Blink draw a clear (×)
 * button inside a search input and clear it on Escape, so four of the six were
 * missing an affordance and a keystroke their siblings had, on the same
 * control, one click apart in the nav.
 *
 * Bare with an `aria-label` rather than inside a `Field`, which is 7.6: a
 * filter takes effect on change, has no error and no submit, and `Field`'s
 * stacked label made the one filter that used it twenty pixels taller than the
 * box beside it.
 *
 * `placeholder` is separate from `label` because it is for saying what is
 * searched — a placeholder that repeats its own accessible name tells a sighted
 * reader nothing the label did not.
 */
export function SearchBox({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="search-box">
      <Search size={16} />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
 * keyboard behavior they imply are worse than none.
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
        // whatever the choice opened, and is still there afterward.
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
  confirmLabel,
  confirmVariant = "danger",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  /**
   * The verb and what it acts on, "Delete budget" rather than "Delete". It had
   * a default of "Delete", and nine of twenty dialogs took it, so the label was
   * the one sentence in the dialog that did not say what was about to go.
   */
  confirmLabel: string;
  /**
   * `primary` when the confirmed action puts something in place rather than
   * taking something away: restoring, committing, paying. Red on "Restore
   * account" said the opposite of what the button does.
   */
  confirmVariant?: "danger" | "primary";
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
          <Button type="button" variant={confirmVariant} onClick={onConfirm}>
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
    <div className="option-bar" role="group" aria-label="Visible date range">
      <div className="option-bar-title">
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
      {/* The two dates and the word joining them are one group, so the bar
          wraps around them rather than through them. Unwrapped, the 560px step
          broke after "to" and left it stranded at the end of a line with its
          date on the next. */}
      <div className="option-bar-range">
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
  /*
   * The tab says which page you are on.
   *
   * It said "Simple Balance" on all thirteen for five releases, which is the
   * state where two windows of this app are indistinguishable in a task
   * switcher and a bookmark records nothing about what was bookmarked.
   *
   * Setting it here rather than from a table in the router is deliberate:
   * `title` is already the page's `h1`, so the tab cannot drift from the
   * heading, and a page added later gets a correct tab without anybody
   * remembering a second list. The router is where the obvious alternative
   * lives and it is the one that goes stale.
   */
  useEffect(() => {
    document.title = `${title} — ${APP_NAME}`;
  }, [title]);

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
 * The strip across the top of Settings, and the one place in this app that
 * navigates by document load on purpose.
 *
 * Settings and the plan tab are two documents rather than two panels because
 * they are served under different content security policies — the plan tab
 * mounts Stripe's payment form, which loads a script and an iframe from Stripe
 * that every other page forbids — and a policy belongs to the document it
 * arrived with. A client-side push between them would carry one page's policy
 * onto the other: into the plan tab that means the payment form never appears,
 * and out of it that means the pages showing somebody's balances run with
 * Stripe's origins allowed.
 *
 * So these are plain anchors, and the cost is a reload on a strip most people
 * use twice. Written as one component rather than copied into both pages,
 * because a strip that disagrees with itself about which tab is current is the
 * obvious thing to get wrong with two copies.
 */
export function SettingsTabs({
  current,
  billingAvailable,
}: {
  current: "preferences" | "plan";
  billingAvailable: boolean;
}) {
  // Nothing to choose between when the deployment sells nothing, and a strip
  // with one tab in it is furniture rather than navigation.
  if (!billingAvailable) return null;
  const tabs = [
    { id: "preferences", href: "/settings", label: "Preferences" },
    { id: "plan", href: "/settings/plan", label: "Plan and billing" },
  ] as const;
  return (
    <nav className="settings-tabs" aria-label="Settings sections">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          className={tab.id === current ? "settings-tab is-current" : "settings-tab"}
          aria-current={tab.id === current ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
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
  hint,
  children,
}: PropsWithChildren<{
  label: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
  /**
   * What to know about this field, wired the way `Field` wires a hint.
   *
   * It was a `<small>` each caller wrote after the control, pointed at by
   * nothing (`web.md` 8.1, Binding on SC 1.3.1): "Leave blank to clear", the
   * one currency an account change may take, and every reason a toggle is
   * disabled, all sat beside controls a screen reader read without them. The
   * toggle and the control both point at it now — the toggle because a reason
   * it is dead is about the toggle, the control because what to type is about
   * the control.
   */
  hint?: string;
}>) {
  const hintId = useId();
  const describedBy = hint ? hintId : undefined;
  return (
    <div className={enabled ? "bulk-edit-field enabled" : "bulk-edit-field"}>
      <label className="bulk-edit-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <FieldContext.Provider value={{ id: undefined, describedBy, invalid: false }}>
        {children}
      </FieldContext.Provider>
      {hint ? <small id={hintId}>{hint}</small> : null}
    </div>
  );
}

/**
 * Where focus goes when a selection's own controls take the selection away.
 *
 * "Clear selection" empties the selection, which unmounts the bar it sits in,
 * so focus fell to `<body>` on every surface that has one — the register, the
 * staged queue, templates and both merge panels (`web.md` 13.3) — and the next
 * Tab started from the top of the page. It goes back to where the selection is
 * made: the element the page marks `data-selection-home`, its select-all box or
 * the first row's.
 *
 * In a layout effect's cleanup because that runs before the node leaves the
 * document, the one moment `contains(document.activeElement)` can still tell a
 * bar that took focus with it from one that went away while focus was
 * elsewhere. A notice that takes focus afterward — a bulk delete's — runs
 * later and wins, which is right: it says what happened.
 */
export function useFocusHomeOnUnmount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node?.contains(document.activeElement)) return;
      document.querySelector<HTMLElement>("[data-selection-home]")?.focus();
    };
  }, []);
  return ref;
}

/**
 * The panel a merge is set up in, which appears at two selected rows and goes
 * when the selection does. A component of its own so its unmount is its own:
 * the hook above has to run its cleanup before the panel leaves the document,
 * and a section rendered inline by the page is removed before the page's own
 * cleanup would run.
 */
export function MergePanel({ children }: PropsWithChildren) {
  const panel = useFocusHomeOnUnmount<HTMLElement>();
  return (
    <section className="panel merge-panel" ref={panel}>
      {children}
    </section>
  );
}

/**
 * The bar that appears when rows are selected: how many, and what may be done
 * to them.
 *
 * 6.2 named this past the component threshold — "three toolbars, three label
 * sets, three variant assignments" — and only the label sets were closed, by
 * `tests/ui-copy.test.ts`. Two pages shared a standalone band; the staged
 * queue rendered its own as a CHILD of the filter bar, so ticking a row grew
 * the filter row into a second and third line and pushed the filters down the
 * page. That third one also carried no live region, on the one queue where
 * selecting everything stops silently at the ten-thousand cap and nothing
 * announced the number it stopped at.
 *
 * One element, one `aria-live`, one icon, one actions group, one 560px step.
 * The count sentence stays a prop because the three say genuinely different
 * things — a filtered selection is still being counted while a template
 * selection is not — but `formatCount` is here so the thousands separator
 * is one decision rather than three.
 */
export function SelectionBar({
  summary,
  notes,
  children,
}: PropsWithChildren<{ summary: ReactNode; notes?: ReactNode }>) {
  const bar = useFocusHomeOnUnmount<HTMLDivElement>();
  return (
    <div className="selection-bar" aria-live="polite" ref={bar}>
      <div>
        <ListChecks size={17} aria-hidden />
        <strong>{summary}</strong>
        {notes}
      </div>
      <div className="selection-bar-actions">{children}</div>
    </div>
  );
}

/**
 * A count a person reads, with its thousands grouped.
 *
 * Ten thousand is the cap on every bulk operation in the product
 * (`AGENTS.md`), and four digits with no separator is where a count starts
 * being misread. It was `selectionCount` and only the selection bars asked it,
 * so the bar read "4,318" while the dialog it opened read "4318 … will be
 * edited", the notice after it "Deleted 4318", and the pages under the list
 * "of 12345". Every count in a sentence goes through it now.
 */
export const formatCount = (count: number) => count.toLocaleString();

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

/**
 * One figure in a row of them: the dashboard's four metrics and the account
 * page's four balances.
 *
 * Two classes did this job and had already drifted. `.balance-snapshot` and
 * `.metric-card` were the same markup, the same radius and the same grid, and
 * differed only where nobody chose: padding 15 against 16, gap 11 against 12,
 * `flex-start` against `center`, a 33px icon against 35, and
 * `overflow: hidden; text-overflow: ellipsis` on one `strong` and not the
 * other. That last one is consequential rather than cosmetic — the same money
 * truncated on one page and wrapped on the other — and the argument settles
 * it: a cut-off figure is worse than a figure on two lines, so it wraps.
 *
 * The icon says WHICH figure this is, which is why it is required. The account
 * page drew the same saturated green glyph on all four of its tiles — four
 * identical blocks distinguishing none of the four figures beside them, and
 * the loudest thing in the band. A channel that repeats carries nothing.
 */
export function MetricTile({
  icon: Icon,
  tone,
  emphasis = false,
  label,
  figure,
  negative = false,
  note,
}: {
  icon: ComponentType<{ size?: number }>;
  /** Green or red on the glyph's tile, where the figure has a direction. */
  tone?: "positive" | "negative";
  /** The one tile that is the headline figure of its row. */
  emphasis?: boolean;
  label: string;
  figure: string;
  negative?: boolean;
  note?: string;
}) {
  // Named by its label, so a screen reader moving by landmark or listing
  // articles hears "Balance" rather than a row of unnamed articles.
  const labelId = useId();
  return (
    <article
      className={`metric-card ${emphasis ? "metric-balance" : ""}`}
      aria-labelledby={labelId}
    >
      <span className={`metric-icon ${tone ?? ""}`}>
        <Icon size={18} />
      </span>
      <div>
        <span id={labelId}>{label}</span>
        <strong className={negative ? "money-negative" : ""}>{figure}</strong>
        {note ? <small>{note}</small> : null}
      </div>
    </article>
  );
}

/** The one size an empty state's glyph is drawn at, inside its 48px tile. */
const EMPTY_ICON = 24;

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  compact = false,
  level = 3,
}: {
  /**
   * Required, and it used to be optional with three of the sixteen sites
   * omitting it. An empty state is the whole of what somebody sees on a page
   * that answered their question with nothing, and the three that had no icon
   * were a heading and a sentence floating in a card — which reads as a page
   * that failed to load rather than as an answer.
   *
   * A component rather than a node, because a node carries its own size and
   * the size was written at the call site: 20, 22, 23, 24 and 25 across
   * eighteen of them, varying by a quarter inside a tile that is a fixed 48px
   * either way, on pages one click apart. A node cannot be corrected from
   * here; a component can, so the size stops being something anybody types.
   */
  icon: ComponentType<{ size?: number }>;
  title: string;
  body: string;
  action?: ReactNode;
  /**
   * For a slot inside a panel rather than a page's whole answer.
   *
   * The full card is `min-height: 250px`, which is right when it is what the
   * page came back with and wrong inside the dashboard's per-currency panels
   * or the budgets forecast — there it would be the tallest thing on screen
   * saying the least. Six such lists answered with a bare muted paragraph
   * instead, which put all six outside 12.1's check as well as outside its
   * look; a variant keeps them inside both.
   */
  compact?: boolean;
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
    <div className={`empty-state ${compact ? "empty-state-compact" : ""}`}>
      <div className="empty-icon">
        <Icon size={EMPTY_ICON} />
      </div>
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
    if (!takeFocus) return;
    box.current?.focus();
    // When the work was confirmed in a dialog, the dialog is still open as this
    // mounts: a modal dialog makes everything outside it inert, so the focus
    // above does not land, and closing the dialog then hands focus back to the
    // button that opened it — which the work just removed, leaving `<body>`.
    // A bulk edit's "N transactions updated." was exactly that. The dialog's
    // `close` event fires after it has restored focus, so focusing again there
    // is the last word.
    const open = [...document.querySelectorAll("dialog[open]")].find(
      (dialog) => !dialog.contains(box.current),
    );
    if (!open) return;
    const refocus = () => box.current?.focus();
    open.addEventListener("close", refocus, { once: true });
    return () => open.removeEventListener("close", refocus);
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
 * A transfer's category cell: a dash, and words for whoever cannot see one.
 *
 * One component so the transactions list and the staged queue cannot drift
 * apart again — one of them said "Uncategorized", which reads as work left
 * undone, about a row that can never have a category.
 */
export function TransferCategory() {
  return (
    <span className="subtle">
      <span aria-hidden="true">—</span>
      <span className="sr-only">No category: transfers have none</span>
    </span>
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
