/**
 * The old spellings a rename left answering, read out of `src/server/api.ts`.
 *
 * They are named once, in `RENAMED_PATHS`, and registered like any other route
 * against the same handler as their replacement; one middleware reads the table
 * to mark them deprecated. Three checks have to tell them apart from the
 * surface — the route table, parity, and the path-id check — and each used to
 * parse a `deprecated(...)` argument off the registration, which stopped
 * existing when the headers moved ahead of the guards. One reader, so the next
 * change to how they are written is one change here.
 *
 * Keyed `METHOD /path`, valued with the successor path in the same spelling.
 */
export function renamedRoutes(apiSource: string): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const match of apiSource.matchAll(
    /method: "(\w+)",\s*path: "([^"]+)",\s*successor: "([^"]+)"/g,
  )) {
    renamed.set(`${match[1]} ${match[2]}`, match[3]!);
  }
  return renamed;
}
