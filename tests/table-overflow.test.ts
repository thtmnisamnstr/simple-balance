import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Every wide table sits in something that scrolls.
 *
 * `.data-table` carries a 760px `min-width`, so on a narrow panel it is wider
 * than the space it has. Wrapped in a container that scrolls, the far columns
 * stay reachable; wrapped in one that does not, they spill past the panel's
 * edge and cannot be reached at all. That is what `.table-wrap` was for on the
 * templates and recurrences pages, where the class was used but never written,
 * so both had silently overflowed since they shipped.
 *
 * Checked by reading the source, because jsdom computes no layout and would
 * report the overflowing version and the fixed one identically.
 */
const CLIENT = new URL("../src/client/", import.meta.url);

async function tsxFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: URL[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...(await tsxFiles(new URL(`${entry.name}/`, directory))));
    } else if (entry.name.endsWith(".tsx")) {
      found.push(new URL(entry.name, directory));
    }
  }
  return found;
}

describe("wide tables", () => {
  it("are wrapped in a container that scrolls", async () => {
    const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const scrolls = new Set(
      [...styles.matchAll(/^\.([\w-]+)\s*\{[^}]*overflow-x:\s*auto/gms)].map(
        (match) => match[1]!,
      ),
    );
    expect(scrolls.size).toBeGreaterThan(0);

    const unwrapped: string[] = [];
    for (const file of await tsxFiles(CLIENT)) {
      const source = await readFile(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!/className="data-table\b/.test(line)) return;
        const above = lines.slice(Math.max(0, index - 3), index).join("\n");
        const wrapper = [...above.matchAll(/className="([\w- ]+)"/g)]
          .flatMap((match) => match[1]!.split(/\s+/))
          .some((name) => scrolls.has(name));
        if (!wrapper) {
          unwrapped.push(
            `${file.pathname.split("/client/")[1]}:${index + 1} — no scrolling wrapper`,
          );
        }
      });
    }
    expect(unwrapped).toEqual([]);
  });

  /**
   * `.table-card` brings a card's own border, background and shadow. Inside a
   * panel, which carries the same three, it draws a second card around the
   * first, so the two classes are not interchangeable.
   */
  it("keep the panel wrapper free of a second card's chrome", async () => {
    const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const cardChrome = styles
      .split("\n")
      .findIndex((line) => line.trim() === ".table-card,");
    expect(cardChrome).toBeGreaterThan(-1);

    const wrapRule = /^\.table-wrap\s*\{([^}]*)\}/ms.exec(styles)?.[1] ?? "";
    expect(wrapRule).toContain("overflow-x: auto");
    expect(wrapRule).not.toContain("border");
    expect(wrapRule).not.toContain("background");
    expect(wrapRule).not.toContain("box-shadow");
  });
});
