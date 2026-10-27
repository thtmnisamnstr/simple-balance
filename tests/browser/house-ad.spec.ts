import { expect, test, type Browser, type Page } from "@playwright/test";
import { PLAN_LABELS } from "../../src/shared/domain.js";
import { answerHouseAd, answerPlanStatus } from "./support/routes.js";

/**
 * The house ad, laid out by a browser.
 *
 * It is a bar pinned to the foot of the window, and nothing about pinning is
 * visible to jsdom: whether it stays on screen over a long page and comes to
 * rest below the content at the end, whether it sits on the window's foot when
 * the page is short, whether a control tabbed to near the bottom is scrolled
 * clear of it, and whether the column made into a flex column for it moved
 * anything on a page that does not have it. `reflow.spec.ts` and
 * `target-size.spec.ts` measure it on every page as part of the shell; this
 * measures the bar itself.
 */

const person = {
  email: `house-ad-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "House Ad",
};

/** The same sign-up the other browser specs do, and for the reason they give. */
async function signUp(page: Page) {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Sign up" });
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

/** A second window for the same person, signed in through the form. */
async function signedIn(
  browser: Browser,
  options: { width: number; height: number; reducedMotion?: "reduce"; houseAd?: boolean },
) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
  });
  const page = await context.newPage();
  await answerPlanStatus(page);
  if (options.houseAd !== false) await answerHouseAd(page);
  await page.goto("/");
  await page.getByLabel("Email address").fill(person.email);
  await page.getByLabel(/^Password/).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  return { context, page };
}

/** A frame, so a resize or a scroll has been laid out before it is measured. */
const frame = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

/** Where the bar is, against the window and against the page above it. */
const placement = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".house-ad")!.getBoundingClientRect();
    const content = document.querySelector(".content")!.getBoundingClientRect();
    return {
      top: bar.top,
      bottom: bar.bottom,
      contentBottom: content.bottom,
      window: innerHeight,
      scrollable: document.documentElement.scrollHeight - innerHeight,
    };
  });

/**
 * The widths the bar changes shape at, and the floor: 1440 the desktop it was
 * drawn at; 1051 and 1050 either side of the step where the title and the
 * drawing go down a size; 820 and 781 where the drawing has to drop tiles,
 * 781 being the most cramped it ever is beside the sidebar; 780 where the
 * gutter narrows; 561 and 560 either side of the phone bar; 390 a phone; 320
 * the width SC 1.4.10 names.
 */
const WIDTHS = [1440, 1051, 1050, 820, 781, 780, 561, 560, 390, 320] as const;

test.describe.configure({ mode: "serial" });

test.describe("the house ad", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await answerPlanStatus(page);
    await answerHouseAd(page);
    await signUp(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  /**
   * Over a long page it stays on the window's foot while there is page below
   * it, and once there is none it rests in its own place after the content,
   * covering nothing. A short window makes Settings long enough to scroll.
   */
  test("stays pinned while the page scrolls, and rests below the content at its end", async () => {
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    let at = await placement(page);
    expect(at.scrollable, "Settings scrolls in a 500px window").toBeGreaterThan(300);

    await page.evaluate(() =>
      window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2),
    );
    await frame(page);
    at = await placement(page);
    expect(Math.abs(at.bottom - at.window), "on the window's foot mid-scroll").toBeLessThanOrEqual(
      1,
    );
    expect(at.top, "with the page passing under it").toBeLessThan(at.contentBottom);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await frame(page);
    at = await placement(page);
    expect(Math.abs(at.bottom - at.window), "still on the foot at the end").toBeLessThanOrEqual(1);
    expect(at.top, "below the last of the content").toBeGreaterThanOrEqual(at.contentBottom - 0.5);
  });

  /** Not halfway up the screen under a page that ends early. */
  test("sits on the window's foot under a short page", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/recurrences");
    await page.waitForLoadState("networkidle");
    await frame(page);
    const at = await placement(page);
    expect(at.scrollable, "the page does not scroll").toBeLessThanOrEqual(0);
    expect(at.contentBottom, "and ends well above the window's foot").toBeLessThan(at.top - 100);
    expect(Math.abs(at.bottom - at.window), "the bar is on the foot").toBeLessThanOrEqual(1);
  });

  /**
   * A window short as well as narrow, which is a phone on its side and a
   * screen zoomed to 400%, would have the bar pinned under the sticky header,
   * and the two together left a sliver of ledger between them. So it is not
   * pinned there: mid-scroll the header is all that stays, and at the end the
   * bar rests below the content as it does anywhere. 320 by 256 is a 1280 by
   * 1024 screen at 400%; a portrait phone and a short desktop window, which
   * has no header to stack with, stay pinned.
   */
  test("is not pinned where the window is short as well as narrow", async () => {
    const position = () =>
      page.evaluate(() => getComputedStyle(document.querySelector(".ad-slot")!).position);
    for (const [width, height] of [
      [320, 256],
      [667, 375],
    ] as const) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto("/settings");
      await page.waitForLoadState("networkidle");
      expect(await position(), at).toBe("static");
      await page.evaluate(() =>
        window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) / 2),
      );
      await frame(page);
      const covered = await page.evaluate(() => {
        const bar = document.querySelector(".house-ad")!.getBoundingClientRect();
        const header = document.querySelector(".mobile-header")!.getBoundingClientRect();
        const barOnScreen = Math.max(0, Math.min(innerHeight, bar.bottom) - Math.max(0, bar.top));
        return (barOnScreen + header.height) / innerHeight;
      });
      expect(covered, `${at}: the window kept by what stays on screen`).toBeLessThanOrEqual(0.25);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await frame(page);
      const end = await placement(page);
      expect(
        Math.abs(end.bottom - end.window),
        `${at}: on the foot at the end`,
      ).toBeLessThanOrEqual(1);
      expect(end.top, `${at}: below the content`).toBeGreaterThanOrEqual(end.contentBottom - 0.5);
    }
    for (const [width, height] of [
      [390, 844],
      [781, 400],
    ] as const) {
      await page.setViewportSize({ width, height });
      await frame(page);
      expect(await position(), `${width}x${height}`).toBe("sticky");
    }
  });

  test("fits at every width it changes shape at, in line with the page", async () => {
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("complementary", { name: "Advertisement" })).toBeVisible();
    const problems: string[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await frame(page);
      const measured = await page.evaluate(() => {
        const box = (element: Element) => element.getBoundingClientRect();
        const content = document.querySelector(".content")!;
        const gutter = Number.parseFloat(getComputedStyle(content).paddingLeft);
        const art = document.querySelector(".house-ad-art")!;
        const strip = document.querySelector(".house-ad-strip")!;
        const visible = (element: Element) => {
          const own = box(element);
          const clip = box(strip);
          return own.left >= clip.left - 0.5 && own.right <= clip.right + 0.5;
        };
        return {
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          contentLeft: box(content).left + gutter,
          contentRight: box(content).right - gutter,
          bar: box(document.querySelector(".house-ad")!),
          words: box(document.querySelector(".house-ad-words")!),
          cta: box(document.querySelector(".house-ad-cta")!),
          drawn: getComputedStyle(art).display !== "none",
          // A tile is drawn as a frosted square; its height is its size on screen.
          tiles: [...document.querySelectorAll(".house-ad-account > .house-ad-veil")].map(
            (tile) => box(tile).height,
          ),
          ending: [...document.querySelectorAll(".house-ad-arrive-second, .house-ad-badge")].map(
            visible,
          ),
          // The ad's own, and not the sidebar's transition at 780px.
          animations: document.getAnimations().filter((one) => {
            const target = (one.effect as KeyframeEffect | null)?.target;
            return target instanceof Element && target.closest(".house-ad") !== null;
          }).length,
        };
      });
      const at = `${width}px`;
      if (measured.document > 0)
        problems.push(`${at}: the document is ${measured.document}px wide`);
      // The words start and the button ends on the page's own content edges.
      if (Math.abs(measured.words.left - measured.contentLeft) > 1) {
        problems.push(
          `${at}: the words start at ${measured.words.left}, the page at ${measured.contentLeft}`,
        );
      }
      if (Math.abs(measured.cta.right - measured.contentRight) > 1) {
        problems.push(
          `${at}: the button ends at ${measured.cta.right}, the page at ${measured.contentRight}`,
        );
      }
      if (measured.cta.width < 24 || measured.cta.height < 24) {
        problems.push(`${at}: the button is ${measured.cta.width}x${measured.cta.height}`);
      }
      if (measured.cta.bottom > measured.bar.bottom || measured.cta.top < measured.bar.top) {
        problems.push(`${at}: the button runs past the bar`);
      }
      if (width > 560) {
        // As tall as the design allows above a phone, whatever the title does.
        if (measured.bar.height > 72.5)
          problems.push(`${at}: the bar is ${measured.bar.height}px tall`);
        if (!measured.drawn) problems.push(`${at}: the drawing is missing`);
        // Tiles are dropped where there is no room, never shrunk past reading.
        const smallest = Math.min(...measured.tiles);
        if (smallest < 29.5) problems.push(`${at}: a tile is ${smallest}px`);
        // The story ends at the end the strip keeps: the last arrival and its
        // badge are never what is cut.
        if (!measured.ending.every(Boolean)) problems.push(`${at}: the badge's tile is cut off`);
      } else {
        // Words and the button, at most three lines of words at the floor.
        const ceiling = width >= 390 ? 61 : 80;
        if (measured.bar.height > ceiling)
          problems.push(`${at}: the bar is ${measured.bar.height}px tall`);
        if (measured.drawn) problems.push(`${at}: a phone is shown the drawing`);
        // Nothing runs where nothing is drawn.
        if (measured.animations > 0)
          problems.push(`${at}: ${measured.animations} animations run unseen`);
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * SC 2.4.11, measured the hard way. Focusing an element scrolls it to the
   * middle of the window when it is off screen, which would pass whatever the
   * bar did, so each control is first parked just under the bar's top edge,
   * where it is on screen and covered; the one before it takes focus without
   * scrolling; and Tab moves focus on, which is when the browser decides
   * whether to scroll. It has to end above the bar.
   */
  test("never leaves a control it tabs to under the bar", async () => {
    // A short window, so most of each page can be scrolled under the bar.
    await page.setViewportSize({ width: 1440, height: 450 });
    let tested = 0;
    const covered: string[] = [];
    for (const path of ["/settings", "/accounts"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const found = await tabUnderTheBar(page);
      tested += found.tested;
      covered.push(...found.covered.map((one) => `${path}: ${one}`));
    }
    expect(tested, "controls parked under the bar").toBeGreaterThanOrEqual(6);
    expect(covered).toEqual([]);
  });

  /**
   * And when the bar is taller than its design, because its title wraps to
   * more lines on a phone or a reader widens the spacing of text (SC 1.4.12).
   * The room it keeps is measured from the bar, so it grows with it.
   */
  test("keeps the room it leaves in step with its height", async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    });
    const kept = () =>
      page.evaluate(() => ({
        height: Math.ceil(document.querySelector(".house-ad")!.getBoundingClientRect().height),
        padding: Number.parseFloat(document.documentElement.style.scrollPaddingBottom),
      }));
    await expect
      .poll(async () => {
        const { height, padding } = await kept();
        return padding - height;
      }, "the room kept follows the bar")
      .toBe(16);
    expect((await kept()).height, "the spacing made the bar taller").toBeGreaterThan(80);
    const { tested, covered } = await tabUnderTheBar(page);
    expect(tested).toBeGreaterThan(5);
    expect(covered).toEqual([]);
  });

  /**
   * Pinned to the window it is in view from the first frame, so it plays once
   * per document load, and is still within three seconds.
   */
  test("plays once on arrival, and is at rest within three seconds", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/accounts");
    const box = page.locator(".house-ad");
    await expect(box).toHaveClass(/\bis-armed\b/);
    await expect(box).toHaveClass(/\bis-playing\b/);
    const timing = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((one) => (one.effect as KeyframeEffect | null)?.target?.closest(".house-ad"))
        .map((one) => {
          const computed = one.effect!.getComputedTiming();
          return { end: Number(computed.endTime), iterations: computed.iterations };
        }),
    );
    expect(timing, "six beats").toHaveLength(6);
    expect(
      timing.every((one) => one.iterations === 1),
      "every beat runs once",
    ).toBe(true);
    expect(Math.max(...timing.map((one) => one.end)), "at rest by three seconds").toBeLessThan(
      3000,
    );
    // Running, not present: a finished animation that fills both ways is still
    // in effect, and still listed.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.getAnimations().filter((one) => one.playState === "running").length,
          ),
        { timeout: 5000 },
      )
      .toBe(0);
  });

  /**
   * Once per document load, and not once per showing. Hiding an element
   * discards its animations and showing it again starts them over, so the
   * story retires itself on its last beat. Crossing the phone width hides the
   * drawing and shows it again, which is a window narrowed and widened, a
   * phone turned, or a page zoomed; turning reduced motion on and off again
   * is the other way back in. And a story cut short comes back finished.
   */
  test("does not start over when the drawing is hidden and shown again", async () => {
    const box = page.locator(".house-ad");
    const present = (started = false) =>
      page.evaluate(
        (started) =>
          document
            .getAnimations()
            .filter((one) => (one.effect as KeyframeEffect | null)?.target?.closest(".house-ad"))
            .filter((one) => !started || !one.pending).length,
        started,
      );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/accounts");
    await expect(box).toHaveClass(/\bis-playing\b/);
    await expect(box, "the finished picture once it ends").toHaveAttribute("class", "house-ad", {
      timeout: 5000,
    });
    for (const width of [500, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await frame(page);
    }
    expect(await present(), "after the phone width and back").toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await frame(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await frame(page);
    expect(await present(), "after reduced motion on and off").toBe(0);
    await page.emulateMedia({ reducedMotion: null });

    // Cut short: the cancel arrives as an event a frame later, so it is waited
    // for while the drawing is hidden, and then it comes back finished. Hidden
    // only once the beats have started, since a drawing hidden before they
    // start has nothing to cancel, which is a phone's case and not this one.
    // Started rather than present: a beat is listed while it is still pending,
    // the frame before its clock starts, and Chromium sends no cancel for one
    // hidden then. Polling for six present hid the drawing in that frame about
    // one run in twenty, which left this waiting on a cancel that never came.
    await page.goto("/accounts");
    await expect(box).toHaveClass(/\bis-playing\b/);
    await expect.poll(() => present(true), "the story under way").toBe(6);
    await page.setViewportSize({ width: 500, height: 900 });
    await expect(box, "retired while hidden").toHaveAttribute("class", "house-ad");
    await page.setViewportSize({ width: 1440, height: 900 });
    await frame(page);
    expect(await box.getAttribute("class"), "and back finished").toBe("house-ad");
    expect(await present()).toBe(0);
  });

  /**
   * The button enters the plan tab by loading it, because the tab is served
   * under its own content security policy. A marker on `window` survives a
   * client-side push and does not survive a load. The tab has no bar, and
   * keeps none of the room the bar left.
   */
  test("leads to the plan tab by loading the document, where it is not shown", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/accounts");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      (window as unknown as { marker?: boolean }).marker = true;
    });
    await page.getByRole("link", { name: `Upgrade to ${PLAN_LABELS.plus}` }).click();
    await expect(page).toHaveURL(/\/settings\/plan$/);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { marker?: boolean }).marker),
      "a document load, not a push",
    ).toBeUndefined();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("complementary", { name: "Advertisement" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.style.scrollPaddingBottom)).toBe("");
  });
});

