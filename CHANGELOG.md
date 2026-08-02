# Changelog

All notable Simple Balance changes are recorded here by release.

## Unreleased

Not yet released. Current feature set:

- Self-hosted React and Hono application in one non-root Docker image
- Embedded local authentication, with optional allowlisted Google login
- Account, category, committed transaction, and staged transaction workflows
- Double-entry books: every transaction settles to zero in each currency it
  touches, opening balances post against equity, and server-owned income,
  expense, exchange, and equity counter-accounts stay out of account pickers
- Append-only postings that carry their own date: a correction appends only the
  difference, deleting posts a reversal rather than setting a flag, and a
  balance as of a date is an indexed range rather than a scan of the ledger
- Balances, dashboards, and reports derived from postings alone
- Page and all-filtered transaction selection with atomic, concurrency-safe
  mass editing across transaction, account, category, and payee views, up to
  10,000 rows per request
- Mass delete for committed transactions from both the web app and MCP
- Numbered pagination across every transaction list, with staged rows shown
  inline on category and payee detail pages
- Every list sortable by any column it displays, ascending or descending
- Required payees, optional descriptions, case-insensitive category/payee
  autocomplete, dedicated category/payee lists, safe merging, and filtered
  transaction views
- Per-account currency with same-currency and cross-currency transfers
- Amounts displayed at their currency's own precision, with crypto assets
  keeping the digits they need
- Date-filtered account views, balances, dashboards, and reports
- Duplicate-aware CSV staging with automatic category/payee resolution and
  creation, plus lossless Simple Balance CSV round trips
- OAuth-protected MCP tools sharing the web application's ledger services
- Safe, reviewable AI automation through scoped, audited MCP access
- Automatic, locked PostgreSQL schema upgrades and readiness checks
- Ralph story runner with isolated verification and guarded commits
- npm toolchain end to end, from local development through the Docker build
- Tagged multi-architecture images published to GHCR by a release workflow
- Clean initial PostgreSQL schema baseline
