import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blankComments, repoRoot, sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/typescript.md`, held against the two programs it is
 * about.
 *
 * Several of its rules read as repository-wide and are checked in the
 * application source alone, and two of those are false in the other half: 3.1
 * asks every relative import to end in `.js`, and all fifteen under
 * `deploy/pulumi` drop the extension because that project resolves CommonJS.
 * The application source is clean, which is the shape somebody sweeps
 * mechanically and breaks.
 *
 * So the populations are discovered here rather than listed, in the sense
 * `tests/support/source.ts:88-106` argues for, and the few genuine exceptions —
 * the four casts in 2.2 and 2.6, the eight files 1.4 names — are written down,
 * named and argued, which is what an exception is allowed to be.
 *
 * The numbers are read out of the guide and compared with the tree, rather than
 * restated here. A check carrying its own copy of a rule is a second place for
 * the rule to drift, which is the defect this guide set exists to prevent.
 */
const GUIDE_PATH = "docs/standards/code/typescript.md";
const GUIDE = readFileSync(path.join(repoRoot, GUIDE_PATH), "utf8");

/** One `### n.m …` section of the guide, body only. */
const section = (number: string): string => {
  const start = GUIDE.indexOf(`### ${number} `);
  expect(start, `${GUIDE_PATH} has no section ${number}`).toBeGreaterThan(-1);
  const stop = ["\n### ", "\n## "]
    .map((marker) => GUIDE.indexOf(marker, start + 1))
    .filter((at) => at > -1);
  return GUIDE.slice(start, stop.length > 0 ? Math.min(...stop) : GUIDE.length);
};

const json = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8")) as Record<string, unknown>;

const options = (relative: string): Record<string, unknown> =>
  (json(relative).compilerOptions ?? {}) as Record<string, unknown>;

const scripts = (relative: string): Record<string, string> =>
  (json(relative).scripts ?? {}) as Record<string, string>;

const ROOT_TSCONFIG = "tsconfig.json";
const PULUMI = "deploy/pulumi";
const PULUMI_TSCONFIG = `${PULUMI}/tsconfig.json`;

/** The few counts the guide spells rather than digits, so a cell can be read. */
const WORDS: Record<string, number> = { three: 3, four: 4, eight: 8, fifteen: 15 };

/**
 * Every `.ts` under `deploy/pulumi`, its own `node_modules` left unwalked.
 *
 * Not `sourceFiles`, which has no way to skip a directory: that install carries
 * thousands of `.d.ts` files, every one of which matches, so filtering the
 * result afterwards gives the right answer having read the wrong tree.
 */
const infrastructureFiles = (): { path: string; text: string; code: string }[] => {
  const found: { path: string; text: string; code: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(full, "utf8");
      found.push({
        path: path.relative(repoRoot, full).split(path.sep).join("/"),
        text,
        code: blankComments(text),
      });
    }
  };
  walk(path.join(repoRoot, PULUMI));
  return found;
};

/**
 * Every relative import specifier in a file, with the line it is on.
 *
 * Read off the comment-blanked copy, because `docs/standards/code/comments.md`
 * asks for a density at which `"../single-common/cloud-init"` appears in prose
 * as often as in code — `deploy/pulumi/single-common/cloud-init.ts:12` names a
 * sibling module inside a paragraph explaining why the test suite cannot import
 * the one beside it.
 */
const relativeImports = (code: string): { specifier: string; line: number }[] => {
  const found: { specifier: string; line: number }[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)"(\.[^"]*)"/g;
  for (const match of code.matchAll(pattern)) {
    found.push({ specifier: match[1]!, line: code.slice(0, match.index).split("\n").length });
  }
  return found;
};

/** Extensions a runtime resolves without help. `.js` is the common one. */
const RUNTIME_EXTENSION = /\.(js|jsx|mjs|cjs|json|css|svg|png|webp)$/;

/**
 * A relative specifier as the root program resolves it: `./x.js` is `./x.ts`,
 * `./x.mjs` is the `./x.d.mts` beside it, and an extension-less one — which is
 * every relative import in the infrastructure programs — is `./x.ts`.
 */
