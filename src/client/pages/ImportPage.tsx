import { Link } from "../router.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Download, FileSpreadsheet, FlaskConical, Upload } from "lucide-react";
import { type ChangeEvent, Fragment, useId, useMemo, useRef, useState } from "react";
import {
  csvCell,
  isAppExportCsv,
  suggestCsvMapping,
  type CsvDateFormat,
  type CsvDecimalSeparator,
  type CsvMapping,
  type CategoryResolution,
  type PayeeResolution,
} from "../../shared/csv.js";
import {
  PROGRESS_STREAM_MIN_ROWS,
  type CategoryKind,
  type StagedDraft,
} from "../../shared/domain.js";
import {
  defaultLedgerFileKinds,
  ledgerFileKinds,
  ledgerFileQueryString,
  ledgerFileSelectionSchema,
  MAX_LEDGER_FILE_ACCOUNT_CHOICES,
  type LedgerFileAccountScope,
  type LedgerFileKind,
  type LedgerFileSelection,
} from "../../shared/ledger-file.js";
import { progressFraction, type ProgressEvent } from "../../shared/progress.js";
import {
  api,
  ApiClientError,
  apiStreamed,
  download,
  json,
  queryString,
  writeDidNotHappen,
  type Account,
  type Category,
  type CsvPreview,
  type CsvSampleRow,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorSummary,
  Field,
  Form,
  formatCount,
  Input,
  Note,
  PageHeader,
  progressLabel,
  ProgressBar,
  Select,
  Skeleton,
} from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";
import { LedgerFileImport } from "../LedgerFileImport.js";
import { noAccountReason } from "../list-filters.js";
import { formatDate, formatMoney, movementSign } from "../money.js";
import {
  largestStagedLeg,
  stagedLegs,
  stagedString,
  summarizeStagedDraft,
} from "../staged-draft.js";

type StageResult = {
  rowCount: number;
  validCount: number;
  invalidCount: number;
  importBatchId?: string;
  /** The first rows as the server read them. Its shape is the server's own. */
  sample: CsvSampleRow[];
  referenceResolution: {
    categories: {
      inputName: string;
      resolvedName: string;
      categoryId: string | null;
      kind: CategoryKind;
      resolution: CategoryResolution;
      unarchived: boolean;
    }[];
    payees: {
      inputPayee: string;
      resolvedPayee: string;
      resolution: PayeeResolution;
    }[];
  };
};

/**
 * How many rows the panel draws.
 *
 * Twelve, not the twenty-five the sample carries: `.import-preview` is sticky,
 * and a table taller than the viewport pins with its last rows out of reach.
 */
const PREVIEW_ROWS = 12;

/**
 * The delimiter the preview found, as a word.
 *
 * Printed as the character itself it read "Detected , delimiter" — a bold lone
 * comma that looks like stray punctuation and that a screen reader at its
 * default punctuation level skips. Papa guesses from six, not just the three
 * the drop zone names, and two are control characters that print as nothing at
 * all. Display only: the preview's `delimiter`, the MCP's and the import
 * batch's stay the character, because there it is data. A guess outside these
 * is quoted rather than left bare.
 */
const delimiterNames: Readonly<Record<string, string>> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
  "|": "pipe",
  "\u001e": "record separator",
  "\u001f": "unit separator",
};

