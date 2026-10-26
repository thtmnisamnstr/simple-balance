import { expect, test, type Page, type Route } from "@playwright/test";
import {
  defaultLedgerFileKinds,
  ledgerFileKinds,
  ledgerFileQueryString,
  type LedgerFileKind,
} from "../../src/shared/ledger-file.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * What the export form puts on the wire, and that a keyboard alone can make it.
 *
 * `web.md` 13.5 names the class of defect this tier is for: the markup is right
 * and the wire is wrong. A checkbox that changes nothing in either position was
 * the first one it caught, and the export form is nine checkboxes, three radio
 * groups and two dates whose whole job is to change one query string — and the
 * route is read by another half of the stack that cannot see the page. jsdom
 * holds the same query string against the shared builder; what it cannot hold
 * is the browser's own share of it — implicit submission from a date field, the
 * arrow keys moving inside a radio group, a real download with the name the
 * response gave — so those are here.
 *
 * The route is answered with `page.route`, the way `plan-buttons.spec.ts`
 * answers the billing status: the question is what this page sends and what it
 * does with the answer, and the file the server builds is the integration
 * tier's to check. Everything below the response is the real page.
 */

const person = {
  email: `ledger-export-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Ledger Export",
};

const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

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

/** A write through the real API, as the signed-in page, with the Origin the guard checks. */
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { id: string };
}

/** Every request the page made to the route, and the answer it is given. */
function answerExport(page: Page, answer: (route: Route) => Promise<void>) {
  const asked: { url: URL; method: string; body: string | null }[] = [];
  const handler = async (route: Route) => {
    const request = route.request();
    asked.push({ url: new URL(request.url()), method: request.method(), body: request.postData() });
    await answer(route);
  };
  const matches = (url: URL) => url.pathname === "/api/v1/ledger-file";
  return {
    asked,
    install: () => page.route(matches, handler),
    remove: () => page.unroute(matches, handler),
  };
}

const fileAnswer = (route: Route) =>
  route.fulfill({
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="simple-balance-accounts-${today}.json"`,
    },
    body: '{"format":"simple-balance-ledger-1"}\n',
  });

const inOrder = (kinds: readonly LedgerFileKind[]) =>
  ledgerFileKinds.filter((kind) => kinds.includes(kind));

test.describe.configure({ mode: "serial" });

test.describe("the export form", () => {
  let page: Page;
  const accounts: Record<string, string> = {};

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signUp(page);
    // Two in use and one archived, named so the server's name order puts the
    // archived one between the others: the list puts it last, and the request
    // follows the list.
    for (const [key, name] of [
      ["checking", "Everyday checking"],
      ["old", "Old travel card"],
      ["savings", "Rainy-day savings"],
    ] as const) {
      const created = await post(page, "/api/v1/accounts", {
        name,
        type: "checking",
        currency: "USD",
        openingDate: today,
        openingBalance: "0",
      });
      accounts[key] = created.id;
    }
    await post(page, `/api/v1/accounts/${accounts.old}/archived`, {
      expectedVersion: 1,
      archived: true,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("downloads everything but the history by default, as a GET of the route", async () => {
    const route = answerExport(page, fileAnswer);
    await route.install();
    await page.goto("/import");
    const form = page.getByRole("region", { name: "Export a Simple Balance file" });
    const saving = page.waitForEvent("download");
    await form.getByRole("button", { name: "Export file" }).click();
    const download = await saving;
    expect(download.suggestedFilename()).toBe(`simple-balance-accounts-${today}.json`);
    expect(route.asked).toHaveLength(1);
    expect(route.asked[0]!.method).toBe("GET");
    expect(route.asked[0]!.body).toBeNull();
    expect(route.asked[0]!.url.search.slice(1)).toBe(
      ledgerFileQueryString({ kinds: [...defaultLedgerFileKinds] }),
    );
    await route.remove();
  });

  /**
   * The keyboard pass `web.md` 14 asks for, done by the keyboard: the arrows
   * choose inside a group and Tab leaves it, Space ticks, and Enter in a date
   * field submits the form. Each of those is the browser's behavior given the
   * right markup — a shared `name`, one form, one submit — and none of it
   * happens in jsdom.
   */
  test("is driven by the keyboard alone, and sends what it was told", async () => {
    const route = answerExport(page, fileAnswer);
    await route.install();
    await page.goto("/import");
    const form = page.getByRole("region", { name: "Export a Simple Balance file" });

    await form.getByRole("radio", { name: /Everything/ }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(form.getByRole("radio", { name: /Some accounts/ })).toBeChecked();
    await expect(form.getByRole("radio", { name: /Some accounts/ })).toBeFocused();

    const list = form.getByRole("group", { name: "Accounts" });
    const boxes = list.getByRole("checkbox");
    await expect(boxes).toHaveCount(3);
    await expect(boxes.last()).toHaveAccessibleName(/Old travel card USD Archived/);
    await page.keyboard.press("Tab");
    await expect(boxes.first()).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(boxes.last()).toBeFocused();
    await page.keyboard.press("Space");

    // One tab stop for the group, on its checked radio, and the arrows inside.
    await page.keyboard.press("Tab");
    await expect(form.getByRole("radio", { name: "No, account details only" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(form.getByRole("radio", { name: "In a date range" })).toBeChecked();

    await page.keyboard.press("Tab");
    await expect(
      form.getByRole("checkbox", { name: "Include deleted transactions" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(form.getByLabel("Start date")).toBeFocused();
    await form.getByLabel("Start date").fill("2026-01-01");
    await form.getByLabel("End date").fill(today);

    const saving = page.waitForEvent("download");
    await form.getByLabel("End date").press("Enter");
    await saving;
    expect(route.asked).toHaveLength(1);
    expect(route.asked[0]!.url.search.slice(1)).toBe(
      ledgerFileQueryString({
        kinds: inOrder(["accounts", "categories", "entries", "deletedEntries"]),
        accountIds: [accounts.checking!, accounts.old!],
        start: "2026-01-01",
        end: today,
      }),
    );
    await route.remove();
  });

  test("shows the route's refusal where the button is, and saves nothing", async () => {
    const sentence =
      "This export would hold 120,000 rows, more than the 100,000 one file may. Narrow the entries with a start and end date and export one piece at a time.";
    const route = answerExport(page, (answer) =>
      answer.fulfill({
        status: 422,
        json: {
          error: {
            code: "VALIDATION_ERROR",
            message: sentence,
            details: { limit: 100_000, count: 120_000 },
          },
        },
      }),
    );
    await route.install();
    let saved = false;
    page.on("download", () => {
      saved = true;
    });
    await page.goto("/import");
    const form = page.getByRole("region", { name: "Export a Simple Balance file" });
    await form.getByRole("button", { name: "Export file" }).click();
    const summary = form.getByRole("alert");
    await expect(summary).toContainText("There is a problem");
    await expect(summary).toContainText(sentence);
    // The summary takes focus, so the sentence is where the next Tab starts.
    await expect(form.locator(".error-summary")).toBeFocused();
    expect(route.asked).toHaveLength(1);
    expect(saved).toBe(false);
    await route.remove();
  });
});
