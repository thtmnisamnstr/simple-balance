#!/bin/sh
set -eu

ROOT=${1:?workspace root is required}
STORY_JSON=${2:?story JSON is required}
NETWORK=${3:?network mode is required}

mkdir -p "$ROOT/.ralph"
VERIFY_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/simple-balance-ralph-verify.XXXXXX")
VERIFY_ROOT=$(cd "$VERIFY_ROOT" && pwd -P)
VERIFY_WORKSPACE="$VERIFY_ROOT/workspace"
VERIFY_WRITABLE="$VERIFY_ROOT/writable"
VERIFY_TRUSTED="$VERIFY_ROOT/trusted"
COMMANDS_PATH="$VERIFY_TRUSTED/commands.json"
PROFILE_PATH="$VERIFY_TRUSTED/verification.sb"
VERIFICATION_RUNNER="$RALPH_TRUSTED_DIR/verification-runner.mjs"
PNPM_SHIM="$RALPH_TRUSTED_DIR/pnpm"
TRUSTED_SCRIPTS="$RALPH_TRUSTED_DIR/package-scripts.json"
PG_CONTAINER=""
PG_NETWORK=""
PG_PROXY_CONTAINER=""
PG_PROXY_NETWORK=""
mkdir -p \
  "$VERIFY_WORKSPACE" \
  "$VERIFY_TRUSTED" \
  "$VERIFY_WRITABLE/tmp" \
  "$VERIFY_WRITABLE/home" \
  "$VERIFY_WRITABLE/cache" \
  "$VERIFY_WRITABLE/npm-cache"

cleanup_verification() {
  if [ -n "$PG_PROXY_CONTAINER" ]; then
    docker rm -f "$PG_PROXY_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$PG_CONTAINER" ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$PG_PROXY_NETWORK" ]; then
    docker network rm "$PG_PROXY_NETWORK" >/dev/null 2>&1 || true
  fi
  if [ -n "$PG_NETWORK" ]; then
    docker network rm "$PG_NETWORK" >/dev/null 2>&1 || true
  fi
  case "$VERIFY_ROOT" in
    */simple-balance-ralph-verify.*) rm -rf -- "$VERIFY_ROOT" ;;
  esac
}
trap cleanup_verification EXIT HUP INT TERM

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [sourceRoot, copiedRoot] = process.argv.slice(1);
  const excludedDirectories = new Set([".git", ".ralph", "dist"]);
  fs.cpSync(sourceRoot, copiedRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (relative === "") return true;
      if (!relative.includes(path.sep)) {
        if (excludedDirectories.has(relative)) return false;
        if (relative === ".env" || relative.startsWith(".env.")) return false;
      }
      return true;
    },
  });
' "$ROOT" "$VERIFY_WORKSPACE"

# pnpm's generated command shims contain absolute NODE_PATH entries. Rewrite
# those entries in the disposable copy so the verifier never falls back to the
# live workspace, which is deliberately unreadable inside the macOS sandbox.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [originalRoot, copiedRoot] = process.argv.slice(1);
  const binDirectory = path.join(copiedRoot, "node_modules", ".bin");
  if (!fs.existsSync(binDirectory)) process.exit(0);
  for (const name of fs.readdirSync(binDirectory)) {
    const commandPath = path.join(binDirectory, name);
    if (!fs.lstatSync(commandPath).isFile()) continue;
    const command = fs.readFileSync(commandPath, "utf8");
    const rewritten = command.replaceAll(originalRoot, copiedRoot);
    if (rewritten !== command) fs.writeFileSync(commandPath, rewritten);
  }
' "$ROOT" "$VERIFY_WORKSPACE"

