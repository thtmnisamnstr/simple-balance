import { expect, test, type Page } from "@playwright/test";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * SC 1.4.10 Reflow, level AA: no horizontal scrollbar on the document, at any
 * width, on any page.
 *
 * **This is the check the defect it was written for went through.** The
 * stylesheet's own note above `.date-bar` describes the failure exactly — "between
 * roughly 560px and 900px the four `.category-toolbar` pages held a bar that
 * could neither shrink nor wrap" — and the remedy, `flex-wrap: wrap`, reached
 * `.filter-bar` at base and `.date-bar` only inside the 560px block. So Budgets'
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
 * green. So: each breakpoint, each breakpoint minus one pixel, and the middle of
 * each gap, plus 320, which is the width the success criterion actually names.
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
  await page.getByLabel("Category name").fill(category);
  await page.getByLabel("Category applies to").selectOption("expense");
  await page.getByRole("button", { name: "Add category" }).click();
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
  await form.getByRole("combobox", { name: "Payee" }).fill("Corner Market");
  await form.getByPlaceholder(/type to search or add/i).fill(category);
  await form.getByRole("button", { name: /^Commit transaction$/ }).click();
  await expect(form).toBeHidden();
}

/** The four breakpoints, their edges, the gaps between them, and the floor. */
const WIDTHS = [
  320, 390, 480, 559, 560, 620, 700, 779, 780, 820, 900, 979, 980, 1049, 1050,
] as const;

/** Every route the shell serves. The four detail pages need an id and are covered by their list. */
const ROUTES = [
  "/",
  "/accounts",
  "/budgets",
  "/reports",
  "/transactions",
  "/staged",
  "/categories",
  "/payees",
  "/templates",
  "/recurrences",
  "/import",
  "/activity",
  "/settings",
] as const;

test.describe.configure({ mode: "serial" });

test.describe("every page reflows", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await signUp(page);
    await seed(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("without the document scrolling sideways at any width", async () => {
    test.setTimeout(300_000);
    const overflowing: string[] = [];
    for (const route of ROUTES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");
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
          overflowing.push(`${route} at ${width}px: document is ${scrollWidth}px wide`);
        }
      }
    }
    expect(overflowing, "these pages scroll sideways").toEqual([]);
  });
});
