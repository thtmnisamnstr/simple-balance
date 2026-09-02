import { Link } from "../router.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, FileSpreadsheet, FlaskConical, Upload } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { isAppExportCsv, type CsvMapping } from "../../shared/csv.js";
import { type StagedDraft } from "../../shared/domain.js";
import {
  api,
  json,
  queryString,
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
  Field,
  PageHeader,
  Select,
  Skeleton,
} from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";
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
      kind: "income" | "expense" | "both";
      resolution: "existing" | "new" | "updated" | "deferred";
      unarchived: boolean;
    }[];
    payees: {
      inputPayee: string;
      resolvedPayee: string;
      resolution: "existing" | "new";
    }[];
  };
};

const aliases: Record<keyof CsvMapping, string[]> = {
  date: ["date", "posted date", "transaction date"],
  description: ["description", "memo", "details"],
  amount: ["amount", "signed amount"],
  debit: ["debit", "withdrawal", "money out"],
  credit: ["credit", "deposit", "money in"],
  payee: ["payee", "merchant", "description", "memo", "details", "name"],
  category: ["category"],
  notes: ["notes", "note"],
  // The file's own column first. `transaction_id` is the primary key of the
  // ledger the export came from and means nothing here, so guessing it as a
  // bank reference fabricates one and keys the duplicate check on it.
  externalId: ["external_id", "external id", "reference", "fitid"],
};

/**
 * How many rows the panel draws.
 *
 * Twelve, not the twenty-five the sample carries: `.import-preview` is sticky,
 * and a table taller than the viewport pins with its last rows out of reach.
 */
const PREVIEW_ROWS = 12;

function inferMapping(headers: string[]): Partial<CsvMapping> {
  const normalized = new Map(headers.map((header) => [header.toLowerCase(), header]));
  return Object.fromEntries(
    Object.entries(aliases).flatMap(([key, candidates]) => {
      const match = candidates.map((candidate) => normalized.get(candidate)).find(Boolean);
      return match ? [[key, match]] : [];
    }),
  );
}

