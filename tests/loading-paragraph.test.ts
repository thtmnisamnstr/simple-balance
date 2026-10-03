import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * A list says it is loading with a skeleton, not a sentence.
 *
 * `web.md` 12.2 is the rule and 17.2 item 6 is the check: **`Skeleton` for
 * anything whose shape is known, the full-screen block for session boot only,
 * and retire the paragraph.** The code disagreed with itself five ways before
 * that — nine skeletons, eight `settings-note` paragraphs, six bare ones, one
 * list showing nothing at all — and fifteen sites moved. The item was blocked
 * on that migration and the guide now says so: "this is a grep with a
 * four-line allow-list rather than a grep waiting on a migration."
 *
 * What is left is not untidiness. A paragraph and a skeleton answer the same
 * question in two different shapes, so a list that swaps one for a sentence
 * reflows the page under somebody's cursor, and the categories page and the
 * overview panel were worse than that: both rendered their *empty* sentence
 * while still loading, so a list said "none yet" before it had looked.
 *
 * **Four paragraphs survive on purpose**, and they are a register rather than
 * a count: the sign-in options and the three detail pages stand in for a record
 * that does not exist yet, so their shape is genuinely unknown and a skeleton
 * would be a picture of a guess. Each is keyed by the file and the sentence,
 * not by a line number — 17.2's own rule is that a list which can quietly fall
 * behind is worth nothing, and a line number drifts the first time anything
 * above it moves.
 */

/**
 * The four, with the argument for each. A fifth entry is a decision somebody
 * has to defend in review; `web.md` 12.2 is where it gets defended.
 */
const STANDS_IN_FOR_A_RECORD = [
  {
    file: "src/client/App.tsx",
    sentence: "Loading sign-in options…",
    // Which methods a deployment offers decides the whole form: one password
    // field, or a Google button, or both, or a setup code beside them. There is
    // no shape to draw until the answer arrives.
    why: "the sign-in form's shape is the answer to the query",
  },
  {
    file: "src/client/pages/AccountDetailPage.tsx",
    sentence: "Loading account…",
    why: "a whole-page swap for a record that may not exist",
  },
  {
    file: "src/client/pages/CategoryDetailPage.tsx",
    sentence: "Loading category…",
    why: "a whole-page swap for a record that may not exist",
  },
  {
    file: "src/client/pages/TemplateDetailPage.tsx",
    sentence: "Loading template…",
    why: "a whole-page swap for a record that may not exist",
  },
];

type Paragraph = {
  readonly file: string;
  readonly line: number;
  readonly sentence: string;
  readonly attributes: string;
};

/**
 * Every `<p>` in the client whose own text says it is waiting.
 *
 * The population is the paragraphs, not the pages that were migrated: a page
 * that grows a new list tomorrow is inside this without anybody adding it,
 * which is 17.2's opening rule. Text only — a `<p>` holding `{children}` or a
 * component is some other paragraph and is not read.
 */
function waitingParagraphs(): Paragraph[] {
  const found: Paragraph[] = [];
  for (const file of sourceFiles("src/client")) {
    for (const match of file.code.matchAll(/<p\b([^>]*)>\s*([^<>{}]*?)\s*<\/p>/g)) {
      const sentence = match[2]!;
      // "Loading" is the house word and the only one 12.2's table ever used.
      // Matched case-insensitively so a lower-cased copy is not a way out.
      if (!/\bloading\b/i.test(sentence)) continue;
      found.push({
        file: file.path,
        line: file.text.slice(0, match.index).split("\n").length,
        sentence,
        attributes: match[1]!,
      });
    }
  }
  return found;
}

describe("what a list shows while it loads", () => {
  const paragraphs = waitingParagraphs();

  /**
   * The reading, before the verdict. This check's whole value is in reporting
   * an empty list, and a matcher that had stopped matching reports the same
   * empty list from a client full of them.
   */
  it("finds the paragraphs that are there", () => {
    expect(paragraphs.length).toBeGreaterThanOrEqual(STANDS_IN_FOR_A_RECORD.length);
    // And reads both halves off one of them, because the two verdicts below
    // compare the sentence and read the attributes, and a matcher that found
    // the element while capturing neither would satisfy both.
    const signIn = paragraphs.find((paragraph) => paragraph.file === "src/client/App.tsx");
    expect(signIn?.sentence).toBe("Loading sign-in options…");
    expect(signIn?.attributes).toContain('role="status"');
  });

  it("uses a skeleton everywhere else", () => {
    const registered = new Set(
      STANDS_IN_FOR_A_RECORD.map((entry) => `${entry.file}\u0000${entry.sentence}`),
    );
    const extra = paragraphs
      .filter((paragraph) => !registered.has(`${paragraph.file}\u0000${paragraph.sentence}`))
      .map((paragraph) => `${paragraph.file}:${paragraph.line} "${paragraph.sentence}"`);
    expect(
      extra,
      "web.md 12.2: Skeleton for anything whose shape is known. If this one's shape is " +
        "genuinely unknown, add it to STANDS_IN_FOR_A_RECORD with the argument.",
    ).toEqual([]);
  });

  /**
   * A register entry that no longer names anything is the other way this rots,
   * and it rots silently: the check above would go on passing while the list
   * excused four paragraphs that had all become skeletons.
   */
  it("keeps no excuse for a paragraph that is gone", () => {
    const live = new Set(
      paragraphs.map((paragraph) => `${paragraph.file}\u0000${paragraph.sentence}`),
    );
    const stale = STANDS_IN_FOR_A_RECORD.filter(
      (entry) => !live.has(`${entry.file}\u0000${entry.sentence}`),
    ).map((entry) => `${entry.file} no longer says "${entry.sentence}"`);
    expect(stale).toEqual([]);
  });

  /**
   * And the price 12.2 charges for keeping one. A `Skeleton` is `aria-hidden`
   * and carries its sentence in an `.sr-only` `role="status"`; a paragraph that
   * replaced one has to announce itself the same way, or retiring the shimmer
   * would have traded a consistency defect for an accessibility one in reverse.
   */
  it("makes the ones that stay announce themselves", () => {
    const silent = paragraphs
      .filter((paragraph) => !/role="status"/.test(paragraph.attributes))
      .map((paragraph) => `${paragraph.file}:${paragraph.line} "${paragraph.sentence}"`);
    expect(silent).toEqual([]);
  });
});
