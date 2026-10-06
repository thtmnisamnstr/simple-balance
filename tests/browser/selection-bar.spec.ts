import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * The selection bar, in every state its controls can take, at every width.
 *
 * `web.md` 12.3 records the defect. On the staged queue, selecting across
 * pages with a possible duplicate among the rows disabled Commit selected with
 * a sentence saying why — and the bar fell apart: the count was crushed to one
 * word a line, its icon shrank to nothing, and the actions ran out past the
 * bar's right edge, cutting the duplicate checkbox to "Co". Ticking the box
 * enabled the button, the sentence went, and the bar came back. Pressing
 * Commit broke it a second way: Commit and Delete both drew a spinner beside
 * their icons, both grew, and the count rewrapped.
 *
 * **It had been fixed once, in a comment.** The stylesheet carried a long and
 * correct-sounding note about exactly this sentence in exactly this bar, and a
 * rule under it, and `web.md` cited both as the answer. Nothing measured it.
 * The rule moved the sentence onto its own line; what it could not change was
 * that the actions group took its width from its content, and a wrapping
 * group's content width counts everything it holds as though on one line. So
 * the sentence still inflated the group it had been moved below. jsdom has no
 * layout engine, so the unit tier cannot ask; `reflow.spec.ts` visits
 * `/staged` with nothing selected, where there is no bar at all; and
 * `plan-buttons.spec.ts` measures one row it was written for.
 *
 * **What this measures is the resting bar's failure modes, in each state.**
 * A state is a fact about the bar's contents — a reason showing, none, a
 * button working — and a width is a fact about the room it has, and the
 * defect lived in one combination of the two. So each state is walked across
 * the same widths `reflow.spec.ts` uses, minus the ones between that changed
 * nothing here, and each width asks five things:
 *
 * - nothing in the bar extends past its edges;
 * - the count is on one line wherever one line of it fits;
 * - its icon has its size;
 * - no button's label wraps inside the button, which is what the actions
 *   look like when they are starved rather than crushing the count — the
 *   first fix for this did that, below about 1050px;
 * - and where the count shares a line with buttons, it sits on their midline.
 *
 * The busy state adds two: the working button is the width it was before it
 * started, and the action that is not running is not drawn as running.
 */

/** A fresh account per run, for the reason `budgets.spec.ts` gives. */
const person = {
  email: `selection-bar-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Selection Bar",
};

const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const account = `Checking ${Date.now()}`;

/**
 * More than a page of staged rows, some of them possible duplicates.
 *
 * More than a page because "Select all N matching" is a button that only
 * exists then, and it is one more thing in the group. Duplicates because a
 * possible duplicate is what disables Commit selected with the longest reason
 * any selection bar shows. A row with issues would disable it too, with a
 * shorter one, and could not be cleared by the checkbox — which is the
 * transition the second state is about.
 */
const STAGED = 120;
const DUPLICATE_EVERY = 30;

/** The widths `reflow.spec.ts` walks, less the ones between that change nothing here. */
const WIDTHS = [1440, 1280, 1050, 980, 900, 820, 700, 560, 390] as const;

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
 * A write through the real API, as the signed-in page.
 *
 * The page's own request context carries its session cookie; the `Origin` is
 * what the browser would send and what the mutation guard checks.
 */
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return response.json();
}

async function seed(page: Page) {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  await page.getByLabel(/^Account name/).fill(account);
  await page.getByLabel(/^Account type/).selectOption("checking");
  await page.getByLabel(/^Currency or crypto asset/).selectOption("USD");
  await page.getByLabel(/^Opening date/).fill(today);
  await page.getByLabel(/^Starting amount|^Opening balance/).fill("400.00");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(account).first()).toBeVisible();

  // A bare array: the list route answers with the accounts themselves.
  const listed = (await (await page.request.get("/api/v1/accounts")).json()) as {
    id: string;
    name: string;
  }[];
  const accountId = listed.find((item) => item.name === account)!.id;

  // The entry the duplicates look like.
  const original = {
    type: "withdrawal",
    date: today,
    payee: "Corner Market",
    amount: "84.20",
  };
  await post(page, "/api/v1/transactions", {
    idempotencyKey: randomUUID(),
    draft: { ...original, fromAccountId: accountId },
  });
  for (let index = 0; index < STAGED; index += 1) {
    const duplicate = index % DUPLICATE_EVERY === 0;
    await post(page, "/api/v1/staged-transactions", {
      idempotencyKey: randomUUID(),
      draft: duplicate
        ? { ...original, fromAccountId: accountId }
        : {
            type: "withdrawal",
            date: today,
            payee: `Shop ${index}`,
            amount: `${(index % 90) + 1}.25`,
            fromAccountId: accountId,
          },
    });
  }
}

type Geometry = {
  readonly overflowing: string[];
  readonly countLines: number;
  readonly countFitsOnOneLine: boolean;
  readonly iconWidth: number;
  readonly wrappedButtons: string[];
  readonly offMidline: number | null;
};

/**
 * Everything asked of the bar at one width, read in one pass.
 *
 * The count's line total comes from the text's own line boxes rather than its
 * height, so a change of font size cannot pass for a wrap. Whether one line
 * *fits* is measured by laying the same text out unwrapped in the same place,
 * because the honest answer depends on the font the page actually loaded.
 */
async function measure(page: Page): Promise<Geometry> {
  // Two frames: one for the resize to lay out, one for anything it triggers.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return page.locator(".selection-bar").evaluate((bar): Geometry => {
    const box = bar.getBoundingClientRect();
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()}${
        element.className && typeof element.className === "string"
          ? `.${element.className.trim().split(/\s+/).join(".")}`
          : ""
      } "${(element.textContent ?? "").trim().slice(0, 40)}"`;

    const overflowing = [...bar.querySelectorAll("*")]
      .filter((element) => !element.closest(".sr-only"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.left < box.left - 0.5 || rect.right > box.right + 0.5;
      })
      .map(name);

    const summary = bar.firstElementChild as HTMLElement;
    const count = summary.querySelector("strong")!;
    const range = document.createRange();
    range.selectNodeContents(count);
    const countLines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
      .size;
    const icon = summary.querySelector("svg")!;
    const probe = count.cloneNode(true) as HTMLElement;
    probe.style.whiteSpace = "nowrap";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    summary.append(probe);
    const oneLine = probe.getBoundingClientRect().width;
    probe.remove();
    const style = getComputedStyle(bar);
    const inner =
      box.width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) -
      parseFloat(style.borderRightWidth);
    const room =
      inner -
      icon.getBoundingClientRect().width -
      parseFloat(getComputedStyle(summary).columnGap || "0");

    const buttons = [...bar.querySelectorAll<HTMLElement>(".button")];
    // `min-height: 39px` on every `.button`; a label on two lines is taller.
    const wrappedButtons = buttons
      .filter((button) => button.getBoundingClientRect().height > 40.5)
      .map(name);

    const summaryBox = summary.getBoundingClientRect();
    const beside = buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.top < summaryBox.bottom && rect.bottom > summaryBox.top;
    });
    const middle = (rect: DOMRect) => rect.top + rect.height / 2;
    const offMidline = beside.length
      ? Math.max(
          ...beside.map((button) =>
            Math.abs(
              middle(button.getBoundingClientRect()) - middle(count.getBoundingClientRect()),
            ),
          ),
        )
      : null;

    return {
      overflowing,
      countLines,
      countFitsOnOneLine: oneLine <= room,
      iconWidth: icon.getBoundingClientRect().width,
      wrappedButtons,
      offMidline,
    };
  });
}

