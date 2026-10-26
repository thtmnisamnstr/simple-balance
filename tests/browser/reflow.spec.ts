import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { reportNames } from "../../src/shared/domain.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";
import { visitImportStates } from "./support/ledger-file-import.js";
import { answerHouseAd, answerPlanStatus, pagesToVisit, type Fill } from "./support/routes.js";

/**
 * SC 1.4.10 Reflow, level AA: no horizontal scrollbar on the document, at any
 * width, on any page.
 *
 * **This is the check the defect it was written for went through.** The
 * stylesheet's own note above `.option-bar` describes the failure exactly — "between
 * roughly 560px and 900px the four `.category-toolbar` pages held a bar that
 * could neither shrink nor wrap" — and the remedy, `flex-wrap: wrap`, reached
 * `.filter-bar` at base and `.option-bar` only inside the 560px block. So Budgets'
 * view bar and Reports' options bar went on overflowing `.content` in exactly
 * the band the note names, for as long as nobody opened the page at 820px. The
 * document was 958px wide inside a 900px viewport.
 *
 * Nothing could see it. jsdom computes no layout, so the unit tier cannot ask
 * the question at all; `styles-order.test.ts` reads the breakpoint blocks and
 * has no opinion about what is missing from one; and the two browser specs that
 * do measure, `target-size` and `plan-buttons`, each look at one width they were
 * given. A rule about every width needs a check that walks the widths.
 *
 * **Why these widths.** The four breakpoints are 1050, 980, 780 and 560, and a
 * rule that is going to be missing is missing *between* two of them — which is
 * where this defect lived and why a test at 1440 and 390 would have stayed
 * green. So: each breakpoint and the pixel either side of it, and the middle of
 * each gap, plus 320, which is the width the success criterion actually names.
 * The pixel above matters as much as the one below: every block is a
 * `max-width`, so 781 is the first width the 780 block has stopped applying to,
 * and the narrowest a layout above it is ever asked to fit. The house ad is
 * side by side there, beside the sidebar, at its most cramped.
 *
 * **Every page carries the house ad** but the plan tab, which never does. The
 * ad sits on every page in the shell, so a width it overflows at is a width
 * every page overflows at; the tier has no Stripe and would never be shown
 * one, so the session is told to show it.
 *
 * **What is measured is the document, not a container.** A `.table-wrap`
 * scrolling sideways is the criterion's own exception for a data table and is
 * how every table in this product is meant to behave. What the criterion forbids
 * is the *page* scrolling, which is `document.documentElement`.
 */

