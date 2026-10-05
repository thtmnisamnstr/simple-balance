import { execFileSync } from "node:child_process";
import { globSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The numbers `docs/standards/code/index.md` states about its own toolchain.
 *
 * That page is the route into the code guides, so a wrong figure on it is read
 * and cited rather than checked — and every figure on it was hand-counted. Four
 * censuses had gone stale together by the time anybody recounted: the six
 * category totals, the exemption list under the strictest of them, the sites
 * each exemption covers, and the three declined compiler flags. The arguments
 * all survived; none of the numbers did.
 *
 * `tests/standards-citations.test.ts` already holds every citation in every
 * guide, and the `human`-rule total across the eight code guides. What it does
 * not read is any of the measurements, and it skips `index.md` entirely when it
 * walks the labeled rules. This file is that gap.
 *
 * The half deliberately left out is `npm run lint` reading zero, which the
 * guide pairs with the census below. `npm run verify` runs it two steps before
 * the suite, so asserting it here would buy a second copy of a check that
 * already fails louder and earlier.
 */
const read = (path: string) => readFileSync(path, "utf8");

const INDEX = "docs/standards/code/index.md";
const TYPESCRIPT = "docs/standards/code/typescript.md";

/**
 * The guide with its line breaks flattened.
 *
 * Prose wraps, so a sentence that is right and wrapped differently reads as a
 * sentence that is wrong. Every comparison below is against this.
 */
const flat = (path: string) => read(path).replaceAll(/\s+/g, " ");

/**
 * English for the small numbers, because the guide writes them both ways.
 *
 * A table cell says "Twenty-nine sites" and a bullet says `prefer-tag-over-role`
 * 29 — the same count, and the prose is better for the mix. A test that only
 * knew numerals would silently stop checking the half written in words.
 */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
  "twenty-six",
  "twenty-seven",
  "twenty-eight",
  "twenty-nine",
  "thirty",
];
const spell = (n: number): string => WORDS[n] ?? String(n);

/** Case-insensitive, because a count can open a sentence or a table cell. */
const says = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

type Diagnostic = { code: string; filename: string; labels?: { span?: { line?: number } }[] };

/**
 * Every finding the strictest category has when the exemptions are discarded.
 *
 * `-A all -D correctness` is the command the guide quotes, and it overrides
 * `.oxlintrc.json` rather than reading it — which is the subtlety the guide got
 * wrong. A rule turned *off* reappears, and so does a rule merely *narrowed*,
 * so the output is the exemption list rather than the off list.
 */
