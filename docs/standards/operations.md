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
(`src/server/mail.ts:234-255`) names the occurrence dates and stops, and the
docstring above it says why: "a proposed row is not money that has moved" and "a
total in a mail reads like a statement". `templateReminderMessage`
(`src/server/mail.ts:264-283`) names the template and the date and carries no
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
not honor it invert colors with their own algorithms. Plain text inherits the
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

**How a SHOULD is labeled here**, stated once because this section leans on
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
`sendMail` (`src/server/mail.ts:142-182`) sets it on every message.

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
is where the header is set for every message rather than in each builder. It
asserts the header set exactly, so it holds the `List-Unsubscribe` rule above
too: it matched a subset, and either list header could have been added with it
green.

### Subject lines

**House.** The fixed, identifying part comes first, and any interpolated user
text is capped.

No source establishes a subject-line rule for transactional mail. The length
advice that circulates is vendor open-rate data about campaign mail, which is a
different medium with a different reader. This is a house rule and the reason is
truncation: a mail client shows the first N characters, so whatever is first is
what the person reads in the list.

Both message builders follow it. `Reminder: ${templateName}`
(`src/server/mail.ts:272`) and `Staged: N rows from ${recurrenceName}` (`:245`)
each lead with the fixed word, and both pass the name through `forSubject`
(`src/server/mail.ts:204-211`), which cuts it to 60 code points and appends an
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
(`src/shared/domain.ts:351-357`), which refuses every character
from U+0000 to U+001F and U+007F, so header injection through a subject is
closed at the schema rather than at the mailer. Worth writing down precisely because the
defense is nowhere near the code it defends.

*Checked by:* `tests/mail-subjects.test.ts`, which pins both fixed parts and the
cap, including that a name of astral-plane characters comes back whole rather
than cut through a surrogate pair.
`tests/integration/notifications.integration.test.ts:216` pins the template
subject exactly, `Reminder: Quarterly tax`, against the code that sends it. That
`oneLine` refuses a newline is `tests/subject-header-injection.test.ts`, which
feeds CR LF, a bare LF, a bare CR, a tab, NUL and DEL to all four schemas that
carry a name into a subject — the create *and* the update of each, because the
update schemas respell the name rather than deriving it from the create. It
carries a positive control, an accented and emoji-bearing name that must be
accepted, and that control earned its place immediately: the first draft's
fixture was wrong and all twelve refusals were passing for the wrong reason.

### What goes in the log when a message fails

**House.** A log line about a message names what the message was, never the
subject.

One policy about personal data in log lines, in one process.
`account-deletion.ts:226-233` logs counts and no address, with the comment
"Deliberately without the address: they asked to be gone." `sendMail` follows it:
every `Message` carries `about`, a fixed phrase naming the kind of message
(`src/server/mail.ts:97-107`), and that phrase is what the log line carries
(`:179-182`). The phrase comes from the builder, so a caller that spreads one
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
hand. A Drizzle error is narrowed for a harder reason, and it is narrowed in one
place rather than at each transport: see §Logging below, which owns
`log.failure` (`src/server/log.ts:75-101`). `src/server/api.ts:414-418` is the
HTTP transport handing it over, with the comment saying why it stopped doing the
narrowing itself.

*Checked by:* `tests/mail-logging.test.ts`, which makes the transport throw and
asserts the log line names the message and not the subject, and that what goes
beside it carries no `envelope` and no `rejected`.

### Password reset and verification

**House, and already met.** The reset satisfies the OWASP Forgot Password
guidance in the ways that matter here: a single-use token whose one-hour expiry
is stated in the body (`src/server/mail.ts:215-225`), no password in the
message, and an identical response whether or not the account exists, which is
the whole reason `sendMail` returns `false` rather than throwing
(`src/server/mail.ts:133-141`).

**House, and this is the constraint to state as a defense rather than as
strictness.** The URL in a reset message is built from `APP_BASE_URL`, which
`config.ts:26-60` validates as an exact HTTP(S) origin with no credentials, path,
query or fragment, HTTPS everywhere but loopback. That is the Host-header
injection defense: a reset link assembled from the request's `Host` header lets a
stranger send a real user a real reset link pointing at the stranger's server.
Written as "the origin must be exact" it reads as fussiness about URLs.

**House.** Mail is a notification channel and an account-recovery channel. It is
never a second factor. NIST SP 800-63B revision 4 §3.1.3.1 is the citation, and
revision 3 is superseded.

*Checked by:* `tests/config.test.ts` (the origin rule, including the four
non-origin forms it refuses). The single-use and expiry behavior is Better
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
This is the first of the named exceptions to fail-fast configuration, below.

**Settled, and the process that sends was the one not doing it.** Both
entrypoints check the transport at startup now. `src/server/index.ts:36` always
did; `src/server/scheduler.ts:74-81` does as of this change, and it has the
stronger claim on the check: it sends every scheduled message, and nobody is
waiting for one. A person locked out of a password reset complains within the
hour, and a reminder that never arrives is noticed by nobody at all. A scheduler
with no mail configured says that too, in one line
(`src/server/scheduler.ts:82-95`), because a container that was never handed the
SMTP settings and one whose relay answers are indistinguishable in a log that
says nothing — and a split deployment assembled by hand is exactly where that
happens, since the chart and the compose file both give the scheduler the whole
of the API's environment and a hand-built one gives it what somebody remembered.

What it deliberately does not copy from the API is written above its own
`main()` (`src/server/scheduler.ts:43-56`). The archived-account reconciliation
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
the nginx frontend reads prefixed ones — eight of them, every `SB_` name the
image declares a default for: `SB_FRONTEND_PORT`, `SB_API_ORIGIN`,
`SB_MAX_UPLOAD_SIZE`, `SB_BILLING_CONFIGURED`, `SB_CSP_REPORT_ONLY`,
`SB_ADS_CONFIGURED`, `SB_TRUSTED_PROXY_CIDR` and `SB_REAL_IP_RECURSIVE`
(`deploy/docker/frontend.Dockerfile:49-90`, documented at
`docs/deployment.md:865-872`). It was three for two releases and the rule held
through five more arriving, which is the evidence the rule is worth something.
`AUTH_MODE` and `TRUST_PROXY` are generic enough to collide with a sidecar or a
base image.

**The existing unprefixed names are frozen, and the rule applies to new ones.**
Renaming them is a breaking change for every operator, and the cost of the
inconsistency is smaller than the cost of the rename. What is not acceptable is
leaving the question open, which is what this paragraph closes.

**House, and a third category the rule above did not name.** A credential or an
identifier that belongs to somebody else's product keeps that product's own
spelling, unprefixed. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` were already
this, and 0.2.0 adds `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY_ID`, `STRIPE_PRICE_YEARLY_ID`,
`ADSENSE_CLIENT_ID`, `ADSENSE_BANNER_SLOT_ID` and `ADSENSE_FOOTER_SLOT_ID`.

The reason is that these names are not this product's to invent. An operator
meets `STRIPE_SECRET_KEY` in Stripe's own documentation, in Stripe's CLI and in
every other application they have wired to Stripe; spelling it `SB_STRIPE_SECRET_KEY`
here would make this the one place it is written differently, and would suggest
the value is ours rather than theirs. The test is ownership, not familiarity:
`SB_BILLING_ENABLED` is prefixed, because whether this deployment sells a plan is
a question only this product asks.

*Checked by:* `tests/deploy-settings-naming.test.ts`. A grep would have to know
which names belong to a vendor — so the grep does not know and the four
registers do: a platform convention, a vendor's own spelling, the inventions
frozen in 0.1.x, and the inventions frozen in 0.2.0. Each entry is keyed by name
and carries its reason, so a name on none of them fails by name. Neither frozen
register takes a new entry: a name invented from 0.2.1 on is prefixed `SB_`.

**Superseded in 0.2.0, by the release shipping: this was open, and the owner's
to close before 0.2.0 shipped.** It is kept as it was written because the
reasoning is the record of why the exceptions below exist. `PRIVACY_POLICY_URL`,
`TERMS_OF_USE_URL` and `SITE_ADDRESS` break the rule above. All three are this
product's own inventions, none is a platform's convention or a vendor's
identifier, and all three arrived unprefixed in 0.2.0: the first with the ads
work, the second beside it, the third with the `single` profile's TLS overlay.
They are not frozen, because none has been released. This records the question
rather than an exception, because an exception that a change writes for itself
is exactly what "the rule applies to new ones" exists to stop. It is a row of
the backlog below, so it is a question somebody owns rather than a deadline
written in prose.

`SITE_ADDRESS` is the one that would be easiest to call somebody else's. It is
not: Caddy reads `{$SITE_ADDRESS}` because `deploy/compose/single/Caddyfile:33`
is a file in this repository that spells it that way, and
`compose.caddy.yml:57` makes it a required interpolation. No Caddy convention
names it, so the test above — ownership, not familiarity — puts it on this
product's side of the line. What settles it is the machine next door:
`deploy/compose/single/.env.postgres.example:16` carries `SB_BIND_ADDRESS`, an
address this profile invented and prefixed, so the same profile spells two
addresses it owns two different ways on two machines an operator sets up in one
sitting.

Two ways out, and each costs what the other avoids.

- **Prefix all three**, as `SB_PRIVACY_POLICY_URL`, `SB_TERMS_OF_USE_URL` and
  `SB_SITE_ADDRESS`. The rule holds with no exception to name. Every
  environment already setting the unprefixed name for the ads work has to
  rename it, and one with AdSense configured refuses to start until it does,
  because the policy is required beside the ids. `SITE_ADDRESS` is the cheapest
  of the three to move and the only one that fails loudly: `compose.caddy.yml`
  interpolates it as `${SITE_ADDRESS:?}`, so an operator who renamed the
  variable and not the compose file is told rather than served a site on the
  wrong name.
- **Keep all three**, and name the exception here. Nothing already set changes.

One way is not open: prefixing the two legal names and not each other. They are
one setting in two halves — set together, documented in one table, read by one
function (`parseLegalDocuments`) — and an environment variable spelled wrong is
ignored rather than refused. An operator who writes the second name by analogy
with the first, beside a real `SB_TERMS_OF_USE_URL`, gets a sign-up form that
links no terms and no word about why, which is the failure with no symptom this
whole section is arranged against.

**0.2.0 shipped all three unprefixed, so the second way is the one taken —
and it shipped sixteen more the question above never named.** The open
question named three; 0.2.0 invented nineteen. The other sixteen are seven of
the `single` profile's and the trial recipe's own — `ACME_EMAIL`,
`ACME_EMAIL_OPTION`, `ADSENSE_CONSENT_MANAGED`, `APP_BIND_ADDRESS`, `APP_PORT`,
`CADDY_IMAGE` and `MAX_BODY_SIZE` — and nine `POSTGRES_*` names this repository
invented inside PostgreSQL's namespace: `POSTGRES_APP_PASSWORD`, the six tuning
names `compose.postgres.yml` interpolates into `-c` flags, `POSTGRES_IMAGE` and
`POSTGRES_DATA_MOUNT`. All nineteen are frozen in 0.2.0 as the exceptions to the
`SB_` rule, each with its reason in the register, and renaming any of them is
now a deprecation with both spellings accepted for a release, not an edit.
`ADSENSE_CONSENT_MANAGED` and `APP_BIND_ADDRESS` are the two a fresh start would
have prefixed — the first is a question only this product asks, sitting in a
vendor's namespace, and the second makes one machine spell two of its own
addresses two ways — and both are recorded as that, not as right.

*Checked by:* `tests/deploy-settings-naming.test.ts`, whose 0.2.0 register is
pinned by membership to exactly these nineteen.

### Types

**House.** A boolean accepts exactly `true` and `false`, lowercased, and anything
else refuses to start.

This is the rule most worth stating because the alternative is truthiness, and
truthiness has no symptom. `RECURRENCE_SCHEDULER` already does it, and
`config.ts:275-277` gives the reason: "A misspelling here has no symptom: the
process starts, serves, and quietly proposes nothing until somebody notices a
year of missing rent." `RECURRENCE_SCHEDULER=yes` read as falsy is a deployment
that looks healthy and proposes nothing. `TRUST_PROXY` (`config.ts:271-274`) and
`SMTP_SSL` (`config.ts:558-561`) follow the same pattern.

The same argument applies to any closed set, not only booleans. `NODE_ENV` is
parsed against three values and refuses a fourth (`config.ts:246-250`), because
`NODE_ENV=Production` compared against the string `production` had no symptom
either: no setup code, no rate limiting, no secure cookies.

**The frontend image's three switches are the exception that is on its way
in.** `SB_BILLING_CONFIGURED`, `SB_ADS_CONFIGURED` and `SB_CSP_REPORT_ONLY`
reach nginx's `map` and are matched against `true`, which a map does without
regard to case: `TRUE` was on, and `yes`, `1` and `on` served the off position
with nothing in the log — while the server refuses `SB_CSP_REPORT_ONLY=yes`, so
two halves of one deployment could disagree about one switch and neither say
so. `deploy/docker/nginx-switches.envsh` now reads them before the template is
rendered and **keeps what nginx made of each**: any case of true or false passes
through lowercased and quietly, and anything else stays off and **warns, naming
the variable**: 0.2.0 started on them, so refusing would stop a container that
ran yesterday. A first draft read `TRUE` as off, which was checked against the
image's own nginx only afterwards and would have taken the plan tab's Stripe
policy off a deployment that had it. Refusing is a later release's change, after the
warning has been in the field. `SB_REAL_IP_RECURSIVE`, in the same image,
already refuses, because it arrived refusing and so had nothing to keep.

**House.** An integer is bounded, and both the bound and its reason are
documented. Every ceiling in `config-limits.ts` exists to stop something filling
the database or the process.

**House.** A list is comma-separated, each entry trimmed, and empty entries are
skipped rather than refused. `parseRegistrationRule`
(`src/server/config.ts:1009-1045`) is the model: split, trim, lowercase, drop the
blanks, then validate what is left with a message naming the bad entry.

*Checked by:* `tests/config.test.ts`, which asserts that
`RECURRENCE_SCHEDULER=yes`, `TRUST_PROXY=yes`, `METRICS_ENABLED=on`,
`SB_CSP_REPORT_ONLY=yes`, `LOG_LEVEL=loud`, `AUTH_MODE=sso` and `NODE_ENV=Prod`
each throw with the variable named; `tests/mail-settings.test.ts` covers
`SMTP_SSL` and `SMTP_PORT`; and `tests/frontend-switches.test.ts` holds the
frontend's three to warning by name and keeping the off position.

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
value. It applies to nine names — `AUTH_SECRET`, `DATABASE_URL`,
`DIRECT_DATABASE_URL`, `SMTP_PASSWORD`, `GOOGLE_CLIENT_SECRET`, `SETUP_TOKEN`,
`METRICS_TOKEN`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` — and to no
setting.
**That line is the definition of the difference between a secret and a
setting**: if it has a `_FILE` form it is a secret.

