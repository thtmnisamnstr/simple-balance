# Ralph build loop

Ralph reads `tasks/product.prd.json`, selects the highest-priority incomplete
story whose dependencies are complete, and gives one fresh, ephemeral Codex
context exactly that story. Story IDs use the release-neutral `SB-###` format.

```sh
pnpm ralph --status
pnpm ralph --dry-run
pnpm ralph --max-iterations 5
```

Add future work to `tasks/product.prd.json` with the next `SB-###` ID, explicit
dependencies, acceptance criteria, and verification commands. Bump the manifest
version for a release and never reuse a released story ID.

Each real iteration builds a prompt from the PRD, `AGENTS.md`, progress, and
guardrails; runs non-interactive Codex with `workspace-write`, JSONL logs, and a
structured final response; runs story checks and `pnpm verify`; then marks the
story complete and creates one commit. Failed work is preserved and logged for the
next iteration. An atomic `.ralph/lock` prevents concurrent loops.

Before Codex starts, the driver, state updater, completion schema, PRD/schema,
and verifier are copied to a private temporary directory outside the workspace.
Story IDs and dependencies are validated, and the trusted PRD is restored after
every agent run. After Codex returns, no workspace-controlled test or package
script runs directly with the host user's permissions. Verification uses a
disposable source copy:

- On macOS, `sandbox-exec` allows writes only within that copy and denies
  general network access. It permits only one freshly selected loopback port
  for the raw-socket unit test, plus the disposable database port when needed.
  Verification starts with a minimal environment and a disposable home
  directory, so host credentials are not inherited.
- On Linux, a read-only, capability-free `node:24-alpine` container mounts only
  that copy and has no network access.

The runner fails closed if the platform sandbox is unavailable. On Linux, build
the application image once or pull `node:24-alpine` before starting the loop.
The exact `docker build -t simple-balance:test .` story gate is handled as a
fixed build against the disposable copy and requires explicit network opt-in;
arbitrary workspace-provided Docker commands never receive the host Docker
socket. Story commands run in separate shells, and the mandatory quality gate
is launched directly by an immutable helper. Ralph snapshots the package-script
map before Codex starts; the restricted package runner refuses any later script
definition change and executes the trusted command text instead of a mutable
`package.json` value.
Story commits run through an immutable Git guard. It ignores global/system
configuration and attributes, neutralizes hooks, signing, and fsmonitor, and
fails closed if any Git metadata changed during the agent run. It recursively
rejects metadata symlinks/hardlinks and checks repository, ignored, info, and
index `.gitattributes` for content filters, so an agent cannot change the
verified tree or turn host-side staging into command execution.
Git identity is checked before Codex starts. Completion files are prepared for
the story commit but are finalized in trusted state only after that commit
succeeds; a commit failure restores the prior PRD and progress while leaving
implementation work intact.

Stories that require PostgreSQL receive a disposable `postgres:16-alpine`
database on an isolated internal network; integration tests fail closed if that
local image is unavailable instead of silently passing as skipped. On macOS, a
fixed read-only `nc` proxy exposes only that PostgreSQL endpoint to the Seatbelt
sandbox; the database itself remains unable to reach the internet.

Network is disabled by default. For a dependency/container story with
`"networkAllowed": true`, opt in with:

```sh
pnpm ralph --network --max-iterations 1
```

The opt-in applies to Codex implementation and the one fixed Docker build gate.
Untrusted verification commands still have no general network or Docker-daemon
access. The runner refuses opt-in for other stories. It never uses deprecated
`--full-auto` or unsafe bypass/`--yolo` modes.