/** The five questions every state is asked at every width. */
async function expectWholeAtEveryWidth(page: Page, state: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const at = `${state}, ${width}px`;
    const geometry = await measure(page);
    expect(geometry.overflowing, `${at}: runs past the bar's edge`).toEqual([]);
    if (geometry.countFitsOnOneLine) {
      expect(geometry.countLines, `${at}: the count wraps where one line fits`).toBe(1);
    }
    expect(geometry.iconWidth, `${at}: the count's icon has shrunk`).toBeGreaterThanOrEqual(16);
    expect(geometry.wrappedButtons, `${at}: a button's label wraps inside it`).toEqual([]);
    if (geometry.offMidline !== null) {
      expect(
        geometry.offMidline,
        `${at}: the count is off the buttons' midline`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

test.describe.configure({ mode: "serial" });

test.describe("the selection bar", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await signUp(page);
    await seed(page);
    await page.goto("/staged");
    await page
      .getByRole("checkbox", { name: /select all/i })
      .first()
      .check();
    const bar = page.locator(".selection-bar");
    await bar.getByRole("button", { name: /^Select all .* matching$/ }).click();
    // Explicit however it was made, so it is "N of N matching" and never the
    // filtered "All N matching" (`web.md` 9.5).
    await expect(
      bar.getByText(/^([\d,]+) of \1 matching staged transactions selected$/),
    ).toBeVisible();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("holds together while Commit says why it is disabled", async () => {
    test.setTimeout(120_000);
    const bar = page.locator(".selection-bar");
    // The state, asserted before it is measured: a bar with no reason showing
    // would pass every question below for the wrong reason.
    await expect(bar.getByRole("button", { name: "Commit selected" })).toBeDisabled();
    await expect(bar.getByText(/look like duplicates/)).toBeVisible();
    await expectWholeAtEveryWidth(page, "reason showing");
  });

  test("holds together once the duplicates are allowed", async () => {
    test.setTimeout(120_000);
    const bar = page.locator(".selection-bar");
    await page.setViewportSize({ width: 1440, height: 900 });
    await bar.getByRole("checkbox", { name: "Commit possible duplicates" }).check();
    await expect(bar.getByRole("button", { name: "Commit selected" })).toBeEnabled();
    await expect(bar.getByText(/look like duplicates/)).toHaveCount(0);
    await expectWholeAtEveryWidth(page, "enabled");
  });

  test("holds together while the commit runs, and only the commit looks busy", async () => {
    test.setTimeout(120_000);
    const bar = page.locator(".selection-bar");
    await page.setViewportSize({ width: 1440, height: 900 });
    const commit = bar.getByRole("button", { name: /Commit selected/ });
    const remove = bar.getByRole("button", { name: /Delete selected/ });
    const before = await commit.evaluate((button) => button.getBoundingClientRect().width);

    // Held rather than delayed by a timer, so the state lasts exactly as long
    // as the measuring does and no slow machine can outrun it.
    let release: (route: Route) => void = () => {};
    const held = new Promise<Route>((done) => {
      release = done;
    });
    await page.route("**/api/v1/staged-transactions/commit", (route) => release(route));
    await commit.click();
    await expect(commit).toHaveAttribute("aria-busy", "true");

    expect(
      await commit.evaluate((button) => button.getBoundingClientRect().width),
      "the working button changed width: the spinner arrived beside its icon",
    ).toBeCloseTo(before, 0);
    await expect(remove, "Delete selected is drawn as working during a commit").not.toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(remove).toBeDisabled();

    await expectWholeAtEveryWidth(page, "committing");

    // Nothing is committed: the request is refused once measured, so the
    // queue this spec seeded is the queue it leaves.
    await (await held).abort();
  });
});
