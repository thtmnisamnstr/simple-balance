# Ralph guardrails

This file is append-only. Ralph must preserve these durable constraints and may
append new ones.

- Never convert boundary money strings to JavaScript numbers for calculations.
- Every finance query must include the authenticated actor's user ID even when an
  entity ID is globally unique.
- A failed iteration keeps its working tree and logs; later iterations diagnose
  and continue instead of resetting.
- Network access stays disabled unless both the PRD story allows it and the
  operator passes `--network`.
- The outer runner, not the isolated Codex iteration, owns commits and PRD status.
- Better Auth MCP access tokens are wrapped in persistent RS256 JWTs. Preserve
  the audience check, public-only JWKS response, and underlying Better Auth
  expiry/revocation lookup.
- `AUTH_MODE=local` is the zero-Google production default. Require Google
  credentials and a normalized allowlist only in `google` or `both` mode.
- A ledger owner may authenticate through a credential account, a permitted
  linked Google account, or both. Never create a second ledger user when adding
  the other method; use explicit account linking.
- Keep first-owner local registration serialized by a PostgreSQL advisory lock
  and closed after the first Better Auth user exists.
- Do not hold a main-pool connection while Better Auth needs that pool. Owner
  registration uses one dedicated lock connection plus `pg_try_advisory_lock`.
- Keep Better Auth's Drizzle adapter transactions enabled. A user row without
  its credential/provider account must never close first-owner registration.
- Production local owner creation requires the startup-log setup code (or an
  operator-provided `SETUP_TOKEN`) until the first user exists.
- Never rewrite a released migration. Add a forward-only migration with
  deterministic data backfills and a preceding-release upgrade test. Startup
  remains the production migration path.
