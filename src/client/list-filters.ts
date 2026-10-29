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
   * True for a control that is in force before anybody touches it. There are
   * two kinds in the product, both shipping off: the archived toggles on
   * Accounts, Categories, the Overview and Reports, and the register's Show
   * deleted.
   *
   * It names a way out without making the list *narrowed*, and the distinction
   * is not pedantry. No page can ask whether anything is hidden — the hiding
   * is the server's, and the response holds only what it let through — so a
   * brand-new ledger and one whose every row is archived or deleted arrive as
   * the same empty response. Counted as narrowing, both would be told nothing
   * matches and offered the toggle alone, so a new person would be sent to a
   * filter before being told what to add. Not counted, both get "nothing in
   * this view", what to add, and the toggle: true of each, which is why a new
   * ledger sees "in this view" on purpose and why `clear` says "any archived
   * ones" rather than claiming a history. "Yet" would be false for somebody
   * who archived or deleted everything, so it waits until the reader turns the
   * default off — which asks the question the page cannot.
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

/**
 * Why a button that adds an entry is dead for want of an account, or nothing
 * while the accounts are still on their way.
 *
 * Three buttons said "Create an account first." whenever the list was not
 * loading, which includes when it failed, so somebody with a dozen accounts
 * was told they had none at the moment the page could not read them. The
 * import page already told the two apart; this is that distinction, once.
 */
export function noAccountReason(accounts: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): string | undefined {
  if (accounts.isPending) return undefined;
  if (accounts.isError) return "Your accounts did not load. Reload the page to try again.";
  return "Create an account first.";
}
