// @vitest-environment jsdom

import { globSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { PageHeader } from "../src/client/components.js";
import { APP_NAME } from "../src/shared/version.js";

afterEach(cleanup);

/**
 * The product's name, and the tab it appears in.
 *
 * `APP_NAME` is the one spelling (`src/shared/version.ts`). `index.html`
 * carries a second, because it is served before any module runs and cannot
 * import one; this holds the two together, the same way the theme-color
 * literals in that file are held to the stylesheet.
 */
describe("the product name", () => {
  it("is spelled the same in index.html, which cannot import it", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    expect(html).toContain(`<title>${APP_NAME}</title>`);
  });

  it("is not written as a literal anywhere the constant could be used", () => {
    // `index.html` is the named exception above. Anything in `src` that spells
    // the name out has stopped tracking a rename.
    const offenders: string[] = [];
    for (const file of ["src/client/App.tsx", "src/client/components.tsx", "src/server/auth.ts"]) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (withoutComments.includes(`"${APP_NAME}"`) || withoutComments.includes(`>${APP_NAME}<`)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the browser tab", () => {
  it("names the page, then the product", () => {
    render(<PageHeader title="Transactions" />);
    expect(document.title).toBe(`Transactions — ${APP_NAME}`);
  });

  it("follows the heading, so the two cannot disagree", () => {
    // The tab is set from the same prop that renders the h1. This is the
    // property that makes a router-side title table unnecessary.
    const { getByRole } = render(<PageHeader title="Budgets" eyebrow="Planning" />);
    expect(getByRole("heading", { level: 1 })).toHaveTextContent("Budgets");
    expect(document.title).toBe(`Budgets — ${APP_NAME}`);
  });

  it("updates when the page changes", () => {
    const { rerender } = render(<PageHeader title="Reports" />);
    expect(document.title).toBe(`Reports — ${APP_NAME}`);
    rerender(<PageHeader title="Settings" />);
    expect(document.title).toBe(`Settings — ${APP_NAME}`);
  });
});

/**
 * A page renders its header before it renders any of its four states.
 *
 * `web.md` 12.1 asks for four states per LIST, and nothing anywhere said the
 * four states are also states of the PAGE. So six pages wrote
 * `if (query.isPending) return <Skeleton/>` at the top of the component and
 * took the header, the eyebrow, the tab strip and the back link down with it.
 * `document.title` is set inside `PageHeader`'s effect, whose own comment is
 * that two windows of this app are otherwise indistinguishable in a task
 * switcher — so a fresh tab on `/accounts/<id>` read the bare product name
 * until the query resolved and forever if it failed. The plan tab was the
 * sharpest: its error branch dropped `SettingsTabs` as well, leaving an alert
 * saying "Reload the page to try again" on a screen that had removed its own
 * navigation.
 *
 * The three tests above render `PageHeader` directly, so nothing asked whether
 * a page reaches it. This asks the source, because the shape is structural and
 * mounting nineteen pages against failing fetches to see the same thing is a
 * day's work for an answer a parser gives in a line.
 *
 * **What it cannot see**, said here rather than left to be assumed: it reads
 * the component's FIRST JSX return and asks whether the header is in it. A
 * page that renders the header and then returns a second screen below it is
 * outside this check, and so is one whose header is reached through a name
 * this does not recognise as a header.
 */
describe("a page's header", () => {
  /** Everything between a balanced pair, counted rather than sliced. */
  const balanced = (source: string, from: number, open: string, close: string) => {
    let depth = 0;
    for (let at = from; at < source.length; at++) {
      if (source[at] === open) depth += 1;
      else if (source[at] === close) {
        depth -= 1;
        if (depth === 0) return source.slice(from, at + 1);
      }
    }
    return source.slice(from);
  };

  /**
   * The page component's own body. `export default function` on eighteen of
   * them; the plan tab exports by name, so the file's own name is the second
   * place to look.
   */
  const componentBody = (path: string, code: string) => {
    const named = `export function ${basename(path, ".tsx")}(`;
    const at = code.includes("export default function")
      ? code.indexOf("export default function")
      : code.indexOf(named);
    return at < 0 ? null : code.slice(at);
  };

  /**
   * The one page with no `PageHeader` of its own, and why.
   *
   * `TransactionsPage` is four lines: the heading belongs to
   * `TransactionBrowser`, because the export link's href is built from filter
   * state the browser owns (`web.md` 7.5). The browser is in the population
   * below in its place, so the rule is still asked of that page's header.
   */
  const DELEGATES: Record<string, string> = {
    "src/client/pages/TransactionsPage.tsx": "the header belongs to TransactionBrowser",
  };

  it("comes before every state the page can be in", () => {
    const pages = [...globSync("src/client/pages/*Page.tsx"), "src/client/TransactionBrowser.tsx"];
    const late: string[] = [];
    let checked = 0;
    for (const path of pages) {
      const code = readFileSync(path, "utf8");
      if (path in DELEGATES) {
        expect(code, `${path} renders a header now, so its excuse is stale`).not.toContain(
          "<PageHeader",
        );
        continue;
      }
      const body = componentBody(path, code);
      expect(body, `${path}: no page component found`).not.toBeNull();
      const first = /\breturn (\(\s*<|<)/.exec(body!);
      expect(first, `${path}: the page component returns no JSX`).not.toBeNull();
      const at = first!.index;
      const returned = first![1]!.startsWith("(")
        ? balanced(body!, at + "return ".length, "(", ")")
        : body!.slice(at, body!.indexOf(";", at));
      checked += 1;
      // `{header}` and `{entryHeader}` are the shape the six fixed pages use:
      // the header is built once, above the states, and every branch renders
      // the same value.
      if (!/PageHeader|\{\w*[Hh]eader\}/.test(returned)) late.push(path);
    }
    expect(late, "a page's first return has to carry its header").toEqual([]);
    expect(checked, "no pages found, so this examined nothing").toBeGreaterThan(15);
  });
});
