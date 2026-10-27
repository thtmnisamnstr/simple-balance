// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, CsvPreview, CsvSampleRow } from "../src/client/api.js";
import { APP_CSV_COLUMNS } from "../src/shared/csv.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import { BrowserRouter } from "../src/client/router.js";

const checking: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
};

const card: Account = {
  ...checking,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Other Card",
  type: "credit_card",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dining: Category = { id: "cat-dining", name: "Dining", kind: "expense", version: 1 };

/**
 * The stage reply, in the shape the service returns it.
 *
 * `sample` defaults to empty because a header-only file samples nothing, and a
 * panel that swapped the file's own cells for an empty table would be showing
 * less than it started with.
 */
function stubApi(
  preview: CsvPreview,
  accounts: Account[] = [checking],
  stage: Partial<{ sample: CsvSampleRow[] } & Record<string, unknown>> = {},
  categories: Category[] = [dining],
) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
      if (url.pathname === "/api/v1/categories") return Response.json(categories);
      if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
      if (url.pathname === "/api/v1/csv/stage") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          fileName: "export.csv",
          rowCount: 1,
          validCount: 1,
          invalidCount: 0,
          sample: [],
          referenceResolution: { categories: [], payees: [] },
          ...stage,
        });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return bodies;
}

async function chooseFile(csv: string, name: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ImportPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Choose a CSV file" });
  const file = new File([csv], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => csv });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
}

describe("CSV reference resolution UI", () => {
  it("maps the category column and explains automatic category/payee handling", async () => {
    const csv = ["date,payee,category,amount", "2026-07-31,ACME Market,Dining,-12.34"].join("\n");
    const preview: CsvPreview = {
      delimiter: ",",
      headers: ["date", "payee", "category", "amount"],
      rows: [
        {
          date: "2026-07-31",
          payee: "ACME Market",
          category: "Dining",
          amount: "-12.34",
        },
      ],
      errors: [],
    };
    let stageBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") {
          return Response.json([checking]);
        }
        if (url.pathname === "/api/v1/csv/preview") {
          return Response.json(preview);
        }
        if (url.pathname === "/api/v1/csv/stage") {
          stageBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            fileName: "bank.csv",
            rowCount: 1,
            validCount: 1,
            invalidCount: 0,
            sample: [],
            referenceResolution: {
              categories: [
                {
                  inputName: "Dining",
                  resolvedName: "Dining",
                  categoryId: null,
                  kind: "expense",
                  resolution: "new",
                  unarchived: false,
                },
              ],
              payees: [
                {
                  inputPayee: "ACME Market",
                  resolvedPayee: "Acme Market",
                  resolution: "existing",
                },
              ],
            },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ImportPage />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Choose a CSV file" });

    const file = new File([csv], "bank.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    expect(await screen.findByLabelText("Category")).toHaveValue("category");
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => {
      expect(stageBody).toMatchObject({
        mapping: { category: "category", payee: "payee" },
        dryRun: true,
      });
    });
    expect(screen.getByText(/Categories: 0 matched, 1 new, and 0 updated/)).toBeInTheDocument();
    expect(screen.getByText(/Payees: 1 matched and 0 new/)).toBeInTheDocument();
  });
});

/**
 * Every column mapping shown for one of our own exports is a control that
 * decides nothing, and one of them looked like it decided the account. The
 * screen asks for the account and nothing else.
 */
