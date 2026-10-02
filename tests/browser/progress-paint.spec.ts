import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import sharp from "sharp";

/**
 * Whether the progress bar's fill is painted, in a browser that paints it.
 *
 * `web.md` 12.6 ends: "**Not covered:** that the bar is *painted*. jsdom has no
 * layout engine and the fill comes from vendor pseudo-elements, so only 13.5
 * could see it and nothing there does yet; it was checked by hand in Chromium
 * in both themes." It is **17.2 item 7**, moved out of 17.3 because filing it
 * as review meant the one tier built to catch it was never asked.
 *
 * Three ways the fill goes missing, every one of them leaving
 * `tests/progress-bar-ui.test.tsx` green — that test queries by role and by
 * accessible name, which is the right thing for it to do and says nothing
 * about pixels:
 *
 * - `appearance: none` turns the platform widget off, and the two
 *   `::-webkit-progress-*` rules behind it are then the only thing drawing
 *   anything. Firefox paints the track from the element and the fill from its
 *   own pseudo-element, so the stylesheet writes all three out; dropping one
 *   of the three is a one-line edit.
 * - The fill and the track resolving to the same color: a bar that is there
 *   and says nothing. A token rename does this in one theme only.
 * - `overflow: hidden` and a radius clipping the fill away.
 *
 * **Measured from the painted image, not from `getComputedStyle`.** 17.2 item
 * 7 proposes `getComputedStyle(element, "::-webkit-progress-value")`, and in
 * this Chromium that call does not resolve the pseudo-element: it returns the
 * *element's* own computed style, so it answers `--track` for the fill and
 * would pass a stylesheet with both vendor rules deleted. `::-moz-progress-bar`
 * comes back blank from the same call, which is what an unrecognized pseudo
 * does — so the webkit one is being accepted and then ignored. A screenshot of
 * the element decoded to raw pixels answers the question the rule actually
 * asks, and sees the clipping case as well, which no computed style could.
 *
 * **The markup is read out of the component**, not written here: a test that
 * hard-coded `.progress-meter` would go on passing through a rename, and a
 * renamed class with the stylesheet left behind is failure one.
 *
 * *What this cannot see:* whether a page ever renders one.
 * `tests/progress-bar-ui.test.tsx` holds that — when the bar is drawn, what it
 * says, and that it is removed rather than frozen — and nothing here repeats
 * it. The element is placed on a real page rather than reached through a real
 * commit because reaching one needs thousands of staged rows and a race with
 * the work finishing, and neither changes what is being measured: this
 * stylesheet against this browser.
 */

/** The row and meter `ProgressBar` renders, as its own source spells them. */
function markupFromSource() {
  const component = readFileSync(
    new URL("../../src/client/components.tsx", import.meta.url),
    "utf8",
  );
  const meter = /<(progress)\s+className="([^"]+)"/.exec(component);
  const row = /<div className="(progress-row[^"]*)">/.exec(component);
  if (!meter || !row) {
    throw new Error("components.tsx no longer renders a <progress> inside a progress row");
  }
  return { tag: meter[1]!, meterClass: meter[2]!, rowClass: row[1]! };
}

const markup = markupFromSource();

/** Where the bar is drawn, as a fraction of its width. */
const VALUE = 0.6;

type Painted = {
  readonly expected: { fill: string; track: string };
  readonly size: { width: number; height: number };
  readonly pixel: (x: number, y: number) => string;
};

/**
 * Put a bar on the page, photograph it, and hand back a pixel reader.
 *
 * The expected colors come from a probe element in the same document, so the
 * comparison is a painted pixel against a painted pixel: reading `--green-fill`
 * off `:root` gives `#176b4b` while a screenshot reports `rgb(23, 107, 75)`,
 * and converting between them here would be the test deciding what the token
 * means.
 */
async function paint(page: Page, theme: "light" | "dark"): Promise<Painted> {
  const expected = await page.evaluate(
    ({ markup, theme, value }) => {
      document.documentElement.setAttribute("data-theme", theme);
      const row = document.createElement("div");
      row.className = markup.rowClass;
      row.id = "progress-paint-probe";
      // Fixed and over everything, so the screenshot is of the bar rather than
      // of whatever the sign-in page happens to have scrolled under it.
      row.style.position = "fixed";
      row.style.top = "40px";
      row.style.left = "40px";
      row.style.zIndex = "99";
      const bar = document.createElement(markup.tag);
      bar.className = markup.meterClass;
      bar.id = "progress-paint-bar";
      bar.setAttribute("value", String(value));
      bar.setAttribute("max", "1");
      row.append(bar);
      document.body.append(row);
      const swatch = (token: string) => {
        const probe = document.createElement("span");
        probe.style.background = `var(${token})`;
        row.append(probe);
        const painted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return painted;
      };
      return { fill: swatch("--green-fill"), track: swatch("--track") };
    },
    { markup, theme, value: VALUE },
  );

  const shot = await page.locator("#progress-paint-bar").screenshot();
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  await page.evaluate(() => {
    document.querySelector("#progress-paint-probe")?.remove();
    document.documentElement.removeAttribute("data-theme");
  });

  return {
    expected,
    size: { width: info.width, height: info.height },
    pixel: (x, y) => {
      const at = (y * info.width + x) * info.channels;
      return `rgb(${data[at]}, ${data[at + 1]}, ${data[at + 2]})`;
    },
  };
}

test.describe("the progress bar's fill", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`is painted in ${theme}`, async ({ page }) => {
      await page.goto("/");
      // The stylesheet rather than the app: nothing here signs in, and Vite
      // serves the CSS through the module graph, so what is waited for is a
      // token from it resolving.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const probe = document.createElement("span");
            probe.style.background = "var(--green-fill)";
            document.body.append(probe);
            const value = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return value;
          }),
        )
        .not.toBe("rgba(0, 0, 0, 0)");

      const bar = await paint(page, theme);

      /**
       * The guards, before any verdict. Each assertion below compares two
       * colors, and two blanks compare equal: a token that resolved to nothing,
       * or a screenshot of a collapsed element, would pass a naive reading.
       */
      expect(bar.expected.fill).not.toBe("rgba(0, 0, 0, 0)");
      expect(bar.expected.track).not.toBe("rgba(0, 0, 0, 0)");
      expect(bar.expected.fill, "the fill and the track are the same color").not.toBe(
        bar.expected.track,
      );
      // `flex: 0 0 180px` and `height: 6px` in the stylesheet. A bar with no
      // area paints a correct color over nothing.
      expect(bar.size.width).toBe(180);
      expect(bar.size.height).toBe(6);

      const middle = Math.floor(bar.size.height / 2);
      // Well inside each region rather than near the boundary, which is
      // antialiased, and inside the 1px border and 3px radius at either end.
      const filled = Math.floor(bar.size.width * VALUE);
      expect(bar.pixel(30, middle), "the fill is not painted").toBe(bar.expected.fill);
      expect(bar.pixel(filled - 20, middle), "the fill stops short").toBe(bar.expected.fill);
      // And it is a *determinate* bar: past the value, the track shows. A solid
      // block of fill is what an indeterminate bar frozen by the reduced-motion
      // rule looks like, which is the defect 12.6's first bullet is about.
      expect(bar.pixel(filled + 20, middle), "the track is not painted past the value").toBe(
        bar.expected.track,
      );
      expect(bar.pixel(bar.size.width - 10, middle)).toBe(bar.expected.track);
    });
  }
});