const census = (): Diagnostic[] => {
  // Findings mean a non-zero exit, which is the normal case here, so the status
  // is not the signal — the parsed output is.
  let raw: string;
  try {
    raw = execFileSync("npx", ["oxlint", "-A", "all", "-D", "correctness", "--format=json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    raw = String((error as { stdout?: string }).stdout ?? "");
  }
  return (JSON.parse(raw) as { diagnostics?: Diagnostic[] }).diagnostics ?? [];
};

/** `jsx-a11y(no-autofocus)` is how oxlint spells it; the guide spells it bare. */
const ruleOf = (code: string) => code.slice(code.indexOf("(") + 1, -1);

const countBy = <T>(items: T[], key: (item: T) => string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
};

describe("the exemption census index.md prints", () => {
  const found = census();
  const byRule = countBy(found, (diagnostic) => ruleOf(diagnostic.code));
  const guide = flat(INDEX);

  it("states the total the measuring command actually reports", () => {
    const dated = /\d{4}-\d{2}-\d{2}: correctness (\d+),/.exec(guide);
    expect(dated, "the re-measured paragraph carries the date it was taken").not.toBeNull();
    expect(Number(dated![1]), `the category reads ${found.length}`).toBe(found.length);
    expect(guide).toContain(`\`correctness\` reads ${found.length},`);
    expect(guide).toContain(`the ${found.length} are`);
  });

  it("lists every rule in it, with the count the linter gives", () => {
    const wrong = [...byRule.entries()]
      .filter(([rule, count]) => !guide.includes(`\`${rule}\` ${count}`))
      .map(([rule, count]) => `${rule} is ${count}`);
    expect(wrong, "the bullet under the category table lists these").toEqual([]);
  });

  /**
   * The sentence somebody auditing the exemption list acts on.
   *
   * It read "the 39 are exactly those six" for a release, and it was wrong in a
   * way that matters: the set is not the six rules turned off by name. The
   * seventh is `no-noninteractive-tabindex`, which is narrowed rather than off,
   * and `-A all` discards a narrowing exactly as it discards an `"off"`.
   */
  it("is exactly the rules .oxlintrc.json exempts, off or narrowed", () => {
    const config = JSON.parse(read(".oxlintrc.json")) as { rules: Record<string, unknown> };
    const exempted = Object.entries(config.rules)
      .filter(([, setting]) => setting === "off" || Array.isArray(setting))
      .map(([rule]) => rule.slice(rule.indexOf("/") + 1));
    expect([...byRule.keys()].sort()).toEqual([...exempted].sort());
  });

  it("gives every rule it exempts a row or a paragraph of its own", () => {
    const config = JSON.parse(read(".oxlintrc.json")) as { rules: Record<string, unknown> };
    const unargued = Object.keys(config.rules).filter((rule) => !guide.includes(`\`${rule}\``));
    expect(unargued, "turned off in the config and unexplained in the guide").toEqual([]);
  });

  it("counts the jsx-a11y rules it turns off", () => {
    const config = JSON.parse(read(".oxlintrc.json")) as { rules: Record<string, unknown> };
    const off = Object.entries(config.rules).filter(
      ([rule, setting]) => rule.startsWith("jsx-a11y/") && setting === "off",
    );
    expect(says(guide, `${spell(off.length)} \`jsx-a11y\` rules are off`)).toBe(true);
  });
});

/**
 * The shapes behind two of those counts, which is where the argument lives.
 *
 * A count alone says nothing about whether an exemption is still defensible.
 * Both of these rows argue from the *shape* of the sites rather than from how
 * many there are, and both had drifted into describing a minority of them: the
 * `prefer-tag-over-role` row named two shapes covering six of twenty-nine, and
 * said nothing about the fourteen that are the same scroll region the narrowed
 * rule one table down exists for.
 */
describe("what the exempted rules are actually firing on", () => {
  const found = census();
  const guide = flat(INDEX);
  const sitesOf = (rule: string) => found.filter((d) => ruleOf(d.code) === rule);

  /**
   * The `role="…"` on the flagged line, which every one of these carries.
   *
   * By the reported line rather than by the span's byte offset. The offset is
   * counted in bytes and a JavaScript string index is counted in UTF-16 units,
   * so in a file whose comments hold em dashes — which here is most of them —
   * the two diverge and the lookup lands on an earlier line. That went wrong on
   * twelve of twenty-nine sites, all of them in the longest files.
   */
  const roleAt = (diagnostic: Diagnostic): string => {
    const at = diagnostic.labels?.[0]?.span?.line ?? 0;
    const line = read(diagnostic.filename).split("\n")[at - 1] ?? "";
    return /role="([a-z]+)"/.exec(line)?.[1] ?? "unknown";
  };

  it("describes prefer-tag-over-role by every shape, not two of five", () => {
    const sites = sitesOf("prefer-tag-over-role");
    const shapes = countBy(sites, roleAt);
    expect(shapes.get("unknown"), "every flagged line names a role").toBe(undefined);
    expect(says(guide, `${spell(sites.length)} sites in ${spell(shapes.size)} shapes`)).toBe(true);
    for (const [role, count] of shapes) {
      expect(
        says(guide, `${spell(count)} \`role="${role}"\``) ||
          says(guide, `${spell(count)} \`<svg role="${role}">\``) ||
          says(guide, `${spell(count)} \`<summary role="${role}">\``),
        `${count} sites use role="${role}" and the row should say so`,
      ).toBe(true);
    }
  });

  /**
   * The connection the guide was missing: these are one pattern, not two.
   *
   * `web.md` §9.6 requires `tabIndex={0}`, `role="region"` and a name together,
   * so a scroll region trips `prefer-tag-over-role` on the role and
   * `no-noninteractive-tabindex` on the tabindex. Two rows about the same
   * fourteen elements, and neither said so.
   */
  it("knows the narrowed rule's sites are the scroll regions of the row above", () => {
    const regions = sitesOf("prefer-tag-over-role").filter((d) => roleAt(d) === "region");
    const tabbable = sitesOf("no-noninteractive-tabindex");
    expect(countBy(tabbable, (d) => d.filename)).toEqual(countBy(regions, (d) => d.filename));
    expect(
      says(guide, `every one of the ${spell(tabbable.length)} sites is a named scroll region`),
    ).toBe(true);
  });

  it("splits no-autofocus into the two shapes it claims", () => {
    const sites = sitesOf("no-autofocus");
    const staging = sites.filter((d) => d.filename.endsWith("StagingPage.tsx"));
    expect(says(guide, `${spell(sites.length)} sites, all one of those two shapes`)).toBe(true);
    expect(says(guide, `${spell(staging.length)} inline editors on the staging page`)).toBe(true);
    expect(says(guide, `${spell(sites.length - staging.length)} form fields`)).toBe(true);
  });

  it("names every file the control-character rule fires in", () => {
    const sites = sitesOf("no-control-regex");
    expect(says(guide, `all ${spell(sites.length)} sites here exist`)).toBe(true);
    const unnamed = [...new Set(sites.map((d) => d.filename))].filter(
      (file) => !guide.includes(`\`${file}:`),
    );
    expect(unnamed, "cited by file and line, like the other three").toEqual([]);
  });
});

/**
 * The `human`-rule split, which drifted because only the total was held.
 *
 * `tests/standards-citations.test.ts` holds "There are 47 `human` rules". It
 * does not hold either half of the sentence that follows, and both halves moved
 * at once — `testing.md` gained a row, `comments.md` lost one — so the total sat
 * still and the check stayed green over prose that was false twice.
 */
describe("the per-guide human-rule counts index.md quotes", () => {
  /** The same census `tests/standards-citations.test.ts` takes, per guide. */
  const perGuide = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const guide of globSync("docs/standards/code/*.md")) {
      if (guide.endsWith("index.md")) continue;
      const text = read(guide);
      const table = text.slice(text.indexOf("not enforced"));
      counts.set(
        guide.slice(guide.lastIndexOf("/") + 1),
        [...table.matchAll(/^\| (?!Rule|---)[^|]+\|/gm)].length,
      );
    }
    return counts;
  };

  const counts = perGuide();
  const guide = flat(INDEX);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

  it("splits the total the way the guides are actually written", () => {
    const comments = counts.get("comments.md")!;
    expect(guide).toContain(`There are ${total} \`human\` rules`);
    expect(guide).toContain(`${total - comments} in the seven that`);
    expect(says(guide, `${spell(comments)} in \`comments.md\``)).toBe(true);
  });

  it("names the guide that holds the most, and how many", () => {
    const largest = [...counts.entries()]
      .filter(([name]) => name !== "comments.md")
      .sort((left, right) => right[1] - left[1])[0]!;
    expect(says(guide, `\`${largest[0]}\`'s table grew to ${spell(largest[1])}`)).toBe(true);
  });
});

