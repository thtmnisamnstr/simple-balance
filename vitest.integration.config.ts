import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * The integration run, which is the base configuration plus one guarantee: in CI
 * it may not pass by skipping everything.
 *
 * A separate file rather than a flag on the shared one, because `npm run verify`
 * runs the fast suite with `TEST_DATABASE_URL` deliberately blank. A guard on the
 * shared config would fail that run for doing exactly what it is meant to do.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      globalSetup: ["tests/integration/support/require-database.ts"],
    },
  }),
);
