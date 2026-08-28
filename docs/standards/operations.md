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
(`src/server/mail.ts:229-250`) names the occurrence dates and stops, and the
docstring above it says why: "a proposed row is not money that has moved" and "a
total in a mail reads like a statement". `templateReminderMessage`
(`src/server/mail.ts:259-278`) names the template and the date and carries no
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
this product sends is `text` only (`src/server/mail.ts:153-168`). The Email
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

**Binding (RFC 3834 §5.2, SHOULD), and met.** Every message this
product sends is machine-generated and must carry
`Auto-Submitted: auto-generated`, which §5.2 says "SHOULD be used on messages
generated by automatic (often periodic) processes". What that buys is in §2:
automatic responses "SHOULD NOT be issued in response to any message which
contains an Auto-Submitted header field ... where that field has any value other
than 'no'". Without it a vacation responder or a ticketing system may reply to a
password reset, and the reply lands on `MAIL_FROM` or `MAIL_REPLY_TO`.
`sendMail` (`src/server/mail.ts:142-177`) sets it on every message.

*Checked by:* `tests/mail-headers.test.ts`.

**House, already correct.** `Reply-To` is set only when replies should go
somewhere other than `From` (`src/server/mail.ts:155-157`), which is what RFC
5322 §3.6.2 assumes when it says replies go to `From` in the header's absence.
The common mistake is a no-reply `From` with no `Reply-To`, which sends a
person's question nowhere.

**House.** No `List-Unsubscribe` and no `List-Unsubscribe-Post`. RFC 8058
one-click unsubscribe requires both headers to be covered by a DKIM signature
that this application does not produce, the relay does. It binds bulk senders,
and a self-hosted ledger sending a handful of reminders is not one. What RFC
8058 is *for* is met another way, below.

*Checked by:* `tests/mail-headers.test.ts`, one assertion over `sendMail`, which
is where the header is set for every message rather than in each builder.

### Subject lines

**House.** The fixed, identifying part comes first, and any interpolated user
text is capped.

No source establishes a subject-line rule for transactional mail. The length
advice that circulates is vendor open-rate data about campaign mail, which is a
different medium with a different reader. This is a house rule and the reason is
truncation: a mail client shows the first N characters, so whatever is first is
what the person reads in the list.

Both message builders follow it. `Reminder: ${templateName}`
(`src/server/mail.ts:267`) and `Staged: N rows from ${recurrenceName}` (`:240`)
each lead with the fixed word, and both pass the name through `forSubject`
(`src/server/mail.ts:199-206`), which cuts it to 60 code points and appends an
ellipsis. A recurrence or template name may be 120 characters
(`recurrenceCreateSchema` and `transactionTemplateCreateSchema`, both in
`src/shared/domain.ts`), roughly twice what a client's message list shows, so
the cut is the difference between a subject whose meaning survives truncation
and one whose meaning is what got truncated. The count precedes the name for the
same reason: it is fixed text, so a narrow list still shows it. The slice is by
code point rather than by UTF-16 unit, so it cannot land between the halves of a
surrogate pair. RFC 5322
§2.1.1's 78-character SHOULD is not the argument: it is a rule about transmitted
line length, which a mailer satisfies by folding, and the subject stays well
inside the 998-character MUST either way. This is legibility rather than
conformance.

**Binding, and already met by accident of the schema.** A subject cannot contain
CR or LF. Recurrence and template names go through `oneLine`
(`src/shared/domain.ts:252-258`), which refuses every character
from U+0000 to U+001F and U+007F, so header injection through a subject is
closed at the schema rather than at the mailer. Worth writing down precisely because the
defence is nowhere near the code it defends.

*Checked by:* `tests/mail-subjects.test.ts`, which pins both fixed parts and the
cap, including that a name of astral-plane characters comes back whole rather
than cut through a surrogate pair.
`tests/integration/notifications.integration.test.ts:216` pins the template
subject exactly, `Reminder: Quarterly tax`, against the code that sends it.
Nothing asserts that `oneLine` refuses a newline.

### What goes in the log when a message fails

**House.** A log line about a message names what the message was, never the
subject.

One policy about personal data in log lines, in one process.
`account-deletion.ts:179-186` logs counts and no address, with the comment
"Deliberately without the address: they asked to be gone." `sendMail` follows it:
every `Message` carries `about`, a fixed phrase naming the kind of message
(`src/server/mail.ts:97-107`), and that phrase is what the log line carries
(`:174-177`). The phrase comes from the builder, so a caller that spreads one
gets it without deciding anything, and it names the row rather than the kind:
both scheduled senders set `about` after the spread, to
`recurrence proposal <id>` and `template reminder <id>`. An id is neither
private nor ambiguous, where "a recurrence proposal notice could not be sent" is
no help at all on a deployment with several. The name is deliberately not in it:
that is somebody's own text and a log line is not the place for it.

