/**
 * Seed a throwaway instance and photograph every screen in it.
 *
 * The output in `docs/product/` is the marketing site's only source of
 * pictures. That site is a separate repository and cannot run this
 * application, so if the kit is not built here it is not built anywhere, and
 * the site falls back to describing screens nobody has looked at.
 *
 * **Why the seed is committed.** `seed.json` is a fixture rather than a
 * generator. A screenshot of randomly generated data is a screenshot nobody
 * can reproduce, so two captures a month apart cannot be compared and a
 * layout regression hides in the noise. The dates inside it are relative —
 * a day within a month, and a count of months back — because every page in
 * this app defaults to a this-month range, and a fixed calendar would render
 * an empty dashboard the moment the month turned.
 *
 * WHAT THIS NEEDS, and why it is not in `npm run verify`: a throwaway
 * PostgreSQL, this application on :3000, Vite on :5173, and about a minute.
 * `docs/standards/operations.md` has the runbook, and the `product-kit`
 * skill has the order and the traps.
 *
 *   npx tsx scripts/product-kit/build.mjs
 */
import { chromium } from "playwright";
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Run under `tsx`, because this is the one question that may not be answered
// twice. `AGENTS.md`: whether it is a given day where somebody lives is
// answered in one place, and a second implementation here is what put the
// seed a day ahead of the browser reading it.
import { calendarDayIn } from "../../src/shared/recurrence-dates.js";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.OUT_DIR ?? "docs/product/screenshots";
const seed = JSON.parse(readFileSync("scripts/product-kit/seed.json", "utf8"));
const features = JSON.parse(readFileSync("docs/product/features.json", "utf8"));
/* The release these pictures are of. The marketing site records it so that
   "which version is the site describing" has an answer, and so that a
   screenshot set can be recognised as older than the app it advertises. */
const { version: appVersion } = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * The zone both halves of this script agree on.
 *
 * The seed's dates are worked out here and read back by a browser, and those
 * two used to be different clocks: the dates were UTC and the browser was on
 * whatever the machine was set to. Run in the evening in California that put
 * every clamped date a day into the future, and this application correctly
 * declines to count money that has not moved yet — so the current month came
 * out short with no visible sign, which is the worst way for a marketing
 * screenshot to be wrong. One zone, used for the dates and handed to the
 * browser below.
 */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const today = new Date();
const iso = (d) => calendarDayIn(d, zone);