**The two Stripe names are the newest, and the line they are on the far side of
is drawn in the code's own docstring** (`src/server/config-files.ts:3-27`).
`STRIPE_SECRET_KEY` can charge a card, refund one and cancel a subscription;
`STRIPE_WEBHOOK_SECRET` is the only thing distinguishing a real delivery from a
forged one, so anybody holding it can tell this deployment an invoice was paid.
Neither belongs anywhere `kubectl describe pod` prints it. The other Stripe
names are deliberately outside the list: `STRIPE_PUBLISHABLE_KEY` ships to every
browser by design and the two price ids appear in Stripe's own dashboard URLs.
The AdSense ids are the same case, and both are the subject of their own rule
below. Giving any of them a `_FILE` form would say they are secrets when they
are not, which blunts the one distinction this list exists to draw.

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
(`src/server/config-files.ts`) read `NAME_FILE` for those nine names.
`SETUP_TOKEN` and `DIRECT_DATABASE_URL` are on the list because the litmus runs
both ways: the first is the code that claims an instance and the second carries
a password, so a set of four would have been this product quietly calling them
settings.

The resolved values are held in a module-level map and handed out by
`readSecret`, and are never written back into `process.env`. Two reasons, and
the second is the load-bearing one. A Node diagnostic report serializes
`process.env`, so a value that never enters it cannot appear in the dump this
section exists to worry about. And a resolver that writes into the environment
has to run before anything reads it, which is an ordering nobody can see:
`getPool` and `directConnectionString` (`src/server/db/client.ts:13-42`,
`:62-71`) read the connection string themselves, and `npm run db:migrate` never
calls `getConfig` at all, so the write-back design needed a second call site
bolted onto that script and would have needed a third for the next entrypoint.
Resolving on first read removes the ordering entirely. `getConfig` calls the
resolver eagerly all the same, for one reason only: an unreadable or
contradictory secret file then refuses at startup rather than at the first
query, which is what the next section asks of everything else.

The same argument decided the one line that looks like it should have been left
alone. `config.ts:484-492` hands `getPool()` the *development default* for
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
`deploy/compose/compose.distributed.yml` still hand all nine to the container
as environment variables, so on the two platforms this section argues from, the
form is reachable only by work outside what the chart and the compose file
offer.

**The chart can mount a Secret and chooses not to for these nine names**, which
is a different sentence from the one this paragraph used to carry and the
difference is the whole of the remaining work. It is not that volumes are
missing. Both workloads declare one and mount it — `database-ca`, projected out
of the database Secret by a single key, with the comment saying that naming the
one item is what keeps the superuser, replication and Patroni passwords out of a
container with no use for them
(`deploy/helm/simple-balance/templates/server-deployment.yaml:146-161`, and
`scheduler-deployment.yaml:132-146`). That is exactly the shape a `_FILE` secret
wants, built and working, for a different file. What is absent is a values block
that would project `AUTH_SECRET` or `STRIPE_SECRET_KEY` the same way and set
`AUTH_SECRET_FILE` to where it landed: the application's own credentials are
still consumed through `envFrom` (`server-deployment.yaml:72-85`), including an
existing Secret under `secret.create=false`, so reaching the form today means
placing the file with something outside the chart and naming it through
`config.extraEnv`. The compose file writes `DATABASE_URL` inline and makes
`AUTH_SECRET` a required interpolation
(`deploy/compose/compose.distributed.yml:50`, `:71`), so both have to be edited
out first. A plain `docker run` reaches the form with a bind mount and nothing
else, which is the path `README.md` documents.

Saying "the chart declares no volume" was the stronger-sounding claim and the
false one, and it is worth naming why it mattered: it read as an unsolved
problem when the solution is two files along, which is the sort of sentence that
gets a capability rewritten from scratch beside the one already there.

*Checked by:* `tests/config.test.ts:389-661`, over eight of the nine by the
consumer that has to end up holding the value, including that a resolved
`DATABASE_URL` reaches `directConnectionString` without reaching `process.env`,
and that it does so in a process that never calls `getConfig` at all.
`METRICS_TOKEN_FILE` is the gap and is still the only one: no test reads it back
through the scrape endpoint, so that one name rests on the resolver's registry
(`src/server/config-files.ts:28-38`) alone. Both Stripe secrets arrived with a
consumer row each, which is what kept the gap at one while the list grew by two.

**House, and stronger than the litmus test.** `config.ts:69-81` holds a
`publicAuthSecrets` set and refuses an `AUTH_SECRET` matching any value this
project has ever published, including whatever `.env.example` last carried, with
the message "AUTH_SECRET is a published placeholder. Generate one, for example
with `openssl rand -base64 32`." Length alone cannot tell a real secret from a
documented one. This is the twelve-factor litmus test enforced rather than
stated, and it is the pattern to copy the next time a placeholder ships.

