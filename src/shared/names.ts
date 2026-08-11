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