/**
 * Park each control in `<main>` just under the bar's top edge, focus the one
 * before it without scrolling, press Tab, and report every control focus lands
 * on that ends up under the bar.
 */
async function tabUnderTheBar(page: Page) {
  const CONTROLS = "a[href], button:not(:disabled), input:not([type=hidden]), select, textarea";
  const count = await page.evaluate(
    (selector) => document.querySelectorAll(`main :is(${selector})`).length,
    CONTROLS,
  );
  let tested = 0;
  const covered: string[] = [];
  for (let index = 1; index < count; index += 1) {
    const parked = await page.evaluate(
      ({ selector, index }) => {
        const controls = [...document.querySelectorAll<HTMLElement>(`main :is(${selector})`)];
        const control = controls[index]!;
        const before = controls[index - 1]!;
        if (control.getClientRects().length === 0 || before.getClientRects().length === 0)
          return false;
        const bar = document.querySelector(".house-ad")!;
        window.scrollBy(
          0,
          control.getBoundingClientRect().top - (bar.getBoundingClientRect().top + 10),
        );
        const top = bar.getBoundingClientRect().top;
        const own = control.getBoundingClientRect();
        // The end of the page, where nothing can be scrolled under the bar.
        if (own.top < top || own.top > innerHeight) return false;
        before.focus({ preventScroll: true });
        return document.activeElement === before;
      },
      { selector: CONTROLS, index },
    );
    if (!parked) continue;
    await page.keyboard.press("Tab");
    await frame(page);
    const landed = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || !active.closest("main")) return null;
      const own = active.getBoundingClientRect();
      const bar = document.querySelector(".house-ad")!.getBoundingClientRect();
      return {
        name: `${active.tagName.toLowerCase()} "${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 40)}"`,
        overlap: own.bottom - bar.top,
      };
    });
    if (!landed) continue;
    tested += 1;
    if (landed.overlap > 0.5) covered.push(`${landed.name} is ${landed.overlap}px under the bar`);
  }
  return { tested, covered };
}