/**
 * The three declined compiler flags, said in two guides.
 *
 * This table is a summary; `typescript.md` §1.4 is where the flags are argued,
 * split and re-measured. Re-measuring in one place and not the other is how the
 * summary came to stand at 71, 440 and 666 while the argument stood at 106, 567
 * and 927 — about 40% under, on the one row that tells somebody to come back to
 * the work. Neither number is derived here: running `tsc` three times with a
 * flag apiece costs a minute, and what went wrong was never the measurement.
 * It was that two pages could disagree in silence.
 */
describe("the declined compiler flags", () => {
  const FLAGS = [
    "exactOptionalPropertyTypes",
    "noUncheckedIndexedAccess",
    "noPropertyAccessFromIndexSignature",
  ];

  it("cost the same in index.md as in typescript.md", () => {
    const index = flat(INDEX);
    const argued = flat(TYPESCRIPT);
    const disagreed: string[] = [];
    for (const flag of FLAGS) {
      const row = new RegExp(`\`${flag}\` \\| ([\\d,]+) \\|`).exec(index);
      expect(row, `${flag} has a row in the compiler table`).not.toBeNull();
      const count = row![1]!;
      // A window after the flag's name rather than an exact phrase: the other
      // guide is free to reword, and this is checking the two agree about a
      // number rather than policing how it says it.
      const windows = [...argued.matchAll(new RegExp(`${flag}\`?([^]{0,160})`, "g"))];
      if (!windows.some(([, after]) => after!.includes(count))) {
        disagreed.push(`${flag}: index.md says ${count}, typescript.md does not`);
      }
    }
    expect(disagreed, "re-measure both or neither").toEqual([]);
  });
});