HAS_CONTAINER_BUILD=$(node -e '
  const story = JSON.parse(process.argv[1]);
  const commands = story.verification ?? [];
  process.stdout.write(commands.includes("docker build -t simple-balance:test .") ? "true" : "false");
' "$STORY_JSON")

HAS_INTEGRATION=$(node -e '
  const story = JSON.parse(process.argv[1]);
  const commands = story.verification ?? [];
  process.stdout.write(
    commands.some((command) => command.includes("test:integration"))
      ? "true"
      : "false",
  );
' "$STORY_JSON")

node -e '
  const fs = require("node:fs");
  const story = JSON.parse(process.argv[1]);
  const output = process.argv[2];
  const commands = (story.verification ?? []).filter(
    (command) => command !== "docker build -t simple-balance:test .",
  );
  if (!commands.every((command) => typeof command === "string" && command.length > 0 && command.length <= 2_000 && !command.includes("\0"))) {
    throw new Error("Story verification commands are invalid");
  }
  fs.writeFileSync(output, `${JSON.stringify(commands)}\n`, { mode: 0o600 });
' "$STORY_JSON" "$COMMANDS_PATH"

if [ "$HAS_CONTAINER_BUILD" = true ]; then
  if [ "$NETWORK" != true ]; then
    echo "The fixed Docker build gate requires explicit --network opt-in." >&2
    echo "Rerun this network-allowed container story with pnpm ralph --network." >&2
    exit 1
  fi
  echo "Verifying in disposable Docker build: docker build -t simple-balance:test ."
  docker build --pull=false -t simple-balance:test "$VERIFY_WORKSPACE"
fi

if [ "$HAS_INTEGRATION" = true ]; then
  if ! docker image inspect postgres:16-alpine >/dev/null 2>&1; then
    echo "The local postgres:16-alpine image is required for isolated integration verification." >&2
    exit 1
  fi
  VERIFY_SUFFIX=${VERIFY_ROOT##*.}
  PG_CONTAINER="ralph-pg-$VERIFY_SUFFIX"
  PG_NETWORK="ralph-net-$VERIFY_SUFFIX"
  PG_PROXY_CONTAINER="ralph-pg-proxy-$VERIFY_SUFFIX"
  PG_PROXY_NETWORK="ralph-host-$VERIFY_SUFFIX"
  docker network create --internal "$PG_NETWORK" >/dev/null
  docker run -d \
    --name "$PG_CONTAINER" \
    --network "$PG_NETWORK" \
    --network-alias ralph-postgres \
    -e POSTGRES_DB=ralph_test \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=ralph-verification-only \
    postgres:16-alpine >/dev/null
  ready=false
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if docker exec "$PG_CONTAINER" pg_isready -U postgres -d ralph_test >/dev/null 2>&1; then
      ready=true
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$ready" != true ]; then
    echo "The isolated Ralph PostgreSQL instance did not become ready." >&2
    exit 1
  fi
  if [ "$(uname -s)" = Darwin ]; then
    # Docker Desktop does not publish a port from an --internal network.
    # Bridge the one PostgreSQL TCP endpoint through a fixed, read-only nc
    # process. The database remains on the internal network and therefore
    # cannot turn superuser SQL (for example COPY PROGRAM) into internet access.
    docker network create "$PG_PROXY_NETWORK" >/dev/null
    docker create \
      --name "$PG_PROXY_CONTAINER" \
      --network "$PG_PROXY_NETWORK" \
      -p 127.0.0.1::5432 \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --pids-limit 64 \
      --user postgres \
      --entrypoint sh \
      postgres:16-alpine \
      -c 'exec nc -lk -p 5432 -e nc ralph-postgres 5432' >/dev/null
    docker network connect "$PG_NETWORK" "$PG_PROXY_CONTAINER"
    docker start "$PG_PROXY_CONTAINER" >/dev/null
    PG_HOST_BINDING=$(docker port "$PG_PROXY_CONTAINER" 5432/tcp)
    PG_HOST_PORT=${PG_HOST_BINDING##*:}
    case "$PG_HOST_PORT" in
      ''|*[!0-9]*)
        echo "Could not determine the isolated PostgreSQL proxy port." >&2
        exit 1
        ;;
    esac
  fi
fi

case "$(uname -s)" in
  Darwin)
    ORIGINAL_USER_HOME=$(node -e 'process.stdout.write(require("node:os").homedir())')
    # The unit suite includes one real raw-socket regression. Give that test one
    # freshly selected loopback port instead of opening all localhost services
    # to code running in the verification sandbox.
    LOOPBACK_TEST_PORT=$(node -e '
      const net = require("node:net");
      const server = net.createServer();
      server.on("error", (error) => {
        console.error(error.message);
        process.exit(1);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") process.exit(1);
        process.stdout.write(String(address.port));
        server.close();
      });
    ')
    case "$LOOPBACK_TEST_PORT" in
      ''|*[!0-9]*)
        echo "Could not reserve the restricted unit-test loopback port." >&2
        exit 1
        ;;
    esac
    node -e '
      const fs = require("node:fs");
      const escape = (value) => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
      const [
        profile,
        workspace,
        writable,
        userHome,
        trustedDriverDirectory,
        verificationTrustedDirectory,
        postgresPort,
        testPort,
      ] = process.argv.slice(1);
      const rules = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        `(allow file-write* (subpath "${escape(workspace)}") (subpath "${escape(writable)}") (literal "/dev/null") (literal "/dev/tty"))`,
        `(deny file-read-data (subpath "${escape(userHome)}"))`,
        `(allow file-read-data (subpath "${escape(workspace)}") (subpath "${escape(writable)}") (subpath "${escape(trustedDriverDirectory)}") (subpath "${escape(verificationTrustedDirectory)}"))`,
        "(deny network*)",
        "(deny appleevent-send)",
        "(deny signal)",
        "(allow signal (target self))",
        "(allow signal (target children))",
        "(deny process-info* (target others))",
        "(deny mach-task-name (target others))",
        `(deny mach-lookup
          (global-name "com.apple.SecurityServer")
          (global-name "com.apple.securityd")
          (global-name "com.apple.securityd.xpc")
          (global-name "com.apple.securityd.general")
          (global-name "com.apple.securityd.systemkeychain")
          (global-name "com.apple.securityd.ckks")
          (global-name "com.apple.pasteboard.1")
          (global-name "com.apple.pboard")
          (global-name "com.apple.pbs")
          (global-name "com.apple.pbs.fetch_services")
          (global-name "com.apple.coreservices.appleevents"))`,
      ];
      if (postgresPort) {
        rules.push(
          `(allow network-outbound (remote tcp "localhost:${escape(postgresPort)}"))`,
        );
      }
      rules.push(
        `(allow network-bind (local tcp "*:${escape(testPort)}"))`,
        `(allow network-inbound (local tcp "*:${escape(testPort)}"))`,
        `(allow network-outbound (remote tcp "localhost:${escape(testPort)}"))`,
      );
      fs.writeFileSync(profile, `${rules.join("\n")}\n`, { mode: 0o600 });
    ' \
      "$PROFILE_PATH" \
      "$VERIFY_WORKSPACE" \
      "$VERIFY_WRITABLE" \
      "$ORIGINAL_USER_HOME" \
      "$RALPH_TRUSTED_DIR" \
      "$VERIFY_TRUSTED" \
      "${PG_HOST_PORT:-}" \
      "$LOOPBACK_TEST_PORT"
    (
      cd "$VERIFY_WORKSPACE"
      set -- \
        CI=1 \
        HOME="$VERIFY_WRITABLE/home" \
        TMPDIR="$VERIFY_WRITABLE/tmp" \
        XDG_CACHE_HOME="$VERIFY_WRITABLE/cache" \
        NPM_CONFIG_CACHE="$VERIFY_WRITABLE/npm-cache" \
        RALPH_TRUSTED_SCRIPTS_PATH="$TRUSTED_SCRIPTS" \
        RALPH_LOOPBACK_TEST_PORT="$LOOPBACK_TEST_PORT" \
        PATH="$RALPH_TRUSTED_DIR:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      if [ "$HAS_INTEGRATION" = true ]; then
        set -- "$@" \
          TEST_DATABASE_URL="postgresql://postgres:ralph-verification-only@127.0.0.1:$PG_HOST_PORT/ralph_test"
      fi
      sandbox-exec -f "$PROFILE_PATH" /usr/bin/env -i \
        "$@" \
        node "$VERIFICATION_RUNNER" "$COMMANDS_PATH" "$PNPM_SHIM"
    )
    ;;
  Linux)
    if ! docker image inspect node:24-alpine >/dev/null 2>&1; then
      echo "The node:24-alpine image is required for restricted Ralph verification." >&2
      echo "Build the application image once, or pull node:24-alpine, before starting Ralph." >&2
      exit 1
    fi
    set -- docker run --rm \
      --read-only \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --pids-limit 512 \
      --user "$(id -u):$(id -g)" \
      --tmpfs /tmp:rw,noexec,nosuid,size=256m \
      --mount "type=bind,src=$VERIFY_WORKSPACE,dst=/workspace" \
      --mount "type=bind,src=$COMMANDS_PATH,dst=/ralph/commands.json,readonly" \
      --mount "type=bind,src=$VERIFICATION_RUNNER,dst=/ralph/verification-runner.mjs,readonly" \
      --mount "type=bind,src=$PNPM_SHIM,dst=/ralph/pnpm,readonly" \
      --mount "type=bind,src=$TRUSTED_SCRIPTS,dst=/ralph/package-scripts.json,readonly" \
      --workdir /workspace \
      --env CI=1 \
      --env RALPH_TRUSTED_SCRIPTS_PATH=/ralph/package-scripts.json \
      --env PATH=/ralph:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    if [ "$HAS_INTEGRATION" = true ]; then
      set -- "$@" \
        --network "$PG_NETWORK" \
        --env TEST_DATABASE_URL=postgresql://postgres:ralph-verification-only@ralph-postgres:5432/ralph_test
    else
      set -- "$@" --network none
    fi
    set -- "$@" \
      node:24-alpine \
      node /ralph/verification-runner.mjs /ralph/commands.json /ralph/pnpm
    "$@"
    ;;
  *)
    echo "Restricted Ralph verification supports macOS and Linux only." >&2
    exit 1
    ;;
esac