test("is the finished picture under reduced motion, and never armed", async ({ browser }) => {
  const { context, page } = await signedIn(browser, {
    width: 1440,
    height: 900,
    reducedMotion: "reduce",
  });
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const box = page.locator(".house-ad");
  await expect(box).toBeVisible();
  expect(await box.getAttribute("class")).toBe("house-ad");
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await context.close();
});

/** The text spacing SC 1.4.12 says a page has to survive, as a reader's stylesheet. */
const TEXT_SPACING =
  "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

type Clip = { x: number; y: number; width: number; height: number };

/**
 * Frames until the bar stops moving after a resize. A step in the stylesheet
 * can land a frame after the window's new width does, so the first frame is
 * sometimes the old layout, and a region measured there is not the region the
 * screenshot then takes.
 */
async function settled(page: Page) {
  let last = "";
  for (let tries = 0; tries < 10; tries += 1) {
    await frame(page);
    const now = await page.evaluate(() =>
      JSON.stringify(
        [".house-ad-words", ".house-ad-art", ".house-ad-strip", ".house-ad-cta"].map((selector) =>
          document.querySelector(selector)!.getBoundingClientRect(),
        ),
      ),
    );
    if (now === last) return;
    last = now;
  }
}

/** The red, green, blue and alpha of every pixel in each shot, decoded by the page itself. */
function decoded(page: Page, shots: Buffer[]) {
  return page.evaluate(
    (pngs) =>
      Promise.all(
        pngs.map(async (png) => {
          const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          return [...context.getImageData(0, 0, bitmap.width, bitmap.height).data];
        }),
      ),
    shots.map((shot) => shot.toString("base64")),
  );
}

