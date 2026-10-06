// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { Alert, Button, MergePanel, Modal, SelectionBar } from "../src/client/components.js";

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
 * are structural. The fourth is behavior and is rendered.
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
 * And the one that is behavior: where focus goes when the button goes.
 *
 * A bulk action's button lives in the selection bar, and finishing the work
 * unmounts the bar. Focus fell to `<body>`, so the next Tab started at the top
 * of the document — past the skip link and the whole sidebar — to get back to a
 * list somebody was in the middle of.
 */
/**
 * "Clear selection" empties the selection, which unmounts the bar or panel the
 * button sits in, so focus fell to `<body>` on all five surfaces that have one
 * (`web.md` 13.3). Both components send it back to where the selection is
 * made, the element marked `data-selection-home`.
 */
describe("a selection's own way out", () => {
  function Surface({ panel }: { panel: boolean }) {
    const [selected, setSelected] = useState(true);
    const clear = (
      <Button type="button" onClick={() => setSelected(false)}>
        Clear selection
      </Button>
    );
    return (
      <>
        <input type="checkbox" aria-label="Select all" data-selection-home />
        {selected ? (
          panel ? (
            <MergePanel>{clear}</MergePanel>
          ) : (
            <SelectionBar summary="2 selected">{clear}</SelectionBar>
          )
        ) : null}
      </>
    );
  }

  it.each([
    ["a selection bar", false],
    ["a merge panel", true],
  ])("returns focus to where the selection is made, from %s", (_name, panel) => {
    render(<Surface panel={panel} />);
    const clear = screen.getByRole("button", { name: "Clear selection" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Select all" }));
  });

  it("has somewhere to go on every page that renders one", () => {
    const pages = readdirSync("src/client", { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => ({ name, code: readFileSync(`src/client/${name}`, "utf8") }))
      .filter(({ code }) => /<(SelectionBar|MergePanel)\b/.test(code));
    // The register, the staged queue, templates and both merge panels.
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(
      pages.filter(({ code }) => !code.includes("data-selection-home")).map(({ name }) => name),
    ).toEqual([]);
  });
});

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

  /**
   * When the work was confirmed in a dialog, the dialog is still open as the
   * sentence mounts, and closing it hands focus back to the button that opened
   * it — which the work removed. The sentence takes focus again on the dialog's
   * `close`. Found by the 0.2.0 sandbox smoke test on a bulk edit's "N
   * transactions updated."; `tests/browser/smoke-test-fixes.spec.ts` holds it
   * in a real browser, where the open dialog makes the page behind it inert.
   */
  it("takes focus again once the dialog it was confirmed in has closed", () => {
    const view = (open: boolean) => (
      <>
        <Modal open={open} title="Edit selected" onClose={() => {}}>
          <button type="button">Apply changes</button>
        </Modal>
        <Alert kind="success" takeFocus>
          2 transactions updated.
        </Alert>
      </>
    );
    const { rerender } = render(view(true));
    // What the open dialog does in a browser: focus stays inside it.
    act(() => screen.getByRole("button", { name: "Apply changes", hidden: true }).focus());
    rerender(view(false));
    expect(document.activeElement).toBe(screen.getByRole("status"));
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

  /**
   * Asked of every surface of this shape the product has, and not of a list.
   *
   * The check that stood here named three files and said "named rather than
   * counted, so a fourth is a decision". Four more arrived without one:
   * Categories, Payees, Accounts and the plan tab all grew a control whose own
   * success removes it, and this went on asking about three. That is `web.md`
   * 17.2's opening failure — a check that derives its population from a list
   * somebody maintains rather than from the product — and it is the one 13.3
   * was rewritten about, because stating the rule as a count of pages is what
   * let the first three ship.
   *
   * So the population is derived from the two shapes the product uses for "a
   * control whose own success removes the control": a `<SelectionBar>`, which
   * unmounts when the selection it reports empties, and a panel gated on two or
   * more selected rows, which is how both merge panels are drawn. Counted per
   * surface rather than per file, so a page with two of them cannot pass on one
   * `takeFocus`.
   *
   * A focus-returning ref satisfies it too: moving focus back to the control
   * that opened the thing is the other right answer, and the drawer above uses
   * it.
   */
  it("is asked for on every surface whose own success removes it", () => {
    const client = "src/client";
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".tsx")) files.push(path);
      }
    };
    walk(client);
    expect(files.length, "no client component was read").toBeGreaterThan(10);

    let surfaces = 0;
    const uncovered: string[] = [];
    for (const path of files) {
      const code = readFileSync(path, "utf8");
      const bars = code.match(/<SelectionBar\b/g)?.length ?? 0;
      const panels =
        code.match(/\{\s*[A-Za-z_$][\w$.]*\.(?:length|size)\s*>=?\s*2\s*\?\s*\(/g)?.length ?? 0;
      const needed = bars + panels;
      if (needed === 0) continue;
      surfaces += needed;
      const answers =
        (code.match(/<Alert[^>]*\s+takeFocus/gs)?.length ?? 0) +
        (code.match(/\.current\?\.focus\(\)/g)?.length ?? 0);
      if (answers < needed) {
        uncovered.push(`${path}: ${needed} self-removing surface(s), ${answers} focus answer(s)`);
      }
    }
    // An empty population passes every claim made over it, and this one is
    // derived, so a rename of `SelectionBar` would empty it silently.
    expect(surfaces, "no self-removing surface was found, so nothing was asked").toBeGreaterThan(4);
    expect(
      uncovered,
      "give this surface a takeFocus Alert or return focus to the control that opened it",
    ).toEqual([]);
  });
});
