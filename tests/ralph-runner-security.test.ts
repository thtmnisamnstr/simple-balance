import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const runner = path.join(repositoryRoot, "scripts/ralph/runner.mjs");
const driver = path.join(repositoryRoot, "scripts/ralph/ralph.sh");
const schemaSource = path.join(repositoryRoot, "tasks/product.prd.schema.json");
const temporaryRoots: string[] = [];

const validPrd = {
  $schema: "./product.prd.schema.json",
  product: "Runner Test",
  version: "0.1.0",
  stories: [
    {
      id: "SB-001",
      priority: 10,
      title: "Contained story",
      dependsOn: [],
      networkAllowed: false,
      completed: false,
      acceptanceCriteria: ["The runner remains contained"],
      verification: ["pnpm test"],
    },
  ],
};

function temporaryDirectory(prefix: string) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryRoots.push(directory);
  return directory;
}

function createWorkspace(document: unknown = validPrd) {
  const root = temporaryDirectory("simple-balance-runner-test-");
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  mkdirSync(path.join(root, "scripts/ralph"), { recursive: true });
  mkdirSync(path.join(root, ".ralph"), { recursive: true });
  copyFileSync(schemaSource, path.join(root, "tasks/product.prd.schema.json"));
  writeFileSync(
    path.join(root, "tasks/product.prd.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  writeFileSync(path.join(root, "AGENTS.md"), "# Test agent instructions\n");
  writeFileSync(
    path.join(root, "scripts/ralph/iteration-prompt.md"),
    "Implement the selected test story.\n",
  );
  writeFileSync(path.join(root, "scripts/ralph/progress.md"), "# Progress\n");
  writeFileSync(path.join(root, "scripts/ralph/guardrails.md"), "# Guardrails\n");
  return root;
}

function createTrustedManifest(document: unknown = validPrd) {
  const trusted = temporaryDirectory("simple-balance-runner-trusted-");
  copyFileSync(schemaSource, path.join(trusted, "product.prd.schema.json"));
  writeFileSync(
    path.join(trusted, "product.prd.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  return trusted;
}

function runRunner(
  root: string,
  args: string[],
  trustedDirectory?: string,
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RALPH_WORKSPACE_ROOT: root,
  };
  delete environment.RALPH_TRUSTED_DIR;
  if (trustedDirectory) environment.RALPH_TRUSTED_DIR = trustedDirectory;
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
}

function createTrustedDriver(root: string) {
  const trusted = temporaryDirectory("simple-balance-driver-trusted-");
  const fakeBin = temporaryDirectory("simple-balance-driver-bin-");
  copyFileSync(driver, path.join(trusted, "ralph.sh"));
  copyFileSync(runner, path.join(trusted, "runner.mjs"));
  copyFileSync(
    path.join(repositoryRoot, "scripts/ralph/completion.schema.json"),
    path.join(trusted, "completion.schema.json"),
  );
  copyFileSync(
    path.join(root, "tasks/product.prd.json"),
    path.join(trusted, "product.prd.json"),
  );
  copyFileSync(
    path.join(root, "tasks/product.prd.schema.json"),
    path.join(trusted, "product.prd.schema.json"),
  );
  writeFileSync(
    path.join(trusted, "verify-in-sandbox.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  chmodSync(path.join(trusted, "verify-in-sandbox.sh"), 0o700);
  writeFileSync(
    path.join(trusted, "git-guard.mjs"),
    [
      'const command = process.argv[2];',
      'if (command === "commit") {',
      '  console.error("forced story commit failure");',
      "  process.exit(27);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/bin/sh",
      "set -eu",
      'output=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--output-last-message" ]; then',
      "    shift",
      "    output=$1",
      "  fi",
      "  shift",
      "done",
      '[ -n "$output" ]',
      "printf '%s\\n' '{\"storyId\":\"SB-001\",\"status\":\"completed\",\"summary\":\"done\",\"learnings\":[]}' > \"$output\"",
      "printf '%s\\n' 'implementation survives' > implementation.txt",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(fakeBin, "codex"), 0o700);
  return { trusted, fakeBin };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("trusted Ralph runner", () => {
  it("snapshots the PRD and schema before Codex and restores them afterward", () => {
    const driver = readFileSync(
      path.join(repositoryRoot, "scripts/ralph/ralph.sh"),
      "utf8",
    );
    const prdSnapshot = driver.indexOf(
      'cp "$WORKSPACE_ROOT/tasks/product.prd.json" "$TRUSTED_DIR/product.prd.json"',
    );
    const schemaSnapshot = driver.indexOf(
      'cp "$WORKSPACE_ROOT/tasks/product.prd.schema.json" "$TRUSTED_DIR/product.prd.schema.json"',
    );
    const codex = driver.indexOf("codex --ask-for-approval never exec");
    const restore = driver.indexOf('node "$RUNNER" restore');

    expect(prdSnapshot).toBeGreaterThan(0);
    expect(schemaSnapshot).toBeGreaterThan(prdSnapshot);
    expect(codex).toBeGreaterThan(schemaSnapshot);
    expect(restore).toBeGreaterThan(codex);
  });

  it("checks Git identity before invoking Codex", () => {
    const driverText = readFileSync(driver, "utf8");
    const identityPreflight = driverText.indexOf(
      "Git user.name and user.email must be configured before starting Ralph.",
    );
    const codex = driverText.indexOf("codex --ask-for-approval never exec");

    expect(identityPreflight).toBeGreaterThan(0);
    expect(codex).toBeGreaterThan(identityPreflight);
  });

  it("fails the real loop before Codex when Git identity is missing", () => {
    const root = createWorkspace();
    const { trusted, fakeBin } = createTrustedDriver(root);
    const result = spawnSync("/bin/sh", [path.join(trusted, "ralph.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        RALPH_TRUSTED_DRIVER: "true",
        RALPH_TRUSTED_DIR: trusted,
        RALPH_WORKSPACE_ROOT: root,
        RALPH_GIT_EXECUTABLE: "/usr/bin/git",
        RALPH_GIT_DIRECTORY: path.join(root, ".git"),
        RALPH_GIT_COMMON_DIRECTORY: path.join(root, ".git"),
        RALPH_GIT_AUTHOR_NAME: "",
        RALPH_GIT_AUTHOR_EMAIL: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Git user.name and user.email must be configured before starting Ralph.",
    );
    expect(existsSync(path.join(root, "implementation.txt"))).toBe(false);
  });

  it("rejects a traversal story ID through the tracked PRD schema", () => {
    const root = createWorkspace({
      ...validPrd,
      stories: [
        {
          ...validPrd.stories[0],
          id: "escape/../../../../../../../tmp/owned",
        },
      ],
    });

    const result = runRunner(root, ["status"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PRD schema validation failed");
    expect(result.stderr).toContain("^SB-[0-9]{3}$");
  });

  it("rejects dependency cycles instead of treating blocked stories as complete", () => {
    const root = createWorkspace({
      ...validPrd,
      stories: [
        { ...validPrd.stories[0], id: "SB-001", dependsOn: ["SB-002"] },
        { ...validPrd.stories[0], id: "SB-002", dependsOn: ["SB-001"] },
      ],
    });

    const result = runRunner(root, ["next"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dependency cycle");
  });

  it("writes a valid prompt only below the real .ralph directory", () => {
    const root = createWorkspace();

    const result = runRunner(root, ["prompt", "SB-001"]);
    const expected = path.join(root, ".ralph/prompt-SB-001.md");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(readFileSync(expected, "utf8")).toContain('"id": "SB-001"');
  });

  it("refuses a symlinked prompt directory instead of writing through it", () => {
    const root = createWorkspace();
    const outside = temporaryDirectory("simple-balance-runner-outside-");
    rmSync(path.join(root, ".ralph"), { recursive: true });
    symlinkSync(outside, path.join(root, ".ralph"), "dir");

    const result = runRunner(root, ["prompt", "SB-001"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be a real directory");
    expect(readFileSync(path.join(root, "tasks/product.prd.json"), "utf8")).toContain(
      '"id": "SB-001"',
    );
  });

  it("uses and restores the immutable trusted manifest after workspace tampering", () => {
    const root = createWorkspace();
    const trusted = createTrustedManifest();
    const trustedPrd = readFileSync(path.join(trusted, "product.prd.json"), "utf8");
    const trustedSchema = readFileSync(
      path.join(trusted, "product.prd.schema.json"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "tasks/product.prd.json"),
      JSON.stringify({
        ...validPrd,
        stories: [
          {
            ...validPrd.stories[0],
            id: "escape/../../../../../../../tmp/owned",
            networkAllowed: true,
          },
        ],
      }),
    );
    writeFileSync(path.join(root, "tasks/product.prd.schema.json"), "{}\n");

    const next = runRunner(root, ["next"], trusted);
    const restored = runRunner(root, ["restore"], trusted);

    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      id: "SB-001",
      networkAllowed: false,
    });
    expect(restored.status).toBe(0);
    expect(readFileSync(path.join(root, "tasks/product.prd.json"), "utf8")).toBe(
      trustedPrd,
    );
    expect(
      readFileSync(path.join(root, "tasks/product.prd.schema.json"), "utf8"),
    ).toBe(trustedSchema);
  });

  it("refuses to restore through a workspace PRD symlink", () => {
    const root = createWorkspace();
    const trusted = createTrustedManifest();
    const outside = temporaryDirectory("simple-balance-runner-sentinel-");
    const sentinel = path.join(outside, "sentinel.json");
    writeFileSync(sentinel, "do not overwrite\n");
    rmSync(path.join(root, "tasks/product.prd.json"));
    symlinkSync(sentinel, path.join(root, "tasks/product.prd.json"));

    const result = runRunner(root, ["restore"], trusted);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a symbolic link");
    expect(readFileSync(sentinel, "utf8")).toBe("do not overwrite\n");
  });

  it("finalizes trusted completion state only after the commit gate", () => {
    const root = createWorkspace();
    const trusted = createTrustedManifest();
    const completionPath = path.join(root, ".ralph/final.json");
    writeFileSync(
      completionPath,
      JSON.stringify({
        storyId: "SB-001",
        status: "completed",
        summary: "Completed safely",
        learnings: [],
      }),
    );

    const prepared = runRunner(
      root,
      ["prepare-complete", "SB-001", completionPath],
      trusted,
    );
    const pendingNext = runRunner(root, ["next"], trusted);
    const preparedWorkspacePrd = JSON.parse(
      readFileSync(path.join(root, "tasks/product.prd.json"), "utf8"),
    );
    const pendingTrustedPrd = JSON.parse(
      readFileSync(path.join(trusted, "product.prd.json"), "utf8"),
    );

    expect(prepared.status).toBe(0);
    expect(pendingNext.status).toBe(0);
    expect(JSON.parse(pendingNext.stdout)).toMatchObject({ id: "SB-001" });
    expect(preparedWorkspacePrd.stories[0]).toMatchObject({
      id: "SB-001",
      completed: true,
      networkAllowed: false,
    });
    expect(pendingTrustedPrd.stories[0].completed).toBe(false);

    const finalized = runRunner(
      root,
      ["finalize-complete", "SB-001"],
      trusted,
    );
    const next = runRunner(root, ["next"], trusted);
    const trustedPrd = JSON.parse(
      readFileSync(path.join(trusted, "product.prd.json"), "utf8"),
    );

    expect(finalized.status, finalized.stderr).toBe(0);
    expect(next.status).toBe(0);
    expect(next.stdout.trim()).toBe("null");
    expect(trustedPrd).toEqual(preparedWorkspacePrd);
  });

  it("rolls prepared completion back without discarding implementation work", () => {
    const root = createWorkspace();
    const trusted = createTrustedManifest();
    const completionPath = path.join(root, ".ralph/final.json");
    const progressPath = path.join(root, "scripts/ralph/progress.md");
    const originalProgress = readFileSync(progressPath, "utf8");
    writeFileSync(path.join(root, "implementation.txt"), "preserve me\n");
    writeFileSync(
      completionPath,
      JSON.stringify({
        storyId: "SB-001",
        status: "completed",
        summary: "Prepared but not committed",
        learnings: ["Rollback only harness-owned state"],
      }),
    );

    const prepared = runRunner(
      root,
      ["prepare-complete", "SB-001", completionPath],
      trusted,
    );
    const rolledBack = runRunner(
      root,
      ["rollback-complete", "SB-001"],
      trusted,
    );
    const workspacePrd = JSON.parse(
      readFileSync(path.join(root, "tasks/product.prd.json"), "utf8"),
    );
    const trustedPrd = JSON.parse(
      readFileSync(path.join(trusted, "product.prd.json"), "utf8"),
    );

    expect(prepared.status, prepared.stderr).toBe(0);
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    expect(workspacePrd.stories[0].completed).toBe(false);
    expect(trustedPrd.stories[0].completed).toBe(false);
    expect(readFileSync(progressPath, "utf8")).toBe(originalProgress);
    expect(readFileSync(path.join(root, "implementation.txt"), "utf8")).toBe(
      "preserve me\n",
    );
  });

  it("rolls completion back when the story-scoped commit is forced to fail", () => {
    const root = createWorkspace();
    const { trusted, fakeBin } = createTrustedDriver(root);
    const result = spawnSync("/bin/sh", [path.join(trusted, "ralph.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        RALPH_TRUSTED_DRIVER: "true",
        RALPH_TRUSTED_DIR: trusted,
        RALPH_WORKSPACE_ROOT: root,
        RALPH_GIT_EXECUTABLE: "/usr/bin/git",
        RALPH_GIT_DIRECTORY: path.join(root, ".git"),
        RALPH_GIT_COMMON_DIRECTORY: path.join(root, ".git"),
        RALPH_GIT_AUTHOR_NAME: "Ralph Test",
        RALPH_GIT_AUTHOR_EMAIL: "ralph-test@example.invalid",
      },
    });
    const workspacePrd = JSON.parse(
      readFileSync(path.join(root, "tasks/product.prd.json"), "utf8"),
    );
    const trustedPrd = JSON.parse(
      readFileSync(path.join(trusted, "product.prd.json"), "utf8"),
    );
    const progress = readFileSync(
      path.join(root, "scripts/ralph/progress.md"),
      "utf8",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("forced story commit failure");
    expect(result.stderr).toContain("completion state was rolled back");
    expect(workspacePrd.stories[0].completed).toBe(false);
    expect(trustedPrd.stories[0].completed).toBe(false);
    expect(progress).toContain("story commit exited with 27");
    expect(progress).not.toContain("SB-001 passed:");
    expect(existsSync(path.join(root, "implementation.txt"))).toBe(true);
    expect(readFileSync(path.join(root, "implementation.txt"), "utf8")).toBe(
      "implementation survives\n",
    );
  });
});
