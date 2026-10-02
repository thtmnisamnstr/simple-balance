// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SortableHeader, type SortState } from "../src/client/components.js";
import { sourceFiles } from "./support/source.js";

/**
 * Two decisions about tables that `web.md` records and nothing holds.
 *
 * 9.1 settles that this product's tables are tables and not grids: no
 * `role="grid"`, no roving tabindex, every control in a row its own tab stop.
 * The section argues it against the APG, which leans the other way, and the
 * guide values the check honestly at "roughly nothing until somebody reaches
 * for one" — which is exactly the moment it is worth something, because
 * reaching for the role is how the rest of the pattern arrives afterwards.
 *
 * 9.4 settles that `SortableHeader` is one of the two sanctioned sorting
 * affordances and that ARIA 1.2's one-header-at-a-time rule is met by it. The
 * guide calls that rule "assertable" and leaves it unasserted.
 */

const client = sourceFiles("src/client");

describe("tables are tables", () => {
  /**
   * The grid pattern's own roles, and nothing wider. `role="region"` is used
   * deliberately on the scrolling wrappers (9.6) and `role="status"` on the
   * loading paragraphs, so a check that fired on "a hand-written role" would
   * fire on two rules this guide requires.
   */
  const GRID_ROLES = ["grid", "treegrid", "gridcell"];

  it("reaches for none of the grid pattern's roles", () => {
    const found = client.flatMap((file) =>
      GRID_ROLES.flatMap((role) =>
        [...file.code.matchAll(new RegExp(`role=['"\`]${role}['"\`]`, "g"))].map(
          (match) =>
            `${file.path}:${file.text.slice(0, match.index).split("\n").length} ${match[0]}`,
        ),
      ),
    );
    expect(
      found,
      "web.md 9.1 records why this product's tables are not grids. Reopen it there first.",
    ).toEqual([]);
  });

  it("is looking at files that declare roles", () => {
    // The guard. The assertion above is a search for something absent, and a
    // reader pointed at nothing at all would report the same empty list.
    const withRoles = client.filter((file) => /role=["']/.test(file.code));
    expect(withRoles.length).toBeGreaterThan(3);
    expect(withRoles.map((file) => file.path)).toContain("src/client/components.tsx");
  });
});

describe("one sorted header at a time", () => {
  /**
   * The attribute has one writer.
   *
   * ARIA 1.2's rule is about the table, not the cell, so it cannot be met by a
   * component alone — but it can be *lost* by a second writer, and a `<th>`
   * somewhere with a hand-written `aria-sort="ascending"` is the shape that
   * would do it while every rendered test went on passing.
   */
  it("is written in one component and nowhere else", () => {
    const writers = client.filter((file) => /\baria-sort\s*=/.test(file.code));
    expect(writers.map((file) => file.path)).toEqual(["src/client/components.tsx"]);
  });

  /**
   * And every header of one table is told about the same sort.
   *
   * This is the half a rendered test cannot reach: a page holding two sort
   * states and handing one to three headers and the other to two would render
   * two sorted columns in one table, and each page's own test would still see
   * its rows in the right order. The population is every `<thead>` in the
   * client that holds a `SortableHeader`, which is the table rather than the
   * header — `web.md` 17.2: a check derives its population from the product,
   * never from the presence of the thing it is checking.
   */
  it("hands every sortable header of one table the same sort state", () => {
    const disagreeing: string[] = [];
    let heads = 0;
    let headers = 0;
    for (const file of client) {
      for (const open of file.code.matchAll(/<thead\b/g)) {
        const close = file.code.indexOf("</thead>", open.index);
        const region = file.code.slice(open.index, close === -1 ? file.code.length : close);
        const states = [...region.matchAll(/<SortableHeader\b[\s\S]*?\/>/g)].map(
          (header) => /\bsort=\{([^}]*)\}/.exec(header[0])?.[1]?.trim() ?? "no sort prop",
        );
        if (states.length === 0) continue;
        heads += 1;
        headers += states.length;
        const line = file.text.slice(0, open.index).split("\n").length;
        const distinct = [...new Set(states)];
        if (distinct.length > 1) {
          disagreeing.push(`${file.path}:${line} sorts by ${distinct.join(" and ")}`);
        }
      }
    }
    // The reading, proved before the verdict: four sortable tables and
    // twenty-five headers between them. A `<thead>` matcher that broke, or a
    // prop regex that stopped matching, would report every table compliant.
    expect(heads).toBeGreaterThanOrEqual(4);
    expect(headers).toBeGreaterThanOrEqual(25);
    expect(disagreeing, "ARIA 1.2 asks for aria-sort on one header at a time").toEqual([]);
  });

  /**
   * The component's own half, rendered: whichever column is active, every other
   * one says `none` rather than saying nothing. ARIA 1.2 asks for the explicit
   * value, and an omitted attribute is what a reader falls back to a default
   * for rather than being told.
   */
  it("marks the active column and says none on the rest", () => {
    const columns = ["date", "payee", "amount"] as const;

    function Head({ initial }: { initial: SortState<(typeof columns)[number]> }) {
      const [sort, setSort] = useState(initial);
      return (
        <table>
          <thead>
            <tr>
              {columns.map((field) => (
                <SortableHeader
                  key={field}
                  field={field}
                  label={field}
                  sort={sort}
                  onSort={setSort}
                  lean={field === "amount" ? "descending" : "ascending"}
                />
              ))}
            </tr>
          </thead>
          <tbody />
        </table>
      );
    }

    for (const active of columns) {
      const view = render(<Head initial={{ field: active, direction: "desc" }} />);
      const sorted = screen
        .getAllByRole("columnheader")
        .map((header) => [header.textContent, header.getAttribute("aria-sort")] as const);
      expect(sorted.filter(([, value]) => value === null)).toEqual([]);
      expect(sorted.filter(([, value]) => value !== "none")).toEqual([
        [expect.stringContaining(active), "descending"],
      ]);
      view.unmount();
      cleanup();
    }
  });
});
