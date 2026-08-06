import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/support/dialog.ts"],
    fileParallelism: false,
    // `vi.restoreAllMocks` does not undo `vi.stubGlobal`, so a file that stubs
    // fetch and restores mocks leaves the stub installed for whatever runs
    // next. A test with no stub of its own is then served by another test's,
    // which answers requests it was never written for and throws inside itself
    // where a framework swallows it.
    unstubGlobals: true,
    // A git worktree checked out inside the repo is a second copy of every test
    // in it. Left in, a run collects them all, and the integration ones then
    // race each other for the same database and fail on schema comparisons that
    // are perfectly correct in each copy.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
