import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A docblock sits on the code it describes.
 *
 * `comments.md` 4: a comment says why the code beside it is the way it is, and
 * an editor shows a declaration the docblock directly above it. Twenty-six
 * declarations here had been slid in between an existing docblock and its
 * code, so hovering the new one showed the old one's argument and the old one
 * showed nothing — `currentBalance`'s explanation over `userAccountById`, a
 * component's over the helper inserted above it. The shape is mechanical: a
 * docblock closing and another opening with nothing between them.
 *
 * A file's own header is the one docblock that may be followed straight by a
 * declaration's: it describes the file, and nothing but imports comes before
 * it.
 */
const SOURCES = globSync("src/**/*.{ts,tsx}");

function stacked() {
  const found: string[] = [];
  let headers = 0;
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf8");
    // Followed by another docblock, or by a blank line: either way the editor
    // no longer shows it on the code beneath.
    for (const match of source.matchAll(/\*\/\s*\n(?:\s*\/\*\*|[ \t]*\n)/g)) {
      if (
        !source
          .slice(0, match.index)
          .slice(source.slice(0, match.index).lastIndexOf("/*"))
          .startsWith("/**")
      )
        continue;
      const before = source.slice(0, match.index);
      const first = before.lastIndexOf("/**");
      const preamble = before
        .slice(0, first)
        .replaceAll(/^import[\s\S]*?;\s*$/gm, "")
        .replaceAll(/^\s*\/\/.*$/gm, "")
        .trim();
      if (preamble === "") {
        headers += 1;
        continue;
      }
      found.push(`${file}:${before.split("\n").length}`);
    }
  }
  return { found, headers };
}

describe("a docblock", () => {
  it("sits directly on the declaration it describes", () => {
    const { found, headers } = stacked();
    // A file header is the case this allows, and there are several: a scan
    // that found none would have stopped recognizing the shape at all.
    expect(headers, "no file headers recognized, so this examined nothing").toBeGreaterThan(3);
    expect(found, "move the newer declaration above the older docblock").toEqual([]);
  });
});
