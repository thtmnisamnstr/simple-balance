# Operations

Three surfaces with one audience: the person running this. Mail is what the
product sends them and their users; configuration is what they hand it; the
container is what they schedule. They are one guide because a decision in any of
the three shows up in the other two, and because the same person reads all of
them at three in the morning.

Read [`common.md`](common.md) first. Money, dates, naming, errors and prose are
answered there and not restated here.

---

## Mail

### What a message may contain

**House.** Three tiers, and the reasoning is the rule rather than a citation.

| Tier | What |
| --- | --- |
| **Never** | A balance, a total, an amount, an account number. Anything that lets somebody reading the mailbox learn a financial position they could not learn from the subject line. |
| **Only when the message is meaningless without it** | A payee, a category, a specific date, a recurrence or template name. All of these are text the person wrote themselves. |
| **Always** | What happened, what is waiting, where to go, and how to stop the message arriving again. |

The premise is NIST SP 800-63B revision 4 §3.1.3.1, which refuses email for
out-of-band authentication on three grounds: it is reachable with only a
password, interceptable in transit and at intermediate mail servers, and
reroutable by DNS spoofing. Two of those three are about the path rather than
the mailbox, so "the recipient's mailbox is secure" is not an answer.

Say plainly what this is not: **no regulation or standard requires any of it.**
PCI DSS covers card numbers and this product stores none. Nothing in the
researched sources says a financial notification may not name an amount. This is
a house rule with reasoning, and anybody arguing with it should argue with the
reasoning.

The product already follows it. `recurrenceProposedMessage`
(`src/server/mail.ts:140-166`) names the occurrence dates and stops, and the
docstring above it says why: "a proposed row is not money that has moved" and "a
total in a mail reads like a statement". `templateReminderMessage`
(`src/server/mail.ts:175-193`) names the template and the date and carries no
figure. The two auth messages carry a URL and nothing else.

**Binding.** `AGENTS.md`: "Never represent money with JavaScript/JSON
floating-point numbers. Use validated decimal strings and PostgreSQL
`numeric(44,18)`." No message currently carries a figure, so the temptation here
is prospective: the first person to put "you have spent 412.30 this month" in a
subject line will reach for a number to compare against a budget. Both halves of
that are wrong, the arithmetic and the disclosure.

*Checked by:* nothing. This is review, and it is honest review: what makes a
sentence a disclosure is not something a regex knows.

### One message, one action

**House.** A message has one subject and one thing to do about it. Two reasons.
A digest that mixes a password reset with a reminder cannot be traced back to
one setting, and a single-purpose message keeps the CAN-SPAM primary-purpose
question from ever arising. That statute could not be read during research, so
the guide does not rely on it; the operational rule stands on its own.

*Not checked mechanically.* Four message builders is a short enough list to read.

### Plain text

**House, and the evidence is unusually strong for a house rule.** Every message
this product sends is `text` only (`src/server/mail.ts:111-119`). The Email
Markup Consortium tested 376,348 messages sent between May 2025 and May 2026 and
found 99.88% carried Serious or Critical accessibility defects; eight messages,
from three brands, passed. The top nine defects are all HTML defects: missing
`dir`, missing `lang`, layout tables with no `role`, no level-one heading, links
without discernible text, insufficient contrast, images with no alt text,
missing `<title>`. A plain-text message has none of them, for free, forever.

**House.** Mail is never themed. This product shipped a three-state theme in the
browser in 0.1.5, and it does not transfer:
`prefers-color-scheme` has roughly 42% support across tested mail clients, Yahoo
and AOL rewrite the query into something that never matches, and clients that do
not honour it invert colours with their own algorithms. Plain text inherits the
reader's own theme correctly everywhere.

**House.** If HTML is ever added it ships as `multipart/alternative` with the
existing text part first, and it is authored against the EMC defect list and
WCAG 2.2 contrast ratios. RFC 2046 §5.1.4 describes plainest-first as "the
friendliest possible option" for non-MIME viewers, and it is worth knowing that
this is descriptive and SHOULD-level: the same section allows an agent that
"prefer[s] to offer the user the choice". The ordering is still right, for the
reason RFC 2046 gives rather than because it is mandated.

*Checked by:* nothing. `sendMail` passes `text` and no `html`, and nothing
asserts it stays that way.

### Headers

**How a SHOULD is labelled here**, stated once because this section leans on
four of them. A SHOULD about what this product emits is **Binding**: it is an
obligation on us and breaking it is a defect. A SHOULD about how a receiver
behaves, or one that only describes a practice, is **House**: the reasoning
carries it, not the mandate.

**Binding (RFC 3834 §5.2, SHOULD), and missing today.** Every message this
product sends is machine-generated and must carry
`Auto-Submitted: auto-generated`, which §5.2 says "SHOULD be used on messages
generated by automatic (often periodic) processes". What that buys is in §2:
automatic responses "SHOULD NOT be issued in response to any message which
contains an Auto-Submitted header field ... where that field has any value other
than 'no'". Without it a vacation responder or a ticketing system may reply to a
password reset, and the reply lands on `MAIL_FROM` or `MAIL_REPLY_TO`.
`sendMail` (`src/server/mail.ts:106-127`) sets it on every message.

*Checked by:* `tests/mail-headers.test.ts`.

