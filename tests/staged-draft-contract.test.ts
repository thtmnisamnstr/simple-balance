import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stagedDraftSchema, transactionDraftSchema } from "../src/shared/domain.js";

/**
 * The staged draft an agent is handed declares every field that decides the row.
 *
 * `AGENTS.md`, on parity: "Route by route is where the test can check, not where
 * the rule stops: a request field only an agent ever sets is the same defect one
 * level down, and it is invisible to a comparison of route lists." This is the
 * same sentence read the other way, which `mcp.md` records as the unclosed half
 * — "nothing compares the fields a tool writes against the fields a page
 * writes" — and it is the half that bites, because `stagedDraftSchema` ends
 * `.catchall(z.unknown())`. Every undeclared key travels perfectly well. It is
 * just invisible in `tools/list`, so an agent has no way to know it exists.
 *
 * Three were. `categoryName` and `categoryKind` are written onto a staged draft
 * by a deferred CSV import and by the review queue's inline category editor,
 * and read back at commit through the canonical draft; `templateId` is written
 * by the transaction form and is what `staged-transactions?templateId=` filters
 * on. None of the three was published, and `categoryId`'s own description sent
 * an agent to `rawData` instead — a column that is stored and never read for
 * resolution. So an agent staging a row under a category that does not exist
 * yet had no documented way to name it and no way at all to say which kind to
 * create, and the kind fell to direction alone, which `AGENTS.md` calls "the
 * case the direction alone gets wrong".
 *
 * **The population is the canonical draft**, not a list kept by hand: a staged
 * row is a proposal of a committed entry, and `validateDraft` parses it through
 * `transactionDraftSchema` when it commits. So every field that schema declares
 * is a field a staged row can carry, and a staged draft that does not publish
 * one is publishing an incomplete contract. Deriving it this way is what would
 * have caught all three on the day they landed (`web.md` 17.2).
 */
const canonicalKeys = () => {
  const variants = (transactionDraftSchema as unknown as { options: { shape: object }[] }).options;
  // A union of three, and a field on any one of them is a field a staged row
  // can hold: a staged row has no settled type until it commits.
  expect(variants.length).toBeGreaterThan(1);
  return new Set(variants.flatMap((variant) => Object.keys(variant.shape)));
};

const stagedShape = () =>
  (stagedDraftSchema as unknown as { shape: Record<string, { description?: string }> }).shape;

describe("the published staged draft", () => {
  it("declares every field the committed draft declares", () => {
    const staged = new Set(Object.keys(stagedShape()));
    const missing = [...canonicalKeys()].filter((key) => !staged.has(key));
    expect(
      missing,
      "declare these on stagedDraftSchema with a description; the catchall carries them either way, which is why nothing noticed",
    ).toEqual([]);
  });

  it("describes every field it declares, because the type says nothing", () => {
    // The schema's own preamble: every field is `unknown`, so a field with no
    // description tells an agent nothing at all.
    const bare = Object.entries(stagedShape())
      .filter(([, field]) => !field.description?.trim())
      .map(([key]) => key);
    expect(bare).toEqual([]);
  });

  /**
   * `categoryId`'s description points at the field that actually resolves a
   * category, and not at `rawData`.
   *
   * Every reference to `rawData` in the staging service is a write (`:249`,
   * `:269`, `:289`, `:324`); nothing reads it back to resolve anything. An
   * agent following the old sentence put the name somewhere nothing looks,
   * and the row committed uncategorized with no refusal at all.
   */
  it("sends a caller naming a category by name to categoryName", () => {
    const categoryId = stagedShape().categoryId!.description!;
    expect(categoryId).toContain("categoryName");
    expect(categoryId).not.toContain("rawData the queue keeps");
  });

  /**
   * And the keys the browser writes are a subset of what is published, which is
   * the parity claim in the direction the route-by-route test cannot see.
   *
   * Read from `StagingPage`, which PUTs the whole draft back: an update of a
   * staged row replaces the draft rather than patching it, so a key the browser
   * sets and the schema does not name is a key an agent clears every time it
   * edits a row.
   */
  it("publishes every key the review queue writes onto a draft", async () => {
    const source = await readFile(
      new URL("../src/client/pages/StagingPage.tsx", import.meta.url),
      "utf8",
    );
    const written = [...source.matchAll(/\bdraft\.([A-Za-z][A-Za-z0-9]*)\s*=/g)].map(
      (match) => match[1]!,
    );
    expect(written.length, "the inline editor no longer writes onto a draft").toBeGreaterThan(3);
    const staged = new Set(Object.keys(stagedShape()));
    expect([...new Set(written)].filter((key) => !staged.has(key))).toEqual([]);
  });
});