The nodemailer error is narrowed rather than passed whole, for the same reason.
`envelope` and `rejected` each hold the recipient's address, and for a password
reset that address is whatever a stranger typed into a form this product
deliberately answers identically either way. `smtpFailure`
(`src/server/mail.ts:123-131`) keeps `code`, `command`, `responseCode` and
`response`, which is what tells an operator whether the relay is unreachable,
refusing their credentials, or refusing this one message. `response` is the
relay's own sentence and may quote the address inside it; that is the relay
talking, and an operator who cannot read it has to reproduce the failure by
hand. `src/server/api.ts:266-272` narrows a Drizzle error the same way for a
harder reason: its message is built from the failing SQL and its bound
parameters, one of which is an OAuth access token.

*Checked by:* `tests/mail-logging.test.ts`, which makes the transport throw and
asserts the log line names the message and not the subject, and that what goes
beside it carries no `envelope` and no `rejected`.

### Password reset and verification

**House, and already met.** The reset satisfies the OWASP Forgot Password
guidance in the ways that matter here: a single-use token whose one-hour expiry
is stated in the body (`src/server/mail.ts:210-220`), no password in the
message, and an identical response whether or not the account exists, which is
the whole reason `sendMail` returns `false` rather than throwing
(`src/server/mail.ts:133-141`).

**House, and this is the constraint to state as a defence rather than as
strictness.** The URL in a reset message is built from `APP_BASE_URL`, which
`config.ts:15-49` validates as an exact HTTP(S) origin with no credentials, path,
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
`requireTLS: !mail.ssl && authenticated` (`src/server/mail.ts:35`) makes the
STARTTLS upgrade compulsory whenever there is a password to protect and optional
when there is not, so credentials never cross an unencrypted link but a relay on
a trusted network that speaks no TLS still works.

`docs/deployment.md` names the four an operator has to publish under "Getting
mail delivered", inside "Sending mail", with the fifth already handled by the
transport described above: what each of SPF, DKIM, DMARC and PTR is and who sets
it, that a
hosted relay handles most of them and its own setup page is the one to follow,
Google's requirements for every sender, and the order to check them in when
reminders land in spam. `README.md` and `.env.example` point at that section
rather than repeating it, because a duplicated list is a list that drifts.
`deploy/` names none of them on purpose: the compose, Helm and Pulumi recipes
stand containers up, and a DNS record for a domain is not something any of them
configures. Neither does the operator-facing text name an RFC. The numbers belong
here, where the argument is; an operator standing a deployment up needs the
record and the registrar, and a citation they cannot check is worse than none.

*Checked by:* `tests/mail-settings.test.ts` for the transport matrix, including
"will not send a password to a relay that refuses to encrypt", and
`tests/deployment-docs.test.ts` for the documentation, which proves the four
names and the two pointers are present and that no RFC number has crept into the
operator's copy. Whether the section answers an operator's question is review,
and presence is not usefulness.

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
(`src/server/mail.ts:69-86`) opens a connection at startup so a wrong address is
found by the operator rather than by somebody locked out, and returns `false`
rather than throwing, "because the ledger is the thing people came for, and it
works whether or not mail does; what must not happen is failing in silence".
This is the one named exception to fail-fast configuration, below.

**Settled, and the process that sends was the one not doing it.** Both
entrypoints check the transport at startup now. `src/server/index.ts:35` always
did; `src/server/scheduler.ts:68-75` does as of this change, and it has the
stronger claim on the check: it sends every scheduled message, and nobody is
waiting for one. A person locked out of a password reset complains within the
hour, and a reminder that never arrives is noticed by nobody at all. A scheduler
with no mail configured says that too, in one line
(`src/server/scheduler.ts:76-89`), because a container that was never handed the
SMTP settings and one whose relay answers are indistinguishable in a log that
says nothing — and a split deployment assembled by hand is exactly where that
happens, since the chart and the compose file both give the scheduler the whole
of the API's environment and a hand-built one gives it what somebody remembered.

What it deliberately does not copy from the API is written above its own
`main()` (`src/server/scheduler.ts:37-50`). The archived-account reconciliation
is a repair of somebody's postings rather than anything the schedule needs, and
the API image runs in every deployment that runs this one; the `TRUST_PROXY`
notice and the first-run setup code belong to a sign-in this process does not
serve. Two processes with different jobs are not made equal by running the same
list, and an omission nobody wrote down reads as an oversight.

*Checked by:* `tests/mail-settings.test.ts` ("is off when nothing is set",
"refuses half a configuration, in either direction"), and
`tests/scheduler-startup.test.ts` for the entrypoint: started against a relay
that refuses it says so and goes on proposing, against one that answers it names
the address it will send as, with no mail server at all it says it will send
none, and shutting it down closes the connection the check opened. The
degradation itself is covered by the recurrence and notification suites rather
than here.

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
`SB_MAX_UPLOAD_SIZE`; `deploy/docker/frontend.Dockerfile:49-54`). `AUTH_MODE`
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
`config.ts:217-219` gives the reason: "A misspelling here has no symptom: the
process starts, serves, and quietly proposes nothing until somebody notices a
year of missing rent." `RECURRENCE_SCHEDULER=yes` read as falsy is a deployment
that looks healthy and proposes nothing. `TRUST_PROXY` (`config.ts:213-216`) and
`SMTP_SSL` (`config.ts:380-383`) follow the same pattern.

