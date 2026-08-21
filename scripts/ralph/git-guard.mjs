#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const maximumMetadataBytes = 1024 * 1024;
const maximumGitOutputBytes = 64 * 1024 * 1024;
const maximumIndexBytes = 64 * 1024 * 1024;
const attributeName = Buffer.from(".gitattributes");

function fail(message) {
  throw new Error(`Ralph Git guard: ${message}`);
}

function canonicalDirectory(input, label) {
  const resolved = realpathSync(path.resolve(input));
  const stats = lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail(`${label} must be a real directory`);
  }
  return resolved;
}

function isContained(base, target) {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function regularFileState(
  file,
  allowedRoot,
  required = false,
  maximumBytes = maximumMetadataBytes,
) {
  const resolved = path.resolve(file);
  if (!isContained(allowedRoot, resolved)) {
    fail(`${resolved} is outside its trusted Git directory`);
  }
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    fail(`${resolved} must be a single-link regular file`);
  }
  if (stats.size > maximumBytes) {
    fail(`${resolved} is unexpectedly large`);
  }
  if (realpathSync(resolved) !== resolved) {
    fail(`${resolved} must not resolve through a symbolic link`);
  }
  const content = readFileSync(resolved);
  return {
    bytes: stats.size,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

function restoreIndex(gitDirectory, previousIndex) {
  const indexPath = path.join(gitDirectory, "index");
  const currentIndex = regularFileState(
    indexPath,
    gitDirectory,
    false,
    maximumIndexBytes,
  );
  if (!previousIndex) {
    if (currentIndex) unlinkSync(indexPath);
    return;
  }
  writeFileSync(indexPath, previousIndex.content, {
    flag: "w",
    mode: 0o600,
  });
  const restored = regularFileState(
    indexPath,
    gitDirectory,
    true,
    maximumIndexBytes,
  );
  if (
    restored.bytes !== previousIndex.bytes ||
    restored.sha256 !== previousIndex.sha256
  ) {
    fail("could not restore the pre-commit Git index");
  }
}

function scanConfig(file, state) {
  if (!state) return;
  const text = state.content.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate || candidate.startsWith("#") || candidate.startsWith(";")) {
      continue;
    }
    if (/^\[\s*(?:filter|include|includeif)(?:\s|\])/i.test(candidate)) {
      fail(`${file} contains an executable or included configuration section`);
    }
    // git accepts a key on the same line as its section header, so the key
    // pattern has to see the line with any header stripped off. Tested only
    // against the raw line, `[core] fsmonitor = ...` walked straight past a
    // check that caught the same key written underneath.
    const bare = candidate.replace(/^\[[^\]]*\]\s*/, "");
    if (/^(?:fsmonitor|include(?:if)?\.|filter\.)/i.test(bare)) {
      fail(`${file} contains an executable or included configuration key`);
    }
  }
}

function scanAttributes(label, content) {
  if (content.byteLength > maximumMetadataBytes) {
    fail(`${label} is unexpectedly large`);
  }
  const text = content.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trimStart();
    if (!candidate || candidate.startsWith("#")) continue;
    if (/(?:^|[ \t])(?:-filter|!filter|filter(?:=|[ \t]|$))/.test(candidate)) {
      fail(`${label} assigns a Git content filter`);
    }
  }
}

