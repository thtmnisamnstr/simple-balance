import { expect, test, type Page } from "@playwright/test";

/**
 * The budgets page, in a browser, through the real API.
 *
 * Two of this story's defects were invisible to every other tier. The
 * archived-spending checkbox changed nothing in either position, because the
 * query-string helper drops a falsy value and unchecked fell through to a
 * server default; jsdom rendered the box correctly and never asked what the
 * server received. And the transaction form offered a split combining an income
 * leg with an expense leg, which the server refuses with a 422, because the rule
 * was enforced on one side only. Both are the same shape of bug: the markup is
 * right and the wire is wrong.
 *
 * So these specs assert what the screen says after a round trip, and in two
 * places what actually went over the wire.
 */

const account = `Checking ${Date.now()}`;
const groceries = `Groceries ${Date.now()}`;
const salary = `Salary ${Date.now()}`;
const card = `Old card ${Date.now()}`;

/**
 * A fresh account per run, because these specs write real rows through the real
 * API and a shared identity would make one run's leftovers another run's
 * mystery.
 */
const person = {
  email: `browser-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Browser Tier",
};

async function signUp(page: Page) {
  await page.goto("/");
  // The first account on an empty deployment lands on the sign-up form already:
  // the toggle only exists once somebody can sign in instead. Which of the two
  // this run gets depends on whether the database already holds an account, so
  // both are waited for and whichever arrives decides.
  //
  // Asking the toggle whether it is visible without waiting is what this used
  // to do, and it passed on an empty database and failed on every run after:
  // the sign-in form renders before the options query answers, so the question
  // was asked while neither the toggle nor the heading existed, answered no,
  // and left the run waiting for a heading nothing was going to show.
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(heading).toBeVisible();
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("Email address").fill(person.email);
  // Not an exact match: `Field` wraps its control in a label that includes
  // the hint, so the accessible name is "Password At least 12 characters".
  await page.getByLabel(/^Password/).fill(person.password);
  await page.getByLabel(/^Confirm password/).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

/**
 * Through the pages rather than through the API, because the point of this tier
 * is that the forms work.
 */
async function seedLedger(page: Page) {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  await page.getByLabel(/^Account name/).fill(account);
  await page.getByLabel(/^Account type/).selectOption("checking");
  await page.getByLabel(/^Currency or crypto asset/).selectOption("GBP");
  await page.getByLabel(/^Opening date/).fill("2026-01-01");
  await page.getByLabel(/^Opening balance/).fill("4000.00");
  // The same accessible name as the sign-up button, on a different page. Worth
  // noting rather than working around: `web.md` says an action names what it
  // acts on, and two "Create account" buttons in one product is the reason.
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(account, { exact: false }).first()).toBeVisible();

  await page.goto("/categories");
  for (const [name, kind] of [
    [groceries, "expense"],
    [salary, "income"],
  ] as const) {
    await page.getByLabel("Category name").fill(name);
    await page.getByLabel("Category applies to").selectOption(kind);
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  }
}

/**
 * One page for the whole journey. Playwright gives each test a fresh context, so
 * a signed-in session does not survive into the next test, and these specs are
 * deliberately one story told in order: arrive with nothing, budget, spend,
 * refund, override, put it back.
 */
let page: Page;

test.describe.configure({ mode: "serial" });

test.describe("the budgets page in a browser", () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signUp(page);
    await seedLedger(page);
  });

  test.afterAll(async () => {
    await page.close();
  });
  test("reaches Budgets from the sidebar", async () => {
    await page.getByRole("link", { name: /^Budgets$/ }).click();
    await expect(page).toHaveURL(/\/budgets/);
    await expect(page.getByRole("heading", { name: /^budgets$/i })).toBeVisible();
    // Nothing budgeted yet, and the page says so rather than showing an empty table.
    await expect(page.getByText(/nothing budgeted in this range/i)).toBeVisible();
  });

  /**
   * The snapping rule, seen from the screen: a date inside a month names the
   * month, and the row says the month rather than the raw stored date. Printing
   * the stored date read a whole period short, and read a one-month budget as a
   * single day.
   */
  test("sets a budget from a mid-month date and names the period it covers", async () => {
    await page.goto("/budgets");
    await page.getByLabel(/^Category/).selectOption({ label: groceries });
    await page
      .getByLabel(/^Amount/)
      .first()
      .fill("200.00");
    await page.getByLabel(/^Currency/).selectOption("GBP");
    await page.getByLabel(/^Starting/).fill("2026-08-14");
    await page.getByRole("button", { name: /^set budget$/i }).click();

    await expect(page.getByText(/budgeting £200\.00/i)).toBeVisible();
    // The standing budgets table names August, not 2026-08-01.
    const standing = page.getByRole("table", { name: /standing budgets/i });
    await expect(standing.getByText(/August 2026 onward/)).toBeVisible();
    await expect(standing.getByText("2026-08-01")).toHaveCount(0);
  });

  test("shows the budget against real spending, and marks the month unfinished", async () => {
    await page.goto("/transactions");
    // Two buttons share this name on the page, which `web.md` calls out: an
    // action should name what it acts on. `.first()` here rather than a
    // workaround pretending the ambiguity is not there.
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByRole("radio", { name: /withdrawal/i }).check();
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${account} · GBP` });
    await form
      .getByRole("textbox", { name: /^Amount/ })
      .first()
      .fill("45.00");
    await form.getByRole("textbox", { name: /^Date/ }).fill("2026-08-03");
    await form.getByRole("combobox", { name: "Payee" }).fill("Corner shop");
    await form.getByPlaceholder(/type to search or add/i).fill(groceries);
    await form.getByRole("button", { name: /^Commit transaction$/ }).click();

    await page.goto("/budgets");
    // Scoped to the report: the category also appears in the standing budgets
    // table and in the single-periods panel.
    const row = page
      .getByRole("table", { name: /Budget against spending/ })
      .getByRole("row", { name: new RegExp(groceries) });
    await expect(row).toContainText("£200.00");
    await expect(row).toContainText("£45.00");
    // A month that has not finished is not a month somebody stayed within.
    await expect(row.getByText("So far")).toBeVisible();
  });

  /**
   * The criterion that failed acceptance. A refund names a spending category on
   * a deposit, and the budget must go down rather than income going up.
   */
  test("a refund lowers the category it came back to", async () => {
    await page.goto("/transactions");
    // Two buttons share this name on the page, which `web.md` calls out: an
    // action should name what it acts on. `.first()` here rather than a
    // workaround pretending the ambiguity is not there.
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByRole("radio", { name: /deposit/i }).check();
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${account} · GBP` });
    await form
      .getByRole("textbox", { name: /^Amount/ })
      .first()
      .fill("12.00");
    await form.getByRole("textbox", { name: /^Date/ }).fill("2026-08-05");
    await form.getByRole("combobox", { name: "Payee" }).fill("Corner shop refund");
    // The picker must offer a spending category on a deposit at all. It used to
    // hide it, which is how a refund was impossible to enter.
    await form.getByPlaceholder(/type to search or add/i).fill(groceries);
    await form.getByRole("button", { name: /^Commit transaction$/ }).click();

    await page.goto("/budgets");
    // Scoped to the report: the category also appears in the standing budgets
    // table and in the single-periods panel.
    const row = page
      .getByRole("table", { name: /Budget against spending/ })
      .getByRole("row", { name: new RegExp(groceries) });
    await expect(row).toContainText("£33.00");

    // And the category is not corrupted, so a second refund works too. This is
    // the half that used to fail silently: widening the category to cover both
    // directions made every later refund credit income instead.
    await page.goto("/transactions");
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const second = page.getByRole("dialog");
    await second.getByRole("radio", { name: /deposit/i }).check();
    await second
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${account} · GBP` });
    await second
      .getByRole("textbox", { name: /^Amount/ })
      .first()
      .fill("3.00");
    await second.getByRole("textbox", { name: /^Date/ }).fill("2026-08-06");
    await second.getByRole("combobox", { name: "Payee" }).fill("Second refund");
    await second.getByPlaceholder(/type to search or add/i).fill(groceries);
    await second.getByRole("button", { name: /^Commit transaction$/ }).click();

    await page.goto("/budgets");
    await expect(
      page
        .getByRole("table", { name: /Budget against spending/ })
        .getByRole("row", { name: new RegExp(groceries) }),
    ).toContainText("£30.00");
  });

  /**
   * The defect no other tier could see. The box sends its state both ways now;
   * before, unchecked sent nothing and the server default answered instead, so
   * the figure never moved.
   */
  /**
   * The defect no other tier could see. The box sends its state both ways now;
   * before, unchecked sent nothing and the server default answered instead, so
   * the box changed nothing in either position. Asserted on the figure rather
   * than on the request, because the figure is what somebody reads and because
   * the two answers differ by every penny spent through a closed account.
   */
  test("the closed-accounts checkbox changes the figure", async () => {
    // A card, spending on it, and then close the card.
    await page.goto("/accounts");
    await page.getByRole("button", { name: "New account" }).click();
    await page.getByLabel(/^Account name/).fill(card);
    await page.getByLabel(/^Account type/).selectOption("credit_card");
    await page.getByLabel(/^Currency or crypto asset/).selectOption("GBP");
    await page.getByLabel(/^Opening date/).fill("2026-01-01");
    await page.getByLabel(/^Starting amount|^Opening balance/).fill("0");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(card, { exact: false }).first()).toBeVisible();

    await page.goto("/transactions");
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByRole("radio", { name: /withdrawal/i }).check();
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${card} · GBP` });
    await form
      .getByRole("textbox", { name: /^Amount/ })
      .first()
      .fill("80.00");
    await form.getByRole("textbox", { name: /^Date/ }).fill("2026-08-06");
    await form.getByRole("combobox", { name: "Payee" }).fill("Card shop");
    await form.getByPlaceholder(/type to search or add/i).fill(groceries);
    await form.getByRole("button", { name: /^Commit transaction$/ }).click();

    // Archived through the API rather than the page: this test is about the
    // checkbox, and the archive control has its own coverage. `page.request`
    // carries the same session cookies the browser holds.
    const accounts = await page.request.get("/api/v1/accounts").then((response) => response.json());
    const closing = accounts.find(
      (entry: { name: string; id: string; version: number }) => entry.name === card,
    );
    const archived = await page.request.post(`/api/v1/accounts/${closing.id}/archived`, {
      data: { archived: true, expectedVersion: closing.version },
      // Every state-changing request must be same-origin and declare JSON.
      // Playwright's request context sends no Origin of its own, and the
      // guard is right to refuse one that does not.
      headers: { Origin: "http://localhost:5173" },
    });
    expect(archived.ok(), await archived.text()).toBe(true);

    await page.goto("/budgets");
    const row = page
      .getByRole("table", { name: /Budget against spending/ })
      .getByRole("row", { name: new RegExp(groceries) });
    const box = page.getByLabel(/count spending through closed accounts/i);

    // Counted by default: the card's 80 is money the budget covered.
    await expect(box).toBeChecked();
    await expect(row).toContainText("£110.00");

    await box.uncheck();
    await expect(row).toContainText("£30.00");

    await box.check();
    await expect(row).toContainText("£110.00");
  });

  /**
   * The other one jsdom missed: the form must refuse a split that names an
   * income category and an expense category, because the server does, and a
   * 422 arriving after submit is a refusal nobody could have predicted.
   */
  test("the form refuses a split that is income and a refund at once", async () => {
    await page.goto("/transactions");
    // Two buttons share this name on the page, which `web.md` calls out: an
    // action should name what it acts on. `.first()` here rather than a
    // workaround pretending the ambiguity is not there.
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByRole("radio", { name: /withdrawal/i }).check();
    await form
      .getByRole("combobox", { name: "Account", exact: true })
      .selectOption({ label: `${account} · GBP` });
    await form
      .getByRole("textbox", { name: /^Amount/ })
      .first()
      .fill("50.00");
    await form.getByRole("textbox", { name: /^Date/ }).fill("2026-08-07");
    await form.getByRole("combobox", { name: "Payee" }).fill("Mixed split");
    await form.getByRole("button", { name: /split/i }).click();

    const legs = form.getByPlaceholder(/type to search or add/i);
    await legs.nth(0).fill(groceries);
    await form.getByLabel("Amount for split 1").fill("30.00");
    await legs.nth(1).fill(salary);
    await form.getByLabel("Amount for split 2").fill("20.00");

    await expect(page.getByText(/either spending or income coming back/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Commit transaction$/ })).toBeDisabled();
  });

  test("overrides one month and puts it back", async () => {
    await page.goto("/budgets");
    // Scoped to the report: the category also appears in the standing budgets
    // table and in the single-periods panel.
    const row = page
      .getByRole("table", { name: /Budget against spending/ })
      .getByRole("row", { name: new RegExp(groceries) });
    await row.getByRole("button", { name: /just this month/i }).click();

    const dialog = page.getByRole("dialog", { name: new RegExp(`${groceries}, August 2026`) });
    await dialog.getByLabel(/^Amount/).fill("300.00");
    await dialog.getByRole("button", { name: /^save$/i }).click();

    await expect(row).toContainText("£300.00");
    await expect(row.getByText(/this month only/i)).toBeVisible();
    // Listed where it can be found again, rather than only on the month it changed.
    await expect(page.getByRole("table", { name: /amounts set for one period/i })).toContainText(
      "August 2026",
    );

    await row.getByRole("button", { name: /change this month/i }).click();
    await page
      .getByRole("dialog", { name: new RegExp(`${groceries}, August 2026`) })
      .getByRole("button", { name: /use the standing budget/i })
      .click();
    await expect(row).toContainText("£200.00");
  });

  test("keyboard reaches the whole page", async () => {
    await page.goto("/budgets");
    const reached: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return `${el.tagName.toLowerCase()}:${
          el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? ""
        }`;
      });
      if (label) reached.push(label);
    }
    // The period control, the create form and a row action are all reachable
    // without a mouse, which AGENTS.md's definition of done requires somebody
    // to have verified.
    expect(reached.some((r) => /budget period/i.test(r))).toBe(true);
    expect(reached.some((r) => /set budget/i.test(r))).toBe(true);
    expect(reached.filter((r) => r.startsWith("select")).length).toBeGreaterThan(1);
  });

  test("no console error and no failed request on the page", async () => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) => problems.push(`failed: ${request.url()}`));
    page.on("response", (response) => {
      if (response.status() >= 500) problems.push(`${response.status()}: ${response.url()}`);
    });
    await page.goto("/budgets");
    await expect(page.getByRole("heading", { name: /^budgets$/i })).toBeVisible();
    await page.getByRole("combobox", { name: "Budget period" }).selectOption("quarter");
    await expect(page.getByRole("heading", { name: /^budgets$/i })).toBeVisible();
    expect(problems).toEqual([]);
  });

  /**
   * The four paths 0.1.6 renamed still answer under their old spelling.
   *
   * `/api/v1` is cookie-only and same-origin, so the argument for renaming
   * rather than deprecating was that the only client which could be calling the
   * old ones ships in this image. That holds for this image and not for the one
   * already running: a browser tab left open across the upgrade is serving the
   * previous build, and would meet a 404 on the first archive somebody
   * attempted, with nothing to tell it apart from a bug.
   *
   * Proved here rather than in a unit test because the session gate answers
   * `401` for every `/api/v1` path before routing happens, registered or not,
   * so without a real session there is nothing to tell the two apart.
   */
  test("archives an account through the path the previous release used", async () => {
    const name = `Renamed ${Date.now()}`;
    const created = await page.request.post("/api/v1/accounts", {
      data: {
        name,
        type: "checking",
        currency: "GBP",
        openingDate: "2026-01-01",
        openingBalance: "0",
      },
      headers: { Origin: "http://localhost:5173" },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const account = (await created.json()) as { id: string; version: number };

    const archived = await page.request.post(`/api/v1/accounts/${account.id}/archive`, {
      data: { archived: true, expectedVersion: account.version },
      headers: { Origin: "http://localhost:5173" },
    });

    expect(archived.status(), await archived.text()).toBe(200);
    // It works, and it says it is going away, and when. `Deprecation` carries a
    // date rather than `true`: RFC 9745 supersedes the draft that spelled it as
    // a boolean, and this test pinned the draft's spelling while the sunset it
    // never read was a date already in the past.
    expect(archived.headers()["deprecation"]).toMatch(/^@\d+$/);
    expect(new Date(archived.headers()["sunset"]!).getTime()).toBeGreaterThan(Date.now());
    expect(archived.headers()["link"]).toContain("successor-version");
    expect(archived.headers()["link"]).toContain('rel="deprecation"');
  });

  test("reads a staged duplicate through the path the previous release used", async () => {
    // No staged row is needed. A refusal carrying `NOT_FOUND` came from the
    // handler, which means the route reached it; a path the router no longer
    // serves would answer from the catch-all instead.
    const response = await page.request.get(
      "/api/v1/staged/00000000-0000-4000-8000-000000000000/duplicate",
    );
    const body = await response.text();
    expect(body, body).toContain("NOT_FOUND");
    expect(response.headers()["deprecation"]).toMatch(/^@\d+$/);
  });

  /**
   * Rollover through the form and back off the screen.
   *
   * The fold is tested exhaustively against the service in
   * `tests/integration/budgets.integration.test.ts`. What only a browser can
   * show is that the checkbox reaches the server at all — the same shape of
   * defect as the archived-spending box, which rendered correctly and sent
   * nothing — and that the two columns appear when, and only when, something
   * carries.
   */
  test("carries what a period did not spend into the next one", async () => {
    const carried = `Carried ${Date.now()}`;
    await page.goto("/categories");
    await page.getByLabel("Category name").fill(carried);
    await page.getByLabel("Category applies to").selectOption("expense");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(carried, { exact: false }).first()).toBeVisible();

    await page.goto("/budgets");
    // Before anything carries, the columns are not there at all.
    const report = page.getByRole("table", { name: /Budget against spending/ }).first();
    await expect(report.getByRole("columnheader", { name: "Carried in" })).toHaveCount(0);

    // Scoped to the form that sets a budget: the edit dialog carries the same
    //field and a closed `<dialog>` is still in the document.
    const setBudget = page.locator("form.budget-form");
    await setBudget.getByLabel(/^Category/).selectOption({ label: carried });
    await setBudget.getByLabel(/^Amount$/).fill("100.00");
    await setBudget.getByLabel(/^Currency/).selectOption("GBP");
    await setBudget.getByLabel(/^Starting/).fill("2026-07-01");
    await setBudget.getByLabel(/^Carry what is left over/).check();
    await page.getByRole("button", { name: /^set budget$/i }).click();
    await expect(page.getByText(/budgeting £100\.00/i)).toBeVisible();

    const standing = page.getByRole("table", { name: /standing budgets/i });
    await expect(standing.getByRole("row", { name: new RegExp(carried) })).toContainText(
      "Carries over",
    );

    // July was budgeted and untouched, so August starts with a hundred more
    // than it budgeted — and the page says where the figure was worked out from.
    await page.getByLabel("Start date").fill("2026-08-01");
    await page.getByLabel("End date").fill("2026-08-31");
    const august = page
      .getByRole("table", { name: /Budget against spending/ })
      .getByRole("row", { name: new RegExp(carried) });
    await expect(august).toContainText("£100.00");
    await expect(page.getByText(/Carried-in figures were worked out from/i)).toBeVisible();
  });

  test("a sinking fund asks for no amount and says what it is saving for", async () => {
    const fund = `Fund ${Date.now()}`;
    await page.goto("/categories");
    await page.getByLabel("Category name").fill(fund);
    await page.getByLabel("Category applies to").selectOption("expense");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(fund, { exact: false }).first()).toBeVisible();

    await page.goto("/budgets");
    const setBudget = page.locator("form.budget-form");
    await setBudget.getByLabel(/^Category/).selectOption({ label: fund });
    await setBudget.getByLabel(/^Saving up for/).fill("600.00");
    // Typing a target hides the amount box, because a fund works out its own
    // figure, and turns the carry on, because a fund that does not keep what it
    // saved saves nothing.
    await expect(setBudget.getByLabel(/^Amount$/)).toHaveCount(0);
    await expect(setBudget.getByLabel(/^Carry what is left over/)).toBeChecked();
    await setBudget.getByLabel(/^Needed by/).fill("2026-12-20");
    await setBudget.getByLabel(/^Currency/).selectOption("GBP");
    await setBudget.getByLabel(/^Starting/).fill("2026-07-01");
    await page.getByRole("button", { name: /^set budget$/i }).click();

    const standing = page.getByRole("table", { name: /standing budgets/i });
    const row = standing.getByRole("row", { name: new RegExp(fund) });
    await expect(row).toContainText("Saving £600.00 by December 2026");
    // The amount column says what it is rather than showing a zero somebody
    // would read as "budget nothing".
    await expect(row).toContainText("Worked out");
  });

  /**
   * A worked-out amount through the form, which is the only tier that can show
   * the select reaching the server. The arithmetic itself is held against the
   * service in the integration suite.
   */
  test("budgets a share of the income before it, without asking for an amount", async () => {
    const share = `Share ${Date.now()}`;
    await page.goto("/categories");
    await page.getByLabel("Category name").fill(share);
    await page.getByLabel("Category applies to").selectOption("expense");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(share, { exact: false }).first()).toBeVisible();

    await page.goto("/budgets");
    const setBudget = page.locator("form.budget-form");
    await setBudget.getByLabel(/^Category/).selectOption({ label: share });
    await setBudget.getByLabel("Amount decided by").selectOption("income");
    // The amount box goes away, because the amount is not somebody's to type.
    await expect(setBudget.getByLabel(/^Amount$/)).toHaveCount(0);
    await setBudget.getByLabel(/Share of income/).fill("15");
    await setBudget.getByLabel(/^Currency/).selectOption("GBP");
    await setBudget.getByLabel(/^Starting/).fill("2026-07-01");
    await setBudget.getByRole("button", { name: /^set budget$/i }).click();

    const standing = page.getByRole("table", { name: /standing budgets/i });
    const row = standing.getByRole("row", { name: new RegExp(share) });
    await expect(row).toContainText("15% of income");
    await expect(row).toContainText("Worked out");
  });

  /**
   * A group through both pages, which is the only tier that sees them meet.
   *
   * The group is made on Categories, a category is filed under it there, and
   * the budget page reads it back — three requests through two pages, and the
   * kind of seam where a field reaches one and not the other.
   */
  test("groups categories and budgets the group", async () => {
    const groupName = `Fixed ${Date.now()}`;
    const rent = `Rent ${Date.now()}`;
    await page.goto("/categories");
    await page.getByLabel("Group name").fill(groupName);
    await page.getByLabel("Group budget").selectOption("standalone");
    await page.getByRole("button", { name: "Add group" }).click();
    await expect(
      page.getByRole("table", { name: /category groups/i }).getByRole("rowheader", {
        name: groupName,
      }),
    ).toBeVisible();

    await page.getByLabel("Category name").fill(rent);
    await page.getByLabel("Category applies to").selectOption("expense");
    await page.getByRole("button", { name: "Add category" }).click();
    await page.getByRole("button", { name: `Edit ${rent}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Group").selectOption({ label: groupName });
    await dialog.getByRole("button", { name: "Save" }).click();

    await page.goto("/budgets");
    const setBudget = page.locator("form.budget-form");
    await setBudget
      .getByLabel(/^Category or group/)
      .selectOption({ label: `${groupName} (group)` });
    await setBudget.getByLabel(/^Amount$/).fill("1200.00");
    await setBudget.getByLabel(/^Currency/).selectOption("GBP");
    await setBudget.getByLabel(/^Starting/).fill("2026-08-01");
    await setBudget.getByRole("button", { name: /^set budget$/i }).click();

    await expect(
      page.getByRole("table", { name: /standing budgets/i }).getByRole("rowheader", {
        name: new RegExp(groupName),
      }),
    ).toBeVisible();
    // And the group has a line of its own in the report, marked as holding its
    // own budget rather than adding up its categories.
    const groupRow = page
      .getByRole("table", { name: /^Groups for/ })
      .getByRole("row", { name: new RegExp(groupName) });
    await expect(groupRow).toContainText("Own budget");
    await expect(groupRow).toContainText("£1,200.00");
  });

  /**
   * The envelope figure through the browser, including the perimeter switch.
   *
   * The arithmetic is held against the service; what only this tier can show is
   * that the checkbox on the account form reaches the server and changes the
   * figure on a different page.
   */
  test("says what is left to assign, and leaves an account out when told to", async () => {
    const envelope = `Envelope ${Date.now()}`;
    const pension = `Pension ${Date.now()}`;
    await page.goto("/categories");
    await page.getByLabel("Category name").fill(envelope);
    await page.getByLabel("Category applies to").selectOption("expense");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(envelope, { exact: false }).first()).toBeVisible();

    await page.goto("/budgets");
    const setBudget = page.locator("form.budget-form");
    await setBudget.getByLabel(/^Category or group/).selectOption({ label: envelope });
    await setBudget.getByLabel(/^Amount$/).fill("100.00");
    await setBudget.getByLabel(/^Currency/).selectOption("GBP");
    await setBudget.getByLabel(/^Starting/).fill("2026-08-01");
    await setBudget.getByLabel(/^Carry what is left over/).check();
    await setBudget.getByRole("button", { name: /^set budget$/i }).click();
    await expect(page.getByText(/left to assign/i)).toBeVisible();

    // A second account, outside the perimeter. What it holds must not appear in
    // the figure, which is the whole reason the switch exists.
    await page.goto("/accounts");
    await page.getByRole("button", { name: "New account" }).click();
    await page.getByLabel(/^Account name/).fill(pension);
    await page.getByLabel(/^Account type/).selectOption("investment");
    await page.getByLabel(/^Currency or crypto asset/).selectOption("GBP");
    await page.getByLabel(/^Opening date/).fill("2026-01-01");
    await page.getByLabel(/^Opening balance/).fill("50000.00");
    await page.getByLabel(/budget is about the money/i).uncheck();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(pension, { exact: false }).first()).toBeVisible();

    await page.goto("/budgets");
    // Fifty thousand more in the ledger and not a penny of it assignable.
    await expect(page.getByText(/left to assign/i)).toBeVisible();
    await expect(page.getByText(/£50,000/)).toHaveCount(0);
  });
});