/** The largest step in any channel between two shots of one size, less the pixels `skip` names. */
function largestStep(one: number[], other: number[], skip?: (pixel: number) => boolean) {
  let largest = 0;
  for (let pixel = 0; pixel < one.length / 4; pixel += 1) {
    if (skip?.(pixel)) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = pixel * 4 + channel;
      largest = Math.max(largest, Math.abs(one[index]! - other[index]!));
    }
  }
  return largest;
}

/**
 * How far a region's pixels move when a style is added: painted, painted again
 * with the style, and the largest step between the two. Not byte equality,
 * because the compositor rasterizes the same masked drawing a level or four
 * apart from one paint to the next; anything a mask actually does to a tile
 * is ten levels and more.
 */
async function change(page: Page, clip: Clip, style: string) {
  const before = await page.screenshot({ clip, animations: "disabled" });
  const tag = await page.addStyleTag({ content: style });
  await frame(page);
  const after = await page.screenshot({ clip, animations: "disabled" });
  await tag.evaluate((element) => (element as Element).remove());
  await frame(page);
  const [one, other] = await decoded(page, [before, after]);
  return largestStep(one!, other!);
}

/** A level or four is the compositor's; a mask at work is more. */
const NOISE = 8;

/**
 * The strip drops tiles where the bar is too narrow for the row, and drops
 * them whole. A fade at its edge narrower than a tile left a cut one's
 * rounded edge and veil showing beside the struck-out ad, and one wide enough
 * to hide that dimmed the next tile too. So a tile the strip's edge falls
 * across paints nothing at all, and the first whole tile after it paints
 * exactly what it would with no mask. The same holds where widened text
 * spacing leaves no room even for the badge's tile, which shows nothing
 * rather than a fragment — and there the title keeps to two lines clear of
 * the drawing, the drawing giving way rather than the words.
 *
 * Read as pixels, because that is the whole claim: each region is shot twice,
 * once as it is and once with the tiles hidden or the mask made clear, and the
 * two have to be the same to within the compositor's own noise.
 */
