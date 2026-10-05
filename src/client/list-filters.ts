/**
 * Which of `web.md` 12.1's two empty screens a list shows, decided in one place.
 *
 * Every list used to write its own boolean, and every one counted a different
 * set. Four pages blamed a search box nobody had typed in, because their
 * condition read `search.trim()` and ignored the Type select or the archived
 * toggle sitting beside it. And the register counted the page's own subject:
 * `fixedCategoryId`, `fixedTemplateId`, `fixedPayee` and `fixedAccountId` went
 * into the same `Boolean(...)` as the search box, so a category created a
 * minute ago was told to "clear the search and filters above" — with nothing
 * above to clear, because the Account select is not even rendered when the page
 * is about one account.
 *
 * So the rule is that a filter is only what the reader can reach, and the
 * subject of the page is not passed in at all. That is what makes "the subject
 * is not a filter" true by construction rather than by somebody remembering it
 * at the next call site.
 *
 * **The shared date range is deliberately not a filter either.** Every view in
 * the product carries one, so counting it would report an empty ledger as a
 * filtered one — this rule's own failure from the other side. The two registers
 * still *name* it as a way out, because on a list of transactions it is the
 * most common culprit; naming a way out and deciding the screen are different
 * jobs and only the second one is load-bearing.
 */

/** One narrowing control a list carries, as the reader meets it. */
export type ListFilter = {
  /** True while this control is keeping rows off the screen. */
  readonly set: boolean;
  /**
   * The way out, as a lowercase imperative naming the control on screen —
   * "clear the search", "turn on Show archived". Named rather than described,
   * because the sentence has to point at something the reader can find.
   */
  readonly clear: string;
  /**
   * True for a control that is in force before anybody touches it. Hiding
   * archived rows is the only one in the product: Accounts and Categories both
   * ship with the toggle off.
   *
   * It names a way out without making the list *narrowed*, and the distinction
   * is not pedantry. If a default counted, "nothing yet" would be unreachable
   * on the two pages that have one, and a brand-new ledger would be told its
   * empty category list is the fault of a filter. Neither page can ask whether
   * archived rows exist — the hiding is the server's, and the response holds
   * only what it let through — so the honest screen is "nothing yet, and here
   * is the thing that is also hidden".
   */
  readonly fromTheStart?: boolean;
};

export type EmptyScreen = {
  /** Whether to say "nothing matches" rather than "nothing yet". */
  readonly narrowed: boolean;
  /** Every way out that is in force, in the order the controls sit on screen. */
  readonly ways: readonly string[];
};

/** The screen, and the controls to name as the way out of it. */
export function emptyScreen(filters: readonly ListFilter[]): EmptyScreen {
  const live = filters.filter((filter) => filter.set);
  return {
    narrowed: live.some((filter) => !filter.fromTheStart),
    ways: live.map((filter) => filter.clear),
  };
}

/**
 * The ways out as one sentence.
 *
 * Joined here rather than at the call sites so a list with three live filters
 * reads as one instruction instead of three, and so the capital and the full
 * stop are not eight pages' separate problem.
 */
export function waysOut(ways: readonly string[]): string {
  const [first, ...rest] = ways;
  if (first === undefined) return "";
  const last = rest.at(-1);
  const joined =
    last === undefined ? first : `${[first, ...rest.slice(0, -1)].join(", ")}, or ${last}`;
  return `${joined.slice(0, 1).toUpperCase()}${joined.slice(1)}.`;
}
