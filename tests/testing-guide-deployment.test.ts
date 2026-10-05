import { describe, expect, it } from "vitest";
import { repoFiles, sourceFiles } from "./support/source.js";

/**
 * The split 1.3 of `docs/standards/code/testing.md` describes, held from both
 * sides.
 *
 * Deployment material is read as text in the node tier and rendered by the real
 * tool in CI, and the two halves fail differently: a template that renders
 * nothing satisfies every text check written about it, and a template whose
 * program deletes in the wrong order renders perfectly. So neither half is
 * allowed to quietly become the only one.
 *
 * The half this file can see directly is that nothing here shells out to the
 * tool. The half it cannot is the render, so what is held instead is that the
 * workflow still runs it — without that, deleting the job would leave the text
 * checks green and nobody looking at a chart again until somebody installed it.
 */
const TOOLS = ["helm", "kubectl", "pulumi", "docker"] as const;

/**
 * Every `.test.ts` and `.test.tsx` under `tests/`, discovered rather than
 * listed, and carrying its comments blanked as well as written: the sentence
 * above this one names three of the four tools and is not running any of them.
 */
const testFiles = sourceFiles("tests").filter((file) => /\.test\.tsx?$/.test(file.path));

/** Those that read something out of `deploy/`, which is the population 1.3 is about. */
const deploymentReaders = testFiles.filter((file) => file.text.includes("deploy/"));

describe("deployment material in the node tier", () => {
  it("is read by tests that exist, including the chart's own", () => {
    // The population before the claim, which is 2.6. A sweep that stopped
    // matching would pass the assertion below over nothing at all.
    expect(deploymentReaders.length).toBeGreaterThanOrEqual(10);
    expect(deploymentReaders.map((file) => file.path)).toContain("tests/helm-shapes.test.ts");
  });

  it("is never rendered or applied by a test", () => {
    // `sh` and `node` are fair game and four of these files use them — a shell
    // script is checked by running it, and `set-version` is checked by letting
    // it write into a scratch tree. What is refused is the deployment tool
    // itself: it is not on this job's PATH, so a test reaching for it would be
    // green on whoever's laptop has it and red in CI, which is worse than the
    // gap it was trying to close.
    const running: string[] = [];
    for (const file of testFiles) {
      for (const [index, line] of file.code.split("\n").entries()) {
        for (const tool of TOOLS) {
          // The command, not a mention of it. Matching the tool name anywhere
          // on a line that also calls something named `exec` read a regex
          // pulling `helm.sh/hook-weight` out of a rendered document as a test
          // running helm, which is the opposite of what that file does.
          const invocation = new RegExp(
            `(?:execSync|execFileSync|spawnSync|spawn)\\(\\s*["'\`]${tool}\\b`,
          );
          if (invocation.test(line)) running.push(`${file.path}:${index + 1} runs ${tool}`);
        }
      }
    }
    expect(running).toEqual([]);
  });
});

describe("the render that happens where the tool is", () => {
  const workflow = repoFiles((path) => path === ".github/workflows/verify.yml")[0];

  it("still lints and templates the chart in CI", () => {
    expect(workflow, "verify.yml is where the deployment job lives").toBeDefined();
    const text = workflow!.text;
    expect(text).toContain("helm lint /charts/simple-balance");
    // A floor rather than a count, because this is guarding the existence of
    // the other half rather than auditing what it renders. Each render exists
    // because something it covers is off at default values and so is reached by
    // no other one.
    const renders = [...text.matchAll(/helm template release/g)].length;
    expect(renders).toBeGreaterThanOrEqual(4);
  });

  it("renders the shapes the text checks only read", () => {
    const text = workflow!.text;
    // `helm-shapes.test.ts` holds that `database.enabled` defaults to false and
    // that the two documented shapes set what they set. Nothing in this
    // repository can say that turning it on produces one StatefulSet per Citus
    // group — only a render can, and this is where it happens.
    expect(text).toContain("--set database.enabled=true");
    expect(text).toContain("--set networkPolicy.enabled=true");
  });
});