function scanGitMetadataTree(directory) {
  const pending = [directory];
  const entries = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const names = readdirSync(current).sort();
    for (const name of names) {
      const entry = path.join(current, name);
      const relative = path.relative(directory, entry);
      const stats = lstatSync(entry);
      if (stats.isSymbolicLink()) {
        fail(`${entry} must not be a symbolic link`);
      }
      if (stats.isDirectory()) {
        if (realpathSync(entry) !== entry) {
          fail(`${entry} resolves outside the Git metadata tree`);
        }
        entries.push({ path: relative, type: "directory" });
        pending.push(entry);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        fail(`${entry} must be a single-link regular Git metadata file`);
      }
      if (realpathSync(entry) !== entry) {
        fail(`${entry} resolves outside the Git metadata tree`);
      }
      entries.push({
        path: relative,
        type: "file",
        bytes: stats.size,
        sha256: createHash("sha256")
          .update(readFileSync(entry))
          .digest("hex"),
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function captureGitTrees(gitDirectory, commonDirectory) {
  return {
    common: scanGitMetadataTree(commonDirectory),
    worktree:
      gitDirectory === commonDirectory
        ? null
        : scanGitMetadataTree(gitDirectory),
  };
}

function splitNull(buffer) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    entries.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) fail("Git returned a non-NUL-terminated path list");
  return entries;
}

function isAttributePath(buffer) {
  if (buffer.equals(attributeName)) return true;
  return (
    buffer.length > attributeName.length &&
    buffer[buffer.length - attributeName.length - 1] === 0x2f &&
    buffer.subarray(buffer.length - attributeName.length).equals(attributeName)
  );
}

function decodeGitPath(buffer) {
  const decoded = buffer.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(buffer)) {
    fail("a Git path is not valid UTF-8");
  }
  return decoded;
}

function createGitContext({
  root,
  gitDirectory,
  commonDirectory,
  executable,
  authorName,
  authorEmail,
}) {
  const gitExecutable = realpathSync(path.resolve(executable));
  const executableStats = lstatSync(gitExecutable);
  if (!executableStats.isFile()) fail("Git executable must be a regular file");
  const environment = {
    PATH: `${path.dirname(gitExecutable)}:/usr/bin:/bin`,
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: root,
  };
  if (authorName && authorEmail) {
    Object.assign(environment, {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    });
  }
  const fixedArguments = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
  ];

  function git(arguments_, output = "buffer") {
    const result = spawnSync(
      gitExecutable,
      [...fixedArguments, ...arguments_],
      {
        cwd: root,
        env: environment,
        encoding: output === "inherit" ? undefined : "buffer",
        stdio: output === "inherit" ? "inherit" : "pipe",
        maxBuffer: maximumGitOutputBytes,
      },
    );
    if (result.error) fail(result.error.message);
    if (result.signal) fail(`Git ${arguments_[0]} terminated by ${result.signal}`);
    if (result.status !== 0) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8").trim()
        : "";
      fail(
        `Git ${arguments_[0]} exited with ${result.status}${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  }

  return { git, commonDirectory, gitDirectory };
}

function metadataPaths(gitDirectory, commonDirectory) {
  return [
    { name: "config", path: path.join(commonDirectory, "config"), required: true },
    {
      name: "worktreeConfig",
      path: path.join(gitDirectory, "config.worktree"),
      required: false,
    },
    {
      name: "commonAttributes",
      path: path.join(commonDirectory, "info/attributes"),
      required: false,
      attributes: true,
    },
    ...(gitDirectory === commonDirectory
      ? []
      : [
          {
            name: "worktreeAttributes",
            path: path.join(gitDirectory, "info/attributes"),
            required: false,
            attributes: true,
          },
        ]),
  ];
}

function captureMetadata(gitDirectory, commonDirectory) {
  const captured = {};
  for (const entry of metadataPaths(gitDirectory, commonDirectory)) {
    const allowedRoot = entry.path.startsWith(`${gitDirectory}${path.sep}`)
      ? gitDirectory
      : commonDirectory;
    const state = regularFileState(entry.path, allowedRoot, entry.required);
    if (entry.attributes && state) scanAttributes(entry.path, state.content);
    if (!entry.attributes) scanConfig(entry.path, state);
    captured[entry.name] = state
      ? { bytes: state.bytes, sha256: state.sha256 }
      : null;
  }
  return captured;
}

function scanRepositoryAttributes(root, context) {
  const addable = splitNull(
    context.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  );
  const worktreeAttributeFiles = new Set([path.join(root, ".gitattributes")]);
  for (const encodedPath of addable) {
    const relative = decodeGitPath(encodedPath);
    let directory = path.dirname(path.resolve(root, relative));
    if (!isContained(root, directory)) {
      fail(`Git path escapes the worktree: ${relative}`);
    }
    while (isContained(root, directory)) {
      worktreeAttributeFiles.add(path.join(directory, ".gitattributes"));
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }
  // Check attribute files from the filesystem directly, including ignored
  // .gitattributes files that `git ls-files --others --exclude-standard`
  // intentionally omits. An attribute file can affect only its own directory
  // and descendants, so the ancestors of every addable path are exhaustive.
  for (const file of worktreeAttributeFiles) {
    const relative = path.relative(root, file);
    if (!isContained(root, file)) fail(`attribute path escapes the worktree: ${relative}`);
    let stats;
    try {
      stats = lstatSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      realpathSync(file) !== file
    ) {
      fail(`${relative} must be a single-link regular attribute file`);
    }
    scanAttributes(relative, readFileSync(file));
  }

  const index = splitNull(context.git(["ls-files", "--stage", "-z"]));
  for (const record of index) {
    const tab = record.indexOf(0x09);
    if (tab < 0) fail("Git returned a malformed index record");
    const metadata = record.subarray(0, tab).toString("ascii").split(" ");
    const encodedPath = record.subarray(tab + 1);
    if (!isAttributePath(encodedPath)) continue;
    if (metadata.length !== 3 || !/^[0-9a-f]+$/.test(metadata[1])) {
      fail("Git returned malformed index metadata");
    }
    const relative = decodeGitPath(encodedPath);
    const content = context.git(["cat-file", "blob", metadata[1]]);
    scanAttributes(`index:${relative}`, content);
  }
}

function loadManifest(file) {
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    fail("trusted Git manifest must be a single-link regular file");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshot(args, replace = false) {
  const [rootInput, gitInput, commonInput, executable, manifestPath] = args;
  const root = canonicalDirectory(rootInput, "workspace");
  const gitDirectory = canonicalDirectory(gitInput, "Git directory");
  const commonDirectory = canonicalDirectory(commonInput, "Git common directory");
  const context = createGitContext({
    root,
    gitDirectory,
    commonDirectory,
    executable,
  });
  const gitTrees = captureGitTrees(gitDirectory, commonDirectory);
  const metadata = captureMetadata(gitDirectory, commonDirectory);
  scanRepositoryAttributes(root, context);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      root,
      gitDirectory,
      commonDirectory,
      metadata,
      gitTrees,
    })}\n`,
    {
      encoding: "utf8",
      flag: replace
        ? constants.O_WRONLY | constants.O_TRUNC
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode: 0o600,
    },
  );
}

function validateRepository(args, authorName, authorEmail) {
  const [rootInput, gitInput, commonInput, executable, manifestPath] = args;
  const root = canonicalDirectory(rootInput, "workspace");
  const gitDirectory = canonicalDirectory(gitInput, "Git directory");
  const commonDirectory = canonicalDirectory(commonInput, "Git common directory");
  const manifest = loadManifest(manifestPath);
  if (
    manifest.root !== root ||
    manifest.gitDirectory !== gitDirectory ||
    manifest.commonDirectory !== commonDirectory
  ) {
    fail("Git repository paths changed after the agent run");
  }
  const gitTrees = captureGitTrees(gitDirectory, commonDirectory);
  if (JSON.stringify(gitTrees) !== JSON.stringify(manifest.gitTrees)) {
    fail("Git metadata changed after the agent run");
  }
  const metadata = captureMetadata(gitDirectory, commonDirectory);
  if (JSON.stringify(metadata) !== JSON.stringify(manifest.metadata)) {
    fail("Git configuration or info attributes changed after the agent run");
  }
  const context = createGitContext({
    root,
    gitDirectory,
    commonDirectory,
    executable,
    authorName,
    authorEmail,
  });
  scanRepositoryAttributes(root, context);
  return context;
}

function commit(args) {
  const [
    rootInput,
    gitInput,
    commonInput,
    executable,
    manifestPath,
    authorName,
    authorEmail,
    message,
  ] = args;
  if (!authorName || !authorEmail) {
    fail("Git user.name and user.email must be configured before starting Ralph");
  }
  const context = validateRepository(
    [rootInput, gitInput, commonInput, executable, manifestPath],
    authorName,
    authorEmail,
  );
  const previousIndex = regularFileState(
    path.join(context.gitDirectory, "index"),
    context.gitDirectory,
    false,
    maximumIndexBytes,
  );
  try {
    context.git(["add", "-A"], "inherit");
    context.git(["commit", "-m", message], "inherit");
  } catch (error) {
    try {
      restoreIndex(context.gitDirectory, previousIndex);
    } catch (restoreError) {
      fail(
        `${error instanceof Error ? error.message : error}; index rollback failed: ${
          restoreError instanceof Error ? restoreError.message : restoreError
        }`,
      );
    }
    throw error;
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "snapshot" && args.length === 5) snapshot(args);
  else if (command === "refresh" && args.length === 5) snapshot(args, true);
  else if (command === "check" && args.length === 5) validateRepository(args);
  else if (command === "commit" && args.length === 8) commit(args);
  else {
    fail(
      "usage: git-guard.mjs snapshot|refresh|check ROOT GIT_DIR COMMON_DIR GIT MANIFEST | commit ROOT GIT_DIR COMMON_DIR GIT MANIFEST NAME EMAIL MESSAGE",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
