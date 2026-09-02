import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const runner = resolve("scripts/ralph/verification-runner.mjs");
const npmShim = resolve("scripts/ralph/npm-shim.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(commands: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "simple-balance-verification-runner-"));
  temporaryDirectories.push(directory);
  const commandsPath = join(directory, "commands.json");
  const npmPath = join(directory, "npm");
  writeFileSync(commandsPath, JSON.stringify(commands));
  writeFileSync(
    npmPath,
    [
      "#!/bin/sh",
      "set -eu",
      // The runner must reach the mandatory gate as `npm run verify`.
      '[ "$1" = run ] && [ "$2" = verify ]',
      'node -e \'require("node:fs").writeFileSync("mandatory-ran", "yes")\'',
      "",
    ].join("\n"),
  );
  chmodSync(npmPath, 0o700);
  return { directory, commandsPath, npmPath };
}

describe("trusted Ralph verification runner", () => {
  it("isolates story shells so exit cannot skip the mandatory gate", () => {
    const { directory, commandsPath, npmPath } = fixture([
      "exit 0",
      'node -e \'require("node:fs").writeFileSync("later-story-ran", "yes")\'',
    ]);
    const result = spawnSync(process.execPath, [runner, commandsPath, npmPath], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(directory, "later-story-ran"))).toBe(true);
    expect(existsSync(join(directory, "mandatory-ran"))).toBe(true);
  });

  it("fails immediately when a story verification command fails", () => {
    const { directory, commandsPath, npmPath } = fixture(["exit 9"]);
    const result = spawnSync(process.execPath, [runner, commandsPath, npmPath], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status).toBe(9);
    expect(existsSync(join(directory, "mandatory-ran"))).toBe(false);
  });

  it("rejects a mutable package script changed to a no-op", () => {
    // ralph.sh copies the shim to "$TRUSTED_DIR/npm" and leads PATH with that
    // directory, so a nested `npm test` re-enters the shim. Set the gate up the
    // same way, and give it a PATH holding only node, so the run proves the
    // sandbox never reaches a host package manager.
    const workspace = mkdtempSync(join(tmpdir(), "simple-balance-package-script-gate-"));
    const trusted = mkdtempSync(join(tmpdir(), "simple-balance-package-script-trusted-"));
    temporaryDirectories.push(workspace, trusted);
    const trustedNpm = join(trusted, "npm");
    copyFileSync(npmShim, trustedNpm);
    chmodSync(trustedNpm, 0o700);
    const nodeOnlyBin = join(trusted, "bin");
    mkdirSync(nodeOnlyBin);
    symlinkSync(process.execPath, join(nodeOnlyBin, "node"));

    const snapshotPath = join(trusted, "trusted-scripts.json");
    const packagePath = join(workspace, "package.json");
    const marker = join(workspace, "trusted-verify-ran");
    const trustedScripts = {
      test: 'node -e \'require("node:fs").writeFileSync("trusted-verify-ran", "yes")\'',
      verify: "npm test",
    };
    writeFileSync(snapshotPath, JSON.stringify({ scripts: trustedScripts }));
    writeFileSync(packagePath, JSON.stringify({ scripts: trustedScripts }));

    const runShim = () =>
      spawnSync("/bin/sh", [trustedNpm, "run", "verify"], {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: nodeOnlyBin,
          RALPH_TRUSTED_SCRIPTS_PATH: snapshotPath,
        },
      });

    const valid = runShim();
    expect(valid.status, valid.stderr).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    writeFileSync(packagePath, JSON.stringify({ scripts: { verify: "true" } }));
    const tampered = runShim();

    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toContain("package.json scripts changed after Ralph started");
    expect(existsSync(marker)).toBe(false);
  });
});