describe("importing a Simple Balance export", () => {
  const headers = [...APP_CSV_COLUMNS];
  const preview: CsvPreview = {
    delimiter: ",",
    headers,
    rows: [Object.fromEntries(headers.map((header) => [header, ""]))],
    errors: [],
  };
  const csv = `${headers.join(",")}\n`;

  it("asks for the account and hides the mapping it would ignore", async () => {
    stubApi(preview, [checking, card]);
    await chooseFile(csv, "simple-balance-export.csv");

    await screen.findByRole("heading", { name: "Choose the account" });
    expect(screen.getByLabelText("Account")).toBeInTheDocument();
    expect(
      screen.getByText(/Every row is posted against the account you choose/),
    ).toBeInTheDocument();

    for (const label of [
      "Date",
      "Payee",
      "Signed amount",
      "Debit",
      "Credit",
      "Category",
      "Description",
      "Notes",
      "Date format",
      "Decimal separator",
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  /**
   * The alphabetically first of several accounts used to be chosen for the
   * person, one press from staging a whole file into an account nobody had
   * named. Found by the 0.2.0 sandbox smoke test, where it was somebody
   * else's card.
   */
  it("chooses no account for the person when there are several to choose from", async () => {
    stubApi(preview, [checking, card]);
    await chooseFile(csv, "simple-balance-export.csv");

    const account = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    expect(account.value).toBe("");
    expect(account.options[account.selectedIndex]?.textContent).toBe("Choose an account");
    expect((screen.getByRole("button", { name: "Dry run" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("chooses the only account there is", async () => {
    stubApi(preview, [card]);
    await chooseFile(csv, "simple-balance-export.csv");
    expect(((await screen.findByLabelText("Account")) as HTMLSelectElement).value).toBe(card.id);
  });

  it("stages against the chosen account and sends no mapping", async () => {
    const bodies = stubApi(preview, [checking, card]);
    await chooseFile(csv, "simple-balance-export.csv");

    const account = await screen.findByLabelText("Account");
    fireEvent.change(account, { target: { value: card.id } });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ defaultAccountId: card.id, dryRun: true });
    expect(bodies[0]).not.toHaveProperty("mapping");
  });

  it("still asks for a mapping when the file is not one of ours", async () => {
    stubApi({
      delimiter: ",",
      headers: ["transaction_type", "date", "description", "amount"],
      rows: [],
      errors: [],
    });
    await chooseFile("transaction_type,date,description,amount\n", "bank.csv");

    await screen.findByRole("heading", { name: "Map the columns" });
    expect(screen.getByLabelText("Signed amount")).toBeInTheDocument();
  });
});

/**
 * The page takes both answers off the preview the server sent, which is what
 * `preview_csv` hands an agent, rather than working out its own.
 *
 * Each case below gives the page a reply the headings alone would not have
 * produced, so a page that went on guessing for itself fails it. The cases
 * above send no such fields, which is a server from before they existed, and
 * pass on the fallback — the rolling-update path, checked by the same file.
 */
describe("what the preview says about the file", () => {
  it("starts the mapping from the server's guess", async () => {
    stubApi({
      delimiter: ",",
      headers: ["When", "Who", "How much"],
      rows: [],
      errors: [],
      simpleBalanceExport: false,
      suggestedMapping: { date: "When", payee: "Who", amount: "How much" },
    });
    await chooseFile("When,Who,How much\n", "bank.csv");

    expect(await screen.findByLabelText("Date")).toHaveValue("When");
    expect(screen.getByLabelText("Payee")).toHaveValue("Who");
    expect(screen.getByLabelText("Signed amount")).toHaveValue("How much");
  });

  /**
   * The delimiter as a word. It printed the character, so a comma-separated
   * file read "Detected , delimiter" — a bold comma that looks like stray
   * punctuation and that a screen reader skips — and two of the six Papa can
   * guess are control characters that print as nothing.
   */
  it.each([
    [",", "comma"],
    ["\t", "tab"],
    ["\u001f", "unit separator"],
  ])("names the %j delimiter it found", async (delimiter, word) => {
    stubApi({ delimiter, headers: ["When", "Who", "How much"], rows: [], errors: [] });
    await chooseFile("When,Who,How much\n", "bank.csv");

    expect(
      await screen.findByText((_, element) =>
        element?.tagName === "P"
          ? element.textContent === `Detected a ${word} delimiter and 3 columns.`
          : false,
      ),
    ).toBeInTheDocument();
  });

  it("asks only for the account when the server says the file is an export", async () => {
    stubApi({
      delimiter: ",",
      headers: ["date", "payee", "amount"],
      rows: [],
      errors: [],
      simpleBalanceExport: true,
      suggestedMapping: {},
    });
    await chooseFile("date,payee,amount\n", "export.csv");

    await screen.findByRole("heading", { name: "Choose the account" });
    expect(screen.queryByLabelText("Payee")).toBeNull();
  });
});

/**
 * A right preview and a wrong import is a bug rather than a surprise, so the
 * panel stops showing the file's own cells once the server has read them and
 * shows what it read instead.
 */
describe("the interpreted preview", () => {
  const preview: CsvPreview = {
    delimiter: ",",
    headers: ["date", "payee", "category", "amount"],
    rows: [{ date: "2026-07-31", payee: "ACME Market", category: "Dining", amount: "-12.34" }],
    errors: [],
  };
  const csv = ["date,payee,category,amount", "2026-07-31,ACME Market,Dining,-12.34"].join("\n");

  const withdrawal = (extra: Record<string, unknown> = {}): CsvSampleRow => ({
    draft: {
      type: "withdrawal",
      date: "2026-07-31",
      payee: "ACME Market",
      fromAccountId: checking.id,
      amount: "12.34",
      ...extra,
    } as CsvSampleRow["draft"],
    issues: [],
  });

  const dryRun = async () => {
    await screen.findByRole("heading", { name: "Map the columns" });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  };

  it("shows the first rows as they will be read", async () => {
    stubApi(preview, [checking], {
      rowCount: 2,
      validCount: 1,
      invalidCount: 1,
      sample: [
        withdrawal({ categoryId: dining.id }),
        {
          draft: null,
          partial: { type: "withdrawal", payee: "Missing a date", fromAccountId: checking.id },
          issues: [{ field: "date", message: "Date could not be parsed" }],
        },
      ],
    });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    expect(screen.getByText("Jul 31, 2026")).toBeInTheDocument();
    expect(screen.getByText("ACME Market")).toBeInTheDocument();
    expect(screen.getAllByText("Checking")).toHaveLength(2);
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("−$12.34")).toBeInTheDocument();
    expect(screen.getByText("Missing a date")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Date could not be parsed")).toBeInTheDocument();
  });

  it("names a category the file will create", async () => {
    // The case the dry run used to get wrong in the only direction that
    // matters: nothing has been created, so there is no id, and the panel
    // reported "Uncategorized" for exactly the category the real stage was
    // about to make.
    stubApi(preview, [checking], {
      sample: [withdrawal({ categoryName: "Groceries", categoryKind: "expense" })],
    });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByText("Uncategorized")).toBeNull();
  });

  it("stops showing an interpretation the controls no longer describe", async () => {
    stubApi(preview, [checking], { sample: [withdrawal({ categoryId: dining.id })] });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "DMY" } });

    await screen.findByRole("heading", { name: "File preview" });
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
    // The counts went with it: a number somebody acts on is worse than useless
    // once the settings it was computed under are gone.
    expect(screen.queryByText(/ready and/)).toBeNull();
  });

  it("keeps what a completed stage reported when the controls change", async () => {
    stubApi(preview, [checking], {
      importBatchId: "44444444-4444-4444-8444-444444444444",
      sample: [withdrawal({ categoryId: dining.id })],
    });
    await chooseFile(csv, "bank.csv");
    await screen.findByRole("heading", { name: "Map the columns" });
    fireEvent.click(screen.getByRole("button", { name: "Stage all rows" }));

    await screen.findByRole("link", { name: /Review these 1 rows/ });
    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "DMY" } });

    // Rows already written are history, not a prediction, so they never go
    // stale — but the reading they were written under no longer describes the
    // controls, so the interpreted table goes.
    expect(screen.getByRole("link", { name: /Review these 1 rows/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
  });

  it("stamps an interpretation with the settings it was run under", async () => {
    // The race nothing else can see: change a control while the request is in
    // flight and the reply, read at the moment it arrives, would be labeled
    // with settings it knows nothing about.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
        if (url.pathname === "/api/v1/categories") return Response.json([dining]);
        if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
        if (url.pathname === "/api/v1/csv/stage") {
          await held;
          return Response.json({
            fileName: "bank.csv",
            rowCount: 1,
            validCount: 1,
            invalidCount: 0,
            sample: [withdrawal({ categoryId: dining.id })],
            referenceResolution: { categories: [], payees: [] },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );
    await chooseFile(csv, "bank.csv");
    await dryRun();

    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "MDY" } });
    release!();

    await waitFor(() => expect(screen.queryByText(/ready and/)).toBeNull());
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
    expect(screen.getByRole("heading", { name: "File preview" })).toBeInTheDocument();
  });

  it("shows the parse errors the preview reported", async () => {
    stubApi({
      ...preview,
      errors: ["Row 3: Too few fields: expected 4 fields but parsed 3"],
    });
    await chooseFile(csv, "bank.csv");

    expect(
      await screen.findByText(/Too few fields: expected 4 fields but parsed 3/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only the first rows of the file are read/)).toBeInTheDocument();
  });
});

/**
 * The bank's reference column, which the page used to guess from four headings
 * and send without ever showing. A reference under any other heading could not
 * be chosen, and a wrong guess could not be undone, though an agent's mapping
 * could do both — and a column that repeats makes every row after the first look
 * like one already imported.
 */
describe("the bank reference column", () => {
  const csv = ["date,payee,amount,Ref No", "2026-07-31,ACME Market,-12.34,A1"].join("\n");
  const preview: CsvPreview = {
    delimiter: ",",
    headers: ["date", "payee", "amount", "Ref No"],
    rows: [{ date: "2026-07-31", payee: "ACME Market", amount: "-12.34", "Ref No": "A1" }],
    errors: [],
  };

  it("can be chosen under a heading nothing guesses, and is sent", async () => {
    const bodies = stubApi(preview);
    await chooseFile(csv, "bank.csv");
    const reference = await screen.findByLabelText("Bank reference");
    expect(reference).toHaveValue("");
    fireEvent.change(reference, { target: { value: "Ref No" } });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ mapping: { externalId: "Ref No" } });
  });

  it("can be unmapped when the guess was wrong", async () => {
    const guessed = ["date,payee,amount,reference", "2026-07-31,ACME Market,-12.34,1"].join("\n");
    const bodies = stubApi({
      ...preview,
      headers: ["date", "payee", "amount", "reference"],
      rows: [{ date: "2026-07-31", payee: "ACME Market", amount: "-12.34", reference: "1" }],
    });
    await chooseFile(guessed, "bank.csv");
    const reference = await screen.findByLabelText("Bank reference");
    expect(reference).toHaveValue("reference");
    fireEvent.change(reference, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0]!.mapping as Record<string, unknown>).externalId ?? "").toBe("");
  });
});