/** Day `day` of the month `monthsAgo` back, never dated into the future. */
function dayOfMonth(monthsAgo, day) {
  const start = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
  const last = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const candidate = new Date(start.getFullYear(), start.getMonth(), Math.min(day, last));
  // Money dated ahead has not moved, and this application correctly declines
  // to count it — which would render a screenshot of an empty month.
  return iso(candidate > today ? today : candidate);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    // Both pinned, because both reach the pictures. `src/client/locale.ts`
    // reads the browser's own language tag to choose the new account's
    // currency, so an unpinned locale means a laptop set to en-GB captures a
    // marketing set denominated in pounds. And `zone` is the same one the
    // seed's dates were built in, which is what makes "today" mean one day
    // on both sides of the wire.
    locale: "en-US",
    timezoneId: zone,
  });
  const page = await context.newPage();

  // ---- sign up, or sign in if the fixture is already there ---------------
  await page.goto(BASE);
  const toggle = page.getByRole("button", { name: "Create an account" });
  const signUp = page.getByRole("heading", { name: "Create your account" });
  await signUp.or(toggle).waitFor();
  if (await toggle.isVisible()) await toggle.click();
  await signUp.waitFor();
  await page.getByLabel("Your name").fill(seed.person.name);
  await page.getByLabel("Email address").fill(seed.person.email);
  await page.getByLabel(/^Password/).fill(seed.person.password);
  await page.getByLabel(/^Confirm password/).fill(seed.person.password);
  await page.getByRole("button", { name: "Create account" }).click();

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const taken = page.getByText(/already/i);
  await nav.or(taken).waitFor({ timeout: 30_000 });
  if (!(await nav.isVisible())) {
    // The identity is fixed because it is visible in the sidebar of every
    // shot, so a re-run meets an account that already exists.
    await page.goto(BASE);
    await page.getByRole("button", { name: /Sign in/i }).first().waitFor();
    await page.getByLabel("Email address").fill(seed.person.email);
    await page.getByLabel(/^Password/).fill(seed.person.password);
    await page.getByRole("button", { name: /^Sign in$/i }).click();
    await nav.waitFor({ timeout: 30_000 });
  }

  // ---- seed, idempotently ------------------------------------------------
  const ids = await page.evaluate(
    async ({ accounts, categories, openingDate }) => {
      const post = async (url, body) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
        return res.json();
      };
      const list = async (url, key) => {
        const res = await fetch(url);
        if (!res.ok) return [];
        const body = await res.json();
        return Array.isArray(body) ? body : (body[key] ?? body.items ?? []);
      };
      const byName = (rows) => new Map(rows.map((r) => [r.name, r.id]));
      const haveAccounts = byName(await list("/api/v1/accounts", "accounts"));
      const haveCategories = byName(await list("/api/v1/categories", "categories"));

      const out = { accounts: {}, categories: {} };
      for (const a of accounts) {
        out.accounts[a.name] =
          haveAccounts.get(a.name) ?? (await post("/api/v1/accounts", { ...a, openingDate })).id;
      }
      for (const c of categories) {
        out.categories[c.name] =
          haveCategories.get(c.name) ?? (await post("/api/v1/categories", c)).id;
      }
      return out;
    },
    {
      accounts: seed.accounts,
      categories: seed.categories,
      openingDate: dayOfMonth(seed.openingMonthsAgo, 1),
    },
  );

  const drafts = [];
  for (let month = 0; month < seed.monthsOfHistory; month += 1) {
    for (const entry of seed.entries) {
      const date = dayOfMonth(month, entry.day);
      const common = {
        date,
        payee: entry.payee,
        description: entry.description,
        ...(entry.category ? { categoryId: ids.categories[entry.category] } : {}),
      };
      if (entry.type === "transfer") {
        drafts.push({
          ...common,
          type: "transfer",
          fromAccountId: ids.accounts[entry.from],
          toAccountId: ids.accounts[entry.to],
          sourceAmount: entry.amount,
          destinationAmount: entry.amount,
        });
      } else if (entry.type === "deposit") {
        drafts.push({ ...common, type: "deposit", toAccountId: ids.accounts[entry.to], amount: entry.amount });
      } else {
        drafts.push({ ...common, type: "withdrawal", fromAccountId: ids.accounts[entry.from], amount: entry.amount });
      }
    }
  }

  const written = await page.evaluate(async (list) => {
    let ok = 0;
    const problems = [];
    for (const [index, draft] of list.entries()) {
      const res = await fetch("/api/v1/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Stable across runs, so a re-run replays rather than duplicating.
        body: JSON.stringify({ draft, idempotencyKey: `kit-${index}-${draft.date}` }),
      });
      if (res.ok) ok += 1;
      else if (problems.length < 3) problems.push(`${res.status} ${(await res.text()).slice(0, 180)}`);
    }
    return { ok, problems };
  }, drafts);
  console.log(`transactions: ${written.ok}/${drafts.length}`);
  if (written.problems.length) console.log("problems:", written.problems);

  const budgets = await page.evaluate(
    async ({ plans, categories, activeFrom }) => {
      let ok = 0;
      for (const plan of plans) {
        const res = await fetch("/api/v1/budget-plans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            categoryId: categories[plan.category],
            currency: plan.currency,
            periodUnit: "month",
            amount: plan.amount,
            activeFrom,
          }),
        });
        if (res.ok) ok += 1;
      }
      return ok;
    },
    { plans: seed.budgets, categories: ids.categories, activeFrom: dayOfMonth(seed.monthsOfHistory, 1) },
  );
  console.log(`budgets: ${budgets}/${seed.budgets.length}`);

  // ---- photograph every screen ------------------------------------------
  await page.goto(BASE);
  await nav.waitFor();
  const routes = await nav.locator("a").evaluateAll((links) =>
    links.map((a) => a.getAttribute("href") ?? "").filter((href) => href.startsWith("/")),
  );

  const slug = (route) => (route === "/" ? "dashboard" : route.replace(/^\//, "").replace(/\//g, "-"));
  const shots = [];

  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const route of routes) {
      await page.goto(BASE + route);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(900);
      const png = await page.screenshot();
      const webp = await sharp(png).resize({ width: 1600 }).webp({ quality: 82 }).toBuffer();
      const name = `${slug(route)}-${theme}.webp`;
      writeFileSync(join(OUT, name), webp);
      shots.push({ file: name, route, theme, kb: Math.round(webp.length / 1024) });
      console.log(`wrote ${name} (${Math.round(webp.length / 1024)} KB)`);
    }
  }

  // ---- the manifest, and the check that the two halves agree -------------
  const captured = new Set(shots.map((s) => s.file.replace(/-(light|dark)\.webp$/, "")));
  const missing = [...new Set(features.features.map((f) => f.screenshot))].filter(
    (name) => !captured.has(name),
  );
  if (missing.length > 0) {
    // A feature pointing at a picture that was never taken is the one failure
    // the marketing site cannot detect from its side.
    throw new Error(`features.json names screenshots that were not captured: ${missing.join(", ")}`);
  }

  writeFileSync(
    join("docs/product", "screenshots.json"),
    `${JSON.stringify(
      {
        $comment:
          "Written by scripts/product-kit/build.mjs. Every screen in the application, in both themes, at 1600px.",
        capturedAt: iso(today),
        appVersion,
        appUrl: BASE,
        viewport: "1440x900 at 2x, shipped at 1600px",
        screens: [...captured].sort(),
        shots: shots.sort((a, b) => a.file.localeCompare(b.file)),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${shots.length} shots across ${captured.size} screens.`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
