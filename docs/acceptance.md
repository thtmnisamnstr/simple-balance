# 0.2.0 acceptance

What is proven, how, and what is not. One row per area, each naming the evidence
that closes it — or saying plainly that nothing closes it yet.

This page exists because the alternative kept happening: a release verified by a
list of activities rather than a list of claims, where "we tested the billing
flow" reads as closed and means somebody clicked through it once. A row here is
closed only by something a person can re-run.

**Read the last section first if you are deciding whether to cut.** Four things
are outstanding and three of them are gates.

## Closed

| Area | What is claimed | What closes it |
| --- | --- | --- |
| Architecture | Three deployment shapes, one application, no code that knows which shape it is in | `docs/deployment-profiles.md`; no source file names a profile, and `docs/standards/operations.md` §A deployment profile is a shape, not a setting argues why that is the property that matters |
| Sizing | The five PostgreSQL settings and the machine behind them are stated per size | `docs/deployment-sizing.md`, held against the Pulumi program's own table by `tests/deployment-sizing.test.ts` |
| Capacity | Ten thousand people, thirty million transactions, a busy hour answered at a 130 ms 95th percentile with no errors | `docs/capacity.md`, reproducible from `scripts/capacity/`. The seed verifies zero-sum before any latency is recorded, and `tests/capacity-schedule.test.ts`, `tests/capacity-measure.test.ts` and `tests/integration/capacity-seed.integration.test.ts` hold the harness |
| Database, single node | Every supported PostgreSQL runs the schema | CI runs the whole suite against 15 and 18 on Node 22 and 24 — the floor and the version the profiles deploy |
| Database, cluster | The ledger distributes, and the application works on the result | `docs/citus.md`. Proved on a real three-node Kubernetes cluster: 17 distributed and 14 reference tables, 286 shard placements per worker, tenant reads pruning to one task, 25 of 25 endpoints answering, a coordinator failover with the ledger intact, and a rebalance onto an added worker |
| Storage and recovery | A dump restores, and the backup is read before it is kept | `deploy/systemd/simple-balance-backup` verifies every dump with `pg_restore --list` before keeping it; both scripts were run end to end against a real external PostgreSQL, taking a 32-table dump and restoring it. That run predates the rewrite both now apply to `DATABASE_URL` for libpq — `sslmode=no-verify`, which the application needs and `pg_dump` refuses, becomes `require` — and `tests/systemd-scripts.test.ts` holds the rewrite rather than a second run |
| Rollback | Each profile has a stated way back, and `ha` has a stated way it cannot go back | `docs/upgrades.md` §Rolling back from 0.2.0 |
| Flags | Every combination of billing and advertising settings has a defined meaning | `docs/monetization.md`'s truth table, held by a table-driven test in `tests/config.test.ts`; `tests/monetization-settings.test.ts` holds the parsers |
| Limits | An account cap that the screen and the server agree about | `accountAllowance` in `src/shared/domain.ts` is the single decision both read; `tests/entitlements.test.ts` and `tests/integration/account-limit.integration.test.ts` |
| Freezing | An account past a limited plan's cap is frozen — readable and counted everywhere, refusing every write — which is worked out rather than stored, and the choice of which accounts stay in use is made once | `frozenAccountIds`, `activeChoicePending`, `activeAccountChange`, `restoreAllowance` and `accountsToMarkActive` in `src/shared/domain.ts`. The server asks all five, `activeChoicePending` through `activeAccountChange`; the Accounts page asks `activeChoicePending` and `restoreAllowance` and reads each account's `frozen`, which `frozenAccountIds` decides. `tests/frozen-accounts.test.ts` and `tests/integration/frozen-accounts.integration.test.ts` hold the rule, and `tests/active-accounts-ui.test.tsx` and `tests/frozen-accounts-ui.test.tsx` the screens. The races that could take the last place twice are in `tests/integration/account-limit.integration.test.ts` |
| Downgrade | Pressing a plan button means exactly one of seven things | `subscriptionAction` in `src/shared/domain.ts`, walked against every Stripe status by `tests/subscription-action.test.ts` |
| Override | An operator can grant a plan, and the person sees that it was granted | `docs/billing-operations.md`; the `billing_override` row is the record, and the plan tab reads it |
| Webhooks | A delivery is handled once, and a redelivery changes nothing | `billing_webhook_event` and `claimWebhookEvent`; `tests/integration/billing-reconcile.integration.test.ts` |
| UI and security | The plan tab's wider policy reaches that page and no other, in both deployment shapes | `tests/csp-report-only.test.ts` and the parity suite, which compares both surfaces and both modes; CI's frontend probe asks for the page in both spellings against a real container |
| Ads | A paying subscriber never fetches Google's script at all | The server decides placement and the browser is never told the rule; `tests/ad-placement.test.ts` and two integration files, one of which is the wound-down deployment |
| Deployment | Each profile stands up and serves | `single` and `vps` both exercised end to end — `vps` across four machines, with a deposit written through the frontend to the API to the database and the postings netting to zero |
| Runtime | The image makes no outbound connection nobody configured | `tests/outbound-connections.test.ts`, which holds that `src/server` makes no bare `fetch`, that one module imports `stripe`, and that it turns the SDK's telemetry off |
| Migrating onto a cluster | A dump from a single PostgreSQL restores into Citus and distributes on the way, with the ledger still netting to zero | Run at five dataset sizes from 207,000 to 6,610,000 postings, on one node and on a coordinator with two workers. Every run restored, distributed 17 tables and replicated 14, and summed to zero afterward |
| The cluster migration, at scale | `0023` costs about 49,000 postings a second on one node and 64,000 on three, so the capacity target projects to 17–23 minutes | The table in `docs/citus-runbook.md` §Before the first start against a cluster. A straight line fits the measured range to 4.5%; the last step to 66 million is extrapolation and says so |
| Upgrade safety | A 0.1.6 deployment starts on this release with the configuration it already has | Checked surface by surface: every 0.1.6 route still answers, no setting stopped being read, no CSV column or tool was lost, and a 0.1.6 configuration was started against PostgreSQL 15 with no warnings |

