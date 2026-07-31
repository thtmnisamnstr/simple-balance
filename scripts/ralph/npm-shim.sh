#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "npm-shim: a script or command is required" >&2
  exit 2
fi

TRUSTED_SCRIPTS_PATH=${RALPH_TRUSTED_SCRIPTS_PATH:?trusted package scripts are required}

case "$1" in
  --version|-v)
    echo "11.17.0-sandbox-shim"
    exit 0
    ;;
  exec)
    shift
    [ "$#" -gt 0 ] || exit 2
    executable=$1
    shift
    exec "./node_modules/.bin/$executable" "$@"
    ;;
  run)
    shift
    [ "$#" -gt 0 ] || exit 2
    script=$1
    shift
    ;;
  *)
    script=$1
    shift
    ;;
esac

if [ "${1:-}" = "--" ]; then
  shift
fi

exec node - "$TRUSTED_SCRIPTS_PATH" "$0" "$script" "$@" <<'NODE'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [snapshotPath, shimPath, script, ...scriptArguments] =
  process.argv.slice(2);

function scriptsFrom(file) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  const scripts = document.scripts;
  if (
    !scripts ||
    typeof scripts !== "object" ||
    Array.isArray(scripts) ||
    !Object.values(scripts).every((value) => typeof value === "string")
  ) {
    throw new Error(`${file} does not contain a valid script map`);
  }
  return scripts;
}

function sameScripts(left, right) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every(
      (name, index) =>
        name === rightNames[index] && left[name] === right[name],
    )
  );
}

try {
  const trustedScripts = scriptsFrom(snapshotPath);
  const workspaceScripts = scriptsFrom(path.resolve("package.json"));
  if (!sameScripts(trustedScripts, workspaceScripts)) {
    throw new Error(
      "package.json scripts changed after Ralph started; trusted verification refused them",
    );
  }
  if (!Object.hasOwn(trustedScripts, script)) {
    throw new Error(
      `unsupported command in network-disabled verification: ${script}`,
    );
  }

  const trustedShimDirectory = path.dirname(fs.realpathSync(shimPath));
  const environment = {
    ...process.env,
    PATH: [
      trustedShimDirectory,
      path.resolve("node_modules/.bin"),
      process.env.PATH ?? "",
    ].join(path.delimiter),
  };
  const result = spawnSync(
    "/bin/sh",
    ["-c", `${trustedScripts[script]} "$@"`, `npm run ${script}`, ...scriptArguments],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`script ${script} terminated by ${result.signal}`);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`npm-shim: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
NODE
