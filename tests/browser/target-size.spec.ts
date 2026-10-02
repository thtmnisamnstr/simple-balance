import { expect, test, type Page } from "@playwright/test";
import { todayIn } from "../../src/shared/recurrence-dates.js";

/**
 * SC 2.5.8 Target Size (Minimum), level AA, measured by a layout engine.
 *
 * `web.md` 13.4 is Binding, is met today by design — `.icon-button` is 31 by 31
 * with a 45px hit area — and carries "*Not checked mechanically*" with no
 * qualification. That was right while jsdom was the only tier. It is not right
 * now: a source read gets as far as `width: 15px` in the stylesheet and can
 * reason about row padding, and then stops, because whether two 24px circles
 * intersect on a row that has wrapped is a question only a browser can answer.
 * §17.2 item 7 already made this correction for the progress bar. Filing a rule
 * as review means the one tier built to catch it never gets asked.
 *
 * The success criterion has two branches and this measures both:
 *
 * 1. **Size.** 24 by 24 CSS pixels passes outright, and nothing else is asked.
 * 2. **Spacing**, for anything smaller: a 24px-diameter circle centered on the
 *    target must not intersect the circle of any other target — centers 24 CSS
 *    pixels apart or more.
 *
 * The second branch is why this cannot be a source read. The checkbox a row
 * carries is 15 by 15 by the stylesheet's own rule, so the whole question is
 * where the browser puts the next one, which depends on row height, padding,
 * the width of the column beside it and whether the row wrapped — none of which
 * jsdom computes.
 *
 * Both widths, because a phone is where rows wrap and where spacing fails.
 */

const person = {
  email: `target-size-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Target Size",
};

const account = `Checking ${Date.now()}`;
const payee = "Corner Shop";

/**
 * Dated today, for the reason `budgets.spec.ts` gives about its spend: the
 * register opens on a default range around now, and a row hard-coded to a past
 * month is filed correctly and then simply not on the screen being measured.
 */
const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

/** The same sign-up the other two specs do, and for the reason they give. */
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
 * One account and one entry, because an empty list has no rows and the rule is
 * about what a dense row does to the controls in it.
 */
async function seedOneRow(page: Page) {
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  await page.getByLabel(/^Account name/).fill(account);
  await page.getByLabel(/^Account type/).selectOption("checking");
  await page.getByLabel(/^Currency or crypto asset/).selectOption("USD");
  await page.getByLabel(/^Opening date/).fill(today);
  await page.getByLabel(/^Opening balance/).fill("400.00");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(account, { exact: false }).first()).toBeVisible();

  await page.goto("/transactions");
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Add transaction" }).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Date/).fill(today);
  await dialog.getByLabel(/^Payee/).fill(payee);
  await dialog
    .getByLabel(/^Amount/)
    .first()
    .fill("12.34");
  await dialog.getByRole("button", { name: "Commit transaction" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(payee).first()).toBeVisible();
}

/** A measured target: where the browser put it, and how to name it in a failure. */
type Target = { label: string; x: number; y: number; width: number; height: number };

/**
 * Every target SC 2.5.8 is about, as the browser laid it out.
 *
 * The exclusions are the criterion's own, not convenience:
 *
 * - **Inline.** A target in a sentence or a block of text is excluded outright,
 *   because its size is the line's. Detected as a link whose parent is running
 *   text rather than a list item, a cell or a row of actions.
 * - **Not rendered.** Zero area, `display: none`, `visibility: hidden`. There is
 *   nothing to hit and nothing to measure.
 * - **An `<option>`.** The list a `<select>` opens is drawn by the browser, is
 *   not in the page's layout at all, and is the criterion's user-agent-control
 *   exception by definition.
 *
 * Nothing is excluded for being small, which is the whole point.
 */
async function targets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const interactive =
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="switch"], [tabindex]:not([tabindex="-1"])';
    const out: Target[] = [];
    for (const element of Array.from(document.querySelectorAll(interactive))) {
      if (element.tagName === "OPTION") continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (element.tagName === "A") {
        const parent = element.parentElement;
        const inRunningText =
          parent !== null && ["P", "SPAN", "SMALL", "LI", "LABEL"].includes(parent.tagName);
        // A link inside a sentence takes the sentence's line height whatever is
        // done to it, which is why the criterion exempts it. A link that is on
        // its own in a cell or a nav is not inline and is measured.
        if (inRunningText && parent.textContent !== element.textContent) continue;
      }
      const name =
        element.getAttribute("aria-label") ||
        (element.textContent || "").trim().slice(0, 40) ||
        element.getAttribute("name") ||
        element.getAttribute("type") ||
        "";
      out.push({
        label: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}${name ? ` "${name}"` : ""}`,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        width: box.width,
        height: box.height,
      });
    }
    return out;
  });
}

/**
 * The criterion applied: pass on size, else pass on spacing, else report.
 *
 * Rounded to a tenth of a pixel before comparing, because a browser lays out in
 * fractions and 23.999 is not a defect anybody can see or anybody authored.
 */
function failures(found: readonly Target[]): string[] {
  const small = found.filter((target) => target.width < 23.9 || target.height < 23.9);
  const reported: string[] = [];
  for (const target of small) {
    const crowded = found.find((other) => {
      if (other === target) return false;
      const distance = Math.hypot(other.x - target.x, other.y - target.y);
      return distance < 23.9;
    });
    if (crowded) {
      reported.push(
        `${target.label} is ${target.width.toFixed(1)}x${target.height.toFixed(1)} and its 24px circle meets ${crowded.label}`,
      );
    }
  }
  return reported;
}

test.describe("every target in a browser", () => {
  test("is 24 by 24, or spaced so its 24px circle meets no other", async ({ page }) => {
    await signUp(page);
    await seedOneRow(page);

    for (const path of ["/transactions", "/accounts", "/settings"]) {
      await page.goto(path);
      // The nav is the last thing to render on a cold route, and measuring
      // before it arrives measures a page that is still laying itself out.
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();

      const wide = await targets(page);
      // A selector that matched nothing would report every page perfectly
      // accessible. Each of these screens carries a nav, a heading row and at
      // least one form control.
      expect(wide.length, `${path} has targets to measure`).toBeGreaterThan(8);
      // And reached past the navigation into the page itself. A count alone is
      // satisfied by the sidebar, which every screen has and which is not what
      // this is about: the dense row is. The seeded entry is the one thing this
      // spec put on the screen, so its own controls are what proves the
      // selector got that far — three of them, the row checkbox, the payee link
      // and the row's action menu.
      if (path === "/transactions") {
        expect(
          wide.filter((target) => target.label.includes(payee)).length,
          "the seeded row's own controls were measured",
        ).toBeGreaterThan(2);
      }
      expect(failures(wide), `${path} at desktop width`).toEqual([]);

      await page.setViewportSize({ width: 390, height: 844 });
      // Retried, because a resize is not laid out when `setViewportSize`
      // returns and the first read would measure the width that has gone.
      await expect(async () => {
        const narrow = await targets(page);
        expect(narrow.length, `${path} has targets to measure at 390px`).toBeGreaterThan(8);
        expect(failures(narrow), `${path} at 390px`).toEqual([]);
      }).toPass();
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });
});
