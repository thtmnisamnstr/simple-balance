# Deployment

Simple Balance is one container and one PostgreSQL database. There is no Redis,
no sidecar, no object store, and nothing it needs to write to disk.

PostgreSQL 15 or newer. Every release is tested against 15 and 16, on Node 22
and 24. Nothing else is assumed about the server.

## Settings

Everything is an environment variable. `.env.example` has the lot; these are the
ones that matter.

### Required in production

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 15+ connection string. Encrypt it when the database is not on the same host; see TLS below for which `sslmode` to use. The database it names is created if the server does not have it yet. |
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
| `SETUP_TOKEN` | generated | The one-time code that claims a fresh instance. At least 16 characters if you set it; a shorter one refuses to start. Left unset, one is generated and printed to the startup log. It is a secret, so it also takes a `SETUP_TOKEN_FILE`; see below. |
| `PORT` | `3000` | The port inside the container. Change it and your published port mapping has to follow. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. It governs this product's own lines as well as the auth library's, so `error` really is quiet. A refusal at startup is reported whatever it is set to. |
| `TRUST_PROXY` | `false` | Turn it on when a reverse proxy sits in front and replaces `X-Forwarded-For`. See the reverse proxy section; getting it wrong costs per-visitor rate limiting. |
| `DATABASE_POOL_SIZE` | `10` | Connections held open, per process. Ceiling 100. Raise it only if you have measured contention, and see the split-container section for what it means once there is more than one replica. |
| `DIRECT_DATABASE_URL` | `DATABASE_URL` | A second connection string that bypasses a transaction pooler. Only needed when PgBouncer or similar sits in front; see below. It carries a password, so it also takes a `DIRECT_DATABASE_URL_FILE`. |
| `CSV_MAX_BYTES` | `10485760` | Largest CSV accepted for import, 10 MB by default. Ceiling 104857600. |
| `CSV_MAX_ROWS` | `10000` | Most rows accepted from one CSV. Ceiling 10000, which is also the most rows one mass edit, commit, or delete covers, so an import always fits in a single review-queue action. |
| `RECURRENCE_SCHEDULER` | `true` | Whether this process runs the schedule at all: proposing recurring transactions, and sending the reminders and proposal notices that go by email. Turn it off on replicas that serve the API when a separate scheduler container owns the job. A value other than `true` or `false` refuses to start, because the wrong setting is otherwise silent. |
| `RECURRENCE_TICK_SECONDS` | `300` | How often it looks for work that has come due, meaning both a recurrence to propose and a reminder to send. Latency only for a recurrence: whatever a missed tick leaves behind, the next one catches up. A reminder whose moment passed is not sent late, so this is also how close to the requested time a reminder lands. Ceiling 3600. |
| `RECURRENCE_CATCH_UP_LIMIT` | `50` | Most occurrences one recurrence catches up in one tick. Nothing is dropped; a tick that hits the cap comes straight back rather than waiting out the interval. Ceiling 500. |
| `RECURRENCE_CLAIM_LIMIT` | `500` | Most recurrences examined in one tick. Ceiling 5000. |
| `METRICS_ENABLED` | `false` | Whether this process answers `GET /metrics` in Prometheus' text format. Off unless you ask for it. |
| `METRICS_TOKEN` | unset | A bearer token `GET /metrics` demands before it answers. Optional; unset means anybody who can reach the port can scrape it. It is a secret, so it also takes a `METRICS_TOKEN_FILE`; see below. |

`CSV_MAX_BYTES`, `CSV_MAX_ROWS`, `DATABASE_POOL_SIZE`,
`RECURRENCE_TICK_SECONDS`, `RECURRENCE_CATCH_UP_LIMIT` and
`RECURRENCE_CLAIM_LIMIT` are each a whole number between 1 and the ceiling
shown. Anything else — a word, a zero, a negative, something past the ceiling —
warns at startup, names the variable and the value, and uses the default.
Leaving one out is the only way to ask for its default without a warning.

All six are read at startup, before anything is served, so the warning is in
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
`PORT` has to be a port. `DATABASE_POOL_SIZE` has a ceiling of its own because
too many connections takes the database down rather than this process.

### Limits you cannot change

These are compiled in rather than configured, because each one bounds something
a person or an agent could otherwise use to fill the database. They are here so
a refusal is explainable rather than surprising.

| Limit | Value | What hits it |
| --- | --- | --- |
| Rows in one mass edit or mass delete | 10,000 | A selection larger than this is refused rather than truncated. Split the work across calls; each one stands or falls on its own. |
| Category legs on one transaction | 50 | Far past a receipt anybody itemises by hand. A split is the whole counter-side of the entry rewritten, so the cost is paid on every read of it. |
| Recurring transactions per person | 200 | Each one is a standing instruction that proposes rows on every tick, so an uncapped list is a way to flood Staged transactions with nothing but `ledger:write`. |
| Transaction templates per person | 200 | A template is read into the form's dropdown on every visit, so the list is loaded whole rather than paged. |
| Columns in one report | 600 | A long history asked for weekly buckets is thousands of columns nobody can read. Refused with the coarser bucket named, rather than served slowly. |
| Postings in one register | 10,000 | Refused rather than truncated: a register is read to find the row a balance went wrong on, and one cut short would close on a balance its own last row does not reach. Narrow the date range. |
| Consecutive skipped occurrences a reminder looks past | 400 | A rule whose every date its own policies skip — the 31st of every month with `skip`, say — has no schedule left to speak of, and the bound is what stops it spinning inside a scheduler tick. |
| Interval on a schedule | 366 | The N in "every N days", for a recurrence and for a template reminder alike. |