**House, already correct.** `Reply-To` is set only when replies should go
somewhere other than `From` (`src/server/mail.ts:113-115`), which is what RFC
5322 §3.6.2 assumes when it says replies go to `From` in the header's absence.
The common mistake is a no-reply `From` with no `Reply-To`, which sends a
person's question nowhere.

**House.** No `List-Unsubscribe` and no `List-Unsubscribe-Post`. RFC 8058
one-click unsubscribe requires both headers to be covered by a DKIM signature
that this application does not produce, the relay does. It binds bulk senders,
and a self-hosted ledger sending a handful of reminders is not one. What RFC
8058 is *for* is met another way, below.

*Checked by:* nothing. `Auto-Submitted` is a one-assertion test over the four
message builders and does not exist.

### Subject lines

**House.** The fixed, identifying part comes first, and any interpolated user
text is capped.

No source establishes a subject-line rule for transactional mail. The length
advice that circulates is vendor open-rate data about campaign mail, which is a
different medium with a different reader. This is a house rule and the reason is
truncation: a mail client shows the first N characters, so whatever is first is
what the person reads in the list.

The product is half right. `Reminder: ${templateName}`
(`src/server/mail.ts:182`) gets it right. `${recurrenceName} is waiting on
Staged transactions` and `${recurrenceName} has N rows waiting on Staged
transactions` (`src/server/mail.ts:153-156`) get it backwards, and a recurrence
name may be 120 characters (`src/shared/domain.ts:1790`), so the meaning is
pushed past every client's truncation. RFC 5322 §2.1.1's 78-character SHOULD is
not the argument: it is a rule about transmitted line length, which a mailer
satisfies by folding, and the subject stays well inside the 998-character MUST
either way. This is legibility rather than conformance. **Work to do:** put the
fixed part first and cap the name.

**Binding, and already met by accident of the schema.** A subject cannot contain
CR or LF. Recurrence and template names go through `oneLine`
(`src/shared/domain.ts:236-248`), which refuses every character
from U+0000 to U+001F and U+007F, so header injection through a subject is
closed at the schema rather than at the mailer. Worth writing down precisely because the
defence is nowhere near the code it defends.

*Checked by:* `tests/integration/notifications.integration.test.ts:216` pins the
template subject exactly, `Reminder: Quarterly tax`, which is the fixed part
first. Nothing pins the recurrence subject beyond `:154` asserting that it
contains the recurrence's name, so the ordering this section calls wrong is the
half nothing holds. Nothing asserts that `oneLine` refuses a newline.

### What goes in the log when a message fails

**House.** A log line about a message names the notification row, never the
subject.

There are two policies about personal data in log lines in one process today.
`account-deletion.ts:178-185` logs counts and no address, with the comment
"Deliberately without the address: they asked to be gone."
`src/server/mail.ts:75-81` logs `Could not send "${message.subject}"`, and the
subject is a recurrence or template name the person wrote, alongside the
nodemailer error, which carries `rejected` and `envelope` holding the recipient's
address. The account-deletion policy wins. **Work to do:** log the notification
id, as `notifications.ts` already does elsewhere.

*Checked by:* nothing.

### Password reset and verification

**House, and already met.** The reset satisfies the OWASP Forgot Password
guidance in the ways that matter here: a single-use token whose one-hour expiry
is stated in the body (`src/server/mail.ts:129-138`), no password in the
message, and an identical response whether or not the account exists, which is
the whole reason `sendMail` returns `false` rather than throwing
(`src/server/mail.ts:97-109`).

**House, and this is the constraint to state as a defence rather than as
strictness.** The URL in a reset message is built from `APP_BASE_URL`, which
`config.ts:13-47` validates as an exact HTTP(S) origin with no credentials, path,
query or fragment, HTTPS everywhere but loopback. That is the Host-header
injection defence: a reset link assembled from the request's `Host` header lets a
stranger send a real user a real reset link pointing at the stranger's server.
Written as "the origin must be exact" it reads as fussiness about URLs.

**House.** Mail is a notification channel and an account-recovery channel. It is
never a second factor. NIST SP 800-63B revision 4 §3.1.3.1 is the citation, and
revision 3 is superseded.

*Checked by:* `tests/config.test.ts` (the origin rule, including the four
non-origin forms it refuses). The single-use and expiry behaviour is Better
Auth's and is not asserted here.

### Deliverability

**House.** Deliverability is documented, not solved.

SPF (RFC 7208), DKIM (RFC 6376), DMARC (RFC 9989, with RFC 9990 and RFC 9991 for
reporting), a valid PTR record and TLS on the submission leg are properties of
the operator's relay and DNS, not of this application. An app that tried to solve
them would be a mail server, which is a second persistent dependency and a
different product. What this product owes the operator is a page that names the
five, says which of them their relay provider already handles, and says what
Google's bulk-sender thresholds are so they can tell whether any of it applies to
them.

Cite **RFC 9989**, republished as Standards Track in May 2026, and not RFC 7489,
which it obsoletes and which most guidance on the web still names.

Google requires of every sender: SPF or DKIM on the sending domain, valid forward
and reverse DNS, TLS for transmission, a spam rate under 0.3% in Postmaster
Tools, and RFC 5322 formatting. Senders of roughly 5,000 messages or more to
personal Gmail accounts in 24 hours additionally need SPF and DKIM both, DMARC,
alignment, and one-click unsubscribe. A self-hosted ledger is not in the second
group.