The same argument applies to any closed set, not only booleans. `NODE_ENV` is
parsed against three values and refuses a fourth (`config.ts:188-192`), because
`NODE_ENV=Production` compared against the string `production` had no symptom
either: no setup code, no rate limiting, no secure cookies.

**House.** An integer is bounded, and both the bound and its reason are
documented. Every ceiling in `config-limits.ts` exists to stop something filling
the database or the process.

**House.** A list is comma-separated, each entry trimmed, and empty entries are
skipped rather than refused. `parseRegistrationRule`
(`src/server/config.ts:440-475`) is the model: split, trim, lowercase, drop the
blanks, then validate what is left with a message naming the bad entry.

*Checked by:* `tests/config.test.ts:145-166`, which asserts that
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
value. It applies to `AUTH_SECRET`, `DATABASE_URL`, `DIRECT_DATABASE_URL`,
`SMTP_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `SETUP_TOKEN` and `METRICS_TOKEN`, and
to no setting.
**That line is the definition of the difference between a secret and a
setting**: if it has a `_FILE` form it is a secret.

Set one of `NAME` and `NAME_FILE`, never both. Both set warns and uses `NAME`,
naming the file being ignored, because a change to that file will look like it
worked and will not have. It refused to start for a while, which was the better
rule read in isolation and the wrong one across an upgrade: `NAME` winning is
what happened before `NAME_FILE` did anything at all, so a deployment that had
both set kept the value it was already using. A `NAME_FILE` that cannot be read,
or whose file is empty, still refuses to start rather than resolving to
nothing — nobody was relying on that, because nothing worked.

**That includes `SMTP_PASSWORD_FILE`, and it is worth saying why it does not
break the mail invariant.** `AGENTS.md` says everything needing mail degrades
rather than breaks, and it says what that means: a deployment with **no**
`SMTP_HOST` offers no password reset and sends no reminder. Absence degrades.
This is not absence — it is a deployment that asked for mail and pointed at a
file that is not there, which is the same class of mistake as setting
`SMTP_USERNAME` with no `SMTP_PASSWORD`, and that already refuses. A secret that
silently resolves to the empty string would authenticate to the relay as nobody
and fail every send at the far end, where the only symptom is a log line.

The cost is real and belongs beside the rule: a mounted secret that fails to
appear during a rotation takes the process down rather than the mail. That is
the intended trade, because a ledger that will not start is a problem somebody
sees within a minute, and mail that silently stops is one nobody sees until they
needed a password reset. An empty `NAME` does not count as set. `.env.example`
ships a blank `AUTH_SECRET=` and `deploy/compose/compose.distributed.yml` ships
a `SETUP_TOKEN` defaulted to the empty string, so refusing those would break a
deployment that works today.

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

**Settled.** `resolveFileBackedSecrets` and `readSecret`
(`src/server/config-files.ts`) read `NAME_FILE` for those seven names.
`SETUP_TOKEN` and `DIRECT_DATABASE_URL` are on the list because the litmus runs
both ways: the first is the code that claims an instance and the second carries
a password, so a set of four would have been this product quietly calling them
settings.

The resolved values are held in a module-level map and handed out by
`readSecret`, and are never written back into `process.env`. Two reasons, and
the second is the load-bearing one. A Node diagnostic report serialises
`process.env`, so a value that never enters it cannot appear in the dump this
section exists to worry about. And a resolver that writes into the environment
has to run before anything reads it, which is an ordering nobody can see:
`getPool` and `directConnectionString` (`src/server/db/client.ts:13-42`,
`:69-78`) read the connection string themselves, and `npm run db:migrate` never
calls `getConfig` at all, so the write-back design needed a second call site
bolted onto that script and would have needed a third for the next entrypoint.
Resolving on first read removes the ordering entirely. `getConfig` calls the
resolver eagerly all the same, for one reason only: an unreadable or
contradictory secret file then refuses at startup rather than at the first
query, which is what the next section asks of everything else.

The same argument decided the one line that looks like it should have been left
alone. `config.ts:306-314` hands `getPool()` the *development default* for
`DATABASE_URL` and is now guarded so it does that and nothing else, because
unguarded it would have written a value read from `DATABASE_URL_FILE` straight
back into the environment the form exists to keep it out of.

One trailing newline is stripped and nothing further: `printf` and a Kubernetes
secret volume write none, `echo` and every text editor write one, a password may
legitimately end in a space, and `config.ts` stores `authSecret` untrimmed, so
the difference between stripping one and calling `trim()` is a different
session-signing key. An empty file refuses rather than starting with an empty
secret.

*Not yet:* the Helm chart in `deploy/helm` and
`deploy/compose/compose.distributed.yml` still hand all six to the container as
environment variables, so on the two platforms this section argues from, the
form is reachable only by work outside what the chart and the compose file
offer. `secret.create=false` is not the escape hatch it looks like: an existing
Secret is consumed through `envFrom` too
(`deploy/helm/simple-balance/templates/server-deployment.yaml:62-66`), and the
chart declares no volume or volume mount on either workload, so the file has to
be placed by something else and named through `config.extraEnv`. The compose
file writes `DATABASE_URL` inline and makes `AUTH_SECRET` a required
interpolation (`deploy/compose/compose.distributed.yml:45`, `:60`), so both have
to be edited out first. A plain `docker run` reaches the form with a bind mount
and nothing else, which is the path `README.md` documents. The application
supports it everywhere; the two orchestrated paths this section argues from do
not, and marking this settled without saying so would credit the guide with a
capability neither of them can reach.

*Checked by:* `tests/config.test.ts:363-560`, over all six by the consumer that
has to end up holding the value, including that a resolved `DATABASE_URL`
reaches `directConnectionString` without reaching `process.env`, and that it
does so in a process that never calls `getConfig` at all.

**House, and stronger than the litmus test.** `config.ts:58-70` holds a
`publicAuthSecrets` set and refuses an `AUTH_SECRET` matching any value this
project has ever published, including whatever `.env.example` last carried, with
the message "AUTH_SECRET is a published placeholder. Generate one, for example
with `openssl rand -base64 32`." Length alone cannot tell a real secret from a
documented one. This is the twelve-factor litmus test enforced rather than
stated, and it is the pattern to copy the next time a placeholder ships.

*Checked by:* `tests/config.test.ts:299-313` ("refuses the published placeholder
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

**Settled twice, and the second time reversed the first.** There used to be an
exception nobody had named as one: `boundedEnvironmentInteger` returned the
default whenever the value was not a safe integer in range, so `CSV_MAX_ROWS`,
`CSV_MAX_BYTES`, `RECURRENCE_TICK_SECONDS`, `RECURRENCE_CATCH_UP_LIMIT` and
`RECURRENCE_CLAIM_LIMIT` all fell back silently while `DATABASE_POOL_SIZE` threw.
The five were made to do what the one did, and then all six were made to warn
instead, which is where they are now
(`src/server/config-limits.ts:52-72`).

**The reversal is the interesting half, and it is not a retreat from the rule.**
A release upgrades cleanly from the one before it, which `AGENTS.md` states as a
rule of its own: a setting that was accepted stays accepted, and the release that
starts refusing it is a later one, after the warning has been in the field. A
deployment carrying `CSV_MAX_ROWS=50000` since 0.1.4 was being quietly reduced to
10,000 the whole time; refusing it at startup would have been correct in
isolation and would have stopped that container on upgrade, which is the one
thing this product promises not to do.

So the warning carries what the refusal would have said — the variable, the value
it was given, the range it had to be in, and the number in force instead — and it
is printed once per name at startup, in front of whoever just deployed. What was
kept from the first pass is the part that mattered most: all six are read at
startup rather than at the call site. `configuredCsvMaxRows()` used to run inside
an import (`src/server/services/import-export.ts:776`) and the recurrence limits
inside a tick, so a message about either arrived hours later in a log nobody was
reading, or on a deployment that never imported a CSV, not at all.
`assertConfiguredLimits()` (`src/server/config-limits.ts:155-162`) reads all six
and `getConfig()` calls it (`src/server/config.ts:178-183`), which every
entrypoint runs before it serves anything.

*Checked by:* `tests/config.test.ts` ("warns and falls back when %s is not a
whole number in range", over all six, through `getConfig()` rather than through
the parser) and `tests/config-limits.test.ts` for the parser: "accepts positive
bounded integer overrides", "leaves an unset limit on its default", and a case
per variable naming the one that was wrong.

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
silent") and the six bounded integers (`:58-72`), and nowhere else.
`SB_MAX_UPLOAD_SIZE` (`deploy/docker/frontend.Dockerfile:51-54`) models the
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
copy. Both now do all five: optional variables are commented out, so uncommenting
one is what enables it, and only the secrets are present and empty with the
generation command above them. Commenting out costs nothing in the compose file
because every reference in `compose.distributed.yml` is `${VAR:-}` or
`${VAR:-default}`, and `:-` reads empty and unset alike, so the two files differ
in shape and not in what the containers end up with.

**One variable is deliberately outside the correspondence, and this is the reason
rather than an exemption.** `POSTGRES_PASSWORD` is the bundled
`postgres:16-alpine` container's own variable, not one of this product's; it is
there because a trial on one machine should take one command, and it goes away
with that service when
`DATABASE_URL` names a real server. It is documented at
`deploy/compose/README.md:31-36`, beside the file that uses it. Putting another
image's settings into this product's tables would make the tables less true, not
more.

*Checked by:* `tests/env-example.test.ts`, which pins the uncommented set in each
file by name, so an optional variable added uncommented later fails with its own
name in the message.

The root file is the model for all five. `AUTH_SECRET=` is empty with
`openssl rand -base64 32` above it (`.env.example:8-13`),
`RECURRENCE_SCHEDULER` carries its own silence warning (`.env.example:77-81`),
and the mail block is commented out as a group (`.env.example:31-51`).

It also does one thing beyond the rule, worth generalising: it warns about
`NODE_ENV` (`.env.example:1-4`), a variable the images set and the operator is
not meant to touch, because unset reads as development "with nothing said about
it". **A silent hazard gets a comment even when the variable is not one you are
meant to set.**

**House, and keyed to the command rather than stated once.** Two different
parsers read `.env` in this repository and they disagree about quoting.

| Path | Parser | Rule |
| --- | --- | --- |
| `docker run --env-file .env` (`README.md:119`, `docs/deployment.md:428`) | Docker CLI | `NAME=value`, `#` only at line start, values passed as-is. **No interpolation and no quote processing. Do not quote.** Quoting an `SMTP_PASSWORD` here puts the quote marks in the password. |
| Compose `.env` and `env_file` (`deploy/compose/compose.distributed.yml`) | Compose | Interpolation applies to unquoted and double-quoted values, `${VAR:-default}` and friends work. **Single-quote a value containing `$`.** |

