import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
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

const guard = path.resolve("scripts/ralph/git-guard.mjs");
const gitExecutable = realpathSync(
  process.env.PATH!.split(path.delimiter)
    .map((directory) => path.join(directory, "git"))
    .find((candidate) => existsSync(candidate))!,
);
const temporaryRoots: string[] = [];

function git(root: string, args: string[]) {
  return spawnSync(gitExecutable, args, {
    cwd: root,
    encoding: "utf8",
  });
}

function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "simple-balance-git-guard-")),
  );
  temporaryRoots.push(root);
  const initialized = git(root, ["init", "--quiet"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  const gitDirectory = realpathSync(path.join(root, ".git"));
  const trusted = path.join(root, "trusted");
  mkdirSync(trusted);
  const manifest = path.join(trusted, "git-state.json");
  const snapshot = spawnSync(
    process.execPath,
    [
      guard,
      "snapshot",
      root,
      gitDirectory,
      gitDirectory,
      gitExecutable,
      manifest,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(snapshot.status, snapshot.stderr).toBe(0);
  return { root, gitDirectory, manifest };
}

function guardedCommit(
  fixture_: ReturnType<typeof fixture>,
  message = "guarded commit",
) {
  return spawnSync(
    process.execPath,
    [
      guard,
      "commit",
      fixture_.root,
      fixture_.gitDirectory,
      fixture_.gitDirectory,
      gitExecutable,
      fixture_.manifest,
      "Ralph Test",
      "ralph-test@example.invalid",
      message,
    ],
    { cwd: fixture_.root, encoding: "utf8" },
  );
}

function refreshSnapshot(fixture_: ReturnType<typeof fixture>) {
  return spawnSync(
    process.execPath,
    [
      guard,
      "refresh",
      fixture_.root,
      fixture_.gitDirectory,
      fixture_.gitDirectory,
      gitExecutable,
      fixture_.manifest,
    ],
    { cwd: fixture_.root, encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Ralph Git guard", () => {
  it("stages and commits ordinary story changes with sanitized Git settings", () => {
    const testRepository = fixture();
    writeFileSync(path.join(testRepository.root, "result.txt"), "verified\n");

    const committed = guardedCommit(testRepository);
    const subject = git(testRepository.root, ["log", "-1", "--pretty=%s"]);

    expect(committed.status, committed.stderr).toBe(0);
    expect(subject.status, subject.stderr).toBe(0);
    expect(subject.stdout.trim()).toBe("guarded commit");
  });

  it("refreshes the trusted metadata baseline after a guarded commit", () => {
    const testRepository = fixture();
    writeFileSync(path.join(testRepository.root, "first.txt"), "first\n");
    expect(guardedCommit(testRepository, "first").status).toBe(0);
    const refreshed = refreshSnapshot(testRepository);
    expect(refreshed.status, refreshed.stderr).toBe(0);
    writeFileSync(path.join(testRepository.root, "second.txt"), "second\n");

    const second = guardedCommit(testRepository, "second");
    const count = git(testRepository.root, ["rev-list", "--count", "HEAD"]);

    expect(second.status, second.stderr).toBe(0);
    expect(count.stdout.trim()).toBe("2");
  });

  it("refuses a repository content-filter assignment before host Git runs", () => {
    const testRepository = fixture();
    writeFileSync(
      path.join(testRepository.root, ".gitattributes"),
      "*.txt filter=owned\n",
    );
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain("assigns a Git content filter");
  });

  it("finds an ignored .gitattributes file that can affect addable paths", () => {
    const testRepository = fixture();
    writeFileSync(path.join(testRepository.root, ".gitignore"), ".gitattributes\n");
    writeFileSync(
      path.join(testRepository.root, ".gitattributes"),
      "*.txt filter=owned\n",
    );
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain("assigns a Git content filter");
  });

  it("does not execute an agent-added clean filter", () => {
    const testRepository = fixture();
    const marker = path.join(testRepository.root, "clean-filter-ran");
    const filter = path.join(testRepository.root, "clean-filter.sh");
    writeFileSync(
      filter,
      `#!/bin/sh\nprintf ran > "${marker}"\ncat\n`,
    );
    chmodSync(filter, 0o700);
    expect(
      git(testRepository.root, ["config", "filter.owned.clean", filter]).status,
    ).toBe(0);
    writeFileSync(
      path.join(testRepository.root, ".gitattributes"),
      "*.txt filter=owned\n",
    );
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute an agent-added fsmonitor command", () => {
    const testRepository = fixture();
    const marker = path.join(testRepository.root, "fsmonitor-ran");
    const monitor = path.join(testRepository.root, "fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\nprintf ran > "${marker}"\n`);
    chmodSync(monitor, 0o700);
    expect(
      git(testRepository.root, ["config", "core.fsmonitor", monitor]).status,
    ).toBe(0);
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a config key written on the same line as its section header", () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "simple-balance-git-guard-")),
    );
    temporaryRoots.push(root);
    expect(git(root, ["init", "--quiet"]).status).toBe(0);
    const gitDirectory = realpathSync(path.join(root, ".git"));
    const configPath = path.join(gitDirectory, "config");
    // Written by hand, because `git config` always emits the two-line form. git
    // honours both; the scan only ever read one, so this shape reached the
    // snapshot as though the file held nothing executable.
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}[core] fsmonitor = /tmp/evil.sh\n`,
    );
    const trusted = path.join(root, "trusted");
    mkdirSync(trusted);

    const snapshot = spawnSync(
      process.execPath,
      [
        guard,
        "snapshot",
        root,
        gitDirectory,
        gitDirectory,
        gitExecutable,
        path.join(trusted, "git-state.json"),
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(snapshot.status).not.toBe(0);
    expect(snapshot.stderr).toMatch(/executable or included configuration key/);
  });

  it("refuses an agent-modified index instead of committing a different tree", () => {
    const testRepository = fixture();
    writeFileSync(path.join(testRepository.root, "hidden.txt"), "staged early\n");
    const staged = git(testRepository.root, ["add", "hidden.txt"]);
    expect(staged.status, staged.stderr).toBe(0);

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain("Git metadata changed");
  });

  it("refuses agent changes to Git info/exclude", () => {
    const testRepository = fixture();
    const exclude = path.join(testRepository.gitDirectory, "info/exclude");
    writeFileSync(exclude, "hidden.txt\n");
    writeFileSync(path.join(testRepository.root, "hidden.txt"), "must be added\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain("Git metadata changed");
  });

  it("refuses a symbolic-link escape inside Git metadata", () => {
    const testRepository = fixture();
    const outside = realpathSync(
      mkdtempSync(path.join(tmpdir(), "simple-balance-git-outside-")),
    );
    temporaryRoots.push(outside);
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "unchanged\n");
    mkdirSync(path.join(testRepository.gitDirectory, "logs"), {
      recursive: true,
    });
    symlinkSync(sentinel, path.join(testRepository.gitDirectory, "logs/HEAD"));
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain("must not be a symbolic link");
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("refuses a hard-link escape inside Git metadata", () => {
    const testRepository = fixture();
    const outside = realpathSync(
      mkdtempSync(path.join(tmpdir(), "simple-balance-git-outside-")),
    );
    temporaryRoots.push(outside);
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "unchanged\n");
    linkSync(
      sentinel,
      path.join(testRepository.gitDirectory, "COMMIT_EDITMSG"),
    );
    writeFileSync(path.join(testRepository.root, "result.txt"), "untrusted\n");

    const committed = guardedCommit(testRepository);

    expect(committed.status).not.toBe(0);
    expect(committed.stderr).toContain(
      "must be a single-link regular Git metadata file",
    );
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  });
});