## Outstanding

Three are gates you set. One is a limit of what has been measured. None is
closed by writing more code here, and none should be reported as closed.

| Area | What is not proven | Why it is still open |
| --- | --- | --- |
| **Stripe, against a real account** | The subscription schedule path, 3-D Secure — including "Pay now" on a `past_due` subscription and the invoice an uncollected upgrade hands back — proration arithmetic, which invoice reactivates an `unpaid` subscription, whether the card-pinning fix recovers a `past_due` subscription, a Link sign-in, and Google Pay's popup under the plan tab's opener policy | No live Stripe account exists. The host list is no longer a guess: the policy is Stripe's published Stripe.js set plus its Link set, plus four additions each named in `src/server/http-security.ts` — `*.hcaptcha.com`, `m.stripe.com`, `q.stripe.com` and `errors.stripe.com`. Which of those four a live account actually contacts has not been observed, and `SB_CSP_REPORT_ONLY` is how an operator finds out without enforcing anything |
| **Ads, against a real account** | No AdSense unit has ever rendered, and the ads policy — derived from how Google documents its tag and its consent message — has never been seen holding one, nor has the consent message under the referrer policy those pages now send. Account approval, site verification and the European regulations message are the operator's and have not been done for a test deployment either | No AdSense account exists |
| **The cloud programs** | Neither `deploy/pulumi/aws-single/` nor `oci-single/` has been applied, and neither `aws/` nor `gcp/` has deployed the chart | No cloud accounts with quota |
| The `ha` cluster, on a cloud | It has run on kind, where storage is local and a node is deleted politely rather than disappearing | Follows from the row above |

**On a cloud machine, the Stripe and Ads rows need a release that carries
billing and ads.** Every cloud program deploys the release image its checkout
pins — 0.1.6 until 0.2.0 is released — and that image predates both: it reads
none of their settings and starts without saying it ignored them, so a Stripe
or AdSense account applied to it proves nothing. `simple-balance:imageTag`
selects another published release, and billing and ads reach a cloud machine
with the release that carries them.

## What this page is not

It is not a test report — the suite reports itself, and the numbers move. It is
the list of **claims** and what answers each, so that the next person to ask "is
the billing flow tested?" gets a file and a line rather than a memory.

A row moves out of Outstanding when something re-runnable closes it, never
because it was discussed.