test("drops whole tiles where it narrows, never a part of one", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await signedIn(browser, {
    width: 1440,
    height: 600,
    reducedMotion: "reduce",
  });
  await page.goto("/accounts");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".house-ad")).toBeVisible();
  const HIDDEN =
    ".house-ad-strip .house-ad-account, .house-ad-strip .house-ad-badge { visibility: hidden !important; }";
  // A mask that hides nothing rather than no mask: an element with a mask is
  // painted in a layer of its own, and lifting it changes the anti-aliasing of
  // every edge in the drawing whatever the mask did.
  const UNMASKED = ".house-ad-strip { mask-image: linear-gradient(black, black) !important; }";
  const span = (from: number, to: number, step: number) =>
    Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);
  const problems: string[] = [];
  let cut = 0;
  let whole = 0;
  for (const spaced of [false, true]) {
    const tag = spaced ? await page.addStyleTag({ content: TEXT_SPACING }) : null;
    const widths = spaced
      ? [...span(1051, 1100, 7), ...span(781, 900, 7), ...span(561, 600, 7)]
      : [...span(781, 905, 4), ...span(561, 605, 4)];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 600 });
      await settled(page);
      const at = `${width}px${spaced ? " with text spacing" : ""}`;
      const measured = await page.evaluate(() => {
        const strip = document.querySelector(".house-ad-strip")!.getBoundingClientRect();
        const title = document.querySelector(".house-ad-title")!;
        return {
          strip: { left: strip.left, right: strip.right, top: strip.top, bottom: strip.bottom },
          lines: Math.round(
            title.getBoundingClientRect().height /
              Number.parseFloat(getComputedStyle(title).lineHeight),
          ),
          // How far the title's longer half reaches past the drawing's left
          // edge: two lines bought by letting a half run under it are no use.
          under:
            Math.max(
              ...[...title.querySelectorAll(".house-ad-half")].map(
                (half) => half.getBoundingClientRect().right,
              ),
            ) - document.querySelector(".house-ad-art")!.getBoundingClientRect().left,
          // Each tile's frosted square, right to left, so the first that is
          // not whole is the one the strip's edge falls across.
          tiles: [...document.querySelectorAll(".house-ad-account > .house-ad-veil")]
            .map((tile) => tile.getBoundingClientRect())
            .map(({ left, right, top, bottom }) => ({ left, right, top, bottom }))
            .reverse(),
        };
      });
      if (measured.lines > 2) problems.push(`${at}: the title is ${measured.lines} lines`);
      if (measured.under > 0.5) problems.push(`${at}: the title runs ${measured.under}px under`);
      const { strip, tiles } = measured;
      // The box of a turned tile is a little wider than the tile, so a tile
      // only just whole or only just cut is left alone rather than guessed at.
      const firstCut = tiles.findIndex((tile) => tile.left < strip.left + 0.5);
      const lastWhole = firstCut === -1 ? tiles[tiles.length - 1] : tiles[firstCut - 1];
      if (lastWhole && lastWhole.left >= strip.left + 0.5) {
        const clip = {
          x: Math.ceil(lastWhole.left + 1),
          y: Math.ceil(lastWhole.top + 1),
          width: Math.floor(lastWhole.right - 1) - Math.ceil(lastWhole.left + 1),
          height: Math.floor(lastWhole.bottom - 1) - Math.ceil(lastWhole.top + 1),
        };
        whole += 1;
        const moved = await change(page, clip, UNMASKED);
        if (moved > NOISE) problems.push(`${at}: the first whole tile is dimmed by ${moved}`);
      }
      const across = firstCut === -1 ? undefined : tiles[firstCut];
      if (across && across.left < strip.left - 1.5 && across.right > strip.left + 2) {
        // The chart's tile carries the badge, and where it is cut the strip
        // shows nothing at all, so the whole strip is what is read there.
        const last = firstCut === 0;
        const clip = {
          x: Math.ceil(strip.left),
          y: Math.ceil(strip.top),
          width: Math.floor(last ? strip.right : across.right - 1) - Math.ceil(strip.left),
          height: Math.floor(strip.bottom) - Math.ceil(strip.top),
        };
        if (clip.width > 0) {
          cut += 1;
          const moved = await change(page, clip, HIDDEN);
          if (moved > NOISE) problems.push(`${at}: part of a cut tile shows, ${moved} levels`);
        }
      }
    }
    await tag?.evaluate((element) => (element as Element).remove());
  }
  expect(problems).toEqual([]);
  // The sweep has to have met both cases, or it proved nothing.
  expect(cut, "cut tiles read").toBeGreaterThan(20);
  expect(whole, "whole tiles read").toBeGreaterThan(40);
  await context.close();
});