### Only for Google sign-in

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | unset | The OAuth client this deployment signs people in with. Required when `AUTH_MODE` is `google` or `both`, and ignored otherwise. |
| `GOOGLE_CLIENT_SECRET` | unset | That client's secret. Required alongside the ID. It is a secret, so it also takes a `GOOGLE_CLIENT_SECRET_FILE`; see below. |

Google modes refuse to start without both, and without an `ALLOWED_EMAILS` that
admits somebody, rather than silently letting everyone in.

### Keeping a secret out of the environment

Seven variables also answer to a `NAME_FILE` form: `AUTH_SECRET`,
`DATABASE_URL`, `DIRECT_DATABASE_URL`, `SMTP_PASSWORD`, `GOOGLE_CLIENT_SECRET`,
`SETUP_TOKEN` and `METRICS_TOKEN`. Having the form is the definition of being a
secret here, so nothing else in either table above has one.

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
takes work you do yourself. The Helm chart in `deploy/helm` writes all six into
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

A database on another host should be reached over TLS, or the password and every
row of the ledger cross the network in the clear. Which `sslmode` to put in
`DATABASE_URL` depends on who signed the server's certificate.

| `sslmode` | Encrypted | Certificate checked | Use it when |
| --- | --- | --- | --- |
| omitted | No | n/a | The database is on the same host, or reached over a private network you trust. |
| `no-verify` | Yes | No | The server presents a certificate it signed itself, which a self-hosted PostgreSQL usually does. |
| `verify-full` | Yes | Yes | The server has a certificate from a CA the container already trusts, such as a managed database. |

Do not reach for `require`. In libpq it means "encrypt and do not check the
certificate", and it is the setting most people try first, but node-postgres
does check the certificate, so against a self-signed server it fails with
`DEPTH_ZERO_SELF_SIGNED_CERT` and Node advises installing a root CA that does
not exist. The server refuses to start and says which setting to use instead.

`no-verify` is a real improvement on no TLS at all: the connection is encrypted,
so nothing on the network can read it. It cannot tell you that the host
answering is the host you meant, so on a network where somebody could stand in
the middle, put the server's CA where the container trusts it and use
`verify-full`.

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
| `SMTP_PORT` | `587`, or `465` when `SMTP_SSL` is true | |
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
server carries on, because the ledger works whether or not mail does. Reset and
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
all four yours, and PTR is the one that catches people out: it belongs to
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
  reverse_proxy 127.0.0.1:3000
}
```

```nginx
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
}
```

Then set `TRUST_PROXY=true`. Sign-in attempts are counted per client address,
and with this off that address is the far end of the connection, which behind a
proxy is the proxy itself for every visitor. Everybody would share one
allowance, and one stranger could spend it for the rest. The server warns at
startup when it is counting against the connection address, and says nothing
when it is not, so silence there means the setting took.

Only leave `TRUST_PROXY` off when the application is reached directly, or when
the proxy in front passes through `X-Forwarded-For` rather than replacing it.
With it off, an address a caller made up is ignored in favour of the connection
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

## Splitting it into separate containers

One container is the supported way to run this, and the rest of this document
assumes it. If you are running under Kubernetes and want to scale the web tier,
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

The server image is the API and the MCP endpoint with no browser bundle in it.
A request for a page gets a 404 rather than an application shell it is not the
authority on. It reads the same settings as the single container.

The frontend image is nginx serving the bundle and proxying `/api`, `/mcp`,
`/health` and `/.well-known` through to the server. It listens on **8080**, not
80, because the base image runs as a non-root user that cannot bind a privileged
port. Three settings, all with working defaults:

| Variable | Default | What it does |
| --- | --- | --- |
| `SB_API_ORIGIN` | `http://simple-balance-server:3000` | Where to proxy everything the API owns. Point it at your API Service. |
| `SB_FRONTEND_PORT` | `8080` | The port nginx listens on. Change it and the readiness probe and Service have to follow. |
| `SB_MAX_UPLOAD_SIZE` | `61m` | The largest request body nginx will pass. A CSV arrives as a JSON string rather than as a file upload, and the API sizes its own limit for those routes at `CSV_MAX_BYTES` x 6 plus 64 KiB to cover worst-case JSON escaping. Keep this above that number, or a CSV the API would accept is refused before it reaches it. At the default `CSV_MAX_BYTES` of 10 MB that means at least `61m`. |

