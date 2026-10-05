import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * What the 0.2.0 sandbox smoke test found, held in the tier that can see it.
 *
 * Every case here is a fact about a real browser that jsdom does not model:
 * where focus is after a dialog closes, whether a transitioned `visibility`
 * lets an element take focus, whether a long figure pushes the page sideways.
 * Each was reported from the deployed sandbox and reproduced before it was
 * fixed.
 */

const person = {
  email: `smoke-fixes-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Smoke Fixes",
};
const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

let page: Page;
let accountId: string;

async function signUp(target: Page) {
  await target.goto("/");
  const toggle = target.getByRole("button", { name: "Create an account" });
  const heading = target.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(heading).toBeVisible();
  await target.getByLabel("Your name").fill(person.name);
  await target.getByLabel("Email address").fill(person.email);
  await target.getByLabel(/^Password/).fill(person.password);
  await target.getByLabel(/^Confirm password/).fill(person.password);
  await target.getByRole("button", { name: "Create account" }).click();
  await expect(target.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

/** A write through the real API, as the signed-in page, with the Origin the guard checks. */
async function post(path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return response.json();
}

async function withdrawal(payee: string, amount: string) {
  return post("/api/v1/transactions", {
    idempotencyKey: randomUUID(),
    draft: { type: "withdrawal", date: today, payee, amount, fromAccountId: accountId },
  });
}

const alertSaying = (text: string | RegExp) => page.locator(".alert", { hasText: text });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await (await browser.newContext()).newPage();
  await signUp(page);
  const account = await post("/api/v1/accounts", {
    name: "Focus Checking",
    type: "checking",
    currency: "USD",
    openingDate: today,
    openingBalance: "500.00",
  });
  accountId = account.id;
});

test.afterAll(async () => {
  await page.context().close();
});

test("the mobile menu takes focus when it opens, and a link in it leaves focus in the page", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/accounts");
  const hamburger = page.getByRole("button", { name: "Open navigation" });
  await expect(hamburger).toHaveAttribute("aria-expanded", "false");
  await hamburger.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".mobile-close")).toBeFocused();
  await expect(hamburger).toHaveAttribute("aria-expanded", "true");

  await page.locator("#app-navigation").getByRole("link", { name: "Transactions" }).click();
  await expect(page).toHaveURL(/\/transactions/);
  await expect(page.locator("#main")).toBeFocused();
  await expect(hamburger).not.toBeFocused();
  await page.setViewportSize({ width: 1280, height: 860 });
});

test("a single delete says what it did and takes focus", async () => {
  await withdrawal("Focus Delete", "3.00");
  await page.goto("/transactions");
  const row = page.getByRole("row", { name: /Focus Delete/ });
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(alertSaying(/Deleted “Focus Delete”/)).toBeFocused();
});

test("a bulk edit's result takes focus once its dialog has closed", async () => {
  await withdrawal("Focus Bulk A", "4.00");
  await withdrawal("Focus Bulk B", "5.00");
  await page.goto("/transactions");
  for (const payee of ["Focus Bulk A", "Focus Bulk B"]) {
    await page
      .getByRole("row", { name: new RegExp(payee) })
      .getByRole("checkbox")
      .check();
  }
  await page.getByRole("button", { name: /Edit selected/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Change notes").check();
  await dialog.getByLabel("New notes").fill("bulk focus");
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(alertSaying("2 transactions updated.")).toBeFocused();
});

test("a button keeps focus while it works and after", async () => {
  await page.goto("/categories");
  await page.getByLabel("Category name").fill(`Focus ${Date.now()}`);
  const add = page.getByRole("button", { name: "Add category" });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(add).toBeFocused();
  await expect(add).not.toHaveAttribute("aria-busy", "true");
  await expect(add).toBeFocused();
});

test("an address with nothing at it goes to the Overview", async () => {
  await page.goto("/no-such-page");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});

test("a report name nobody knows goes to Reports", async () => {
  await page.goto("/reports/not-a-report");
  await expect(page).toHaveURL(/\/reports$/);
});

test("a failed authorization link explains itself and repeats nothing from the address", async () => {
  await page.goto("/auth-error?error=invalid_client&error_description=Call%20555-0100%20now");
  await expect(page.getByRole("heading", { name: "That did not work." })).toBeVisible();
  await expect(page.getByText(/names an app this server does not know/)).toBeVisible();
  await expect(page.getByText(/555-0100/)).toHaveCount(0);
});

test("a very long balance wraps rather than pushing the page sideways", async () => {
  await post("/api/v1/accounts", {
    name: "Focus Enormous",
    type: "other_asset",
    currency: "USD",
    openingDate: today,
    openingBalance: "99999999999999999999999999.999999999999999999",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/", "/accounts"]) {
    await page.goto(path);
    await expect(page.getByText("Focus Enormous").first()).toBeVisible();
    const { overflow, offenders } = await page.evaluate(() => ({
      overflow: document.scrollingElement!.scrollWidth - window.innerWidth,
      // What sticks out, deepest first, so a failure names the element to fix.
      offenders: [...document.querySelectorAll("main *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5)
        .filter(
          (element) =>
            ![...element.children].some(
              (child) => child.getBoundingClientRect().right > window.innerWidth + 0.5,
            ),
        )
        .slice(0, 5)
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}.${String(element.className).trim().replaceAll(" ", ".")} "${(element.textContent ?? "").trim().slice(0, 40)}"`,
        ),
    }));
    expect(
      overflow,
      `${path} scrolls sideways by ${overflow}px: ${offenders.join("; ")}`,
    ).toBeLessThanOrEqual(0);
  }
  // A page that does not scroll can still have a card whose balance runs out
  // past its own edge, which is what the sandbox showed at desktop width: the
  // grid cell is narrower than the number and nothing above it scrolls.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/accounts");
  const card = page.locator(".account-card-link", { hasText: "Focus Enormous" });
  const spill = await card.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    return Math.max(
      ...[...element.querySelectorAll("*")].map(
        (child) => child.getBoundingClientRect().right - edge,
      ),
    );
  });
  expect(spill, `the balance runs ${spill}px past its card`).toBeLessThanOrEqual(0);
});