function MappingField({
  label,
  hint,
  value,
  headers,
  required,
  onChange,
}: {
  label: string;
  hint?: string;
  value?: string;
  headers: string[];
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Select
        required={required}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{required ? "Choose a column…" : "Not mapped"}</option>
        {headers.map((header) => (
          <option value={header} key={header}>
            {header}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export default function ImportPage() {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<CsvMapping>>({});
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [dateFormat, setDateFormat] = useState<CsvDateFormat>("YMD");
  const [decimalSeparator, setDecimalSeparator] = useState<CsvDecimalSeparator>(".");
  const [result, setResult] = useState<StageResult | null>(null);
  const [resultReading, setResultReading] = useState("");
  const stageIdempotencyKey = useRef(newIdempotencyKey());

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });
  // The accounts an import may post against. Every row lands on the one chosen
  // here, so a frozen one stages the whole file with the same issue on every
  // row — and the list arrives in name order, so a default read off its front
  // chose a frozen account for anybody whose first one was.
  const writableAccounts = (accounts.data ?? []).filter(
    (account) => !account.archivedAt && !account.frozen,
  );

  // The server's answer, read off the preview rather than worked out here, so
  // the page and `preview_csv` cannot disagree about what a file is. The
  // fallback is for a rolling update, which briefly serves this bundle against
  // a server from before the preview said so — and it is the same shared
  // function the server calls, so the two readings are still one rule.
  const appExport = preview
    ? (preview.simpleBalanceExport ?? isAppExportCsv(preview.headers))
    : false;

  // A draft names its category by id, so the panel needs the list to show a name
  // rather than a UUID — the same reason the queue fetches it, archived ones
  // included.
  const categories = useQuery({
    queryKey: ["categories", true],
    queryFn: () => api<Category[]>("/api/v1/categories?includeArchived=true"),
  });
  const categoryNames = useMemo(
    () => new Map((categories.data ?? []).map((category) => [category.id, category.name])),
    [categories.data],
  );

  // Everything that decides how the file is read. An interpretation made under
  // one of these and shown beside another is worse than no interpretation at
  // all, because it looks like an answer.
  const reading = JSON.stringify({
    mapping,
    dateFormat,
    decimalSeparator,
    defaultAccountId,
    appExport,
  });
  const stale = Boolean(result) && resultReading !== reading;
  // `[]` is truthy and a header-only file samples nothing, so without the length
  // check the panel would replace the file's own cells with an empty table.
  const interpreted = result && !stale && result.sample.length ? result : null;

  const previewMutation = useMutation({
    mutationFn: async (file: File) => {
      const contents = await file.text();
      const parsed = await api<CsvPreview>("/api/v1/csv/preview", json({ csv: contents }));
      return { contents, parsed, name: file.name };
    },
    onSuccess: ({ contents, parsed, name }) => {
      setCsv(contents);
      setFileName(name);
      setPreview(parsed);
      // The guess `preview_csv` hands an agent, so a person and an agent
      // importing one file start from one mapping. Worked out here only
      // against a server from before it sent one, by the function it calls.
      setMapping(parsed.suggestedMapping ?? suggestCsvMapping(parsed.headers));
      // Chosen for them only when there is nothing to choose between. Picking
      // the alphabetically first of several put a file one press away from
      // landing in an account nobody had named — and the queue would then
      // file every row there.
      setDefaultAccountId(
        (current) => current || (writableAccounts.length === 1 ? writableAccounts[0]!.id : ""),
      );
      setResult(null);
      setResultReading("");
      stageIdempotencyKey.current = newIdempotencyKey();
    },
  });

  // Beside the mutation, because a mutation has no channel for anything between
  // pending and settled, and this arrives four times a second while one is in
  // flight.
  const [stageProgress, setStageProgress] = useState<ProgressEvent | null>(null);

  const stageMutation = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const request = json({
        csv,
        fileName,
        idempotencyKey: stageIdempotencyKey.current,
        defaultAccountId,
        mapping: appExport ? undefined : mapping,
        dateFormat,
        decimalSeparator,
        dryRun,
      });
      return {
        // Read here rather than in onSuccess: React Query re-reads its options on
        // every render, so a control touched while the request was in flight would
        // stamp a stale interpretation as the current one, which is the single
        // thing the stamp exists to prevent.
        reading,
        // A dry run stages nothing and does no per-row work, so there is
        // nothing to report and it never asks. A real stage always asks: how
        // many rows this file holds is not known until the server has parsed
        // it, and the alternative — parsing it a second time in the browser to
        // decide — is two readings of one file, which is the thing this app
        // does not do.
        value: dryRun
          ? await api<StageResult>("/api/v1/csv/stage", request)
          : await apiStreamed<StageResult>("/api/v1/csv/stage", request, setStageProgress),
      };
    },
    // Cleared here as well as in onSettled, because onSettled runs after
    // onSuccess has awaited its refetches — long enough for the finished bar
    // and the result to sit on screen together.
    onSuccess: async ({ value, reading: stamped }, dryRun) => {
      setStageProgress(null);
      setResult(value);
      setResultReading(stamped);
      if (!dryRun) {
        stageIdempotencyKey.current = newIdempotencyKey();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["categories"] }),
          queryClient.invalidateQueries({ queryKey: ["payees"] }),
          queryClient.invalidateQueries({ queryKey: ["staged"] }),
          queryClient.invalidateQueries({ queryKey: ["import-batches"] }),
        ]);
      }
    },
    onSettled: () => setStageProgress(null),
  });

  const hasAmounts = Boolean(mapping.amount || mapping.debit || mapping.credit);
  const ready = Boolean(
    csv && defaultAccountId && (appExport || (mapping.date && mapping.payee && hasAmounts)),
  );
  // The first unmet condition, in the order the steps ask for them (`web.md`
  // 12.3), rather than every condition at once. Never "choose a file": these
  // buttons exist only once a file has been previewed, and the preview refuses
  // an empty one. And our own export has nothing to map, so naming columns
  // there sent somebody looking for controls this screen hides. Undefined
  // exactly when `ready` is true, since `csv` is always set by then.
  const stageBlockedBecause = !defaultAccountId
    ? "Choose the account to post the rows to."
    : appExport
      ? undefined
      : !mapping.date
        ? "Map the date column."
        : !mapping.payee
          ? "Map the payee column."
          : !hasAmounts
            ? "Map a signed amount column or one or both debit/credit columns."
            : undefined;
  // One per distinct name, so a large statement's payees run to four digits
  // and group like every other count on the page (`common.md` §Prose).
  const resolved = (items: readonly { resolution: string }[], resolution: string) =>
    formatCount(items.filter((item) => item.resolution === resolution).length);
  const sampleHeaders = useMemo(() => preview?.headers.slice(0, 8) ?? [], [preview]);

  /**
   * What to call the category a row names, whichever way it names it.
   *
   * Three cases in order, and the middle one is why the server defers a name on
   * a dry run: an id this ledger already owns, a name the stage will create the
   * category for, or an id this stage created a moment ago and the categories
   * list has not refetched yet.
   */
  const categoryLabel = (categoryId: string | undefined, categoryName: string | undefined) => {
    const known = categoryNames.get(categoryId ?? "");
    if (known) return known;
    const named = (categoryName ?? "").trim();
    if (named) return named;
    const created = result?.referenceResolution.categories.find(
      (item) => item.categoryId !== null && item.categoryId === categoryId,
    );
    return created?.resolvedName ?? "Uncategorized";
  };

  const csvHeading = useId();
  const fileHeading = useId();

  // The file being read, named from the moment it is chosen: `fileName` is set
  // only once the preview answers, and a large file spends seconds on the way
  // up with the panel still saying there is no file yet (`web.md` 12.2).
  const choosing = previewMutation.isPending ? previewMutation.variables.name : null;
  // A pick while a file is read or staged is refused, as the Simple Balance
  // file's drop zone refuses one while it is checked or added.
  const fileBusy = choosing !== null || stageMutation.isPending;

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Refused here as well as on the click, because a drop lands on the input
    // whatever the click guard says. And it has to be: every answer runs
    // `onSuccess`, so a second pick that answered first was overwritten when
    // the first one landed late, leaving the page on the file not chosen last.
    if (file && !fileBusy) previewMutation.mutate(file);
    // Cleared so the same file can be chosen again. A file input whose value
    // still names the file fires no change event for re-picking it — and
    // re-picking is exactly what somebody does after fixing the file the
    // preview just complained about.
    event.target.value = "";
  };

  return (
    <>
      <PageHeader
        eyebrow="Your data"
        title="Import and export"
        description="Bring in a bank statement or a Simple Balance file, or export your ledger as a Simple Balance file to keep or to move to another copy of Simple Balance."
      />

      {/* The CSV import's own section, and its two empty states are inside it.
          They used to replace the whole page, which was harmless while the page
          was only this import and is not now: somebody with no account yet, or
          with every account frozen, still has a ledger to export. */}
      <section className="import-section" aria-labelledby={csvHeading}>
        <div className="section-title">
          <div>
            <h2 id={csvHeading}>Import a CSV</h2>
            <p>
              {appExport
                ? "Choose the account, check the preview, then stage the rows."
                : "Match your columns, check the preview, then stage the rows."}
            </p>
          </div>
        </div>
        {accounts.error ? <Alert>{accounts.error.message}</Alert> : null}
        {/* With no account, the title states the situation and the button
            carries the imperative (12.1): "Create an account first" was an
            order with no way to obey it, eight lines above the frozen branch
            that has one. "No account", not "no accounts yet": this list leaves
            archived accounts out, so somebody whose accounts are all archived
            lands there too, and "yet" would be false for them. */}
        {accounts.isPending ? (
          <Skeleton height={64} label="Loading accounts…" />
        ) : accounts.error ? null : !accounts.data?.length ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="No account to import into"
            body="A CSV needs an account for its rows to be posted against. Moving from another copy of Simple Balance? Add its file below."
            action={
              <Link className="button button-primary" to="/accounts">
                Go to Accounts
              </Link>
            }
          />
        ) : !writableAccounts.length ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="Every account is frozen"
            body="A CSV needs an account its rows can be posted against, and a frozen account accepts no rows. One comes back into use when an account in use is archived or deleted, or if you upgrade."
            action={
              <Link className="button button-primary" to="/accounts">
                Go to Accounts
              </Link>
            }
          />
        ) : (
          <div className="import-layout">
            <section className="panel import-steps">
              <div className="step-heading">
                <span>1</span>
                <div>
                  <h3>Choose a CSV file</h3>
                  <p>Files are parsed in memory and the original is not stored on disk.</p>
                </div>
              </div>
              <label className="file-drop">
                <Upload size={26} />
                <strong>{choosing ?? (fileName || "Drop in a file or browse")}</strong>
                <span>Comma, semicolon, and tab delimiters are detected automatically.</span>
                <span>A very large export may need importing one date range at a time.</span>
                {/* Refused while busy the way `Button` refuses, never
                    `disabled`, for the reason the Simple Balance file's drop
                    zone gives: a browser blurs what it disables (`web.md`
                    13.3). */}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  aria-disabled={fileBusy || undefined}
                  onClick={(event) => {
                    if (fileBusy) event.preventDefault();
                  }}
                  onChange={chooseFile}
                />
              </label>
              {previewMutation.error ? <Alert>{previewMutation.error.message}</Alert> : null}
              {preview?.errors.length ? (
                <Alert kind="info">
                  The parser could not read some rows cleanly. Only the first rows of the file are
                  read for this preview, so there may be more.
                  <ul>
                    {preview.errors.slice(0, 5).map((message, index) => (
                      // Keyed on the index as well as the message: an undetectable
                      // delimiter yields no row number, so the same sentence can
                      // appear twice.
                      <li key={`${index}-${message}`}>{message}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              {preview ? (
                <>
                  <div className="step-heading">
                    <span>2</span>
                    <div>
                      <h3>{appExport ? "Choose the account" : "Map the columns"}</h3>
                      <p>
                        Detected a{" "}
                        <strong>
                          {delimiterNames[preview.delimiter] ?? `"${preview.delimiter}"`}
                        </strong>{" "}
                        delimiter and {formatCount(preview.headers.length)} columns.
                      </p>
                    </div>
                  </div>
                  {appExport ? (
                    <Alert kind="info">
                      This is a Simple Balance export, so its dates, amounts, categories, and text
                      are read from the columns it already names and there is nothing to map. Every
                      row is posted against the account you choose here, whichever account the file
                      was exported from. Transfers name a second account, which is a choice this
                      screen cannot make, so they arrive in the queue asking for it.
                    </Alert>
                  ) : null}
                  <div className="form-grid">
                    <div className={appExport ? undefined : "two-columns"}>
                      <Field label="Account">
                        <Select
                          required
                          value={defaultAccountId}
                          onChange={(event) => setDefaultAccountId(event.target.value)}
                        >
                          <option value="" disabled>
                            Choose an account
                          </option>
                          {writableAccounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name} ({account.currency})
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {appExport ? null : (
                        <Field label="Date format">
                          <Select
                            value={dateFormat}
                            onChange={(event) =>
                              setDateFormat(event.target.value as typeof dateFormat)
                            }
                          >
                            <option value="YMD">YYYY-MM-DD</option>
                            <option value="MDY">MM/DD/YYYY</option>
                            <option value="DMY">DD/MM/YYYY</option>
                          </Select>
                        </Field>
                      )}
                    </div>
                    {appExport ? null : (
                      <>
                        <div className="two-columns">
                          <MappingField
                            label="Date"
                            required
                            headers={preview.headers}
                            value={mapping.date}
                            onChange={(date) => setMapping((value) => ({ ...value, date }))}
                          />
                          <MappingField
                            label="Payee"
                            required
                            headers={preview.headers}
                            value={mapping.payee}
                            onChange={(payee) => setMapping((value) => ({ ...value, payee }))}
                          />
                        </div>
                        <div className="three-columns">
                          <MappingField
                            label="Signed amount"
                            headers={preview.headers}
                            value={mapping.amount}
                            onChange={(amount) => setMapping((value) => ({ ...value, amount }))}
                          />
                          <MappingField
                            label="Debit"
                            headers={preview.headers}
                            value={mapping.debit}
                            onChange={(debit) => setMapping((value) => ({ ...value, debit }))}
                          />
                          <MappingField
                            label="Credit"
                            headers={preview.headers}
                            value={mapping.credit}
                            onChange={(credit) => setMapping((value) => ({ ...value, credit }))}
                          />
                        </div>
                        <div className="two-columns">
                          <MappingField
                            label="Category"
                            headers={preview.headers}
                            value={mapping.category}
                            onChange={(category) => setMapping((value) => ({ ...value, category }))}
                          />
                          <MappingField
                            label="Description"
                            headers={preview.headers}
                            value={mapping.description}
                            onChange={(description) =>
                              setMapping((value) => ({ ...value, description }))
                            }
                          />
                        </div>
                        <div className="two-columns">
                          <MappingField
                            label="Notes"
                            headers={preview.headers}
                            value={mapping.notes}
                            onChange={(notes) => setMapping((value) => ({ ...value, notes }))}
                          />
                          <Field label="Decimal separator">
                            <Select
                              value={decimalSeparator}
                              onChange={(event) =>
                                setDecimalSeparator(event.target.value as CsvDecimalSeparator)
                              }
                            >
                              <option value=".">1,234.56</option>
                              <option value=",">1.234,56</option>
                            </Select>
                          </Field>
                        </div>
                        {/* Guessed from four headings and sent, and until 0.2.1 never
                          shown: a reference column under any other heading could
                          not be chosen, and a wrong guess could not be undone,
                          which an agent's mapping could do both of. */}
                        <div className="two-columns">
                          <MappingField
                            label="Bank reference"
                            hint="The column your bank identifies each transaction by, which stops the same statement being imported twice. Leave it Not mapped if that column repeats from row to row."
                            headers={preview.headers}
                            value={mapping.externalId}
                            onChange={(externalId) =>
                              setMapping((value) => ({ ...value, externalId }))
                            }
                          />
                        </div>
                        {/* An instruction, not an error: nothing has been submitted,
                          so it is a note beside the mapping rather than a red
                          `alert` that interrupted a screen reader the moment a
                          file was chosen (`web.md` 8.2, 12.4). The buttons that
                          cannot run yet already carry it as their reason. */}
                        {!hasAmounts ? (
                          <Note>
                            Map a signed amount column or one or both debit/credit columns.
                          </Note>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div className="step-heading">
                    <span>3</span>
                    <div>
                      <h3>Validate and stage</h3>
                      <p>A dry run reports problems without changing anything.</p>
                    </div>
                  </div>
                  <div className="form-actions">
                    {/* One mutation serves both, so each asks which of them is
                      running (`web.md` 12.3): the button that writes rows must
                      not spin and say "Working…" through a dry run, which
                      writes nothing. The one not pressed is held through
                      `disabled`, since a sibling that is not `loading` no
                      longer swallows a click and `mutate` would start a second
                      request, and it gives no reason then, because the
                      pressed one's spinner is the answer. */}
                    <Button
                      variant="secondary"
                      disabled={!ready || stageMutation.isPending}
                      disabledReason={stageMutation.isPending ? undefined : stageBlockedBecause}
                      loading={stageMutation.isPending && stageMutation.variables === true}
                      onClick={() => stageMutation.mutate(true)}
                    >
                      <FlaskConical size={16} /> Dry run
                    </Button>
                    <Button
                      disabled={!ready || stageMutation.isPending}
                      disabledReason={stageMutation.isPending ? undefined : stageBlockedBecause}
                      loading={stageMutation.isPending && stageMutation.variables === false}
                      onClick={() => stageMutation.mutate(false)}
                    >
                      Stage all rows <ArrowRight size={16} />
                    </Button>
                  </div>
                  {/* Mounted on the first frame and never before: until one
                    arrives there is no count behind a bar, and the button's own
                    busy state is the honest indicator. It is gone before the
                    result Alert below takes the same slot. */}
                  {stageProgress && stageProgress.total >= PROGRESS_STREAM_MIN_ROWS ? (
                    <ProgressBar
                      label={progressLabel(stageProgress)}
                      value={progressFraction(stageProgress)}
                      max={1}
                    />
                  ) : null}
                  {stageMutation.error ? (
                    <Alert>
                      {stageMutation.error.message}
                      {/* A stage is one transaction, so a refusal partway through
                        leaves the queue exactly as it was, and somebody who
                        watched a bar climb has no other way to know that. Three
                        conditions, and each rules out a case it would be wrong
                        for: a dry run stages nothing to begin with, and a
                        connection that died says nothing about whether the rows
                        landed. */}
                      {stageMutation.variables === false && writeDidNotHappen(stageMutation.error)
                        ? " Nothing was staged."
                        : null}
                    </Alert>
                  ) : null}
                  {/* A dry run is a prediction and goes stale with the settings it
                    was run under. A completed stage describes rows already
                    written, so it is history and cannot. */}
                  {result && (result.importBatchId || !stale) ? (
                    <>
                      <Alert kind={result.invalidCount ? "info" : "success"}>
                        <strong>{formatCount(result.validCount)}</strong> ready and{" "}
                        <strong>{formatCount(result.invalidCount)}</strong> needing attention out of{" "}
                        {formatCount(result.rowCount)} rows.
                        {result.importBatchId ? (
                          <>
                            {" "}
                            {/* Carries the batch through so the queue opens on
                              the rows that just arrived, rather than on
                              everything ever staged — and pins the range to
                              all-time, because the queue's default this-month
                              filter hid every imported row dated outside the
                              current month: the link said 250 rows and the
                              page showed none of them. */}
                            <Link
                              to={{
                                pathname: "/staged",
                                search: queryString({
                                  importBatchId: result.importBatchId,
                                  preset: "all-time",
                                }),
                              }}
                            >
                              Review these {formatCount(result.rowCount)} rows
                            </Link>
                            .
                          </>
                        ) : (
                          " Nothing was changed during this dry run."
                        )}
                      </Alert>
                      {result.referenceResolution.categories.length ||
                      result.referenceResolution.payees.length ? (
                        <Alert kind="info">
                          Categories: {resolved(result.referenceResolution.categories, "existing")}{" "}
                          matched, {resolved(result.referenceResolution.categories, "new")} new, and{" "}
                          {resolved(result.referenceResolution.categories, "updated")} updated.
                          Payees: {resolved(result.referenceResolution.payees, "existing")} matched
                          and {resolved(result.referenceResolution.payees, "new")} new.
                        </Alert>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
            </section>

            <aside className="panel import-preview">
              <header className="panel-header">
                <h3>{interpreted && choosing === null ? "As it will be read" : "File preview"}</h3>
                {choosing !== null ? null : interpreted ? (
                  // Says what is on screen rather than what came back: twelve rows
                  // are rendered out of a sample of twenty-five out of the file.
                  <Badge tone="blue">
                    {Math.min(interpreted.sample.length, PREVIEW_ROWS)} of{" "}
                    {formatCount(interpreted.rowCount)} rows
                  </Badge>
                ) : preview ? (
                  <Badge tone="blue">{formatCount(preview.rows.length)} sampled</Badge>
                ) : null}
              </header>
              {/* The categories are read only to name each row's category here,
                  and unread they name every one Uncategorized, which states
                  something about the file that was never checked. */}
              {categories.error ? <Alert>{categories.error.message}</Alert> : null}
              {/* Both preview tables are reachable, like every other scrolling
                table region (9.6). They were the only ones in the client that
                scrolled and could not be focused, so a keyboard could not read
                the columns past the edge. Each is named by the caption its
                table already carries rather than by the panel heading. */}
              {choosing !== null ? (
                <div className="import-reading">
                  {/* Said in words as well as drawn, as the Simple Balance
                      file's check is: a shimmer is a picture of waiting. */}
                  <p role="status">{`Reading ${choosing}`}</p>
                  <Skeleton height={96} />
                </div>
              ) : interpreted ? (
                <div
                  className="preview-table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="The first rows of the file as the import will read them"
                >
                  <table className="preview-table">
                    <caption className="sr-only">
                      The first rows of the file as the import will read them
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Date</th>
                        <th scope="col">Payee</th>
                        <th scope="col">Account</th>
                        <th scope="col">Category</th>
                        <th scope="col" className="align-right">
                          Amount
                        </th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {interpreted.sample.slice(0, PREVIEW_ROWS).map((row, index) => {
                        // A row that could not be assembled is shown from its
                        // `partial`, which is exactly what the stage will store.
                        const draft: StagedDraft = row.draft ?? row.partial ?? {};
                        const summary = summarizeStagedDraft(draft, accounts.data ?? []);
                        // The queue's own reading of an unreadable type: a string,
                        // never null, so `movementSign` takes it.
                        const { sign, className } = movementSign(stagedString(draft.type).trim());
                        const legs = stagedLegs(draft.legs);
                        const largest = largestStagedLeg(legs);
                        const date = stagedString(draft.date);
                        const issue = row.issues[0]?.message;
                        return (
                          <tr key={index}>
                            <td className="nowrap">{date ? formatDate(date) : "—"}</td>
                            {/* The payee heads the row, as it does in the queue
                              these same rows land in two clicks later. The
                              interpreted preview's columns are fixed, so one
                              of them is knowably the subject — the raw CSV
                              preview beside it is the named exception, because
                              its columns are whatever the file had. */}
                            <th scope="row">
                              {stagedString(draft.payee).trim() || "Incomplete row"}
                            </th>
                            <td>{summary.account}</td>
                            <td>
                              {legs.length ? (
                                <div className="cell-with-badge">
                                  <span>
                                    {categoryLabel(largest?.categoryId, largest?.categoryName)}
                                  </span>
                                  <Badge tone="blue">Split · {formatCount(legs.length)}</Badge>
                                </div>
                              ) : (
                                categoryLabel(
                                  stagedString(draft.categoryId),
                                  stagedString(draft.categoryName),
                                )
                              )}
                            </td>
                            <td className={`align-right money ${className}`}>
                              {/* A decimal string throughout, never through
                                `Number`. A row missing either half has no figure
                                to show rather than a wrong one. */}
                              {summary.amount && summary.currency
                                ? `${sign}${formatMoney(summary.amount, summary.currency)}`
                                : "—"}
                            </td>
                            <td className="preview-issue">
                              {issue ? (
                                <>
                                  <Badge tone="red">Needs attention</Badge>
                                  <div className="issue-tooltip">{issue}</div>
                                </>
                              ) : (
                                <Badge tone="green">Ready</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : preview?.rows.length ? (
                <>
                  <div
                    className="preview-table-wrap"
                    tabIndex={0}
                    role="region"
                    aria-label="Preview of the file being imported"
                  >
                    <table className="preview-table">
                      <caption className="sr-only">Preview of the file being imported</caption>
                      <thead>
                        <tr>
                          {sampleHeaders.map((header) => (
                            <th scope="col" key={header}>
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                          <tr key={index}>
                            {/* `csvCell`, not `row[header]`, and this is the one
                              place in the client that indexes a parsed row by a
                              name the uploaded file chose. A header line
                              containing `__proto__` leaves no own property of
                              that name — assigning a string to it on an object
                              literal sets the prototype and is dropped — so
                              indexing answers `Object.prototype`, React throws
                              rather than render an object as a child, and the
                              root boundary replaces the whole app the moment
                              the file is picked, before any mapping or
                              staging. The file is RFC 4180-conformant; the
                              server reader has used `csvCell` all along. */}
                            {sampleHeaders.map((header) => (
                              <td key={header}>{csvCell(row, header)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Note>Run a dry run to see how these rows will be read.</Note>
                </>
              ) : (
                <EmptyState
                  // The subject, like every other empty state here. A checkmark
                  // meant "done" on a panel that has not started: nothing had
                  // been imported, and the screen congratulated the reader for
                  // it.
                  icon={FileSpreadsheet}
                  title="No file yet"
                  body="A sample of the file appears here before anything is staged."
                  // Under the panel's own heading, which is an h3 now that the
                  // CSV import is a section of the page rather than all of it.
                  level={4}
                />
              )}
            </aside>
          </div>
        )}
      </section>

      {/* Between the two, because it is the other half of each: an import
          like the CSV above it, of the file the export below it writes. */}
      <section className="import-section" aria-labelledby={fileHeading}>
        <div className="section-title">
          <div>
            <h2 id={fileHeading}>Import a Simple Balance file</h2>
            <p>
              Add a file exported from Simple Balance to this ledger. Accounts, categories,
              templates, recurring transactions and budgets that are new here are created as they
              are, one already here under the same name is yours to decide, and transactions go to
              Staged for review. Into a new ledger, the file can be moved instead, with every
              transaction going straight into the books.
            </p>
          </div>
        </div>
        <LedgerFileImport />
      </section>

      <LedgerFileExport />
    </>
  );
}

/**
 * The boxes the "Everything" export ticks, in the order the page lists them.
 *
 * Every kind the format has but `deletedEntries`, which is not a record of its
 * own: a deleted entry is an entry voided by its reversal, so it is a narrowing
 * of Transactions and sits under that box rather than beside it.
 * `tests/import-export-page.test.tsx` holds this list to `ledgerFileKinds`, so a
 * kind added to the format cannot ship with nothing on the page to choose it.
 */
const KIND_CHOICES: readonly { kind: LedgerFileKind; label: string }[] = [
  { kind: "accounts", label: "Accounts" },
  { kind: "categories", label: "Categories and groups" },
  { kind: "entries", label: "Transactions" },
  { kind: "templates", label: "Templates" },
  // The glossary's two words for the record. The sidebar's one word names a
  // page to go to, and a box beside "Templates" and "Budgets" names a record.
  { kind: "recurrences", label: "Recurring transactions" },
  { kind: "budgets", label: "Budgets" },
  { kind: "staged", label: "Staged transactions" },
  // The two Settings headings that hold what this carries — timezone and
  // default currency under one, the theme under the other — so somebody
  // checking what the box means finds the same words there.
  { kind: "preferences", label: "Regional defaults and appearance" },
  { kind: "history", label: "Activity history (kept in the file, cannot be imported)" },
];

/** How much of each chosen account a "Some accounts" export carries. */
type AccountDetail = "accounts" | "entries" | "range";

/**
 * A selection the shared schema refused, in the shape a server refusal arrives
 * in.
 *
 * Checked before anything is fetched, with the schema the route parses, so the
 * sentence beside a field is the one the server would have answered with and a
 * range that ends before it starts never costs a request. An `ApiClientError`
 * because that is what `ErrorSummary` and `Field` read: each sentence with the
 * request path it is about, so the end date says its own.
 */
function refusedSelection(
  issues: readonly { path: readonly PropertyKey[]; message: string; code?: string }[],
) {
  const kept = issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    // The shared sentence is right for the route and the tool, where leaving
    // the ids out exports every account. Here the same move is unticking every
    // box, which disables the button, so the page names the move that works on
    // it instead (`common.md` §Errors: the advice is the part that differs).
    const message =
      path === "accountIds" && issue.code === "too_big"
        ? `Choose at most ${MAX_LEDGER_FILE_ACCOUNT_CHOICES} accounts, or choose Everything to export every account`
        : issue.message;
    return { path, message };
  });
  return new ApiClientError(
    "VALIDATION_ERROR",
    kept[0]!.message,
    kept,
    kept.map((issue) => issue.message),
    kept,
  );
}

/**
 * The export half of the page: a Simple Balance file of the whole ledger, or of
 * the accounts somebody picks.
 *
 * Exported because `tests/radio-groups.test.tsx` renders every exported
 * component that writes a radio, and this one writes three groups.
 *
 * The file is fetched with `download`, the way the transactions CSV is, rather
 * than followed as a link. A refusal — over the row cap, an account that is not
 * this person's, a session that lapsed — then arrives as a sentence on this page
 * instead of as a page of raw JSON in place of the app.
 */
export function LedgerFileExport() {
  const heading = useId();
  const scopeGroup = useId();
  const rangeGroup = useId();
  const detailGroup = useId();
  const [scope, setScope] = useState<LedgerFileAccountScope>("all");
  // One set for both halves, deleted entries included: somebody who unticks
  // them under Everything and then picks Some accounts meant the same there.
  const [kinds, setKinds] = useState<ReadonlySet<LedgerFileKind>>(
    () => new Set(defaultLedgerFileKinds),
  );
  const [ranged, setRanged] = useState(false);
  const [detail, setDetail] = useState<AccountDetail>("accounts");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  // Archived accounts too, because a file is how an account somebody has put
  // away takes its history to another copy. Not fetched until Some accounts is
  // chosen: Everything names no account and needs no list.
  const accounts = useQuery({
    queryKey: ["accounts", "including-archived"],
    queryFn: () => api<Account[]>("/api/v1/accounts?includeArchived=true"),
    enabled: scope === "chosen",
  });
  // The accounts in use first and the archived ones after them, each in the
  // server's name order, so the ones somebody is most likely picking from are
  // the ones at the top.
  const listed = useMemo(() => {
    const all = accounts.data ?? [];
    return [
      ...all.filter((account) => !account.archivedAt),
      ...all.filter((account) => account.archivedAt),
    ];
  }, [accounts.data]);

  const entries = kinds.has("entries");
  const history = kinds.has("history");
  // What a range narrows under Everything: the entries, and the activity
  // history by the days its events happened. Either one is enough to offer it,
  // because a history too long for one file is exported a range at a time.
  const rangeable = entries || history;
  const withDeleted = kinds.has("deletedEntries");
  const range = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  // Narrowed to the accounts still listed, as the active-account chooser does:
  // the list can change under a held choice, and an id that has gone would turn
  // the whole export into "Account not found".
  const accountIds = listed
    .filter((account) => chosen.has(account.id))
    .map((account) => account.id);
  const sent: ReadonlySet<LedgerFileKind> =
    scope === "all"
      ? kinds
      : new Set<LedgerFileKind>(
          detail === "accounts"
            ? ["accounts"]
            : [
                "accounts",
                "categories",
                "entries",
                ...(withDeleted ? ["deletedEntries" as const] : []),
              ],
        );
  /**
   * What the page sends, worked out from the controls on every render rather
   * than kept beside them, so the request and the screen cannot disagree.
   *
   * In the format's own order, whichever half built it, so one choice is one
   * query string. A narrowing whose parent is off is left out rather than sent:
   * deleted entries without Transactions, and a range with neither Transactions
   * nor the activity history, are both refusals in the shared schema, and the
   * controls that set them are disabled for that reason.
   */
  const selection: LedgerFileSelection = {
    kinds: ledgerFileKinds.filter(
      (kind) => sent.has(kind) && (kind !== "deletedEntries" || sent.has("entries")),
    ),
    ...(scope === "chosen" ? { accountIds } : {}),
    ...((scope === "all" ? rangeable && ranged : detail === "range") ? range : {}),
  };

  const listReady = Boolean(accounts.data?.length);
  const disabled =
    scope === "all" ? selection.kinds.length === 0 : !listReady || accountIds.length === 0;
  const disabledReason =
    scope === "all"
      ? "Choose at least one kind of record to export."
      : listReady
        ? "Choose at least one account to export."
        : noAccountReason(accounts);

  const exportFile = useMutation({
    mutationFn: async (asked: LedgerFileSelection) => {
      const checked = ledgerFileSelectionSchema.safeParse(asked);
      if (!checked.success) throw refusedSelection(checked.error.issues);
      // `export_ledger_file` answers with `ledgerFile`, `rowCount` and
      // `fileName`, and the page reads none of the three by name (`web.md`
      // 11.9): the route serves the same text as the response body, which goes
      // to the download unread, and the name as `Content-Disposition`. The row
      // count is for an agent deciding whether to cut a range; a person has the
      // file. The second argument is the name to save under if the server's is
      // missing, which a proxy in front of it may strip: `download` falls back
      // to `export.csv` otherwise, JSON under a spreadsheet's name.
      await download(
        `/api/v1/ledger-file?${ledgerFileQueryString(checked.data)}`,
        "simple-balance.json",
      );
    },
  });

  /**
   * A refusal is about the form as it was sent, so a switch that changes which
   * fields are on it clears the refusal with it: the scope, the range, the
   * detail, and the two boxes the range depends on. Left up, it named a date
   * field that was no longer there — a summary link focusing nothing — or sat
   * beside a form whose own button said something else was wrong. Typing in a
   * field does not clear it; the next submit does, as everywhere else.
   */
  const reconsider = () => exportFile.reset();

  const tick = (kind: LedgerFileKind, on: boolean) => {
    if (kind === "entries" || kind === "history") reconsider();
    setKinds((current) => {
      const next = new Set(current);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  // What the start date does, said on the field so a screen reader hears it
  // there (`web.md` 8.1). The carry is only in a file with accounts and their
  // entries in it, and the history is only Everything's.
  const startHint =
    [
      sent.has("accounts") && sent.has("entries")
        ? "Each account carries what it held the day before, so its balance in the file still adds up."
        : null,
      scope === "all" && history ? "The activity history covers the same days." : null,
    ]
      .filter((sentence) => sentence !== null)
      .join(" ") || undefined;

  // A ledger too large for one file is moved a range at a time, and every
  // range with recurring transactions in it creates them where it lands. One
  // created by an earlier range can propose its next occurrence into Staged
  // before the next range arrives, and a row nobody imported waiting there
  // stops the move. The agent's tool says this in its description; here it
  // is said on the choice that makes a range — the "Transactions from" radio
  // group — rather than on End date, which it says nothing about: there it
  // ran six lines in a 252px column and pushed the two date labels about
  // 65px apart, and a screen reader heard it on a date field, seven rows
  // after the checkbox it is about.
  const rangeAdvice =
    scope === "all" && kinds.has("recurrences") && ranged
      ? "When a ledger moves a range at a time, only the latest range should carry recurring transactions: one an earlier range brings can propose a row into Staged before the next range is moved, which stops the move until that row is discarded."
      : undefined;

  // One start and one end for both halves, so a range typed under one is still
  // there after switching to the other. `required` is what refuses an empty
  // one, in the person's own language (`common.md` §Errors), and a disabled
  // field is not asked.
  const rangeFields = (off: boolean) => (
    <div className="two-columns ledger-export-range">
      <Field label="Start date" name="start" hint={startHint}>
        <Input
          type="date"
          required
          disabled={off}
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </Field>
      <Field label="End date" name="end">
        <Input
          type="date"
          required
          disabled={off}
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </Field>
    </div>
  );

  return (
    <section className="import-section" aria-labelledby={heading}>
      <div className="section-title">
        <div>
          <h2 id={heading}>Export a Simple Balance file</h2>
          <p>
            Your whole ledger, or some of its accounts, in one file to keep or to move to another
            copy of Simple Balance. For a spreadsheet of transactions, export a CSV from
            Transactions instead.
          </p>
        </div>
      </div>
      <Form
        className="panel ledger-export"
        error={exportFile.error}
        onSubmit={(event) => {
          event.preventDefault();
          exportFile.mutate(selection);
        }}
      >
        <ErrorSummary error={exportFile.error} />
        <fieldset className="commit-choice">
          <legend>What to export</legend>
          <label>
            <input
              type="radio"
              name={scopeGroup}
              checked={scope === "all"}
              onChange={() => {
                reconsider();
                setScope("all");
              }}
            />
            <span>
              <strong>Everything</strong>
              <small>The kinds of record you choose, across the whole ledger</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name={scopeGroup}
              checked={scope === "chosen"}
              onChange={() => {
                reconsider();
                setScope("chosen");
              }}
            />
            <span>
              <strong>Some accounts</strong>
              <small>The accounts you pick, with or without their transactions</small>
            </span>
          </label>
        </fieldset>

        {scope === "all" ? (
          <>
            <Field
              as="group"
              label="What the file holds"
              hint="Anything you leave out still travels by name wherever something in the file refers to it."
              name="kinds"
            >
              <div className="ledger-export-choices">
                {KIND_CHOICES.map(({ kind, label }) => (
                  <Fragment key={kind}>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={kinds.has(kind)}
                        onChange={(event) => tick(kind, event.target.checked)}
                      />
                      {label}
                    </label>
                    {kind === "entries" ? (
                      <label className="check-label ledger-export-nested">
                        <input
                          type="checkbox"
                          checked={withDeleted}
                          disabled={!entries}
                          onChange={(event) => tick("deletedEntries", event.target.checked)}
                        />
                        Include deleted transactions
                      </label>
                    ) : null}
                  </Fragment>
                ))}
              </div>
            </Field>
            <div className="field">
              {/* Named for what the range will narrow, so the question
                  never asks about transactions in a file holding none. */}
              <span className="field-label" id={`${rangeGroup}-question`}>
                {entries && history
                  ? "Transactions and activity from"
                  : history
                    ? "Activity history from"
                    : "Transactions from"}
              </span>
              {rangeAdvice ? (
                <span className="field-hint" id={`${rangeGroup}-advice`}>
                  {rangeAdvice}
                </span>
              ) : null}
              <div
                className="radio-row"
                role="radiogroup"
                aria-labelledby={`${rangeGroup}-question`}
                aria-describedby={rangeAdvice ? `${rangeGroup}-advice` : undefined}
              >
                <label className="check-label">
                  <input
                    type="radio"
                    name={rangeGroup}
                    checked={!ranged}
                    disabled={!rangeable}
                    onChange={() => {
                      reconsider();
                      setRanged(false);
                    }}
                  />
                  All time
                </label>
                <label className="check-label">
                  <input
                    type="radio"
                    name={rangeGroup}
                    checked={ranged}
                    disabled={!rangeable}
                    onChange={() => {
                      reconsider();
                      setRanged(true);
                    }}
                  />
                  Date range
                </label>
              </div>
            </div>
            {ranged ? rangeFields(!rangeable) : null}
          </>
        ) : (
          <>
            <Field
              as="group"
              label="Accounts"
              hint={`Up to ${MAX_LEDGER_FILE_ACCOUNT_CHOICES} accounts in one file. Archived accounts are listed too. Where a transfer runs to an account you did not choose, that account travels by its name only.`}
              name="accountIds"
            >
              {accounts.error ? (
                <Alert>{accounts.error.message}</Alert>
              ) : accounts.isPending ? (
                <Skeleton height={64} label="Loading accounts…" />
              ) : listed.length ? (
                <ul className="ledger-export-choices ledger-export-accounts">
                  {listed.map((account) => (
                    <li key={account.id}>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={chosen.has(account.id)}
                          onChange={(event) => {
                            const next = new Set(chosen);
                            if (event.target.checked) next.add(account.id);
                            else next.delete(account.id);
                            setChosen(next);
                          }}
                        />
                        {/* The spaces are for the name a screen reader reads,
                            which runs the parts together without them; on
                            screen the label's gap does the spacing. Frozen
                            accounts carry no mark: a frozen account is fully
                            readable, and reading is all an export does. */}
                        {account.name} <span className="subtle">{account.currency}</span>
                        {account.archivedAt ? (
                          <>
                            {" "}
                            <Badge>Archived</Badge>
                          </>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <Note>There are no accounts to choose from yet.</Note>
              )}
            </Field>
            <div className="field">
              <span className="field-label" id={`${detailGroup}-question`}>
                With their transactions
              </span>
              <div
                className="radio-row"
                role="radiogroup"
                aria-labelledby={`${detailGroup}-question`}
              >
                <label className="check-label">
                  <input
                    type="radio"
                    name={detailGroup}
                    checked={detail === "accounts"}
                    onChange={() => {
                      reconsider();
                      setDetail("accounts");
                    }}
                  />
                  No, account details only
                </label>
                <label className="check-label">
                  <input
                    type="radio"
                    name={detailGroup}
                    checked={detail === "entries"}
                    onChange={() => {
                      reconsider();
                      setDetail("entries");
                    }}
                  />
                  All of them
                </label>
                <label className="check-label">
                  <input
                    type="radio"
                    name={detailGroup}
                    checked={detail === "range"}
                    onChange={() => {
                      reconsider();
                      setDetail("range");
                    }}
                  />
                  In a date range
                </label>
              </div>
            </div>
            {detail === "accounts" ? null : (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={withDeleted}
                  onChange={(event) => tick("deletedEntries", event.target.checked)}
                />
                Include deleted transactions
              </label>
            )}
            {detail === "range" ? rangeFields(false) : null}
          </>
        )}

        <div className="form-actions">
          <Button
            type="submit"
            loading={exportFile.isPending}
            disabled={disabled}
            disabledReason={disabledReason}
          >
            <Download size={16} /> Export file
          </Button>
        </div>
      </Form>
    </section>
  );
}