These three are the only settings in this document that appear in no
`.env.example`, and that is the reason rather than an omission: they belong to
the nginx container, and neither example file configures it. The root file
serves the single container, which has no nginx in it. The compose file sets all
three on the frontend service itself, where the value can carry the reason it is
what it is, and the defaults above are baked into
`deploy/docker/frontend.Dockerfile`, so a deployment changing none of them has
nothing to set. Everything the Node processes read appears in both places.

nginx repeats every response header the API sets — the content security policy,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, HSTS, the two
`Cross-Origin-*` policies, `Origin-Agent-Cluster` and the legacy four — on the
files it serves itself. The application shell never reaches the API process, so
without this the one document that actually runs the app would ship with no
policy at all. `tests/security-header-parity.test.ts` runs a real response
through the middleware and fails if the two lists differ by a header or by a
value, because they are one policy written in two languages. It replaces `X-Forwarded-For` with `$remote_addr` rather than
appending to it, which is what `TRUST_PROXY=true` on the server is safe to
believe.

The scheduler image runs the whole schedule — proposing recurring transactions
and sending the reminders and proposal notices — and serves nothing but its own
health checks, so a Service pointed at it by mistake cannot answer an API
request. It needs the `SMTP_*` and `MAIL_FROM` settings as well: without them it
proposes rows and sends nothing, which is a supported deployment rather than an
error, so it says so in one line at startup instead. Given them, it opens a
connection to the relay at startup and logs the address it will be sending as,
or logs the refusal and carries on proposing. Those two lines are the difference
between a scheduler that is working and one that was never handed the settings,
which otherwise look identical. The chart and the compose file both hand it the
same configuration the API gets, so neither needs anything extra; a deployment
assembled by hand does. It runs one entrypoint of its own and always ticks: the
`RECURRENCE_SCHEDULER` flag decides whether the API replicas tick too, and a pod
whose only job is this one would be pointless with it off.

Five things have to line up:

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
- **Nothing trusted in front of nginx, or `set_real_ip_from` if there is.** The
  template replaces `X-Forwarded-For` with `$remote_addr`, which is right when
  nginx is the first hop and wrong when an ingress terminating TLS sits in front
  of it: `$remote_addr` is then that ingress, and with `TRUST_PROXY=true` every
  visitor in the cluster shares one sign-in allowance. Since this container
  listens on plain HTTP and production requires an HTTPS `APP_BASE_URL`,
  something is terminating TLS in front of it, so this is the ordinary case
  rather than the exotic one. Add
  `set_real_ip_from <your ingress CIDR>; real_ip_header X-Forwarded-For;
  real_ip_recursive on;` to the proxy location so `$remote_addr` resolves back
  to the visitor.

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

A process with the scheduler switched off is not an unhealthy one, so readiness
says nothing about it. What tells you the scheduler has stopped is the Recurring
page: a recurrence past its due date with nothing proposed means whatever runs
the schedule is not running. Reminders give no such signal — an email that never
arrived looks like an email nobody sent — so the Recurring page is the one place
to look for both.

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
it in production without one and the startup log says so once. The bundled
frontend nginx does **not** proxy `/metrics`: a scrape goes to the API service
directly, so the browser's hostname never exposes it.

A Prometheus job for the two containers, with a token:

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
`simple_balance_nodejs_*`, because `prom-client`'s default set is collected under
the same prefix rather than beside it. `simple_balance_build_info` carries the
version as a label, so a scrape says which build produced it. Every series carries `component="api"` or
`component="scheduler"`, so a split deployment can tell the two apart and a
single container reports both under `api`.

Five things are worth alerting on, and they are the ones that fail silently
today:

- `simple_balance_db_pool_connections{state="waiting"}` above zero for more than
  a moment. A request waiting there has already been admitted and is queued
  behind somebody else's transaction, which is what `DATABASE_POOL_SIZE` being
  too small looks like from outside.
- `simple_balance_scheduler_ticks_total{outcome="failed"}` increasing. A tick
  that throws is caught and the next one is armed, so nothing stops and nothing
  gets proposed.
- The absence of `simple_balance_scheduler_ticks_total` altogether, on a
  deployment that expects a schedule. That is `RECURRENCE_SCHEDULER` off
  everywhere, which is the one misconfiguration whose symptom is a year of
  missing rent.
- `simple_balance_mail_messages_total{outcome="failed"}` increasing, or
  `{outcome="skipped"}` on a deployment that thinks it has a mail server.
- `simple_balance_build_info` changing, or disagreeing between the API and the
  scheduler. A split deployment upgraded halfway is two versions against one
  database, which is the state the schema contract is written for and the one
  nobody notices without asking.

The migration counters are the exception: a startup migration that fails takes
the process down before it serves anything, so nothing is ever scraped with
`outcome="failed"` on it. Readiness is what tells you, and the counters are for
reading afterwards — how long the wait for the lock was on a rolling deploy.

## Backups

Everything is in PostgreSQL, so backing up the database backs up the product.

```sh
pg_dump --format=custom "$DATABASE_URL" > simple-balance-$(date +%F).dump
```

Restore into an empty database with `pg_restore`. Take a backup before upgrading;
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