The application does one thing about the transport and does it right.
`requireTLS: !mail.ssl && authenticated` (`src/server/mail.ts:33`) makes the
STARTTLS upgrade compulsory whenever there is a password to protect and optional
when there is not, so credentials never cross an unencrypted link but a relay on
a trusted network that speaks no TLS still works.

**Work to do:** `docs/deployment.md` documents every SMTP variable and the
transport behaviour, and the strings SPF, DKIM, DMARC and PTR appear nowhere an
operator reads: not in `docs/deployment.md`, `README.md`, `.env.example` or
`deploy/`. An operator whose reminders land in spam has nothing to read.

*Checked by:* `tests/mail-settings.test.ts` for the transport matrix, including
"will not send a password to a relay that refuses to encrypt". Nothing checks the
documentation.

### Degrading without mail

**Binding.** `AGENTS.md`: "Mail is optional and everything that needs it degrades
rather than breaks. A deployment with no SMTP_HOST offers no password reset, asks
nobody to confirm an address, and sends no scheduled reminder; one with SMTP_HOST
does all three. Never make an account that was created without a mail server
unusable once one is added, and never refuse to store a notification setting
because there is nowhere to send it yet."

**Binding.** `AGENTS.md`: "A backlog collapses to one message. Nothing is ever
queued for later."

**House, and it is the substance of RFC 8058 without the headers.** Every
scheduled message names the setting that produced it and the screen that turns it
off. `recurrenceProposedMessage` ends "You asked for this when you set the
recurring transaction up. Turn it off on that transaction's edit screen."
`templateReminderMessage` says whether the reminder repeats and where to change
it. A message a person cannot trace back to a decision they made is a message
they will mark as spam, and at this volume that is the whole of the problem RFC
8058 exists to solve.

**House.** A refused mail transport logs and continues. `checkMailTransport`
(`src/server/mail.ts:67-84`) opens a connection at startup so a wrong address is
found by the operator rather than by somebody locked out, and returns `false`
rather than throwing, "because the ledger is the thing people came for, and it
works whether or not mail does; what must not happen is failing in silence".
This is the one named exception to fail-fast configuration, below.

*Checked by:* `tests/mail-settings.test.ts` ("is off when nothing is set",
"refuses half a configuration, in either direction"). The degradation itself is
covered by the recurrence and notification suites rather than here.

---

## Configuration

### Naming

**Binding (POSIX Base Specifications Issue 8, chapter 8).** Uppercase letters,
digits and underscore. No leading digit. No `=`.

**House.** No lowercase names, without exception. POSIX reserves the lowercase
namespace *for* applications, so this product could use it; a mixed-case set is
one more thing an operator has to remember, and no prefix or casing rule here
comes from POSIX.

**House, and this is a decision rather than a description.** Names a platform
already defines by convention stay unprefixed: `PORT`, `NODE_ENV`,
`DATABASE_URL`, `LOG_LEVEL`. Everything this product invents is prefixed `SB_`.

The codebase is split. The server reads unprefixed product names (`AUTH_MODE`,
`TRUST_PROXY`, `AUTH_SECRET`, `RECURRENCE_*`, `CSV_*`, `ALLOWED_EMAILS`) while
the nginx frontend reads prefixed ones (`SB_API_ORIGIN`, `SB_FRONTEND_PORT`,
`SB_MAX_UPLOAD_SIZE`; `deploy/docker/frontend.Dockerfile:34-42`). `AUTH_MODE`
and `TRUST_PROXY` are generic enough to collide with a sidecar or a base image.

**The existing unprefixed names are frozen, and the rule applies to new ones.**
Renaming them is a breaking change for every operator, and the cost of the
inconsistency is smaller than the cost of the rename. What is not acceptable is
leaving the question open, which is what this paragraph closes.

*Not checked mechanically.* A grep for new unprefixed names would need to know
which are conventional.

### Types

**House.** A boolean accepts exactly `true` and `false`, lowercased, and anything
else refuses to start.

This is the rule most worth stating because the alternative is truthiness, and
truthiness has no symptom. `RECURRENCE_SCHEDULER` already does it, and
`config.ts:188-190` gives the reason: "A misspelling here has no symptom: the
process starts, serves, and quietly proposes nothing until somebody notices a
year of missing rent." `RECURRENCE_SCHEDULER=yes` read as falsy is a deployment
that looks healthy and proposes nothing. `TRUST_PROXY` (`config.ts:184-187`) and
`SMTP_SSL` (`config.ts:314-317`) follow the same pattern.

The same argument applies to any closed set, not only booleans. `NODE_ENV` is
parsed against three values and refuses a fourth (`config.ts:159-163`), because
`NODE_ENV=Production` compared against the string `production` had no symptom
either: no setup code, no rate limiting, no secure cookies.

**House.** An integer is bounded, and both the bound and its reason are
documented. Every ceiling in `config-limits.ts` exists to stop something filling
the database or the process.

**House.** A list is comma-separated, each entry trimmed, and empty entries are
skipped rather than refused. `parseRegistrationRule`
(`src/server/config.ts:374-409`) is the model: split, trim, lowercase, drop the
blanks, then validate what is left with a message naming the bad entry.