/**
 * `web.md` 12.3: the reason names the first unmet condition, and is true in
 * the state the page is in. The two step-3 buttons exist only once a file has
 * been previewed, so "choose a file" was never the condition while they were on
 * screen, and our own export has nothing to map.
 */
describe("why the stage buttons are gray", () => {
  const reasonOf = (name: string) => {
    const button = screen.getByRole("button", { name });
    const id = button.getAttribute("aria-describedby") ?? "";
    return id
      .split(" ")
      .map((one) => document.getElementById(one)?.textContent ?? "")
      .join(" ")
      .trim();
  };

  it("asks for the account, and only the account, on our own export", async () => {
    const headers = [...APP_CSV_COLUMNS];
    stubApi(
      {
        delimiter: ",",
        headers,
        rows: [Object.fromEntries(headers.map((header) => [header, ""]))],
        errors: [],
      },
      [checking, card],
    );
    await chooseFile(`${headers.join(",")}\n`, "simple-balance-export.csv");
    await screen.findByRole("heading", { name: "Choose the account" });
    expect(reasonOf("Dry run")).toBe("Choose the account to post the rows to.");
    expect(reasonOf("Stage all rows")).toBe("Choose the account to post the rows to.");
  });

  it("names the one column still to map on a bank file", async () => {
    stubApi({
      delimiter: ",",
      headers: ["When", "Who", "How much"],
      rows: [],
      errors: [],
      simpleBalanceExport: false,
      suggestedMapping: { date: "When", amount: "How much" },
    });
    await chooseFile("When,Who,How much\n", "bank.csv");
    await screen.findByRole("heading", { name: "Map the columns" });
    expect(reasonOf("Dry run")).toBe("Map the payee column.");
  });
});

