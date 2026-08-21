/**
 * Refuse to skip the whole integration suite in CI.
 *
 * Every file here is `describe.skipIf(!TEST_DATABASE_URL)`, so with no database
 * the run passes having executed nothing — forty-eight files skipped, exit 0, a
 * green gate that proved nothing. The workflow deliberately blanks that variable
 * for the fast suite one step earlier, which is exactly the edit that could
 * reach here unnoticed.
 *
 * The check lives with the tests rather than in the workflow so it holds however
 * the suite is invoked, and it asks for `CI` rather than for a particular
 * provider: locally, running with no database and watching everything skip is a
 * reasonable thing to want.
 */
export default function requireDatabase() {
  if (process.env.CI && !process.env.TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is empty, so every integration file would skip and the " +
        "run would pass having tested nothing. Point it at a PostgreSQL this run " +
        "may create and drop databases on, or unset CI to skip deliberately.",
    );
  }
}