The intuitive advice, "quote your secrets in `.env`", is wrong on the path this
project documents first. **Settled.** The warning sits beside `SMTP_PASSWORD` in
each file and says the opposite thing in each, because that is the only place it
can be right: do not quote in the root `.env.example`, which
`docker run --env-file` passes through as typed; single-quote a value containing
`$` in `deploy/compose/.env.example`, which Compose interpolates. A general note
about quoting would have had to be wrong for one of the two.

*Checked by:* `tests/env-example.test.ts`, which pins both comments to their
variable.

**House.** Every variable in either `.env.example` appears in the
`docs/deployment.md` tables and every variable in those tables appears in an
`.env.example`. A drifted example file is worse than no example file, because it
is believed.

**Settled, and six variables had drifted.** Three were in the root example and
in no table, because prose was doing the work a table row does: `NODE_ENV` and
the two Google settings, which are now rows of their own
(`docs/deployment.md:21`, `:105-106`). Prose is where the reasoning goes and a
table is what somebody scans for a name, so a variable mentioned only in a
sentence is one an operator searching the tables concludes does not exist.

**The other three are a named exception rather than an omission, and this is the
reason.** `SB_API_ORIGIN`, `SB_FRONTEND_PORT` and `SB_MAX_UPLOAD_SIZE`
(`docs/deployment.md:528-530`) belong to the nginx container, and neither example
file configures it: the root file serves the single container, which has no
nginx in it, and the compose recipe sets all three on the frontend service
itself (`deploy/compose/compose.distributed.yml:196-200`), where a value can
carry the reason it is what it is. Their defaults are in the image
(`deploy/docker/frontend.Dockerfile:49-54`), so a deployment that changes none of
them has nothing to write down. This is the same shape as `POSTGRES_PASSWORD`
above: another image's variable, documented beside the file that sets it.