*Checked by:* `tests/config.test.ts:118-134`, which asserts that
`RECURRENCE_SCHEDULER=yes`, `TRUST_PROXY=yes`, `LOG_LEVEL=loud`, `AUTH_MODE=sso`
and `NODE_ENV=Prod` each throw with the variable named.
`tests/mail-settings.test.ts` covers `SMTP_SSL`.

### Secrets and settings

**Contested.** Twelve-Factor requires config in the environment and offers the
litmus test of whether the codebase could be open-sourced at any moment without
compromising a credential. OWASP's Secrets Management guidance says the opposite
for the secret half: environment variables "are generally accessible to all
processes and may be included in logs or system dumps ... therefore not
recommended unless the other methods are not possible". Both are right about
different things. In a container the OWASP objection is concrete: `kubectl
describe pod` shows them, `kubectl exec -- env` dumps them, and a crash dump can
contain them.

**What this product picked:** environment variables for everything, with a
`_FILE` escape hatch for secrets. `NAME_FILE` names a file whose contents are the
value. It applies to `AUTH_SECRET`, `DATABASE_URL`, `SMTP_PASSWORD` and
`GOOGLE_CLIENT_SECRET`, and to no setting. **That line is the definition of the
difference between a secret and a setting**: if it has a `_FILE` form it is a
secret.

Exactly one of `NAME` and `NAME_FILE` may be set. Both set refuses to start,
because a precedence rule means somebody eventually changes a value that has no
effect.

The `_FILE` suffix is not a cross-image convention. The postgres Docker Official
Image documents it as a feature of its own entrypoint. Adopting it follows a
widely copied idiom, which is weaker justification than a specification and is
still adequate.

This does not conflict with `AGENTS.md`: "PostgreSQL is the only persistent
dependency. Do not add Redis, SQLite, an object store, sidecar, or
writable-volume requirement." A mounted Docker secret, a Kubernetes secret volume
or a systemd credential is read-only and platform-provided. It is not a volume
this application requires in order to work, and a deployment that sets none of
them is unaffected.

**Work to do: none of this exists.** The string `_FILE` appears nowhere in `src/`
or `deploy/`. The rule is written here as the target; the code has one form only.

**House, and stronger than the litmus test.** `config.ts:56-68` holds a
`publicAuthSecrets` set and refuses an `AUTH_SECRET` matching any value this
project has ever published, including whatever `.env.example` last carried, with
the message "AUTH_SECRET is a published placeholder. Generate one, for example
with `openssl rand -base64 32`." Length alone cannot tell a real secret from a
documented one. This is the twelve-factor litmus test enforced rather than
stated, and it is the pattern to copy the next time a placeholder ships.

