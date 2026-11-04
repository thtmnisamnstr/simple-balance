/**
 * Load the demo ledger into a throwaway instance and photograph every screen in it.
 *
 * The output in `docs/product/` is the marketing site's only source of
 * pictures. That site is a separate repository and cannot run this
 * application, so if the kit is not built here it is not built anywhere, and
 * the site falls back to describing screens nobody has looked at.
 *
 * **What it photographs.** The demo ledger, `scripts/demo-ledger/demo-ledger.json`:
 * an export from this application, committed, and moved into a new sign-up's
 * books through the route a person moving their own file uses. Committed
 * rather than generated, because a screenshot of randomly generated data is a
 * screenshot nobody can reproduce, so two captures a month apart cannot be
 * compared and a layout regression hides in the noise. Its dates move to this
 * month on the way in, because every page in this app defaults to a
 * this-month range; `scripts/demo-ledger/rebase.mjs` says how.
 *
 * WHAT THIS NEEDS, and why it is not in `npm run verify`: a throwaway
 * PostgreSQL, this application on :3000, Vite on :5173, and about a minute.
 * The `product-kit` skill has the runbook, the order and the traps.
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
// demo ledger a day ahead of the browser reading it.
import { calendarDayIn } from "../../src/shared/recurrence-dates.js";
import { DEMO_PERSON, demoLedgerMove } from "../demo-ledger/rebase.mjs";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.OUT_DIR ?? "docs/product/screenshots";
const features = JSON.parse(readFileSync("docs/product/features.json", "utf8"));
/* The release these pictures are of. The marketing site records it so that
   "which version is the site describing" has an answer, and so that a
   screenshot set can be recognized as older than the app it advertises. */
const { version: appVersion } = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * The zone both halves of this script agree on.
 *
 * The demo ledger's dates are worked out here and read back by a browser, and those
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
    // demo ledger's dates were rebased in, which is what makes "today" mean one day
    // on both sides of the wire.
    locale: "en-US",
    timezoneId: zone,
  });
  const page = await context.newPage();

  // ---- sign up, or sign in if the fixture is already there ---------------
  await page.goto(BASE);
  const toggle = page.getByRole("button", { name: "Sign up" });
  const signUp = page.getByRole("heading", { name: "Create your account" });
  await signUp.or(toggle).waitFor();
  if (await toggle.isVisible()) await toggle.click();
  await signUp.waitFor();
  await page.getByLabel("Your name").fill(DEMO_PERSON.name);
  await page.getByLabel("Email address").fill(DEMO_PERSON.email);
  await page.getByLabel(/^Password/).fill(DEMO_PERSON.password);
  await page.getByLabel(/^Confirm password/).fill(DEMO_PERSON.password);
  await page.getByRole("button", { name: "Create account" }).click();

  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const taken = page.getByText(/already/i);
  await nav.or(taken).waitFor({ timeout: 30_000 });
  if (!(await nav.isVisible())) {
    // The identity is fixed because it is visible in the sidebar of every
    // shot, so a re-run meets an account that already exists.
    await page.goto(BASE);
    await page
      .getByRole("button", { name: /Sign in/i })
      .first()
      .waitFor();
    await page.getByLabel("Email address").fill(DEMO_PERSON.email);
    await page.getByLabel(/^Password/).fill(DEMO_PERSON.password);
    await page.getByRole("button", { name: /^Sign in$/i }).click();
    await nav.waitFor({ timeout: 30_000 });
  }

  // ---- the demo ledger -------------------------------------------------
  // One move, from the page so it carries the session. A second run on the
  // same day replays the first under the same idempotency key; a run on a
  // later day passes over every entry already there by its origin and leaves
  // them on their old dates, which is why the skill's runbook starts from a
  // fresh database every time.
  const moved = await page.evaluate(
    async (body) => {
      const res = await fetch("/api/v1/ledger-file:move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    },
    demoLedgerMove({ today: iso(today) }),
  );
  if (!moved.ok) {
    // On a deployment that sells a plan, the usual one is the free plan's
    // three places against the ledger's four accounts; the skill has the fix.
    throw new Error(`The demo ledger was refused (${moved.status}): ${moved.text}`);
  }
  const result = JSON.parse(moved.text);
  console.log(
    `demo ledger: ${result.written.entries} transactions, ${result.written.deleted} deleted, ` +
      `${result.skipped.entries} already there, ${result.staged} staged, ` +
      `${result.balances.checked} balances checked`,
  );

  // ---- photograph every screen ------------------------------------------
  await page.goto(BASE);
  await nav.waitFor();
  const routes = await nav
    .locator("a")
    .evaluateAll((links) =>
      links.map((a) => a.getAttribute("href") ?? "").filter((href) => href.startsWith("/")),
    );

  /*
   * The plan tab is reached from Settings rather than from the navigation, so
   * walking the nav never finds it — which is why the kit has never carried a
   * picture of the one screen that says what the paid plan costs, and why the
   * site's roadmap lists that screenshot as waiting on this repository.
   *
   * Only where the deployment being photographed actually sells something.
   * Where it does not, the tab is a heading and a sentence saying so, and a
   * picture of that advertises the opposite of what it is for. `sells` asks
   * the deployment rather than reading a setting, because whether the tab has
   * anything on it is the server's answer, not an environment variable's.
   */
  const sells = await page.evaluate(async () => {
    const res = await fetch("/api/auth/methods");
    return res.ok ? ((await res.json()).billingAvailable ?? false) : false;
  });
  if (sells) routes.push("/settings/plan");
  else console.log("no Stripe on this deployment, so no plan tab to photograph");

  const slug = (route) =>
    route === "/" ? "dashboard" : route.replace(/^\//, "").replace(/\//g, "-");
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
    throw new Error(
      `features.json names screenshots that were not captured: ${missing.join(", ")}`,
    );
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