**House.** Renaming or removing a variable is a breaking change for every
operator, whatever a `0.y.z` version number formally permits. See the version
question under the container.

*Checked by:* `tests/env-example.test.ts`, in both directions and over both
example files, with the two exception lists written out and a third case holding
each name to still being outside the rule it is excused from — an exception list
that has quietly become the rule proves nothing. *Not checked:* that `config.ts`
and the deployment table agree on defaults.

---

## The container

### Labels

**Binding (OCI Image Specification, `annotations.md`).** Labels use the
pre-defined `org.opencontainers.image.*` keys, which supersede the older
`org.label-schema` ones. The prefix is reserved, and a consumer must not error on
an unknown key.

**House.** A label that varies per build comes from a build argument set in CI,
never a literal. The `Dockerfile:31-33` does this for `APP_VERSION`, with the
comment saying the release workflow passes the tag being published "so the image
reports the version it actually contains".

All four images set `title`, `description`, `version`, `licenses`, `source`,
`url`, `documentation`, `base.name` and `base.digest` (`Dockerfile:39-47`,
`deploy/docker/server.Dockerfile:45-53`,
`deploy/docker/scheduler.Dockerfile:45-53`,
`deploy/docker/frontend.Dockerfile:31-39`). `AGPL-3.0-only` is a valid SPDX
expression, and `.github/workflows/release.yml:210-218` restates it rather than
letting `metadata-action` derive the deprecated `AGPL-3.0` from GitHub's
detection, with the reason in a comment: v0.1.0 shipped carrying the derived one.

**Settled, and the guide was wrong about half of it.** `url`, `documentation`
and `base.name` are static strings that cost nothing, and `base.name` is what
answers the provenance question for a hand-built image.

`created` and `revision` are deliberately not set in the Dockerfiles, and this is
the correction. `APP_VERSION` works as a build argument because it has a truthful
default, the version in `package.json`, which `tests/dockerfile.test.ts` pins.
Those two have none, and a Dockerfile cannot emit a label conditionally, so a
defaulted `ARG` would give every hand-built image
`org.opencontainers.image.revision=""`, which reads to a consumer as known and
empty rather than as absent. They belong to the builder that knows them, which is
`.github/workflows/release.yml:203-220`, where `docker/metadata-action` supplies
both on a published image.

**Settled, and it took the decision it was waiting on.** `base.digest` was
absent because the bases were pinned by tag, and pinning by digest was refused
while nothing watched Docker: `.github/dependabot.yml` covered npm and GitHub
Actions only, so a pin would have frozen `node:24-alpine` on the day somebody
typed it. That is the objection the fix has to answer rather than route around,
so the watcher came first. `.github/dependabot.yml:60-83` now watches Docker over
both directories, grouped into one pull request because all four images share a
base and four bumps of one digest is four reviews of one decision.

