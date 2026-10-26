# Deployment

Simple Balance is one container and one PostgreSQL database. There is no Redis,
no sidecar, no object store, and nothing it needs to write to disk.

PostgreSQL 15 or newer. Every release is tested against 15 and 18 — the floor
for a server you bring, and the version both deployment profiles run where they
provision one — on Node 22 and 24. Nothing else is assumed about the server.

This page is the settings and the contract: what every variable does, what a
reverse proxy has to send, and what the split containers have to agree about.
For a deployment that runs somewhere and survives a reboot, read
[`deployment-profiles.md`](deployment-profiles.md) beside it — it compares the
two profiles, gives the encryption guarantees, the firewall and DNS, and points
at the material that stands each one up.
[`deployment-sizing.md`](deployment-sizing.md) says how big the machines have to
be and [`deployment-costs.md`](deployment-costs.md) what they cost.

## Settings

Everything is an environment variable. `.env.example` has all of them; these are
the ones that matter.

Where the variables are set depends on how the deployment was built. Installed
by hand, they are the `.env` file. Built by one of the programs in
`deploy/pulumi/`, they are the Pulumi stack's — `simple-balance:env` for the
plain ones and `simple-balance:secrets` for the ones this page calls secrets —
and the program keeps them in the cloud's own secret store and delivers them to
the machine or the cluster; a `pulumi up` changes one.
[deploy/pulumi/README.md](../deploy/pulumi/README.md#the-applications-settings)
has the commands, with a `.env` file to fill a stack from and without one.

### Required in production

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 15+ connection string. Encrypt and verify it whenever the connection leaves the host, which in both deployment profiles it does; see TLS below for which `sslmode` to use. The database it names is created if the server does not have it yet. |
| `AUTH_SECRET` | At least 32 random characters. `openssl rand -base64 32`. Keep it: changing it signs everyone out. A value published in this project's own files, including whatever `.env.example` carried, is refused by name. |
| `APP_BASE_URL` | Your canonical public origin, exactly as the browser sees it. HTTPS anywhere but localhost. |
| `NODE_ENV` | `production`. Every image sets it for you; a host running `npm start` does not, and unset reads as development. See below for what that costs. |

`APP_BASE_URL` is load-bearing beyond cosmetics: secure cookies, the OAuth
issuer metadata, redirect validation, and the audience on MCP tokens are all
derived from it. Get it wrong and sign-in fails in ways that look unrelated.

So is `NODE_ENV`. Outside production the first-run setup code is not demanded,
sign-in attempts are not rate limited, and cookies are not marked secure: those
three together are the difference between a deployment and a development
machine.

It is parsed against `production`, `development` and `test` and refuses anything
else, because comparing to one string turned every other spelling into
development with no symptom at all. A process outside production that has been
given an `APP_BASE_URL` naming anything but localhost refuses to start: that
setting is the one only a real deployment has, so it is worth failing on rather
than warning about.

### Optional

| Variable | Default | What it does |
| --- | --- | --- |
| `AUTH_MODE` | `local` | Which sign-in methods are offered. See below. |
| `ALLOWED_EMAILS` | unset | Who may register. Unset admits nobody but the first account. See below. |
| `SETUP_TOKEN` | generated | The one-time code that claims a fresh instance. At least 16 characters if you set it. A shorter one refuses to start while no account exists, which is the only time the code is read, and is warned about at every other start. Left unset, one is generated and printed to the startup log. It is a secret, so it also takes a `SETUP_TOKEN_FILE`; see below. |
| `PORT` | `3000` | The port inside the container. Change it and your published port mapping has to follow. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. It governs this product's own lines as well as the auth library's, so `error` really is quiet. The auth library writes through the same gate, each line tagged `[Better Auth]`, with every email address in what it writes replaced by `[email address]` — at `info` it used to log the address of every sign-up that named an existing account — and a failure inside one of its routes is logged like any other, as the statement that failed without the values it was given. A few notices about the library's own setup still go straight to the console; none carries anything from a request. `debug` adds a line per HTTP request, per MCP tool call, per message sent and per scheduler tick that found nothing due; `info` keeps startup, mail, shutdown and the ticks that actually proposed or reminded. A refusal at startup is reported whatever it is set to, and so is the first-run setup code. |
| `TRUST_PROXY` | `false` | Turn it on when a reverse proxy sits in front and replaces `X-Forwarded-For`. See the reverse proxy section; getting it wrong costs per-visitor rate limiting. |
| `DATABASE_POOL_SIZE` | `10` | Connections held open, per process. Ceiling 100. Raise it only if you have measured contention, and see the split-container section for what it means once there is more than one replica. |
| `DIRECT_DATABASE_URL` | `DATABASE_URL` | A second connection string that bypasses a transaction pooler. Only needed when PgBouncer or similar sits in front; see below. It carries a password, so it also takes a `DIRECT_DATABASE_URL_FILE`. |
| `CSV_MAX_BYTES` | `10485760` | Largest CSV accepted for import, 10 MB by default. Ceiling 104857600. |
| `CSV_MAX_ROWS` | `10000` | Most rows accepted from one CSV. Ceiling 10000, which is also the most rows one mass edit, commit, or delete covers, so an import always fits in a single review-queue action. |
| `RECURRENCE_SCHEDULER` | `true` | Whether this process runs the schedule at all: proposing recurring transactions, sending the reminders and proposal notices that go by email, and — where Stripe is configured — the twelve-hourly sweep that re-reads subscriptions Stripe stopped telling us about. Turn it off on replicas that serve the API when a separate scheduler container owns the job; it has to be on **somewhere**, or a delivery Stripe gave up on leaves somebody on a plan they canceled. The process warns at startup while Stripe is configured and this is off. A value other than `true` or `false` refuses to start, because the wrong setting is otherwise silent. |
| `RECURRENCE_TICK_SECONDS` | `300` | How often it looks for work that has come due, meaning both a recurrence to propose and a reminder to send. Latency only for a recurrence: whatever a missed tick leaves behind, the next one catches up. A reminder whose moment passed is not sent late, so this is also how close to the requested time a reminder lands. Ceiling 3600. |
| `RECURRENCE_CATCH_UP_LIMIT` | `50` | Most occurrences one recurrence catches up in one tick. Nothing is dropped; a tick that hits the cap comes straight back rather than waiting out the interval. Ceiling 500. |
| `RECURRENCE_CLAIM_LIMIT` | `500` | Most recurrences examined in one tick. Ceiling 5000. |
| `IDEMPOTENCY_RETENTION_HOURS` | `0`, meaning forever | How long a used idempotency key keeps replaying. Every create, commit and bulk write stores a copy of its response so a retried request answers the same way twice; nothing prunes those copies unless you set this, and on a busy deployment the table outgrows the ledger. Zero, unset or empty all mean keep everything, which is what every release before this one did. A window is safe because the record makes a retry *quiet* rather than safe: a repeated create still meets the duplicate check, a repeated commit finds its rows already committed, and a repeated bulk write carries a count and fingerprint that no longer match. Ceiling 8760, one year. Needs `RECURRENCE_SCHEDULER` on somewhere, since the sweep rides its tick. |
| `METRICS_ENABLED` | `false` | Whether this process answers `GET /metrics` in Prometheus' text format, at exactly that path. Off unless you ask for it — or unless the metrics collector is turned on where something derives it: a machine one of the single-machine programs built, the chart, and the cluster programs. By hand it is set beside the collector; see [metrics](#metrics). |
| `METRICS_TOKEN` | unset | A bearer token `GET /metrics` demands before it answers, and the one the metrics collector sends. Optional; unset means anybody who can reach the port can scrape it. It is a secret, so it also takes a `METRICS_TOKEN_FILE`; see below. |
| `SB_CSP_REPORT_ONLY` | `false` | Rehearses the plan and billing tab's content security policy instead of enforcing it: that page reports what would have been blocked and blocks nothing, and `POST /api/csp-report` is registered for the reports. Every other page goes on enforcing, and that includes every page that can carry an ad, so this rehearses nothing about advertising: an ad the policy refuses shows up as a content security policy violation in the browser's console, on a page showing one. For the hour after turning billing on; the process warns at every start while it is set. In the split deployment set it on the frontend container too — nginx serves that document, so its copy is the one that decides. |

`CSV_MAX_BYTES`, `CSV_MAX_ROWS`, `DATABASE_POOL_SIZE`,
`RECURRENCE_TICK_SECONDS`, `RECURRENCE_CATCH_UP_LIMIT` and
`RECURRENCE_CLAIM_LIMIT` are each a whole number between 1 and the ceiling
shown. Anything else — a word, a zero, a negative, something past the ceiling —
warns at startup, names the variable and the value, and uses the default.
Leaving one out is the only way to ask for its default without a warning.

`IDEMPOTENCY_RETENTION_HOURS` follows the same rule with one difference: zero is
a real answer there rather than a mistake, because "keep everything" is a
setting somebody may want to state rather than only inherit. So zero is accepted
in silence, and anything unreadable warns and keeps everything — falling back to
*off* rather than to a window, since the other direction would prune on a typo.

All seven are read at startup, before anything is served, so the warning is in
front of whoever just deployed rather than in a log nobody opens until the day
it matters. They used to be read at the moment they were wanted, which is a
combination with no symptom at all: `CSV_MAX_ROWS=1O000`, typed with a letter O,
ran happily on ten thousand rows and told nobody the number set was not the
number in force. A warning rather than a refusal because a deployment carrying
one of these values from an earlier release has to keep starting; the release
that stops accepting it is a later one, after the warning has been in the
field.

The rest refuse to start for the same reason. `NODE_ENV`, `AUTH_MODE`,
`LOG_LEVEL`, `TRUST_PROXY` and `RECURRENCE_SCHEDULER` are each parsed against
the values they accept and nothing else: comparing to one string is what turns
every other spelling into the default with no symptom at all, and for
`RECURRENCE_SCHEDULER` that default would be a schedule quietly not running.
`PORT` and `SMTP_PORT` have to be ports. `DATABASE_POOL_SIZE` is not among
them: it has a ceiling of its own, because too many connections takes the
database down rather than this process, and a value past it warns and runs at
its default like the bounded integers above.

### Limits you cannot change

These are compiled in rather than configured, because each one bounds something
a person or an agent could otherwise use to fill the database. They are here so
a refusal is explainable rather than surprising.

| Limit | Value | What hits it |
| --- | --- | --- |
| Rows in one mass edit or mass delete | 10,000 | A selection larger than this is refused rather than truncated. Split the work across calls; each one stands or falls on its own. |
| Category legs on one transaction | 50 | Far past a receipt anybody itemizes by hand. A split is the whole counter-side of the entry rewritten, so the cost is paid on every read of it. |
| Recurring transactions per person | 200 | Each one is a standing rule that proposes rows on every tick, so an uncapped list is a way to flood Staged transactions with nothing but `ledger:write`. |
| Transaction templates per person | 200 | A template is read into the form's dropdown on every visit, so the list is loaded whole rather than paged. |
| Columns in one report | 600 | A long history asked for weekly buckets is thousands of columns nobody can read. Refused with the coarser bucket named, rather than served slowly. |
| Postings in one register | 10,000 | Refused rather than truncated: a register is read to find the row a balance went wrong on, and one cut short would close on a balance its own last row does not reach. Narrow the date range. |
| Consecutive skipped occurrences a reminder looks past | 400 | A rule whose every date its own policies skip — the 31st of every month with `skip`, say — has no schedule left to speak of, and the bound is what keeps it from spinning inside a scheduler tick. |
| Interval on a schedule | 366 | The N in "every N days", for a recurrence and for a template reminder alike. |

### Only for Google sign-in

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | The OAuth client this deployment signs people in with. Required when `AUTH_MODE` is `google` or `both`, and ignored otherwise. |
| `GOOGLE_CLIENT_SECRET` | unset | That client's secret. Required alongside the ID. It is a secret, so it also takes a `GOOGLE_CLIENT_SECRET_FILE`; see below. |

Google modes refuse to start without both, and without an `ALLOWED_EMAILS` that
admits somebody, rather than silently letting everyone in.

### Your privacy policy and terms of use

| Variable | Default | What it does |
| --- | --- | --- |
| `PRIVACY_POLICY_URL` | unset | Where this deployment's privacy policy lives. Linked, whenever it is set, from the sign-in and sign-up screens and from the sidebar on every page, because the sign-up form is where a name and an address are first collected and California's online privacy law expects a policy conspicuous there. **Required whenever AdSense is configured** — Google's program policies require one on any site serving their ads, and the server refuses to start without it rather than letting an operator breach them from the first impression. Must be absolute and https. |
| `TERMS_OF_USE_URL` | unset | Where this deployment's terms of use live. Linked beside the privacy policy wherever that is. With it set, the sign-up form and the **Continue with Google** button each say, directly above the button, that creating an account accepts these terms, and the plan tab links them from the renewal terms it shows beside every request to pay. Optional, and never required. Must be absolute and https. |

This software ships neither document and cannot write yours: what it does is
one input to them, and the rest is who you are and what else you run. Both are
read at startup, so an address that is relative or plain http refuses to start
and names the variable. A blank value is the same as unset, which is what every
compose recipe passes when you set nothing.

Both names are unprefixed, which the `SB_` rule for names this product invents
does not allow. They shipped this way in 0.2.0, so these are their spellings;
`docs/standards/operations.md` §Naming records them as named exceptions. The
two are spelled the same way, and always will be.

### Only for selling a plan

| Variable | Default | What it does |
| --- | --- | --- |
| `SB_BILLING_ENABLED` | `false` | Whether this deployment sells a plan, and holds a free account to three financial accounts in use, freezing the rest. `true` or `false`; anything else refuses to start. Setting it without the five Stripe settings below refuses to start too, because a plan nobody can be charged for is an upgrade button that always fails. |
| `STRIPE_SECRET_KEY` | unset | The key this process charges, refunds and cancels with. A restricted key, `rk_…`, is what §Setting up Stripe step 2 builds, and it must carry PaymentIntents: Write and PaymentMethods: Write and must not be agent-tagged — Stripe holds an agent-tagged key's `subscriptions.cancel` for a person to approve, which this deployment has nobody to do. A live key while `NODE_ENV` is not `production` refuses to start. It is a secret, so it also takes a `STRIPE_SECRET_KEY_FILE`; see below. |
| `STRIPE_PUBLISHABLE_KEY` | unset | The key the browser loads Stripe's payment form with. It is published to every visitor by design, so it is a setting rather than a secret. A live key here beside a test secret key, or the reverse, refuses to start. |
| `STRIPE_WEBHOOK_SECRET` | unset | What a delivery from Stripe is verified against. Without it a forged request could tell this deployment an invoice was paid. It is a secret, so it also takes a `STRIPE_WEBHOOK_SECRET_FILE`; see below. |
| `STRIPE_PRICE_MONTHLY_ID` | unset | The monthly price, `price_…`. A product id here is the usual mistake and is refused at startup rather than at the first checkout. |
| `STRIPE_PRICE_YEARLY_ID` | unset | The annual price, `price_…`. Both prices belong to one product. |

What has to exist at Stripe before these mean anything — the product and its
two prices, the webhook endpoint, the customer emails, the retry settings and
the payment method domain — is
[`billing-operations.md` §Setting up Stripe](billing-operations.md#setting-up-stripe),
in the order to do it.

**`RECURRENCE_SCHEDULER` has to be on somewhere.** The twelve-hourly
reconciliation sweep rides its tick, and that sweep is the only repair for a
delivery Stripe gave up on or never sent — Stripe retries for up to 72 hours
and then stops. Without it a subscription canceled at Stripe goes on entitling
somebody to the paid plan indefinitely, because the entitlement is read from
the stored status and nothing else expires it. Turning it off on web replicas
is right when a separate scheduler container has it on; turning it off on a
single process is the case that costs, and the process warns at startup while
Stripe is configured and it is off.

A `price_` prefix is all a string can say, so what the two ids name is asked of
Stripe. Both have to be recurring, the monthly one billed every `month` and the
annual one every `year`, one interval at a time; in the same currency as each
other and prices of the same product; in the same mode as `STRIPE_SECRET_KEY`,
so test prices beside a test key and live ones beside a live key; and active,
which is checked only while `SB_BILLING_ENABLED` is `true`, because archiving
the prices is what winding a deployment down looks like. An id Stripe has no
price for is the same mistake from another angle, usually a test id beside a
live key or an id from another account.

The check runs once as each API and scheduler process starts, and again
whenever the prices are read — the plan tab, before every subscription is
started, and every reconciliation sweep — on a read at most ten minutes old. A
mismatch is one error line in the log, written when the verdict changes rather
than every time, and from then on nothing is sold:
`PUT /api/v1/billing/subscription` answers `409 CONFLICT` with
`details.prices` set to `misconfigured` and says nothing was charged, and
`GET /api/v1/billing` reports `selling: false`. Changing the payment method,
canceling, paying a renewal's open invoice, and letting go of a switch still
waiting for the renewal keep working from the plan tab, because they serve
subscriptions that already exist. Stripe being unreachable is a warning and
refuses nothing — a sale then goes ahead and meets Stripe on its own terms —
and prices that fit are said once, as
`Stripe is configured, and both prices fit the plans they are sold as.`

### The webhook, and which events it has to be sent

Point a Stripe webhook endpoint at `https://your-host/api/billing/webhook` and
**subscribe it to exactly these event types**. Stripe makes the selection a
required step and nothing in this deployment can see what you chose, so an
endpoint subscribed to the wrong set fails silently — the deliveries that matter
never arrive, and the ones that do are acknowledged.

| Event | Why this deployment needs it |
| --- | --- |
| `customer.subscription.created` | A subscription that began somewhere other than the plan tab. |
| `customer.subscription.updated` | Every change of status, price, cancellation and renewal. This is the one that grants and revokes the plan. |
| `customer.subscription.deleted` | The end of a subscription, however it ended. |
| `invoice.paid` | The only thing treated as proof that a first payment succeeded. |
| `invoice.payment_failed` | Starts the fifteen-day grace, by recording when the failure happened. |
| `setup_intent.succeeded` | Makes a replacement payment method the one Stripe bills. Without it, a method saved during a 3-D Secure redirect is attached and never used, and dunning goes on retrying the dead one. A method the subscription cannot be billed with — one of a kind this deployment does not offer, or one Stripe refuses for the subscription's currency — is recorded and acknowledged rather than retried, because a delivery that fails is retried for 72 hours and the answer will not change. |
| `customer.deleted` | Drops a customer mapping Stripe no longer has, so the next attempt to subscribe is not made against a customer that does not exist. |
| `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn` | Logged for an operator to act on. None of them changes an entitlement by itself. |

Anything else is acknowledged and ignored, so subscribing to more than this
costs only noise. Subscribing to less is the failure that is hard to see.

**The grace is fifteen days, and Stripe's retry setting decides whether that is
enough.** A renewal that is declined leaves the subscription `past_due`, and it
keeps the paid plan for fifteen days from the failure. From the fifteenth day it
is on the free plan until a payment succeeds, which freezes the accounts a free
plan does not keep active and, where ads are configured, shows them. Fifteen is
Stripe's recommended Smart Retries default, eight tries within two weeks, plus a
day for a webhook that arrives late. This deployment cannot see what the Stripe
account is set to, so keep that default, or any window of two weeks or less,
under **Billing → Revenue recovery → Retries**, and set *If all retries for a
payment fail* to *Cancel the subscription* or *Mark the subscription as unpaid*.
A window of three weeks or longer outlasts the grace: a subscriber whose card
Stripe is still retrying drops to the free plan in the meantime, and gets the
paid plan back the moment a retry succeeds. `billing-operations.md` §Setting up
Stripe has what each of those two choices shows on the plan tab.

**Testing it.** A test delivery from Stripe's dashboard answering `200` with
`{"received": true}` proves the signature verified and nothing else — that body
is also what an event this deployment has no opinion about returns. To prove a
subscription path end to end, make a real test-mode subscription and watch the
plan tab change, or read `simple_balance_billing_sweeps_total`.

**Going live** is all five Stripe settings replaced together, never one at a
time: the live webhook endpoint has a `whsec_` of its own, and a test-mode price
id does not exist in live mode, which the price check above refuses by name.
What the test mode leaves behind, and what the server does about it when nobody
clears it, is
[`billing-operations.md` §Going live, or changing Stripe account](billing-operations.md#going-live-or-changing-stripe-account).

See [`monetization.md`](monetization.md) for what the two plans are, what the
prices net, and the table of what is on in which combination.

The five Stripe settings are set together or not at all, and they answer only
whether Stripe can be reached. `SB_BILLING_ENABLED` answers the separate
question of whether anything is for sale. That split is what lets a deployment
stop selling while it goes on honoring — and listening to — the subscriptions
people are already paying for. Set none of it and this process never opens a
connection to Stripe.

### Only for ads

| Variable | Default | What it does |
| --- | --- | --- |
| `ADSENSE_CLIENT_ID` | unset | The AdSense publisher id, `ca-pub-` followed by sixteen digits. The dashboard shows it as `pub-…`, and the missing `ca-` prefix is refused at startup because it otherwise fails by rendering nothing, which looks exactly like having no inventory. |
| `ADSENSE_BANNER_SLOT_ID` | unset | The ad unit shown once in the application shell. Ten digits. Set with the client id or not at all. |
| `ADSENSE_FOOTER_SLOT_ID` | unset | A second unit at the bottom of the page. Off unless you set it, and an addition to the banner rather than a replacement, so setting it alone refuses to start. |
| `ADSENSE_CONSENT_MANAGED` | `false` | Whether a certified consent platform is collecting consent. Off by default, and then every ad request forces non-personalized ads, which Google serves without a platform at all. Set it to `true` only if you want personalized ads, and only once you have published a European regulations message in AdSense's own **Privacy and messaging** — free, part of your account, and delivered by the ad tag this app already loads, so nothing is added here. It then stops forcing the flag and lets the platform's answer decide. Visitors in the EEA, the UK and Switzerland need that message whichever you choose; this setting only decides whether its answer can turn personalized ads on. Nothing in this software can check the platform exists. See `monetization.md`. |
| `SB_HOUSE_AD` | `false` | Shows a free account this product's own advertisement for the paid plan instead of anybody else's: a bar pinned to the foot of the window, one sentence and a button that opens the plan tab, never on the plan tab itself, never to a subscriber and never on paper. Only where a plan is for sale (`SB_BILLING_ENABLED=true`, Stripe configured) and the configured prices fit the plans; otherwise nobody sees it, and a production process warns at every start when billing is off. It loads nothing from another site, so it needs no `PRIVACY_POLICY_URL`, serves no `/ads.txt`, needs nothing on the split deployment's frontend, and keeps `default-src 'self'` and the `same-origin` referrer. With the AdSense ids also set, a free account shown it is shown no AdSense unit; the AdSense settings still widen the policy and serve `/ads.txt` until they are unset, and the process warns at every start that they do. See `monetization.md`. |

The first four rows are AdSense, and the cost and the privacy policy below are
theirs; the house ad, the last row, needs neither.

**Know what this costs before turning it on.** AdSense publishes no list of the
hosts it loads from, so serving it means widening this app's content security
policy on every page that renders your balances — including allowing scripts to
be evaluated at runtime. Those pages also send `Referrer-Policy:
strict-origin-when-cross-origin` rather than `same-origin`, because Google's
consent message does not serve under the stricter one: a request from them to
another origin is told this site's address and never the page's path. A
deployment that sets none of these keeps the `default-src 'self'` policy and
the `same-origin` referrer the container ships with. Ads are never shown to a
paid account, and never on the plan and billing tab.

`PRIVACY_POLICY_URL`, above, is required beside these: the server refuses to
start with the AdSense ids set and no policy to link to.

**And ads are shown only where a plan is for sale**, both kinds. An ad goes to
an account on a limited plan, and nobody is on one unless `SB_BILLING_ENABLED`
is `true` with Stripe configured. Set the AdSense ids without it and the policy
is still widened on every page and `/ads.txt` is still served, but nobody is
shown an ad; a production process says so at every start, as a warning rather
than a refusal, and it says the same of the house ad.

### Keeping a secret out of the environment

Nine variables also answer to a `NAME_FILE` form: `AUTH_SECRET`,
`DATABASE_URL`, `DIRECT_DATABASE_URL`, `SMTP_PASSWORD`, `GOOGLE_CLIENT_SECRET`,
`SETUP_TOKEN`, `METRICS_TOKEN`, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. Having the form is the definition of being a
secret here, so nothing else in any table above has one.

`NAME_FILE` names a file whose contents are the value. Set one of `NAME` and
`NAME_FILE` and never both: both set warns and uses `NAME`, naming the file
being ignored, because a precedence rule means somebody eventually changes a
value that has no effect. `NAME` winning is what happened before `NAME_FILE`
did anything at all, so an upgrade cannot change which value a running
deployment is using. An empty `NAME` does not count as set, so the blank `AUTH_SECRET=` that
`.env.example` ships is not in the way.

One trailing newline is stripped and nothing further. `printf` and a Kubernetes
secret volume write none, `echo` and every text editor write one, and a password
may legitimately end in a space, so trimming further would mean a secret typed
into a file and the same secret typed into the environment producing different
values. For `AUTH_SECRET` that difference is a different session-signing key,
which signs everybody out. A file that is empty, or that this process cannot
read, refuses to start.

The value is never placed in the environment of the running process, which is
the point of asking for it this way. Everything that exposes an environment,
`kubectl describe pod` and `kubectl exec` among them, and a Node diagnostic
report along with them, can only show what is in it, and none of them can show
something that was never put there.

```sh
# Docker, adding these to the run command under "Running it". Compose does the
# same thing with a secrets: entry, which lands the file under /run/secrets.
-v /etc/simple-balance/auth_secret:/run/secrets/auth_secret:ro \
-e AUTH_SECRET_FILE=/run/secrets/auth_secret
```

```yaml
# Kubernetes, with the Secret mounted as a volume rather than injected
env:
  - name: AUTH_SECRET_FILE
    value: /etc/simple-balance/auth_secret
volumeMounts:
  - name: secrets
    mountPath: /etc/simple-balance
    readOnly: true
```

```ini
# systemd, where LoadCredential puts the file under $CREDENTIALS_DIRECTORY
LoadCredential=auth_secret:/etc/simple-balance/auth_secret
Environment=AUTH_SECRET_FILE=%d/auth_secret
```

A deployment that uses none of these is unaffected: every variable still works
exactly as it did, and nothing here is required.

Two things worth knowing before you reach for it. An `SMTP_PASSWORD_FILE` that
cannot be read stops the whole server rather than only the mail, which is
consistent with the existing refusal when `SMTP_USERNAME` is set without
`SMTP_PASSWORD`, but is not what "mail degrades rather than breaks" would lead
you to expect while rotating a mail secret.

And the shipped deployment paths do not use the form yet, so on both of them it
takes work you do yourself. The Helm chart in `deploy/helm` writes all nine into
a Secret that reaches both workloads through `envFrom`, and it has no volume or
volume-mount values of its own, so `secret.create=false` is not enough on its
own: an existing Secret is still consumed through `envFrom`. Something outside
the chart has to put the file in the pod, a secrets injector added through
`server.podAnnotations` and `scheduler.podAnnotations` for instance, with
`config.extraEnv` naming the `_FILE` variable; otherwise it is a change to the
chart. On `deploy/compose/compose.distributed.yml`, `DATABASE_URL` is written
in the file and `AUTH_SECRET` is a required interpolation, so both have to be
edited out before their `_FILE` forms will do anything, and leaving
`DATABASE_URL` where it is while adding `DATABASE_URL_FILE` is the both-set
refusal rather than a fallback.

## Reaching the database over a network

A database on another host should be reached over TLS that checks who is
answering, or the password and every row of the ledger go to whoever can stand
at that address. Which `sslmode` to put in `DATABASE_URL` depends on who signed
the server's certificate.

| `sslmode` | Encrypted | Certificate checked | Use it when |
| --- | --- | --- | --- |
| omitted | No | n/a | The database is on the same host, or reached over a private network you trust. |
| `no-verify` | Yes | No | There is no CA certificate to name. It encrypts, and checks nothing about who answers. |
| `verify-full` | Yes | Yes | Any database reached over a network. Name the CA that signed its certificate with `&sslrootcert=/path/to/ca.pem`, or leave that out when the certificate is from a public CA that Node already trusts. |

`verify-full` with `sslrootcert` is the answer for most managed PostgreSQL
services, whose certificates are signed by a CA of the provider's own that it
publishes for download — OCI Database with PostgreSQL and Amazon RDS both do —
and for a server you run yourself, whose CA is yours, or whose self-signed
`server.crt` is its own CA. node-postgres reads `sslrootcert` as a path and
trusts that file and nothing else, so the file has to be readable inside the
container, and the host in the URL has to be a name the certificate carries. Use
the hostname, not an IP address, even one the certificate lists: node-postgres
passes no server name for an address and so checks the certificate against the
name `localhost`.

Do not reach for `require`. In libpq it means "encrypt and do not check the
certificate", and it is the setting most people try first, but node-postgres
reads it as `verify-full`, so against a server whose CA it has not been given it
fails with `DEPTH_ZERO_SELF_SIGNED_CERT` or `SELF_SIGNED_CERT_IN_CHAIN`, and
Node's advice is to install the root CA system-wide, which in a container means
rebuilding the image. The server refuses to start and says what to write
instead: the CA's certificate named with `sslrootcert`, or `no-verify` where
there is no certificate to name.

`no-verify` is a real improvement on no TLS at all: the connection is encrypted,
so nothing on the network can read it. It cannot tell you that the host
answering is the host you meant, so on a network where somebody could stand in
the middle, name the CA and use `verify-full`. On the `single` profile the file
goes in `/var/lib/simple-balance/tls/`, and the `compose.db-tls.yml` overlay
mounts that directory into the application, so add it to `COMPOSE_FILE` (the
cloud programs already do). `deploy/compose/single/README.md`, "The database's
certificate", has the steps for OCI, Amazon RDS and a public CA. The Helm chart
mounts the CA it generates into its API and scheduler pods at
`/etc/simple-balance/db-ca.pem` and writes that path into the `DATABASE_URL` it
derives, so under `database.enabled` there is nothing to arrange; a chart
pointed at a database you bring still needs either a public CA, which needs no
file, or a volume added by a Helm post-renderer.

### A database this deployment runs itself

Both profiles provision one, and in both the certificate is generated rather
than obtained, because there is nobody to obtain it from: the database is
reachable only from inside one VPC, VCN or cluster, and no public CA will issue
for a name that resolves nowhere else.

**In the `single` profile**, `pulumi up` issues a private CA and a server
certificate with `@pulumi/tls` at plan time, before either machine exists. The
CA's private key stays in Pulumi state and reaches neither machine. The server
certificate and its key go to the database node in its own cloud-init; the CA
certificate, which is public, goes to the application node in its own. The
generated `DATABASE_URL` is

```text
postgresql://simple_balance:<password>@<the node's internal DNS name>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem
```

and the certificate's SAN is that same internal name —
`db.db.simplebalance.oraclevcn.com` on Oracle Cloud,
`ip-10-20-1-10.<region>.compute.internal` on AWS, and
`ip-10-20-1-10.ec2.internal` in `us-east-1`, which spells it differently and is
a real trap. The node's private address is pinned so the name is known before
the machine is built. It is also in the certificate as an IP SAN, for an
operator running `psql "host=… sslmode=verify-full"` by hand — but the URL uses
the name, for the reason in the previous section: node-postgres sends no server
name for an address, so `verify-full` against an IP literal checks the
certificate against `localhost` and fails however many IP SANs it carries.

**The server is what enforces it, not the client.** `pg_hba.conf` is mounted
into the container and named with `-c hba_file=`, rather than left to the one
the image generates, and every line in it that crosses a machine boundary is
`hostssl`. A client that dropped `sslmode` is refused —
`no pg_hba.conf entry for host "…", user "simple_balance", … no encryption` —
rather than served in the clear. The superuser is refused over the network
entirely, even under TLS; it exists to run `initdb` and to be reached over the
container's own socket. The application signs in as `simple_balance`, which is
not a superuser and owns only its own database.

**In the `ha` profile**, the chart generates the same pair and keeps them in the
release's database Secret, mounts the CA into the API and scheduler pods, sets
`ssl = on`, and writes `hostssl` on every non-loopback `pg_hba` line. The
coordinator reaches its workers and the standbys stream with `verify-ca` rather
than `verify-full`, deliberately: Patroni registers members by pod address,
which no certificate can promise, so a name check would fail a healthy cluster.

**Rotation is by hand in both**, and `docs/deployment-profiles.md` §Encryption
says why — in the `single` profile a re-issued certificate would sit in Pulumi
state and never reach a running machine, because the instances ignore changes to
their user data. `deploy/pulumi/README.md` §Rotating the database's certificate
is the procedure.

**And nothing that was accepted is refused.** A `DATABASE_URL` with
`sslmode=disable`, or with none at all, still works exactly as it did;
`simple-balance-env` warns about it in the journal on every start and carries
on.

**What the backups make of it.** `pg_dump`, `psql` and `pg_restore` are libpq,
and read `sslmode` libpq's way rather than node-postgres's: `no-verify` is not a
word libpq knows, so it refuses the whole string, and its `require` is exactly
what node-postgres calls `no-verify`. So the `single` profile's nightly backup
and its restore (`deploy/systemd/simple-balance-backup` and
`simple-balance-restore`) rewrite the string before they use it:
`sslmode=no-verify` becomes `sslmode=require`, the same guarantee in libpq's
spelling, and a `uselibpqcompat` parameter, which libpq refuses as unknown, is
dropped. Everything else passes through. An omitted `sslmode` stays omitted:
node-postgres then connects without TLS, and libpq tries TLS first without
checking the certificate (`prefer`), so the dump is never less protected than
the application.

`verify-full` survives the trip, and so does `verify-ca` with a `sslrootcert`.
The client runs from the `postgres:18` image, which carries no certificate
authorities, so the scripts mount the file `sslrootcert` names into it at the
same path and point `PGSSLROOTCERT` at it. `verify-full` with no `sslrootcert`
gets this machine's CA bundle instead: the first of
`/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`,
`/etc/ssl/ca-bundle.pem` and `/etc/ssl/cert.pem` that exists, or the file
`SB_PG_CA_BUNDLE` names in `/etc/default/simple-balance`. `verify-ca` with no
`sslrootcert` is refused before any client runs, because libpq would then take
a certificate any public CA issued, for any host, as the database's — the
reason libpq itself refuses `verify-ca` with `sslrootcert=system`. A named file
that is missing, a relative path, `system`, or a path holding a `%`, a `+` or a
comma is refused the same way, the last because node-postgres decodes a `+` to a
space where libpq does not, and the two would read different files. Under any
other mode nothing is mounted, even when the URL names a file, and libpq stays
unverified as it always was. `verify-full` is the one spelling both read the
same way: under `verify-ca` libpq checks the chain and not the name, and under
`require` with a file the application checks the certificate and the backup
does not. A `pg_dump` of your own against the same `DATABASE_URL` needs the same
rewrite, and the file `sslrootcert` names readable where it runs.

## Who may register

`ALLOWED_EMAILS` decides who can create an account. It is a comma-separated
list, matched case-insensitively, and each entry is one of:

| Entry | Admits |
| --- | --- |
| `you@example.com` | That address, and only it. A plus tag is a different address. |
| `example.com` | Anybody at that domain. |
| `@example.com` | The same thing, written the way people often expect. |
| `*` | Anybody at all. |

A domain matches only itself. Allowing `example.com` does not allow
`someone@mail.example.com`, because a subdomain is a different domain and may be
under somebody else's control.

Leaving `ALLOWED_EMAILS` unset admits nobody. That is what makes an
unconfigured deployment a private one: the person who claims it with the setup
code gets an account, and nobody else can register. Set the variable when you
want to let other people in.

Every account is separate. Two people on one deployment cannot see each other's
accounts, transactions, categories, payees, or totals, and neither can name the
other's records by id.

### What the list does and does not do

The list decides who may *open* an account. It has no say after that. Somebody
you remove keeps the account they already have, along with everything in it,
because the alternative would mean an unset list locked every existing user out
of their own books. To remove somebody, delete their account, which takes their
data with it.

A domain entry is only as strong as the proof behind the address. In `google`
mode it is strong: Google has confirmed the address before it reaches us, and an
unconfirmed claim is refused. In local password mode it depends on whether this
deployment can send mail. With SMTP configured, a new account has to open a link
sent to the address before it can be signed in to, so `pinecone.io` means
somebody who can read mail at that domain. Without SMTP nothing is confirmed,
and the entry is a statement about who you expect to find the deployment rather
than proof of anything.

## Sign-in modes

`local` is the default and needs no Google configuration at all.

`google` allows Google accounts that `ALLOWED_EMAILS` admits.

`both` offers either. To use both for one account, create the local account
first, sign in with it, then use **Connect Google** in Settings. That link is
explicit on purpose: two accounts sharing an email address are not assumed to be
the same person.

For either Google mode, register this exact redirect URI on the Google OAuth web
application:

```text
https://simple-balance.example.com/api/auth/callback/google
```

Simple Balance asks Google for `openid`, `email`, and `profile`, and nothing
else. Keep the client secret out of the image.

## Passwords and the first account

The logs print a one-time setup code the first time a deployment starts with no
accounts in it. Whoever holds that code can create an account the registration
rule would otherwise turn away, which is what makes an unconfigured deployment
usable at all. It stops working the moment an account exists. Set `SETUP_TOKEN`
yourself if you would rather choose the code than read it from a log. When
`ALLOWED_EMAILS` already admits the first person, no code is asked for, because
it would guard a door anyone could walk around.

Guessing the code is bounded: five attempts per client address every fifteen
minutes, counted in PostgreSQL so the bound holds across a restart and across
every replica. A tally in the process refuses a caller already over the
allowance without asking the database, which is what keeps a flood from becoming
a write storm. A correct code clears the count.

Passwords can be changed from Settings by whoever is signed in, and changing one
signs every other session out and disconnects every MCP client, so an agent
authorized before the change has to be authorized again. Adding a password to an
account that has only ever signed in with Google needs a session created in the
last fifteen minutes: there is no existing password to confirm against, so a
recent sign-in is the re-authentication available to every account. What happens
when a password is *lost* depends on whether this deployment can send mail; see
below.

Sign-up and sign-in are rate limited to a few attempts per client address every
ten seconds. The count lives in PostgreSQL, shared by every replica and kept
across a restart, so the allowance is one allowance however many processes serve
the deployment. Which address they are counted against depends on `TRUST_PROXY`;
see the reverse proxy section.

## Sending mail

Set `SMTP_HOST` and `MAIL_FROM` and two things switch on together: people can
reset a forgotten password, and a new account has to confirm its address before
it works. Leave them unset and neither happens, which is the right answer for a
deployment of one where the password lives in a password manager.

Scheduled notifications need the same two, and behave differently from the two
above: a recurrence set to email when it proposes, or a template with a reminder,
keeps that setting whether or not mail is configured, and starts sending once it
is. Nothing queues in the meantime — a reminder whose moment passed while there
was nowhere to send it is not sent later. They also need the scheduler, so a
deployment with `RECURRENCE_SCHEDULER=false` on every replica sends none of them.

| Variable | Default | What it is |
| --- | --- | --- |
| `SMTP_HOST` | unset | The submission server. Setting it turns mail on. |
| `MAIL_FROM` | unset | The address messages come from. `balance@example.com`, or `Simple Balance <balance@example.com>`. Required alongside `SMTP_HOST`. |
| `MAIL_REPLY_TO` | unset | Where a reply should go, if not to `MAIL_FROM`. Same two forms. |
| `SMTP_PORT` | `587`, or `465` when `SMTP_SSL` is true | The submission port, a whole number from 1 to 65535. Anything else refuses to start and names this variable. Set it only for a relay on a port of its own, such as 2525. |
| `SMTP_SSL` | `false` | True for a connection encrypted from the first byte, which is what 465 expects. False starts on 587 and upgrades with STARTTLS, which is what nearly every provider wants. |
| `SMTP_USERNAME` | unset | Set with `SMTP_PASSWORD` or not at all. |
| `SMTP_PASSWORD` | unset | Never sent unencrypted; see below. |

A password is never sent in the clear. With `SMTP_SSL` false and credentials
set, the STARTTLS upgrade is required rather than merely attempted, so a relay
that does not support it gets an error instead of your password. A connection
with no username and password has nothing to leak on the way, so it is allowed
to proceed unencrypted against a relay on a network you control, and still
upgrades whenever the relay offers to.

Use a **submission** service, not the MX host your domain publishes. An MX
record says where mail *to* your domain is delivered. It does not accept
authenticated submission, does not relay to other domains, and listens on a port
most hosts block outbound, so `aspmx.l.google.com` or `gmr-smtp-in.l.google.com`
will not work here however correct they look in your DNS.

For a domain on Google Workspace, either:

```sh
# One mailbox. Needs 2-Step Verification on that account and then an app
# password, which is not the account password.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=balance@example.com
SMTP_PASSWORD=the-app-password
MAIL_FROM=Simple Balance <balance@example.com>
```

```sh
# The Workspace relay, which can send as any address in the domain. Turn it on
# first under Apps > Google Workspace > Gmail > Routing > SMTP relay service,
# and authenticate by IP allowlist, by SMTP credentials, or both.
SMTP_HOST=smtp-relay.gmail.com
SMTP_PORT=587
```

Google rewrites `From` to the mailbox that authenticated unless the address is a
verified alias on it, or the relay is set to allow any sender in the domain. If
that leaves messages coming from somewhere nobody reads, set `MAIL_REPLY_TO` to
an address somebody does.

Every link in these messages is built from `APP_BASE_URL`. If it is wrong the
links point somewhere the recipient cannot use, and there is nothing they can do
about it from their end.

The connection is opened once at startup so a wrong setting is reported in the
log rather than discovered by somebody locked out. A refusal is logged and the
server keeps running, because the ledger works whether or not mail does. Reset and
verification links last an hour. A reset link is consumed the moment it is
used, so it works once. A verification link is a signed token rather than a
stored one, so it keeps working for the rest of its hour; opening it only
confirms the address, and signing in still takes the password.

### Getting mail delivered

Simple Balance hands every message to the relay `SMTP_HOST` names and does
nothing else about it. Whether a mailbox provider accepts what that relay sends
is decided outside this application, by four things that live in DNS and on the
relay itself.

| What | What it is | Who sets it |
| --- | --- | --- |
| SPF | A DNS record listing the hosts allowed to send as your domain | You, in DNS |
| DKIM | A signature the relay adds to each message, checked against a public key published in your DNS | The relay, plus the one record it gives you |
| DMARC | A DNS record saying what a receiver should do with mail that fails the first two, and where to send reports | You, in DNS |
| PTR | Reverse DNS for the address the relay connects from, resolving back to the name it announces | Whoever owns that IP address |

A hosted relay (Google Workspace, Fastmail, Postmark, SES, Mailgun) already
handles DKIM and PTR and hands you the records to publish, so its setup page is
the one to follow rather than this one. Relaying through a host you own makes
all four yours, and PTR is the one that trips people up: it belongs to
whoever owns the address, which on most cloud providers is a support request
rather than a control panel.

Google asks the same of every sender, however little it sends: SPF or DKIM on
the sending domain, forward and reverse DNS that agree, TLS on the connection, a
spam rate under 0.3% in Postmaster Tools, and correctly formatted messages.
Senders of roughly 5,000 messages or more a day to personal Gmail addresses
additionally need SPF and DKIM both, DMARC, alignment between them, and
one-click unsubscribe. A ledger sending password resets and a handful of
reminders is not in that group, so the first list is the one to satisfy.

When reminders land in spam, check in this order. SPF first, because it is one
record and the one most often missing. Then DKIM, which the relay signs but your
DNS has to carry the key for. Then the PTR record on the address the relay sends
from.

### With no mail server

Nobody can reset a forgotten password, and recovering one means editing the
database. Accounts are usable the moment they are created because nothing is
waiting to be confirmed. On a deployment with more than one person, say that
before they sign up rather than after.

Accounts created while no mail server was configured keep working if one is
added later. They were admitted under the rules that applied at the time.

## Running it

```sh
docker run -d --name simple-balance --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --stop-timeout 30 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

The container runs as a non-root user and the filesystem can stay read-only. It
also drops every Linux capability and cannot gain a privilege it did not start
with: the process binds port 3000 as a non-root user and no setuid binary is
involved, so it needs neither. Bind to loopback and put a reverse proxy in front
rather than publishing the port.

## Reverse proxy

Terminate TLS at the proxy and forward the original scheme and host.

```caddyfile
simple-balance.example.com {
  # Metrics are for a scraper on the machine, never for the site's address.
  @metrics path /metrics /metrics/*
  respond @metrics 404
  reverse_proxy 127.0.0.1:3000
}
```

```nginx
# Metrics are for a scraper on the machine, never for the site's address.
location = /metrics {
    return 404;
}

location / {
    # nginx defaults to 1 MiB, which refuses CSV imports this document
    # advertises at up to 10 MB. See SB_MAX_UPLOAD_SIZE below for the sizing.
    client_max_body_size 61m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # $remote_addr, not $proxy_add_x_forwarded_for. The latter appends to
    # whatever the client sent, which both lets a client put an address of its
    # choosing at the front of the list and produces a chain nothing downstream
    # can resolve to one caller.
    proxy_set_header X-Forwarded-For $remote_addr;
    # A commit or an import of several thousand rows is one request that can
    # take a minute, and it reports its progress as it goes. Both defaults are
    # wrong for that: proxy_read_timeout is 60s, which cuts the request off, and
    # proxy_buffering holds the progress back until the response is complete, so
    # the progress bar in the browser would fill in one jump at the end.
    proxy_read_timeout 600s;
    proxy_buffering off;
}
```

Caddy needs neither line: it streams by default and does not time a slow
response out. The frontend image's own nginx already sets both
(`deploy/docker/nginx.conf.template`).

The `/metrics` refusal matters only with `METRICS_ENABLED` on, and then it is
the difference between numbers for a scraper and numbers for anybody. Both
proxies match it after decoding the path and folding repeated slashes, so
`/%6detrics` and `//metrics` are refused with it, and the application answers
nothing at a path that only resolves to `/metrics` whatever is in front of it.
A 404 rather than a 403, because "forbidden" says there is something to find.

Then set `TRUST_PROXY=true`. Sign-in attempts are counted per client address,
and with this off that address is the far end of the connection, which behind a
proxy is the proxy itself for every visitor. Everybody would share one
allowance, and one stranger could spend it for the rest. The server warns at
startup when it is counting against the connection address, and says nothing
when it is not, so silence there means the setting took.

Only leave `TRUST_PROXY` off when the application is reached directly, or when
the proxy in front passes through `X-Forwarded-For` rather than replacing it.
With it off, an address a caller made up is ignored in favor of the connection
they actually opened; with it on and a proxy that appends, a caller can put
whatever they like at the front of the chain.

## Starting from nothing

Point Simple Balance at a PostgreSQL server and it takes care of the rest. If
the database named in `DATABASE_URL` does not exist, it is created; if it exists
but is empty, the schema is built; if it is already up to date, nothing happens.
That is true however you run it, whether that is the container, `npm start`, or
`npm run dev`, because all of them go through the same startup step.

```sh
docker run -d --name simple-balance \
  -e DATABASE_URL='postgresql://postgres:secret@db.example:5432/simple_balance' \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e APP_BASE_URL='https://simple-balance.example.com' \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/thtmnisamnstr/simple-balance:latest
```

Creating the database needs the connecting role to have `CREATEDB`, which the
default `postgres` superuser has. Without it you get a message naming the
database and the statement to run, rather than a driver error. Nothing else
about the server is assumed or altered.

Where a deployment profile provisions the database, the role it hands you is
not a superuser and does not have `CREATEDB` — it owns the one database it was
made for, which is what the schema needs and no more. The database is created
before the application ever connects, so there is nothing for `CREATEDB` to do.
`docs/deployment-profiles.md` has both shapes.

## Splitting it into separate containers

One container is the supported way to run this, and the rest of this document
assumes it. `deploy/compose/single/` is that container as a deployment — with
TLS, backups and a systemd unit, against a PostgreSQL 18 on a second machine
that the same `pulumi up` builds — and is what
[`deployment-profiles.md`](deployment-profiles.md) calls the `single` profile.

If you are running under Kubernetes and want to scale the web tier,
`deploy/docker/` holds three Dockerfiles that split it up, and three things
built on them: a Helm chart in `deploy/helm/simple-balance/`, a compose file in
`deploy/compose/` that runs the same split on one machine, and Pulumi programs
in `deploy/pulumi/` for EKS and GKE. Each has a README of its own; what follows
is the contract they all have to satisfy. Build them from the
repository root:

```sh
docker build -f deploy/docker/server.Dockerfile -t simple-balance-server .
docker build -f deploy/docker/frontend.Dockerfile -t simple-balance-frontend .
docker build -f deploy/docker/scheduler.Dockerfile -t simple-balance-scheduler .
```

Building the frontend image needs BuildKit, which is Docker's builder by default
since 23.0 and what `docker buildx` and Compose use: the Dockerfile sets the
mode of the script that checks the trusted-proxy settings with `COPY --chmod`,
because nginx's entrypoint skips one that is not executable with nothing but a
log line. The legacy builder refuses it with
`the --chmod option requires BuildKit`.

The server image is the API and the MCP endpoint with no browser bundle in it.
A request for a page gets a 404 rather than an application shell it is not the
authority on. It reads the same settings as the single container.

The frontend image is nginx serving the bundle and proxying `/api`, `/mcp`,
`/health` and `/.well-known` through to the server. It listens on **8080**, not
80, because the base image runs as a non-root user that cannot bind a privileged
port. Its settings all have working defaults:

| Variable | Default | What it does |
| --- | --- | --- |
| `SB_API_ORIGIN` | `http://simple-balance-server:3000` | Where to proxy everything the API owns. Point it at your API Service. |
| `SB_FRONTEND_PORT` | `8080` | The port nginx listens on. Change it and the readiness probe and Service have to follow. |
| `SB_MAX_UPLOAD_SIZE` | `61m` | The largest request body nginx will pass. A CSV arrives as a JSON string rather than as a file upload, and the API sizes its own limit for those routes at `CSV_MAX_BYTES` x 6 plus 64 KiB to cover worst-case JSON escaping. Keep this above that number, or a CSV the API would accept is refused before it reaches it. At the default `CSV_MAX_BYTES` of 10 MB that means at least `61m`. |
| `SB_BILLING_CONFIGURED` | `false` | Whether Stripe is configured. nginx serves the plan and billing tab's document in this shape, so it decides which content security policy that page arrives with, and Stripe's payment form needs the wider one. Configured, not selling: an operator who has stopped selling still has subscribers who must be able to replace an expired card. The compose recipe derives it from `STRIPE_PUBLISHABLE_KEY`, and the Helm chart from a `STRIPE_PUBLISHABLE_KEY` in `config.extraEnv` or from `frontend.billingConfigured`, which is for a key kept in an `existingSecret`, so the two cannot disagree. |
| `SB_CSP_REPORT_ONLY` | `false` | Whether that page reports its policy instead of enforcing it. Only meaningful with `SB_BILLING_CONFIGURED`, and only for that page. Set it on the server as well, which is what registers `POST /api/csp-report` for the reports to land on. |
| `SB_ADS_CONFIGURED` | `false` | Whether this deployment serves AdSense. nginx serves every document in this shape, so it decides the policy they arrive with, and AdSense needs a much wider one — scripts, frames and connections to any HTTPS origin, plus `unsafe-eval`. Set it with the server's own `ADSENSE_*` settings or neither; the compose recipe derives it from `ADSENSE_CLIENT_ID`, and the Helm chart from an `ADSENSE_CLIENT_ID` in `config.extraEnv` or from `frontend.adsConfigured`, which is for an id kept in an `existingSecret`. The house ad, `SB_HOUSE_AD`, is the server's alone and leaves this off: it loads nothing, so there is nothing to widen. |
| `SB_TRUSTED_PROXY_CIDR` | `127.0.0.1` | Which addresses this nginx will believe about where a request came from. Everything it proxies carries `X-Forwarded-For` set to the address it saw, and behind anything terminating TLS that address is the terminator — the same value for every visitor. With `TRUST_PROXY` on, the API then counts every sign-in attempt against one allowance, and one stranger can spend it for everybody. Set it to the address or range the terminator connects from — an ingress controller's pod CIDR under Kubernetes, the load balancer's subnet on a VM — or to several, separated by commas or spaces, when more than one proxy connects. Name the proxies' ranges and nothing wider: this decides whose word is taken for an address, so a range that includes callers lets a caller choose their own. Every entry has to be an IPv4 or IPv6 address, a CIDR, or `unix:`, and anything else — a host name, a short form such as `10.0.0`, an empty value — stops the container before nginx starts, with a line naming the entry, because nginx would otherwise resolve a name at startup and trust whatever it answered, and read `10.0.0` as `10.0.0.0`, without a word. The default is the off position rather than a trusted range: nothing reaches the container from loopback, so a deployment that sets nothing behaves exactly as it did before this setting existed, and a single address or CIDR renders exactly the configuration it did before a list was accepted. |
| `SB_REAL_IP_RECURSIVE` | `off` | Whether nginx walks `X-Forwarded-For` from the right past every address above and takes the first one that is not among them, rather than taking the last entry outright. Leave it off behind a terminator that *replaces* the header, which is what nginx with `$remote_addr`, Caddy, and ingress-nginx unless `use-forwarded-headers` and `compute-full-forwarded-for` are both on all do: the last entry is then the visitor. Turn it on only behind a chain whose every hop *appends* and is in the list — Google's load balancer appends `<client-ip>,<load-balancer-ip>` — so nginx walks past the trusted hops to the address the outermost of them wrote and never reads anything a caller wrote before it. Takes `on` or `off`, and `true` or `false` meaning the same, in any case; empty is off, and any other value stops the container. A `/0` entry above with this on stops it too, since the walk would then end at whatever a caller put first. |

These belong to the nginx container, which is why most of them are in neither
`.env.example` nor `deploy/compose/.env.example`, and that is the reason rather
than an omission. The root file serves the single container, which has no nginx
in it. The compose recipe sets all of them on the frontend service itself, where
the value can carry the reason it is what it is, and derives
`SB_BILLING_CONFIGURED` and `SB_ADS_CONFIGURED` from the server's own Stripe and
AdSense settings so the two sides cannot disagree. The ones an operator
chooses are in the compose example anyway, commented out: `SB_CSP_REPORT_ONLY`,
which the server reads too and so is in the root file as well, and
`SB_TRUSTED_PROXY_CIDR` and `SB_REAL_IP_RECURSIVE`, which depend on what is in
front. Under the Helm chart they are `frontend.trustedProxyCidr` and
`frontend.realIpRecursive`, which both `ha` shapes leave at the chart's
defaults unless the cluster's ingress needs otherwise. The defaults above are
baked into
`deploy/docker/frontend.Dockerfile`, so a deployment changing none of them has
nothing to set. Every `SB_` name the template reads has a default there, and
`tests/dockerfile.test.ts` holds it to that: an absent one is not a fallback but
a literal `${SB_…}` in the rendered config, which nginx refuses to start on.
Everything the Node processes read is in a table here and in an example file,
and `tests/env-example.test.ts` holds the two to each other.

nginx repeats every response header the API sets — the content security policy,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, HSTS, the two
`Cross-Origin-*` policies, `Origin-Agent-Cluster`, the legacy four and
`X-Robots-Tag: noindex` — on the files it serves itself. The application shell
never reaches the API process, so without this the document that runs the app
would ship with no policy. `tests/security-header-parity.test.ts` runs a real
response through the middleware and fails if the two lists differ by a header
or by a value, because they are one policy written in two languages. It
replaces `X-Forwarded-For` with `$remote_addr` rather than appending to it,
which is what `TRUST_PROXY=true` on the server is safe to believe.

The scheduler image runs the whole schedule — proposing recurring transactions
and sending the reminders and proposal notices — and serves nothing but its own
health checks, so a Service pointed at it by mistake cannot answer an API
request. It needs the `SMTP_*` and `MAIL_FROM` settings as well: without them it
proposes rows and sends nothing, which is a supported deployment rather than an
error, so it says so in one line at startup instead. Given them, it opens a
connection to the relay at startup and logs the address it will be sending as,
or logs the refusal and goes on proposing. Those two lines are the difference
between a scheduler that is working and one that was never handed the settings,
which otherwise look identical; with metrics on,
`simple_balance_dependency_up{dependency="smtp"}` says the same as a number,
and is absent where no relay was given. The chart and the compose file both hand it the
same configuration the API gets, so neither needs anything extra; a deployment
assembled by hand does. It runs one entrypoint of its own and always ticks: the
`RECURRENCE_SCHEDULER` flag decides whether the API replicas tick too, and a pod
whose only job is this one would be pointless with it off.

These have to line up:

- **`APP_BASE_URL` on the server names the frontend's public origin**, not the
  server's own address. Cookies are set by the API and read by the browser, so
  both have to be reached on one origin, and that origin is nginx.
- **`TRUST_PROXY=true` on the server**, because nginx is now the address every
  connection comes from. Without it every visitor shares one sign-in allowance.
- **`RECURRENCE_SCHEDULER=false` on the server Deployment.** The scheduler
  entrypoint ignores the flag and always ticks, so the only thing left to decide
  is whether the API replicas tick too. Leaving them on is safe rather than
  wrong: a recurrence is claimed with `for update skip locked`, so whoever gets
  to a row first works it and everybody else moves on. It is still a sweep of
  the due list on every replica, for work the schedulers are already doing.
- **As many scheduler replicas as you like.** They divide the due rows between
  them rather than one holding a lock the others wait on, so more of them is
  more throughput on a large backlog and costs nothing on a small one.
- **`SB_BILLING_CONFIGURED` on the frontend**, if Stripe is configured at all —
  not `SB_BILLING_ENABLED`, and not only when you are selling. nginx serves the
  application shell itself in this shape, so it, and not the API, decides the
  content security policy the plan tab arrives with, and Stripe's payment form
  needs the wider one. An operator who has stopped selling still has subscribers
  who must be able to replace an expired card on that page, which is why the
  frontend asks "is Stripe configured" rather than "is a plan for sale". Set on
  the server and not on the frontend, the tab loads and the card fields never
  appear. The compose recipe derives it from `STRIPE_PUBLISHABLE_KEY`, and so
  does the Helm chart from one in `config.extraEnv`; `frontend.billingConfigured`
  turns it on for a key kept in an `existingSecret`, which the render never sees.
- **`SB_TRUSTED_PROXY_CIDR` on the frontend**, set to the range whatever
  terminates TLS in front of it connects from. The template replaces
  `X-Forwarded-For` with `$remote_addr`, which is right when nginx is the first
  hop and wrong when an ingress sits in front of it: `$remote_addr` is then the
  ingress, and with `TRUST_PROXY=true` every visitor shares one sign-in
  allowance. This container listens on plain HTTP and production requires an
  HTTPS `APP_BASE_URL`, so something always sits in front, and this is the
  ordinary case rather than the exotic one. Setting it takes no template edit
  and no image rebuild. Under Helm it is `frontend.trustedProxyCidr`, a string
  or a YAML list, and under Kubernetes the range is the ingress controller's
  pods.
- **`SB_REAL_IP_RECURSIVE` left off, unless every hop appends.** Off, nginx
  takes the last entry of `X-Forwarded-For`, which behind a terminator that
  replaces the header is the visitor and cannot be talked past. On, it walks
  back past every trusted address, which is what a chain of appending proxies
  needs and what lets a range set too wide walk past the visitor to an address
  the caller wrote. Under Helm it is `frontend.realIpRecursive`.
  `deploy/docker/nginx.conf.template` has the reasoning, and
  `docs/deployment-profiles.md` the measurement.

  The `ha` Pulumi programs set both for the network they build, and on each
  cloud that takes more than these two values. On AWS the program turns proxy
  protocol on between the network load balancer and ingress-nginx, which would
  otherwise see the load balancer rather than the visitor, and ingress-nginx
  believes that header only from the load balancer's subnets; the frontend then
  trusts the VPC's range, where ingress-nginx's pods take their addresses, with
  recursion off. On GCP it trusts Google's two front-end ranges and the
  Ingress's reserved address with recursion on, because Google's load balancer
  appends its own address after the visitor's. `simple-balance:trustedProxyCidr`
  and `simple-balance:realIpRecursive` replace either choice.
  `deploy/pulumi/README.md` has the detail, and only a frontend image of 0.2.0
  or later reads either setting.
- **`SB_ADS_CONFIGURED` on the frontend**, if you serve AdSense, for the
  same reason: nginx decides the policy every other page arrives with, and
  AdSense needs a much wider one. The Helm chart derives it from an
  `ADSENSE_CLIENT_ID` in `config.extraEnv`, and `frontend.adsConfigured` turns it
  on for an id kept in an `existingSecret`.
- **Clocks in step across the API replicas.** A subscription snapshot is ordered
  by the wall clock of whichever replica read it from Stripe, so two replicas
  more than a moment apart can keep the older read and leave somebody's plan
  wrong until the twelve-hour reconciliation sweep repairs it. Keep the nodes on
  NTP, which they almost certainly already are.

Each of these processes opens `DATABASE_POOL_SIZE` connections and no more once
it is running. Two others exist and neither is held: migrations take one at
startup and close it, and the first-account claim takes one once in a
deployment's life.

So the arithmetic that decides how far the API tier can scale is
`replicas x DATABASE_POOL_SIZE`, plus one per replica while they are starting,
against your server's `max_connections`, which is 100 by default. At the default
pool of 10 that is nine replicas, not ninety. Lower `DATABASE_POOL_SIZE` before
raising the replica count, or put a connection pooler in front of PostgreSQL.

### Behind a transaction pooler

PgBouncer in transaction mode hands each statement whichever server connection
is free, which suits the application pool exactly: every lock the ledger takes
is transaction-scoped and is released by the commit that ends it.

Two things are not. Migrations hold a session-level advisory lock across the
whole run so two replicas starting together cannot migrate at once, and the
first-account claim holds one for the length of the claim. Through a transaction
pooler those are taken on one connection and released on another, which is to
say not held at all. Set `DIRECT_DATABASE_URL` to a string that reaches
PostgreSQL past the pooler and both go direct; leave it unset and everything
uses `DATABASE_URL`, which is right when there is no pooler.

All three are published alongside the single container, on the same release and
under the same tags: `ghcr.io/thtmnisamnstr/simple-balance-server`,
`ghcr.io/thtmnisamnstr/simple-balance-frontend` and
`ghcr.io/thtmnisamnstr/simple-balance-scheduler`, each carrying the version and,
on a release that is not a prerelease, `latest`. They are built for amd64 and
arm64, like the single container. Every pull request builds all four for the
runner's own architecture, so a Dockerfile that stops building fails there
rather than at the release that needed it.

## Health and shutdown

`/health/live` says the process is up. `/health/ready` opens a database
connection and runs one statement on it, so it says the database is reachable
and nothing more. What it also gives you is ordering rather than a check:
migrations run under an advisory lock before the server starts listening, so
nothing answers at all until they have finished, and a failed migration is a
process that never came up rather than one answering `503`.

Point your orchestrator at readiness.

Both processes count every check they answer, as
`simple_balance_readiness_checks_total` and `simple_balance_ready`, and run one
as they start listening; a scrape never asks the database anything to report
them.

A process with the scheduler switched off is not an unhealthy one, so readiness
says nothing about it. What tells you the scheduler has stopped is the Recurring
page: a recurrence past its due date with nothing proposed means whatever runs
the schedule is not running. Reminders give no such signal — an email that never
arrived looks like an email nobody sent — so the Recurring page is the one place
in the product to look for both. With metrics on, the scheduler says it too:
[what to alert on](#the-scheduler) has the two rules, one for nothing running it
and one for a sweep that has stopped finishing.

On `SIGTERM` the process stops accepting connections, closes the HTTP server,
and drains the database pool before exiting.

## Metrics

Off by default. `METRICS_ENABLED=true` makes the process answer `GET /metrics`
in the Prometheus text format, on the same port everything else is served on.
With it off there is no such route, so `/metrics` reaches the single-page app
like any other path the browser owns and a scraper pointed at it gets HTML and
a parse error — which is what a scrape against a deployment that never turned
this on looks like.
Both entrypoints have one, and in a split deployment you want both: the API
reports requests, MCP tool calls, ledger writes and its connection pool, and the
scheduler reports ticks, proposals, reminders and mail. Scraping only the API
watches the process that does none of the scheduled work.

It answers that exact path and nothing that only resolves to it. A request for
`/api/..\metrics` is a 404, as though there were no such route, and that is a
fix rather than a nicety: the frontend nginx reads a backslash as an ordinary
character and proxied that request as an `/api` path, so in 0.2.1 a deployment
behind it with metrics on and no token served its numbers to anybody who typed
the address.

Nothing in a metric names a person. No label carries a user, an email, an
account or an amount, and a path with an id in it is counted under the route
pattern rather than the path, so `/api/v1/accounts/{id}` is one series and not
one per account. What a scrape does say is how much this deployment is doing:
requests by route and status, writes by kind, queue depths, how long a
transaction holds a connection. That is not somebody's ledger and it is not for
the open internet either.

So `METRICS_TOKEN` is there when the port is reachable by anything you do not
control. Set it, and the endpoint answers only a request carrying
`Authorization: Bearer <token>`; leave it unset behind a private network and
`kubernetes-pods` style discovery scrapes it with no configuration at all. Set
it in production without one and the startup log says so once. Neither proxy
this project ships passes `/metrics` on: the frontend nginx has no such
location, and the `single` profile's Caddyfile answers it 404 before it proxies
anything — which it did not do in 0.2.1, so there too metrics on and no token
published them. A proxy of your own wants the same refusal, and
[the reverse proxy section](#reverse-proxy) has it for both.

There are two ways to read it. Point a Prometheus you already run at it, with
the job below; or turn on [the collector](#the-collector) every profile here can
run, which scrapes it and sends the result to New Relic or to anything else that
takes OTLP or Prometheus remote write. A Prometheus job for the two containers,
with a token:

```yaml
scrape_configs:
  - job_name: simple-balance
    authorization:
      credentials_file: /etc/prometheus/simple-balance-token
    static_configs:
      - targets: ["simple-balance-server:3000", "simple-balance-scheduler:3000"]
```

Every name starts `simple_balance_`, the runtime's included: heap, event-loop
lag and garbage collection arrive as `simple_balance_process_*` and
`simple_balance_nodejs_*`, because `prom-client`'s default set is collected
under the same prefix rather than beside it. `simple_balance_build_info` carries
the version as a label, so a scrape says which build produced it. Every series
carries `component="api"` or `component="scheduler"`, so a split deployment can
tell the two apart and a single container reports both under `api` — [which
process a series comes from](#which-process-a-series-comes-from) says what that
does to an alert.

### The collector

One OpenTelemetry Collector per deployment, off unless asked for. It scrapes the
application's `/metrics` with its token, the machine it runs on through
node-exporter, and itself, and sends all of it to one backend over OTLP or
Prometheus remote write. Which backend is settings and nothing else, so moving
from New Relic to Grafana Cloud is two values and a restart.

It is the core distribution, `otel/opentelemetry-collector:0.162.0`, pinned by
tag and digest, and it was chosen over Prometheus in agent mode because it
measured lighter: scraping the same series, 51.7 MiB resident against 72.3, and
0.75% of a core against 1.46% ([what it costs](#what-it-costs)). It keeps
nothing: no volume, no write-ahead log, a queue in memory and no more, a
read-only root filesystem and no capabilities. A restart loses at most the batch
it was holding. node-exporter is the other half, one per machine in the Compose
shapes, mounting the host's root read-only and serving nothing past the machine.

**The application does not use OpenTelemetry, and that is a decision rather than
a gap.** It instruments itself with `prom-client` and serves the Prometheus text
format; the collector is what speaks OTLP, from outside the process. Do not
replace one with the other on the way to a backend that wants OTLP — this
already sends it — and
[architecture](architecture.md#metrics-and-why-the-process-does-not-speak-otlp)
has the reason the SDK stays out.

#### Turning it on

**The `single` profile, installed by hand.** Four lines in the application
machine's `.env`, which go together. The last is the credential, which a backend
that needs none goes without:

```sh
COMPOSE_PROFILES=metrics
METRICS_ENABLED=true
SB_METRICS_EXPORT_ENDPOINT=https://otlp.nr-data.net
SB_METRICS_EXPORT_HEADERS='{"api-key":"<your New Relic ingest license key>"}'
```

then `docker compose up -d --wait`. The profile is what starts the collector and
node-exporter; `METRICS_ENABLED` is what gives the collector the application's
own figures, and Compose cannot derive it from the endpoint without rendering it
empty when neither is set, which the application refuses. Left off, the
collector sends the machine's figures and none of the application's. The
database machine's node-exporter is a step of its own, taken on that machine —
[`deploy/compose/single/README.md`](../deploy/compose/single/README.md#metrics)
has it — and `SB_METRICS_DATABASE_TARGET` then names it here. On an AWS or
Oracle Cloud machine, keep the collector and node-exporter off the instance
metadata address first, for the reason
[`deployment-profiles.md`](deployment-profiles.md#the-firewall) gives, and keep
the rule across a reboot however that machine keeps its firewall — on Oracle's
image, `sudo netfilter-persistent save` after it:

```sh
sudo iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner 10000-65534 -j REJECT
```

**The `single` profile, built by `aws-single` or `oci-single`.** Two settings in
the stack and a `pulumi up`:

```sh
pulumi config set --path 'simple-balance:env.SB_METRICS_EXPORT_ENDPOINT' https://otlp.nr-data.net
pulumi config set --secret --path 'simple-balance:secrets.SB_METRICS_EXPORT_HEADERS'
# {"api-key":"<your New Relic ingest license key>"}, typed at the prompt
pulumi up
```

The machine derives the profile and `METRICS_ENABLED=true` itself, the program
names its own database node as the target and opens 9100 to it from the
application node alone, and the settings timer restarts the deployment onto the
collector within about five minutes. A stack whose machines were built before
this release needs files on both machines first, because `pulumi up` never
rewrites a running machine;
[`upgrades.md`](upgrades.md#before-you-upgrade-to-022) has them, and
[`deploy/pulumi/README.md`](../deploy/pulumi/README.md#exporting-metrics) the
rest.

**The split recipe, `compose.distributed.yml`.** The same four lines in
`deploy/compose/.env`, then `docker compose -f
deploy/compose/compose.distributed.yml up -d --wait`.

**The Helm chart.** `collector.enabled`, an endpoint, and the credential in a
Secret of its own:

```sh
kubectl -n simple-balance create secret generic simple-balance-metrics-export \
  --from-literal=SB_METRICS_EXPORT_HEADERS='{"api-key":"<license key>"}'
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --reset-then-reuse-values \
  --set collector.enabled=true \
  --set collector.export.endpoint=https://otlp.nr-data.net \
  --set collector.export.existingSecret=simple-balance-metrics-export
```

The chart turns `METRICS_ENABLED` on with the collector, and the collector needs
naming in no NetworkPolicy; [its
README](../deploy/helm/simple-balance/README.md#the-collector-this-chart-can-run)
has the values and why `--reuse-values` is refused here.

**The cluster programs, `aws`, `gcp` and `oci`.** The same two `pulumi config`
lines as the single-machine programs. The program puts the headers in a Secret
only the collector reads, turns the chart's collector on, and the API and the
scheduler roll once, because `METRICS_ENABLED` changes under them.

Turning it off is the endpoint coming out of the stack, or out of `.env`. By
hand, `docker compose --profile metrics down` first: a `down` that does not name
the profile leaves that profile's containers running. On the database machine
it is `docker compose rm --stop --force node-exporter`, never a `down`, which
would take PostgreSQL with it.

#### Its settings

The collector's, not the application's: neither process reads them.
`COMPOSE_PROFILES` is Compose's own and is not here either.

| Variable | What it does |
| --- | --- |
| `SB_METRICS_EXPORT_ENDPOINT` | Where everything goes. Unset means off. For OTLP a base URL, to which the exporter adds `/v1/metrics` itself: New Relic's is `https://otlp.nr-data.net`, or `https://otlp.eu01.nr-data.net` in the EU. For remote write the whole write URL. `http://` or `https://` and a host; the Pulumi programs and the chart refuse anything else before it reaches a machine. On the chart, `collector.export.endpoint`. |
| `SB_METRICS_EXPORT_PROTOCOL` | Unset means `otlp`, which is OTLP over HTTP, protobuf, gzipped. The other value is `prometheus_remote_write`. Anything else is a refusal at the collector's start naming `forward/<value>`, and a refusal at plan time or render time before that. On the chart, `collector.export.protocol`. |
| `SB_METRICS_EXPORT_HEADERS` | The backend's credential, as a JSON object of header names to values: `{"api-key":"<license key>"}`. A secret: in `simple-balance:secrets` on a stack, single-quoted in a `.env` so a `$` in it survives Compose, and on the chart either `collector.export.headers` or a Secret named in `collector.export.existingSecret`. Never in the Secret the API and the scheduler read, because every key of that one is in their environment. Unset sends no headers. |
| `SB_METRICS_SCRAPE_INTERVAL` | How often, in minutes and seconds: unset means `30s`, and `1m30s` is how a longer one is written. Always under five minutes, for New Relic's reason [below](#sending-to-new-relic). The Pulumi programs and the chart refuse `5m` or more; Compose does not check. On the chart, `collector.scrapeInterval`. |
| `SB_METRICS_ENVIRONMENT` | `deployment.environment.name` on every series, which is what tells two deployments apart in one account. Unset means `production`. On the chart, `collector.environment`. |
| `SB_METRICS_DATABASE_TARGET` | The `single` profile's database machine, as `host:9100`, scraped over TLS and checked against the CA `compose.db-tls.yml` mounts, so the host has to be one the database's certificate names — the host in `DATABASE_URL`, or the machine's private address. The single-machine programs set it themselves for a database node they built, and refuse it from the stack then; with `databaseNode: false` it is yours to name or to leave unset, which scrapes nothing there. The cluster programs refuse it. |

`METRICS_TOKEN` is read by the collector as well as by the application, and sent
as a bearer token on every scrape of the application.

### Sending to New Relic

New Relic is the backend this was designed around, and it is two values. No
real New Relic account has received any of it yet — `docs/acceptance.md`
carries that as outstanding — so the first export is also the first check, and
step 4 is how to make it.

1. **The key is the license key**, the one New Relic's API keys page lists as
   `INGEST - LICENSE`. Its OTLP documentation asks for that key in particular,
   and not a User key, which starts `NRAK-`.
2. **The endpoint is regional.** `https://otlp.nr-data.net` in the US,
   `https://otlp.eu01.nr-data.net` in the EU. Port 443 takes OTLP over HTTP,
   which is what this sends and what New Relic recommends across the public
   internet.
3. **The key travels in an `api-key` header**, so the headers setting is
   `{"api-key":"<license key>"}`.
4. **Check it arrived**, after one scrape interval, in New Relic's query
   builder: every target should read 1.

   ```sql
   FROM Metric SELECT latest(up) FACET service.name, service.instance.id SINCE 10 minutes ago
   ```

**Remote write is the alternative**, for a reason of your own:
`SB_METRICS_EXPORT_PROTOCOL=prometheus_remote_write`, the endpoint
`https://metric-api.newrelic.com/prometheus/v1/write?prometheus_server=simple-balance`
— `metric-api.eu.newrelic.com` in the EU — and the same key as a bearer token,
`{"Authorization":"Bearer <license key>"}`. `prometheus_server` becomes an
attribute on every point, which is how New Relic tells two remote-write sources
apart.

**OTLP is the default for two reasons, and a third that holds less than it
sounds.** A histogram arrives as New Relic's `distribution` type, so
`percentile()` and `histogram()` work on it directly; over remote write the same
histogram arrives as one `count` series per bucket and a `summary` for its sum,
which NRQL cannot take a percentile of. And it is about a quarter of the bytes:
the collector sent 1.1 MB of OTLP in twelve minutes where Prometheus sent 4.8 MB
by remote write, scraping the same 3,700 series every fifteen seconds (October
24, 2026). The third is reset detection. New Relic tells a counter that
restarted from one that went wrong by the start time an OTLP point carries; the
collector's Prometheus receiver stopped setting one in 0.142, and the processor
that adds it back is only in the contrib distribution. So a restart reads as it
does over remote write — the counter drops, New Relic takes the drop as a reset,
and the rate carries on — and New Relic may record the drop as an integration
error, which after a restart is expected rather than a fault. Not observed
against an account.

**Why the interval stays under five minutes.** New Relic turns a cumulative
counter into a rate by remembering the last value of each series, and it forgets
a series that has been silent for five minutes: the next point is treated as the
series beginning again, and the increase across the gap is lost. Thirty seconds
leaves room for several missed scrapes. Two minutes is about as long as is safe,
because one failed scrape at two minutes is four minutes of silence.

**What New Relic calls each thing.** The collector's Prometheus receiver turns a
scrape job into `service.name` and the address it scraped into
`service.instance.id`, and New Relic makes an OpenTelemetry service entity per
`service.name`:

| Profile | `service.name` |
| --- | --- |
| `single` | `simple-balance` (the API and the scheduler, one process), `node`, `node-database`, `collector` |
| `compose.distributed.yml` | `simple-balance-api`, `simple-balance-scheduler`, `node`, `collector` |
| The chart | `simple-balance-api`, `simple-balance-scheduler`, `collector`, with a `pod` attribute on the first two |

Every point also carries `deployment.environment.name`. Two deployments sending
to one account arrive under the same entity names, so set
`SB_METRICS_ENVIRONMENT` differently on each and filter on it. The collector's
own series are `otelcol_*`, and over OTLP they have no `_total` suffix — 0.152
dropped it — where remote write adds it back.

Counters arrive as `cumulativeCount`, which `sum()` reads as the increase over
the window, so `rate(sum(simple_balance_http_requests_total), 1 minute)` is
requests a minute. Histograms arrive as `distribution`, gauges as `gauge`. The
NRQL below is written for that, which is to say for OTLP.

### Sending somewhere else

The same two settings, and the protocol where it is not OTLP. The collector
appends `/v1/metrics` to an OTLP endpoint, which is why some of these end
where they do.

| Backend | `SB_METRICS_EXPORT_PROTOCOL` | `SB_METRICS_EXPORT_ENDPOINT` | `SB_METRICS_EXPORT_HEADERS` |
| --- | --- | --- | --- |
| New Relic | `otlp` | `https://otlp.nr-data.net` | `{"api-key":"<license key>"}` |
| New Relic, remote write | `prometheus_remote_write` | `https://metric-api.newrelic.com/prometheus/v1/write?prometheus_server=simple-balance` | `{"Authorization":"Bearer <license key>"}` |
| Grafana Cloud | `otlp` | `https://otlp-gateway-<region>.grafana.net/otlp` | `{"Authorization":"Basic <base64 of instance id:token>"}` |
| Grafana Mimir, your own | `otlp` | `http://<mimir>/otlp` | none, or `{"X-Scope-OrgID":"<tenant>"}` where it is multi-tenant |
| Prometheus, your own | `prometheus_remote_write` | `http://<prometheus>:9090/api/v1/write`, with `--web.enable-remote-write-receiver` | none |
| VictoriaMetrics | `otlp` | `http://<victoriametrics>:8428/opentelemetry` | none |
| Honeycomb | `otlp` | `https://api.honeycomb.io`, or `https://api.eu1.honeycomb.io` | `{"x-honeycomb-team":"<key>","x-honeycomb-dataset":"<dataset>"}` |
| Chronosphere | `otlp` | `https://<tenant>.chronosphere.io/data/opentelemetry` | `{"API-Token":"<token>"}` |
| SigNoz Cloud | `otlp` | `https://ingest.<region>.signoz.cloud:443` | `{"signoz-ingestion-key":"<key>"}` |
| Elastic Cloud | `otlp` | The managed OTLP endpoint its console shows | `{"Authorization":"ApiKey <key>"}` |

Each row is from that vendor's own documentation, read on October 24, 2026.
What has actually been sent to is a Prometheus and a plain OTLP receiver, each
checked for the headers it was handed — not New Relic, and not any other row
here. Mimir's tenant header is the one detail its page did not confirm.

**A few are not settings alone, and it is better to know before choosing one.**

- **Datadog and Dynatrace** accept delta temporality only, and drop the
  cumulative counters and histograms a Prometheus scrape produces. They need the
  `cumulative_to_delta` processor in the pipeline, which is in the contrib
  distribution and not in the core one this runs.
- **Amazon Managed Service for Prometheus** takes remote write signed with
  SigV4, which is the `sigv4auth` extension — contrib again.
- **Google Cloud's managed Prometheus**, over `telemetry.googleapis.com`, wants
  the `googleclientauth` extension — contrib — and Google's guide adds the
  `metric_start_time` processor beside it.
- **Splunk Observability** takes OTLP at `/v2/datapoint/otlp` rather than at
  `/v1/metrics`, which is a `metrics_endpoint` line in the exporter rather than
  a different image.

For the first three, swap the image for contrib — the same version, built by the
same project, `otel/opentelemetry-collector-contrib:0.162.0`, whose digest on
October 24, 2026 was
`sha256:39923a8e431bd1f57be82411999d389fcfe40857492e4365456d97a4c1f74be6` — in
the `collector` service's `image:` line, or in the chart's `collector.image`
values, and add the component to that deployment's copy of `collector.yaml` or
the chart's ConfigMap template. Both are edits to a file this project ships, so
they are yours to carry through an upgrade. Contrib measured 79.6 MiB where core
measured 51.7, which is still inside the 128 MiB the container is given and
nearer to it.

### What is scraped, and what is not

| Profile | Job | What it reads |
| --- | --- | --- |
| `single` | `simple-balance` | The application, at the loopback port `compose.yml` publishes it on, with the token |
| `single` | `node` | The application machine: CPU, memory, load, pressure, filesystems, disks and its own network interfaces |
| `single` | `node-database` | The database machine's node-exporter, over the private network and TLS, checked against the database's own CA. Only when `SB_METRICS_DATABASE_TARGET` names it |
| `compose.distributed.yml` | `simple-balance-api` | Every `server` container, each a target of its own by DNS |
| `compose.distributed.yml` | `simple-balance-scheduler` | Both `scheduler` replicas, the same way |
| `compose.distributed.yml` | `node` | The machine, with no network figures, because node-exporter there sits on the recipe's network rather than the host's and would report its own one interface as the machine's |
| The chart | `simple-balance-api`, `simple-balance-scheduler` | Every API and scheduler pod of this release, found by watching pods in its own namespace and nothing wider |
| Every shape | `collector` | Itself: what it accepted, refused and sent, its queue and its memory, at `127.0.0.1:8888` |

**Not scraped, on purpose.** The edge — Caddy, the frontend nginx, the cloud's
load balancer — because what reaches the application is already counted by the
application, by route, status and duration, and an edge's own figures would mean
another listener for a question already answered from the inside. PostgreSQL,
Patroni and Citus, because the application's pool is its view of the database —
how long a connection takes to get, how long a transaction holds it, how many
are waiting — and the database's own metrics would need a monitoring role and an
exporter or the contrib distribution. Kubernetes nodes, kubelet and the
cluster's own objects, which EKS, GKE and OKE already measure in their own
monitoring. The `single` profile's database machine *is* scraped for its disk,
memory and CPU, because there the machine is this project's and nothing else is
watching it. Each is the owner's decision rather than an omission, and adding
one is a job of your own in `collector.yaml`.

### Which process a series comes from

The scheduler runs in a different process depending on the profile, and every
series it writes carries the `component` of the process it runs in:

| Profile | Where the scheduler runs | Its series carry |
| --- | --- | --- |
| A single container, or `single` | Inside the API process | `component="api"`, and on `single` the job `simple-balance` |
| `compose.distributed.yml` | Two `scheduler` containers | `component="scheduler"` |
| The chart | The scheduler Deployment | `component="scheduler"` |

So an alert on a scheduler series written against `component="scheduler"`
never fires on `single`, and one written against `component="api"` fires on
`single` and nowhere else.
`simple_balance_scheduler_enabled` is the series written for exactly this: it is
1 in whichever processes run the schedule and 0 in the rest, so its sum across a
deployment is the answer on every profile. The alerts below aggregate
`component` away for the same reason.

### What it costs

Measured on October 24, 2026 on Docker Desktop for arm64, which runs containers
in a Linux VM; a cloud machine has fewer cores and disks for node-exporter to
report and will read lower.

| | Memory | CPU |
| --- | --- | --- |
| The collector, scraping about 3,700 series every fifteen seconds for ten minutes | 51.7 MiB at the median | 0.75% of a core, on average |
| Prometheus 3.13 in agent mode, the same series | 72.3 MiB | 1.46% |
| The collector, contrib distribution, the same series | 79.6 MiB | 0.71% |
| The collector on the `single` profile, every job every fifteen seconds, OTLP | 42.8 MiB, 49 MiB at peak | 0.36% |
| The same, remote write | 43.2 MiB | 2.06% |
| node-exporter, the application machine | 11.3 MiB | 1% or less |
| node-exporter, the database machine, serving TLS | 32 MiB, of which 21 is page cache the kernel can reclaim; 41 MiB at peak | 1% or less |
| The collector in a Kubernetes cluster, two API and two scheduler pods | 31 MiB working set | about 0.003 of a core |

Every container is limited: the collector to 128 MiB, with `GOMEMLIMIT=80MiB`
and its memory limiter refusing data above 80 MiB of heap and collecting hard at
100, node-exporter to 48 MiB with
`GOMEMLIMIT=38MiB`, and on the chart the collector requests 64Mi and 10m and is
limited to 128Mi and 200m. On the `single` profile all of it fits beside the
application on the machine it already has, so turning it on adds no machine and
no line to the bill; [`deployment-costs.md`](deployment-costs.md#metrics) has
the egress and what New Relic's free tier makes of the volume.

### What to alert on

Profile-agnostic, so one set of rules serves every shape. Each PromQL rule
aggregates away the labels that differ between profiles — `component`,
`instance`, and `pod` where the chart adds one — with `sum without` for a count
and `max without` or `min without` for a reading, and where a figure lives in
one process on one profile and another on the next, `job` goes too. A label that
is absent costs nothing to aggregate away. The PromQL is written for the labels
remote write produces; the NRQL for OTLP into New Relic, where a query sums
across everything it does not `FACET`, which is the same aggregation by default.
Thresholds are starting points rather than readings from a production fleet.

None of these rules has run against a live backend yet. The metric names are
checked against the source and against a real scrape, and the NRQL against New
Relic's documentation of how OTLP data is stored and queried. Four queries lean
on functions that documentation does not show on metric data —
`aggregationendtime()`, `derivative()` and `uniqueCount()` of a label — and each
of those is marked where it appears.

#### Down

Every target the collector scrapes reports `up`, and the application's own
readiness is `simple_balance_ready`, 1 when its last check reached the database.
Neither can say the collector itself has stopped, because then nothing arrives
at all: that is a loss-of-signal condition in New Relic, and an outside check of
`/health/ready` at the public address is the one alert that does not depend on
the collector or on anything inside the deployment.

```promql
up{job=~"simple-balance.*|node.*|collector"} == 0                    # for 5m
simple_balance_ready == 0                                            # for 5m
absent_over_time(up{job="collector"}[10m])
sum without (component, instance, pod) (rate(otelcol_exporter_send_failed_metric_points_total[15m])) > 0
```

```sql
FROM Metric SELECT latest(up) FACET service.name, service.instance.id   -- below 1 for 5 minutes
FROM Metric SELECT latest(simple_balance_ready) FACET service.instance.id   -- below 1 for 5 minutes
FROM Metric SELECT count(up) WHERE service.name = 'collector'   -- loss of signal after 10 minutes
```

The outside check is a New Relic synthetic monitor, or any uptime service, on
`https://<your host>/health/ready`, which both proxies pass through.

#### Restarts

```promql
changes(simple_balance_process_start_time_seconds[1h]) > 2   # more than two in an hour is a crash loop
```

```sql
FROM Metric SELECT max(simple_balance_process_start_time_seconds) - min(simple_balance_process_start_time_seconds)
FACET service.instance.id SINCE 1 hour ago   -- above 0 is a restart inside the hour
```

On the chart a replaced pod is a new instance rather than a restarted one, so
the cluster's own count of container restarts is the better reading there.

#### Errors

A 5xx share, and an internal-error share, both leaving out the health probes
and the scrape, which would otherwise be most of an idle deployment's traffic.
`simple_balance_internal_errors_total` is the one to page on: it counts failures
nobody meant on every surface — a streamed commit that failed after its 200, an
MCP tool that failed inside a JSON-RPC reply, an auth task in the background —
and never a refusal the caller can act on. It misses one: a tool whose result
fails its own output schema, which the MCP SDK raises after the tool has
returned, so it reads as `outcome="tool_error"` on
`simple_balance_mcp_requests_total` beside an `ok` on
`simple_balance_mcp_tool_calls_total`.

```promql
sum without (component, instance, pod, method, route, status) (
  rate(simple_balance_http_requests_total{status=~"5..", route!~"/health/.*|/metrics"}[5m]))
/ sum without (component, instance, pod, method, route, status) (
  rate(simple_balance_http_requests_total{route!~"/health/.*|/metrics"}[5m]))
> 0.01

sum without (component, instance, pod, surface) (rate(simple_balance_internal_errors_total[5m]))
/ sum without (component, instance, pod, method, route, status) (
  rate(simple_balance_http_requests_total{route!~"/health/.*|/metrics"}[5m]))
> 0.001
```

```sql
FROM Metric SELECT filter(sum(simple_balance_http_requests_total), WHERE status LIKE '5%') * 100
  / sum(simple_balance_http_requests_total)
WHERE route NOT LIKE '/health/%' AND route != '/metrics'   -- above 1 for 10 minutes

FROM Metric SELECT sum(simple_balance_internal_errors_total) * 100
  / filter(sum(simple_balance_http_requests_total), WHERE route NOT LIKE '/health/%' AND route != '/metrics')
  -- above 0.1 for 10 minutes
```

#### Latency

From the histogram's buckets, leaving out the probes, the scrape, the shell
page, and the two streamed writes — a commit and a CSV stage, which take as long
as the rows they carry and would otherwise be the 95th percentile on their own.
The capacity run answered its busiest hour at 130 ms.

```promql
histogram_quantile(0.95,
  sum without (component, instance, pod, method, route) (
    rate(simple_balance_http_request_duration_seconds_bucket{
      route!~"/health/.*|/metrics|spa_shell|/api/v1/staged-transactions/commit|/api/v1/csv/stage"}[5m])))
> 1
```

```sql
FROM Metric SELECT percentile(simple_balance_http_request_duration_seconds, 95)
WHERE route NOT LIKE '/health/%'
  AND route NOT IN ('/metrics', 'spa_shell', '/api/v1/staged-transactions/commit', '/api/v1/csv/stage')
  -- above 1 for 10 minutes
```

New Relic interpolates within a bucket the way `histogram_quantile` does, so
either figure is an estimate between two bucket bounds.

#### Saturation

Requests in flight, the pool, the event loop and memory. `in_flight` counts the
scrape that reads it, so an idle API reads 1. A request waiting for a pool
connection has already been admitted and is queued behind somebody else's
transaction, which is what `DATABASE_POOL_SIZE` being too small looks like from
outside, and the acquire histogram sees every such wait where the gauge sees
only the ones in progress at a scrape.

```promql
max without (component, instance, pod) (simple_balance_http_requests_in_flight) > 20     # for 10m
max without (component, instance, pod) (simple_balance_db_pool_connections{state="waiting"}) > 0   # for 5m
histogram_quantile(0.95, sum without (component, instance, pod) (
  rate(simple_balance_db_pool_acquire_duration_seconds_bucket[5m]))) > 0.1
sum without (component, instance, pod) (increase(simple_balance_db_pool_errors_total[15m])) > 0
max without (component, instance, pod) (simple_balance_nodejs_eventloop_lag_p99_seconds) > 0.2   # for 10m
predict_linear(simple_balance_process_resident_memory_bytes[6h], 24 * 3600) > 1024 * 1024 * 1024
```

```sql
FROM Metric SELECT max(simple_balance_http_requests_in_flight)   -- above 20 for 10 minutes
FROM Metric SELECT max(simple_balance_db_pool_connections) WHERE state = 'waiting'   -- above 0 for 5 minutes
FROM Metric SELECT percentile(simple_balance_db_pool_acquire_duration_seconds, 95)   -- above 0.1
FROM Metric SELECT sum(simple_balance_db_pool_errors_total)   -- above 0
FROM Metric SELECT max(simple_balance_nodejs_eventloop_lag_p99_seconds)   -- above 0.2 for 10 minutes
FROM Metric SELECT derivative(simple_balance_process_resident_memory_bytes, 1 hour)
FACET service.instance.id SINCE 6 hours ago   -- not run against an account
```

The memory ceiling is the chart's 1 GiB limit for the API; the `single`
profile's application has no container limit, so there the machine's own
memory alert below is the one that matters.

#### The scheduler

Whether anything runs it, and whether each of its four sweeps — recurrences,
reminders, idempotency and billing — has finished lately. A sweep switched off
still counts as finished, so a deployment that sells nothing is not a stuck
billing sweep; one that threw leaves its last timestamp where it was, and the
gap grows. `simple_balance_scheduler_tick_interval_seconds` publishes the
interval, so the rule is three intervals whatever `RECURRENCE_TICK_SECONDS`
says.

```promql
sum without (component, instance, pod, job) (simple_balance_scheduler_enabled) == 0
time() - max without (component, instance, pod, job) (simple_balance_scheduler_last_success_timestamp_seconds)
  > 3 * scalar(max(simple_balance_scheduler_tick_interval_seconds))
sum without (component, instance, pod, job) (increase(simple_balance_scheduler_ticks_total{outcome="failed"}[1h])) > 0
```

```sql
FROM Metric SELECT max(simple_balance_scheduler_enabled)   -- below 1: nothing runs the schedule
FROM Metric SELECT aggregationendtime() / 1000 - max(simple_balance_scheduler_last_success_timestamp_seconds)
FACET sweep   -- above 900, three of the default 300-second ticks; not run against an account
FROM Metric SELECT filter(sum(simple_balance_scheduler_ticks_total), WHERE outcome = 'failed')   -- above 0
```

In NRQL `max` across every process is the same question as the PromQL sum: 1
anywhere means something runs the schedule.

#### Dependencies

Mail, Stripe and the webhook. `simple_balance_dependency_up` is 1 when the last
check a process made of a dependency passed and 0 when it failed, and absent for
a dependency the deployment does not use — no relay configured is a supported
deployment, not a broken one. `smtp` and `stripe_access` are checked as the
process starts, so a relay fixed since then still reads 0 until a restart, and
`mail_messages_total` is where to read whether mail is going out;
`stripe_prices` follows every price check the process makes. A failed Stripe
request says why: `api` and `connection` are Stripe, `authentication` and
`permission` are this deployment's key. A webhook delivery whose signature did
not verify is either a webhook secret that is wrong or somebody probing the
one public route whose body an unauthenticated caller writes, and a billing
sweep that counts `written` has repaired what a webhook should have done.

```promql
min without (component, instance, pod) (simple_balance_dependency_up) == 0
sum without (component, instance, pod) (increase(simple_balance_mail_messages_total{outcome="failed"}[1h])) > 0
sum without (component, instance, pod, operation) (
  increase(simple_balance_stripe_request_failures_total{reason=~"api|connection|authentication|permission|approval_required"}[30m])) > 0
sum without (component, instance, pod) (
  increase(simple_balance_billing_webhook_deliveries_total{outcome="signature_refused"}[1h])) > 0
sum without (component, instance, pod, job) (increase(simple_balance_billing_sweeps_total{outcome="written"}[1d])) > 0
```

```sql
FROM Metric SELECT min(simple_balance_dependency_up) FACET dependency   -- below 1
FROM Metric SELECT filter(sum(simple_balance_mail_messages_total), WHERE outcome = 'failed')   -- above 0
FROM Metric SELECT sum(simple_balance_stripe_request_failures_total)
WHERE reason IN ('api', 'connection', 'authentication', 'permission', 'approval_required') FACET reason
FROM Metric SELECT sum(simple_balance_billing_webhook_deliveries_total) FACET outcome
FROM Metric SELECT filter(sum(simple_balance_billing_sweeps_total), WHERE outcome = 'written') SINCE 1 day ago
```

`outcome="skipped"` on `mail_messages_total` is a message with no relay to send
it, which is right on a deployment without mail and a misconfiguration on one
that thinks it has some.

#### Version skew

`simple_balance_build_info` is 1, with the version as a label. Two versions at
once is a split deployment upgraded halfway, two versions against one database,
which is the state the schema contract is written for and the one nobody notices
without asking.

```promql
count without (version) (count without (component, instance, pod, job) (simple_balance_build_info)) > 1
```

```sql
FROM Metric SELECT uniqueCount(version) WHERE metricName = 'simple_balance_build_info'
  -- above 1; not run against an account
```

#### The machines

From node-exporter, on each machine the Compose shapes run: space left, memory
left, the OOM killer, and CPU busy, stolen or making work wait. The data volume
fills with dumps on the application machine and with the ledger on the database
machine, which is why space is also predicted rather than only measured.

```promql
node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1
predict_linear(node_filesystem_avail_bytes[6h], 24 * 3600) < 0
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
increase(node_vmstat_oom_kill[1h]) > 0
1 - avg without (cpu, mode) (rate(node_cpu_seconds_total{mode="idle"}[5m])) > 0.9   # for 15m
avg without (cpu, mode) (rate(node_cpu_seconds_total{mode="steal"}[5m])) > 0.1
rate(node_pressure_cpu_waiting_seconds_total[5m]) > 0.2
```

```sql
FROM Metric SELECT latest(node_filesystem_avail_bytes) / latest(node_filesystem_size_bytes)
FACET service.name, mountpoint   -- below 0.1
FROM Metric SELECT latest(node_memory_MemAvailable_bytes) / latest(node_memory_MemTotal_bytes)
FACET service.name   -- below 0.1
FROM Metric SELECT max(node_vmstat_oom_kill) - min(node_vmstat_oom_kill) FACET service.name   -- above 0
FROM Metric SELECT 1 - filter(rate(sum(node_cpu_seconds_total), 1 second), WHERE mode = 'idle') / uniqueCount(cpu)
WHERE metricName = 'node_cpu_seconds_total' FACET service.name   -- above 0.9; not run against an account
```

`node_vmstat_oom_kill` is a gauge over OTLP rather than a counter, because
node-exporter publishes it untyped, hence the difference rather than a `sum`.

The migration counters are not on this list on purpose: a startup migration
that fails takes the process down before it serves anything, so nothing is
ever scraped with `outcome="failed"` on it. Readiness is what tells you, and the
counters are for reading afterward — how long the wait for the lock was on a
rolling deploy.

## Backups

Everything is in PostgreSQL, so backing up the database backs up the product.

```sh
pg_dump --format=custom "$DATABASE_URL" > simple-balance-$(date +%F).dump
```

`pg_dump` reads that string as libpq does, so where it says
`sslmode=no-verify`, write `sslmode=require` for the dump — the same guarantee,
in the spelling libpq accepts, and a file `sslrootcert` names has to be
readable where `pg_dump` runs; [reaching the database over a
network](#reaching-the-database-over-a-network) has the reason. Restore into an
empty database with `pg_restore`. Take a backup before upgrading;
[upgrades](upgrades.md) explains why.

## Upgrading

Pull the new image, stop and remove the container, start it again with the same
command. Migrations run at startup under an advisory lock, so concurrent starts
cannot race each other, and readiness stays closed until they finish.
`npm run db:migrate` is a development convenience, not an operator step. See
[upgrades](upgrades.md).

## Development

```sh
docker compose -f compose.dev.yml up -d
npm run dev
```

Then `npm run dev:client` in another terminal, and open
<http://localhost:5173>. Vite proxies the API, OAuth discovery, health, and MCP
routes to port 3000. No environment variables are needed: create a real account
on the first visit and use it for both the web app and MCP OAuth. Outside
production the API binds to `127.0.0.1`.

The compose file also creates `simple_balance_test` for the integration suite.
