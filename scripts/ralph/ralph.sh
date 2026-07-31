#!/bin/sh
set -eu

# Snapshot the driver and every host-executed helper before Codex can modify the
# workspace. The trusted copy remains outside Codex's writable root.
if [ "${RALPH_TRUSTED_DRIVER:-false}" != true ]; then
  WORKSPACE_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
  mkdir -p "$WORKSPACE_ROOT/.ralph"
  TRUSTED_DIR=$(mktemp -d "${TMPDIR:-/tmp}/simple-balance-ralph.XXXXXX")
  cp "$0" "$TRUSTED_DIR/ralph.sh"
  cp "$WORKSPACE_ROOT/scripts/ralph/runner.mjs" "$TRUSTED_DIR/runner.mjs"
  cp "$WORKSPACE_ROOT/scripts/ralph/completion.schema.json" "$TRUSTED_DIR/completion.schema.json"
  cp "$WORKSPACE_ROOT/scripts/ralph/verify-in-sandbox.sh" "$TRUSTED_DIR/verify-in-sandbox.sh"
  cp "$WORKSPACE_ROOT/scripts/ralph/pnpm-shim.sh" "$TRUSTED_DIR/pnpm"
  cp "$WORKSPACE_ROOT/scripts/ralph/verification-runner.mjs" "$TRUSTED_DIR/verification-runner.mjs"
  cp "$WORKSPACE_ROOT/scripts/ralph/git-guard.mjs" "$TRUSTED_DIR/git-guard.mjs"
  cp "$WORKSPACE_ROOT/tasks/product.prd.json" "$TRUSTED_DIR/product.prd.json"
  cp "$WORKSPACE_ROOT/tasks/product.prd.schema.json" "$TRUSTED_DIR/product.prd.schema.json"
  node -e '
    const fs = require("node:fs");
    const packageDocument = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const scripts = packageDocument.scripts ?? {};
    if (
      !scripts ||
      typeof scripts !== "object" ||
      Array.isArray(scripts) ||
      !Object.values(scripts).every((value) => typeof value === "string")
    ) {
      throw new Error("package.json scripts must be string values");
    }
    fs.writeFileSync(process.argv[2], `${JSON.stringify({ scripts })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  ' "$WORKSPACE_ROOT/package.json" "$TRUSTED_DIR/package-scripts.json"
  chmod 700 \
    "$TRUSTED_DIR/ralph.sh" \
    "$TRUSTED_DIR/verify-in-sandbox.sh" \
    "$TRUSTED_DIR/pnpm"
  GIT_EXECUTABLE=$(command -v git)
  GIT_EXECUTABLE=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$GIT_EXECUTABLE")
  GIT_DIRECTORY=$(git -C "$WORKSPACE_ROOT" rev-parse --path-format=absolute --absolute-git-dir)
  GIT_COMMON_DIRECTORY=$(git -C "$WORKSPACE_ROOT" rev-parse --path-format=absolute --git-common-dir)
  GIT_AUTHOR_NAME=$(git -C "$WORKSPACE_ROOT" config --get user.name || true)
  GIT_AUTHOR_EMAIL=$(git -C "$WORKSPACE_ROOT" config --get user.email || true)
  node "$TRUSTED_DIR/git-guard.mjs" snapshot \
    "$WORKSPACE_ROOT" \
    "$GIT_DIRECTORY" \
    "$GIT_COMMON_DIRECTORY" \
    "$GIT_EXECUTABLE" \
    "$TRUSTED_DIR/git-state.json"
  RALPH_TRUSTED_DRIVER=true \
  RALPH_TRUSTED_DIR="$TRUSTED_DIR" \
  RALPH_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  RALPH_GIT_EXECUTABLE="$GIT_EXECUTABLE" \
  RALPH_GIT_DIRECTORY="$GIT_DIRECTORY" \
  RALPH_GIT_COMMON_DIRECTORY="$GIT_COMMON_DIRECTORY" \
  RALPH_GIT_AUTHOR_NAME="$GIT_AUTHOR_NAME" \
  RALPH_GIT_AUTHOR_EMAIL="$GIT_AUTHOR_EMAIL" \
    exec "$TRUSTED_DIR/ralph.sh" "$@"
fi

ROOT=${RALPH_WORKSPACE_ROOT:?trusted workspace root is required}
RUNNER="$RALPH_TRUSTED_DIR/runner.mjs"
COMPLETION_SCHEMA="$RALPH_TRUSTED_DIR/completion.schema.json"
VERIFIER="$RALPH_TRUSTED_DIR/verify-in-sandbox.sh"
GIT_GUARD="$RALPH_TRUSTED_DIR/git-guard.mjs"
MAX_ITERATIONS=${RALPH_MAX_ITERATIONS:-20}
DRY_RUN=false
NETWORK=false
LOCK=""

cleanup() {
  if [ -n "$LOCK" ]; then
    rmdir "$LOCK" 2>/dev/null || true
  fi
  case "$RALPH_TRUSTED_DIR" in
    "${TMPDIR:-/tmp}"/simple-balance-ralph.*)
      rm -rf -- "$RALPH_TRUSTED_DIR"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

usage() {
  echo "Usage: pnpm ralph [--dry-run] [--network] [--max-iterations N] [--status]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --network) NETWORK=true ;;
    --max-iterations)
      shift
      [ "$#" -gt 0 ] || { usage; exit 2; }
      MAX_ITERATIONS=$1
      ;;
    --status)
      node "$RUNNER" status
      exit $?
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift
done

case "$MAX_ITERATIONS" in
  ''|*[!0-9]*) echo "Iteration limit must be a positive integer" >&2; exit 2 ;;
  0) echo "Iteration limit must be greater than zero" >&2; exit 2 ;;
esac

if [ "$DRY_RUN" != true ] && {
  [ -z "$RALPH_GIT_AUTHOR_NAME" ] || [ -z "$RALPH_GIT_AUTHOR_EMAIL" ];
}; then
  echo "Git user.name and user.email must be configured before starting Ralph." >&2
  exit 1
fi

mkdir -p "$ROOT/.ralph"
LOCK="$ROOT/.ralph/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another Ralph loop is already running ($LOCK)." >&2
  exit 1
fi

iteration=1
while [ "$iteration" -le "$MAX_ITERATIONS" ]; do
  STORY_JSON=$(node "$RUNNER" next)
  if [ "$STORY_JSON" = "null" ]; then
    echo "All ready stories are complete."
    node "$RUNNER" status
    exit 0
  fi

  STORY_ID=$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.id)' "$STORY_JSON")
  STORY_TITLE=$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(s.title)' "$STORY_JSON")
  STORY_NETWORK=$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s.networkAllowed))' "$STORY_JSON")
  PROMPT_PATH=$(node "$RUNNER" prompt "$STORY_ID")

  echo "Iteration $iteration/$MAX_ITERATIONS: $STORY_ID — $STORY_TITLE"
  if [ "$NETWORK" = true ] && [ "$STORY_NETWORK" != true ]; then
    echo "Story $STORY_ID does not permit network access." >&2
    exit 2
  fi
  if [ "$DRY_RUN" = true ]; then
    echo "Prompt: $PROMPT_PATH"
    if [ "$NETWORK" = true ]; then
      echo "Implementation sandbox: workspace-write; ephemeral context; network enabled"
    else
      echo "Implementation sandbox: workspace-write; ephemeral context; network disabled"
    fi
    echo "Verification sandbox: disposable copy; no general network or Docker access"
    node -e 'const s=JSON.parse(process.argv[1]); for(const c of s.verification) console.log(`Would verify: ${c}`)' "$STORY_JSON"
    echo "Would verify: pnpm verify"
    exit 0
  fi

  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  LOG_PATH="$ROOT/.ralph/$STAMP-$STORY_ID.jsonl"
  FINAL_PATH="$ROOT/.ralph/$STAMP-$STORY_ID-final.json"

  set +e
  if [ "$NETWORK" = true ]; then
    GIT_OPTIONAL_LOCKS=0 codex --ask-for-approval never exec \
      --cd "$ROOT" \
      --sandbox workspace-write \
      --config sandbox_workspace_write.network_access=true \
      --ephemeral \
      --json \
      --output-schema "$COMPLETION_SCHEMA" \
      --output-last-message "$FINAL_PATH" \
      - < "$PROMPT_PATH" > "$LOG_PATH" 2>&1
  else
    GIT_OPTIONAL_LOCKS=0 codex --ask-for-approval never exec \
      --cd "$ROOT" \
      --sandbox workspace-write \
      --config sandbox_workspace_write.network_access=false \
      --ephemeral \
      --json \
      --output-schema "$COMPLETION_SCHEMA" \
      --output-last-message "$FINAL_PATH" \
      - < "$PROMPT_PATH" > "$LOG_PATH" 2>&1
  fi
  CODEX_STATUS=$?
  set -e

  if ! node "$RUNNER" restore; then
    echo "Trusted PRD restoration failed; refusing to continue." >&2
    exit 1
  fi

  if [ "$CODEX_STATUS" -ne 0 ] || [ ! -s "$FINAL_PATH" ]; then
    node "$RUNNER" fail "$STORY_ID" \
      "Codex exited with $CODEX_STATUS; see ${LOG_PATH#"$ROOT/"}"
    echo "Iteration failed; work was preserved. See $LOG_PATH" >&2
    iteration=$((iteration + 1))
    continue
  fi

  VERIFY_STATUS=0
  "$VERIFIER" "$ROOT" "$STORY_JSON" "$NETWORK" || VERIFY_STATUS=$?

  if [ "$VERIFY_STATUS" -ne 0 ]; then
    node "$RUNNER" fail "$STORY_ID" \
      "sandboxed verification exited with $VERIFY_STATUS; see ${LOG_PATH#"$ROOT/"}"
    echo "Verification failed; work was preserved for the next iteration." >&2
    iteration=$((iteration + 1))
    continue
  fi

  if ! node "$GIT_GUARD" check \
    "$ROOT" \
    "$RALPH_GIT_DIRECTORY" \
    "$RALPH_GIT_COMMON_DIRECTORY" \
    "$RALPH_GIT_EXECUTABLE" \
    "$RALPH_TRUSTED_DIR/git-state.json"; then
    node "$RUNNER" fail "$STORY_ID" \
      "Git metadata or attributes changed; refusing the host commit"
    echo "Git safety check failed; completion state was not changed." >&2
    exit 1
  fi

  if ! node "$RUNNER" prepare-complete "$STORY_ID" "$FINAL_PATH"; then
    if ! node "$RUNNER" rollback-complete "$STORY_ID"; then
      echo "Completion preparation failed and could not be rolled back." >&2
      exit 1
    fi
    node "$RUNNER" fail "$STORY_ID" \
      "completion output was invalid; see ${FINAL_PATH#"$ROOT/"}"
    iteration=$((iteration + 1))
    continue
  fi

  set +e
  node "$GIT_GUARD" commit \
    "$ROOT" \
    "$RALPH_GIT_DIRECTORY" \
    "$RALPH_GIT_COMMON_DIRECTORY" \
    "$RALPH_GIT_EXECUTABLE" \
    "$RALPH_TRUSTED_DIR/git-state.json" \
    "$RALPH_GIT_AUTHOR_NAME" \
    "$RALPH_GIT_AUTHOR_EMAIL" \
    "$STORY_ID: $STORY_TITLE"
  COMMIT_STATUS=$?
  set -e
  if [ "$COMMIT_STATUS" -ne 0 ]; then
    if ! node "$RUNNER" rollback-complete "$STORY_ID"; then
      echo "Story commit failed and completion state could not be rolled back." >&2
      exit 1
    fi
    node "$RUNNER" fail "$STORY_ID" \
      "story commit exited with $COMMIT_STATUS; implementation work was preserved"
    echo "Story commit failed; completion state was rolled back and work was preserved." >&2
    exit 1
  fi
  if ! node "$RUNNER" finalize-complete "$STORY_ID"; then
    echo "Story was committed but trusted completion finalization failed." >&2
    exit 1
  fi
  node "$GIT_GUARD" refresh \
    "$ROOT" \
    "$RALPH_GIT_DIRECTORY" \
    "$RALPH_GIT_COMMON_DIRECTORY" \
    "$RALPH_GIT_EXECUTABLE" \
    "$RALPH_TRUSTED_DIR/git-state.json"
  echo "Completed and committed $STORY_ID."
  iteration=$((iteration + 1))
done

echo "Reached iteration limit ($MAX_ITERATIONS)." >&2
node "$RUNNER" status
exit 1