/**
 * The drawing's light ends at its box's edges without a step. Both glows are
 * measured from the box's right-hand edge and end exactly there, so the
 * button sits on the plain base; and the box's own left-hand end takes the
 * light down into the base, which is where beside the sidebar the box can be
 * narrower than the light. A straight seam in the light at either edge is
 * what this reads for: the column of pixels just inside each edge against
 * one just outside, a step of a few levels being the anti-aliasing of the
 * page and not a seam.
 */
test("lights the drawing with no seam at its edges", async ({ browser }) => {
  const { context, page } = await signedIn(browser, {
    width: 1440,
    height: 600,
    reducedMotion: "reduce",
  });
  await page.goto("/accounts");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".house-ad")).toBeVisible();
  const problems: string[] = [];
  for (const width of [1440, 1100, 1051, 1000, 900, 860, 820, 800, 781, 700, 600, 561]) {
    await page.setViewportSize({ width, height: 600 });
    await settled(page);
    const box = await page.evaluate(() => {
      const bar = document.querySelector(".house-ad")!.getBoundingClientRect();
      const art = document.querySelector(".house-ad-art")!.getBoundingClientRect();
      // The struck-out ad stands against the box's left-hand end; its rows are
      // left out on that side, so what is read there is only the light.
      const ad = document.querySelector(".house-ad-banner .house-ad-veil")!.getBoundingClientRect();
      return { top: bar.top, height: bar.height, left: art.left, right: art.right, ad };
    });
    // One pixel wide and the bar's height, so a pixel's index is its row.
    const column = (x: number) =>
      page.screenshot({
        clip: { x, y: Math.floor(box.top), width: 1, height: Math.floor(box.height) },
        animations: "disabled",
      });
    const [leftIn, leftOut, rightIn, rightOut] = await decoded(page, [
      await column(Math.ceil(box.left)),
      await column(Math.ceil(box.left) - 4),
      await column(Math.floor(box.right) - 1),
      await column(Math.floor(box.right) + 3),
    ]);
    const [adTop, adBottom] = [box.ad.top - box.top - 2, box.ad.bottom - box.top + 2];
    const last = Math.floor(box.height) - 1;
    // The hairline along the bar's top and its last row are the bar's, not the light's.
    const edge = (row: number) => row < 2 || row > last - 2;
    const steps = {
      left: largestStep(leftIn!, leftOut!, (row) => edge(row) || (row > adTop && row < adBottom)),
      right: largestStep(rightIn!, rightOut!, edge),
    };
    if (steps.left > 4) problems.push(`${width}px: a step of ${steps.left} at the left edge`);
    if (steps.right > 4) problems.push(`${width}px: a step of ${steps.right} at the right edge`);
  }
  expect(problems).toEqual([]);
  await context.close();
});

