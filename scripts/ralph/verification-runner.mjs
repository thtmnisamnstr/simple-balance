#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const [commandsPath, pnpmPath] = process.argv.slice(2);
if (!commandsPath || !pnpmPath) {
  console.error("Usage: verification-runner.mjs COMMANDS_JSON PNPM_SHIM");
  process.exit(2);
}

const commands = JSON.parse(readFileSync(commandsPath, "utf8"));
if (
  !Array.isArray(commands) ||
  !commands.every(
    (command) =>
      typeof command === "string" &&
      command.length > 0 &&
      command.length <= 2_000 &&
      !command.includes("\0"),
  )
) {
  console.error("Story verification commands are invalid");
  process.exit(2);
}

function run(executable, args, label) {
  console.log(`Verifying in restricted sandbox: ${label}`);
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`${label} terminated by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const command of commands) {
  // Each story command receives its own shell. `exit 0`, shell options, and
  // working-directory changes therefore cannot bypass later commands.
  run("/bin/sh", ["-c", command], command);
}

// Invoke the immutable shim directly, outside every story-controlled shell.
run(pnpmPath, ["verify"], "pnpm verify");
