# Simple Balance agent guide

## Architecture boundaries

- Keep shared Zod contracts and CSV primitives in `src/shared`.
- Keep ledger behavior in `src/server/services`; both Hono routes and MCP tools
  must call the same services.
- Treat `src/server/api.ts` and `src/server/mcp.ts` as transport adapters.
- Keep the browser UI in `src/client`; server calculations are authoritative.
- PostgreSQL is the only persistent dependency. Do not add Redis, SQLite, an
  object store, sidecar, or writable-volume requirement.

## Non-negotiable ledger invariants

- Never represent money with JavaScript/JSON floating-point numbers. Use validated
  decimal strings and PostgreSQL `numeric(44,18)`.
- Never accept a public `userId`. Derive it from the authenticated `Actor`, and
  scope every finance read/write by that ID.
- Keep `AUTH_MODE=local` as the default. Google credentials and `ALLOWED_EMAILS`
  are required only for `google` or `both`; never apply the Google allowlist to
  a valid local credential user.
- Keep first-owner creation transactional, serialized outside the application
  pool, and protected by the production setup code. Never expose a first-visitor
  claim race.
- Deposit: one positive destination posting. Withdrawal: one negative source
  posting. Transfer: negative source plus positive destination posting.
- Per-account FX stores distinct source/destination native amounts and an implied
  audit rate only. Do not add global rates or revaluation.
- Staged and soft-deleted transactions never affect balances or reports.
- Updates/deletes require an expected version. Creates and commits require
  idempotency. Bulk commits are explicit-ID, validate-first, and atomic.
- Transaction mass edits are atomic. Explicit rows carry expected versions;
  all-filtered selections carry a server-issued count and `id:version`
  fingerprint. Never silently move a transaction into a different currency or
  collapse a transfer into a single-account transaction in bulk.
- Preserve audit history, transaction provenance, and cross-currency CSV round
  trips.
- Treat `drizzle/0000_v0_1_0_initial.sql` as the immutable release baseline.
  Every schema change after 0.1.0 needs a new forward-only migration that
  preserves existing rows and backfills every new required value.
- Startup must remain the only production migration path. Keep migrations safe
  under the advisory lock, fail readiness on migration failure, and add an
  upgrade test that starts from the preceding release schema and representative
  data.

## Commands

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm verify
TEST_DATABASE_URL=postgresql://... pnpm test:integration
docker build -t simple-balance:test .
pnpm ralph --dry-run
```

## Definition of done

- Add focused tests for changed domain behavior and run the story verification
  commands from `tasks/product.prd.json`.
- Run `pnpm verify` before declaring a story complete.
- For database behavior, run the PostgreSQL integration suite when a test URL is
  available. For UI changes, verify keyboard use and responsive layouts.
- Keep changes story-scoped. Do not reset, discard, or overwrite existing work.
- Never use `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, or deprecated
  `--full-auto` in automation.
