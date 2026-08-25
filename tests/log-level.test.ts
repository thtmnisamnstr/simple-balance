import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `LOG_LEVEL`, which for a long time governed somebody else's logging.
 *
 * It was passed to Better Auth's logger and to nothing else, so a deployment
 * that asked for `error` still got this product's startup banner, its mail
 * notice and its scheduler warnings. That is worse than having no setting: the
 * log looks like the answer to a question the operator did asked, and is not.
 *
 * Two halves, and the second is the one that rots. The gate itself is simple
 * enough to check in four assertions; keeping every call site behind it is a
 * property of thirty-odd files that a person cannot re-check on every change.
 */
const environment = { ...process.env };

afterEach(() => {
  process.env = { ...environment };
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The logger, rebuilt against the environment this test just set. */
async function freshLog() {
  vi.resetModules();
  const module = await import("../src/server/log.js");
  module.resetLogLevel();
  return module.log;
}

describe("the log level", () => {
  it("keeps everything at debug", async () => {
    process.env.LOG_LEVEL = "debug";
    const log = await freshLog();
    const spies = {
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(spies.debug).toHaveBeenCalledOnce();
    expect(spies.info).toHaveBeenCalledOnce();
    expect(spies.warn).toHaveBeenCalledOnce();
    expect(spies.error).toHaveBeenCalledOnce();
  });

  it("drops what sits below the level asked for", async () => {
    process.env.LOG_LEVEL = "warn";
    const log = await freshLog();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.info("the startup banner");
    log.warn("something worth knowing");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never silences an error", async () => {
    process.env.LOG_LEVEL = "error";
    const log = await freshLog();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("what went wrong");
    // The quietest setting there is. A level that could silence this would be a
    // setting an operator uses once and then cannot diagnose anything with.
    expect(error).toHaveBeenCalledOnce();
  });

  it("says something rather than nothing when configuration cannot be read", async () => {
    process.env.LOG_LEVEL = "not-a-level";
    const log = await freshLog();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // This is the path a startup failure takes: `getConfig()` throws, and the
    // line reporting that has to come out anyway or the container exits in
    // silence.
    log.error("configuration is wrong");
    expect(error).toHaveBeenCalledOnce();
  });
});

describe("every line this product writes", () => {
  /**
   * The configuration layer keeps `console` on purpose.
   *
   * A warning about configuration cannot be gated by a configuration value: the
   * gate reads `getConfig()`, and these three warn from inside it. Routing them
   * through the logger would be a re-entrant call during the first read, which
   * is a stack overflow rather than a quiet line.
   */
  const CONFIGURATION_LAYER = [
    "src/server/config.ts",
    "src/server/config-files.ts",
    "src/server/config-limits.ts",
    "src/server/log.ts",
  ];

  it("goes through the level gate, except in the configuration layer", () => {
    const direct: string[] = [];
    for (const file of sourceFiles("src/server")) {
      if (CONFIGURATION_LAYER.includes(file.path)) continue;
      // Comments blanked, because several of them discuss what is logged and a
      // grep that read those would report files that log nothing at all.
      for (const [index, line] of file.code.split("\n").entries()) {
        if (/\bconsole\.(debug|info|warn|error)\(/.test(line)) {
          direct.push(`${file.path}:${index + 1}`);
        }
      }
    }
    expect(
      direct,
      "Use `log` from src/server/log.ts so LOG_LEVEL means something, or add the file to " +
        "CONFIGURATION_LAYER with the reason it cannot.",
    ).toEqual([]);
  });

  it("keeps the configuration layer's exception real", () => {
    // An exception list that has quietly become unnecessary proves nothing, so
    // each name has to still be doing the thing it is excused for.
    const logging = sourceFiles("src/server").filter(
      (file) =>
        CONFIGURATION_LAYER.includes(file.path) &&
        // `log.ts` is on the list because it is the gate, not because it is
        // excused from it: every `console` call in it is the one doing the
        // writing.
        file.path !== "src/server/log.ts" &&
        /\bconsole\.(warn|error|info)\(/.test(file.code),
    );
    expect(logging.map((file) => file.path)).toEqual([
      "src/server/config-files.ts",
      "src/server/config-limits.ts",
      "src/server/config.ts",
    ]);
  });
});
