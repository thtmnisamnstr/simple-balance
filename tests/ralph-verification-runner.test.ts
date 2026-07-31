import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const runner = resolve("scripts/ralph/verification-runner.mjs");
const pnpmShim = resolve("scripts/ralph/pnpm-shim.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(commands: string[]) {
  const directory = mkdtempSync(
    join(tmpdir(), "simple-balance-verification-runner-"),
  );
  temporaryDirectories.push(directory);
  const commandsPath = join(directory, "commands.json");
  const pnpmPath = join(directory, "pnpm");
  writeFileSync(commandsPath, JSON.stringify(commands));
  writeFileSync(
    pnpmPath,
    [
      "#!/bin/sh",
      "set -eu",
      '[ "$1" = verify ]',
      "node -e 'require(\"node:fs\").writeFileSync(\"mandatory-ran\", \"yes\")'",
      "",
    ].join("\n"),
  );
  chmodSync(pnpmPath, 0o700);
  return { directory, commandsPath, pnpmPath };
}

describe("trusted Ralph verification runner", () => {
  it("isolates story shells so exit cannot skip the mandatory gate", () => {
    const { directory, commandsPath, pnpmPath } = fixture([
      "exit 0",
      "node -e 'require(\"node:fs\").writeFileSync(\"later-story-ran\", \"yes\")'",
    ]);
    const result = spawnSync(
      process.execPath,
      [runner, commandsPath, pnpmPath],
      { cwd: directory, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(directory, "later-story-ran"))).toBe(true);
    expect(existsSync(join(directory, "mandatory-ran"))).toBe(true);
  });

  it("fails immediately when a story verification command fails", () => {
    const { directory, commandsPath, pnpmPath } = fixture(["exit 9"]);
    const result = spawnSync(
      process.execPath,
      [runner, commandsPath, pnpmPath],
      { cwd: directory, encoding: "utf8" },
    );

    expect(result.status).toBe(9);
    expect(existsSync(join(directory, "mandatory-ran"))).toBe(false);
  });

  it("rejects a mutable package script changed to a no-op", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "simple-balance-package-script-gate-"),
    );
    temporaryDirectories.push(directory);
    const snapshotPath = join(directory, "trusted-scripts.json");
    const packagePath = join(directory, "package.json");
    const marker = join(directory, "trusted-verify-ran");
    const trustedScripts = {
      test:
        "node -e 'require(\"node:fs\").writeFileSync(\"trusted-verify-ran\", \"yes\")'",
      verify: "pnpm test",
    };
    writeFileSync(snapshotPath, JSON.stringify({ scripts: trustedScripts }));
    writeFileSync(packagePath, JSON.stringify({ scripts: trustedScripts }));

    const valid = spawnSync("/bin/sh", [pnpmShim, "verify"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        RALPH_TRUSTED_SCRIPTS_PATH: snapshotPath,
      },
    });
    expect(valid.status, valid.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    writeFileSync(
      packagePath,
      JSON.stringify({ scripts: { verify: "true" } }),
    );
    const tampered = spawnSync("/bin/sh", [pnpmShim, "verify"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        RALPH_TRUSTED_SCRIPTS_PATH: snapshotPath,
      },
    });

    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toContain(
      "package.json scripts changed after Ralph started",
    );
    expect(existsSync(marker)).toBe(false);
  });
});