const person = {
  email: `reflow-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Reflow",
};

const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const account = `Checking ${Date.now()}`;
const category = `Groceries ${Date.now()}`;
const payee = "Corner Market";

/** The same sign-up the other browser specs do, and for the reason they give. */
async function signUp(page: Page) {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(heading).toBeVisible();
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("Email address").fill(person.email);
  await page.getByLabel(/^Password/).fill(person.password);
  await page.getByLabel(/^Confirm password/).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

/**
 * One account, one category, one entry.
 *
 * An empty page is the easy case: every bar this is about is at its widest with
 * something in it, and a list with no rows has no row to push the page out.
 */
async function seed(page: Page) {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  await page.getByLabel(/^Account name/).fill(account);
  await page.getByLabel(/^Account type/).selectOption("checking");
  await page.getByLabel(/^Currency or crypto asset/).selectOption("USD");
  await page.getByLabel(/^Opening date/).fill(today);
  await page.getByLabel(/^Starting amount|^Opening balance/).fill("400.00");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(account, { exact: false }).first()).toBeVisible();

  await page.goto("/categories");
  // The add form, by its button: the Edit category dialog asks "Applies to"
  // too, and a closed `<dialog>` is still in the document.
  const addForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add category" }) });
  await addForm.getByLabel("Category name").fill(category);
  await addForm.getByLabel("Applies to").selectOption("expense");
  await addForm.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByText(category, { exact: false }).first()).toBeVisible();

  await page.goto("/transactions");
  await page.getByRole("button", { name: "Add transaction" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByRole("radio", { name: /withdrawal/i }).check();
  await form
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption({ label: `${account} · USD` });
  await form
    .getByRole("textbox", { name: /^Amount/ })
    .first()
    .fill("84.20");
  await form.getByRole("textbox", { name: /^Date/ }).fill(today);
  await form.getByRole("combobox", { name: "Payee" }).fill(payee);
  await form.getByPlaceholder(/type to search or add/i).fill(category);
  await form.getByRole("button", { name: /^Commit transaction$/ }).click();
  await expect(form).toBeHidden();
}

/** A write through the real API, as the signed-in page, with the Origin the guard checks. */
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { id: string };
}

/** The id of the one row this spec named `name`, from a list route that answers with a bare array. */
async function idOf(page: Page, path: string, name: string) {
  const rows = (await (await page.request.get(path)).json()) as { id: string; name: string }[];
  const row = rows.find((one) => one.name === name);
  expect(row, `${path} lists ${name}`).toBeDefined();
  return row!.id;
}

/**
 * Something for every detail page to show, and the ids that reach them.
 *
 * Through the API rather than the forms, because none of this is what the
 * spec is about: a template and a staged copy of the seeded entry — the copy
 * is what puts a pair in the duplicate review — plus the ids of what `seed`
 * already made. Every report kind comes from `reportNames`, the list the
 * report tabs are drawn from, so a seventh report is visited the day it lands.
 */
async function seedDetails(page: Page): Promise<Fill> {
  const accountId = await idOf(page, "/api/v1/accounts", account);
  const categoryId = await idOf(page, "/api/v1/categories", category);
  const template = await post(page, "/api/v1/transaction-templates", {
    name: `Weekly shop ${Date.now()}`,
    draft: { type: "withdrawal", payee, fromAccountId: accountId },
  });
  const staged = await post(page, "/api/v1/staged-transactions", {
    idempotencyKey: randomUUID(),
    draft: { type: "withdrawal", date: today, payee, amount: "84.20", fromAccountId: accountId },
  });
  return {
    params: {
      accountId: [accountId],
      categoryId: [categoryId],
      templateId: [template.id],
      id: [staged.id],
      report: reportNames,
    },
    // The payee page reads its subject from the query, and without one it is
    // a register filtered to a payee called nothing.
    search: { "/payees/transactions": `?name=${encodeURIComponent(payee)}` },
  };
}

/** The four breakpoints, their edges, the gaps between them, and the floor. */
const WIDTHS = [
  320, 390, 480, 559, 560, 561, 620, 700, 779, 780, 781, 820, 900, 979, 980, 981, 1049, 1050, 1051,
] as const;

test.describe.configure({ mode: "serial" });

test.describe("every page reflows", () => {
  let page: Page;
  let fill: Fill;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await answerPlanStatus(page);
    await answerHouseAd(page);
    await signUp(page);
    await seed(page);
    fill = await seedDetails(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  /**
   * Every page the router serves, which this did not use to mean.
   *
   * The routes were a hand-kept list of thirteen, written once and never
   * grown: `/settings/plan`, `/staged/duplicates`, `/payees/transactions`, the
   * four detail pages and five of the six reports were never opened at any
   * width, so a bar that overflowed on one of them passed here for as long as
   * nobody resized that page by hand. They now come from the route table, with
   * each parameter filled by `seedDetails`, and a route nobody can fill fails
   * `pagesToVisit` rather than being skipped.
   */
  test("without the document scrolling sideways at any width", async () => {
    test.setTimeout(300_000);
    const pages = pagesToVisit(fill);
    // Found what it was meant to find: an unreadable route table is an empty
    // population, and an empty population passes every claim made over it.
    expect(pages.length, "the route table was read").toBeGreaterThan(20);
    expect(pages.map((visit) => visit.pattern)).toContain("/settings/plan");
    const overflowing: string[] = [];
    const advertised: string[] = [];
    for (const { pattern, url } of pages) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      if (await page.getByRole("complementary", { name: "Advertisement" }).count()) {
        advertised.push(pattern);
      }
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        // A frame, so the resize has been laid out before it is measured.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
        );
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        if (scrollWidth > clientWidth) {
          overflowing.push(`${url} at ${width}px: document is ${scrollWidth}px wide`);
        }
      }
    }
    expect(overflowing, "these pages scroll sideways").toEqual([]);
    // Measured with the ad on screen, or this said nothing about it.
    expect(advertised, "the house ad was on every page but the plan tab").toEqual(
      pages.map((visit) => visit.pattern).filter((pattern) => pattern !== "/settings/plan"),
    );
  });

  /**
   * The export form on Import and export, in the states the walk above never
   * reaches.
   *
   * The walk opens `/import` as it loads, on Everything with no range, which is
   * the narrowest the form ever is. What it holds grows with what is chosen —
   * two date fields and the sentence under them, a checklist of every account
   * with a badge on the archived ones, a refusal summary at the top — and
   * section 15 asks for a bar to be measured with each of its contents present.
   * An archived account with a name that has no break in it is the list at its
   * widest. At the widths the request names: the floor, a phone, the first
   * pixel the sidebar is back, the wide step, and a desktop.
   */
  test("with the export form in every state it can take", async () => {
    test.setTimeout(120_000);
    const long = `JointHouseholdEverydayChecking${Date.now()}`;
    const archived = await post(page, "/api/v1/accounts", {
      name: long,
      type: "checking",
      currency: "EUR",
      openingDate: today,
      openingBalance: "0",
    });
    const response = await page.request.post(`/api/v1/accounts/${archived.id}/archived`, {
      data: { expectedVersion: 1, archived: true },
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(response.status(), await response.text()).toBeLessThan(300);

    const measure = async (state: string) => {
      const overflowing: string[] = [];
      for (const width of [320, 390, 781, 1050, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
        );
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        if (scrollWidth > clientWidth) {
          overflowing.push(`${state} at ${width}px: document is ${scrollWidth}px wide`);
        }
      }
      return overflowing;
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/import");
    const form = page.getByRole("region", { name: "Export a Simple Balance file" });
    await form.getByRole("radio", { name: "Date range" }).check();
    await form.getByLabel("Start date").fill("2026-06-30");
    await form.getByLabel("End date").fill("2026-01-01");
    const overflowing = await measure("Everything, with a range");
    // The shared schema's refusal, which the page shows before asking.
    await form.getByRole("button", { name: "Export file" }).click();
    await expect(form.getByRole("alert")).toContainText("The range cannot end before it starts");
    overflowing.push(...(await measure("Everything, with a refusal")));

    await page.setViewportSize({ width: 1440, height: 900 });
    await form.getByRole("radio", { name: /Some accounts/ }).check();
    await form.getByRole("radio", { name: "In a date range" }).check();
    await expect(form.getByRole("checkbox", { name: new RegExp(long) })).toBeVisible();
    await expect(form.getByText("Archived", { exact: true })).toBeVisible();
    overflowing.push(...(await measure("Some accounts, with a range")));
    expect(overflowing, "the export form scrolls the page sideways").toEqual([]);
  });

  /**
   * The Simple Balance file's import, which the walk above only ever sees
   * empty: everything it shows arrives after a file is chosen and checked.
   * Each state the section can take, at the same five widths as the export —
   * a refusal listing places in the file, a question about a duplicate with a
   * copy's name being typed, the places checklist and its sentence, the
   * settings question, every record in a table, a part that stopped, a
   * finished add, and a reference being matched — with an account name that
   * has no break in it, which is every one of those at its widest.
   */
  test("with the Simple Balance file import in every state it can take", async () => {
    test.setTimeout(180_000);
    const overflowing: string[] = [];
    await visitImportStates(page, async (state) => {
      for (const width of [320, 390, 781, 1050, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
        );
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        if (scrollWidth > clientWidth) {
          overflowing.push(`${state} at ${width}px: document is ${scrollWidth}px wide`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    expect(overflowing, "the import section scrolls the page sideways").toEqual([]);
  });
});