function MappingField({
  label,
  value,
  headers,
  required,
  onChange,
}: {
  label: string;
  value?: string;
  headers: string[];
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
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
  const [dateFormat, setDateFormat] = useState<"YMD" | "MDY" | "DMY">("YMD");
  const [decimalSeparator, setDecimalSeparator] = useState<"." | ",">(".");
  const [result, setResult] = useState<StageResult | null>(null);
  const [resultReading, setResultReading] = useState("");
  const stageIdempotencyKey = useRef(newIdempotencyKey());

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });

  const appExport = preview ? isAppExportCsv(preview.headers) : false;

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
      setMapping(inferMapping(parsed.headers));
      setDefaultAccountId((current) => current || accounts.data?.[0]?.id || "");
      setResult(null);
      setResultReading("");
      stageIdempotencyKey.current = newIdempotencyKey();
    },
  });

  const stageMutation = useMutation({
    mutationFn: async (dryRun: boolean) => ({
      // Read here rather than in onSuccess: React Query re-reads its options on
      // every render, so a control touched while the request was in flight would
      // stamp a stale interpretation as the current one, which is the single
      // thing the stamp exists to prevent.
      reading,
      value: await api<StageResult>(
        "/api/v1/csv/stage",
        json({
          csv,
          fileName,
          idempotencyKey: stageIdempotencyKey.current,
          defaultAccountId,
          mapping: appExport ? undefined : mapping,
          dateFormat,
          decimalSeparator,
          dryRun,
        }),
      ),
    }),
    onSuccess: async ({ value, reading: stamped }, dryRun) => {
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
  });

  const hasAmounts = Boolean(mapping.amount || mapping.debit || mapping.credit);
  const ready = Boolean(
    csv && defaultAccountId && (appExport || (mapping.date && mapping.payee && hasAmounts)),
  );
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

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) previewMutation.mutate(file);
    // Cleared so the same file can be chosen again. A file input whose value
    // still names the file fires no change event for re-picking it — and
    // re-picking is exactly what somebody does after fixing the file the
    // preview just complained about.
    event.target.value = "";
  };

  return (
    <>
      <PageHeader
        eyebrow="Import"
        title="Import a CSV"
        description={
          appExport
            ? "Choose the account, check the preview, then stage the rows."
            : "Match your columns, check the preview, then stage the rows."
        }
      />

      {accounts.error ? <Alert>{accounts.error.message}</Alert> : null}
      {accounts.isPending ? (
        <Skeleton height={64} label="Loading accounts…" />
      ) : accounts.error ? null : !accounts.data?.length ? (
        <EmptyState
          icon={<FileSpreadsheet size={25} />}
          title="Create an account first"
          body="A CSV needs an account for its rows to be posted against."
        />
      ) : (
        <div className="import-layout">
          <section className="panel import-steps">
            <div className="step-heading">
              <span>1</span>
              <div>
                <h2>Choose a CSV file</h2>
                <p>Files are parsed in memory and the original is not stored on disk.</p>
              </div>
            </div>
            <label className="file-drop">
              <Upload size={26} />
              <strong>{fileName || "Drop in a file or browse"}</strong>
              <span>Comma, semicolon, and tab delimiters are detected automatically.</span>
              <span>A very large export may need importing one date range at a time.</span>
              <input type="file" accept=".csv,text/csv" onChange={chooseFile} />
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
                    <h2>{appExport ? "Choose the account" : "Map the columns"}</h2>
                    <p>
                      Detected{" "}
                      <strong>{preview.delimiter === "\t" ? "tab" : preview.delimiter}</strong>{" "}
                      delimiter and {preview.headers.length} columns.
                    </p>
                  </div>
                </div>
                {appExport ? (
                  <Alert kind="info">
                    This is a Simple Balance export, so its dates, amounts, categories, and text are
                    read from the columns it already names and there is nothing to map. Every row is
                    posted against the account you choose here, whichever account the file was
                    exported from. Transfers name a second account, which is a choice this screen
                    cannot make, so they arrive in the queue asking for it.
                  </Alert>
                ) : null}
                <div className="form-grid">
                  <div className={appExport ? undefined : "two-columns"}>
                    <Field label="Account">
                      <Select
                        value={defaultAccountId}
                        onChange={(event) => setDefaultAccountId(event.target.value)}
                      >
                        {accounts.data?.map((account) => (
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
                              setDecimalSeparator(event.target.value as "." | ",")
                            }
                          >
                            <option value=".">1,234.56</option>
                            <option value=",">1.234,56</option>
                          </Select>
                        </Field>
                      </div>
                      {!hasAmounts ? (
                        <Alert>
                          Map a signed amount column or one or both debit/credit columns.
                        </Alert>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="step-heading">
                  <span>3</span>
                  <div>
                    <h2>Validate and stage</h2>
                    <p>A dry run reports problems without changing anything.</p>
                  </div>
                </div>
                <div className="form-actions">
                  <Button
                    variant="secondary"
                    disabled={!ready}
                    loading={stageMutation.isPending}
                    onClick={() => stageMutation.mutate(true)}
                  >
                    <FlaskConical size={16} /> Dry run
                  </Button>
                  <Button
                    disabled={!ready}
                    loading={stageMutation.isPending}
                    onClick={() => stageMutation.mutate(false)}
                  >
                    Stage all rows <ArrowRight size={16} />
                  </Button>
                </div>
                {stageMutation.error ? <Alert>{stageMutation.error.message}</Alert> : null}
                {/* A dry run is a prediction and goes stale with the settings it
                    was run under. A completed stage describes rows already
                    written, so it is history and cannot. */}
                {result && (result.importBatchId || !stale) ? (
                  <>
                    <Alert kind={result.invalidCount ? "info" : "success"}>
                      <strong>{result.validCount}</strong> ready and{" "}
                      <strong>{result.invalidCount}</strong> needing attention out of{" "}
                      {result.rowCount} rows.
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
                            Review these {result.rowCount} rows
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
                        Categories:{" "}
                        {
                          result.referenceResolution.categories.filter(
                            (item) => item.resolution === "existing",
                          ).length
                        }{" "}
                        matched,{" "}
                        {
                          result.referenceResolution.categories.filter(
                            (item) => item.resolution === "new",
                          ).length
                        }{" "}
                        new, and{" "}
                        {
                          result.referenceResolution.categories.filter(
                            (item) => item.resolution === "updated",
                          ).length
                        }{" "}
                        updated. Payees:{" "}
                        {
                          result.referenceResolution.payees.filter(
                            (item) => item.resolution === "existing",
                          ).length
                        }{" "}
                        matched and{" "}
                        {
                          result.referenceResolution.payees.filter(
                            (item) => item.resolution === "new",
                          ).length
                        }{" "}
                        new.
                      </Alert>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </section>

          <aside className="panel import-preview">
            <header className="panel-header">
              <h3>{interpreted ? "As it will be read" : "File preview"}</h3>
              {interpreted ? (
                // Says what is on screen rather than what came back: twelve rows
                // are rendered out of a sample of twenty-five out of the file.
                <Badge tone="blue">
                  {Math.min(interpreted.sample.length, PREVIEW_ROWS)} of {interpreted.rowCount} rows
                </Badge>
              ) : preview ? (
                <Badge tone="blue">{preview.rows.length} sampled</Badge>
              ) : null}
            </header>
            {interpreted ? (
              <div className="preview-table-wrap">
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
                      <th scope="col">Amount</th>
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
                          <td>{date ? formatDate(date) : "—"}</td>
                          <td>{stagedString(draft.payee).trim() || "Incomplete row"}</td>
                          <td>{summary.account}</td>
                          <td>
                            {legs.length ? (
                              <div className="transaction-payee">
                                <span>
                                  {categoryLabel(largest?.categoryId, largest?.categoryName)}
                                </span>
                                <Badge tone="blue">Split · {legs.length}</Badge>
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
                <div className="preview-table-wrap">
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
                          {sampleHeaders.map((header) => (
                            <td key={header}>{row[header]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-hint">Run a dry run to see how these rows will be read.</p>
              </>
            ) : (
              <EmptyState
                icon={<CheckCircle2 size={23} />}
                title="No file yet"
                body="A sample of the file appears here before anything is staged."
              />
            )}
          </aside>
        </div>
      )}
    </>
  );
}