Every `FROM` that names a registry image now carries its digest as well as its
tag, build stages included: a label describes the stage that ships, and a build
stage on a moving tag compiles the application against whatever the tag meant
that morning. The digest is the multi-platform index's rather than one
architecture's manifest, so an arm64 build still resolves its own image, and
`apk upgrade` in each runtime stage still applies whatever the distribution has
published since the pin, so pinned is not the same as unpatched.

The cost is stated rather than hidden: Dependabot moves a `FROM` line and cannot
move a label, so a base bump arrives as a pull request that fails until the
`base.digest` beside it is moved too. That is the failure worth having. The
alternative is an image whose label names a base it was not built on, which is
the one thing a provenance label must never do.

**House.** State which labels are guaranteed. The nine in the Dockerfiles are,
on every image however it was built. A release-job image carries `created`,
`revision` and whatever else `metadata-action` adds on top.

*Checked by:* `tests/dockerfile.test.ts`, over all four images: the seven fixed
labels including `licenses` and `source`, which nothing asserted before, that
`base.name` and `base.digest` both match the image named by that file's own
runtime `FROM`, that no stage builds on a tag that can move, and that neither
`created` nor `revision` is set. A base bump that forgets the label fails rather
than shipping an image that lies about what it was built on.

### Health checks

**House.** Liveness checks the process. Readiness checks everything a request
needs and nothing a request does not.

`/health/live` returns 200 unconditionally. `/health/ready` runs `select 1` and
returns 200 or 503 (`src/server/api.ts:283-298`, and the same pair on the
scheduler at `src/server/scheduler.ts:23-32`). Both are registered above every
auth middleware and neither is authenticated.

The rule that generalises best is already written in `docs/deployment.md:640`: "A
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
(`src/server/index.ts:27,68`; `src/server/scheduler.ts:67,74`), so readiness
cannot open before they finish. The 0.1.5 notes record that the payee index
"takes a moment to build while the container starts, before it opens readiness"
(`docs/upgrades.md:23`). So the generous number is `--start-period`, currently
20s (`Dockerfile:58`), plus a Kubernetes startup probe. Not the shutdown
deadline.

**Settled, and the second half declined.** Both documents used to say
`/health/ready` "says configuration, the database, and the migrations have all
succeeded, and stays closed until they have", and readiness never knew anything
about configuration or migrations. Both now say what it does:
`docs/deployment.md:631-636` and `README.md:130-133` describe one statement
against the database and nothing else, and `src/server/api.ts:283-289` says the
same beside the route. The difference matters to an operator designing alerting:
a migration that succeeded on an older image leaves readiness green against a
schema this build does not expect.

The second half of the proposal was to give readiness a real check, comparing
the applied migration tag against `drizzle/meta/_journal.json`. Declined:
`runMigrations()` is awaited before the server listens and nothing migrates
afterwards, so the guarantee is already ordering rather than a probe. A process
answering the route at all is past them, and a failed migration is a process
that never came up rather than one answering `503`. Querying for that on every
probe, every three seconds in the compose file, would buy nothing and would take
a working server out of rotation whenever the query was slow.

**House.** A healthcheck reads its port from the environment rather than
hardcoding one. All four images do: the three Node images read `PORT`, the
frontend reads `SB_FRONTEND_PORT`. The frontend also probes `/` rather than
`/health`, deliberately, because `/health` is proxied to the API and a frontend
healthcheck should not go red because the API did
(`deploy/docker/frontend.Dockerfile:69-70`).