/**
 * The column becomes a flex column for the bar, and only while the bar is in
 * it. So a page without the bar has the block column it always had, and a page
 * with it lays its content out exactly as it would without: the same box for
 * `<main>` and for every block in it, at a desktop and a phone width.
 */
test("moves nothing on the page, and changes nothing where it is absent", async ({ browser }) => {
  const without = await signedIn(browser, { width: 1440, height: 900, houseAd: false });
  const withAd = await signedIn(browser, { width: 1440, height: 900 });
  const layout = (page: Page) =>
    page.evaluate(() => {
      const round = (rect: DOMRect) =>
        [rect.left, rect.top, rect.width, rect.height].map(Math.round);
      const main = document.querySelector("main")!;
      return {
        column: getComputedStyle(document.querySelector(".main-column")!).display,
        main: round(main.getBoundingClientRect()),
        blocks: [...main.querySelectorAll(":scope > *, :scope > * > *")].map((element) =>
          round(element.getBoundingClientRect()),
        ),
      };
    });
  const differences: string[] = [];
  for (const path of ["/", "/accounts", "/transactions", "/budgets", "/settings", "/recurrences"]) {
    for (const width of [1440, 390]) {
      const measured = [];
      for (const { page } of [without, withAd]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await frame(page);
        measured.push(await layout(page));
      }
      const [plain, advertised] = measured;
      if (plain!.column !== "block")
        differences.push(`${path} at ${width}px: the column is ${plain!.column} with no ad`);
      if (advertised!.column !== "flex")
        differences.push(`${path} at ${width}px: the column is not a flex column with the ad`);
      if (JSON.stringify(plain!.main) !== JSON.stringify(advertised!.main)) {
        differences.push(
          `${path} at ${width}px: <main> is ${plain!.main} without the ad and ${advertised!.main} with it`,
        );
      }
      if (JSON.stringify(plain!.blocks) !== JSON.stringify(advertised!.blocks)) {
        differences.push(`${path} at ${width}px: a block in <main> moved`);
      }
    }
  }
  expect(differences).toEqual([]);
  await without.context.close();
  await withAd.context.close();
});
