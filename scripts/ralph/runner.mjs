#!/usr/bin/env node

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const configuredRoot = process.env.RALPH_WORKSPACE_ROOT
  ? path.resolve(process.env.RALPH_WORKSPACE_ROOT)
  : path.resolve(import.meta.dirname, "../..");
const root = await realpath(configuredRoot);
const trustedDir = process.env.RALPH_TRUSTED_DIR
  ? await realpath(path.resolve(process.env.RALPH_TRUSTED_DIR))
  : null;

const workspacePrdPath = path.join(root, "tasks/product.prd.json");
const workspaceSchemaPath = path.join(root, "tasks/product.prd.schema.json");
const statePrdPath = trustedDir
  ? path.join(trustedDir, "product.prd.json")
  : workspacePrdPath;
const stateSchemaPath = trustedDir
  ? path.join(trustedDir, "product.prd.schema.json")
  : workspaceSchemaPath;
const stateRoot = trustedDir ?? root;
const progressPath = path.join(root, "scripts/ralph/progress.md");
const guardrailsPath = path.join(root, "scripts/ralph/guardrails.md");
const promptTemplatePath = path.join(root, "scripts/ralph/iteration-prompt.md");
const agentPath = path.join(root, "AGENTS.md");
const runPath = path.join(root, ".ralph");
const completionPendingPath = trustedDir
  ? path.join(trustedDir, "pending-completion.json")
  : null;

const storyIdPattern = /^SB-[0-9]{3}$/;
const supportedSchemaKeywords = new Set([
  "$schema",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "pattern",
]);

function isContained(base, target) {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function requireContained(base, target, label) {
  if (!isContained(base, target)) {
    throw new Error(`${label} must remain within ${base}`);
  }
}

async function requireSafeDirectory(directory, base, create = false) {
  const resolved = path.resolve(directory);
  requireContained(base, resolved, "Directory");
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${resolved} must be a real directory, not a symbolic link`);
    }
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw error;
    await mkdir(resolved, { mode: 0o700 });
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved || !isContained(base, canonical)) {
    throw new Error(`${resolved} resolves outside its trusted root`);
  }
  return canonical;
}

async function requireSafeFile(file, base) {
  const resolved = path.resolve(file);
  requireContained(base, resolved, "File");
  await requireSafeDirectory(path.dirname(resolved), base);
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${resolved} must be a regular file, not a symbolic link`);
  }
  if (stats.nlink > 1) {
    throw new Error(`${resolved} must not be a hard-linked file`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved || !isContained(base, canonical)) {
    throw new Error(`${resolved} resolves outside its trusted root`);
  }
  return resolved;
}

async function validateOpenFile(handle, resolved, base) {
  const [openedStats, pathStats, canonicalParent] = await Promise.all([
    handle.stat(),
    lstat(resolved),
    realpath(path.dirname(resolved)),
  ]);
  if (
    !openedStats.isFile() ||
    openedStats.nlink > 1 ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    pathStats.nlink > 1 ||
    openedStats.dev !== pathStats.dev ||
    openedStats.ino !== pathStats.ino
  ) {
    throw new Error(`${resolved} changed during safe file access`);
  }
  if (
    canonicalParent !== path.dirname(resolved) ||
    !isContained(base, canonicalParent)
  ) {
    throw new Error(`${resolved} resolves outside its trusted root`);
  }
}

