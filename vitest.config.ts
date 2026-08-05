import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/support/dialog.ts"],
    fileParallelism: false,
    // A git worktree checked out inside the repo is a second copy of every test
    // in it. Left in, a run collects them all, and the integration ones then
    // race each other for the same database and fail on schema comparisons that
    // are perfectly correct in each copy.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
