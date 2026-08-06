import { Link } from "../router.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  FlaskConical,
  Upload,
} from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { isAppExportCsv, type CsvMapping } from "../../shared/csv.js";
import {
  api,
  json,
  queryString,
  type Account,
  type CsvPreview,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  PageHeader,
  Select,
} from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";

type StageResult = {
  fileName: string;
  rowCount: number;
  validCount: number;
  invalidCount: number;
  importBatchId?: string;
  stagedIds?: string[];
  sample: {
    draft: Record<string, unknown> | null;
    issues: { field: string; message: string }[];
  }[];
  referenceResolution: {
    categories: {
      inputName: string;
      resolvedName: string;
      categoryId: string | null;
      kind: "income" | "expense" | "both";
      resolution: "existing" | "new" | "updated";
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
  externalId: ["transaction_id", "id", "external id"],
};

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
  const stageIdempotencyKey = useRef(newIdempotencyKey());

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<Account[]>("/api/v1/accounts"),
  });

  const appExport = preview ? isAppExportCsv(preview.headers) : false;

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
      stageIdempotencyKey.current = newIdempotencyKey();
    },
  });

  const stageMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<StageResult>(
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
    onSuccess: async (value, dryRun) => {
      setResult(value);
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
    csv &&
      defaultAccountId &&
      (appExport || (mapping.date && mapping.payee && hasAmounts)),
  );
  const sampleHeaders = useMemo(() => preview?.headers.slice(0, 8) ?? [], [preview]);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) previewMutation.mutate(file);
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
        <p className="settings-note">Loading accounts…</p>
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
              <input type="file" accept=".csv,text/csv" onChange={chooseFile} />
            </label>
            {previewMutation.error ? <Alert>{previewMutation.error.message}</Alert> : null}
            {preview ? (
              <>
                <div className="step-heading">
                  <span>2</span>
                  <div>
                    <h2>{appExport ? "Choose the account" : "Map the columns"}</h2>
                    <p>
                      Detected <strong>{preview.delimiter === "\t" ? "tab" : preview.delimiter}</strong>{" "}
                      delimiter and {preview.headers.length} columns.
                    </p>
                  </div>
                </div>
                {appExport ? (
                  <Alert kind="info">
                    This is a Simple Balance export, so its dates, amounts,
                    categories, and text are read from the columns it already
                    names and there is nothing to map. Every row is posted
                    against the account you choose here, whichever account the
                    file was exported from. Transfers name a second account,
                    which is a choice this screen cannot make, so they arrive in
                    the queue asking for it.
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
                          onChange={(category) =>
                            setMapping((value) => ({ ...value, category }))
                          }
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
                        <Alert>Map a signed amount column or one or both debit/credit columns.</Alert>
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
                {result ? (
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
                              everything ever staged. */}
                          <Link
                            to={{
                              pathname: "/staged",
                              search: queryString({
                                importBatchId: result.importBatchId,
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
                        Categories: {result.referenceResolution.categories.filter(
                          (item) => item.resolution === "existing",
                        ).length} matched, {result.referenceResolution.categories.filter(
                          (item) => item.resolution === "new",
                        ).length} new, and {result.referenceResolution.categories.filter(
                          (item) => item.resolution === "updated",
                        ).length} updated. Payees:{" "}
                        {result.referenceResolution.payees.filter(
                          (item) => item.resolution === "existing",
                        ).length} matched and {result.referenceResolution.payees.filter(
                          (item) => item.resolution === "new",
                        ).length} new.
                      </Alert>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </section>

          <aside className="panel import-preview">
            <header className="panel-header">
              <h3>File preview</h3>
              {preview ? <Badge tone="blue">{preview.rows.length} sampled</Badge> : null}
            </header>
            {preview?.rows.length ? (
              <div className="preview-table-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      {sampleHeaders.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 12).map((row, index) => (
                      <tr key={index}>
                        {sampleHeaders.map((header) => (
                          <td key={header}>{row[header]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
