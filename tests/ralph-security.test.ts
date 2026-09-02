import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const driver = readFileSync("scripts/ralph/ralph.sh", "utf8");
const verifier = readFileSync("scripts/ralph/verify-in-sandbox.sh", "utf8");

describe("Ralph execution containment", () => {
  it("snapshots host-executed helpers before invoking Codex", () => {
    const snapshot = driver.indexOf('cp "$0" "$TRUSTED_DIR/ralph.sh"');
    const codex = driver.indexOf("codex --ask-for-approval never exec");
    expect(snapshot).toBeGreaterThan(0);
    expect(codex).toBeGreaterThan(snapshot);
    expect(driver).toContain('RUNNER="$RALPH_TRUSTED_DIR/runner.mjs"');
    expect(driver).toContain('VERIFIER="$RALPH_TRUSTED_DIR/verify-in-sandbox.sh"');
    expect(driver).toContain(
      'cp "$WORKSPACE_ROOT/scripts/ralph/verification-runner.mjs" "$TRUSTED_DIR/verification-runner.mjs"',
    );
    expect(driver).toContain(
      'cp "$WORKSPACE_ROOT/scripts/ralph/git-guard.mjs" "$TRUSTED_DIR/git-guard.mjs"',
    );
    expect(driver).toContain('"$WORKSPACE_ROOT/package.json" "$TRUSTED_DIR/package-scripts.json"');
  });

  it("never runs workspace verification commands directly on the host", () => {
    expect(driver).not.toContain('/bin/sh -lc "$command"');
    expect(driver).not.toContain('(cd "$ROOT" && npm run verify)');
    expect(driver).not.toContain("git -c core.hooksPath=/dev/null add -A");
    expect(driver).toContain('"$VERIFIER" "$ROOT" "$STORY_JSON" "$NETWORK"');
    expect(driver).toContain('node "$GIT_GUARD" commit');
  });

  it("fails closed into write- and network-restricted platform sandboxes", () => {
    expect(verifier).toContain("(deny file-write*)");
    expect(verifier).toContain("(deny network*)");
    expect(verifier).toContain("(deny appleevent-send)");
    expect(verifier).toContain("(deny signal)");
    expect(verifier).toContain("(allow signal (target children))");
    expect(verifier).toContain("(deny process-info* (target others))");
    expect(verifier).toContain('(global-name "com.apple.SecurityServer")');
    expect(verifier).toContain('(global-name "com.apple.pasteboard.1")');
    expect(verifier).toContain('(allow network-bind (local tcp "*:${escape(testPort)}"))');
    expect(verifier).toContain('RALPH_LOOPBACK_TEST_PORT="$LOOPBACK_TEST_PORT"');
    expect(verifier).toContain("/usr/bin/env -i");
    expect(verifier).toContain('HOME="$VERIFY_WRITABLE/home"');
    expect(verifier).toContain('node "$VERIFICATION_RUNNER" "$COMMANDS_PATH" "$NPM_SHIM"');
    expect(verifier).toContain("RALPH_TRUSTED_SCRIPTS_PATH=/ralph/package-scripts.json");
    expect(verifier).toContain('PATH="$RALPH_TRUSTED_DIR:');
    expect(verifier).toContain("--read-only");
    expect(verifier).toContain("--cap-drop ALL");
    expect(verifier).toContain("--security-opt no-new-privileges");
    expect(verifier).toContain("--network none");
    expect(verifier).toContain(
      "--env PATH=/ralph:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(verifier).toContain('docker network create --internal "$PG_NETWORK"');
    expect(verifier).toContain('if [ "$NETWORK" != true ]; then');
    expect(verifier).not.toContain("docker.sock");
    expect(verifier).not.toContain("/bin/sh /ralph/commands.sh");
  });
});
