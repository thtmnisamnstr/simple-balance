// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * import one; this holds the two together, the same way the theme-colour
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
