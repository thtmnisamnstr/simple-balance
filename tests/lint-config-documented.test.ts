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

/**
 * And the same rule one level down: a rule silenced at a site argues there.
 *
 * `comments.md` section 5 is Binding and was answering to nothing. A rule turned
 * off across the repository carries its reason in `index.md`, where the count of
 * them is visible; a rule turned off on one line has nowhere to carry it but the
 * line above. A bare disable is a claim that the rule is wrong about this code,
 * made without argument — and there is no count anywhere that would show it,
 * because the disable itself looks the same either way.
 *
 * The guide states the failure precisely: "a count going up is not the failure.
 * A count going up faster than the paragraphs is." This is that sentence.
 */
describe("a rule silenced at the site", () => {
  it("carries its reason on the line above", () => {
    const bare: string[] = [];
    let found = 0;
    for (const path of globSync("src/**/*.{ts,tsx}")) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("oxlint-disable")) return;
        found += 1;
        // Contiguous with the disable, not merely nearby. A window of a dozen
        // lines passes on a bare disable that happens to sit under an unrelated
        // comment, which in a file this densely commented is most of them — so
        // it is the run of comment lines directly above that has to carry the
        // argument.
        //
        // Two shapes need allowing for. A JSX disable sits under a `{/* … */}`
        // whose last line begins with a word and ends in `*/}`, so being inside
        // a block comment is tracked walking upward rather than inferred from a
        // prefix. And one of the fourteen argues about a whole effect from above
        // the `useEffect(` that opens it, which `comments.md` names as its
        // exception, so one line of code may be stepped over before the run
        // begins — but never a blank, because a disable separated from its
        // paragraph by an empty line has lost it.
        let insideBlock = false;
        let stepped = 0;
        const run: string[] = [];
        for (let above = index - 1; above >= 0; above -= 1) {
          const text = lines[above]!.trim();
          const closes = /\*\/\}?$/.test(text) && !text.includes("/*");
          const opens = text.includes("/*");
          const isComment = insideBlock || closes || opens || text.startsWith("//");
          if (!isComment) {
            if (run.length > 0 || text === "" || stepped > 0) break;
            stepped += 1;
            continue;
          }
          if (closes) insideBlock = true;
          if (insideBlock && opens) insideBlock = false;
          run.push(text.replace(/^(?:\/\/|\{\/\*|\/\*|\*)\s*/, ""));
        }
        // Two words of three letters or more, so a lone URL or the rule name
        // repeated back is not mistaken for an argument.
        if (/[a-z]{3,}\s+[a-z]{3,}/i.test(run.join(" "))) return;
        bare.push(`${path}:${index + 1}`);
      });
    }
    // The count is deliberately not pinned — the guide says a rising count is
    // not itself the failure — but a walk that found nothing would pass the
    // assertion below by looking at nothing.
    expect(found).toBeGreaterThan(5);
    expect(bare, "a disable with no argument above it").toEqual([]);
  });
});