*Checked by:* `tests/dockerfile.test.ts` ("uses the configured PORT for its
readiness healthcheck"). The doc-versus-code readiness claim is checked by
nothing.

### Logging

**House.** Sentences to stdout, at the level the operator asked for, and no
second channel. The container's logs are the log; nothing writes a file, rotates
anything, or needs a volume.

`LOG_LEVEL` reached exactly one consumer for a long time — Better Auth's own
logger — while this product's thirty-one `console` calls ignored it, so a
deployment asking for `error` still got the startup banner, the mail notice and
the scheduler's warnings. That is worse than having no setting at all, because
the log looks like the answer to a question the operator asked. Everything now
goes through `log` (`src/server/log.ts`), which reads the level once and drops
what sits below it. `error` is the top of the order and is never silenced.

**The configuration layer keeps `console` directly, and this is the exception
worth understanding.** `config.ts`, `config-files.ts` and `config-limits.ts`
warn from inside `getConfig()`, and the gate reads `getConfig()` to learn the
level: routing them through it would be a re-entrant call during the first read,
which is a stack overflow rather than a quiet line. A warning about
configuration also should not be gated by a configuration value that may be the
thing that is wrong.

**House.** Sentences, not JSON. Every line here is written for a person reading
it while a container refuses to start, and the machine-readable half of
observability is `/metrics` below, which is a better shape for it than a log
somebody has to reread through `jq`. A deployment that wants structured logs
puts a collector in front; that is the collector's job and not this product's.

*Checked by:* `tests/log-level.test.ts`, which holds both halves — that the gate
drops what it should and never drops an error, and that no file outside the
configuration layer reaches for `console` directly.

### Metrics

**House, and off unless asked for.** `GET /metrics` answers in the Prometheus
text format, on the port everything else is served on, and only when
`METRICS_ENABLED=true` (`src/server/api.ts:223`). Registered rather
than refused: a deployment that never asked has no such route, which is the same
answer the MCP surface gives for a tool outside a token's scope.

Both entrypoints mount it, and the reason is worth stating because a split
deployment gets it wrong by omission: the API reports requests, tool calls,
ledger writes and its pool, and the scheduler reports ticks, proposals,
reminders and mail. Scraping only the API watches the process that does none of
the scheduled work. Every series carries `component="api"` or
`component="scheduler"` so the two never collide.

**Binding, and the rule the rest of this product already follows.** No label
carries somebody's identity: not a user id, not an email, not an account name,
not an amount. A metric is read by whoever can reach the endpoint, which is not
the person whose ledger it counts, and every query in `src/server/services` is
scoped by actor for exactly that reason. `tests/metrics.test.ts` holds the list
of label names that would break it.

The same rule keeps the cardinality bounded, which is the same defect wearing a
cost rather than a privacy label. A path with an id in it is counted under the
route pattern — `/api/v1/accounts/:id` is one series, not one per account — and
a path matching no route at all is counted under a single literal, because a
mistyped URL is exactly where unbounded labels come from.

**House.** `METRICS_TOKEN` is optional and is a secret in the `_FILE` sense,
the seventh
(`src/server/config-files.ts:15-24`). Scraping over a private network with a
NetworkPolicy in front is a real deployment and demanding a token there would be
ceremony; publishing write rates and queue depths to the open internet is not,
and the two are indistinguishable from inside the process. So the token is
offered, the production case without one warns once at startup, and the bundled
frontend nginx does not proxy `/metrics` at all — a scrape goes to the API
service directly, so the browser's own hostname never exposes it
(`tests/dockerfile.test.ts:212-218`).

**House.** Collection is always on; only the endpoint is switched. It is not
free — the request middleware builds a label object per request and
`prom-client`'s default set installs a `PerformanceObserver` for garbage
collection — but it is small and constant, and gating it would put a branch in
front of every write in the product to save it. What the setting decides is
whether the endpoint answers, which is the part with a security consequence.

**The client is `prom-client`, and it is deprecated by rename.** npm prints
"prom-client has been replaced by @prometheus-io/client" on every install, and
the successor is the same project under the Prometheus organisation. It is not
adopted here yet, and the reason is dates rather than doubt:
`@prometheus-io/client` first appeared on 21 August 2026 and has four releases,
the newest a day before this was written, while `prom-client@15.1.3` is what the
ecosystem runs. Taking a week-old package on the branch a release is being cut
from trades a deprecation notice for an unknown, which is the wrong way round.
Revisit it in the release after this one: the move is an import rename if the API
held, and finding out costs one branch.

*Checked by:* `tests/metrics.test.ts` for the labels, the route pattern, the
token and the absence of the route when it was not asked for;
`tests/dockerfile.test.ts` for the frontend not proxying it and for the runtime
manifest carrying `prom-client`.

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
killed mid-drain" (`deploy/compose/compose.distributed.yml:154-156`), and the
chart sets `terminationGracePeriodSeconds: 30`
(`deploy/helm/simple-balance/values.yaml:217`).

**Settled.** Both documented `docker run` commands now pass
`--stop-timeout 30` (`README.md:117-122`, `docs/deployment.md:422-429`). Docker's
default is 10 seconds, exactly the drain deadline, so the forced exit and
SIGKILL used to land in the same instant and the drain never got to finish.

*Checked by:* `tests/server-lifecycle.test.ts`, four cases covering the drain,
the deadline, the second signal, and never exiting twice. The relationship
between the deadline and any grace period is checked by nothing.

### Hardening

**House (OWASP Docker Security Cheat Sheet, rules 2, 3, 4 and 8).** Non-root
user, read-only root filesystem, all capabilities dropped, no new privileges.

All four are everywhere now, and three of them always were. `USER node` in the
Node images and `USER 101` in the frontend (`Dockerfile:56`,
`deploy/docker/frontend.Dockerfile:46`). The documented run command passes
`--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m`. The chart sets
`runAsNonRoot`, `runAsUser: 1000`, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` and
`capabilities.drop: [ALL]` (`deploy/helm/simple-balance/values.yaml:199-213`).

**Settled.** `--cap-drop=ALL` and `--security-opt=no-new-privileges` are on the
documented `docker run` in both `README.md` and `docs/deployment.md`, and
`cap_drop: [ALL]` with `security_opt: ["no-new-privileges:true"]` reach the three
Simple Balance services in `deploy/compose/compose.distributed.yml` through one
`x-hardening` anchor. A Node HTTP server binding 3000 as a non-root user, and an
nginx binding 8080 as uid 101, need no capability at all, so this costs nothing
and closes the two routes a container escape usually takes. The Pulumi programs
deploy the chart, so they inherit the Kubernetes spelling at
`deploy/helm/simple-balance/values.yaml:199-213` and need nothing of their own.

**The one exception, stated because an unstated one reads as an oversight.** The
`postgres` service in the compose file gets `no-new-privileges` and keeps its
capabilities. Its entrypoint starts as root, chowns the data directory and drops
to the postgres user, which needs CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE and
CAP_SETUID/SETGID; dropping them breaks the one-command trial that service exists
for. It is not part of a real deployment, where `DATABASE_URL` names a database
somebody else runs.

**House.** Every install in an image resolves from a committed lockfile, and the
runtime stage carries production dependencies only.

*Checked by:* `tests/dockerfile.test.ts` for the lockfile rule ("Every install
must resolve from a committed lockfile, so the image cannot drift between
builds"), for the Alpine patch ordering relative to `USER node`, and for the
frontend's step up to root and back down to 101. `tests/deployment-docs.test.ts`
greps the documented run command for all five flags and reads the compose file
for both settings on the three application services, naming the postgres
exception when it fails. **The documented run command is the security surface
most people copy**, which is why it is the thing under test rather than the thing
described.

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
more to it. The sixth is where the answer is "warn and carry on" rather than
"refuse": a bounded integer out of range names itself at startup and runs on the
default, which is a deliberate trade against a deployment that has been carrying
a bad value since a release that accepted it.

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
| Booleans and closed sets refuse an unrecognised value, naming the variable | `tests/config.test.ts:145-166` |
| `APP_BASE_URL` is an exact origin, HTTPS off loopback | `tests/config.test.ts` |
| A non-production process with a real `APP_BASE_URL` refuses to start | `tests/config.test.ts` |
| A bounded integer outside its range refuses at startup, naming the variable | `tests/config-limits.test.ts`, `tests/config.test.ts` |
| Half a mail configuration refuses; ports, address forms, credentials pair | `tests/mail-settings.test.ts` |
| A password is never sent to a relay that refuses to encrypt | `tests/mail-settings.test.ts` |
| Healthcheck reads `PORT` | `tests/dockerfile.test.ts` |
| `title` and a build-argument `version` label | `tests/dockerfile.test.ts` |
| Alpine patch applied before dropping to `USER node`; frontend returns to 101 | `tests/dockerfile.test.ts` |
| Lockfile-only installs, production-only runtime, both lockfiles resolve alike | `tests/dockerfile.test.ts` |
| Entrypoints name files the compiler emits; nginx proxies every API prefix | `tests/dockerfile.test.ts` |
| Drain once, force-exit on deadline, force-exit on a second signal | `tests/server-lifecycle.test.ts` |
| The version reaches all fifteen places | `tests/version.test.ts` |
| The published placeholder secrets are refused in production | `tests/config.test.ts:299-313` |
| The template reminder's subject is exactly `Reminder: <name>` | `tests/integration/notifications.integration.test.ts:216` |
| Every message declares itself auto-generated | `tests/mail-headers.test.ts` |
| A subject leads with its fixed part, and a long name is cut by code point | `tests/mail-subjects.test.ts` |
| A failed send names the message and not the subject, and drops the recipient's address | `tests/mail-logging.test.ts` |
| Only secrets and always-set variables are assigned in either example file; the quoting warning sits beside each `SMTP_PASSWORD` | `tests/env-example.test.ts` |
| The example files and the deployment tables name the same variables, both directions, exceptions listed | `tests/env-example.test.ts` |
| The deliverability section exists, the README and `.env.example` point at it, and it cites no RFC | `tests/deployment-docs.test.ts` |
| The documented `docker run` carries all five hardening flags; the compose services carry both settings | `tests/deployment-docs.test.ts` |
| Nine labels on all four images, `base.name` and `base.digest` matching each file's own runtime `FROM`, and no stage built on a tag that can move | `tests/dockerfile.test.ts` |
| The scheduler checks its mail transport at startup and closes it on shutdown | `tests/scheduler-startup.test.ts` |

Not checked mechanically, ranked by how cheap the check would be:

1. `config.ts` defaults and the deployment table agree.
2. No unconfigured outbound network call from `src/server`.
3. `oneLine` refuses CR and LF, which is what closes header injection.
4. A failed send names the notification row and not only the kind of message it
   was. `sendMail` takes the phrase from the caller, so this is a matter of the
   two callers passing an id they already hold.

Review only, because no test can judge them:

- Whether a message's content sits in the right tier. What makes a sentence a
  disclosure is a judgement about a reader.
- Whether a variable's documentation answers the seventh question, "what happens
  when it is wrong", in words an operator can act on.

A rule in neither list is a rule nobody is responsible for, and that is a defect
in this guide rather than in the code.

---

## Work to do

Collected, with the file and line, so this section is a backlog rather than a
mood. A row leaves this table when the work lands and a test holds it, never
when somebody remembers it differently: two rows here once described finished
work for a release, one of them contradicted three lines away by a paragraph
marked **Settled**.

Nothing is outstanding. The four rows this table last carried have landed, and
each is recorded above as **Settled** with the test that holds it: the bounded
integers are read at startup and warn by name, the two example files and the
deployment tables name
the same variables with the exceptions written down, every image pins its bases
by digest and labels them, and the scheduler checks the transport it sends
every scheduled message over. An empty table is a claim, so it is worth saying
what would put a row back: work this guide argues for and the code does not do.
