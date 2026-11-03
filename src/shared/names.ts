/**
 * Normalize user-facing names without discarding the user's capitalization.
 * NFKC folds equivalent Unicode presentation forms, while trimming and
 * collapsing whitespace makes matching predictable across browser and CSV
 * input.
 */
export function cleanHumanName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/** Locale-independent comparison key for human-facing names. */
export function normalizeHumanName(value: string) {
  return cleanHumanName(value).toLowerCase();
}

/**
 * Whether a name answers a search, asked of the name's normalized form.
 *
 * One function because the Payees page narrows its list as somebody types and
 * `list_payees` narrows the same list for an agent, and the two predicates had
 * drifted: the page lower-cased the spelling as typed, so "acme co" missed
 * "ACME  Co" in the browser and found it over MCP. A search left blank
 * matches every name, as an empty search box shows the whole list.
 */
export function nameSearch(search: string): (normalizedName: string) => boolean {
  const wanted = normalizeHumanName(search);
  return (normalizedName) => normalizedName.includes(wanted);
}
