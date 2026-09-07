// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Alert } from "../src/client/components.js";

/**
 * Where focus is, at the four moments `web.md` 13.3 called the largest hole in
 * that section.
 *
 * Each of the four was the same defect wearing different clothes: something
 * moved or vanished and focus was left wherever it had been, so the next Tab
 * started from the top of the document. On a page whose first eleven stops are
 * navigation links, that is the difference between carrying on and starting
 * again.
 *
 * Three of the four are read from the source rather than rendered. The app
 * shell needs a session, a router, a query client and a timezone provider to
 * mount, and the properties under test — that a skip link exists and is first,
 * that the column behind the drawer goes inert, that navigation moves focus —
 * are structural. The fourth is behaviour and is rendered.
 */
// Rendered tests share one document, and this suite renders two alerts with
// the same role. Nothing in `vitest.config.ts` cleans up between cases.
afterEach(cleanup);

const APP = readFileSync("src/client/App.tsx", "utf8");
const CSS = readFileSync("src/client/styles.css", "utf8");

describe("the skip link", () => {
  it("is the first thing in the shell and points at the main region", () => {
    const shell = APP.slice(APP.indexOf('<div className="app-shell">'));
    const skip = shell.indexOf("skip-link");
    const sidebar = shell.indexOf("className={`sidebar");
    expect(skip, "there is a skip link").toBeGreaterThan(-1);
    // Before the sidebar, which is the whole point: a keyboard user meets it
    // before the eleven navigation links rather than after them.
    expect(skip).toBeLessThan(sidebar);
    expect(shell).toContain('href="#main"');
  });

  it("lands somewhere that can hold focus", () => {
    // `<main>` is not focusable on its own, so a fragment jump to it moves the
    // browser's scroll and leaves focus behind — which is the failure mode that
    // makes a skip link look like it works and not work.
    const main = /<main className="content"([^>]*)>/.exec(APP);
    expect(main, "the shell has a main region").not.toBeNull();
    expect(main![1]).toContain('id="main"');
    expect(main![1]).toContain("tabIndex={-1}");
  });

  it("is invisible until it is focused, and then is not", () => {
    const rule = CSS.slice(CSS.indexOf(".skip-link {"));
    const block = rule.slice(0, rule.indexOf("}"));
    expect(block).toContain("position: fixed");
    // Off-screen by transform rather than by `display: none` or `width: 1px`:
    // it has to be focusable to be reachable, and a zero-size box is a focus
    // ring nobody can see.
    expect(block).toMatch(/transform:\s*translateY\(-/);
    expect(rule).toContain(".skip-link:focus-visible");
  });
});

describe("a route change", () => {
  it("moves focus and resets scroll, and only when the path changes", () => {
    const effect = APP.slice(APP.indexOf("const previousPath = useRef"));
    const body = effect.slice(0, effect.indexOf("}, ["));
    expect(body).toContain("window.scrollTo");
    expect(body).toContain("main.current?.focus()");
    // Keyed on the pathname alone. Every filter, sort and page change rewrites
    // the query string, and moving focus on those would take it out of the
    // control somebody is still typing in.
    expect(effect).toContain("}, [location.pathname]);");
    // And not on the first render, or loading the app steals focus from
    // wherever the browser put it.
    expect(body).toContain("if (previousPath.current === location.pathname) return;");
  });
});

describe("the mobile drawer", () => {
  it("takes the column behind it out of the tab order", () => {
    // The defect: Tab walked the page behind the scrim, because an `<aside>`
    // with an `.open` class is not a dialog and nothing said otherwise.
    expect(APP).toContain('<div className="main-column" inert={mobileNav}>');
  });

  it("announces itself as a modal only while it is one", () => {
    // The same element is the permanent sidebar above 780px. Marking a visible
    // navigation landmark as a modal dialog would be worse than saying nothing.
    const aside = APP.slice(APP.indexOf("className={`sidebar"));
    expect(aside.slice(0, 400)).toContain('role: "dialog"');
    expect(aside.slice(0, 400)).toContain('"aria-modal": true');
    expect(aside.slice(0, 400)).toContain("mobileNav");
  });

  it("closes when the window stops being narrow", () => {
    // Otherwise opening the drawer and then widening the window leaves a scrim
    // over a page, and the sidebar claiming to be a modal.
    expect(APP).toContain('window.matchMedia("(max-width: 780px)")');
  });

  it("moves focus in on open, back on close, and closes on Escape", () => {
    // The three things a native `<dialog>` gives for nothing and this cannot
    // inherit, because it is a dialog for one breakpoint only.
    expect(APP).toContain("drawerClose.current?.focus()");
    expect(APP).toContain("hamburger.current?.focus()");
    expect(APP).toMatch(/if \(event\.key === "Escape"\) setMobileNav\(false\)/);
  });
});

/**
 * And the one that is behaviour: where focus goes when the button goes.
 *
 * A bulk action's button lives in the selection bar, and finishing the work
 * unmounts the bar. Focus fell to `<body>`, so the next Tab started at the top
 * of the document — past the skip link and the whole sidebar — to get back to a
 * list somebody was in the middle of.
 */
describe("an alert that reports a finished action", () => {
  it("takes focus when asked, so the next Tab starts from the outcome", () => {
    render(
      <Alert kind="success" takeFocus>
        Deleted 4 transactions.
      </Alert>,
    );
    const alert = screen.getByRole("status");
    expect(document.activeElement).toBe(alert);
    expect(alert.getAttribute("tabindex")).toBe("-1");
  });

  it("leaves focus alone otherwise", () => {
    // Most alerts render beside a control that still exists, and moving focus
    // off it would be the defect rather than the fix.
    render(
      <>
        <button type="button">Somewhere else</button>
        <Alert kind="info">Nothing happened.</Alert>
      </>,
    );
    const button = screen.getByRole("button");
    button.focus();
    fireEvent.focus(button);
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("status").getAttribute("tabindex")).toBeNull();
  });

  it("is asked for on each of the three bulk surfaces", () => {
    // The three pages that unmount their own button. Named rather than counted,
    // so a fourth is a decision.
    for (const path of [
      "src/client/TransactionBrowser.tsx",
      "src/client/pages/StagingPage.tsx",
      "src/client/pages/TemplatesPage.tsx",
    ]) {
      expect(readFileSync(path, "utf8"), path).toMatch(/<Alert[^>]*\s+takeFocus/);
    }
  });
});