function resolveSpecifier(from: string, specifier: string): string | null {
  const base = path.join(from, specifier).split(path.sep).join("/");
  const candidates = base.endsWith(".mjs")
    ? [base.replace(/\.mjs$/, ".d.mts")]
    : /\.jsx?$/.test(base)
      ? [base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx")]
      : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((one) => existsSync(path.join(repoRoot, one))) ?? null;
}

describe("1.2 every construct erases, in both programs", () => {
  /**
   * The application half is the compiler's: `erasableSyntaxOnly` fires TS1294 on
   * the syntax itself. The infrastructure programs do not set the flag and erase
   * anyway, which is luck, and this is the half that turns it into enforcement.
   *
   * Read off the source rather than run through their compiler, because that
   * compiler needs `deploy/pulumi/node_modules` and the job running this suite
   * does not install it — the constraint `tests/support/pulumi-source.ts:10-13`
   * is built around.
   */
  const NON_ERASABLE: { what: string; pattern: RegExp }[] = [
    { what: "an enum", pattern: /(?:^|[\s;{}])(?:const\s+)?enum\s+[A-Za-z_$]/ },
    { what: "a namespace", pattern: /(?:^|[\s;{}])(?:namespace|module)\s+[A-Za-z_$][\w$]*\s*\{/ },
    // A parameter property is a modifier inside the constructor's own
    // parentheses. The alternative — any modifier anywhere after `constructor` —
    // reads the body too and calls a `private` field declared below it one.
    {
      what: "a constructor parameter property",
      pattern: /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+[A-Za-z_$]/,
    },
    {
      what: "an import-equals",
      pattern: /(?:^|[\s;{}])import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/,
    },
  ];

  it("holds in the infrastructure programs, which nothing refuses it in", () => {
    const offences: string[] = [];
    for (const file of infrastructureFiles()) {
      for (const { what, pattern } of NON_ERASABLE) {
        const match = pattern.exec(file.code);
        if (match === null) continue;
        offences.push(`${file.path}:${file.code.slice(0, match.index).split("\n").length} ${what}`);
      }
    }
    expect(
      offences,
      "deploy/pulumi does not set erasableSyntaxOnly, so this is the only refusal",
    ).toEqual([]);
  });

  it("is checked by the flag in the application program", () => {
    expect(options(ROOT_TSCONFIG).erasableSyntaxOnly).toBe(true);
    // The flag is absent there, which is what makes the case above a check
    // rather than a second copy of the compiler's.
    expect(options(PULUMI_TSCONFIG).erasableSyntaxOnly).toBeUndefined();
  });
});

/**
 * One compiler run answering both 1.3 and the `src` half of 1.4.
 *
 * Two flags in one invocation rather than two invocations, because each costs
 * about three seconds. They do interact — the whole-program
 * `noUncheckedIndexedAccess` count is one higher with `noImplicitReturns` also
 * on — but the interaction is in `tests`, and the `src` count asserted below is
 * the same either way. If that stops being true the number moves and this
 * comment is where to start.
 *
 * `npx tsc` rather than a path into `node_modules`, so the command run here is
 * the command 1.4 documents for taking the reading by hand.
 */
const compilerReport = (): string => {
  try {
    return execFileSync(
      "npx",
      [
        "tsc",
        "-p",
        ROOT_TSCONFIG,
        "--noEmit",
        "--noUncheckedIndexedAccess",
        "--noImplicitReturns",
        "--pretty",
        "false",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    // A finding is a non-zero exit, so the status says nothing useful and the
    // captured output is the whole signal. Same shape as
    // `tests/no-explicit-any.test.ts:36-45`.
    return String((error as { stdout?: string }).stdout ?? "");
  }
};

type Diagnostic = { file: string; line: number; code: string };

const diagnostics = (report: string): Diagnostic[] =>
  [...report.matchAll(/^(\S+?)\((\d+),\d+\): error (TS\d+):/gm)].map((match) => ({
    file: match[1]!.split(path.sep).join("/"),
    line: Number(match[2]),
    code: match[3]!,
  }));

describe("1.3 and 1.4, the two declined flags with a measurement in them", () => {
  const found = diagnostics(compilerReport());

  it("reports exactly the three middleware sites 1.3 cites", () => {
    // `:887` is a continuation citation — the file is whatever was named last —
    // so the section is read in document order, the way
    // `tests/standards-citations.test.ts` resolves the same shape.
    let file = "";
    const cited: string[] = [];
    for (const match of section("1.3").matchAll(/`(src\/[\w./-]+)?:(\d+)`/g)) {
      if (match[1] !== undefined) file = match[1];
      if (file !== "") cited.push(`${file}:${match[2]}`);
    }
    const sites = found
      .filter((one) => one.code === "TS7030")
      .map((one) => `${one.file}:${one.line}`);
    expect(sites.length, "1.3 argues from there being three and only three").toBe(3);
    expect(sites.sort()).toEqual([...new Set(cited)].sort());
  });

  it("finds in `src` the number 1.4 states for `src`", () => {
    const claimed = /\*\*(\d+) of them in `src`\*\*/.exec(section("1.4"));
    expect(claimed, "1.4 no longer states the src half in the shape this reads").not.toBeNull();
    const inSrc = found.filter((one) => one.file.startsWith("src/") && one.code !== "TS7030");
    expect(inSrc.length, "adopting the flag one directory at a time starts here").toBe(
      Number(claimed![1]),
    );
  });

  /**
   * What `-p tsconfig.json` covers is the include list plus whatever it reaches:
   * the compiler follows an import past it. The suite imports three
   * infrastructure modules to render cloud-init, and five `.d.mts` siblings of
   * the `scripts/` modules it exercises, so all eight are inside every number
   * 1.4 quotes — two of its `exactOptionalPropertyTypes` errors are in the
   * first three.
   */
  it("reads exactly the eight first-party files outside src and tests that 1.4 names", () => {
    const declared = ((json(ROOT_TSCONFIG).include ?? []) as string[]).filter((one) =>
      /\.tsx?$/.test(one),
    );
    const seen = new Set<string>();
    const outside = new Set<string>();
    const queue = [...sourceFiles("src"), ...sourceFiles("tests")]
      .map((file) => file.path)
      .concat(declared);
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const absolute = path.join(repoRoot, current);
      if (!existsSync(absolute)) continue;
      if (!current.startsWith("src/") && !current.startsWith("tests/") && current.includes("/")) {
        outside.add(current);
      }
      for (const { specifier } of relativeImports(readFileSync(absolute, "utf8"))) {
        const resolved = resolveSpecifier(path.dirname(current), specifier);
        if (resolved !== null) queue.push(resolved);
      }
    }
    expect([...outside].sort()).toEqual([
      "deploy/pulumi/aws-single/platform.ts",
      "deploy/pulumi/oci-single/platform.ts",
      "deploy/pulumi/single-common/cloud-init.ts",
      "scripts/capacity/cohorts.d.mts",
      "scripts/capacity/measure.d.mts",
      "scripts/capacity/schedule.d.mts",
      "scripts/capacity/verify.d.mts",
      "scripts/product-kit/entry-key.d.mts",
    ]);
  });
});

describe("2.2 and 2.6, the four casts", () => {
  /**
   * The exception register the two sections argue from. Three are 2.6's pattern
   * — one property, at a vendor's type boundary — and the fourth is the internal
   * row shape 2.2 records. A fifth fails here until somebody says which of the
   * two it is, which is the point: a count alone cannot tell them apart, and a
   * count alone is what let three of these arrive unargued.
   */
  const REGISTER: { where: string; property: string; boundary: boolean }[] = [
    { where: "src/client/ads.tsx", property: "requestNonPersonalizedAds", boundary: true },
    { where: "src/server/services/accounts.ts", property: "", boundary: false },
    { where: "src/server/stripe.ts", property: "current_period_end", boundary: true },
    { where: "src/shared/domain.ts", property: "pattern", boundary: true },
  ];

  /**
   * The braced run starting at `from`, or null if that is not a brace.
   *
   * Counted rather than matched to the next `}`, because the asserted type and
   * the literal being cast both nest: stopping at the first close reads
   * `{ a: { b: 1 }, c: 2 }` as one property and misses the second, which is the
   * very thing this section is about.
   */
  const braced = (text: string, from: number): string | null => {
    if (text[from] !== "{") return null;
    let depth = 0;
    for (let at = from; at < text.length; at += 1) {
      if (text[at] === "{") depth += 1;
      if (text[at] === "}") depth -= 1;
      if (depth === 0) return text.slice(from, at + 1);
    }
    return null;
  };

  /** The braced run ending at `to`, scanning back to its own open brace. */
  const bracedBefore = (text: string, to: number): string | null => {
    const close = text.lastIndexOf("}", to);
    if (close === -1 || text.slice(close + 1, to + 1).trim() !== "") return null;
    let depth = 0;
    for (let at = close; at >= 0; at -= 1) {
      if (text[at] === "}") depth += 1;
      if (text[at] === "{") depth -= 1;
      if (depth === 0) return text.slice(at, close + 1);
    }
    return null;
  };

  const casts = () =>
    sourceFiles("src").flatMap((file) =>
      [...file.code.matchAll(/\bas\s+unknown\s+as\s+/g)].map((match) => {
        const after = match.index + match[0].length;
        return {
          where: file.path,
          asserted:
            braced(file.code, after) ?? /^[^;,)\n]+/.exec(file.code.slice(after))![0].trim(),
          value: bracedBefore(file.code, match.index - 1),
        };
      }),
    );

  it("are the four the guide records, and no others", () => {
    expect(
      casts()
        .map((one) => one.where)
        .sort(),
    ).toEqual(REGISTER.map((one) => one.where).sort());
  });

  /**
   * One property, either in the type asserted — Stripe's and Google's — or in
   * the literal being cast, which is Zod's: there the published type is already
   * `Record<string, string>` and the fact it cannot express is that one key's
   * value is `undefined`. Both spellings confine the cast to a single name, and
   * that is what 2.6 asks for.
   */
  it("each confine themselves to the one property 2.6 names", () => {
    const properties = (text: string) =>
      [...text.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((match) => match[1]!);
    for (const entry of REGISTER.filter((one) => one.boundary)) {
      const cast = casts().find((one) => one.where === entry.where);
      expect(cast, `${entry.where} no longer holds the cast 2.6 records`).toBeDefined();
      const confined = cast!.asserted.startsWith("{") ? cast!.asserted : cast!.value;
      expect(
        confined,
        `${entry.where} asserts ${cast!.asserted} over nothing braced`,
      ).not.toBeNull();
      expect(properties(confined!), `${entry.where}: ${confined}`).toEqual([entry.property]);
    }
  });

  it("are each named in 2.6's table, with the property they add", () => {
    const table = section("2.6");
    for (const entry of REGISTER.filter((one) => one.boundary)) {
      expect(table, `2.6 does not cite ${entry.where}`).toContain(entry.where);
      expect(table, `2.6 does not name ${entry.property}`).toContain(entry.property);
    }
  });
});

describe("3.1 the two import conventions, each as a population", () => {
  it("has every relative import in src and tests carrying a runtime extension", () => {
    const bare: string[] = [];
    for (const file of [...sourceFiles("src"), ...sourceFiles("tests")]) {
      for (const { specifier, line } of relativeImports(file.code)) {
        if (!RUNTIME_EXTENSION.test(specifier)) bare.push(`${file.path}:${line} ${specifier}`);
      }
    }
    expect(bare, "dropping the extension breaks `npm run build:server` and nothing else").toEqual(
      [],
    );
  });

  it("has every relative import in the infrastructure programs carrying none", () => {
    const extended: string[] = [];
    let total = 0;
    for (const file of infrastructureFiles()) {
      for (const { specifier, line } of relativeImports(file.code)) {
        total += 1;
        if (RUNTIME_EXTENSION.test(specifier)) extended.push(`${file.path}:${line} ${specifier}`);
      }
    }
    expect(extended, "deploy/pulumi resolves CommonJS; an extension there is the mistake").toEqual(
      [],
    );
    const claimed = /All (\w+) relative\s*\n?imports under `deploy\/pulumi`/.exec(section("3.1"));
    expect(claimed, "3.1 no longer states the count in the shape this reads").not.toBeNull();
    expect(WORDS[claimed![1]!], `3.1 says "${claimed![1]}" and there are ${total}`).toBe(total);
  });
});

describe("3.5 the infrastructure programs are a second TypeScript program", () => {
  const guide = section("3.5");
  /** One row of 3.5's table, by the text of its first cell. */
  const row = (label: string): string => {
    const line = guide.split("\n").find((one) => one.startsWith(`| ${label} |`));
    expect(line, `3.5 has no row for ${label}`).toBeDefined();
    return line!;
  };
  const backticked = (text: string): string[] =>
    [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

  it("is not inside the application's program", () => {
    const include = (json(ROOT_TSCONFIG).include ?? []) as string[];
    expect(include.some((one) => one.startsWith("deploy"))).toBe(false);
    // Nor the server build's, which is the one that emits.
    const server = (json("tsconfig.server.json").include ?? []) as string[];
    expect(server.every((one) => one.startsWith("src/"))).toBe(true);
  });

  it("pins its own compiler, for a module resolution the newer one removed", () => {
    const root = (json("package.json").devDependencies as Record<string, string>).typescript!;
    const theirs = (json(`${PULUMI}/package.json`).devDependencies as Record<string, string>)
      .typescript!;
    const major = (range: string) => Number(/(\d+)\./.exec(range)![1]);
    expect(major(theirs), "TypeScript 7 answers TS5108 to moduleResolution node").toBeLessThan(
      major(root),
    );
    expect(options(PULUMI_TSCONFIG).moduleResolution).toBe("node");
    expect(options(ROOT_TSCONFIG).moduleResolution).toBe("Bundler");
  });

  it("holds the flag rows of 3.5's table against the two configurations", () => {
    for (const flag of backticked(row("Declined here, on there"))) {
      expect(options(PULUMI_TSCONFIG)[flag], `${flag} is off in ${PULUMI_TSCONFIG}`).toBe(true);
      expect(options(ROOT_TSCONFIG)[flag], `${flag} is on in ${ROOT_TSCONFIG}`).toBeUndefined();
    }
    for (const flag of backticked(row("On here, absent there")).map((one) => one.split(":")[0]!)) {
      expect(options(ROOT_TSCONFIG)[flag], `${flag} is off in ${ROOT_TSCONFIG}`).toBeDefined();
      expect(options(PULUMI_TSCONFIG)[flag], `${flag} is on in ${PULUMI_TSCONFIG}`).toBeUndefined();
    }
  });

  it("typechecks every stack it ships, and nothing at the root runs it", () => {
    const stacks = readdirSync(path.join(repoRoot, PULUMI), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .filter((entry) => existsSync(path.join(repoRoot, PULUMI, entry.name, "Pulumi.yaml")))
      .map((entry) => entry.name)
      .sort();
    const theirs = scripts(`${PULUMI}/package.json`).typecheck ?? "";
    // A stack added without a line here is first-party TypeScript that no
    // compiler reads, and nothing at the root would notice.
    for (const stack of stacks)
      expect(theirs, `${stack} is not typechecked`).toContain(`${stack}/`);
    const claimed = /(\w+) projects \|$/.exec(row("Typecheck"));
    expect(claimed, "3.5's Typecheck row no longer states the project count").not.toBeNull();
    expect(WORDS[claimed![1]!]).toBe(stacks.length);

    const ours = scripts("package.json");
    expect(
      ours.typecheck,
      "npm run typecheck reaches two projects, both at the root",
    ).not.toContain("deploy");
    expect(ours.verify).not.toContain("deploy");
    expect(ours.format, "3.5 records the formatter as not covering it").not.toContain("deploy");
    expect(
      readFileSync(path.join(repoRoot, ".github/workflows/verify.yml"), "utf8"),
      "CI is where the second typecheck runs",
    ).toContain(`working-directory: ${PULUMI}`);
  });

  it("resolves vendor SDKs the application never ships", () => {
    const theirs = Object.keys(json(`${PULUMI}/package.json`).dependencies as object);
    const ours = Object.keys(json("package.json").dependencies as object);
    expect(theirs.every((one) => one.startsWith("@pulumi/"))).toBe(true);
    expect(ours.filter((one) => one.startsWith("@pulumi/"))).toEqual([]);
    const claimed = /resolve (\w+) vendor SDKs/.exec(guide);
    expect(claimed, "3.5 no longer states how many").not.toBeNull();
    expect(WORDS[claimed![1]!]).toBe(theirs.length);
  });

  it("is the size 3.5 says it is", () => {
    const lines = infrastructureFiles().reduce(
      (total, file) => total + file.text.split("\n").length - 1,
      0,
    );
    const claimed = /`deploy\/pulumi` is ([\d,]+) lines/.exec(guide);
    expect(claimed, "3.5 no longer states the size").not.toBeNull();
    // A number in prose is recounted by whoever happens to, which is nobody.
    // This one moves only when a program is added or a large block written, so
    // being made to edit the page is the point rather than the friction.
    expect(Number(claimed![1]!.replaceAll(",", ""))).toBe(lines);
  });
});