*Checked by:* `tests/config.test.ts:325-339` ("refuses the published placeholder
secret %s in production"), over two of the three entries in the set. *Not
checked:* that the set covers whatever `.env.example` currently carries, which is
the half that has to be extended by hand every time the example file changes.

### A deployment program keeps the settings in the stack and the cloud's store

**House.** A program in `deploy/pulumi/` takes every application setting it
has no key of its own for in two maps, `simple-balance:env` and
`simple-balance:secrets`, and delivers them through the cloud's own secret
store to the workload's own identity: one OCI Vault secret or one AWS Secrets
Manager secret that the application machine alone may read, or the Kubernetes
Secret the program builds. The rules — which names a stack may set, which are
secret, which a program decides itself — are one module,
`deploy/pulumi/common/app-settings.ts`, and every program reads them through it.

The obvious alternative was the one these programs shipped with on the branch:
settings typed over SSH into a file on the machine's data volume. It was argued
for honestly — anything a program put on the machine arrived as user data,
which anyone who can describe the instance can read — and that argument was
about the delivery, not the stack. It left a Stripe key in nobody's version
control and nobody's secret store, made a rebuilt machine the moment somebody
found out whether they had kept a copy, and made "change a setting" an SSH
session where everything else about a deployment was `pulumi up`. A fetch the
machine makes with its own identity removes the user-data objection, and with
it the reason for the file.

Two consequences worth knowing before adding a setting or a program:

- **A secret is decided by the server, not by the deploy program.** The names
  that go in `secrets` are the nine with a `_FILE` form, which the section above
  defines; `app-settings.ts` keeps a copy because `deploy/` is vendored without
  `src/`, and a test holds the copy to the source. A secret in `env` is refused
  at plan time rather than moved, because the plain copy is already in a
  committed file by the time the program sees it.
- **What says where a deployment runs is not copied from a `.env`.**
  `settings-from-env.mjs` leaves out `DATABASE_URL`, `APP_BASE_URL`,
  `TRUST_PROXY` and their kind, because a development `.env` has every one of
  them pointing at a laptop. Those are set deliberately or decided by the
  program.

*Checked by:* `tests/app-settings.test.ts` — the two lists against the server's
source, every refusal, the Compose quoting, the chart mapping and the `.env`
script's choices; `tests/cloud-init.test.ts`, that the machine is told where its
settings are and never what they are, and fetches before it folds; and
`tests/systemd-scripts.test.ts`, the fetch's behavior against a fake CLI. Each
was mutation-proved. *Not checked:* that a real Vault or Secrets Manager grant
works end to end, which needs a cloud account — `docs/acceptance.md` carries
the cloud programs as outstanding.

### A vendor's public identifier reaches the browser at runtime

**House, and the one that is easiest to get wrong once and never notice.** A
third-party integration usually needs an identifier in the *browser* — Stripe's
publishable key, AdSense's publisher id. They are published to every visitor by
design, so they are settings rather than secrets, and the instinct is to treat
them like any other build-time constant: a `VITE_` define, an `import.meta.env`
name, a Docker build `ARG`, a placeholder substituted into `index.html`.

Every one of those is wrong here, for a reason that is a property of how this
product ships rather than of the value. **One image serves every operator.**
`simple-balance-frontend:<version>` is built once and pulled by everybody, so a
value compiled into the bundle is one operator's value on every deployment —
which for a publisher id means either the vendor's own account is credited for
somebody else's traffic, or nobody's is and no self-hoster can ever be paid.

So a per-operator vendor identifier travels on a response, at runtime:

| Value | From | To the browser on |
| --- | --- | --- |
| `STRIPE_PUBLISHABLE_KEY` | `config.ts` → `BillingSettings` | `GET /api/v1/billing` |
| `ADSENSE_CLIENT_ID` and the slot ids | `config.ts` → `AdSettings` | `GET /api/v1/session` |

The second carries a second property worth copying rather than reinventing: the
ids are on the session **only when this person should see an ad**. The server
decides, and a browser that was never handed an identifier cannot use one by
mistake. That is `code/services.md`'s "withhold rather than gate", and it is why
the ad rule has no client-side copy to drift.

Not only a vendor's. Anything per-operator that the browser draws takes the same
road for the same reason, which is why `PRIVACY_POLICY_URL` and
`TERMS_OF_USE_URL` arrive on `GET /api/auth/methods` (`config.ts` →
`LegalDocuments`): that one is answered before a session exists, and the sign-up
form links both.

*Checked by:* nothing mechanical, and it is worth saying why rather than
pretending. A grep for `import.meta.env` in `src/client` would catch the define
but not a value threaded through a build step some other way, and the real
check is that `docs/monetization.md` promises no shared publisher id ships —
a promise a reviewer can verify in one grep and a test cannot verify at all.

### Validating at startup

**House.** Configuration is validated in full at startup, and invalid
configuration refuses to start. No specification requires this. The argument is
operational: an orchestrator surfaces a process that will not start, with restart
backoff and a log line, and does not surface a healthy process that is quietly
misconfigured.

**The named exceptions are the checks that ask another service**, and there are
three. `checkMailTransport` logs a long, specific error and continues.
`checkStripePrices` (`src/server/stripe.ts:1528`) does the same for the two
price ids, and a definite mismatch stops sales at the point of sale rather than
the process. `checkStripeAccess` (`:1592`) asks, for a restricted key only,
whether it can read each resource this product uses, names in one error line
every one it cannot, and writes nothing. Each asks something only the other end
can answer, and can fail for reasons no configuration here controls — a relay
down, Stripe slow to answer at the moment a container starts — so refusing would
take the ledger down with a dependency the ledger does not need. Both entrypoints
run the two Stripe checks together (`src/server/index.ts:44`,
`src/server/scheduler.ts:100`), so an unreachable Stripe costs startup one wait
rather than two. State the rule and the exceptions in the same breath, because
an unstated exception reads as a bug.

**Settled twice, and the second time reversed the first.** There used to be an
exception nobody had named as one: `boundedEnvironmentInteger` returned the
default whenever the value was not a safe integer in range, so `CSV_MAX_ROWS`,
`CSV_MAX_BYTES`, `RECURRENCE_TICK_SECONDS`, `RECURRENCE_CATCH_UP_LIMIT` and
`RECURRENCE_CLAIM_LIMIT` all fell back silently while `DATABASE_POOL_SIZE` threw.
The five were made to do what the one did, and then all six were made to warn
instead, which is where they are now
(`src/server/config-limits.ts:41-85`).

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
an import (`src/server/services/import-export.ts:755`) and the recurrence limits
inside a tick, so a message about either arrived hours later in a log nobody was
reading, or on a deployment that never imported a CSV, not at all.
`assertConfiguredLimits()` (`src/server/config-limits.ts:225-237`) reads all seven
and `getConfig()` calls it (`src/server/config.ts:229-241`), which every
entrypoint runs before it serves anything.

**The seventh bounded integer was read at its call site until 0.2.1**, which
made it the live instance of the defect the two paragraphs above are about. `IDEMPOTENCY_RETENTION_HOURS` is parsed by
`configuredIdempotencyRetentionHours` (`src/server/config-limits.ts:134-154`), a
deliberate sibling of the shared reader rather than a flag on it, because zero
is a real answer here — the honest spelling of "do not prune" — where on a cap
it would be a broken deployment. The sibling is right. What is missing is the
line in `assertConfiguredLimits()`: the value is read inside a scheduler tick
(`src/server/recurrence-scheduler.ts:171`) and inside the sweep itself
(`src/server/services/helpers.ts:473`), so a typo in it warns on a timer rather
than in front of whoever just deployed — and on a deployment that leaves
retention off, which is the default, the warning says the value is having no
effect in a log line nobody correlates with the deploy. `assertConfiguredLimits()`
calls it now, beside the other six, and the check below no longer trusts a list
to say which readers there are.

*Checked by:* `tests/config.test.ts` ("warns and falls back when %s is not a
whole number in range", over all six that `assertConfiguredLimits` reads,
through `getConfig()` rather than through the parser) and
`tests/config-limits.test.ts` for the parser: "accepts positive bounded integer
overrides", "leaves an unset limit on its default", and a case per variable
naming the one that was wrong, the seventh among them. Which readers startup
calls is held by "reads every limit the module exports, not the ones somebody
listed": the population is every exported `configured…` function rather than a
table, because a table is how the seventh went unread.

### Documenting a variable

**House, seven parts.** A variable is documented when it names: what it is; its
type or accepted values; its default; whether and when it is required; what
changes when it changes; its ceiling and why that ceiling exists; and what
happens when it is set wrong.

There is no specification for this. `docs/deployment.md` delivers the first five
for every variable. The sixth is given wherever there is a ceiling
(`docs/deployment.md:68-76`, of which `CSV_MAX_ROWS` at `:71` is the fullest: the
cap matches the bulk-action cap so an import always fits one review-queue
action). The seventh appears for `TRUST_PROXY` (`:67`, "getting it wrong costs
per-visitor rate limiting"), `RECURRENCE_SCHEDULER` (`:72`, "A value other than
`true` or `false` refuses to start, because the wrong setting is otherwise
silent") and the seven bounded integers (`:81-102`), and nowhere else.
`SB_MAX_UPLOAD_SIZE` (`deploy/docker/frontend.Dockerfile:51-54`) models the
sixth best of all, because it gives the arithmetic so an operator can compute
their own value rather than copy a number.

**The seventh is the one that needed a paragraph of its own and got one**
(`docs/deployment.md:88-92`). `IDEMPOTENCY_RETENTION_HOURS` takes zero as a real
answer where the other six take it as a mistake, and the document says so in the
terms this rule asks for: what a wrong value does, which way the fallback goes,
and why it goes that way rather than the other — *off* rather than a window,
since a typo must never start pruning. Worth copying wherever a bound and a
sentinel share a variable. The same document is honest about the one thing this
guide recorded as a gap: `:94` said *six* were read at startup and did not
claim the seventh, until the seventh was; it says seven now.

*Not checked mechanically.* A test can assert that every variable has a row; it
cannot assert that the row answers the seventh question.

### `.env.example`

**House.** Required variables uncommented, with a real-shaped value that does not
work. Optional variables commented out, so uncommenting one enables it. Secrets
present but empty, with the generation command in the comment above. A comment on
any variable whose wrong setting is silent. Grouped in the order an operator
meets them.

**There are four example files and the rules govern all of them.**
`.env.example` at the root serves the single container;
`deploy/compose/.env.example` serves `compose.distributed.yml` and is the one
that recipe's header tells an operator to copy; and the `single` profile adds
two, one per machine — `deploy/compose/single/.env.example` for the application
node and `deploy/compose/single/.env.postgres.example` for the database node
beside it. All four do all five: optional variables are commented out, so
uncommenting one is what enables it, and only the secrets are present and empty
with the generation command above them. Commenting out costs nothing in the
compose files because every reference in `compose.distributed.yml` is `${VAR:-}`
or `${VAR:-default}`, and `:-` reads empty and unset alike, so the files differ
in shape and not in what the containers end up with.

**A profile is as many example files as it has machines**, which is the thing
worth generalizing out of the `single` profile rather than the count. Two
machines mean two Compose projects that never run together, so one file holding
both machines' settings would be a file where more than half of every copy is
inert, and the operator cannot tell which half. The application node's example
assigns six names live — `DATABASE_URL`, `AUTH_SECRET`, `APP_BASE_URL`,
`AUTH_MODE`, `LOG_LEVEL` and `SITE_ADDRESS` — and comments out everything a
default already answers, which is the root file's shape against a longer list.

**One variable is deliberately outside the correspondence, and this is the reason
rather than an exemption.** `POSTGRES_PASSWORD` is the bundled
`postgres:18` container's own variable, not one of this product's; it is
there because a trial on one machine should take one command, and it goes away
with that service when
`DATABASE_URL` names a real server. It is documented at
`deploy/compose/README.md:45-55`, beside the file that uses it. Putting another
image's settings into this product's tables would make the tables less true, not
more.

**And the `single` profile's database machine is the same exception, twice
over.** `deploy/compose/single/.env.postgres.example` assigns three names and
two of them are this exception: `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD`
are the `postgres:18` image's own variable and this repository's `db-init.sh`'s,
not the application's — nothing in `src/` reads either, and the application
reaches that machine only through a `DATABASE_URL` one of them ends up inside.
Both are written on the machine at first boot rather than typed, which is why
they are `${VAR:?}` in `compose.postgres.yml`: a refusal to start beats a
database that comes up on a default nobody chose.

**The third name in that file is not an exception at all, and it is the one
worth reading.** `SB_BIND_ADDRESS` is the profile's stated security boundary:
PostgreSQL is published on that address and nowhere else, so a wrong value
either stops the application machine reaching the database or — written as
`0.0.0.0` — publishes the ledger to whatever the provider's firewall has not
closed. It is live rather than commented out because a machine always has an
address, which is this section's own rule for what may be assigned, and it is
`${SB_BIND_ADDRESS:?}` in `compose.postgres.yml` for the reason above. The
checked row for published ports is downstream of exactly this value.

*Checked by:* `tests/env-example.test.ts`, which pins the uncommented set in each
file by name, so an optional variable added uncommented later fails with its own
name in the message.

The root file is the model for all five. `AUTH_SECRET=` is empty with
`openssl rand -base64 32` above it (`.env.example:33-38`),
`RECURRENCE_SCHEDULER` carries its own silence warning (`.env.example:254-264`),
and the mail block is commented out as a group (`.env.example:83-106`).

It also does one thing beyond the rule, worth generalizing: it warns about
`NODE_ENV` (`.env.example:27-31`), a variable the images set and the operator is
not meant to touch, because unset reads as development "with nothing said about
it". **A silent hazard gets a comment even when the variable is not one you are
meant to set.**

**House, and keyed to the command rather than stated once.** Two different
parsers read `.env` in this repository and they disagree about quoting.

| Path | Parser | Rule |
| --- | --- | --- |
| `docker run --env-file .env` (`README.md:133`, `docs/deployment.md:730`) | Docker CLI | `NAME=value`, `#` only at line start, values passed as-is. **No interpolation and no quote processing. Do not quote.** Quoting an `SMTP_PASSWORD` here puts the quote marks in the password. |
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
(`docs/deployment.md:40`, `:135-136`). Prose is where the reasoning goes and a
table is what somebody scans for a name, so a variable mentioned only in a
sentence is one an operator searching the tables concludes does not exist.

**The other three were a named exception rather than an omission, and the
exception is now five.** `SB_API_ORIGIN`, `SB_FRONTEND_PORT`,
`SB_MAX_UPLOAD_SIZE`, `SB_BILLING_CONFIGURED` and `SB_ADS_CONFIGURED` — rows of
the nginx table at `docs/deployment.md:863-872` — belong to the nginx container,
and no example file configures it: the root file serves the single container,
which has no nginx in it, and the compose recipe sets each of them on the
frontend service itself (`deploy/compose/compose.distributed.yml:309-333`),
where a value can carry the reason it is what it is. Their defaults are in the
image (`deploy/docker/frontend.Dockerfile:49-90`), so a deployment that changes
none of them has nothing to write down. This is the same shape as
`POSTGRES_PASSWORD` above: another image's variable, documented beside the file
that sets it.

**Three grew to five unrecorded, and that is this section's own warning
arriving.** The rule written just below is that an exception list which has
quietly become the rule proves nothing — and the way a list gets there is one
name at a time, each obviously belonging. `SB_BILLING_CONFIGURED` and
`SB_ADS_CONFIGURED` were added in 0.2.0, each correctly: both are derived in the
compose file from a server setting the examples already carry
(`${STRIPE_PUBLISHABLE_KEY:+true}` and `${ADSENSE_CLIENT_ID:+true}`), so writing
either into an example would invite an operator to set it twice and disagree
with themselves. The entries are right and the count went unwritten, which is
the failure mode to watch: the check kept passing because the list it compares
against is the same list that grew. The image's other three `SB_` names are
outside this exception for reasons of their own, and all three are in an
example — `SB_CSP_REPORT_ONLY`, because the server reads it too and registers
the report endpoint from its own copy, and `SB_TRUSTED_PROXY_CIDR` with
`SB_REAL_IP_RECURSIVE`, which an operator behind a terminator has to decide and
which no other setting can be derived from.

**House.** Renaming or removing a variable is a breaking change for every
operator, whatever a `0.y.z` version number formally permits. See the version
question under the container.

*Checked by:* `tests/env-example.test.ts`, in both directions over the two
examples the `docs/deployment.md` tables are about, with the two exception lists
written out and a third case holding each name to still being outside the rule
it is excused from — an exception list that has quietly become the rule proves
nothing. A second block runs from each example outward to the compose files
beside it, discovering the recipes by glob rather than listing them, which is
what put the `single` profile's two files under the rule the day they landed; a
third runs from `src/server` outward, so a name no example ever mentioned is
still checked against every compose file that runs the server. *Not checked:*
that `config.ts` and the deployment table agree on defaults.

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
expression, and `.github/workflows/release.yml:244-252` restates it rather than
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
`.github/workflows/release.yml:237-252`, where `docker/metadata-action` supplies
both on a published image.

**Settled, and it took the decision it was waiting on.** `base.digest` was
absent because the bases were pinned by tag, and pinning by digest was refused
while nothing watched Docker: `.github/dependabot.yml` covered npm and GitHub
Actions only, so a pin would have frozen `node:24-alpine` on the day somebody
typed it. That is the objection the fix has to answer rather than route around,
so the watcher came first. `.github/dependabot.yml:89-100` now watches Docker over
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
returns 200 or 503 (`src/server/api.ts:430-448`, and the same pair on the
scheduler at `src/server/scheduler.ts:30-38`). Both are registered above every
auth middleware and neither is authenticated.

The rule that generalizes best is already written in `docs/deployment.md:1036`: "A
process with the scheduler switched off is not an unhealthy one." A readiness
check that fails because an optional subsystem is off takes a working server out
of rotation. Readiness must not consult mail, and it must not consult the
scheduler.

**Binding.** `AGENTS.md`: "Startup must remain the only production migration path.
Keep migrations safe under the advisory lock and fail readiness on migration
failure." *Checked by:* `tests/migration-failure-startup.test.ts`, which makes
`runMigrations` fail and asserts that neither entrypoint calls `serve` or starts
the scheduler and that both exit non-zero. Every other startup test stands the
migration in as a success, so the failing half was asserted by nothing.

**House, and this is the interaction most container guides miss: startup, not
shutdown, is the slow half.** Migrations run at startup under advisory lock
724202607 and `runMigrations()` is awaited before `serve()`
(`src/server/index.ts:28,78`; `src/server/scheduler.ts:73,101`), so readiness
cannot open before they finish. The 0.1.5 notes record that the payee index
"takes a moment to build while the container starts, before it opens readiness"
(`docs/upgrades.md:1337-1339`). So the generous number is `--start-period`:
300s in all three Node images, the same budget the compose recipe's
`start_period` and the chart's startup probe give the same work, and the three
are held to each other. It was 20s in the images, which reported a first start
still migrating as unhealthy. Not the shutdown deadline.

**Settled, and the second half declined.** Both documents used to say
`/health/ready` "says configuration, the database, and the migrations have all
succeeded, and stays closed until they have", and readiness never knew anything
about configuration or migrations. Both now say what it does:
`docs/deployment.md:1027-1032` and `README.md:148-151` describe one statement
against the database and nothing else, and `src/server/api.ts:434-440` says the
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

**House, and it is about somebody else's container rather than ours.** A
readiness check against PostgreSQL connects over TCP, not over the unix socket.

The official image runs a *temporary* server while it executes the initdb
scripts, and that one sets `listen_addresses=''` — so it answers on the socket
and nowhere else. `pg_isready` with no `-h` therefore reports healthy against a
server that is about to be stopped and replaced, and whatever was waiting on that
answer connects into the gap and gets `FATAL: the database system is shutting
down`. `-h 127.0.0.1` forces TCP, which is only listening once the real server
is.

The obvious alternative — waiting longer, or retrying — treats a race as
flakiness. It is not: the check is answering truthfully about the wrong server,
and no timeout distinguishes the two.

The width of the window is what makes this worth a rule rather than a note. A
container with no initdb scripts closes it in milliseconds and the socket check
looks fine for years; one that ships an initdb script holds it open for as long
as that script takes. `deploy/docker/citus.Dockerfile` ships one to create the
extension, which is why the Citus image is where this was finally noticed —
after four other places had been written the wrong way. The `single` profile's
database machine is the case that proves the width: its initdb script creates
the application's role and transfers the database's ownership, so a socket check
there would report healthy while the application still had no account at all.

*Checked by:* `tests/deployment-docs.test.ts` ("goes over TCP everywhere, never
over the unix socket"), which reads every file in the repository rather than a
list — a list is the thing that was already wrong.

**Documents count, inside a fence.** Prose explaining the command is not a
command; a fenced block is one somebody copies. That distinction is not
pedantry: `docs/upgrades.md`'s own PostgreSQL major-version procedure told an
operator to wait on the socket and then restore, which is this exact failure
written into the instructions for avoiding a different one. The first version of
this test skipped documents entirely and did not see it.

**House.** A healthcheck reads its port from the environment rather than
hardcoding one. All four images do: the three Node images read `PORT`, the
frontend reads `SB_FRONTEND_PORT`. The frontend also probes `/` rather than
`/health`, deliberately, because `/health` is proxied to the API and a frontend
healthcheck should not go red because the API did
(`deploy/docker/frontend.Dockerfile:118-119`).

*Checked by:* `tests/dockerfile.test.ts` ("uses the configured PORT for its
readiness healthcheck"). The doc-versus-code readiness claim is checked by
nothing.

### A startup gate proves the database's shape, not that it answers

**House, mechanizable, and it is the rule the section above cannot supply.**
Where the database has a *topology* rather than only an address, what a process
has to wait for before it starts is that topology being complete — not a port
answering, and not a `select 1` returning. The gate goes in front of the
process, as an init container or its equivalent, and the process itself is left
alone.

The argument is in the chart and it is an observation rather than a worry.
`simple-balance.waitForDatabase`
(`deploy/helm/simple-balance/templates/_helpers.tpl:542-639`) is in front of
both application workloads (`server-deployment.yaml:65`,
`scheduler-deployment.yaml:58`) and blocks until every Citus worker group is
registered and active in `pg_dist_node`. It began as a TCP probe, which was
measurably the wrong check: Patroni opens 5432 as soon as the postmaster is up,
seconds before it registers the worker groups, so the probe passed and migration
`0023` ran into a coordinator with no workers. The cluster said so exactly:

```text
error: replication_factor (1) exceeds number of worker nodes (0)
SQL statement "SELECT create_distributed_table('user_preferences', 'user_id')"
```

**The deployment did come up, and that is the part worth reading twice.** The
pod crashed, Kubernetes restarted it, and by the second attempt the workers had
registered. A crash loop as the mechanism by which a deployment succeeds is not
a mechanism: it depends on the restart landing after registration, the window
widens with every worker group added, and the failure is inside the one
migration this project takes care to keep atomic.

**The obvious alternative is a readiness or startup probe, and §Health checks
has already disposed of it.** Migrations are awaited before the server listens,
so by the time anything can probe this process the failure has already happened
— a probe cannot gate what runs before the first probe is possible. That is the
same ordering argument that let readiness stay one `select 1`, used the other
way round: ordering is a guarantee where a probe would be a guess, and here it
means the guarantee has to be established *outside* the process.

**The second alternative is to ask with the superuser's credentials, and it
would undo a decision two files along.** The pod projects exactly one key out of
the database Secret — `ca.crt` — and the comment on that projection
(`server-deployment.yaml:146-161`) says plainly that naming the one item is what
keeps the superuser, replication and Patroni passwords out of a container that
has no use for them. An init container asking for `superuser-password` would
quietly reverse that, for a query any role can make: `pg_dist_node` is
world-readable. So the container takes the application's own connection string,
and mounts the CA volume the pod already has, because libpq reads `sslrootcert`
while it parses the string.

**Bounded, and the bound reports what it saw.** Ten minutes, then the container
fails with a message naming how many groups *did* register. Waiting forever
turns a cluster that is never coming into a pod nobody is told about; failing
with the count turns it into one line that says whether this is slow or wrong.

**It runs only where this chart runs the database.** A deployment bringing its
own `databaseUrl` gets no init container, because that database is somebody
else's to have running and a pod that waited on it would turn a wrong hostname
into a hang instead of an error.

Recurs twice over: for every deployment target whose database has a topology
rather than only an address, and for every process that runs migrations — which
here is both of them, since `src/server/scheduler.ts:73` awaits `runMigrations()`
exactly as `src/server/index.ts:28` does. A gate on the API alone would leave
the scheduler able to be the process that meets a coordinator with no workers,
and on a split deployment either may start first.

*Checked by:* `tests/operations-startup-gate.test.ts`, which holds that both
workloads include the gate, that it is conditional on the chart owning the
database, that it asks with the application's connection string and names no
superuser secret, that the condition counts worker groups rather than probing a
port, and that the timeout is bounded and its message names the count.

### Logging

**House.** Sentences to stdout, at the level the operator asked for, and no
second channel. The container's logs are the log; nothing writes a file, rotates
anything, or needs a volume.

**What each level gets, because a level nobody can predict is a level nobody
sets.** `info` is startup, mail, shutdown, and a scheduler tick that actually
proposed a row or sent a reminder. `debug` adds the ordinary work: a line per
HTTP request, per MCP tool call, per message handed to the relay, and per tick
that found nothing due. `warn` is a setting that is wrong and survivable.
`error` is something that failed, and is never silenced.

**And one line that ignores the setting entirely, which a section arguing for
predictability cannot leave out.** `log.announce`
(`src/server/log.ts:57-74`) prints at any level, including `error`. It is not a
fifth level and not a synonym for `info`: it is for a line the operator cannot
do their job without and has nowhere else to read. The first-run setup code is
the whole of it — a fresh production instance prints a one-time code and there
is no second copy, so `LOG_LEVEL=warn` turned a supported setting into a
deployment nobody could claim. The startup banner is deliberately not here,
because nobody is locked out by not knowing which port was logged, and that line
is what keeps `announce` from becoming the level everything is written at. This
is the exception a reader has to be told about rather than discover: a line
appearing under `LOG_LEVEL=error` otherwise reads as the gate leaking.

*Checked by:* `tests/log-level.test.ts`, which holds the call sites by name, so
a second caller is a failing test rather than a quiet widening.

The work lines shipped in 0.1.6 and the gap they closed is worth naming, because
it is the reason a line per request exists at all: a deployment with `/metrics`
off — which is the default — could not tell a working process from an idle one,
because everything this product did between starting and failing was counted and
never said. A scheduler that stopped ticking a week ago produced exactly the log
of one that was ticking every five minutes.

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

**A line names counts and ids, and never contents.** No payee, no amount, no
note, no subject line, no recipient, and no parameter bound into a failing
query — one of those is the OAuth access token the MCP token endpoint looks a
grant up by, and the rest are somebody's ledger. The narrowing is `log.failure`
(`src/server/log.ts:75-101`), which is one function rather than a line at each
transport because for a release it was a line at *one* transport: the HTTP
handler dropped the bound parameters and the MCP tool path logged the error
whole.

An id is allowed, and the difference from a metric label is deliberate: a label
costs a time series per distinct value and has to stay bounded, while a line
costs one line, and without the id the log says only that a request happened
somewhere.

*Checked by:* `tests/log-level.test.ts`, which holds three halves now — that the
gate drops what it should and never drops an error; that no file under
`src/server` outside the configuration layer names `console` at all, as a call
*or* as a value, which is how `logger = console` put the shutdown and scheduler
lines outside the gate for a release; and that the request, tool and query lines
carry the id and not the payee, the search term or the bound parameter.
`docs/standards/code/observability.md` is the call-site half of this.

### Metrics

**House, and off unless asked for.** `GET /metrics` answers in the Prometheus
text format, on the port everything else is served on, and only when
`METRICS_ENABLED=true` (`src/server/api.ts:341-343`). Registered rather
than refused: a deployment that never asked has no such route, which is the same
answer the MCP surface gives for a tool outside a token's scope.

Both entrypoints mount it, and the reason is worth stating because a split
deployment gets it wrong by omission: the API reports requests, tool calls,
ledger writes and its pool, and the scheduler reports ticks, proposals,
reminders, mail, the idempotency sweep and the billing reconciliation sweep.
Scraping only the API watches the process that does none of the scheduled work.
Every series carries `component="api"` or `component="scheduler"` so the two
never collide.

**Billing is the case that sharpened the argument, because it is the first fact
neither half can report alone.** `billing_webhook_deliveries_total` is the API's
and only the API's — five of the webhook route's exits reply
`200 {"received":true}`, so `http_requests_total` cannot tell a delivery that
granted or revoked an entitlement from one that was acknowledged and ignored
(`src/server/api.ts:1180`, `:1194`). `billing_sweeps_total` is the scheduler's,
and it is the twelve-hourly catch-up for the same subscriptions
(`src/server/recurrence-scheduler.ts:195-204`). An operator scraping one half
can be told that the webhook has been failing for hours, or that the sweep keeps
repairing something, and never both — and reading the sweep alone reports a
silently broken webhook as healthy right up to the tick that fixes it, which is
the wrong instrument for the question. Scraping only the API is the omission
this paragraph started with; scraping only the scheduler is the same defect
pointed the other way, and the billing path is where both are visible at once.

*Checked by:* `tests/scheduler-startup.test.ts` drives the app that entrypoint
hands to `serve`, so the route and the label are read from the process as
configured rather than from the source file — which is what the first attempt at
this check did, and it would have passed on a file that could not start.
`tests/integration/scheduler-metrics.integration.test.ts` starts the real
entrypoint against a real database and scrapes it, which is also where "serves
nothing else" is held: `/api/v1/accounts` on that port is a 404 rather than a
401, so a Service pointed there by mistake cannot half-work.

With a NetworkPolicy in front, both processes need the scraper named:
`networkPolicy.serverIngressFrom` for the API and
`networkPolicy.schedulerIngressFrom` for the scheduler. The scheduler's policy
allows any source in the cluster on its one port until `probeSourceCidrs`
narrows it, and narrowing it without naming a scraper shuts the scrape out of
the half that carries ticks, proposals and mail.

**Binding, and the rule the rest of this product already follows.** No label
carries somebody's identity: not a user id, not an email, not an account name,
not an amount. A metric is read by whoever can reach the endpoint, which is not
the person whose ledger it counts, and every query in `src/server/services` is
scoped by actor for exactly that reason. `tests/observability-guide.test.ts`
holds every published label to a list of bounded vocabularies, so a label nobody
has argued for fails by name. `tests/metrics.test.ts` held a list of label names
that would break it, read from a field `getMetricsAsJSON` never returns, so it
could not fail; it is gone.

The same rule keeps the cardinality bounded, which is the same defect wearing a
cost rather than a privacy label. A path with an id in it is counted under the
route pattern — `/api/v1/accounts/:id` is one series, not one per account — and
a path matching no route at all is counted under a single literal, because a
mistyped URL is exactly where unbounded labels come from.

**House.** `METRICS_TOKEN` is optional and is a secret in the `_FILE` sense,
one of the nine
(`src/server/config-files.ts:28-38`). Scraping over a private network with a
NetworkPolicy in front is a real deployment and demanding a token there would be
ceremony; publishing write rates and queue depths to the open internet is not,
and the two are indistinguishable from inside the process. So the token is
offered, the production case without one warns once at startup, and the bundled
frontend nginx does not proxy `/metrics` at all — a scrape goes to the API
service directly, so the browser's own hostname never exposes it
(`tests/dockerfile.test.ts:230-236`).

**House.** Collection is always on; only the endpoint is switched. It is not
free — the request middleware builds a label object per request and
`prom-client`'s default set installs a `PerformanceObserver` for garbage
collection — but it is small and constant, and gating it would put a branch in
front of every write in the product to save it. What the setting decides is
whether the endpoint answers, which is the part with a security consequence.

**The client is `prom-client`, and it is deprecated by rename.** npm prints
"prom-client has been replaced by @prometheus-io/client" on every install, and
the successor is the same project under the Prometheus organization. It is not
adopted here yet, and the reason is dates rather than doubt:
`@prometheus-io/client` first appeared on August 21, 2026 and has four releases,
the newest a day before this was written, while `prom-client@15.1.3` is what the
ecosystem runs. Taking a week-old package on the branch a release is being cut
from trades a deprecation notice for an unknown, which is the wrong way round.
The move is an import rename if the API held, and finding out costs one branch.
It is a row of the backlog below rather than a sentence here, for the reason
that table states: "revisit it in the release after this one" falls due the
moment 0.2.0 ships and nothing records it falling due, which is the shape of
promise this guide has already had to go back and clean up twice.

**Revisited at 0.2.1, and kept.** The successor had not moved: still 0.16.1,
four releases inside one week of August and nothing published since August 27,
2026, and still before 1.0. A release has no reason to take that in place of a
working, deprecated one, so the row moved to the next cut rather than lapsing.

*Checked by:* `tests/observability-guide.test.ts` for the labels;
`tests/metrics.test.ts` for the route pattern, the token and the absence of the
route when it was not asked for;
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
is 10,000 (`src/server/server-lifecycle.ts:3`), and a signal arriving while
draining forces the exit (`:104-107`),
which is the case most implementations miss and the one that makes Ctrl-C twice
behave the way a person expects. The compose file sets
`stop_grace_period: 30s` with a comment saying it is "Longer than the 10s drain
the process gives itself on SIGTERM (DEFAULT_SHUTDOWN_DEADLINE_MS), so it is not
killed mid-drain" (`deploy/compose/compose.distributed.yml:268-270`), and the
chart sets `terminationGracePeriodSeconds: 30`
(`deploy/helm/simple-balance/values.yaml:268`).

**Settled.** Both documented `docker run` commands now pass
`--stop-timeout 30` (`README.md:133-138`, `docs/deployment.md:730-737`). Docker's
default is 10 seconds, exactly the drain deadline, so the forced exit and
SIGKILL used to land in the same instant and the drain never got to finish.

*Checked by:* `tests/server-lifecycle.test.ts`, four cases covering the drain,
the deadline, the second signal, and never exiting twice. The relationship
between the deadline and any grace period is checked by nothing.

### Hardening

**House (OWASP Docker Security Cheat Sheet, rules 2, 3, 4 and 8).** Non-root
user, read-only root filesystem, all capabilities dropped, no new privileges.

All four are on every Simple Balance container now, and three of them always
were; the two services that run somebody else's image and keep part of it back
are named below, each with its reason. `USER node` in the
Node images and `USER 101` in the frontend (`Dockerfile:56`,
`deploy/docker/frontend.Dockerfile:46`). The documented run command passes
`--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m`. The chart sets
`runAsNonRoot`, `runAsUser: 1000`, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` and
`capabilities.drop: [ALL]` (`deploy/helm/simple-balance/values.yaml:250-265`).

**Settled.** `--cap-drop=ALL` and `--security-opt=no-new-privileges` are on the
documented `docker run` in both `README.md` and `docs/deployment.md`, and
`cap_drop: [ALL]` with `security_opt: ["no-new-privileges:true"]` reach the three
Simple Balance services in `deploy/compose/compose.distributed.yml` through one
`x-hardening` anchor. A Node HTTP server binding 3000 as a non-root user, and an
nginx binding 8080 as uid 101, need no capability at all, so this costs nothing
and closes the two routes a container escape usually takes. The Pulumi programs
deploy the chart, so they inherit the Kubernetes spelling at
`deploy/helm/simple-balance/values.yaml:250-265` and need nothing of their own.

**The one exception, stated because an unstated one reads as an oversight — and
it is about the Docker entrypoint, not about PostgreSQL.** Two services take it,
both running the `postgres:18` image under its own entrypoint:
`deploy/compose/compose.distributed.yml`'s bundled `postgres` (`:214-219`) and
the `single` profile's database machine,
`deploy/compose/single/compose.postgres.yml`'s `postgres` (`:248-256`). Both get
`no-new-privileges` and both keep their capabilities, because that entrypoint
starts as root, chowns the data directory and drops to the postgres user, which
needs CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE and CAP_SETUID/SETGID; dropping
them stops the container coming up at all.

**What proves it is the entrypoint rather than the database is the chart**,
which runs the same PostgreSQL with none of this. `database-statefulset.yaml`
replaces the image's entrypoint with Patroni directly
(`command: ["/usr/local/bin/patroni", …]`, `:103-109`), and that container runs
`runAsNonRoot: true` as uid 999 with `allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true` and `capabilities.drop: [ALL]`
(`:68-74`, `:110-114`). So the exception is not "a database needs capabilities".
It is "this image's startup script does its own `chown` as root", and the way
out of it is to not run that script — which the chart can do because Patroni
owns the data directory already, and which the compose recipes cannot, because
initialising a cluster from an empty volume is the whole of what that script is
for. State it that way round or the next `postgres` service copies the
exception without the reason.

**And that exception is now in a real deployment, which is a change worth
naming rather than leaving as an inherited comment.** It used to be true that
the only `postgres` here was `compose.distributed.yml`'s one-command trial, and
the sentence "it is not part of a real deployment" carried the argument. The
`single` profile's database machine runs
`deploy/compose/single/compose.postgres.yml` in production, so the exception has
to stand on its own. It does, and on three things rather than on one: that
machine has no public address and one inbound rule, 5432 from the application
node alone; the container publishes only on the machine's private address, with
`${SB_BIND_ADDRESS:?}` so an unset variable refuses to start rather than
publishing to everything; and `pg_hba.conf` is a mounted file whose every line
crossing a machine is `hostssl`, with the superuser refused over the network
entirely. That is the precise claim and it is narrower than "every network line
is `hostssl`", which is the sentence an operator would quote: one `host` line
survives, `postgres` over `127.0.0.1/32` with `trust`, and it is the health
check's. It grants nothing, because 127.0.0.1 is inside the container's own
network namespace — the published port reaches the container on its bridge
address, so no packet from off the machine can arrive with that source — and it
is `host` rather than `hostssl` deliberately, since `pg_isready` is answered
before authentication either way and a line that refused it would produce a
health check that still passed beside a `no pg_hba.conf entry` every ten
seconds. The capabilities the entrypoint keeps are reachable only by something
that is already on that machine, which is a different and much smaller claim
than "this is not production".

**The second exception is Caddy, and it was not recorded until a sweep found
it.** The `single` profile's TLS overlay, `deploy/compose/single/compose.caddy.yml`,
runs the official Caddy image, which runs as root, with no `read_only` and with
`NET_BIND_SERVICE` added back after `cap_drop: [ALL]`. It binds 80 and 443,
which is the one privileged thing it does, so it keeps that capability and
nothing else, and takes `no-new-privileges`, which costs it nothing. It is the
one service on the machine the internet reaches, which is why the shape is held
exactly rather than described. A read-only root filesystem is the half left
open: Caddy writes its certificates to the two mounted volumes and nothing else
should need writing, but nobody has run it that way, and a TLS proxy that fails
to renew a certificate in two months is not a change to make on a guess. It
goes in behind a test that renews against a staging CA.

**House.** Every install in an image resolves from a committed lockfile, and the
runtime stage carries production dependencies only.

*Checked by:* `tests/dockerfile.test.ts` for the lockfile rule ("Every install
must resolve from a committed lockfile, so the image cannot drift between
builds"), for the Alpine patch ordering relative to `USER node`, and for the
frontend's step up to root and back down to 101. `tests/deployment-docs.test.ts`
greps the documented run command for all five flags and reads the compose file
for both settings on the three application services, naming the postgres
exception when it fails, and holds Caddy to `cap_drop: [ALL]`,
`no-new-privileges` and exactly one capability added back. **The documented run command is the security surface
most people copy**, which is why it is the thing under test rather than the thing
described.

### What the release pipeline runs, and where it can write

**House.** The gates run against the exact commit being published, and that
commit is one the default branch already carries.

`release.yml` resolves the tag to a SHA once and hands it to `verify.yml`, so a
tag moved between the two jobs cannot verify one commit and ship another. The
cost of that design is the part worth writing down: a release event and a
dispatch both run in the default branch's context, so the suites, `npm ci` and
the Playwright browser all execute that commit's own code in a workflow whose
Actions cache scope is the default branch's. A tag pointing at a commit nobody
merged would be unreviewed code holding a token that writes the cache every
later run on the default branch restores from. That is CodeQL's
`actions/cache-poisoning/poisonable-step`, and it is a real step up from "can
push a tag" to "can plant something in the default branch's build".

**Settled by making the premise false rather than by not testing the tag.**
`.github/workflows/release.yml:119-151` compares the resolved SHA against the
default branch and refuses anything the branch does not already contain:
`behind` and `identical` pass, `ahead` and `diverged` do not. So the code that
runs in that context is code the default branch already has, and there is
nothing untrusted left to poison anything with. A release cut from a branch that
was never merged is refused, in those words, and that is the intended answer.

The alternative — dropping the ref and letting the release trust a `verify` run
from some earlier commit — was declined. "A tag can never ship an image that
would have failed the gates" is worth more than the finding, and this keeps
both.

The npm cache stays off whenever a ref is passed
(`.github/workflows/verify.yml:68`, `:118` and `:438`), which was the earlier
guard and is still right, but it was never sufficient on its own: the token
exists for the job whether or not this workflow chooses to cache with it.

*Checked by:* `human`, and by the refusal itself the first time somebody tries
to publish an unmerged commit. Nothing in the suite runs a workflow file, and a
test that asserted the shell string would pin the spelling rather than the
behavior. The four alerts CodeQL raised for this on the default branch, and the
two the browser job added, are dismissed against this paragraph rather than left
open to be rediscovered.

### A deployment profile is a shape, not a setting

**House.** Two profiles exist and the application does not know which one it is
running in. `docs/deployment-profiles.md` is the comparison; what belongs here is
the property that makes several shapes maintainable at all.

The differences are entirely about machines and how the database is arranged:
`single` is an application node against a PostgreSQL 18 on a second machine, and
`ha` is a Kubernetes cluster whose database is sharded with Citus — in two
shapes of its own, one node per service and fully redundant, which differ by
replica counts alone. Across all of them the application reads the same
settings, serves the same routes, and answers the same MCP surface. Nothing in
`src/` names a profile, and nothing branches on one.

That is what makes a dump portable between them — which is the property an
operator actually cashes, moving from `single` to `ha` by restoring a file — and
it is why `docs/deployment-profiles.md` can be a comparison rather than a manual
per shape.

**Two shapes of one profile is the same rule one level down**, and it is worth
saying because it was nearly a third profile. The small `ha` shape was `vps`, a
machine per service with a PostgreSQL of its own; it was deleted before it
shipped and became the chart at one replica. The reason is this rule: a separate
profile would have had a different database arrangement, so growing out of it
would have been a dump and a restore rather than a values file. Some Kubernetes
overhead at five pods is the price of that, and it is paid deliberately.

The obvious alternative is a `SB_PROFILE` setting selecting behavior. It is
wrong for the reason most mode flags are: every branch on it doubles the surface
that has to be tested, and the branches that matter are already expressed by the
settings themselves. Two profiles, three shapes — `single`, and the chart at one
replica per service and at full redundancy — and a deployment with no
`SMTP_HOST` degrades identically on every one of them, because the rule is about
the setting and not about the shape. Counting shapes rather than profiles is the
honest way to say it here: the argument against a `SB_PROFILE` flag is that the
branches would multiply with the *shapes*, and there are more of those than
there are profiles.

The one place the shapes genuinely differ is where the database is, and that is
answered without a flag too: `deploy/systemd/simple-balance-backup` works out
whether to dump from inside the deployment or over the network by reading the
Compose project's own service list. A setting there would be a second statement
of something the compose file already makes true, and the failure when the two
disagreed would be a backup that reported success against the wrong database.

**That branch survived the `single` profile growing a database**, which is the
test of it. The database is now on a machine this profile builds — but on a
different machine, so the application node's service list still holds no
`postgres` and the script still dumps over the network, with no line changed.
Had it been a `SB_PROFILE=single` check instead, it would have been a lie the
moment the profile stopped meaning "somebody else's database". One unit serves
both machines for the same reason, switched by `COMPOSE_FILE` in
`/etc/default/simple-balance` rather than by knowing which machine it is on.

*Checked by:* nothing mechanical, and honestly so — "no source file names a
profile" is greppable but would pass trivially and forever, which is a test that
looks like a guard and is not. What holds it is that the profiles share `src/`,
and a branch on shape would have to be written on purpose.

### What a new deployment target has to prove before it ships

**House.** A target is a machine shape, a cloud, a chart or a compose recipe
that somebody can run a ledger on. Six properties have to be true of it and
provable from the repository, and each is a property rather than an inspection:
something in a file says it, and a test reads the file.

The six are the rows at the bottom of this guide with no rule above them, and
that is why this section exists. Six checks arrived on this branch — one commit,
nine test files — for the `single` profile's two machines and the chart's
database, and not one sentence argued why any of them is the right property to
check. A reader adding a seventh target therefore met six obligations and no
reasoning, which makes adding a test exception the obvious move the first time
one is inconvenient. The reasoning below is what makes that the wrong move.

**Encryption at rest, set as a property wherever the provider makes it
optional.** Not "the provider encrypts by default" where a default is all it
is. On AWS it is not a default at all — EBS encryption by default is an account
setting that is off on a fresh account, so the property is the whole guarantee —
and a setting is invisible in `pulumi preview` where a property is not, and a
property can be tested. Before this, two uncommented lines of `encrypted: true`
in one program were the repository's entire at-rest story.
*Checked by:* `tests/single-encryption.test.ts`,
`tests/cluster-pulumi-database.test.ts`.

**Where the provider leaves no choice, the class says nothing, and that was
decided.** The cluster check read only the AWS program until it derived its
population from every program that builds a Kubernetes provider, and then found
the GCP and OCI classes stating no encryption. Google encrypts every persistent
disk and Oracle every block volume at rest with keys they manage, and neither
offers a way not to, so the only encryption parameter either driver has is a
customer key, which both programs decline for the lock-out reason they give.
This section used to ask for a property on every volume even where the provider
encrypts by default, which had no spelling on those two, and they sat in a
register of reported violations while it was open. The owner settled it in
0.2.1 by saying where the rule applies rather than by excepting the two
programs it did not fit, so the test now asks by driver: a class on one of those
two needs no property, and any other class does, a third cloud's included.

**The same sweep found Oracle's in-transit half had never been on.** The OCI
class asked for `attachmentType`, which the CSI driver does not read — its key
is `attachment-type` — and ignores without a word, so every cluster volume was
attached over iSCSI, which OCI does not encrypt in transit; and the node pool
never asked for in-transit encryption, which the driver reads from the node at
attach time. Both are right from 0.2.1. A volume keeps the attachment it was
provisioned with, so the fix reaches the volumes made after it, and the flag
reaches the nodes made after it.

**Encryption in transit, proved from the server's side.** The generated URL is
`sslmode=verify-full`; its `sslrootcert` is a path something actually mounts;
and every `pg_hba` line that crosses a machine is `hostssl`. The server refusing
is the only half that cannot be forgotten, because a client's `sslmode` is the
client's choice — and the obvious alternative, `sslmode=require`, is worse than
it reads: node-postgres treats it as verify-full without the file, so it fails
against exactly the certificate it is usually chosen for. The three strings have
to be one fact three times, and a handshake can only ever see one of them, which
is why there is a cheap check beside the expensive one. *Checked by:*
`tests/single-database-tls.test.ts`, `tests/compose-database-node.test.ts`,
`tests/helm-database-tls.test.ts`.

**Which ports each program opens, by source, exhaustively.** Exhaustively is the
property. A check that asserted "5432 is open to the application node" passes
just as happily on a security group that also opens it to the world, and a rule
added in a hurry is exactly the shape of mistake nothing else catches: `pulumi
up` does not complain, the deployment works, and the ledger is reachable. So
every rule is counted and every source named, and an unexpected one fails.
*Checked by:* `tests/single-ingress.test.ts`.

**Which address a published port binds to, with the public ones named.** A
Compose `ports:` entry with no address publishes to `0.0.0.0`, and on Linux
Docker writes its own DNAT rules ahead of the host firewall — so a mapping that
forgot its address is reachable from the network whatever `ufw` was told. That
one line is the difference between "PostgreSQL listens on this machine's private
address" and "the ledger is on the internet". The rule is not "everything is
loopback", because something has to serve the site: it is that every mapping is
loopback, or `${SB_...:?}` so an unset variable refuses to start rather than
defaulting to everything, or on a short list of deliberately public ports with a
reason each. *Checked by:* `tests/compose-bind-address.test.ts`.

**A `reverse_proxy` upstream names a service that exists, on a port it listens
on.** Checked against the *command* the overlay documents rather than the
directory the file sits in, because the directory is not what is brought up. The
opposite shipped and was never noticed: a Caddyfile copied byte for byte between
profiles said `reverse_proxy app:3000` at a project declaring no `app`, and
Caddy resolves an upstream lazily — so the container started, passed its
admin-API health check, and returned 502 to every request. A documented TLS path
that had never worked. *Checked by:* `tests/caddyfile-upstream.test.ts`.

**A `NetworkPolicy` in front of the database, with the control plane separated
from the data.** Two ports reach a database pod and they are not the same kind
of thing: 5432 is the ledger, and Patroni's REST port is where `/switchover`,
`/failover`, `/restart` and `/reinitialize` live. Before the policy existed the
first was open to every pod in the namespace and the second to every pod in the
cluster. *Checked by:* `tests/helm-network-policy.test.ts`.

**What the six have in common is the thing to carry to a seventh target.** Each
is a property a file states and a test reads, rather than an audit somebody
performs; each fails closed, so a target that forgot one does not ship; and each
names the *failure* rather than the control, which is what keeps it from being
negotiated away. Where a property cannot be a file's — a credential that only
the provider can answer for — the next rule is the shape it takes instead.

*Checked by:* the six tests above, one per property, and by nothing holding the
list itself to the targets that exist. That last gap is honest rather than
cheap: a test asserting "every target has six checks" would need to know what a
target is, and the repository's own answer to that is a directory somebody
chose.

### A key is accepted, never created

**House**, and it sits under the rule above as the one property that is a
decision rather than a measurement. A customer-managed encryption key is
accepted from the operator, validated before anything is built with it, and
never created by the program that uses it.

**Refusing late is useless, which is what makes this a plan-time check.** Both
single-machine programs refuse at plan time unless the key is enabled,
customer-managed, symmetric and encrypt/decrypt
(`deploy/pulumi/aws-single/platform.ts:157-189`, and `readKmsSelection` with
`requireUsableKmsKey` in `deploy/pulumi/oci-single/platform.ts`). AWS writes the
reason itself: a disabled key has no effect on a running instance, because EBS
encrypts disk I/O with the data key held in the Nitro card. So nothing breaks
while the volume stays attached, the failure lands on the next detach and
reattach, and that may be after the deletion window has closed — at which point
the volume is unreadable by anybody, its owner included. A check that ran at
first use would be a check that ran at the reboot.

**Creating the key with the stack is refused, and the AWS program already states
why** (`deploy/pulumi/aws-single/index.ts:138-159`): a key this program made
would have the *stack's* lifetime, and that is the wrong lifetime for the thing
that decrypts a ledger. `pulumi destroy --exclude-protected` is this
repository's own documented teardown and it deliberately keeps both data
volumes, so a created key would be scheduled for deletion beside the disks it
was keeping — thirty days, after which AWS says the data is unrecoverable and
that the same key material in a new key will not decrypt it. Accepting keeps the
program's blast radius at "machines and disks" and never at "the key that reads
them". An operator who wants a customer-managed key has one, or has a policy
saying where keys come from.

**The one key a program does create is outside that argument, and is checked to
stay there.** `oci-single` keeps the stack's settings in OCI Vault, which holds
no secret outside a vault, so with no `kmsVaultOcid` named it creates a vault
and a software key for them. The argument above is about what a deletion
countdown does to *data on disk*, and nothing on disk is encrypted with this
key: a destroyed stack's settings go into pending deletion with only the
settings in them. `tests/single-customer-keys.test.ts` holds both halves — that
the settings vault and key are the only `oci.kms` resources the program
creates, and that no volume or instance is handed that key.

**Unset means the provider's own key, which is already encryption at rest**, and
it has to pass `undefined` rather than the empty string: `kms_key_id` is
Optional+Computed on an EBS volume, so `""` diffs against the ARN AWS fills in
and plans a replacement on a stack whose operator set nothing at all. Naming an
AWS-managed key is refused for the same reason from the other end — it is what
unsetting already does, spelled in a way that suggests otherwise.

Two clouds implement it today and the shape generalizes to any third, because it
is the infrastructure form of a rule this guide already keeps for secrets: the
value is the operator's, this product reads it and never mints it, and the thing
that goes wrong when it is wrong is somebody else's data being unreadable.

*Checked by:* `tests/single-customer-keys.test.ts` — that each refusal fires with
the message naming how to recover, that both programs accept a key and create
none, that the key reaches every encrypted disk including OCI's boot volumes,
that a stack naming none passes `undefined`, and that the refusal happens before
any disk is registered, which is what `--skip-preview` needs. An HSM key warns
rather than refusing, because it is usable, billed and permanent.

### A setting that saves money names what it takes away

**House.** `simple-balance:databaseEgress` chooses the database node's way out
on AWS and is the largest single line in a `small` bill: a NAT gateway is about
$36.50 a month against that stack's $96, and $32.85 of it is the hour rather
than the bytes, so moving less data saves nothing. Two cheaper ways out
exist — `ssm` at about $14.60, `ipv6` at nothing at all
(`deploy/pulumi/aws-single/platform.ts:263`,
`deploy/pulumi/aws-single/platform.ts:387`). Each gives something up, and the
rule is about what happens to the thing given up.

Three properties hold it, and they are the ones to carry to the next priced
choice rather than the dollar figures, which will age.

**Unset builds what the stack built before the setting existed.** Blank and
absent both resolve to `nat`, and the comment at
`deploy/pulumi/aws-single/platform.ts:391-394` says why a blank is not a third
value: `pulumi config set ... ""` and an empty key in a stack file arrive
identically, and refusing them would refuse a stack that asked for nothing. That
half is not a preference — `AGENTS.md` §A release upgrades cleanly from the
one before it requires it of configuration, and a Pulumi stack is
configuration an operator already has.

**What the cheap option removes is replaced or refused, never dropped.** `ipv6`
takes Session Manager away from the machine holding the ledger: the agent
resolves an IPv4-only endpoint and the subnet has no IPv4 route once the gateway
is gone. So `ipv6` without `simple-balance:sshPublicKey` is refused outright
(`deploy/pulumi/aws-single/platform.ts:410`), because the alternative is a
routing setting that silently leaves no way onto the database node at all.
`ssm` demands no key for the opposite reason, stated where somebody would
otherwise add one as a safeguard: it buys the agent's shell back with two
interface endpoints, so it has nothing to replace — and a key it never uses
would still plan two instance replacements, since EC2 cannot give a running
machine a key pair.

**The refusal carries the recovery, including the part that happens later.**
Both messages name the setting, the three values, what each costs and the exact
`pulumi config set` to run. The `ipv6` refusal goes further and names the
downtime an operator meets *after* doing as they were told — two rebuilds,
the database node deleted before its replacement because its address is pinned,
the ledger surviving on separate protected volumes. A surprise outage inside a
change about routing is the failure this paragraph exists to prevent.

The obvious alternative is to default to the cheapest way out and document the
trade-off in `docs/deployment.md`. It is wrong twice over. A changed default
rebuilds the network of every stack that upgrades without asking, which is the
upgrade rule broken by a line nobody edited; and a trade-off that lives only in
prose is one an operator meets after `pulumi up` has already removed their only
shell. A document cannot refuse, and this one has to.

*Checked by:* `tests/single-database-egress.test.ts` — that unset, blank and
`nat` are the same answer; that `ipv6` without a key is refused naming Session
Manager and the setting that fixes it; that an unrecognized value is refused by
name rather than falling back; that the NAT gateway and its address are built
for `nat` alone; that the private subnet gets one default route and never both;
and that the printed shell is one that works for the choice rather than one that
hangs.

### An image we build for a dependency carries the dependency's version

**House.** This project builds five images. Four are Simple Balance and are
tagged with its version; the fifth is PostgreSQL with Citus, and is tagged
`14.2.0-pg18` — Citus's version and PostgreSQL's, not ours.

Coupling it to `APP_VERSION` would rebuild a database on every application
release that never touched it, and would print `0.2.0` on an image whose contents
are decided by somebody else's release cycle. So `scripts/set-version.mjs` does
not know `deploy/docker/citus.Dockerfile` exists, and
`.github/workflows/citus-image.yml` publishes it on its own trigger rather than
from `release.yml`.

**There is deliberately no `latest`.** A PostgreSQL major version cannot read the
previous major's data directory, so a floating tag on a database turns an image
pull into an outage. Both tags it publishes name a version, and the shorter one
moves only within a PostgreSQL major.

**The obvious alternative was to adopt the image Citus publishes, and it does
not work — from either direction.** Of its hundreds of tags exactly one carries
arm64, and that one is Alpine; every `-pgNN` tag is amd64 only, by construction,
because upstream's publisher hardcodes the platform for every image type except
alpine. So the architecture this project builds for and the libc it needs do not
meet in any artefact upstream ships. Adopting the amd64 one and dropping arm64
would be choosing the platform over the ledger, and adopting the alpine one would
be choosing musl — which is the one base this application must not have.

**Building somebody else's software brings three obligations the other four
images do not have.** The base is pinned by digest and the source by checksum,
because a tarball fetched over the network and compiled into a database holding
people's money is exactly where a substitution would be worth making. The libc
is a correctness decision rather than a size one: this application compares
normalized category and payee names with the database's collation, and musl
compares byte-wise whatever collation is declared, so the image is Debian and
`docs/deployment-sizing.md` carries the measurement. And its telemetry is off —
Citus reports usage home by default wherever libcurl is compiled in, which on
PostgreSQL 18 cannot be avoided, so it is turned off where it is really decided
rather than compiled out.

**The build reads the artefact it is about to ship.** The first version of that
Dockerfile passed `--without-libcurl`, reported success at every step, and
produced a database that could not start: PostgreSQL 18 defines `HAVE_LIBCURL`
for its own OAuth support, so Citus's `#ifdef` found it and compiled statistics
collection that was never linked. A configure flag is a request; the binary is
the answer.

*Checked by:* `tests/dockerfile.test.ts` ("the database image"), which holds the
three obligations above — a base pinned by digest through the `ARG` that names
it, a pinned and verified source checksum, and labels that do not claim this
product's version. It is deliberately a separate population from the four app
images rather than a fifth entry in their loop: two of that loop's assertions are
wrong for this image, and adding it would have meant weakening them.

And by `.github/workflows/citus-image.yml`, which builds each architecture
natively and then *starts* the image and asks it what it is — that the extension
loads, that telemetry is off, and that the collation orders accented text the way
glibc does rather than the way musl does. A build that succeeds says nothing
about a database that starts, which is the failure this exists to catch.

### One process, one database

**Binding.** `AGENTS.md`: "PostgreSQL is the only persistent dependency. Do not
add Redis, SQLite, an object store, sidecar, or writable-volume requirement."

**House.** The image makes no outbound connection nobody configured. Four exist,
each behind a setting: PostgreSQL (`DATABASE_URL`), SMTP (only when `SMTP_HOST`
and `MAIL_FROM` are both set), Google's OAuth endpoints (only when `AUTH_MODE`
includes `google`), and Stripe (only when the five `STRIPE_*` settings are set).
No telemetry, no update check, no CDN, no font host. `src/server` contains no
`fetch(` call at all.

**The browser is counted separately, and since advertising landed it has to
be.** On a deployment that configures no AdSense ids — the default, and every
deployment that upgraded into 0.2.0 from a release before it — the bundle is served under
`default-src 'self'` and the browser reaches nothing but this origin. On one
that does, it reaches Google: the ad script, the ad frames, the consent
message's own styles and fonts, and measurement beacons, to hosts Google
declines to enumerate. That is a real cost and it is the operator's to accept,
which is why ads are off unless asked for and why `docs/monetization.md` states
the cost in the operator's own words before they turn it on. The two claims are
kept apart because they are different promises to different people: what the
*server* connects to is this project's word, and what the *browser* connects to
is the operator's choice.

Stripe is the one that arrives with a library rather than a URL, and the library
opts into telemetry by default — a fifth connection nobody configured, switched
off in `src/server/stripe.ts` with the reason written beside it. One module
imports `stripe`, so `grep -rn 'from "stripe"' src` answers the whole question in
a line, which is the property that makes the promise checkable at all.

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
a bad value since a release that accepted it. "At startup" holds for six of the
seven; `IDEMPOTENCY_RETENTION_HOURS` warns at its call site and is a row of the
backlog, and this sentence says so rather than rounding up.

*Checked by:* `tests/outbound-connections.test.ts`, and only since 0.2.0 — this
rule carried "not checked mechanically" for four releases, on the fair ground
that an allow-list of network calls did not exist. What changed is that Stripe
arrives as a *library* rather than a URL, the first dependency able to open a
socket without anything here naming a host, and the way that was made safe was
to confine it to one module. That confinement is what made the promise
answerable by reading one file. The test holds three things: `src/server` makes
no bare `fetch` call, exactly one module imports `stripe`, and that module turns
the SDK's own telemetry off.

*Still a reviewer's job:* a **new** vendor library. No test can know that a
package it has never heard of talks to the network, so another connection
arrives unannounced unless somebody notices the dependency. That is the honest
residue of this rule rather than a gap worth pretending away.

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

*Checked by:* `tests/version.test.ts`, which pins every location `npm run
set-version` writes — found rather than listed, so the count is left out here
for the reason `writing.md` §Versioning gives — and also checks that the script
mentions each path, so a location the script forgets fails the suite. Nothing checks that
a renamed variable moved the version.

---

## What is checked, and what is not

| Rule | Check |
| --- | --- |
| Booleans and closed sets refuse an unrecognized value, naming the variable: all four booleans `getConfig` reads and its three closed sets, and `SMTP_SSL` and `SMTP_PORT` beside the mail settings | `tests/config.test.ts`, `tests/mail-settings.test.ts` |
| `APP_BASE_URL` is an exact origin, HTTPS off loopback | `tests/config.test.ts` |
| A non-production process with a real `APP_BASE_URL` refuses to start | `tests/config.test.ts` |
| A bounded integer outside its range warns at startup, naming the variable, and runs at its default | `tests/config-limits.test.ts`, `tests/config.test.ts` |
| Half a mail configuration refuses; ports, address forms, credentials pair | `tests/mail-settings.test.ts` |
| A password is never sent to a relay that refuses to encrypt | `tests/mail-settings.test.ts` |
| Healthcheck reads `PORT` | `tests/dockerfile.test.ts` |
| `title` and a build-argument `version` label | `tests/dockerfile.test.ts` |
| Alpine patch applied before dropping to `USER node`; frontend returns to 101 | `tests/dockerfile.test.ts` |
| Lockfile-only installs, production-only runtime, both lockfiles resolve alike | `tests/dockerfile.test.ts` |
| Entrypoints name files the compiler emits; nginx proxies every API prefix | `tests/dockerfile.test.ts` |
| Drain once, force-exit on deadline, force-exit on a second signal | `tests/server-lifecycle.test.ts` |
| The version reaches every place it is written, found rather than listed | `tests/version.test.ts` |
| The published placeholder secrets are refused in production | `tests/config.test.ts:325-339` |
| The template reminder's subject is exactly `Reminder: <name>` | `tests/integration/notifications.integration.test.ts:216` |
| Every message declares itself auto-generated | `tests/mail-headers.test.ts` |
| A subject leads with its fixed part, and a long name is cut by code point | `tests/mail-subjects.test.ts` |
| A failed send names the message and not the subject, and drops the recipient's address | `tests/mail-logging.test.ts` |
| A failed scheduled send names the notification row: both senders set `about` to an id, after the spread, and the id reaches the log line | `tests/operations-defaults-and-send-failures.test.ts` |
| `config.ts` defaults and the deployment table agree, every literal default in the table either read back from the running configuration or argued to be nginx's | `tests/operations-defaults-and-send-failures.test.ts` |
| A name that reaches a mail subject cannot carry a line break, a control character or a DEL, over the create and the update schema of both records, with a positive control so the refusals cannot pass vacuously | `tests/subject-header-injection.test.ts` |
| Every unprefixed setting name in the four example files, the compose files, the Caddyfile and `config*.ts` is accounted for by name — a platform convention, a vendor's spelling, or frozen in 0.1.x or in 0.2.0, the last pinned to its nineteen — and no grant outlives the variable it names | `tests/deploy-settings-naming.test.ts` |
| Only secrets and always-set variables are assigned in either example file; the quoting warning sits beside each `SMTP_PASSWORD` | `tests/env-example.test.ts` |
| The example files and the deployment tables name the same variables, both directions, exceptions listed | `tests/env-example.test.ts` |
| The deliverability section exists, the README and `.env.example` point at it, and it cites no RFC | `tests/deployment-docs.test.ts` |
| The documented `docker run` carries all five hardening flags; the compose services carry both settings | `tests/deployment-docs.test.ts` |
| Nine labels on all four images, `base.name` and `base.digest` matching each file's own runtime `FROM`, and no stage built on a tag that can move | `tests/dockerfile.test.ts` |
| The scheduler checks its mail transport at startup and closes it on shutdown | `tests/scheduler-startup.test.ts` |
| No metric label carries an identity, a path is counted under its route pattern, and `/metrics` is absent unless asked for and refuses without its token | `tests/metrics.test.ts` |
| Every line goes through the `LOG_LEVEL` gate outside the configuration layer, an error is never silenced, and a caught error that is dropped says why | `tests/log-level.test.ts` |
| Encryption at rest is set explicitly on every volume the single-machine programs build, and on every cluster StorageClass whose provider makes it optional; Oracle's cluster volumes are attached paravirtualized on nodes that encrypt the hop | `tests/single-encryption.test.ts`, `tests/cluster-pulumi-database.test.ts` |
| Encryption in transit to the database: the generated URL is `verify-full`, its `sslrootcert` is a path something actually mounts, and every `pg_hba` line crossing a machine is `hostssl` | `tests/single-database-tls.test.ts`, `tests/compose-database-node.test.ts`, `tests/helm-database-tls.test.ts` |
| Which ports each program opens, by source, exhaustively — nothing on the database node from `0.0.0.0/0`, nothing anywhere on 3000 | `tests/single-ingress.test.ts` |
| Which address a published port binds to, in every compose file, with the three deliberately public ones named | `tests/compose-bind-address.test.ts` |
| A `reverse_proxy` upstream names a service that exists in a compose file beside it, on a port it listens on | `tests/caddyfile-upstream.test.ts` |
| The database's `NetworkPolicy` admits 5432 from the API and scheduler only, and Patroni's REST port from database pods only | `tests/helm-network-policy.test.ts` |
| No unconfigured outbound network call: `src/server` makes no bare `fetch`, one module imports `stripe`, and that module declines the SDK's telemetry | `tests/outbound-connections.test.ts` |
| A customer-managed key for the disks is accepted and never created, an unusable one is refused at plan time, and the settings vault's key reaches no disk | `tests/single-customer-keys.test.ts` |
| A deployment program's application settings are the stack's two maps, checked at plan time, and reach the workload through the cloud's secret store and never through user data | `tests/app-settings.test.ts`, `tests/cloud-init.test.ts`, `tests/systemd-scripts.test.ts` |
| Both application workloads wait for every Citus worker group to register before the process that runs migrations starts | `tests/operations-startup-gate.test.ts` |
| A cheaper way out of the database subnet is a named choice, unset is the NAT gateway every older stack has, and the one that removes the shell is refused without the key that replaces it | `tests/single-database-egress.test.ts` |
| Each of the two machines is sized from its own row, neither node is handed the other's shape, and the application node never has more memory or cores than the database node | `tests/single-node-sizing.test.ts` |
| The database machine runs the tuning its capacity numbers were measured on, with every departure named, and a grown volume becomes grown space at boot | `tests/single-host-sizing.test.ts` |

Not checked mechanically, ranked by how cheap the check would be:

1. **Landed.** `oneLine` refuses CR and LF, which is what closes header
   injection: `tests/subject-header-injection.test.ts`, over both the create and
   the update schema of each of the two named records. Kept here with its number
   because the items around it are cited by position.
2. **Landed in 0.2.1.** `IDEMPOTENCY_RETENTION_HOURS` is read at startup like
   the other six bounded integers, and `tests/config-limits.test.ts` takes the
   population from the module's exports.

Items 1 and 3 were the defaults and the failed send, and both are in the table
above. The failed send is the one worth recording: its code half was already
done — both scheduled senders pass the id — and nothing kept it done, which is
the same shape as the outbound-connection row below, and the override being
*after* the spread is the half a reader would not think to protect.

The outbound-connection row moved out of this list and into the table above, and
the move is the one worth recording: it was *in this list while the section that
argues it already named the test that holds it*. A guide denying in two places a
check it cites in a third is the worst state of all — worse than silence,
because a reader who finds the denial first concludes the promise is unproven
and writes a second test, or deletes the first.

Review only, because no test can judge them:

- Whether a message's content sits in the right tier. What makes a sentence a
  disclosure is a judgement about a reader.
- Whether a variable's documentation answers the seventh question, "what happens
  when it is wrong", in words an operator can act on.
- Whether the release still refuses a tag the default branch does not contain.
  Nothing in the suite runs a workflow file, and a test that asserted the shell
  string would pin its spelling rather than its behavior. The refusal itself is
  the check, and it happens the first time somebody tries.

A rule in neither list is a rule nobody is responsible for, and that is a defect
in this guide rather than in the code.

---

## Work to do

Collected, with the file and line, so this section is a backlog rather than a
mood. A row leaves this table when the work lands and a test holds it, never
when somebody remembers it differently: two rows here once described finished
work for a release, one of them contradicted three lines away by a paragraph
marked **Settled**.

The four rows this table last carried have landed, and each is recorded above as
**Settled** with the test that holds it: the bounded integers are read at
startup and warn by name, the two example files and the deployment tables name
the same variables with the exceptions written down, every image pins its bases
by digest and labels them, and the scheduler checks the transport it sends every
scheduled message over.

Five rows replace them, and each meets the criterion this table sets — work this
guide argues for and the code does not do, or a question this guide opened and
nobody owns until it is written down with a date on it.

| What | Where | Why it is a row |
| --- | --- | --- |
| The `_FILE` secret form is unreachable through the orchestrated paths this guide argues from | `deploy/helm/simple-balance/templates/server-deployment.yaml:72-85`, `deploy/compose/compose.distributed.yml:50`, `:71` | The chart *can* mount a Secret and chooses not to for these nine names: both workloads already project `ca.crt` out of the database Secret by key and mount it, so the mechanism exists and is pointed at a different file, while the application's own credentials still arrive through `envFrom`. Both compose files write `DATABASE_URL` inline and make `AUTH_SECRET` a required interpolation. The application supports the form everywhere and a `docker run` reaches it with a bind mount, so this is the chart and the compose files rather than the resolver. A `secretFiles` values block projecting the named secrets the way `database-ca` already is, and setting each `NAME_FILE` to where it landed, plus a commented `secrets:` stanza, are what would close it. It narrowed rather than widened in 0.2.0: the `vps` profile that took the same shortcut was deleted, and the `single` profile's machines fold `env.db` and `secrets.env` into `.env` on every start, which is a file on disk doing the job `_FILE` would |
| `METRICS_TOKEN_FILE` has no consumer-side proof | `src/server/config-files.ts:28-38` | Eight of the nine `_FILE` names are read back through the consumer that has to end up holding the value, both Stripe secrets included. That one rests on the resolver's registry alone, so a name added there and never wired to the scrape endpoint would look identical |
| `prom-client` is deprecated by rename | `package.json` | §Metrics declines `@prometheus-io/client` for a stated reason — four releases, the newest a day old, against the version the ecosystem runs — and that reason expires with time rather than with a decision. **Due at the cut after 0.2.1**, having been due at 0.2.1 and kept there because the successor had published nothing for six weeks and was still before 1.0. The move is an import rename if the API held, and finding out costs one branch. It is here rather than in that section because "revisit it next release" falls due the moment this one ships and nothing else records it |