test("a refused delete says so where focus is, naming what was refused", async () => {
  await post("/api/v1/transactions", {
    idempotencyKey: randomUUID(),
    draft: {
      type: "withdrawal",
      date: today,
      payee: "Focus Used",
      amount: "2.00",
      fromAccountId: accountId,
      categoryName: "Focus In Use",
    },
  });
  await page.goto("/categories");
  await page.getByRole("button", { name: "Delete unused Focus In Use" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  const refusal = alertSaying(/“Focus In Use” was not deleted/);
  await expect(refusal).toBeFocused();
  await expect(refusal).toBeInViewport();
});

/** Each matching element's own text, and how many lines it is laid out on. */
const linesOf = (selector: string) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((element) => {
        // Text alone: an icon sits a few pixels off the words' top and would
        // count as a line of its own.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const tops: number[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          tops.push(...[...range.getClientRects()].map((rect) => rect.top));
        }
        const half = parseFloat(getComputedStyle(element).fontSize) / 2;
        const lines = tops
          .sort((a, b) => a - b)
          .filter((top, index, all) => index === 0 || top - all[index - 1]! > half).length;
        return { text: (element.textContent ?? "").trim(), lines };
      }),
    selector,
  );

test("a page's header actions wrap rather than push the page sideways", async () => {
  // Staged with a duplicate waiting has the longest set of header actions in
  // the product, and `reflow.spec.ts` visits it with none: at 820px it was
  // 59px wider than the window with its title on two lines, and at 390px the
  // duplicates button broke inside itself.
  await withdrawal("Corner Market", "84.20");
  await post("/api/v1/staged-transactions", {
    idempotencyKey: randomUUID(),
    draft: {
      type: "withdrawal",
      date: today,
      payee: "Corner Market",
      amount: "84.20",
      fromAccountId: accountId,
    },
  });
  for (const width of [1440, 1050, 900, 820, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto("/staged");
    await expect(page.getByRole("link", { name: /possible duplicate/ })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.scrollingElement!.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${width}px scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
    for (const item of await linesOf(".page-heading h1, .page-heading .page-actions .button")) {
      expect(item.lines, `${width}px: "${item.text}" breaks across lines`).toBe(1);
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });
});

test("the duplicate review opens with focus in neither form", async () => {
  // Both sides are a TransactionForm, each of which used to take focus for
  // its payee, so the page opened with the cursor halfway down it in
  // whichever rendered last.
  await page.goto("/staged/duplicates");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("form").first()).toBeVisible();
  const inForm = await page.evaluate(() =>
    document.activeElement?.closest("form") ? document.activeElement.outerHTML.slice(0, 90) : null,
  );
  expect(inForm).toBeNull();
});

test("an ordinary balance stays whole beside a long account name", async () => {
  // The overview's account list let both columns shrink and break anywhere,
  // which kept a 26-digit balance on screen and split "$8,924.60" too.
  await post("/api/v1/accounts", {
    name: "Everyday Joint Checking With A Long Name",
    type: "checking",
    currency: "USD",
    openingDate: today,
    openingBalance: "8924.60",
  });
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto("/");
    await expect(page.getByText("Everyday Joint Checking With A Long Name").first()).toBeVisible();
    for (const item of await linesOf(".account-mini-row > span")) {
      // The enormous balance an earlier test opened may wrap; that is the
      // one it is allowed to.
      if (item.text.replace(/\D/g, "").length > 20) continue;
      expect(item.lines, `${width}px: "${item.text}" is split`).toBe(1);
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });
});

test("a badge's icon keeps its distance from its words", async () => {
  const account = await post("/api/v1/accounts", {
    name: "Badge Checking",
    type: "checking",
    currency: "USD",
    openingDate: today,
    openingBalance: "0",
    institution: "Pacific Mutual",
  });
  await page.goto(`/accounts/${account.id}`);
  const gap = await page.locator(".badge", { hasText: "Pacific Mutual" }).evaluate((badge) => {
    const icon = badge.querySelector("svg")!.getBoundingClientRect();
    const words = [...badge.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
    )!;
    const range = document.createRange();
    range.selectNodeContents(words);
    return range.getBoundingClientRect().left - icon.right;
  });
  expect(gap).toBeGreaterThanOrEqual(3);
});
