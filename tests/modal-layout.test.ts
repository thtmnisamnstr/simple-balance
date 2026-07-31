import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("modal layout", () => {
  it("centers dialogs independently of the global margin reset", () => {
    const css = readFileSync(
      new URL("../src/client/styles.css", import.meta.url),
      "utf8",
    );
    const rule = css.match(/\.modal\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/height:\s*fit-content/);
    expect(rule).toMatch(/margin:\s*auto/);
  });
});