/** Never source, and `node_modules` is slow enough to be worth naming here. */
const IGNORED = new Set(["node_modules", "dist", "coverage", "drizzle"]);

/**
 * The formatter's scope against the linter's, which are not the same tree.
 *
 * `npm run lint` walks everything; `npm run format` is given three paths. The
 * two `*Checked by:*` footers in that section read as one toolchain over one
 * repository, and they are not. This holds the section's counts to the tree, in
 * both directions: when the command is widened the gap closes, and a section
 * still describing a gap then fails until somebody rewrites it.
 */
describe("what the formatter is pointed at", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  const paths = (script: string) =>
    script
      .split(/\s+/)
      .slice(1)
      .filter((argument) => !argument.startsWith("-"));

  const SOURCE = /\.(?:ts|tsx|js|mjs|cjs|jsx)$/;
  /**
   * Covered by one of the paths the command is given.
   *
   * A bare word is a directory oxfmt walks; a word with a `*` in it is a shell
   * glob the shell expands before oxfmt sees it, so it reaches only the root.
   */
  const covered = (path: string) =>
    paths(scripts["format"]!).some((argument) =>
      argument.includes("*")
        ? !path.includes("/") &&
          new RegExp(`^${argument.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(path)
        : path === argument || path.startsWith(`${argument}/`),
    );

  /**
   * What oxfmt is never pointed at, and oxlint always is.
   *
   * Derived from the command rather than from a list of directories, so that
   * widening the command closes this gap and fails the sentence below. A
   * hardcoded `{deploy,scripts}` glob passed every mutation except the one that
   * matters: the command was widened and nothing noticed.
   */
  const outside = readdirSync(".", { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? globSync(`${entry.name}/**/*`).filter((path) => !path.includes("node_modules"))
        : [entry.name],
    )
    .filter((path) => SOURCE.test(path) && !covered(path))
    .sort();

  const guide = flat(INDEX);

  it("fixes and checks the same files", () => {
    expect(paths(scripts["format"]!)).toEqual(paths(scripts["format:check"]!));
  });

  it("says how much of the repository that leaves out", () => {
    const gap = says(guide, `${spell(outside.length)} tracked TypeScript and JavaScript files`);
    expect(gap, outside.length === 0 ? "the gap has closed — rewrite the section" : "recount").toBe(
      outside.length > 0,
    );
    if (outside.length === 0) return;
    const pulumi = outside.filter((path) => path.startsWith("deploy/"));
    const scriptFiles = outside.filter((path) => path.startsWith("scripts/"));
    expect(says(guide, `${spell(pulumi.length)} Pulumi modules`)).toBe(true);
    expect(says(guide, `${spell(scriptFiles.length)} scripts under`)).toBe(true);
  });

  /**
   * The five that make this a live divergence rather than a latent one.
   *
   * A scope that excludes only already-formatted files is a tidiness question.
   * A scope that excludes `scripts/set-version.mjs` — the first command the
   * release procedure runs — is the toolchain disagreeing with itself about a
   * file somebody edits under time pressure.
   */
  it("names the files outside it that a format check would reject", () => {
    let output: string;
    try {
      output = execFileSync("npx", ["oxfmt", "--check", ...outside], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }
    /*
     * Strip the colour before matching, or this check silently inverts.
     *
     * oxfmt writes the path wrapped in SGR escapes when it thinks a terminal is
     * watching, and GitHub Actions makes it think so — `FORCE_COLOR` is set for
     * the whole job. The capture then holds
     * `\x1b[38;2;244;191;117;1mscripts/set-version.mjs\x1b[0m` rather than the
     * path, so `failing.length` is still five and the count assertion above
     * still passes, while every `guide.includes()` below fails on a string the
     * guide could not possibly contain. Green on a laptop, red on CI, and the
     * failure names the five files the guide *does* name — which reads as the
     * guide being wrong when it is right.
     *
     * Not `NO_COLOR`: oxfmt ignores it, checked here with
     * `NO_COLOR=1 FORCE_COLOR=1 npx oxfmt --check`, which still colours. Not a
     * flag either — oxfmt has none. `tsc` is the comparison worth drawing:
     * `compilerReport` in `tests/typescript-guide.test.ts:197` passes
     * `--pretty false`, which is the same defence taken at the tool's own
     * offer. Where a tool makes no offer, the output has to be cleaned here.
     *
     * The escape is built rather than written, and that is not style. Spelling
     * it `/\u001B\[[\d;]*m/` puts a control character in a regex literal,
     * which is a `no-control-regex` finding — and this file is the one that
     * counts those findings and names the files they fire in, so the obvious
     * spelling makes three of its own sibling assertions fail. Taking the
     * character from `fromCharCode` keeps it out of the pattern source.
     */
    const ESCAPE = String.fromCharCode(27);
    const plain = output.replaceAll(new RegExp(`${ESCAPE}\\[[\\d;]*m`, "g"), "");
    const failing = [...plain.matchAll(/^(\S+) \(\d+ms\)$/gm)].map(([, path]) => path!);
    expect(says(guide, `${spell(failing.length)} of those files fail a`)).toBe(true);
    const unnamed = failing.filter((path) => !guide.includes(`\`${path}\``));
    expect(unnamed, "list it, or the count above is a number with nothing behind it").toEqual([]);
  });

  /**
   * And the reason the one-word widening is not available.
   *
   * oxfmt parses YAML, and the chart's templates are Go templates in YAML
   * files. `oxfmt --check .` dies on them before checking anything, which is
   * what makes "the scope has to be the TypeScript and JavaScript, or the
   * ignore file has to grow the templates" a decision rather than a typo.
   */
  it("would die on the chart templates if pointed at everything", () => {
    const templates = "deploy/helm/simple-balance/templates";
    let output = "";
    let failed = false;
    try {
      execFileSync("npx", ["oxfmt", "--check", templates], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failed = true;
      const thrown = error as { stdout?: string; stderr?: string };
      output = `${thrown.stdout ?? ""}${thrown.stderr ?? ""}`;
    }
    expect(failed, "oxfmt now reads Go templates — the argument needs rewriting").toBe(true);
    expect(output).toContain("Syntax error");
    const yaml = globSync(`${templates}/*.yaml`);
    expect(says(guide, `${spell(yaml.length)} Go-templated YAML files`)).toBe(true);
  });
});
