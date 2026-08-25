import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every rule this repository silences has to say why, somewhere a person reads.
 *
 * `docs/standards/code/index.md` opens with "every rule says how it is checked"
 * and "a rule that is not enforced says so". A rule set that quietly turns
 * something off is the exact failure that principle exists to prevent, and it
 * had already happened once: `no-control-regex` was off, correctly, with the
 * reasoning nowhere but in a chat log.
 *
 * So the config and the guides check each other. Turning a rule off is still
 * one line; it is one line plus a paragraph, which is the price.
 */
const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8")) as {
  rules?: Record<string, string>;
  plugins?: string[];
};

const guides = globSync("docs/standards/code/*.md")
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

describe("the lint configuration", () => {
  const rules = Object.entries(config.rules ?? {});

  // Sanity: if the config stopped parsing or the shape changed, every test
  // below would pass vacuously.
  it("has rules to check", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  const silenced = rules.filter(([, level]) => level === "off").map(([rule]) => rule);

  it.each(silenced)("explains why %s is off", (rule) => {
    expect(guides).toContain(rule);
  });

  const warned = rules.filter(([, level]) => level === "warn").map(([rule]) => rule);

  // A warning is a decision to tolerate something for now, which needs a reason
  // as much as an outright "off" does — and a budget, which its own test holds.
  it.each(warned)("explains why %s is only a warning", (rule) => {
    expect(guides).toContain(rule);
  });

  it("names every plugin it enables", () => {
    const undocumented = (config.plugins ?? []).filter((plugin) => !guides.includes(plugin));
    expect(undocumented).toEqual([]);
  });
});
