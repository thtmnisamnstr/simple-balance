import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoFiles, repoRoot } from "./support/source.js";

/**
 * Every relative link in every document under `deploy/` points at a file that
 * is there.
 *
 * These documents are the deployment recipes, and they cross-reference each
 * other and `docs/` constantly — which is the right way to write them, and the
 * reason a link rots the moment anything moves. Two in
 * `deploy/compose/single/README.md` were written `../../docs/...` from a file
 * three directories deep, so both resolved to `deploy/docs/` and neither had
 * ever worked. Nothing looked, because nothing in this repository read a link.
 *
 * A wrong link is worse here than in most places. Somebody following one is
 * part way through standing up a machine that will hold a ledger, and what
 * they lose is the paragraph that says which size to pick or which ports to
 * open — so the failure is not a 404, it is a deployment built on a guess.
 *
 * Only relative links: an `http` target is somebody else's uptime, and a
 * fragment is a heading this check would have to parse Markdown to know about.
 * The path before a `#` is still checked, because that is the half that can be
 * wrong without anybody clicking.
 */

const documents = repoFiles((file) => file.startsWith("deploy/") && file.endsWith(".md"));

/** Every `[text](target)` link in a document, with `http` and bare anchors dropped. */
const linksIn = (text: string) =>
  [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => target.replace(/#.*$/, ""))
    .filter((target) => target !== "");

describe("the links between the deployment recipes", () => {
  it("finds the documents it is checking", () => {
    // A floor, so a glob that stopped matching would leave this passing over
    // nothing — which is the shape of the gap it was written to close.
    expect(documents.length).toBeGreaterThanOrEqual(3);
    expect(documents.map((file) => file.path)).toContain("deploy/compose/single/README.md");
  });

  it.each(documents.map((file) => [file.path, file] as const))(
    "all resolve, in %s",
    (from, file) => {
      const directory = path.dirname(path.join(repoRoot, from));
      const broken = linksIn(file.text).filter(
        (target) => !existsSync(path.join(directory, target)),
      );

      expect(broken).toEqual([]);
    },
  );

  it("checks a real number of links rather than passing on none of them", () => {
    // The population, not just the documents: a link regex that stopped
    // matching would leave every assertion above true and meaningless.
    const total = documents.reduce((count, file) => count + linksIn(file.text).length, 0);

    expect(total).toBeGreaterThanOrEqual(10);
  });
});