async function safeReadFile(file, base) {
  const resolved = await requireSafeFile(file, base);
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await validateOpenFile(handle, resolved, base);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function safeWriteFile(file, content, base) {
  const resolved = path.resolve(file);
  requireContained(base, resolved, "Output file");
  await requireSafeDirectory(path.dirname(resolved), base);
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${resolved} must be a regular file, not a symbolic link`);
    }
    if (stats.nlink > 1) {
      throw new Error(`${resolved} must not be a hard-linked file`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const handle = await open(
    resolved,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await validateOpenFile(handle, resolved, base);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function safeAppendFile(file, content, base) {
  const resolved = await requireSafeFile(file, base);
  const handle = await open(
    resolved,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    await validateOpenFile(handle, resolved, base);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function safeDeleteFile(file, base) {
  const resolved = await requireSafeFile(file, base);
  await unlink(resolved);
}

function failSchema(location, message) {
  throw new Error(`PRD schema validation failed at ${location}: ${message}`);
}

function validateSchemaDefinition(schema, location = "$schema") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    failSchema(location, "schema node must be an object");
  }
  for (const keyword of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(keyword)) {
      failSchema(location, `unsupported schema keyword ${keyword}`);
    }
  }
  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) {
      validateSchemaDefinition(child, `${location}.properties.${name}`);
    }
  }
  if (schema.items) validateSchemaDefinition(schema.items, `${location}.items`);
}

function valueMatchesType(value, type) {
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function validateAgainstSchema(value, schema, location = "$") {
  if (schema.type && !valueMatchesType(value, schema.type)) {
    failSchema(location, `expected ${schema.type}`);
  }
  if (schema.pattern && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) {
    failSchema(location, `must match ${schema.pattern}`);
  }
  if (schema.type === "object") {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        failSchema(location, `missing required property ${required}`);
      }
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) {
          failSchema(location, `unexpected property ${name}`);
        }
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) {
        validateAgainstSchema(value[name], child, `${location}.${name}`);
      }
    }
  }
  if (schema.type === "array") {
    for (let index = 0; index < value.length; index += 1) {
      validateAgainstSchema(value[index], schema.items, `${location}[${index}]`);
    }
  }
}

function validatePrdSemantics(document) {
  const ids = new Set();
  for (const [index, story] of document.stories.entries()) {
    if (!storyIdPattern.test(story.id)) {
      failSchema(`$.stories[${index}].id`, "must match ^SB-[0-9]{3}$");
    }
    if (ids.has(story.id)) {
      failSchema(`$.stories[${index}].id`, `duplicate story ID ${story.id}`);
    }
    ids.add(story.id);
  }
  for (const [index, story] of document.stories.entries()) {
    const dependencies = new Set();
    for (const dependency of story.dependsOn) {
      if (!storyIdPattern.test(dependency) || !ids.has(dependency)) {
        failSchema(
          `$.stories[${index}].dependsOn`,
          `unknown story dependency ${dependency}`,
        );
      }
      if (dependency === story.id) {
        failSchema(`$.stories[${index}].dependsOn`, "a story cannot depend on itself");
      }
      if (dependencies.has(dependency)) {
        failSchema(
          `$.stories[${index}].dependsOn`,
          `duplicate story dependency ${dependency}`,
        );
      }
      dependencies.add(dependency);
    }
  }
  const storiesById = new Map(
    document.stories.map((story) => [story.id, story]),
  );
  const visiting = new Set();
  const visited = new Set();
  function visit(storyId) {
    if (visiting.has(storyId)) {
      failSchema("$.stories", `dependency cycle includes ${storyId}`);
    }
    if (visited.has(storyId)) return;
    visiting.add(storyId);
    for (const dependency of storiesById.get(storyId).dependsOn) {
      visit(dependency);
    }
    visiting.delete(storyId);
    visited.add(storyId);
  }
  for (const story of document.stories) visit(story.id);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function manifest() {
  const [documentText, schemaText] = await Promise.all([
    safeReadFile(statePrdPath, stateRoot),
    safeReadFile(stateSchemaPath, stateRoot),
  ]);
  const document = parseJson(documentText, "PRD");
  const schema = parseJson(schemaText, "PRD schema");
  validateSchemaDefinition(schema);
  validateAgainstSchema(document, schema);
  validatePrdSemantics(document);
  return { document, documentText, schemaText };
}

async function prd() {
  return (await manifest()).document;
}

function readyStories(document) {
  const completed = new Set(
    document.stories.filter((story) => story.completed).map((story) => story.id),
  );
  return document.stories
    .filter(
      (story) =>
        !story.completed && story.dependsOn.every((dependency) => completed.has(dependency)),
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

async function status() {
  const document = await prd();
  const complete = document.stories.filter((story) => story.completed);
  const ready = readyStories(document);
  console.log(`${complete.length}/${document.stories.length} stories complete`);
  for (const story of document.stories) {
    const state = story.completed
      ? "complete"
      : ready.some((candidate) => candidate.id === story.id)
        ? "ready"
        : "waiting";
    console.log(`${story.id}  ${state.padEnd(8)}  ${story.title}`);
  }
}

async function next() {
  const document = await prd();
  console.log(JSON.stringify(readyStories(document)[0] ?? null));
}

async function prompt(storyId) {
  const document = await prd();
  const story = document.stories.find((candidate) => candidate.id === storyId);
  if (!story || story.completed) throw new Error(`Story ${storyId} is unavailable`);
  const [template, agents, progress, guardrails] = await Promise.all([
    safeReadFile(promptTemplatePath, root),
    safeReadFile(agentPath, root),
    safeReadFile(progressPath, root),
    safeReadFile(guardrailsPath, root),
  ]);
  const body = [
    template,
    "## Selected story",
    "```json",
    JSON.stringify(story, null, 2),
    "```",
    "## Repository agent instructions",
    agents,
    "## Append-only progress",
    progress,
    "## Append-only guardrails",
    guardrails,
    "## Required quality gate",
    "After story-specific commands, the outer runner executes `npm run verify`.",
  ].join("\n\n");
  await requireSafeDirectory(runPath, root, true);
  const output = path.resolve(runPath, `prompt-${story.id}.md`);
  requireContained(runPath, output, "Prompt output");
  await safeWriteFile(output, body, runPath);
  console.log(output);
}

