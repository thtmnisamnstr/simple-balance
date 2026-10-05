import { describe, expect, it } from "vitest";
import { sourceFiles, type SourceFile } from "./support/source.js";

/**
 * `web.md` 11.7: a link into a filtered list carries the filter that shows its
 * subject.
 *
 * Whether a link's words make a promise is a reading, and §17.3 owns that. One
 * shape of it is decidable, and it is the shape that produced the defect: a
 * link whose whole text is a COUNT, landing on a page that carries a date
 * range. The count is over everything; the page it opens is over a range; so
 * unless the link pins one, a link saying 40 opens a list of none.
 *
 * The case this was built from is `TemplatesPage`. It forwarded
 * `location.search` — which is the right answer from a page that has a range
 * bar, because the range the reader is looking at travels with them — but that
 * page has no bar, so there was no `preset` in the URL to forward and the
 * detail page read the missing parameter as this-month.
 */
describe("a link whose text is a count", () => {
  const files = sourceFiles("src/client");
  const app = files.find((file) => file.path === "src/client/App.tsx");
  if (!app) throw new Error("src/client/App.tsx has moved");

  const fileOf = (specifier: string) =>
    specifier.replace(/^\.\//, "src/client/").replace(/\.js$/, ".tsx");

  /**
   * Which page component each route renders, read off the one `<Route>` table.
   *
   * Derived rather than listed: a route added next week is covered the day it
   * is added, and the floor below fails if the table stops being readable.
   */
  const componentFiles = new Map<string, string>();
  for (const line of app.code.matchAll(
    /^import\s+(?:\{\s*)?(\w+)(?:\s*\})?\s+from\s+"(\.[^"]+)"/gm,
  )) {
    componentFiles.set(line[1]!, fileOf(line[2]!));
  }
  const routes = new Map<string, string>();
  for (const route of app.code.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)\s*\/>\}/g)) {
    const file = componentFiles.get(route[2]!);
    if (file) routes.set(route[1]!, file);
  }

  /**
   * The pages a date range is in force on.
   *
   * One level of composition, because `/transactions` is a four-line page that
   * renders `TransactionBrowser` and the bar is the browser's. Taking only the
   * file the route names would have left the product's largest ranged list out
   * of this entirely.
   */
  const mountsBar = (file: SourceFile) => file.code.includes("<DateRangeBar");
  const ranged = new Set(files.filter(mountsBar).map((file) => file.path));
  for (const file of files) {
    if (ranged.has(file.path)) continue;
    for (const mounted of file.code.matchAll(/<([A-Z]\w+)/g)) {
      const rendered = files.find(
        (other) => other.path.endsWith(`/${mounted[1]!}.tsx`) && mountsBar(other),
      );
      if (rendered) ranged.add(file.path);
    }
  }

  /** `/templates/${id}` as the route table spells it, which is `:param`. */
  const routeFor = (pathname: string) => {
    const wanted = pathname.replaceAll(/\$\{[^}]*\}/g, ":param").split("/");
    for (const [pattern, file] of routes) {
      const parts = pattern.split("/");
      if (parts.length !== wanted.length) continue;
      if (parts.every((part, at) => part.startsWith(":") || part === wanted[at])) return file;
    }
    return undefined;
  };

  /**
   * Every `<Link …>…</Link>`, as its attributes and its children.
   *
   * Brace-counted rather than cut at the first `>`, for the reason every
   * scanner over this repository's JSX has had to learn: `size={16}` and an
   * arrow function both carry characters that end an element early.
   */
  const links = files.flatMap((file) =>
    file.path.endsWith(".tsx")
      ? [...file.code.matchAll(/<Link\b/g)].flatMap((hit) => {
          let depth = 0;
          let index = hit.index;
          let opened = -1;
          while (index < file.code.length) {
            const character = file.code[index]!;
            if (character === '"') index = file.code.indexOf('"', index + 1);
            else if (character === "{") depth += 1;
            else if (character === "}") depth -= 1;
            else if (character === ">" && depth === 0) {
              opened = index;
              break;
            }
            if (index < 0) break;
            index += 1;
          }
          if (opened < 0) return [];
          const closed = file.code.indexOf("</Link>", opened);
          return [
            {
              file: file.path,
              line: file.code.slice(0, hit.index).split("\n").length,
              props: file.code.slice(hit.index, opened + 1),
              children: closed < 0 ? "" : file.code.slice(opened + 1, closed),
            },
          ];
        })
      : [],
  );

  /**
   * A count, not the word "count".
   *
   * Asked of an expression container rather than of the text, because "All
   * accounts" and "Create an account" both carry the letters and neither is a
   * figure. What this looks for is a value interpolated into the link: a name
   * ending in `Count`, or a `.length`.
   */
  const countLinks = links.filter(
    (link) =>
      /\{[^}]*(?:Count\b|\.length\b)[^}]*\}/.test(link.children) &&
      /pathname:/.test(link.props) &&
      ranged.has(routeFor(/pathname:\s*[`"]([^`"]*)[`"]/.exec(link.props)?.[1] ?? "") ?? ""),
  );

  it("is found by a reader that is still reading", () => {
    // Each floor is a thing that silently stopped matching once: the route
    // table, the composition walk, the element scan, and the count test.
    expect(routes.size, "no routes read, so every link lands nowhere").toBeGreaterThan(10);
    expect(ranged.has("src/client/pages/TransactionsPage.tsx")).toBe(true);
    expect(ranged.has("src/client/pages/CategoriesPage.tsx")).toBe(false);
    expect(links.length, "no links read at all").toBeGreaterThan(20);
    expect(countLinks.length, "no counted links read, so this examined nothing").toBeGreaterThan(2);
  });

  it("opens the list on the rows it counted", () => {
    const unpinned = countLinks
      // A page with its own bar is already showing a range, and the right
      // answer there is to take it with you: the figures on it are the
      // figures for that range. The rule bites on a page that has none.
      .filter((link) => !ranged.has(link.file))
      // Either the parameter itself, or `allTimeSearch`, which is the one
      // helper in `date-range.ts` whose whole job is to set it — named here
      // rather than matched loosely, so a second helper has to come and say so.
      .filter((link) => !/\bpreset\b|\ballTimeSearch\(/.test(link.props))
      .map((link) => `${link.file}:${link.line}`);
    expect(
      unpinned,
      "a count is over everything, so pin a preset rather than forwarding a search this page has no bar to fill",
    ).toEqual([]);
  });
});
