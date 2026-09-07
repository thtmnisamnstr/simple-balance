// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryGroup, CategorySummary } from "../src/client/api.js";
import CategoriesPage from "../src/client/pages/CategoriesPage.js";
import { BrowserRouter } from "../src/client/router.js";

const summary = (
  id: string,
  name: string,
  transactionCount: number,
  stagedTransactionCount: number,
  extra: Partial<CategorySummary> = {},
): CategorySummary => ({
  id,
  name,
  kind: "expense",
  version: 1,
  transactionCount,
  stagedTransactionCount,
  totalCount: transactionCount + stagedTransactionCount,
  ...extra,
});

const groceries = summary("11111111-1111-4111-8111-111111111111", "Groceries", 4, 1);
const rent = summary("22222222-2222-4222-8222-222222222222", "Rent", 1, 0);
const unused = summary("33333333-3333-4333-8333-333333333333", "Unused", 0, 0);
const salary = summary("44444444-4444-4444-8444-444444444444", "Salary", 2, 7, {
  kind: "income",
});

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function stubCategories(
  rows: CategorySummary[],
  options: { groups?: CategoryGroup[] | "error" } = {},
) {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/categories/duplicates") return Response.json([]);
      if (url.pathname === "/api/v1/category-groups") {
        if (options.groups === "error") {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "No." } },
            { status: 500 },
          );
        }
        return Response.json(options.groups ?? []);
      }
      if (url.pathname === "/api/v1/categories/summaries") {
        requested.push(url.search);
        return Response.json(rows);
      }
      if (url.pathname.startsWith("/api/v1/categories")) {
        writes.push({
          path: url.pathname,
          method: init?.method ?? "POST",
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return Response.json({ ...rows[0], id: "written" });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return requested;
}

/** Every write the page made, so a request field can be asserted rather than implied. */
let writes: { path: string; method: string; body: Record<string, unknown> }[] = [];

const household: CategoryGroup = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "Household",
  policy: "sum_of_children",
  categoryCount: 0,
  version: 1,
};

function renderCategories() {
  window.history.replaceState(null, "", "/categories");
  render(
    <QueryClientProvider client={queryClient()}>
      <BrowserRouter>
        <CategoriesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const rowFor = (name: string) => screen.getByText(name).closest(".category-row") as HTMLElement;

const listedNames = () =>
  screen
    .getAllByRole("link")
    .map((link) => link.textContent)
    .filter((text): text is string => Boolean(text));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writes = [];
  window.history.replaceState(null, "", "/");
});

describe("how much each category is used", () => {
  it("splits the count into committed and staged, and totals them", async () => {
    stubCategories([groceries, rent]);
    renderCategories();

    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    const row = within(rowFor("Groceries"));
    expect(row.getByText(/4 committed · 1 staged/)).toBeInTheDocument();
    expect(row.getByText("5 transactions")).toBeInTheDocument();
  });

  it("says one transaction rather than one transactions", async () => {
    stubCategories([rent]);
    renderCategories();

    expect(await screen.findByText("1 transaction")).toBeInTheDocument();
    expect(screen.queryByText("1 transactions")).not.toBeInTheDocument();
  });

  // The row somebody opened this page to find. A count query that inner-joined
  // would drop it, and the page would quietly stop listing categories.
  it("still lists a category nothing has been filed under", async () => {
    stubCategories([groceries, unused]);
    renderCategories();

    expect(await screen.findByText("Unused")).toBeInTheDocument();
    const row = within(rowFor("Unused"));
    expect(row.getByText(/0 committed · 0 staged/)).toBeInTheDocument();
    expect(row.getByText("0 transactions")).toBeInTheDocument();
  });

  /**
   * The badge column is hidden on a narrow screen, so anything that lives only
   * in a badge is invisible there. The counts and the kind both have to be in
   * the first column's subtitle to survive.
   */
  it("keeps the kind alongside the counts, where a narrow screen can still read it", async () => {
    stubCategories([salary]);
    renderCategories();

    expect(await screen.findByText("Salary")).toBeInTheDocument();
    const row = within(rowFor("Salary"));
    expect(row.getByText(/Income · 2 committed · 7 staged/)).toBeInTheDocument();
  });

  it("orders by whichever count is asked for", async () => {
    stubCategories([groceries, rent, unused, salary]);
    renderCategories();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();

    const sortBy = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(sortBy, { target: { value: "total" } });
    // Ascending: 0, 1, 5, 9.
    expect(listedNames()).toEqual(["Unused", "Rent", "Groceries", "Salary"]);

    fireEvent.change(sortBy, { target: { value: "staged" } });
    // Ascending: 0, 0, 1, 7. Ties fall back to name.
    expect(listedNames()).toEqual(["Rent", "Unused", "Groceries", "Salary"]);

    fireEvent.change(sortBy, { target: { value: "committed" } });
    // Ascending: 0, 1, 2, 4.
    expect(listedNames()).toEqual(["Unused", "Rent", "Salary", "Groceries"]);
  });

  it("asks the server for archived rows rather than filtering them out here", async () => {
    const requested = stubCategories([groceries]);
    renderCategories();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(requested).toEqual([""]);

    fireEvent.click(screen.getByRole("checkbox", { name: /Show archived/ }));
    await screen.findByText("Groceries");
    expect(requested).toContain("?includeArchived=true");
  });
});

/**
 * Putting a category in a group.
 *
 * The control existed before this: a "Group" select inside the edit modal,
 * behind a pencil icon whose only label was "Edit Groceries". Nothing on the
 * page said a category had a group, nothing on the Groups panel led to one, and
 * the reasonable conclusion — the one that was reported — was that groups
 * cannot be filled at all. None of that was reachable by a test either, because
 * nothing in this file mentioned a group.
 */
describe("filing a category under a group", () => {
  it("offers the group on the row, and says which one it is already in", async () => {
    stubCategories([{ ...groceries, groupId: household.id }, rent], { groups: [household] });
    renderCategories();
    await screen.findByText("Groceries");

    expect(screen.getByLabelText("Group of Groceries")).toHaveValue(household.id);
    expect(screen.getByLabelText("Group of Rent")).toHaveValue("");
  });

  it("sends the group and the version it was read at", async () => {
    stubCategories([groceries], { groups: [household] });
    renderCategories();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("Group of Groceries"), {
      target: { value: household.id },
    });

    await waitFor(() => expect(writes.some((one) => one.method === "PUT")).toBe(true));
    const write = writes.find((one) => one.method === "PUT");
    expect(write?.path).toBe(`/api/v1/categories/${groceries.id}`);
    expect(write?.body["groupId"]).toBe(household.id);
    // Without it the write is a lost update waiting for two tabs.
    expect(write?.body["expectedVersion"]).toBe(groceries.version);
  });

  it("clears a group with null rather than by leaving the field out", async () => {
    stubCategories([{ ...groceries, groupId: household.id }], { groups: [household] });
    renderCategories();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("Group of Groceries"), { target: { value: "" } });

    await waitFor(() => expect(writes.some((one) => one.method === "PUT")).toBe(true));
    const write = writes.find((one) => one.method === "PUT");
    // The server reads an absent key as "leave the group alone", so omitting it
    // would silently do nothing at all.
    expect(write?.body).toHaveProperty("groupId", null);
  });

  it("files a new category on the way in", async () => {
    stubCategories([groceries], { groups: [household] });
    renderCategories();
    await screen.findByText("Groceries");

    fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Water" } });
    fireEvent.change(screen.getByLabelText("Category group"), { target: { value: household.id } });
    fireEvent.click(screen.getByRole("button", { name: /Add category/ }));

    // `create_category` has always taken a groupId. Until this the browser did
    // not send one, which made it a request field only an agent could set.
    await waitFor(() => expect(writes.some((one) => one.path === "/api/v1/categories")).toBe(true));
    const write = writes.find((one) => one.path === "/api/v1/categories");
    expect(write?.body).toMatchObject({ name: "Water", groupId: household.id });
  });

  it("says the groups could not be read rather than that there are none", async () => {
    stubCategories([groceries], { groups: "error" });
    renderCategories();
    await screen.findByText("Groceries");

    // The failure used to render as "No groups yet." beside a picker offering
    // only "No group" — indistinguishable from a product that cannot group.
    expect(await screen.findByText(/groups could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText("No groups yet.")).toBeNull();
  });
});