/**
 * A held request, so a test can look at the page while it waits: `release`
 * answers it with whatever `answer` builds.
 */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
}

describe("the CSV import while it works", () => {
  const csv = ["date,payee,amount", "2026-07-31,ACME Market,-12.34"].join("\n");
  const preview: CsvPreview = {
    delimiter: ",",
    headers: ["date", "payee", "amount"],
    rows: [{ date: "2026-07-31", payee: "ACME Market", amount: "-12.34" }],
    errors: [],
  };

  function stubHeld(hold: { preview?: Promise<void>; stage?: Promise<void> }) {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
        if (url.pathname === "/api/v1/categories") return Response.json([dining]);
        requests.push(url.pathname);
        if (url.pathname === "/api/v1/csv/preview") {
          await hold.preview;
          return Response.json(preview);
        }
        if (url.pathname === "/api/v1/csv/stage") {
          await hold.stage;
          return Response.json({
            fileName: "bank.csv",
            rowCount: 1,
            validCount: 1,
            invalidCount: 0,
            sample: [],
            referenceResolution: { categories: [], payees: [] },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );
    return requests;
  }

  /**
   * `web.md` 12.3: where one mutation serves several buttons, each asks which
   * action is running. Both used to take `loading={stageMutation.isPending}`,
   * so a dry run drew a spinner on, and said "Working…" through, the button
   * that writes rows.
   */
  it.each([
    ["Dry run", "Stage all rows"],
    ["Stage all rows", "Dry run"],
  ])("spins %s alone and holds %s without a reason", async (pressed, other) => {
    const stage = held();
    const requests = stubHeld({ stage: stage.gate });
    await chooseFile(csv, "bank.csv");
    await screen.findByRole("heading", { name: "Map the columns" });

    fireEvent.click(screen.getByRole("button", { name: pressed }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: new RegExp(`${pressed}$`) })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    const held_ = screen.getByRole("button", { name: other });
    expect(held_).not.toHaveAttribute("aria-busy");
    expect(held_).toHaveTextContent(other);
    expect(held_.textContent).not.toContain("Working");
    expect(held_).toBeDisabled();
    expect(held_).not.toHaveAttribute("aria-describedby");
    // Held for real: a press on it starts nothing.
    fireEvent.click(held_);
    expect(requests.filter((path) => path === "/api/v1/csv/stage")).toHaveLength(1);

    stage.release();
    await waitFor(() => expect(screen.getByRole("button", { name: other })).toBeEnabled());
  });

  /**
   * `web.md` 12.2 and 13.3: a chosen file is named and its reading shown from
   * the moment it is picked, and a second pick waits for the first. The page
   * showed nothing while a large file went up, and a second pick that answered
   * first was overwritten when the first one landed late.
   */
  it("names the file being read and refuses a second pick until it answers", async () => {
    const reading = held();
    const requests = stubHeld({ preview: reading.gate });
    await chooseFile(csv, "statement.csv");

    expect(await screen.findByRole("status")).toHaveTextContent("Reading statement.csv");
    expect(screen.getByText("statement.csv", { selector: "strong" })).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(input).not.toBeDisabled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    input.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    const second = new File(["date,payee,amount\n"], "other.csv", { type: "text/csv" });
    Object.defineProperty(second, "text", { value: async () => "date,payee,amount\n" });
    fireEvent.change(input, { target: { files: [second] } });
    expect(requests.filter((path) => path === "/api/v1/csv/preview")).toHaveLength(1);

    reading.release();
    await screen.findByRole("heading", { name: "Map the columns" });
    expect(screen.queryByText(/^Reading /)).toBeNull();
    expect(input).not.toHaveAttribute("aria-disabled");
  });

  /**
   * `web.md` 12.1: the categories are read only to name each row's category,
   * and a failed read named every one Uncategorized with nothing to say so.
   */
  it("says the categories could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
        if (url.pathname === "/api/v1/categories") {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "The categories could not be read." } },
            { status: 500 },
          );
        }
        if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
        return new Response("Not found", { status: 404 });
      }),
    );
    await chooseFile(csv, "bank.csv");
    expect(await screen.findByText("The categories could not be read.")).toBeInTheDocument();
  });
});

/**
 * `common.md` §Prose: the resolution counts are one per distinct name, so a
 * large statement's payees run to four digits and group like every other count
 * on the page.
 */
it("groups the thousands in the payee and category counts", async () => {
  const many = (count: number, resolution: string) =>
    Array.from({ length: count }, (_, index) => ({
      inputPayee: `${resolution} ${index}`,
      resolvedPayee: `${resolution} ${index}`,
      resolution,
    }));
  stubApi(
    {
      delimiter: ",",
      headers: ["date", "payee", "amount"],
      rows: [],
      errors: [],
    },
    [checking],
    {
      referenceResolution: {
        categories: [],
        payees: [...many(1234, "existing"), ...many(2, "new")],
      },
    },
  );
  await chooseFile("date,payee,amount\n", "bank.csv");
  await screen.findByRole("heading", { name: "Map the columns" });
  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  expect(await screen.findByText(/Payees: 1,234 matched and 2 new/)).toBeInTheDocument();
});