*Checked by:* `tests/config.test.ts:189-215` ("refuses the published placeholder
secret %s in production"), over two of the three entries in the set. *Not
checked:* that the set covers whatever `.env.example` currently carries, which is
the half that has to be extended by hand every time the example file changes.

### Validating at startup

**House.** Configuration is validated in full at startup, and invalid
configuration refuses to start. No specification requires this. The argument is
operational: an orchestrator surfaces a process that will not start, with restart
backoff and a log line, and does not surface a healthy process that is quietly
misconfigured.

**The one named exception is the mail transport.** `checkMailTransport` logs a
long, specific error and continues. State the rule and the exception in the same
breath, because an unstated exception reads as a bug.

**Where the code disagrees.** There is a second exception that is not named as
one. `boundedEnvironmentInteger` (`src/server/config-limits.ts:23-34`) returns
the default whenever the value is not a safe integer in range, so `CSV_MAX_ROWS`,
`CSV_MAX_BYTES`, `RECURRENCE_TICK_SECONDS`, `RECURRENCE_CATCH_UP_LIMIT` and
`RECURRENCE_CLAIM_LIMIT` all fall back silently. `configuredDatabasePoolSize`
(`src/server/config-limits.ts:46-62`) throws instead. Worse, those five are read
lazily at the call site rather than at startup: `configuredCsvMaxRows()` runs
inside an import (`src/server/services/import-export.ts:684`), so a typo in
`CSV_MAX_ROWS` is never surfaced at startup and never surfaced at all.
`DATABASE_POOL_SIZE` is the one to copy: it throws, and because
`reconcileArchivedAccountClosings()` at `src/server/index.ts:27` queries before
`serve()`, the first `getPool()` (`src/server/db/client.ts:16`) reaches it during
startup, so a bad value throws there rather than on the first import.

The fallback is deliberate and documented (`docs/deployment.md:58-63`), and the
argument for it is that a typo in a tuning number should not take the ledger
down. The argument against it is the one `config.ts:188-190` already makes about
`RECURRENCE_SCHEDULER`: the wrong setting is otherwise silent, and
`CSV_MAX_ROWS=1O000` silently becoming 10,000 is exactly that.

**The rule this guide sets is refuse, and the code disagrees with it on five
variables.** Either the parsing changes, or `docs/deployment.md:58-63` becomes a
recorded exception with the reasoning in it rather than a description.

*Checked by:* `tests/config.test.ts` for the strict half,
`tests/config-limits.test.ts` for the bounded half ("accepts positive bounded
integer overrides", "validates the PostgreSQL pool size before creating the
pool"). `tests/config-limits.test.ts:32-41` ("falls back safely for invalid
override %s", over `NaN`, `0`, `-1`, `1.5` and a number past the ceiling) pins
the silent fallback, so adopting the refuse rule means changing that test and
not only the parser. Nothing asserts that a bad bounded value is reported
anywhere.

### Documenting a variable

**House, seven parts.** A variable is documented when it names: what it is; its
type or accepted values; its default; whether and when it is required; what
changes when it changes; its ceiling and why that ceiling exists; and what
happens when it is set wrong.

There is no specification for this. `docs/deployment.md` delivers the first five
for every variable. The sixth is given wherever there is a ceiling
(`docs/deployment.md:51-56`, of which `CSV_MAX_ROWS` at `:52` is the fullest: the
cap matches the bulk-action cap so an import always fits one review-queue
action). The seventh appears for `TRUST_PROXY` (`:48`, "getting it wrong costs
per-visitor rate limiting"), `RECURRENCE_SCHEDULER` (`:53`, "A value other than
`true` or `false` refuses to start, because the wrong setting is otherwise
silent") and the five bounded integers (`:58-63`), and nowhere else.
`SB_MAX_UPLOAD_SIZE` (`deploy/docker/frontend.Dockerfile:36-39`) models the
sixth best of all, because it gives the arithmetic so an operator can compute
their own value rather than copy a number.

*Not checked mechanically.* A test can assert that every variable has a row; it
cannot assert that the row answers the seventh question.

### `.env.example`

**House.** Required variables uncommented, with a real-shaped value that does not
work. Optional variables commented out, so uncommenting one enables it. Secrets
present but empty, with the generation command in the comment above. A comment on
any variable whose wrong setting is silent. Grouped in the order an operator
meets them.

**There are two example files and the rules govern both.** `.env.example` at the
root serves the single container; `deploy/compose/.env.example` serves
`compose.distributed.yml` and is the one the compose header tells an operator to
copy. The root file does all five. The compose file does not: `SMTP_HOST=`,
`ALLOWED_EMAILS=` and `GOOGLE_CLIENT_ID=` ship present and empty rather than
commented out, and `POSTGRES_PASSWORD` appears in no `docs/deployment.md` table.
**Work to do:** bring it under the commented-out convention, or record the
difference with its reason.

The root file does all five. `AUTH_SECRET=` is empty with `openssl rand
-base64 32` above it (`.env.example:7-10`), `RECURRENCE_SCHEDULER` carries its
own silence warning (`.env.example:56-60`), and the mail block is commented out
as a group (`.env.example:26-39`).

It also does one thing beyond the rule, worth generalising: it warns about
`NODE_ENV` (`.env.example:1-4`), a variable the images set and the operator is
not meant to touch, because unset reads as development "with nothing said about
it". **A silent hazard gets a comment even when the variable is not one you are
meant to set.**

**House, and keyed to the command rather than stated once.** Two different
parsers read `.env` in this repository and they disagree about quoting.

| Path | Parser | Rule |
| --- | --- | --- |
| `docker run --env-file .env` (`README.md:117`, `docs/deployment.md:306`) | Docker CLI | `NAME=value`, `#` only at line start, values passed as-is. **No interpolation and no quote processing. Do not quote.** Quoting an `SMTP_PASSWORD` here puts the quote marks in the password. |
| Compose `.env` and `env_file` (`deploy/compose/compose.distributed.yml`) | Compose | Interpolation applies to unquoted and double-quoted values, `${VAR:-default}` and friends work. **Single-quote a value containing `$`.** |

The intuitive advice, "quote your secrets in `.env`", is wrong on the path this
project documents first. **Work to do:** the warning belongs beside
`SMTP_PASSWORD` in `.env.example`, not in a general note about quoting, and it is
not there today.

**House.** Every variable in `.env.example` appears in the `docs/deployment.md`
tables and every variable in those tables appears in `.env.example`. A drifted
example file is worse than no example file, because it is believed.

**Six variables break the correspondence today**, which is why this is a rule
rather than a description. In `.env.example` and in no table: `NODE_ENV`
(`.env.example:4`), `GOOGLE_CLIENT_ID` (`:23`) and `GOOGLE_CLIENT_SECRET`
(`:24`), all three of which `docs/deployment.md` mentions only in prose
(`docs/deployment.md:26`, `:93`). In the table at `docs/deployment.md:403-405`
and in no `.env.example`:
`SB_API_ORIGIN`, `SB_FRONTEND_PORT` and `SB_MAX_UPLOAD_SIZE`, which are the
frontend image's and belong in the compose example if anywhere.

**House.** Renaming or removing a variable is a breaking change for every
operator, whatever a `0.y.z` version number formally permits. See the version
question under the container.

*Not checked mechanically.* The `.env.example` to `docs/deployment.md`
correspondence, in both directions, is the single easiest structural test this
guide names and it does not exist. Neither does a check that `config.ts` and the
deployment table agree on defaults.

---

## The container

### Labels

**Binding (OCI Image Specification, `annotations.md`).** Labels use the
pre-defined `org.opencontainers.image.*` keys, which supersede the older
`org.label-schema` ones. The prefix is reserved, and a consumer must not error on
an unknown key.

**House.** A label that varies per build comes from a build argument set in CI,
never a literal. The `Dockerfile:22-24` does this for `APP_VERSION`, with the
comment saying the release workflow passes the tag being published "so the image
reports the version it actually contains".

All four images set `title`, `description`, `version`, `licenses` and `source`
(`Dockerfile:25-29`, `deploy/docker/server.Dockerfile:30-34`,
`deploy/docker/scheduler.Dockerfile:30-34`,
`deploy/docker/frontend.Dockerfile:20-24`). `AGPL-3.0-only` is a valid SPDX
expression, and `.github/workflows/release.yml:210-218` restates it rather than
letting `metadata-action` derive the deprecated `AGPL-3.0` from GitHub's
detection, with the reason in a comment: v0.1.0 shipped carrying the derived one.

**Work to do.** The Dockerfiles set five labels, so a hand-built image carries
only those. An image built by the release job carries more:
`.github/workflows/release.yml:203-220` runs `docker/metadata-action` and passes
its label output to the build, and that action's default set includes
`org.opencontainers.image.created`, `revision`, `documentation`, `source` and
`url`. So `revision`, `created` and `documentation` are absent from a hand-built
image and present on a published one, and the fix is to set them in the
Dockerfiles as `APP_VERSION` already is.

Absent from every image: `base.name` and `base.digest`. They matter here
specifically because every image pins its base by tag (`node:24-alpine`,
`nginxinc/nginx-unprivileged:1.29-alpine`), so two builds of `0.1.5` can contain
different base layers with nothing recording which.

**House.** State which labels are guaranteed. Only the five in the Dockerfiles
are, because a hand-built image gets no workflow labels at all, and an image
built by the release job carries whatever `metadata-action` adds on top.

*Checked by:* `tests/dockerfile.test.ts` ("labels the image with its product and
the version being built") asserts `title`, the `${APP_VERSION}` interpolation,
and that `ARG APP_VERSION` matches `package.json`. The decomposed-image test
asserts the `ARG` on the other three but not their labels. Nothing asserts
`licenses` or `source` anywhere.

### Health checks

**House.** Liveness checks the process. Readiness checks everything a request
needs and nothing a request does not.

`/health/live` returns 200 unconditionally. `/health/ready` runs `select 1` and
returns 200 or 503 (`src/server/api.ts:226-234`, and the same pair on the
scheduler at `src/server/scheduler.ts:19-28`). Both are registered above every
auth middleware and neither is authenticated.

The rule that generalises best is already written in `docs/deployment.md:497`: "A
process with the scheduler switched off is not an unhealthy one." A readiness
check that fails because an optional subsystem is off takes a working server out
of rotation. Readiness must not consult mail, and it must not consult the
scheduler.

**Binding.** `AGENTS.md`: "Startup must remain the only production migration path.
Keep migrations safe under the advisory lock and fail readiness on migration
failure."

**House, and this is the interaction most container guides miss: startup, not
shutdown, is the slow half.** Migrations run at startup under advisory lock
724202607 and `runMigrations()` is awaited before `serve()`
(`src/server/index.ts:26,68`; `src/server/scheduler.ts:36,37`), so readiness
cannot open before they finish. The 0.1.5 notes record that the payee index
"takes a moment to build while the container starts, before it opens readiness"
(`docs/upgrades.md:23`). So the generous number is `--start-period`, currently
20s (`Dockerfile:40`), plus a Kubernetes startup probe. Not the shutdown
deadline.

**Where the doc disagrees with the code.** `docs/deployment.md:493-495` says
`/health/ready` "says configuration, the database, and the migrations have all
succeeded, and stays closed until they have". Readiness itself knows nothing
about configuration or migrations; the guarantee is purely ordering, and nothing
listens at all until migrations return. The difference matters to an operator
designing alerting: a migration that succeeded on an older image leaves readiness
green against a schema this build does not expect. **Work to do:** narrow the
sentence, or give readiness a real check by comparing the applied migration tag
against `drizzle/meta/_journal.json`.

**House.** A healthcheck reads its port from the environment rather than
hardcoding one. All four images do: the three Node images read `PORT`, the
frontend reads `SB_FRONTEND_PORT`. The frontend also probes `/` rather than
`/health`, deliberately, because `/health` is proxied to the API and a frontend
healthcheck should not go red because the API did
(`deploy/docker/frontend.Dockerfile:54-55`).

*Checked by:* `tests/dockerfile.test.ts` ("uses the configured PORT for its
readiness healthcheck"). The doc-versus-code readiness claim is checked by
nothing.

### Signals and shutdown

**House, and already correct in the unusual half.** Exec-form `CMD`, so the
process is PID 1 and receives signals. Shell form starts the entrypoint under
`/bin/sh -c`, which does not pass them; a container that never receives SIGTERM
is killed at the end of the grace period every time.

**House.** The shutdown deadline is strictly shorter than the orchestrator's
grace period, and a second signal exits immediately.
`src/server/server-lifecycle.ts` implements both: `DEFAULT_SHUTDOWN_DEADLINE_MS`
is 10,000 (`src/server/server-lifecycle.ts:1`), and a signal arriving while
draining forces the exit (`:92-97`),
which is the case most implementations miss and the one that makes Ctrl-C twice
behave the way a person expects. The compose file sets
`stop_grace_period: 30s` with a comment saying it is "Longer than the 10s drain
the process gives itself on SIGTERM (DEFAULT_SHUTDOWN_DEADLINE_MS), so it is not
killed mid-drain" (`deploy/compose/compose.distributed.yml:137-139`), and the
chart sets `terminationGracePeriodSeconds: 30`
(`deploy/helm/simple-balance/values.yaml:217`).

**Settled.** Both documented `docker run` commands now pass
`--stop-timeout 30` (`README.md:115-119`, `docs/deployment.md:302-308`). Docker's
default is 10 seconds, exactly the drain deadline, so the forced exit and
SIGKILL used to land in the same instant and the drain never got to finish.

*Checked by:* `tests/server-lifecycle.test.ts`, four cases covering the drain,
the deadline, the second signal, and never exiting twice. The relationship
between the deadline and any grace period is checked by nothing.

### Hardening

**House (OWASP Docker Security Cheat Sheet, rules 2, 3, 4 and 8).** Non-root
user, read-only root filesystem, all capabilities dropped, no new privileges.

Three of the four are everywhere. `USER node` in the Node images and `USER 101`
in the frontend (`Dockerfile:38`, `deploy/docker/frontend.Dockerfile:31`). The
documented run command passes `--read-only --tmpfs
/tmp:rw,noexec,nosuid,size=16m`. The chart sets `runAsNonRoot`,
`runAsUser: 1000`, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` and
`capabilities.drop: [ALL]` (`deploy/helm/simple-balance/values.yaml:199-213`).

**Work to do, and it is the clearest concrete gap on this surface.** The
Kubernetes equivalents are set in the chart, spelled
`allowPrivilegeEscalation: false` and `capabilities.drop: [ALL]`
(`deploy/helm/simple-balance/values.yaml:199-213`). The Docker flags themselves
exist in exactly one place in this repository and it is not a deployment path:
`scripts/ralph/verify-in-sandbox.sh:172-173` and `:306-307`, asserted by
`tests/ralph-security.test.ts:49-50`. Neither
`--security-opt=no-new-privileges` nor `--cap-drop=ALL` reaches the documented
`docker run` or `deploy/compose/compose.distributed.yml`. Add both to both. A
Node HTTP server binding port 3000 as a non-root user needs no capabilities at
all. **The documented run command is the security surface most people copy**,
which is exactly why it is where this belongs.

**House.** Every install in an image resolves from a committed lockfile, and the
runtime stage carries production dependencies only.

*Checked by:* `tests/dockerfile.test.ts` for the lockfile rule ("Every install
must resolve from a committed lockfile, so the image cannot drift between
builds"), for the Alpine patch ordering relative to `USER node`, and for the
frontend's step up to root and back down to 101. Nothing greps the documented run
command for the hardening flags, which is the test named in the research and it
is a grep.

### One process, one database

**Binding.** `AGENTS.md`: "PostgreSQL is the only persistent dependency. Do not
add Redis, SQLite, an object store, sidecar, or writable-volume requirement."

**House.** The image makes no outbound connection nobody configured. Three exist,
each behind a setting: PostgreSQL (`DATABASE_URL`), SMTP (only when `SMTP_HOST`
and `MAIL_FROM` are both set), and Google's OAuth endpoints (only when
`AUTH_MODE` includes `google`). No telemetry, no update check, no CDN, no font
host. `src/server` contains no `fetch(` call at all, and the browser bundle is
served under a CSP of `default-src 'self'`
(`deploy/docker/nginx-security-headers.conf:10`).

This is worth stating as a promise rather than leaving as a property, because it
is the thing an operator running a finance product on their own hardware most
wants to know and cannot easily verify.

**House, six obligations to an operator.** A documented backup and restore path
for the one stateful component; a statement of what is disposable; a
forward-only upgrade path; health endpoints that distinguish starting from
broken; logs to stdout; and configuration that refuses rather than misbehaves.

All six are covered. `docs/upgrades.md:3-4` states disposability outright:
"Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one." Backup and restore is
`pg_dump --format=custom` and `pg_restore`, under "Backups" in
`docs/deployment.md`, and the reason it must be written down even though it is
two commands is that an operator who cannot find the sentence assumes there is
more to it. The sixth is covered, with the five-variable exception recorded above.

*Not checked mechanically.* "No unconfigured outbound connection" would be a grep
over `src/server` for network calls with an allow-list, which does not exist.

### What the version number is about

**House.** The scheme and what counts as a breaking change are settled in
[`writing.md`](writing.md#versioning), which owns them for the whole set: four
surfaces can break, and the deployment is one of them.

The operations-specific consequence is the one worth stating here. **A
configuration variable renamed or removed is a breaking release, whatever
`0.y.z` formally permits**, because the operator's `.env` is the thing that stops
working. That is why the freeze on the unprefixed names above is a real cost
rather than a shrug, and it is the whole reason this guide takes a position on
naming at all.

*Checked by:* `tests/version.test.ts`, which pins every one of the fifteen
locations `npm run set-version` writes, and also checks that the script mentions
each path, so a location the script forgets fails the suite. Nothing checks that
a renamed variable moved the version.

---

## What is checked, and what is not

| Rule | Check |
| --- | --- |
| Booleans and closed sets refuse an unrecognised value, naming the variable | `tests/config.test.ts:118-134` |
| `APP_BASE_URL` is an exact origin, HTTPS off loopback | `tests/config.test.ts` |
| A non-production process with a real `APP_BASE_URL` refuses to start | `tests/config.test.ts` |
| Bounded integers accept their range; pool size is validated before the pool exists | `tests/config-limits.test.ts` |
| Half a mail configuration refuses; ports, address forms, credentials pair | `tests/mail-settings.test.ts` |
| A password is never sent to a relay that refuses to encrypt | `tests/mail-settings.test.ts` |
| Healthcheck reads `PORT` | `tests/dockerfile.test.ts` |
| `title` and a build-argument `version` label | `tests/dockerfile.test.ts` |
| Alpine patch applied before dropping to `USER node`; frontend returns to 101 | `tests/dockerfile.test.ts` |
| Lockfile-only installs, production-only runtime, both lockfiles resolve alike | `tests/dockerfile.test.ts` |
| Entrypoints name files the compiler emits; nginx proxies every API prefix | `tests/dockerfile.test.ts` |
| Drain once, force-exit on deadline, force-exit on a second signal | `tests/server-lifecycle.test.ts` |
| The version reaches all fifteen places | `tests/version.test.ts` |
| The published placeholder secrets are refused in production | `tests/config.test.ts:189-215` |
| The template reminder's subject is exactly `Reminder: <name>` | `tests/integration/notifications.integration.test.ts:216` |

Not checked mechanically, ranked by how cheap the check would be:

1. `.env.example` and the `docs/deployment.md` tables name the same variables,
   both directions, over both example files. The easiest, the most likely to
   drift, and already failing on six variables.
2. `config.ts` defaults and the deployment table agree.
3. `Auto-Submitted: auto-generated` is present on every message
   `src/server/mail.ts` can send. One assertion, and it currently fails.
4. The recurrence subject's fixed part precedes its interpolated part, and the
   interpolated part is capped. The template subject is already pinned exactly.
5. The documented run commands in `README.md` and `docs/deployment.md` carry the
   hardening flags. A grep, protecting the thing people copy.
6. `licenses`, `source`, `revision` and `created` labels on all four images.
7. No unconfigured outbound network call from `src/server`.
8. A mail log line never contains a subject.
9. `oneLine` refuses CR and LF, which is what closes header injection.

Review only, because no test can judge them:

- Whether a message's content sits in the right tier. What makes a sentence a
  disclosure is a judgement about a reader.
- Whether a variable's documentation answers the seventh question, "what happens
  when it is wrong", in words an operator can act on.
- Whether the five-variable silent fallback is a defect or an exception. It is
  recorded either way; somebody has to decide.

A rule in neither list is a rule nobody is responsible for, and that is a defect
in this guide rather than in the code.

---

## Work to do

Collected, with the file and line, so this section is a backlog rather than a
mood.

| What | Where |
| --- | --- |
| No `Auto-Submitted` header on any message | `src/server/mail.ts:111-119` |
| Recurrence subject leads with up to 120 characters of user text | `src/server/mail.ts:153-156`, `src/shared/domain.ts:1790` |
| A failed send logs the subject, which is a user-authored label, alongside an error carrying the recipient address | `src/server/mail.ts:75-81`, against the policy at `src/server/services/account-deletion.ts:178-185` |
| SPF, DKIM, DMARC and PTR appear nowhere an operator reads | `docs/deployment.md` "Sending mail", `README.md`, `.env.example`, `deploy/` |
| Five bounded integers fall back silently and are read lazily rather than at startup; `DATABASE_POOL_SIZE` throws and is reached during startup | `src/server/config-limits.ts:23-34,52-66`; `src/server/services/import-export.ts:684`; `src/server/index.ts:27`; documented at `docs/deployment.md:58-63` |
| Six variables break the `.env.example` to `docs/deployment.md` correspondence, and `deploy/compose/.env.example` ships three optional variables uncommented | `.env.example:4,23,24`; `docs/deployment.md:403-405`; `deploy/compose/.env.example` |
| No `_FILE` support for any secret | `src/server/config.ts` |
| No quoting warning beside `SMTP_PASSWORD`, and two parsers read `.env` in this repository | `.env.example:39` |
| Readiness is described as checking configuration and migrations; it runs `select 1` | `docs/deployment.md:493-495` against `src/server/api.ts:226-234` |
| The documented `docker run` has no `--stop-timeout`, so the 10s drain deadline equals Docker's 10s default grace | `README.md:115-118`, `docs/deployment.md:302-307` |
| No `--security-opt=no-new-privileges` or `--cap-drop=ALL` on any deployment path; the Helm chart sets the Kubernetes equivalents and the only literal flags are in a sandbox script | `README.md:115-118`, `docs/deployment.md:302-307`, `deploy/compose/compose.distributed.yml`, against `deploy/helm/simple-balance/values.yaml:199-213` and `scripts/ralph/verify-in-sandbox.sh:172-173` |
| `revision`, `created` and `documentation` absent from a hand-built image; `base.name` and `base.digest` absent from every image, with all bases pinned by tag | `Dockerfile:25-29` and the three in `deploy/docker/`, against `.github/workflows/release.yml:203-220` |
| The scheduler entrypoint runs none of the startup checks the API entrypoint runs, including `checkMailTransport`, and it is the process that sends every scheduled message | `src/server/scheduler.ts:30-48` against `src/server/index.ts:13-63` |
