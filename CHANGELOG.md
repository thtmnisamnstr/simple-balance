# Changelog

All notable Simple Balance changes are recorded here by release.

## Unreleased

Not yet released. Current feature set:

- Self-hosted React and Hono application in one non-root Docker image
- Embedded local authentication, with optional allowlisted Google login
- Account, category, committed transaction, and staged transaction workflows
- Page and all-filtered transaction selection with atomic, concurrency-safe
  mass editing across transaction, account, category, and payee views
- Required payees, optional descriptions, case-insensitive category/payee
  autocomplete, dedicated category/payee lists, safe merging, and filtered
  transaction views
- Per-account currency with same-currency and cross-currency transfers
- Date-filtered account views, balances, dashboards, and reports
- Duplicate-aware CSV staging with automatic category/payee resolution and
  creation, plus lossless Simple Balance CSV round trips
- OAuth-protected MCP tools sharing the web application's ledger services
- Safe, reviewable AI automation through scoped, audited MCP access
- Automatic, locked PostgreSQL schema upgrades and readiness checks
- Ralph story runner with isolated verification and guarded commits
- Clean initial PostgreSQL schema baseline
