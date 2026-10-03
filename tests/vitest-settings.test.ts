import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

/**
 * The two runner settings whose absence breaks somebody else's file.
 *
 * `code/testing.md` 5.3 is Binding and was marked `*Checked by:* human` with
 * its own reason for being: "Nothing reads `vitest.config.ts` back, and seven
 * files stub a global and leave the undoing to the runner, so deleting the line
 * breaks whichever file happens to run after one of them rather than anything
 * that names the setting."
 *
 * That is the worst debugging shape a suite has. `vi.restoreAllMocks` does not
 * undo `vi.stubGlobal`, so without `unstubGlobals` a file that stubs `fetch`
 * goes on serving the next file's requests — and the next file has no stub, no
 * mention of `fetch` and nothing to search for. The failure lands on a test
 * that is correct, written by somebody who never touched the setting.
 *
 * Read off the imported configuration rather than the file's text, so what is
 * asserted is the value the runner is handed. A `unstubGlobals: true` inside a
 * commented-out block, or under a second `test` key that the later one
 * replaces, reads perfectly to a regex and does nothing at all.
 */
describe("vitest.config.ts", () => {
  it("unstubs globals between files (Binding, testing.md 5.3)", () => {
    // The whole `test` section, asserted present first: a configuration that
    // moved its options somewhere this cannot see would otherwise fail here
    // with `undefined` and read as the setting being absent, which is the same
    // verdict for a different reason.
    expect(config.test, "vitest.config.ts exports a test section").toBeTypeOf("object");
    expect(config.test?.unstubGlobals, "vi.restoreAllMocks does not undo vi.stubGlobal").toBe(true);
  });

  it("runs one file at a time (House, testing.md 5.4)", () => {
    // 5.4 is the environment half of the same argument and rests on this:
    // every file in a tier shares one process, so a variable one of them sets
    // is still set for whatever runs next, and the thirty-four files that flip
    // a switch restore it by discipline. Turn parallelism on and that
    // discipline stops being enough in a way no single file reports.
    expect(config.test?.fileParallelism, "one process per tier, shared by every file").toBe(false);
  });
});