async function restore() {
  if (!trustedDir) {
    throw new Error("Manifest restoration requires a trusted Ralph snapshot");
  }
  const { documentText, schemaText } = await manifest();
  await safeWriteFile(workspacePrdPath, documentText, root);
  await safeWriteFile(workspaceSchemaPath, schemaText, root);
}

function validateCompletion(completion, storyId) {
  if (
    completion.storyId !== storyId ||
    completion.status !== "completed" ||
    typeof completion.summary !== "string" ||
    !Array.isArray(completion.learnings) ||
    !completion.learnings.every((item) => typeof item === "string")
  ) {
    throw new Error("Codex completion does not identify this story as completed");
  }
}

async function readPendingCompletion(required = true) {
  if (!trustedDir || !completionPendingPath) {
    throw new Error("Completion transactions require a trusted Ralph snapshot");
  }
  try {
    const pending = parseJson(
      await safeReadFile(completionPendingPath, trustedDir),
      "Pending completion",
    );
    if (
      !pending ||
      typeof pending !== "object" ||
      typeof pending.storyId !== "string" ||
      typeof pending.previousWorkspacePrdText !== "string" ||
      typeof pending.previousWorkspaceSchemaText !== "string" ||
      typeof pending.previousProgressText !== "string" ||
      typeof pending.completedDocumentText !== "string" ||
      typeof pending.completedProgressText !== "string" ||
      typeof pending.schemaText !== "string"
    ) {
      throw new Error("Pending completion transaction is invalid");
    }
    return pending;
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareComplete(storyId, finalPath) {
  if (!trustedDir || !completionPendingPath) {
    throw new Error("Completion transactions require a trusted Ralph snapshot");
  }
  if (await readPendingCompletion(false)) {
    throw new Error("A completion transaction is already pending");
  }
  const { document, documentText, schemaText } = await manifest();
  const story = document.stories.find((candidate) => candidate.id === storyId);
  if (!story) throw new Error(`Unknown story ${storyId}`);
  if (story.completed) throw new Error(`Story ${storyId} is already complete`);
  await requireSafeDirectory(runPath, root);
  const completion = parseJson(
    await safeReadFile(path.resolve(finalPath), runPath),
    "Completion output",
  );
  validateCompletion(completion, storyId);
  const [
    previousWorkspacePrdText,
    previousWorkspaceSchemaText,
    previousProgressText,
  ] = await Promise.all([
    safeReadFile(workspacePrdPath, root),
    safeReadFile(workspaceSchemaPath, root),
    safeReadFile(progressPath, root),
  ]);
  if (
    previousWorkspacePrdText !== documentText ||
    previousWorkspaceSchemaText !== schemaText
  ) {
    throw new Error("Workspace manifest changed after trusted restoration");
  }
  story.completed = true;
  const completedDocumentText = `${JSON.stringify(document, null, 2)}\n`;
  const learnings = completion.learnings.length
    ? completion.learnings.map((item) => `  - ${item}`).join("\n")
    : "  - No durable learning recorded.";
  const completedProgressText =
    `${previousProgressText}\n- ${new Date().toISOString()} ${storyId} passed: ` +
    `${completion.summary}\n${learnings}\n`;
  await safeWriteFile(
    completionPendingPath,
    `${JSON.stringify({
      storyId,
      previousWorkspacePrdText,
      previousWorkspaceSchemaText,
      previousProgressText,
      completedDocumentText,
      completedProgressText,
      schemaText,
    })}\n`,
    trustedDir,
  );
  await safeWriteFile(workspacePrdPath, completedDocumentText, root);
  await safeWriteFile(workspaceSchemaPath, schemaText, root);
  await safeWriteFile(progressPath, completedProgressText, root);
}

async function finalizeComplete(storyId) {
  const pending = await readPendingCompletion();
  if (pending.storyId !== storyId) {
    throw new Error(`Pending completion belongs to ${pending.storyId}`);
  }
  const completedDocument = parseJson(
    pending.completedDocumentText,
    "Completed PRD",
  );
  const schema = parseJson(pending.schemaText, "PRD schema");
  validateSchemaDefinition(schema);
  validateAgainstSchema(completedDocument, schema);
  validatePrdSemantics(completedDocument);
  const story = completedDocument.stories.find(
    (candidate) => candidate.id === storyId,
  );
  if (!story?.completed) {
    throw new Error(`Pending completion does not complete ${storyId}`);
  }
  const [workspaceDocument, workspaceSchema, progress] = await Promise.all([
    safeReadFile(workspacePrdPath, root),
    safeReadFile(workspaceSchemaPath, root),
    safeReadFile(progressPath, root),
  ]);
  if (
    workspaceDocument !== pending.completedDocumentText ||
    workspaceSchema !== pending.schemaText ||
    progress !== pending.completedProgressText
  ) {
    throw new Error("Committed completion files changed before finalization");
  }
  await safeWriteFile(statePrdPath, pending.completedDocumentText, stateRoot);
  await safeDeleteFile(completionPendingPath, trustedDir);
}

async function rollbackComplete(storyId) {
  const pending = await readPendingCompletion(false);
  if (!pending) return;
  if (pending.storyId !== storyId) {
    throw new Error(`Pending completion belongs to ${pending.storyId}`);
  }
  await safeWriteFile(
    workspacePrdPath,
    pending.previousWorkspacePrdText,
    root,
  );
  await safeWriteFile(
    workspaceSchemaPath,
    pending.previousWorkspaceSchemaText,
    root,
  );
  await safeWriteFile(progressPath, pending.previousProgressText, root);
  await safeDeleteFile(completionPendingPath, trustedDir);
}

async function fail(storyId, message) {
  const document = await prd();
  if (!document.stories.some((story) => story.id === storyId)) {
    throw new Error(`Unknown story ${storyId}`);
  }
  await safeAppendFile(
    progressPath,
    `\n- ${new Date().toISOString()} ${storyId} failed: ${message}\n`,
    root,
  );
}

const [command = "status", ...args] = process.argv.slice(2);
try {
  if (command === "status") await status();
  else if (command === "next") await next();
  else if (command === "prompt") await prompt(args[0]);
  else if (command === "restore") await restore();
  else if (command === "prepare-complete") {
    await prepareComplete(args[0], args[1]);
  } else if (command === "finalize-complete") {
    await finalizeComplete(args[0]);
  } else if (command === "rollback-complete") {
    await rollbackComplete(args[0]);
  }
  else if (command === "fail") await fail(args[0], args.slice(1).join(" "));
  else throw new Error(`Unknown runner command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
