# Changelog

Notable changes, newest first.

## 0.2.1 - 2026-10-06

Everything below except the `oci-single` fix came out of a full smoke test of a
0.2.0 deployment — the browser app, the HTTP API, the MCP surface and billing
against a Stripe sandbox.

### Changed

**Moving from monthly to annual asks first.** It is the one plan change that
charges a card the moment it is pressed, and it did so on a single click. The
plan tab now says the annual plan starts today, that what is left of the month
is credited and the difference is charged now, and charges nothing until that is
confirmed. Nothing else asks: a move to monthly waits for the renewal, canceling
runs to the end of the period, and both are undone on the same tab, so canceling
stays exactly as easy as subscribing.

**A frozen account can be archived or deleted.** After a downgrade, every
account past the free plan's three refused every change, including being put
away, so somebody with thirty accounts who wanted to clear out the ones they no
longer use had to upgrade first or swap each one into use and out again. Archive
and delete now work on a frozen account, from the Accounts page and from an
agent alike. Neither gives anything a place, because a frozen account never
held one, and an archived account still needs a free place to come back, so the
limit is exactly where it was. Its entries and details stay closed to change.

**Oracle's `small` database node has 8 GB.** Oracle halved its Always Free
Ampere allowance on June 15, 2026, to 2 OCPUs and 12 GB, so a `small` pair's
four cores are about two past it, about $14 a month, whatever this release does.
The memory the allowance still covers now goes to the database node, which takes
the ledger PostgreSQL holds entirely in cache from 2.8M transactions to 6.3M at
no cost, and its PostgreSQL settings move with it. AWS is unchanged. `pulumi up`
resizes a running stack's database machine in place, which restarts it, and
`docs/upgrades.md` has the settings for a machine built before this.

### Fixed

**Older activity no longer skips the rest of an import.** Every change one
import or one mass edit makes is recorded at the same instant, and paging back
through the activity history asked for entries earlier than that instant, so a
page boundary inside an import skipped every entry of it after that page. Each
page now picks up exactly where the last one stopped.

**Opening a staged refund or a recurring refund to edit it keeps it a refund.**
A row or a recurrence naming a category that did not exist yet, with the answer
that it was a refund, lost that answer when it was opened in the form and
saved, and committed as income. The answer is shown and kept, on a split for
each part separately.

**An entry made from a template that has since been deleted can be edited
again.** Every save of it, a restore after deleting it, and any mass edit that
included it were refused because the template was gone.

**The Oracle cluster's volumes are encrypted on the way to the disk.** Its
StorageClass spelled the attachment key the way Oracle's CSI driver does not
read, and the driver ignored it, so every volume was attached over iSCSI, which
Oracle does not encrypt in transit, and the node pool never asked for in-transit
encryption either. New volumes are attached paravirtualized on nodes that
encrypt the hop. Volumes and nodes that already exist keep what they were made
with, and at rest every Oracle and Google volume was encrypted all along, by the
provider's own key.

**Saving something without changing it no longer makes every other copy of it
stale.** An unchanged save of a transaction, account, category, group, budget,
template, recurrence or staged row rewrote the row and bumped its version, so a
second tab or an agent holding the same record was refused its next save over a
change nobody made. Such a save now writes nothing — no new version, no audit
entry, no posting — and so does archiving something already archived or
deleting something already deleted. A mass edit writes only the rows its change
actually changes, and its count says how many that was.

**MCP connections no longer hold a server open for nothing.** The endpoint is
stateless, and it answered every client's `GET` with an event stream that could
never carry a message and stayed open, one connection and one server instance
per connected agent. It now answers `405`, which MCP clients read as "no stream
here".

**The session cookie's secret stays out of page script.** The cookie is
`HttpOnly`, and the sign-in, sign-up, session and session-list answers handed
the same value back in JSON anyway, readable by any script running on the page
— and while advertising is on, the page allows scripts from any HTTPS origin.
Those answers no longer carry it.

**Forms say what is wrong next to the field that is wrong.** A refusal from the
server listed its sentences at the top of the account, transaction, template
and recurrence forms and nowhere else. Each sentence now also appears beside the
field it is about, which is marked invalid, and each line of the summary at the
top is a link that takes you to that field.

**Focus stays where you are working.** A button that was busy dropped focus, so
the next Tab started from the top of the page; the result of a bulk edit, or of
anything confirmed in a dialog, never received focus; deleting or restoring a
single transaction said nothing at all; opening the menu on a phone left focus
behind it, and following a link from it pulled focus back out of the page it
opened. All of these now land focus on the button that is still there or on the
sentence saying what happened. The menu button says whether the menu is open,
and a deleted transaction is labeled "Deleted" in words as well as struck
through.

**A refused delete says so where you can see it.** Deleting a category or an
account that is still in use put the refusal at the top of the page, often far
above the row, beside an earlier success message that was no longer true. The
refusal now names what was not deleted, takes focus, and replaces the old
message.

**A CSV import no longer picks an account for you.** With several accounts, the
first one alphabetically was already chosen, one press from staging a whole file
into an account nobody had named. It now asks, unless there is only one.

**Two accounts can no longer be told apart only by capital letters.** Account
names were the one kind of name compared exactly, so "Checking" and "CHECKING"
could both exist. They are now compared the way categories and payees are.
Accounts that already differ only that way are kept.

**A recurring transfer between an account and itself is refused when it is
made**, rather than accepted and then filling the staged queue, every time it
came due, with a row nobody could commit.

**Pages that were hard to read on a phone or a screen reader.** A very large
balance pushed the overview and accounts pages sideways at phone widths, and
now wraps. The budgets forecast showed one table per currency with nothing on
screen saying which currency each was. Transfers read "Uncategorized" on the
transactions list, which looked like work left undone, and now show a dash as
the staged queue already did. A split's remaining amount read "10 left to
assign" with no currency and "-65.5 left" when over-assigned; it is written as
money, and over-assigning says so. The activity history read like code —
"Create from stage transaction" — and never said which record changed; each
line now says what happened, in words, and names the record. And the
add-category form called a kind "Both" that the rest of the app calls "Income
or expense", while the question about what kind a new category is had no
visible wording at all.

**A link that fails says so.** A failed sign-in or MCP authorization link
landed on the overview with no word of what had gone wrong, and a report name
nobody knows showed net worth under the wrong address. The first now gets a page
that says what happened, and the second goes to Reports.

**Pages fit their window, and numbers start at their currency's decimals.**
Staged, with a duplicate waiting, was wider than an 820px window and broke its
duplicates button over two lines on a phone; header actions now drop to a row of
their own instead. Dates in the staged queue, the import preview and Recurring's
next column broke onto three lines in a narrow table, and now stay whole. An
account opened for editing showed its starting amount to eighteen decimal
places, and a transaction or budget dropped its cents to "12.5"; every amount
field now starts at the currency's own decimals. When the accounts list failed
to load, the add buttons said to create an account first; they now say the
accounts did not load. The duplicate review no longer opens with the cursor in
its second form, a badge's icon no longer touches its words, and a staged row
missing a field names the field to fill in rather than repeating a type error.

**Two edits at once no longer deadlock.** Editing an entry or a staged row so it
no longer names a category, while another write named a category on a
different account, could stop both and fail one of them with a server error.
The two locks they take are now always taken in the same order. A bulk edit
already did this; the single edits and the staged edits now do too. So do
restoring a deleted entry, which took its locks the other way round from a bulk
edit or a payee merge, and committing staged rows, which could meet a delete of
the same rows. Deleting an entry while its account was being archived could
leave the archived account holding the deleted amount until the next restart,
and deleting an account while a recurring transaction naming it was being
created could leave that recurrence pointing at nothing; neither can now.

**The budget forecast counts a recurring refund as a refund**, whether the
recurrence picked its category or named one. A monthly deposit into a spending
category was projected as income, beside a history that had always counted the
same refund as spending going down. It now lowers the projected spending, and
income paid back out lowers the projected income.

**Asking to see a CSV import as it goes no longer turns a bad request into a
success.** A malformed upload sent with a request for progress came back as a
200 with an error inside it; it is refused with a 422, as a commit already was.

**An agent can preview a staged delete and then do it.** A dry run of deleting
staged rows stored its result under the request's key, so sending the real
delete with that key next was refused as a conflict. It no longer stores
anything, as every other dry run already did.

**A server failure says what to do.** It used to say "An unexpected error
occurred". It now says the server could not finish and to try again, and to
tell whoever runs the server if it keeps happening. An agent refused for
missing a scope is told which scope and to ask the person to reconnect, rather
than "Forbidden".

**After a delete, the page says so and you keep your place.** Deleting a
template, a recurrence, a budget, a category group or a connected agent, or
dropping the other row on the duplicate review, now says what happened and puts
the keyboard there, where it used to fall back to the top of the page. "Clear
selection" returns you to the list instead. Empty lists no longer claim there
is nothing at all when a date range is hiding rows: they say nothing is in the
range and suggest widening it. A figure that failed to load shows a dash and
says why, rather than $0.00, and a card paid off to the cent reads "Amount
owed: $0.00" rather than calling zero a credit. The bulk edit's Apply button
gives the reason that applies instead of one about currencies, an archived
account's menu explains why it cannot be deleted, and the advice on a frozen
account names the move that works.

**The app reads correctly to people who do not see color, use a screen reader
or zoom in.** A deleted transaction and an archived account card were faded
until their text was hard to read; they are muted and labelled instead. The
page you are on in the sidebar and the transaction type you have chosen were
marked by color alone, and now have a bar and a heavier edge. Money fields now
say their currency in their label, as the transaction form's always did. Notes
beside a field — what saving a new category name will do, what is left to
assign in a split, why a field in a bulk edit cannot be changed — are now read
with the field. The two add forms on Categories have labels on screen rather
than a placeholder that disappears as you type. A split that mixes spending and
income says so on the Category field. The duplicate review signs both amounts,
so a deposit and a withdrawal of the same figure no longer look alike; a staged
row's Review link keeps the date range it was found in; a staged row that
cannot be committed says why; and the account-deletion email field can be
filled in by your browser.

**One word for one thing, and the same look for the same thing.** The duplicate
review said "drop" where the queue says "delete" for the same action; a split's
rows were read out as "split 2" rather than "category 2"; the template bulk edit
said "source" and "destination" where the form says "from" and "to"; and the
Recurring page said "recurrence" where every page pointing at it says
"recurring transaction". Each now uses the one word. Every confirmation button
names what it acts on — "Delete template", not "Delete" — and the ones that put
something back rather than take it away, restoring an account and committing a
row flagged as a possible duplicate, are no longer red. Row buttons in the
transaction list and the staged queue name their row for a screen reader, as
Categories and Budgets already did, and Budgets' "Just this month" is a named
icon like every other row action. Counts group their thousands everywhere, not
only in the selection bar. A transfer template's badge is blue, as transfers
are everywhere else. Every Cancel is the same quiet button. Templates and
Recurring frame their list like Transactions and Staged, and the pager under a
list no longer scrolls sideways with its columns. Choosing Balance or a count in
a sort menu starts with the largest. The staged queue's import filter shows when
each file arrived, so two `checking.csv` imports can be told apart. Account
types read "Credit card" rather than "Credit Card", and the staged queue says
"Withdrawal" under a payee, as the transaction list does, rather than
"withdrawal". And a refusal that said a
thing "is unavailable" now says whether it was archived or not found, and what
to do about it.

**A row's menu can be used at the bottom of the window.** The menu behind a
row's "…" button always opened downward and closes when the page scrolls, so on
a row or card near the foot of the window its last items sat off-screen with no
way to reach them — Restore and Delete on an archived account at the end of the
Accounts page among them. It now opens upward when there is no room below, and
on a window too short for it either way, as zooming in makes it, it scrolls
within itself rather than running off the screen or under the header.

**A field left empty or written too long says what to write.** Typing a space
where a category name goes said "Too small: expected string to have >=1
characters". Every free-text field now refuses in words — "Enter a category
name", "An account name must be 120 characters or fewer" — in the browser and
for an agent alike. The amount in the review queue's quick edit and the new
amount in a template mass edit say their currency like every other amount
field, and a typo in `IDEMPOTENCY_RETENTION_HOURS` is reported when the server
starts rather than on the scheduler's first sweep.

**What an agent could do, a person can now do too.** Seven things were
reachable only through the MCP: overriding one month of a group's own budget,
reading the activity history past its latest hundred entries, seeing the row a
staged transaction was read from, setting a description or notes across
several templates at once, giving a budget an end date when it is created,
changing a budget's funding order after it is created, and choosing which
column of an imported file is the bank's reference — the page guessed it from
four headings and offered no way to pick another or undo a wrong guess. Each
now has its place in the app — a "Just this month" button on a group row that
holds its own budget, "Show older activity" at the foot of the history, an "As
it arrived" section on a staged row's form, two more fields in the template
mass edit, an "Ends after" and a "Funded first" field on the two budget forms,
and a "Bank reference" column on the import.

**An agent is no longer told that deleting can be undone.** The instructions
every agent reads said deleting was a reversal that could be undone, which is
true of a transaction and of nothing else: a deleted account, category, group,
budget, template, recurrence or staged row is gone. They now say which, and
each of those delete tools says there is no undo and to confirm first.
Deleting a category also deletes its budgets, which its description now says,
and editing an entry off the last use of a category removes that category,
which the two transaction edit tools now say as the staged ones did.

**Agent tool descriptions that were wrong.** `list_accounts` described another
tool as doing something it does not; a report's bucket offered a `day` that
does not exist and a default that is not the one used; a staged split leg was
described with a field name that can never commit; the forecast described two
of its three bases; a merge undersold what it moves and did not say when it is
refused; and an amount that must be positive published a pattern allowing a
minus sign.

**An export that is too large says so in the app.** Exporting more than a
hundred thousand transactions is refused with a sentence saying to export one
date range at a time, and the Export button followed a link, so that sentence
arrived as a page of raw JSON in place of the app — as did a session that had
lapsed. The button now fetches the file and shows a refusal where you are.

**A refusal that names a number carries it as a field.** The CSV size and row
limits, the export limit, the request size limit, the report and register
limits and the frozen-account refusal said their number only in the sentence,
so a program had to read English to learn it. Each now carries `limit` in its
details, as the bulk and plan limits always did.

**Old API paths say they are going, even when they refuse.** The four paths
renamed in 0.1.6 marked themselves deprecated only once a request reached
them, so a signed-out request — the first thing an old tab meets after its
session lapses — got a plain 401. Every response on an old path now carries the
deprecation headers, and the link to the new path names the real id rather than
`{id}`. A cross-origin or wrong-content-type refusal is now marked uncacheable
like every other `/api/v1` response.

**A client that declines progress frames gets none.** An `Accept` header
weighing `text/event-stream` at `q=0` — "not acceptable" — still got frames;
it now gets the JSON answer.

**The account-deletion summary counts what is actually in the queue.** It
counted every staged row ever kept, so somebody with an empty queue was told
thousands of staged rows were about to be deleted.

**Smaller things.** The free-plan refusal said "this one has 3" where it meant
the ledger; the plan tab mentioned frozen accounts when none were frozen; Google
sign-in asked for each of its three scopes twice; a signed-out visit logged a
failed request in the browser on every load; and `/robots.txt` answered with the
app's own page, which a crawler reads as having no rules.

**The first `pulumi up` of a new `oci-single` stack no longer fails at the
settings key.** OCI reports a new vault active minutes before the vault's own
management hostname resolves, and 0.2.0 made the key in it straight away, so
every new stack stopped with `no such host` after its network, its vault and its
database machine were built. Running `up` again did not help for five minutes or
more, because the router and the operator's machine had each cached the failed
lookup. The program now asks OCI's own nameservers until the hostname exists, so
the provider's first lookup succeeds and there is no failure for anything to
cache. It waits up to fifteen minutes and says what to do if that runs out: the
vault is kept, and the next `up` makes the key. A stack that is already up plans
no change.

## 0.2.0 - 2026-10-04

**This release upgrades cleanly from 0.1.6.** Every new setting is additive and
every one of them defaults to absent, so a deployment that changes nothing sells
nothing, limits nobody, shows no advertising, and opens no connection it did not
open before. No route, tool or CSV column is removed. The one change to
schedule is in the `aws` Pulumi program, whose next `pulumi up` turns proxy
protocol on in front of ingress-nginx and interrupts the site for seconds to
about a minute while it does.

### Added

**An `ha` deployment profile: PostgreSQL sharded with Citus, run by Patroni, in
two shapes.** `deploy/helm/` now provisions the database as well as the
application — a StatefulSet per Citus group, the coordinator and its workers,
each a primary with streaming standbys. Citus supplies no high availability of
its own, so Patroni is what promotes, and it registers each node with the
cluster unaided. Off unless `database.enabled` is set, and it stays `false` in
`values.yaml`: every deployment that does not ask for it keeps the
`DATABASE_URL` it already had, and a 0.1.6 values file renders byte for byte
what it rendered before. Two values files turn it on and they are **the same
profile, not two** — `values-node-per-service.yaml` is one of everything, five
pods with no redundancy anywhere; `values-ha.yaml` is three Citus groups at two
replicas with the web tier autoscaling. Everything in the two that is not a
replica count is identical, which is the point: growing from one to the other is
a rollout rather than a migration from one arrangement of the data to another.
That is why there is no separate small-cluster profile, and the Kubernetes
overhead of five pods is what buys never having to do that move.
`docs/citus.md` is what distributing the ledger costs and
`docs/citus-runbook.md` is how to run it — adding a worker, rebalancing, what a
failover does, and how to move an existing database onto a cluster.

**A third cloud for `ha`: Oracle Container Engine for Kubernetes.**
`deploy/pulumi/oci/` builds what the `aws` and `gcp` programs build — a network,
a cluster, a node pool, ingress-nginx behind a load balancer, and the chart on
top — so the three differ in what their clouds call things rather than in what
ends up deployed. It is the shortest of the three, and for reasons rather than
by omission: OKE ships the block-volume CSI driver and the load balancer
controller inside the cluster, which the other two have to install, and an OCI
network load balancer preserves the client address without proxy protocol, so
the frontend needs no second way of learning who is asking. The node pool runs
on Ampere, and the image a node boots is looked up from the Kubernetes version
rather than pinned, because a hard-coded image OCID stops existing when Oracle
retires it and the failure is a pool that never produces a node.
`simple-balance:controlPlaneCidrs` reaches it like the other two, though not in
the same place: EKS and GKE take the allowed sources as a property of the
cluster, while OKE's endpoint sits in a subnet of the deployment's own, so there
it is a rule on that subnet's security list — and that same list is what decides
whether the workers may reach the API at all.

**Not exercised with `pulumi up`.** The program plans against a real tenancy and
no cluster has been built from it, which `docs/acceptance.md` carries as
outstanding rather than leaving to be discovered. That is also why
`tests/cluster-control-plane.test.ts` exists: a preview plans the security rules
and the cluster cleanly whether or not the control plane can be reached, so the
one failure a preview cannot show — a cluster that reports itself ACTIVE while
every kubelet's registration is dropped at the subnet — is asserted in the
repository instead.

**Synchronous replication is derived rather than defaulted.** It was `true` with
nothing tying it to the replica count, and Patroni's `synchronous_mode_strict`
is off, so a group with no standby degraded silently to asynchronous — a setting
claiming a guarantee it could not give. It is now
`synchronousReplication and replicasPerGroup > 1`, and asking for it at one
replica fails the render with the reason named. At two replicas it is on for the
reason it always was: a promotion that loses an acknowledged transaction is the
books disagreeing with what somebody was shown.

**Patroni's REST API now takes a password, and the database has a
`NetworkPolicy`.** `restapi.listen` was `0.0.0.0:8008` with no authentication
block and nothing in front of it, so any pod in the cluster could `POST`
`/switchover`, `/failover`, `/restart` or `/reinitialize`. Both halves are
closed: a fourth generated password in the database Secret, and a fourth policy
admitting 5432 from the API and the scheduler only and the REST port from
database pods only. The frontend is not a peer of either. Egress from the
database pods stays open on purpose — Patroni keeps cluster state in the
Kubernetes API, whose address the chart cannot know, and a restricted cluster
that loses that rule stops failing over.

**A PostgreSQL image this project builds, for the profile that needs one.**
`deploy/docker/citus.Dockerfile` is PostgreSQL 18 pinned by digest with Citus
14.2.0 compiled from a checksummed source tarball, published for both
architectures. It exists because the one arm64 image Citus publishes is musl, and
musl compares text byte by byte whatever collation is declared — which is what
category and payee uniqueness in this application rests on. Its tag names Citus
and PostgreSQL rather than this release, and there is deliberately no `latest`: a
major version cannot read the previous major's data directory, so a floating tag
on a database turns an image pull into an outage.

**The application waits for the database instead of crash-looping at it.** On a
first install of the `ha` profile the API and the scheduler came up before
PostgreSQL was accepting connections and restarted once, or twice at the
redundant shape, before settling — which looks exactly like a broken deployment
to somebody meeting the chart for the first time. Both now carry a
`wait-for-database` init container, gated on `database.enabled`, so a
bring-your-own-database deployment is unaffected and renders what it rendered
before.

**`helm uninstall` now takes Patroni's own state with it, so a reinstall under
the same release name works.** Without it, `helm uninstall` followed by
`helm install` left the database permanently unable to start. Patroni keeps its
cluster state in Kubernetes objects it creates itself at runtime — endpoints
named `<release>-simple-balance-db-<group>`, and `-config`, `-sync` and
`-failover` beside them. Helm deletes what it created and did not create those,
so the `-config` endpoint survived carrying an `initialize` annotation with an
empty value. Patroni reads the *presence* of that annotation as "this cluster
already exists, do not bootstrap, wait for a leader", and the empty value means
no member can claim leadership from it either. Every database pod logged
`INFO: waiting for leader to bootstrap` every ten seconds forever, `Running` and
`0/1`, with nothing crashing, nothing backing off and no event saying anything
was wrong — and **deleting the PersistentVolumeClaims, the obvious thing to
reach for, is what produces it**, because the state then describes a cluster
whose data is gone. Deleting the namespace was the only recovery.

A Job now deletes those objects on uninstall. Because a hook that deletes
database cluster state is dangerous by construction, the decisions that make it
safe are written into the template beside the annotations rather than left to be
inferred:

- **It is a `post-delete` hook, not the `pre-delete` one this obviously wants to
  be.** Helm runs `pre-delete` before deleting anything, so every database pod
  is still up and Patroni's leader rewrites `initialize` and the config object
  within one ten-second `loop_wait`. A `pre-delete` hook would delete four
  objects and be handed them straight back — it would have looked right and
  changed nothing.
- **A hook that cannot run never strands the release.** Helm returns a
  `pre-delete` failure before the uninstall proceeds, so a broken one would
  refuse the uninstall and leave a release nobody could remove. A `post-delete`
  failure is collected instead: the resources are deleted, the history is
  purged, and `helm uninstall` exits non-zero. The residue is the four
  endpoints, which is exactly the old behaviour, recovered the old way. It does
  still fail a `pulumi destroy`, which the runbook and `docs/upgrades.md` both
  cover: the Release is left in Pulumi state with nothing behind it, a second
  `destroy` cannot clear it because the history is already purged, and
  `pulumi state delete` on that URN can. On a teardown that takes the namespace
  anyway, `database.patroniCleanup.enabled: false` declines the hook and the
  question with it.
- **It waits for the database pods to be gone before deleting anything.** Helm
  does not wait for pods on uninstall and they have a sixty-second grace period,
  so a Job that deleted immediately would lose the same race the `pre-delete`
  hook loses. Its wait selector is deliberately broader than its delete
  selector: waiting for too much only costs seconds, while deleting too little
  reproduces the defect on the next install.
- **It matches this release and no other.** Selection is by the labels Patroni
  itself writes — `app.kubernetes.io/instance`, the release name, and
  `cluster-name`, which contains it — never a name prefix or a wildcard that
  could reach a sibling release in the same namespace. It skips Helm-owned
  objects, deletes by exact name, and treats a 404 as success, so it is harmless
  when the objects are already gone. It fires on uninstall and from nowhere
  else: no install, upgrade or rollback path reaches `post-delete`.
- **Its RBAC is a hook resource too, not a release resource**, since Helm
  deletes the release's own objects before running `post-delete`. It is a
  namespaced Role carrying `list` and `delete` on endpoints and services and
  `list` on pods — no cluster scope, no `deletecollection`, and nothing the
  database ServiceAccount is not already granted — and it exists only for the
  seconds the Job runs.

On by default, and `database.patroniCleanup.enabled: false` turns it off for the
one flow it changes: reinstalling over intact claims, where the cleanup means
the dynamic configuration is rebuilt from the chart's `bootstrap.dcs` and any
`patronictl edit-config` is reverted. It renders nothing unless
`database.enabled` is `true`, so a values file that does not run the database is
byte-for-byte what it was. `docs/citus-runbook.md` §Uninstalling, and the state
that used to outlive it has the whole of it.

**A capacity proof, reproducible from this repository.** `docs/capacity.md` is
the claim — ten thousand people's ledgers on the smallest machine the `single`
profile sells, answered inside stated times — and `scripts/capacity/` is what
produces it: a generator that builds thirty million transactions and sixty-six
million postings in SQL, a driver that applies an hour of graded load, and the
thresholds both are held to. The generator writes SQL because thirty million
entries through the service is a load test rather than a setup step, so it ends
by proving what the service would otherwise have enforced: every currency
settles to zero, every individual's books settle to zero, every posting names an
account of its own owner and currency, and every entry moved the amount it says
it moved. It refuses to finish otherwise, because a number measured against a
ledger that does not balance is measuring rows the application could never have
written.

**A `single` deployment profile: two machines, and a PostgreSQL 18 it runs
itself.** `deploy/compose/single/` is the application container behind Caddy
with automatic TLS on one machine, and `postgres:18` on a second with no public
address at all, in a private subnet on the provider's own network. One
`pulumi up` from `deploy/pulumi/aws-single/` or `deploy/pulumi/oci-single/`
builds both. `deploy/systemd/` makes each a service that survives a reboot —
one unit for both machines, switched by `COMPOSE_FILE` rather than by knowing
which machine it is on — with a daily `pg_dump` that is verified by being read
back before it is kept, and a restore that refuses a dump it cannot parse before
it touches the database. The backups stay on the *application* node and are
taken over the network, because a copy on the same disk as the original is not a
backup. Each machine has a data disk that outlives it: the nightly backups, the
generated secret on one, `PGDATA` on the other, so replacing
either destroys its root volume and keeps what matters; a resize is made in
place. Three new documents say which profile to pick, how big the machines have
to be, and what they cost.

**Bringing your own database is still supported, as a setting rather than a
profile.** `simple-balance:databaseNode: false` builds no database node, no
private subnet and no NAT gateway, and the application node waits for a
`DATABASE_URL` in the stack's `simple-balance:secrets` — the floor there is
still PostgreSQL 15, because it connects to whatever you already have. The
generated string lives in `/opt/simple-balance/env.db` at `0600`, and
`simple-balance-env` folds `env.base`, `env.db`, `secrets.env` and the stack's
settings in that order, so a `DATABASE_URL` of your own still wins on a machine
whose program generated one, with nothing to turn off first.
`simple-balance:databaseSubnet`, which the branch's Oracle program took for a
managed database's private subnet, is superseded by `databaseNode` and accepted
rather than refused.

**New settings, all optional:** `databaseSize`, which indexes the same sizing
table as `size` but for the database machine, because the two want opposite
things; `databaseMaxConnections`, default 50 with a floor of 10, which is what
makes the five PostgreSQL numbers in that table applied rather than advice —
the database node's compose file passes every one of them as a `-c` flag; and
`databasePassword`, which generates 32 alphanumerics when unset and holds an
operator's own value to letters and digits, because the value crosses a URL, a
Compose `.env` and a shell script and an encoding applied in one of the three
works until the nightly backup runs. `protectDataVolume` now governs both
volumes.

**The sizing table sizes the two machines apart, because they hold unrelated
things.** One data-disk figure was read twice — once for `PGDATA` and once for
the nightly dumps — and it was wrong for both at the population
`docs/capacity.md` proves. A row now carries an application half and a database
half. The application node comes down to two cores and 4 GiB at every size,
which is roughly four times the 0.5 core and 745 MiB it was measured using, and
the four and eight cores it used to buy were bought for a machine that stores no
ledger and whose memory does nothing for the database's cache. The database
node's machine does not change at all. The disks do: `medium` carries 250 GiB
where it carried 140 and `large` 680 where it carried 240, which is what it
takes to hold the ledgers those rows claim and the fifteen dumps beside them —
fourteen kept plus the one being written, which is the peak the backup script's
own prune order produces and which every figure here had been understating by
one. **No disk in the table got smaller**, deliberately: AWS refuses to shrink a
volume and OCI would replace one, so the disks may be made more generous and
never less, and `small`'s application disk stays at 20 GiB where its arithmetic
asks for 10. The application node's machine is the one thing that does come
down, which is safe for the opposite reason: a resize is in place on both clouds
and costs a restart rather than a disk. `medium` and `large` cost roughly 30% less than they did
on AWS while carrying nearly twice the disk at `medium` — 140 GiB to 250 — and
nearly three times at `large` — 240 GiB to 680. `small` is unchanged, and an
Oracle `small` is still $0 at exactly the Always Free ceiling. `docs/deployment-sizing.md` shows the
arithmetic per machine rather than the answer.

**A grown disk becomes grown space by itself.** Both clouds enlarge a block
volume in place and leave the filesystem on it exactly the size it was
formatted at, so raising a row used to buy space that was real, paid for and
unreachable. `simple-balance-growfs.service` runs `resize2fs` on both machines
at every boot, after the data volume is mounted, and prints `Nothing to do!`
when there is nothing to do — so a reboot is all a grown disk needs. It is a
unit rather than a line in the first-boot scripts because cloud-init runs those
once per instance and a `pulumi up` that grows a volume replaces no machine,
which is exactly the case the growth is for. A machine built before this release
never receives the unit, for the same reason, and wants
`sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"` once; the
`growpart` recipe two documents used to give was wrong on both clouds, since
neither data volume carries a partition table.

**The `ha` chart's wait-for-Citus init container takes its own pod's security
context.** It was hard-coded to the server's, so a deployment that hardened
`scheduler.containerSecurityContext` got the server's settings on the one
container in the scheduler's pod nobody had chosen them for — either a pod a
policy admission controller rejects, or a container an operator believes is
constrained and is not.

**`simple-balance:databaseEgress`, for the AWS NAT gateway that is 38% of a
`small` bill, with three ways off it.** It defaults to `nat`, which is what
every stack has today and plans no change.

`ipv6` builds an Amazon-provided IPv6 range, an egress-only internet gateway and
a `::/0` route instead, and costs **nothing** — no hourly charge and no per-GB
charge. What it costs in another currency is stated rather than hidden: Session
Manager stops working on the database node, because `ssm.<region>.amazonaws.com`
publishes no IPv6 address and there is no IPv4 route left, so the setting
requires `sshPublicKey` and is refused without one rather than quietly removing
the only shell onto the machine holding the ledger.

`ssm` is the middle answer and is **$14.60 a month in a US region**, $21.90
cheaper than the gateway, keeping `pulumi stack output databaseShell` working
exactly as documented and needing no SSH key. It is the IPv6 egress-only gateway
*plus* `com.amazonaws.<region>.ssm` and `…ssmmessages` interface endpoints, and
building both halves as one setting is the point rather than an implementation
detail: interface endpoints reach AWS services, and neither Ubuntu's archive nor
Docker Hub is one, so endpoints **without** the gateway would produce a machine
that comes up `running`, answers Session Manager and never finishes installing
Docker or pulling `postgres:18` — the shell you paid for being the only part
that works. Every combination of *settings* that cannot work is refused at plan
time, naming what is missing. The one condition that is not a setting — whether
the availability zone AWS gave this stack offers both services — is refused
against the same message, at `pulumi preview` on a stack whose subnets already
exist and during `pulumi up`, before the first endpoint and before either
machine, on one that has none yet.

`ec2messages` is deliberately not built: from SSM Agent
3.3.40.0 onward Systems Manager prefers `ssmmessages`, regions launched from
2024 support only `ssmmessages`, and AWS is retiring the `ec2messages` endpoint
itself on 2026-09-30 — so a third endpoint would be $21.90 a month, $7.30 of it
for a service being switched off.
The endpoints' security group admits 443 from **both** node security groups,
because an interface endpoint's private DNS overrides the service name for the
whole VPC rather than for one subnet, and admitting only the database node would
have silently taken Session Manager away from the application node. $14.60 is
us-east-1 and us-west-2; `docs/deployment-costs.md` prices *both* sides region
by region, because the NAT gateway's hour is regional too and moves further than
the endpoint's. The saving therefore grows outside the US rather than shrinking:
in sa-east-1 two endpoints are $30.66 against a gateway that costs $71.54 there,
which is $40.88 a month and, priced across all 34 commercial regions, the
largest saving this setting offers anywhere — while the US $21.90 is the
smallest of any of them.

Oracle Cloud needs none of it, since its NAT gateway is free.

**Customer-managed keys on both single-machine clouds, accepted and never
created.** `simple-balance:kmsKeyArn` on AWS and `simple-balance:kmsVaultOcid`
with `simple-balance:kmsKeyOcid` on Oracle Cloud encrypt both data volumes and
both boot volumes with a key of yours. Unset — the default — every one of them
is still encrypted with the provider's own key, free and undeletable, which
stays the right answer for most deployments. The program accepts a key rather
than building one because a key a program creates has the program's lifetime,
and `pulumi destroy --exclude-protected` is this profile's documented teardown
and deliberately *keeps* both data volumes: a key the program owned would be
scheduled for deletion by the same command that kept the ledger. Both programs
read the key at plan time and refuse the stack before anything the key would
encrypt is declared unless it is enabled, customer-managed, symmetric and for
encrypt/decrypt, so a wrong key fails a preview rather than building half a
deployment around it — the network can still be built first under
`--skip-preview`, which is said plainly rather than rounded up to "before any
resource". It is **not retroactive**: a volume's key is fixed at creation, so on
AWS setting it on a stack that exists plans to replace the volumes. The guard is
a setting of its own, `simple-balance:kmsKeyArnIsNewStack`, which `kmsKeyArn` is
refused without — **not** `protectDataVolume`, because `protect` is a flag in
the state snapshot and `pulumi state unprotect` clears it there while the config
still reads `true`, so a guard built on the config would have passed in one of
the two states where Pulumi goes ahead and deletes a ledger. On Oracle Cloud a
key added later reaches all four volumes, boot volumes included, because both
instances name individual properties in `ignoreChanges` rather than the parent
that holds the key. `docs/deployment-profiles.md` §Encryption has what the key
policy must grant — `GenerateDataKeyWithoutPlaintext` and `CreateGrant`, which
no check can see and whose absence is a volume created and deleted seconds later
— and the lock-out behaviour on each cloud and the recovery, including that on
Oracle a key in pending deletion cannot be unassigned, so the deletion has to be
cancelled first.

**Neither machine carries a secret it does not need.** `AUTH_SECRET` is
generated on the application node at first boot and kept on its disk; the
database's superuser password is generated on the database node and kept on
its disk, and only when the file is absent, so a rebuilt machine cannot rotate
itself out of its own cluster. Neither is in user data or a state file. The CA's
private key reaches neither machine and exists only in Pulumi's state. The one
password the stack does hold is the unprivileged application role's, which has
to reach the machine that puts it in a connection string.

**Every setting is the stack's, kept in the cloud's own secret store.** SMTP,
Google sign-in, Stripe, AdSense, the legal pages and every other setting the
application reads are `simple-balance:env` and `simple-balance:secrets` in the
Pulumi stack, the secret ones encrypted there, in all five programs. On a single
machine the program writes them into one OCI Vault or AWS Secrets Manager secret
and grants the application machine's own identity read on that secret and
nothing else; the machine fetches it every time the deployment starts and checks
every five minutes, so `pulumi up` changes a setting with nobody logged in, and a
rebuilt machine has every setting it had without anybody having kept a copy.
Nothing the stack sets travels in user data, which anyone who can describe the
instance can read. On a cluster the plain half reaches the chart's values and
the secret half the Kubernetes Secret the program builds, which EKS and GKE
encrypt with a key of their own — and billing, ads, mail and Google sign-in,
which those programs could not turn on at all, are settings like any other.
`pulumi preview` refuses a name the application does not read, a secret in the
plain map, and a name a program decides itself. A `.env` file fills a stack in
one command with `deploy/pulumi/settings-from-env.mjs`, which reads the file
literally and leaves out what describes where a development copy runs. The
shared unit in `deploy/systemd/` carries no such step, so a machine installed by
hand edits `/opt/simple-balance/.env` and restarts, as before. The Oracle program
takes `simple-balance:availabilityDomain` — a full name, or a number from 1 —
for the launch that fails with `Out of host capacity`. It requires
`simple-balance:sshPublicKey`, and reaches the application node through OCI's
Bastion unless `simple-balance:sshCidr` opens port 22 to one address, and the
database node through a Bastion in that node's own subnet. Its public address is
ephemeral, and a rebuild changes it.

**The application node waits for the database before Compose is asked for
anything.** Both machines boot at once and the database node takes about four
minutes longer — it formats a volume, initializes a cluster and runs its own
first-run SQL — while the application node is ready in ninety seconds. Without
the wait, `docker compose up -d --wait` found nothing on 5432 and abandoned the
rest of the project on its way out, so Caddy was created and never started: a
healthy application on loopback, nothing on 80 or 443, and a unit in `failed`
that nothing retried because `ExecStart` had already run. The wait does nothing
where there is no remote database to wait for, because being wrong in that
direction costs one boot and refusing would strand a machine that worked before
the check existed.

**Encryption at rest and in transit, stated as properties rather than left to
defaults.** Every volume either single-machine program builds sets it
explicitly — `encrypted: true` on both AWS data volumes and both root devices,
four occurrences where there were two, because EBS encryption-by-default is an
*account* setting that is off on a fresh account and the property is the whole
guarantee. On Oracle Cloud there is deliberately no `kmsKeyId` and a test
asserts its absence, so "OCI encrypts every volume with an Oracle-managed key"
cannot quietly stop being what the program rests on.
`isPvEncryptionInTransitEnabled` is set on both instance launches *and* both
volume attachments, which was a real gap. On EKS the programs now install the
`aws-ebs-csi-driver` add-on with its IRSA role and an encrypted gp3
StorageClass — without the driver a claim from the database StatefulSet sat
`Pending` forever — and turn on envelope encryption of Secrets in etcd; GKE gets
the Cloud KMS equivalent and a StorageClass of its own. No customer-managed key
on any data volume, deliberately: a key policy to get wrong, a monthly charge,
and a documented way to lock yourself permanently out of your own ledger.

**And the hop to the database is verified, not merely encrypted.** Both
single-machine programs issue a private CA and a server certificate with
`@pulumi/tls` at plan time, and the generated `DATABASE_URL` is
`sslmode=verify-full` with an `sslrootcert` the overlay already mounts. The
certificate's SAN is the provider's own internal name for the database node —
`db.db.simplebalance.oraclevcn.com`, or `ip-10-20-1-10.<region>.compute.internal`
with the `us-east-1` `ec2.internal` spelling branched for — which is knowable in
advance because the node's private address is pinned. The URL names that name
and never the address: node-postgres sends no server name for an IP literal, so
`verify-full` against one checks the certificate against `localhost` and fails
however many IP SANs it carries. The server is what insists: `pg_hba.conf` is
mounted and named with `-c hba_file=`, every network line is `hostssl`, and the
superuser is refused over the network entirely — the application signs in as an
unprivileged role that owns only its own database. The chart does the same
inside the cluster, with `verify-ca` for Citus's node-to-node and replication
traffic, because Patroni registers members by pod address and a name check would
fail a healthy cluster.

**Only what has to be reachable is.** On both clouds the application node opens
80, 443/tcp and 443/udp to the internet — it is the edge, because Caddy answers
the ACME HTTP-01 challenge there and this profile has no load balancer — and 22
only behind `simple-balance:sshCidr`. The database node opens 5432 to the
application node and nothing else: one source-security-group rule on AWS, one
subnet CIDR on Oracle Cloud, and not one rule from `0.0.0.0/0` on either. It has
no public address twice over, the subnet refusing one and the instance asking
for none, and no inbound rule for a shell on AWS at all, because Session Manager
works through egress. On Oracle Cloud the host's own netfilter ruleset is opened
for 5432 and nothing else, which is the half of the firewall that an operator
meets as a timeout rather than a refusal.

**The Oracle program builds where its stack says, and will not delete its data
volume by accident.** It requires `oci:region` in the stack and stops at
`preview`, before anything is declared, without it. Left to the provider, the
region came from `TF_VAR_region`, `OCI_REGION` or whichever `~/.oci/config`
profile ran `pulumi up`, so where a machine holding somebody's data lived
depended on the shell, and a stack run from another one looked for its
resources somewhere they were not. Any region is accepted, and for Always Free
it is the tenancy's home region, the only one with free Ampere capacity. The
data volume — the generated secret and every nightly dump — is
marked with Pulumi's `protect` unless `simple-balance:protectDataVolume` is
false, so `pulumi destroy` fails at its preview and deletes nothing. A new
`simple-balance:availabilityDomain`, which would replace the volume, is refused
before the machine is touched, `--skip-preview` included: Pulumi's own refusal
comes only on reaching the volume, by which point a run without a preview had
already relaunched the machine in a domain the volume cannot follow it to. The
volume is built after the machine, so a launch refused for capacity leaves no
volume behind and the retry in another domain goes through. The cost is at
teardown: `pulumi destroy --exclude-protected` and `--skip-preview` delete only
the volume's attachment and leave the machine running without its disk, so
`deploy/pulumi/README.md` §Tearing down on Oracle Cloud gives the two ways to
mean it. `protect` binds Pulumi and nothing else; the console can still delete
the volume. The stack exports `region` and `dataVolumeId`.

**The AWS single-machine program does the same.** It requires `aws:region` in
the stack and stops before anything is declared without it, where it had
accepted the shell's `AWS_REGION` or `AWS_DEFAULT_REGION` — and version 7 of
the provider records a region on every resource, so a stack run from a shell
pointed elsewhere planned to replace every one of them there, the data volume
included. Its EBS data volume is marked with `protect` unless
`simple-balance:protectDataVolume` is false, so `pulumi destroy` fails at its
preview, and so does the one change that would replace the volume, a new
region. A resize and a replaced machine go through, since the volume is built
before the machine and takes nothing from it. `pulumi destroy
--exclude-protected` and `--skip-preview` keep the volume and the VPC and subnet
it was built in and delete the rest, the Elastic IP included, so a rebuild
comes back on a new address; `deploy/pulumi/README.md` §Tearing down on AWS
gives the two ways to mean it. The stack exports `region` and `dataVolumeId`.
Both behaviors were run against the provider itself, on a stand-in of the
program's graph, rather than read from its documentation.

**A first boot waits for its data volume as long as Pulumi would: up to forty
minutes**, which is how long the providers give the steps between the machine
running and its disk appearing. On Oracle Cloud the volume is built only after
the instance runs, and the provider allows twenty minutes for that and twenty
for the attachment; on AWS a replacement waits out the old machine's stop, the
detach and the attach. A shorter wait could give up on a volume still on its
way and leave a machine with none of the directories the next steps write into.
A volume that arrives sooner is used at once, and the script says what it is
waiting for when run by hand.

**The single-machine programs' instructions verify the database.** Both
`nextSteps` install the CA certificate at
`/var/lib/simple-balance/tls/db-ca.pem` and give a `DATABASE_URL` of
`sslmode=verify-full` naming it, as the machine's own `/etc/motd` does;
`sslmode=no-verify` still works. Both say to wait for the first boot to finish
before any of it.
`deploy/systemd/simple-balance.env` documents `SB_PG_CA_BUNDLE` and when to add
`compose.db-tls.yml` to `COMPOSE_FILE`, and both compose recipes with a
frontend pass `SB_REAL_IP_RECURSIVE` through, commented in
`deploy/compose/.env.example`.

**`SB_TRUSTED_PROXY_CIDR`, without which every visitor shares one sign-in
allowance.** The frontend container tells the API which address a request came
from, and behind anything terminating TLS that address was the terminator — the
same value for everybody, so four wrong passwords from anywhere locked out the
rest of the world. Set this to the range the terminator connects from and the
visitor's own address survives the hop. It defaults to loopback, which is the
off position: nothing reaches the container from there, so a deployment that
sets nothing behaves exactly as it did before. Under Kubernetes the chart prints
a warning while it is unset and `config.trustProxy` is on, replacing a note that
told operators to edit the nginx template and rebuild the image — which nobody
using a published image could do.

It takes a list, separated by commas, spaces or both, for more than one proxy,
and beside it `SB_REAL_IP_RECURSIVE`, off by default, for a chain of proxies
that each append to `X-Forwarded-For` rather than one that replaces it —
Google's load balancer is one, and off there takes its address for everybody. A
script the image's entrypoint runs before it renders the configuration turns
each entry into a directive of its own and refuses to start on one that is not
an IPv4 or IPv6 address, a CIDR or `unix:`, naming it, because nginx would
otherwise resolve a host name at startup and trust whatever it answered, and
read `10.0.0` as `10.0.0.0`, without a word in the log. It refuses a recursion
value it would have to guess at, and a `/0` entry with recursion on, which would
believe whatever address a caller wrote first. One address or CIDR renders
exactly the configuration it did before the list existed. The chart takes
`frontend.trustedProxyCidr` as a string or a YAML list, adds
`frontend.realIpRecursive`, refuses at render what the image would refuse at
start, and renders `--set frontend.trustedProxyCidr=null` as the off position
rather than as an empty value and a pod that never started. Building the
frontend image now needs BuildKit, for the `COPY --chmod` that makes that script
executable; the entrypoint skips one that is not, with nothing but a log line.

**A plan, sold through Stripe, off by default.** Setting the five `STRIPE_*`
variables makes Stripe reachable; `SB_BILLING_ENABLED=true` puts a plan on sale
and holds a free account to three financial accounts. The two are separate
switches so that winding a deployment down stops new subscriptions without going
deaf to the ones already running — the state in which somebody is charged for a
plan the app no longer believes they have. `docs/monetization.md` has the table
of what each combination turns on, and `docs/billing-operations.md` is the
runbook: setting the Stripe account up in order, going live from test mode,
granting a plan by hand, what a refund does and does not change, and the order
to shut billing down in. This release collects no tax, and the fee arithmetic
in `docs/monetization.md` counts none.

**A plan can be granted by hand, and while one is granted the tab stops
selling.** `billing_override` puts somebody on a plan without Stripe — two SQL
statements against `auth_user` by email address, one to grant and one to expire,
both in `docs/billing-operations.md` §Granting a plan by hand — and it already
outranked Stripe wherever the plan is resolved. What it did not do was stop the
plan tab offering to sell what it had just given away: every plan button stayed
live, and a first payment that was never finished kept its button too, so
somebody granted Premium could be charged for Premium. Nothing in the product
showed it — the tab said Premium, the grant note said Premium, and only the
Stripe dashboard disagreed. Now both plan buttons are disabled with a sentence
naming who to ask, the unfinished first payment is withdrawn, and the route
refuses the same requests with `409` and `details.planGranted: true` rather than
relying on the buttons. The route that collects a first payment refuses it too,
which is a second door and the one that actually charges a card: closing the
subscribe button alone would have left a granted person able to buy the plan
they had been given by replacing their card, which is the same door that had
already been closed once for a deployment that had stopped selling. Cancelling a subscription somebody is still being
charged for stays open, and so does paying off a renewal whose retries ran out:
both stop a charge rather than starting one, and the person a plan was granted
to is exactly the person who may also still be paying for it. An expired grant
sells again at once, with nothing to clear and no session to end — and the note
claiming the grant "takes precedence over anything below" now goes when the
grant does, where it used to stay beside buttons that were live again.

**No advertising on the plan and billing tab**, enforced in the shell rather
than by the policy. The policy is the obvious place and the wrong one: under
`SB_CSP_REPORT_ONLY` — the mode an operator is told to run on exactly that page
— nothing there is enforced, so a slot left mounted would have put live ads
beside the payment form on the page that sells their removal.

**The ads policy carries what Google's consent message needs.** It does not
render in an iframe: it appends into the document and styles itself from
injected blocks and a Google font stylesheet, so under `style-src 'self'` it
appeared unstyled far down the page, nobody answered it, and in the EEA and UK
no ad request completed — which looks exactly like having no inventory. It needs
a referrer as well, and Google's own troubleshooting says it does not serve under
the `same-origin` this app sends everywhere. So the pages that can carry an ad
send `strict-origin-when-cross-origin`, the browser's own default: another
origin is told this site's address and never a page's path, so the record ids
in a URL still stay off every `Referer`. The plan tab keeps `same-origin`.

**Advertising, off unless an operator asks for it.** Setting `ADSENSE_CLIENT_ID`
and `ADSENSE_BANNER_SLOT_ID` shows one unit in the application shell, and an
optional second at the bottom of the page. Never on the plan and billing tab,
never on sign-in, and never to anybody on a paid plan — and only where a plan is
for sale, so AdSense on a deployment with `SB_BILLING_ENABLED` off widens the
policy, serves `/ads.txt` and shows nobody an ad. The process says so at every
start rather than refusing. `PRIVACY_POLICY_URL` is required beside the ids,
and `docs/monetization.md` holds the one ordered checklist for turning ads on,
from the AdSense account to checking both `ads.txt` files.

**The server decides who sees an ad, and the browser is never told the rule.**
A session that should show no ads carries no ad configuration at all, so the
page has nothing to build a slot from rather than a rule it has to apply
correctly. That closes both ways this usually goes wrong: the gate cannot be
written as the inverse of "is on Premium" — which would show ads to every paying
subscriber on a deployment that had _stopped_ selling, since nobody is on a
limited plan there — and there is no window between first paint and the
entitlement arriving. Absent reads as "no ads", so every bug in this fails
toward showing nothing. Google's script is fetched by the first slot that
mounts rather than by the document, so a subscriber never loads it, is never
counted as an impression, and is never tracked by it.

**The publisher id reaches the browser at runtime**, on the session response,
the same path `STRIPE_PUBLISHABLE_KEY` already takes. One published image serves
every operator with their own account; nothing is compiled in, and there is no
shared publisher id.

**Ads are requested non-personalized unless a consent platform is collecting
consent.** `ADSENSE_CONSENT_MANAGED` defaults to false, and then every request
carries `requestNonPersonalizedAds` — which is what lets a deployment serve ads
with no consent platform at all, since Google gates only _personalized_ ads on
one. It is also the right default on its own merits: the page beside the ad is
showing somebody their own balances.

An operator who wants personalized ads uses **AdSense's own Privacy and
messaging**, which is a certified platform, free, and part of the account they
already have — no second vendor, no second contract, and nothing added to this
application, because Google's ad tag delivers the consent message itself and
that tag is already loaded by the first ad slot that renders. The setting then
stops forcing the flag and lets the platform's answer decide, which is the whole
point: forcing it on top of a platform would override somebody who consented as
surely as it protects somebody who did not.

**`/ads.txt` is served automatically**, derived from the publisher id. Without
it AdSense treats the inventory as unauthorized and pays nothing, which is a
failure with no symptom inside the product: the ads render, the impressions
happen, the revenue is zero. An operator selling through other partners serves
their own file at the edge.

**What serving ads costs the policy is now real rather than promised.** AdSense
publishes no list of the hosts it loads from, so allowing it means allowing
scripts, frames and connections to any HTTPS origin, plus `unsafe-eval`, on
every page but the plan tab. That was documented for a release before it was
implemented — the settings were accepted, the cost was described, and the app's
own policy blocked every unit. Both transports carry the axis now, and
`tests/security-header-parity.test.ts` compares them. `'unsafe-inline'`,
`base-uri`, `form-action`, `frame-ancestors` and `object-src` are unchanged.

**A tab strip across Settings**, with Preferences and Plan and billing as two
pages of one section. It navigates with plain anchors rather than the client
router, which is the one place in the app that does: the two pages are served
under different content security policies, and a policy belongs to the document
it arrived with. Leaving the plan tab is a document load too, however it is
reached — otherwise its wider policy would follow you onto every page that
renders balances.

**`SB_BILLING_CONFIGURED` on the frontend container.** In the split deployment
nginx serves the plan tab's document, so nginx decides which content security
policy it arrives with. It is keyed on whether Stripe is _configured_, not on
whether a plan is for sale — an operator winding down keeps the Stripe settings
while their subscribers go on being charged, and replacing an expired card has
to keep working on that page. The compose recipe derives it from
`STRIPE_PUBLISHABLE_KEY` so the two cannot disagree.

**`SB_CSP_REPORT_ONLY`, a rehearsal for the plan tab's policy.** That policy is
Stripe's published set for Stripe.js and its set for Link, plus four hosts this
project added — `*.hcaptcha.com`, `m.stripe.com`, `q.stripe.com` and
`errors.stripe.com` — and whether a live account contacts those four has not yet
been observed, because no live account has run the form. Setting this makes that
page report what its policy would have blocked and block nothing, and registers
`POST /api/csp-report` for the reports. It reaches that one page: every other
page goes on enforcing, because learning about a page that renders no balances
is not worth taking the defense off every page that does. That includes every
page that can carry an ad, so it reports nothing about AdSense; what the ads
policy refuses is read from the browser console on a page with an ad. Both
deployment shapes honor it, and `tests/security-header-parity.test.ts` now
compares the TypeScript and the nginx spelling across both surfaces and both
modes — a comparison that ran only for the default surface before, which is how
the split deployment shipped a plan tab whose payment form could not load.

**A plan and billing tab, at `/settings/plan`.** It shows what the account
includes, how much of it is used, what it costs — read from Stripe, not from
this deployment's settings, so the figure on the screen is the figure that gets
charged — and changes it. Monthly to annual takes effect immediately and charges
the difference; annual to monthly waits for the renewal, because the period
already paid for is not this software's to cut short. Canceling always means
"at the end of the period", in both directions.

The tab is a separate document rather than a panel on Settings, and the link
into it is a plain anchor. Stripe's payment form loads a script and an iframe
from Stripe, which every other page in this app forbids, and a content security
policy belongs to the document it was served with — so a client-side navigation
would keep the strict policy and the form would never appear. Every other page
keeps the `default-src 'self'` policy this container has shipped since 0.1.0,
byte for byte. Stripe's script loads on that tab alone, and only once there is
something to confirm, so no other page fetches it — sign-in included — and
Stripe's fraud-prevention cookies are set nowhere else.

A failed renewal keeps Premium for fifteen days from the failure while Stripe
retries, which is sized to Stripe's recommended default of eight tries within
two weeks with a day over for a late webhook; a retry window of three weeks or
more outlasts it. While a renewal is failing the tab offers **Pay now**, which
confirms the open invoice in the page — the way to pay, from here, a charge the
bank wants authenticated, since a replaced card pays off-session and 3-D Secure
refuses exactly that. It works while nothing is for sale too, and so does
**Pay what is owed** on an unpaid subscription: paying an invoice that already
exists sells nothing. Asking an unpaid subscription for the other interval is
not a payment but a switch scheduled for the renewal, so it is refused then like
every other change of interval. Letting go of a switch still waiting sells
nothing either, and the tab keeps a button for it. `GET /api/v1/billing` reports
`subscription.payable`, and the tab offers a pay button only where it is true,
so **Finish your payment** on an unfinished first subscription is hidden while
nothing is for sale. `docs/billing-operations.md` §Setting up Stripe says which
Stripe settings to match it with, what each "if all retries fail" choice looks
like here, and how to go live from test mode.

**The two price ids are checked against the plans they are sold as.** Each has
to be recurring, bill every one month or every one year to match its setting, be
active while a plan is for sale, and sit in the secret key's own mode, and the
two have to share a product and a currency. A `price_` prefix is all the
configuration check can see, and swapped ids, a one-time price or a test price
beside a live key each pass it and go unnoticed until somebody is charged the
wrong amount or checkout fails. So where one does not fit, the log says what is
wrong, `GET /api/v1/billing` reports nothing for sale, and starting a
subscription answers `409` and charges nobody until the prices are fixed;
replacing a card, canceling, paying a renewal's open invoice and letting go of a
pending switch go on working. A Stripe that cannot be reached to check is a
warning and refuses nothing. The check runs at startup in both the API and the
scheduler, so a wrong id is in the log before anybody opens the plan tab, and
again whenever the prices are read, before every subscription is started, and on
every reconciliation sweep.

**And what a restricted key may read is checked at startup too.** A key built
from `docs/billing-operations.md` step 2 is asked once, in one round of
parallel calls, for a single item of each of the seven things this deployment
reads — customers, subscriptions, subscription schedules, setup intents,
invoices, payment intents and prices — and every one it is refused is named in
a single error line. It writes nothing, refuses nothing, and asks a standard
`sk_` key nothing at all, because such a key has no permission to be missing.
The reason for it is that Stripe does not reliably name the permission it
wanted: a key without PaymentIntents answered a first subscription with "An
unknown error occurred", and the only way to learn which of eleven grants was
short was to try them. Reads are all a probe can prove, so the other half is
per call: a call refused for a missing permission now logs the call, the code
and the fix, and a call Stripe *holds* for a person to approve says that
instead — which is what an agent-tagged key does, on a deployment with nobody
to approve it. Step 2 now says where that tag comes from, which is a choice
made in the form that creates the key rather than anything a replacement key
escapes; that Stripe's default approval rules cover exactly two actions, a
refund and a cancellation, of which this deployment makes only the second, in
one place; and the two ways out, a key created without that intended use or
the "Subscription is canceled" rule deleted under **Settings → Approvals →
Rules**. The refusal line names both of those too, where it used to name only
the key and so sent an operator to rotate a working one. Both are checkable
rather than invisible, which is what answers *is my replacement key tagged as
well*: a tagged key carries an **Agent** badge in the API keys list, and the
rules are on the Approvals page, where any can be deleted. Do it again in live
mode either way — a key belongs to one mode, though whether a rule does is
something Stripe does not say, so that page is worth a look there too. That
table also
gains **PaymentIntents: Write** and **PaymentMethods: Write**, neither optional:
the first is what lets a paid renewal keep the card that paid it, and the second
is what lets a replaced card become the one Stripe bills.

**The plan tab states its renewal terms beside every request to pay.** Beside
the Annual and Monthly buttons, beside the payment form's confirm button for the
plan being paid for, beside **Keep my plan**, which turns renewal back on, and
beside **Stay on the annual plan** (or monthly), which lets a scheduled switch
go and so decides which price the next renewal charges, a
boxed paragraph says that Premium renews automatically until canceled; what each
plan charges and how often, in the figures Stripe returns and never one written
into the page; that if the price changes, or tax is added to what a renewal
costs, an email comes between 7 and 30 days before the change takes effect,
saying what it will cost and how to cancel; and that canceling is **Cancel at
period end** on this tab, with the plan running to the end of the period paid
for. Each of those buttons is described by it, so a screen reader reads it on
the button as well. California's Automatic Renewal Law asks for these terms
conspicuous and beside the request for consent, which is a place no terms page
can reach, and it sets the 7-to-30-day window. A plan Stripe cannot price at
that moment is not offered, and the tab says which, because its terms could not
say what it charges; paying what is owed, replacing a card and canceling need no
price and still work. The email is a promise this software makes and does not
keep: nothing here sends one when a price changes, so an operator who changes a
price sends it, and `docs/monetization.md` says so.

**Your privacy policy and terms of use, where somebody signs up.**
`TERMS_OF_USE_URL` is new, optional, and an absolute `https://` address like the
`PRIVACY_POLICY_URL` beside it. Either one, once set, is linked from the sign-in
and sign-up screens and from the sidebar of every page. With terms set, the
sign-up form and the **Continue with Google** button each say, above the
button, that creating an account accepts them, and the plan tab links them from
its renewal terms. `PRIVACY_POLICY_URL` is
published whenever it is set, not only while AdSense is configured, which is
where it was read for most of this release: a deployment selling a plan without
advertising linked its policy nowhere, not beside the form that collects an
address and not beside the tab that takes a payment. Both names are
unprefixed, against the `SB_` rule, and whether they stay that way is still
open until this release ships: `docs/standards/operations.md` §Naming records
the question.

**Five billing routes**, all session-only. `AGENTS.md` now names three MCP
exceptions rather than two: paying for the deployment is account management, and
an MCP token is a credential handed to a program. What an agent needs in order to
explain a refusal it meets — the plan, its ceiling and how much of it is used —
is on `whoami`.

**A reconciliation sweep**, on the scheduler's existing tick. Every live
subscription is re-read from Stripe when nothing has been heard about it for
twelve hours, fifty per tick, oldest first, so a webhook endpoint that was
misconfigured for a weekend repairs itself within a day of being fixed. It
returns without touching the database where no Stripe is configured, which is
the default.

**Two metrics for the Stripe seam** — `simple_balance_stripe_requests_total` and
`simple_balance_stripe_request_duration_seconds`, labeled by operation and
outcome and by nothing else — and `simple_balance_billing_sweeps_total`, which
carries an `off` outcome so a deployment that sells nothing is distinguishable
from one whose sweep has stopped.

### Changed

**What this product says it is, on every surface that says it.** A competitive
read in October 2026 found that the lines this repository led on were lines
somebody else also runs. "Know where your money is, and where it went" opened
the README and the sign-in screen, and PocketSmith, Tiller, Quicken and Empower
all run it. "Every account in one place" was feature A1 in the product kit, and
eight competitors lead on it. What the comparison left standing is the part
this product has and they describe differently: a figure here can be taken
apart. So `docs/product/features.json` promotes `numbers-that-tie-out` to A1
and promotes the two features that are its evidence, the account register and
the audit history, from tier C to tier B; the capability list in
`docs/product/facts.json` is reordered to lead on the same thing; and the
README, `index.html`'s description and the sign-in screen are rewritten around
it. The marketing site at smpl.money reads both product files, so this is the
half of the change that reaches a reader.

**Every figure on a report links to the thing it is about.** A row naming an
account opens that account; a row naming a category opens that category; and
both carry the range you were looking at, so the page you land on shows the same
window. The three kinds of row with no subject — income and expenses bucketed by
kind, cash flow's segments, and the uncategorized row — stay as plain text,
because there is nothing behind them to open.

**A category now says what it cost you.** Its page had a header, a date range
and then straight into the list, which on the page you open to ask what a
category costs reads as one that failed to load its middle. Two figures now, for
the range you are looking at and for all time, split by currency where a
category holds more than one.

**A row offers its actions the same way everywhere.** There were four shapes
across eight lists: a menu, a menu plus one or two icons, three bare icons, and
a full-width button naming the row it sat on. There are two now — the actions
you repeat as icons, the rest behind the menu after them, and a row with only
two actions putting both in the menu. Two "Delete Groceries"-style buttons
became the trash icon every other per-row delete already used, which also
narrows the widest column on two tables.

**A refusal and a failed load no longer look like the same thing.** A refusal
appears beside the control that caused it, above the filters. A list that could
not load now says so where the list would have been, instead of hoisting the
one sentence that explains it above the filters and leaving the page looking
finished and empty.

**The plan tab says what the money buys, which until now was half the answer.**
It described both plans by account count and the word "ad" appeared nowhere on
it, while the pricing page's whole argument is that the paid plan adds no
feature: it lifts a limit and removes advertising. A paying customer reading
this screen was told one of the two things they pay for. Both plans now name
the advertising, and the upgrade panel opens on "Every feature is on both
plans" before it gets to how to stop paying.

`GET /api/v1/billing` carries a new `advertises` for it, read from the
deployment's configuration rather than from the reader's entitlement.
`getAdPlacement` answers a different question — show an ad to this person
now — and is null for every subscriber, so reading that would have taken the
claim away from the one person paying to be rid of them. The field is additive
and optional in the browser's own type: a deployment with no `ADSENSE_CLIENT_ID`
and a bundle served by a container from before the field existed both leave the
sentence out rather than promising there are no ads.

The same line stopped saying "up to 3 accounts" and now says **"up to 3
accounts in use at once"**, which is the limit this product actually enforces.
The shorter phrasing is the one freezing replaced, and the marketing site
corrected it while this tab did not.

**Three surfaces said statements arrive on their own, and none of them do.**
"Bank statements that import and file themselves" was in the README twice, in
`index.html`'s meta description, in `features.json` as the name of feature A2,
and on the sign-in screen — which is the first thing a prospective user sees.
There is no bank connection: the importer is a file picker with a column
mapper. Each of those now describes the file you downloaded, and the README and
the feature's own description say outright that nothing arrives from your bank
by itself. The site has had a rule against implying a connection since it was
written; this repository had no such rule and was the source the site was
rewriting from.

**The AI capability is a capability rather than the reason to choose this.**
`docs/roadmap.md` has recorded since August 2026, from protocol-level
verification rather than from marketing, that agent access is not the
differentiator it looked like, and `features.json` already ranked `agents` last
in tier C. The README had not caught up: it joined the MCP server to the
double-entry promise in one paragraph, which reads as one claim in two halves.
It now says which half is which, and `features.json` records in the feature's
own `why` that PocketSmith ships the same idea down to the permission levels.

**A free plan now freezes the accounts it cannot keep active, instead of
letting you keep using all of them.** Somebody who drops to the free plan
with more than three accounts keeps every one of them and chooses three to
keep using. The rest are frozen: still listed, still readable, still
counted in every balance, report and export, and closed to every change — no
new entry, no edit, no delete, not even a rename. Choosing is one operation
over the whole set, `PUT /api/v1/accounts/active` or `set_active_accounts` for
an agent, because swapping which three are live is one decision and a switch
per account would make somebody pass through a state their plan forbids.
Nothing is frozen on a deployment that sells nothing, which is every install
arriving from 0.1.6 — but turning selling on freezes, at once, every account
past the oldest three of anybody who has more, so `docs/upgrades.md` says to
grant an override first to whoever should keep them all.

A frozen account says so everywhere it can be reached. Its own page carries a
Frozen badge and no Add transaction, a new entry never defaults to one, a CSV
import neither defaults to one nor offers one, and the account pickers in both
bulk edits leave frozen accounts out; where every account is frozen, Add
transaction is disabled with the sentence the server would refuse with, and the
import page says so instead of offering a form.

**The choice is made once.** An account you are using stays that way until you
archive or delete it, and only then can a frozen one take its place. Parking
one to make room for another would be having them all a few minutes at a time,
which is the same as not having a limit. The cap counts the accounts you are
using rather than every account you ever opened, so archiving or deleting one
really does free a place — and coming back out of the archive needs a free
place too, which is what keeps the quota from being cycled. A restored account
takes that place and arrives in use, and while none is free the Accounts page
disables Restore with the refusal's own sentence. Creating, archiving,
restoring, deleting and choosing all hold one lock over the person's accounts,
so two requests racing for the last place cannot both have it.

There is no choice while nothing is frozen. On a plan with no limit, or while
every live account fits within the one there is, `set_active_accounts` and
`PUT /api/v1/accounts/active` answer `409`, except for a list naming exactly the
accounts already active, which changes nothing and succeeds. Accepting a set
then would be a capability only an agent had, since the Accounts page shows no
chooser there, and a choice written on the paid plan would bind silently at the
next downgrade. The tool is annotated destructive, so a client may ask the
person before it runs: while the choice is open it decides which accounts they
keep, and its description tells an agent to confirm that with them first.

You are asked again when the question changes. A spell on Premium leaves any
account you opened while the limit was lifted sitting beside a choice you made
about a smaller ledger, so the next lapse puts the choice back rather than
freezing an account nobody ever asked you about. Archiving one of the ones you
are using is the other case and is not the same: that frees a place, and only
a place. Whenever the live accounts fit within three, every one is marked in use
again, on any plan — after an archive or a delete, and before a create or a
restore — so a column left saying "not in use" about an account somebody was
using cannot close the choice at the next lapse and freeze that account instead
of a new one.

Frozen is worked out rather than stored. `0024_active_accounts.sql` adds the
*choice*; `frozenAccountIds` combines it with the entitlement, and it has to be
that way around because entitlements change with nobody present — an override
expires at a moment no code observes, and a deployment that stops selling
answers "no billing" while Stripe goes on charging its subscribers. Until
somebody chooses, the oldest of the accounts marked in use stay usable and the
rest are frozen. The first time a plan limits somebody, every account is marked
in use, so those are the oldest of them all. That costs no write at all, and it
is what makes a subscription lapsing at three in the morning correct rather than
merely handled.

**The Overview and the Reports page lead with your own currency.** Both group
money by currency and both sorted the groups by code, so somebody holding
dollars and a euro account kept for one trip met the euros first — at the top of
the Overview, where the first heading is the largest figure on the page. The
currency set in Settings now leads and the rest follow alphabetically behind it.
Only the order changes: every figure is what it was, and no total, balance or
report value moves. The rule is `compareCurrencies` in `src/shared/domain.ts`,
asked by both pages, because two screens ordering the same ledger differently is
a defect even when both are right.

**Every profile that deploys a database now deploys PostgreSQL 18.** Two
questions were being answered as one. What this application will *connect* to is
a floor and it has not moved: PostgreSQL 15 and up, so a deployment already on 15
or 16 keeps working and is not asked to move. What we *deploy* where the
deployment owns the database is a choice, and it is now the newest version both
profiles can share. The cluster decides it: Citus 14.2 is the newest Citus
and accepts 16, 17 and 18. Every release is now tested against both ends rather
than the middle. Debian rather than Alpine in both, because musl compares text
byte by byte whatever collation is declared, and category and payee uniqueness
here rests on the database's collation.

**`compose.distributed.yml` keeps 0.1.6's `postgres:16-alpine` as its default,
and takes 18 as an opt-in.** It is the one recipe here that ships a database and
the one that is not a profile, so it is the one an operator upgrades in place
with a volume already on disk — and a PostgreSQL container cannot read the
previous major version's data directory. Moving the default would have met that
operator with a database that refuses to start, behind `restart: unless-stopped`
and the health gate the server and the scheduler wait on, which is a break a
note in the changelog does not excuse. `POSTGRES_IMAGE` and
`POSTGRES_DATA_MOUNT` take 18 together, after the dump and restore in
`docs/upgrades.md`; the default moves in a later release, once the deprecation
has been in the field.

**The chart's `envFrom` takes a list of Secrets rather than one.** It had to:
with the database in the cluster, the chart derives a `DATABASE_URL` of its own
while an operator's `existingSecret` still carries `AUTH_SECRET` and the rest,
and the earlier rule made those two mutually exclusive — which is why
`database.enabled` was unreachable from either Pulumi program. Both are
permitted only when the chart runs the database, and the order is pinned with
the operator's Secret last, because Kubernetes lets a later source win and
theirs must. Every combination that rendered before renders byte for byte what
it rendered before.

**The Citus authinfo job is an ordinary release resource, not a post-install
hook.** As a hook it was created only after Helm had finished waiting on
everything else — while the server's first migration was waiting on
`pg_dist_authinfo` to propagate DDL to the workers. Each was waiting for the
other, and `pulumi`'s Helm release gives that 900 seconds before it gives up.
It now runs alongside the rest, named by the release revision.

**The three cluster programs take `simple-balance:database`**, a closed set of
`external` or `in-cluster`, defaulting to `external` — which is exactly what
every release so far did, so an existing stack plans no change. `in-cluster`
turns the chart's database on, refuses a `databaseUrl` set beside it at plan
time rather than three minutes into a rollout, and derives the connection
ceiling from the chart's own `max_connections` instead of a stock PostgreSQL's
100. All three also take `simple-balance:controlPlaneCidrs`, which narrows the
Kubernetes API endpoint and is unset by default, because a wrong guess locks a
stack out of the control plane it would need to fix itself.

**Four migrations run at startup, and on one PostgreSQL none rewrites a row.**
`0022_plans_and_billing.sql` creates the five billing tables and alters nothing
that exists. `0024_active_accounts.sql` adds `ledger_account.active` with a
constant default of true, which is one catalog change on any PostgreSQL this
release supports, and every existing account arrives marked active.
`0025_subscription_cancel_at.sql` adds `billing_subscription.cancel_at`,
nullable and with no default, which is metadata-only for the same reason — and
on a deployment that never set a Stripe key it is a catalog change to an empty
table. `0023_citus_distribution.sql` does nothing on most deployments: it
distributes the ledger across a Citus cluster and is gated on the extension
being installed, so the `single` profile's plain PostgreSQL 18, and any database
you bring, record it as run and keep the schema they had.
All four were verified on PostgreSQL 15 and 18, from an empty database and from
one 0.1.6 left, and again on 18 once `0025` joined them: twenty-six migrations
recorded, and every primary and foreign key exactly as `0022` left it. On a
cluster `0023` rewrites fourteen primary keys to carry the owner, rebuilds the
indexes on them, and drops five unique constraints the new key makes redundant.
It is one transaction: it either distributes everything or changes nothing, and
it is safe to run twice — a second gate stops it on a ledger that is already
distributed and says so, because moving an existing database onto a cluster
means running this file by hand.
`docs/upgrades.md` has what each means for rolling back.

**Deleting a category group no longer depends on which foreign key is
installed.** The service cleared the categories' group by leaving it to
`on delete set null`, which a Citus cluster cannot use when the distribution
column is part of the constraint. It now clears the column itself, which is
identical behavior on a single database and the difference between working and
failing outright on a cluster.

**The release script is no longer told which files pin an image; it is asked.**
Both halves of the check walked a hardcoded pair, so a third file pinning one of
this project's images was checked by nothing — it would pass the suite while
quietly deploying whatever release it was written during. `tests/version.test.ts`
now sweeps the repository for pinned references and fails until `set-version`
rewrites every file carrying one. Adding the `single` profile found the gap
immediately, which is the point.

It writes twenty files now, and the test runs it over a scratch copy of every
one of them to prove it, rather than only reading the tree afterward. Two sets
had been out of its reach. A compose file on this branch pinned its images as
`${SB_VERSION:-0.1.6}`, which neither the rewrite nor the sweep could see, so a
cut would have left it deploying 0.1.6; every pin is written out now and the
sweep refuses that spelling. And the product kit in `docs/product/` names the
release it describes, which nothing wrote, so the first cut would have failed
three kit tests with nothing in the procedure saying why. `set-version` stamps
the kit rather than rebuilding it, which is honest only because `release-prep`
rebuilds it on the tree being cut — so `docs/upgrades.md` §Cutting a release now
asks for that check, and for the step that gives the provisional upgrade note
its number and opens the next one.

**Pressing a plan button means one of seven things, decided in one place.**
The browser previews that decision and the server enforces it, from the same
function, the way refunds already work. It arrived after an adversarial
audit found four defects in the branch it replaces, all of them in corners no
test covered: an unpaid subscription handed back the wrong interval's invoice,
so pressing "Monthly — $3" could charge $30; a second downgrade press sent
Stripe a request it refuses, leaving the plan tab with no working control at
all; somebody on a price the deployment had stopped selling was read as
"Monthly" and could be charged immediately for a switch that should have waited;
and an upgrade on a card that was already failing added a proration charge on
top of the invoice it was failing. `tests/subscription-action.test.ts` walks
every Stripe status against both intervals.

**Replacing a card now replaces the card.** Confirming a SetupIntent attaches a
payment method to the Stripe customer and changes nothing about what is billed —
a subscription's own default outranks the customer's — so the new card sat
unused while Stripe went on retrying the dead one. The browser also confirmed it
with `confirmPayment`, which Stripe.js refuses outright for a SetupIntent. Both
halves are fixed, the server pins the card and pays the outstanding invoice, and
there is a `/api/v1/billing/payment-setups/confirmations` route and a
`setup_intent.succeeded` delivery so neither a closed tab nor an unsubscribed
webhook endpoint leaves it half done.

**The split deployment serves the plan tab's policy.** nginx serves the
application shell itself in that shape rather than proxying it, so the content
security policy the plan tab arrives with is nginx's to set — and it was serving
the strict one, which blocks `js.stripe.com`. The payment form could not load at
all. `SB_BILLING_CONFIGURED` now reaches the frontend container, and both spellings
of the path get the wider policy, because the browser's router renders the tab
for `/settings/plan` and `/settings/plan/` alike.

**Stopping selling no longer hides the way out.** `/api/auth/methods` reports
`billingAvailable` from whether Stripe is configured rather than from whether a
plan is for sale, so turning `SB_BILLING_ENABLED` off stops new subscriptions
without boarding up the only link to the page where somebody cancels or replaces
an expired card — while Stripe keeps charging them.

**Deleting an account fails closed on money.** The Stripe customer is deleted
first, which cancels everything it owns, and the account deletion is refused
with a `409` if that cannot be confirmed: when Stripe cannot be reached, and
when a key that cannot vouch for it says there is no such customer, as a test
key says of every live one. The `billing_customer` row cascades away with the
account, so a subscription that outlived the deletion would belong to nobody:
still charging a card, invisible to the sweep, unreachable from anything left in
the database.

**`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` take a `_FILE` form**, joining
the seven that already did and taking that list to nine.

**`/api/billing/*` answers `404` rather than the single-page shell.** A webhook
aimed at a misspelled path used to get a `200` and an HTML body, which Stripe
records as delivered — a missed delivery nothing ever retries.

**The plan tab's policy carries Stripe's Link hosts, and its opener policy lets
Google Pay finish.** The Payment Element offers Link by default once the domain
is registered with Stripe, and `link.com` and `*.link.com` were missing from
`frame-src` and `connect-src`, so a payer with a Link account would have watched
the sign-in fail halfway through the form. And that page alone now sends
`Cross-Origin-Opener-Policy: same-origin-allow-popups`, because `same-origin`
severs a popup from its opener and Google Pay, where it completes in a popup,
needs that link to hand the payment back. Both transports carry both, and
neither has yet been watched against a live account.

**Under Helm, the frontend's billing and ads switches follow the settings.**
The frontend is told Stripe is configured when `config.extraEnv` carries a
non-blank `STRIPE_PUBLISHABLE_KEY` or `frontend.billingConfigured` is true, and
told ads are configured the same way from `ADSENSE_CLIENT_ID` and
`frontend.adsConfigured`, as the compose recipes already derive them. Left to
agree by hand, either one disagreeing is a plan tab with no card fields or an ad
slot the frontend's policy blocks, with nothing in the pods to say why; refusing
the render instead would have refused a values file 0.1.6 accepted. The two
switches stay for a key kept in an `existingSecret`, which the render cannot
see. The list of keys an `existingSecret` may carry now names `METRICS_TOKEN`,
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as well.

**The `aws` and `gcp` Pulumi programs take the trusted-proxy settings**, as
`simple-balance:trustedProxyCidr` and `simple-balance:realIpRecursive`, passed
to the chart's `frontend.trustedProxyCidr` and `frontend.realIpRecursive`. Left
unset, each program now supplies its own answer for the network it built,
rather than the chart's off position — the fix for the shared allowance under
Fixed, below. A list of your own replaces the program's whole, with recursion
off unless `simple-balance:realIpRecursive` says otherwise, because a list
written before recursion existed was written for a header that is replaced; on
GCP as the program builds it that brings the load balancer's address back for
everybody, and `deploy/pulumi/README.md` says so. Neither program has a billing
or ads setting; enabling either means editing `deploy/pulumi/common/index.ts`,
which the README spells out.

**The refusal a TLS database meets at startup leads with the way that keeps the
check.** When node-postgres cannot verify the server's certificate, the message
now says to save the certificate of the CA that signed it and name it,
`?sslmode=verify-full&sslrootcert=/path/to/ca.pem`, and that the host has to be
a name the certificate carries; `sslmode=no-verify` comes last, for where there
is no certificate to name. It had recommended `no-verify` first for any
self-hosted server, which is the one setting that tells nobody when a different
server answers. Where the code rules the CA out it says so instead of blaming
the one named: an expired certificate is sent to a renewal, and a name the
certificate does not carry to the host in the URL. The process refuses to start
exactly as before.

**An import, a recurrence's proposals and a staged commit read the plan once,
not once a row.** Freezing made every row's validation ask which plan is in
force and which accounts are frozen, which roughly doubled the cost of each row
on a deployment that sells a plan. They are read once per batch now, after the
batch's locks, and a test counts the reads.

**The app reads as American English wherever a person or an agent reads it.**
The spelling sweep changed words by a map, and a map cannot see an idiom, so a
few survived on screen and in what an agent is told. "Tick the box" is "Check
the box" on Staged transactions and Budgets, a budget whose amount is derived
shows "Calculated" rather than "Worked out", both weekend hints say "Monday
through Friday", the budget form's errors say "percent", the reminder mail says
"one-time", and the tool descriptions an agent reads say "every two weeks",
"at once" and "one-time" where they said otherwise. No argument, field or
stored value changed, so a client that worked still works; only the text it
is shown moved. The page declares `lang="en-US"`, and
`tests/american-wording.test.ts` holds the phrases it lists at zero across
`src`, `index.html` and the product kit.

**A reminder's time is written the way the reader's clock writes it.** The
templates list and the reminder preview in the template form printed the stored
`HH:MM` as it was, so a 24-hour "18:30" sat beside a date written the reader's
way. Both now format it in the browser's locale: "6:30 PM" in the US, "18:30"
where a 24-hour clock is the habit. The stored value, and the `time` field over
HTTP and MCP, stay `HH:MM`.

**The guide has a Plans section, in the words the screens use**, and the how-to
walks through choosing which accounts stay usable. `tests/product-facts.test.ts`
holds that section to the labels and the limit `docs/product/facts.json`
publishes and to `BILLING_GRACE_DAYS`, and refuses any other number word there
from zero to twenty but the count of plans and the pronoun "one", so a change to
a label, the limit or the grace cannot leave the guide behind. The MCP guide
names three things an agent cannot do rather than two.

**`docs/product/facts.json` names no `$schema`**, because no address serves
one and anything that followed it met a 404 page. `tests/product-facts.test.ts`
now compares the whole file with what `scripts/build-product-facts.mjs` writes,
rather than only the fields it names, so a hand edit fails. The marketing
site's copy loses the key on its next sync.

### Fixed

**Thirty-five security advisories are closed by this release** — eleven rated
high, twenty medium and four low — across `nodemailer`, `undici`, `ip-address`
and `fast-uri` in the application and its runtime image, and `@grpc/grpc-js`,
`brace-expansion` and `http-cache-semantics` under the Pulumi programs.
`nodemailer` moves to its 10.x line, which is the only one carrying the fixes;
nothing about how mail is configured changes. The application's Node base image
moves to the current 24-alpine build, and the frontend's nginx from the 1.29
line, which stopped receiving builds in May, to the maintained 1.30 stable line.
Routine minor and patch updates come with them, among them the MCP SDK, Better
Auth, Hono, zod and the Pulumi SDKs.

**Selecting staged transactions no longer pushes the filters down the page,
and the bar that appears instead holds together through a commit.** Ticking
rows on Staged transactions used to grow the filter row into a second and third
line, moving the filters that made the selection out from under the pointer.
The selection now gets a bar of its own, the same one Transactions and
Templates use, and it keeps its shape whatever it is showing: a selection
across pages, Commit disabled with the reason beside it, a commit under way.
A button at work, anywhere in the app, now shows its spinner where its icon
was rather than growing to fit both, so a row of buttons no longer shifts on a
click. And Delete selected no longer looks busy during a commit — it showed a
spinner for the whole of every one, on the button that deletes rows.

**No page scrolls sideways any more, at any width.** The stylesheet's own note
describes a bar that "could neither shrink nor wrap" between 560 and 900px, and
the remedy for it reached one container and not its siblings: Budgets' view bar
and Reports' options bar overflowed, and so did the Categories add-a-category
row. Above 780px the sidebar takes 248px of the window, so the narrowest the
content ever gets is around 820px rather than on a phone — which is why a check
at phone and desktop widths had found none of it. The documents were 958px wide
inside a 900px viewport, 871 inside 820, 837 inside 820. Every route is now
measured at each breakpoint, at each breakpoint minus one, in the middle of each
gap and at 320px, so the next one of these fails in CI rather than on somebody's
laptop. WCAG 2.2 SC 1.4.10.

**The Transactions heading on an account, a category or a payee no longer
squashes itself on a phone.** Its two buttons kept their full width at 390px and
wrapped the sentence beside them to four lines in whatever column was left. The
same heading's Register button, a few inches below, had been rendering as two
lines reading "Show" and "register" at every width.

**The activity log reads as sentences again.** It said "Create User
Preferences", because the text is built lowercase on purpose and CSS was
capitalizing every word of it rather than the first.

**An account you have put away is "archived" everywhere now, not sometimes
"closed".** Reports said "(closed)" on every archived row, "the ones you have
closed" in its empty state and "before they closed" in the note above its
table — on the page you go to after archiving something on Accounts, looking
for the word you just used. A shared description said "an account you have
since closed" to the browser and to every connected agent at once.

**Three row actions that finish and take their own row with them now say so.**
Archiving or deleting a category, committing a staged row, and removing a
budget override all ran with nothing in between and left the keyboard at the
top of the document. Each now reports what it did, where focus lands.

**An archived category said so nowhere on a phone.** The badge that marks it
shares a cell with the kind and the count, and that cell is hidden below 560px —
correct for the other two, which the row's own subtitle repeats, and wrong for
this one, which nothing else says. On the one screen you reach by turning Show
archived on.

**Archiving an account with no balance no longer loses the keyboard.** It is the
only action on that page that runs with no dialog in between, so the menu
closed, the button went with the card, and focus fell to the top of the
document with nothing saying what had happened. It now says what it did, where
focus can reach it.

**A delete the server turned down no longer blanks the list.** Templates and
Recurring each folded every error into one value and then rendered nothing in
the list's place when it was set, so a refused delete took the whole list with
it.

**The auth library no longer writes email addresses to the log.** At the
default `LOG_LEVEL=info`, Better Auth logged `Sign-up attempt for existing
email:` and the address for every sign-up that named an account already here,
through its own `console` calls and outside the gate every other line goes
through. Its lines go through that gate now, tagged `[Better Auth]`, and every
address in them, or in anything passed beside them, reads `[email address]`.
The line itself stays, because a run of them is what probing for accounts looks
like and the sign-up response is careful to hide it. A pre-existing defect
rather than anything this release introduced; a log alert matching the
library's own prefix, `INFO [Better Auth]:`, is the one thing that notices.

**A failure inside a sign-in route no longer goes to the log whole.** An error
that was not the auth library's own — a failed query, most often — fell through
to its router's last resort, which wrote `# SERVER_ERROR:` and the error to the
console, the query's bound parameters with it, and in an auth route those are
addresses and OAuth tokens. It now reaches the same error handler as every other
route, which logs `Request failed:` and the statement without its values and
answers with the usual `INTERNAL_ERROR` body rather than an empty 500.

**A restore into PostgreSQL 15 or 16 no longer empties the ledger.** From 17
on, `pg_restore` opens every restore with `SET transaction_timeout = 0`, which
an older server does not have, and `simple-balance-restore` found that out
after it had dropped the database — leaving it empty and the application
stopped, on a server version the `single` profile supports. The script now asks
the server's version before it touches anything and, for an older server,
renders the dump to SQL, takes that one statement out and loads the rest in a
single transaction. Proved against a real PostgreSQL 16 with the postgres:18
client. It also reads `/etc/default/simple-balance` now, so the application it
restarts keeps the Caddy overlay's `TRUST_PROXY`.

**Two presses of a plan button no longer make two subscriptions.** The
per-user lock was held across Stripe, but the new subscription was stored only
after it was let go, so a second press waiting on the lock — a reload while
Stripe was slow, a second tab — found no subscription and made another, and the
person could pay both. The subscription is stored before the lock is released,
and the second press resumes the first.

**A payee's name never reaches Google.** The payee view is addressed by the
payee's name, and every link on it forwarded the query string, the sidebar
included, so one click to the overview put a person's name and who they pay
into an ad request's page address. No ad slot mounts while the page's address,
or the one it was opened from, carries a payee name, and no link leaving that
view forwards it.

**The PostgreSQL 16 to 18 procedure for `compose.distributed.yml` can be run as
written.** Every command in it named no compose file, in a directory that holds
more than one, so the first failed and left an empty dump behind; the last
brought the old images back up. It names the file once and builds the release.

**Turning AdSense on no longer stops a compose deployment from starting.** No
compose shape passed `PRIVACY_POLICY_URL` to the application, and the server
refuses to start with the AdSense ids set and no policy — so following the
instructions crash-looped the API and the scheduler on `single` and the
split recipe alike, the Oracle and AWS machines included. Both pass it now.
`tests/env-example.test.ts` holds every compose file that runs the server to
exactly the names `src/server` reads, in both directions, which is the check
that would have caught it.

**`DIRECT_DATABASE_URL` now reaches the containers**, for the same reason and
through the same test. The split recipe never passed it, so a deployment behind
a pooler that set it got no bypass and no word about it. A pre-existing defect
rather than anything this release introduced.

**Neither single-machine Pulumi program could launch a machine.** Oracle caps
instance metadata at 32,000 bytes and the user data was 67 KB; EC2 caps it at
16,384 and it was 50 KB. Both now send it gzipped, with whole-line comments taken
out of the files it carries, and `pulumi preview` refuses a document over either
ceiling rather than letting the launch find out: about 9.8 KB on Oracle and
7.2 KB on AWS. The Oracle program also asked for a 20 GB data volume, under
Oracle's 50 GB minimum, and now asks for at least 50 — `small` is still inside
the free tier. And its default stack had no way in, so it now requires an SSH
key and admits port 22 from its own subnet for OCI's Bastion. A later
`pulumi up` leaves either machine alone; an upgrade or a setting is applied on
it.

**Behind either `ha` Pulumi program, every visitor shared one sign-in
allowance.** The API counts sign-in attempts per address and reads it from the
frontend's `X-Forwarded-For`, and on both clouds that held a proxy's address,
the same for everybody, so four wrong passwords from anywhere locked out the
rest, and no trusted range set on the frontend could have fixed it on either
cloud as the programs built them. On AWS the network load balancer's IP targets
pass nothing about who connected, so ingress-nginx saw the load balancer: the
program now turns
proxy protocol v2 on at both ends in the one ingress-nginx release, believes the
header only from the public subnets where the load balancer's nodes are — never
the pods' private subnets, from which any pod could otherwise have named an
address of its choosing — and moves the load balancer's health check to
`/healthz` on port 80, because AWS sends the header on health checks and the
controller's server on 10254 cannot parse it. The frontend then trusts the
VPC's range with recursion off. On GCP the load balancer appends its own address
after the visitor's, so the program trusts Google's two front-end ranges and the
Ingress's reserved address with recursion on, and names container-native load
balancing on the frontend's Service, since through instance groups the pod would
see a node instead. It costs an AWS stack that is already running one
interruption of seconds to about a minute at the next `pulumi up`, while the two
ends change over. The frontend's half needs a frontend image of 0.2.0 or later,
and the programs deploy 0.2.0, which carries it. With the chart's
`NetworkPolicy` off, as both programs leave it, a pod inside the cluster can
still reach the API directly, or on AWS the frontend, and name its own address;
that reach is not new, and turning the policy on closes it. None of this has run
on a real AWS or GCP account: it rests on the vendors' documentation,
ingress-nginx's source, Pulumi's mocks and stock nginx built into each chain.

**The nightly backup could not dump a TLS database, and now checks it.** The
application needs `sslmode=no-verify` for a managed PostgreSQL whose certificate
names a private authority, and `pg_dump` refuses that value. The backup and the
restore now hand libpq `sslmode=require` in its place and drop the parameter
libpq does not know. And a `DATABASE_URL` of
`?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem` now
verifies the database for the application and the backups alike, where
`verify-full` had failed every backup because the `postgres:18` client image
carries no CA bundle. The new `compose.db-tls.yml` overlay mounts that directory
read-only into the application at the same path; it is an overlay rather than a
line in `compose.yml` because a rootless Docker daemon cannot make a directory
under `/var/lib`, and the line stopped every such deployment starting, a URL
naming no file included. The cloud programs name it in `COMPOSE_FILE`, and first
boot makes the directory on the data volume. The backup and the restore mount
the named file into their client under `verify-full` and `verify-ca`, or the
machine's CA bundle — or `SB_PG_CA_BUNDLE` — under `verify-full` with no file,
and refuse `verify-ca` with no file, which libpq would check against any public
CA with no name check at all. Every other `sslmode` is handled exactly as
before. The restore's connection to the maintenance database now keeps the
URL's query whole, where it had replaced the last path anywhere in the string
and so mangled an `sslrootcert` path or a socket host, and a server version
that does not come back as a number stops the restore with nothing changed
rather than being compared as one.

**The nightly backup no longer starts a deployment somebody stopped.** Its unit
bound itself to the application's, so the 03:15 timer brought a stopped
deployment back up in order to back it up. It now requires the deployment to be
running already, and fails instead.

**Trying the plan in test mode and then going live no longer strands the
tester.** The rows test mode wrote named a customer and a subscription no live
key can read, so the tester kept Premium for nothing, could never subscribe for
real, and the sweep retried the dead rows forever. A customer Stripe reports
deleted, or missing once a live key has found both prices in live mode, is now
forgotten and a new one made at the next subscription; the sweep marks a
subscription Stripe has no record of canceled under the same condition. A "no
such customer" or "no such subscription" from a test key, or from a key for the
wrong account, drops and cancels nothing: to either one every live customer is
missing, and believing it would end every paying subscriber's plan. Nor can
either confirm that an account being deleted leaves nothing charging, so the
deletion is refused, with a message that says so rather than one promising a
retry. Never point a live deployment at test keys, then. Nothing is canceled,
but nobody with a live customer can subscribe, replace a card or delete their
account until the live keys are back, and the store stays open to anybody else
with Stripe's public test card. `docs/billing-operations.md` §Going live, or changing Stripe account has
the steps that make it immediate.

**The sweep no longer stalls behind rows Stripe cannot answer about.** A row
that failed kept its old `synced_at`, so it stayed at the head of the
oldest-first queue, and fifty of them were every row the sweep would ever read.
A failure now stamps the time the attempt began, so the row is tried again after
the same twelve hours as everything else.

**A card saved while Stripe was failing is no longer forgotten.** The
`setup_intent.succeeded` delivery was claimed before the calls that pin the card,
so one transient failure left it claimed and never retried. The card is pinned
first and the delivery claimed after, and a late delivery for a card that has
since been replaced is claimed and ignored rather than pinning the older card.

**A second change of plan interval no longer fails with an error the person
cannot clear.** A move that waits for the renewal is made on a subscription
schedule, and Stripe refuses a new one while another exists — a switch still
pending on a price this deployment has stopped selling, or one made in Stripe's
dashboard — so the second press answered `500`. Any existing schedule is
released first now.

**An upgrade whose charge the bank wants confirmed now asks for it.** Moving from
monthly to annual charges the difference at once, and when that charge needed
3-D Secure the subscription went `past_due` with no form to confirm it in. The
upgrade's own answer now carries the open invoice's secret, and the tab confirms
it there.

**Paying a failed renewal now keeps the card that paid it.** **Pay now** and
**Pay what is owed** confirm the open invoice in the page, and the card typed
into that form was used once and thrown away, so the next renewal charged the
card that had already failed. A renewal's PaymentIntent carries no instruction
to save what pays it, which is the difference between it and a first payment;
it is now marked to keep the method before its secret is handed out, and Stripe
makes that card the subscription's default. It is marked only while the payment
is still to be made and only where nothing has been said about the method
already, so a first payment is left exactly as it was. The marking is best
effort: a failure is one log line and the payment goes ahead anyway, because
refusing to take somebody's money over not being able to remember their card is
the worse of the two outcomes. It needs the key's PaymentIntents Write grant.
What moves is the subscription's default payment method, which is what Stripe
bills; the customer's own default is left alone, and pinning that too would
mean either a route that takes a PaymentIntent id or a Stripe write on every
`invoice.paid`.

**The plan tab now checks with Stripe whenever money is owed, and says what it
finds.** It re-read Stripe only for an unfinished first payment, so after a
**Pay now** that worked, a failed renewal went on saying "Payment failed" until
the page was reloaded. Every state that owes money is re-read now, on the load
that draws the page. That read also carries the four things the tab had no way
to say: why the last attempt failed, in the sentence Stripe writes for a
cardholder; whether the bank is waiting for the payment to be confirmed, which
is the one case Stripe does not retry, so the alert points at **Pay now**
rather than promising a retry that will not come; when Stripe will next try,
in the cases where it will; and when an unfinished first payment lapses. A
first payment's decline therefore survives a reload, where before it lived
only in the form that showed it and vanished with it.

**And it no longer says a period renews when nobody has paid for it.** "renews
on" and "ending on" are printed only for a period that has been paid for. An
unfinished first payment says nothing has been charged yet and when it lapses;
a failed renewal names the day the fifteen-day grace ends, taken from the same
function that ends it, so the date on the screen is the date enforced; an
unpaid subscription says Stripe has stopped retrying and that the plan is not
in force until what is owed is paid.

**Changing the payment method while a payment is owed now says what happened to
the payment.** Saving a card that was itself declined closed the form as though
it had worked, leaving somebody on a page that said they owed money with
nothing to tell them the new card had not paid it either. The answer now tells
paid, declined — carrying Stripe's own sentence for the cardholder — and a
payment the bank wants confirmed apart, the last of which no saved card can do
off-session and which the tab answers by pointing at **Pay now**. A failure it
cannot classify while money is still owed is reported as a failure rather than
as nothing owed, that being the one answer that would be a lie. A replay of an
idempotency key stored before this change carries no outcome, and is read as
unknown rather than as success.

**The payment form no longer offers a method the subscription cannot be billed
with.** A USD subscription's card replacement offered Satispay, Kakao Pay and
Naver Pay, because the form inherited every method the Stripe account had
turned on. Changing a payment method now narrows that list to a card — which is
how Apple Pay and Google Pay arrive — and Link. It narrows rather than demands,
and the distinction is the whole of it: a list Stripe reads as a demand is
refused whole over a type the account has not activated, and Link is off until
somebody turns it on under Wallets and is not offered at all in India, so
demanding it would have taken the card replacement away from the past-due
subscriber whose way back it is. Starting a subscription names no methods at
all, for the same reason, so its invoices get what the Stripe account allows
for invoices, narrowed to the currency. That list is the operator's to keep to
cards and Link, and `docs/billing-operations.md` step 6 says so. A saved method
the subscription still refuses is answered with a sentence and changes nothing,
and the `setup_intent.succeeded` delivery for one is recorded and acknowledged
rather than failing every retry for three days. The method is pinned on the
subscription before the customer, so a refusal leaves the two agreeing rather
than disagreeing. None of this has been tried against a Stripe account with
Link turned off; it rests on Stripe's documented behavior for the two list
parameters and on what the sandbox's own intents resolved to.

**And the tab stops calling every payment method a card.** **Replace card** is
**Change payment method**, **Save this card** is **Save this payment method**,
the panel headed **Your card** is **Payment method**, and the renewal terms say
a plan is charged to your payment method. Link can be funded from a bank
account, so the old wording was wrong about what was being saved.

**A cancellation set in Stripe's dashboard now shows on the plan tab, and holds
a change of plan.** Stripe records "stop at the end of the period" two ways, as
a flag and as a date, and this deployment read only the flag — so a
cancellation set by date was stored as renewing, and the tab offered no way to
undo something it did not know about. Both spellings are now one question,
`cancellationPending`, and the "ending" line and **Keep my plan** the tab
already had apply unchanged. A date falling inside the current period needs
nothing stored, because Stripe moves the period end onto it. One dated further
out is the case the flag is false for — that period really does renew — so the
day itself is kept, in `billing_subscription.cancel_at`, which
`0025_subscription_cancel_at.sql` adds. While a cancellation is pending, asking
for the other interval is refused with "Your plan is set to end. Press Keep my
plan before changing it.", and Stripe is sent nothing. Before, **Monthly**
quietly turned renewal back on, because the schedule it creates clears the
cancellation, and **Annual** charged the difference for a year of a plan that
was set to stop. Paying what is owed and
repeating the plan already held are not changes of interval and still work. The
status line goes on asking the flag alone, because the day it prints beside
"renews" is the renewal's rather than the ending's; the note saying what ending
the plan would freeze is where a further-out day is named, which is the one
place it is a date somebody can act on.

**Two overlapping presses of Annual no longer move the renewal date twice.**
The upgrade was made at Stripe and stored only after the lock was released —
the same shape as the double subscription above — so a second press waiting on
the lock read a monthly subscription and upgraded again, anchoring the billing
cycle a second time. The upgraded subscription is stored under the lock now,
and the second press reads it and finds nothing to do, or, where the charge is
still owed, the payment to finish.

**The plan tab's buttons and the note under them now follow the server's rule
rather than a copy of it.** Each priced button is disabled exactly where the
shared rule says the press would do nothing, and says which reason it is: the
plan already held, a switch already set and the date it happens, or a plan set
to end, in the server's own words. Letting a scheduled switch go has its own
**Stay on the annual plan** button, where it used to be done by pressing the
priced button of the plan already held — a button that is otherwise disabled,
so on a deployment that had stopped selling there was no way to do it at all.
That button carries the renewal terms, because letting a switch go decides what
the next renewal charges. The note under the buttons is built from the same
rule, so a subscriber whose renewal has failed is no longer told that moving to
annual "takes effect now" when the move is scheduled, and a plan that is ending
gets no renewal sentence at all.

**While a payment form is open it is the only way to pay.** The panel went on
drawing its own **Pay now**, **Finish your payment** or **Pay what is owed**
beside the form — a second primary button with the same name, for the same
payment, pressable while the form was confirming. Those are hidden while a
payment form is open. A form that only saves a payment method hides nothing,
because it is not another way to pay.

**And every result on that tab is now a sentence that takes focus.** Every
button there disables itself while it works, and a disabled element cannot hold
focus, so the browser let go of it as the request started and the answer
arrived with focus on `<body>`: a keyboard user began again from the top of the
page. A payment, a saved payment method, a refusal, and a change that needs no
payment — canceling, keeping, scheduling a switch, letting one go, upgrading —
each say what happened and take focus, worded after the plan has been read
again so a date in the sentence is the new one. A form that opens from a press
takes focus as well, since the button that opened it has gone or let go.
Neither moves focus on a page load: coming back from a bank's page is a fresh
document, and its sentence is left where a reader finds it.

**Coming back from a bank's or a wallet's confirmation page now finishes the
job.** The address Stripe was told to return to was the tab's whole address, so
its parameters piled up a set at a time, and a payment method saved through a
redirect was never confirmed — the tab drew the plan it already had and said
nothing about what had just happened. The return is to the tab's own path now;
the five parameters Stripe adds are taken off the address on arrival, the
client secret among them, and anything else on it is kept; a method that saved
is confirmed through the same route the in-page form uses, once, keyed so a
reload cannot confirm it twice; and each of the six outcomes gets a sentence of
its own.

**A stale "Please select a payment method" no longer sits above a form that is
complete.** Stripe's element draws and clears its own validation message, and
the tab was copying it into an alert of its own that nothing cleared. The
tab's alert is cleared when the form reports itself complete, and only then, so
a decline in the middle of filling the form is not erased; a validation error
is left to the element, beside the field it is about.

**A refused change of plan now re-reads the plan.** The tab said the refusal
and went on offering exactly what had just been refused. Every refusal from the
four billing mutations re-reads the plan and the session, without closing a
form somebody is part-way through.

**The plan tab says what a plan's limit is doing to your accounts.** It gave
the places in use against the limit and said nothing at all about the accounts
past it: how many are frozen, what being frozen means, or where the one-time
choice is made. It now says how many are frozen, that they stay readable and
counted in every total, and links to that choice on the Accounts page while it
is still open. **And it now says what ending Premium would freeze**, beside
**Cancel at period end** before the press and again while a cancellation is
pending, along with whether the one-time choice would be yours to make or
already made. The figure is the server's, because the page cannot work it out:
what freezes is the accounts nobody chose, which is not the same as every
account past the third, and an operator's grant outlasting the period end
freezes nothing at all. `freezeOnPlanEnd` answers both halves at once, by
resolving the entitlement that would be in force afterward with the
subscriptions dropped — so somebody who chose three of five before upgrading is
told the same two freeze with nothing left to choose, somebody who then
archived one of the three is told two and not one, and a grant that outlives
the period gives no number rather than a zero. It rides on the plan status as
`accountsFrozenOnFree` and `activeChoicePendingOnFree`, and a bundle served by
a container from before those fields reads their absence as nothing to say
rather than as a zero, which is what keeps the tab working through the upgrade.

**The one-time choice of active accounts can be saved with the accounts it
starts on.** The Accounts page's **Choose which accounts stay usable** panel
compared the selection against the accounts that are not frozen, which is also
what it starts with ticked — so the commonest answer of all, keep the three
already in use, was read as no change and **Save** stayed gray under "Nothing
to save yet." Only an agent could close the choice that way. The comparison is
against what is stored now, which while the choice is open is every account, so
any selection inside the limit can be saved. Once the choice is made the two
are the same again, so it is still a choice made once.

**A frozen account now says why it will not let you do something, before you
try.** Its card's **Edit**, **Archive** and **Delete** were disabled with no
reason given, and in the transaction list **Edit**, **Delete** and **Restore**
were not disabled at all: they opened a form or a confirmation, and the server
refused what came back as one message at the top of the list that named no
entry. Entries on a frozen account now carry a **Frozen** badge in the Account
column, their three buttons are disabled, and the reason names the account, so
a transfer says which of its two sides is frozen. **Delete selected** and **Edit
selected** are disabled the same way whenever the selection holds such an entry
the page has seen — on this page, on a page it has left, taken in by "Select
all matching", or carried off the page by a reorder — because the server
refuses those whole rather than skipping rows, and unticking or excluding the
entry frees them again. A filtered selection's rows the page has never shown
are the part the browser cannot see; those still meet the server's refusal,
which now names the entry it was about. The account card's three menu items
carry the reason too, written once under the menu because one sentence covers
all three.

**And a disabled row icon or menu item now looks disabled.** Those two families
paint their own color, background and cursor, so the rendering a browser gives
a disabled control never showed: a frozen account's **Edit** icon was
pixel-identical to a live one, down to the hover fill, which is how the badge
and the description came to be the only things saying so. Both now take
`.button:disabled`'s own dim and `cursor: not-allowed`, read from that rule
rather than chosen again, and both hover rules are narrowed to live controls
rather than answered by a second rule repainting what the first painted — two
rules fighting would leave both spellings live for whoever adds the next hover
state. The pagination controls' dimmer 0.45 is left where it is and is not the
number to copy. `tests/theme-tokens.test.ts` holds both families to the house
dim and holds every `:hover` on a family that ships disabled to
`:not(:disabled)`, and `tests/field-contract.test.tsx` now reaches a plain
`<button>` inside a `RowMenu` or behind a spread, which is where a census of
`Button`s could not see that these three said nothing.

**An agent refused for a frozen account is now told something it can act on.**
The refusal was written for somebody looking at a browser: it names the account
and offers the two ways out of it, make the account active or upgrade, and an
MCP token can take neither — buying a plan is one of the three things
reachable only from a session, and the choice is made once, so resending a
list does not take a freeze back. A connection over MCP now gets a second
sentence written for it, naming `whoami` for the plan and its ceiling,
`list_accounts` for which accounts are frozen, and an archive or a delete
freeing a place, or the person upgrading, as the only things that lift one.
The server also says it once, in the instructions every connection reads,
because one guard refuses writes from ten places across four services and only
the tool that is *about* the choice could carry the sentence in its own
description — so an agent met a rule nothing had warned it of, one refusal at
a time. Nothing an agent sends changes, and the refusal's code, status and
person-facing sentence are what they were.

**Deleting an account no longer promises to cancel a paid plan nobody had.**
The note said "Your paid plan is canceled", which was false for a first payment
that never went through: there is a subscription, deleting the Stripe customer
does cancel it, and nobody ever paid for anything. It says the subscription is
canceled. It also says what it had never said: that nothing is refunded, that
time left on what was paid for is lost, and to talk to whoever runs the server
before deleting if a refund is owed. The last dialog, which is the thing
actually confirmed, says the subscription ends now and nothing is refunded.

**The browser app no longer trips its own content security policy on every page
load.** Zod asks once, as it loads, whether it may compile a faster validator,
and it asks by constructing an empty function — which is `eval`, which this
app's policy has refused since 0.1.0. Zod catches the refusal and uses its
interpreted parser, so nothing was ever broken, but the browser reports the
violation before Zod can catch it. The question is turned off before any schema
is built, which needs its own module imported first, because imports are
hoisted and the shared schemas are built while they load. It matters most in
the rehearsal `SB_CSP_REPORT_ONLY` is for, where a log meant to show which of
Stripe's hosts a live account reaches instead filled with a report about `eval`
that invites exactly the wrong fix. Under that rehearsal policy, where `eval`
is allowed, this also moves Zod to the interpreted parser it was already on
everywhere else; the two agree, and nothing this app parses is large enough to
notice.

**An ad unit Google has nothing to fill now collapses.** An unfilled unit kept
the 280px band the slot reserves, so a page shown no advertisement ended in a
blank stripe. Both the unit and the slot around it are hidden once Google marks
it unfilled, which is the rule Google documents for exactly this.

**An enabled button no longer sits below a disabled one that says why.** A
button's reason is a line under it, so the wrapper showing one is the tallest
thing in its row, and a row that centers its items dropped every neighbor half
a reason lower — 8.5px, and 15px with a two-line reason on a phone. The plan
tab showed it on every visit, one of its two plan buttons always being disabled
with a reason. A form's action row and a modal's footer line up on the tops
while a reason is showing, and a line of text in such a row is given a button's
height so it keeps the midline it had.

**The forecast read every tenant's budget plans, not just yours.**
`/api/v1/forecast` joined a budget plan to its category on the category id alone,
with no owner, while every equivalent query carried one on both sides. It was
unreachable on a single database — two people cannot hold the same category id
while the key is the id alone — and became reachable the moment the ledger was
distributed, which is how it was found. Scoping the join fixed a tenancy hole and
a cluster failure in the same edit.

**Waiting for PostgreSQL waited for the wrong server.** The official image runs a
temporary server while it executes its initdb scripts, and that one answers on
the unix socket alone. Five readiness checks in this repository asked over the
socket, so each could report a database ready moments before it was stopped and
replaced — and whatever was waiting connected to `FATAL: the database system is
shutting down`. All of them now ask over TCP, and a test walks the repository for
any that does not.

**The `single` profile's backups ran against a database it no longer has.** When
that profile stopped bundling PostgreSQL, the scripts around it went on assuming
one: every nightly dump would have failed, and so would the restore somebody
reached for at three in the morning. Both now work out how to reach the database
by reading the deployment's own service list — inside it where there is one, over
the network where there is not — so one script serves a machine with the database
beside it and a machine without, and no setting can disagree with the compose
file about which database is being backed up. That branch is what let the
`single` profile grow a database of its own without a line changing: the
database is on the *other* machine, so the application node's service list still
holds no `postgres` and it still dumps over the network.

**The development database and a `single` deployment no longer fight over the
same containers.** Compose takes a project name from the directory when a file
does not give one, which made `compose.dev.yml` claim `simple-balance` — the
name `deploy/compose/single/compose.yml` declares for itself. Bringing the
profile up on a development machine silently replaced the development database
with it, bind mount and all. The development file now names itself
`simple-balance-dev`, so the two coexist.

**A promise this project has made since 0.1.0 is now a test.** "This image
makes no outbound connection nobody configured" carried "not checked
mechanically" for four releases, because an allow-list of network calls did not
exist. Stripe arriving as a library rather than a URL is what changed it: the
way that was made safe — one module imports the vendor, and it turns the SDK's
own telemetry off — is exactly what makes the promise answerable by reading one
file. A test now holds all three. A new vendor library is still a reviewer's
job, and the guide says so rather than implying otherwise.

**A check meant to keep personal information out of `/metrics` could not fail.**
No metric label carries somebody's identity, because whoever can reach that
endpoint is not the person whose ledger it counts. The check holding that
promise read the label names off each metric's declaration — and
`getMetricsAsJSON`, which is what it asked, hands back a metric's help, name,
type, values and aggregator and no declared names at all, so it read an empty
list for every metric and passed on anything, a counter labeled with an email
address included. No metric has ever carried one and none ever shipped: the rule
held by review, which is the state a check is supposed to replace. It is now
read where a scrape reads it, off the published values, which is also the only
side the registry's own `component` label ever appears on. Nothing about what
`/metrics` serves changes, and it is still absent unless `METRICS_ENABLED` asks
for it.

**`IDEMPOTENCY_RETENTION_HOURS` now reaches the containers.** The compose recipe
has documented it since 0.1.6 and never passed it, so an operator who set it got
no retention sweep and no indication why. Nothing tested that the recipe
delivers what its own example file promises; that is now a test, which is the
half that keeps it fixed.

**Deleting an account no longer leaves your address behind.** The cleanup of
pending verification rows matched only the shape a password reset writes, so an
abandoned account-link or authorization flow left a row holding the user id —
and, for a link, the email address — after the account was gone. It matches all
three shapes now. Both are pre-existing defects rather than anything this
release introduced.

**Two lists told you the wrong thing about your own data.** Payees showed one
message whether the ledger was empty or a search had simply matched nothing, and
its two halves disagreed with each other: the heading said "in this view" while
the text underneath told you payees appear once you commit a transaction — the
wrong next step for somebody who has committed hundreds and mistyped a name.
Accounts told anyone whose accounts were all archived that they had none yet,
and offered to create one, rather than pointing at the archived ones already
there. Each list now separates "nothing yet" from "nothing matches this view",
because the way out of the two is the opposite. Both are pre-existing defects
rather than anything this release introduced.

**The Activity page printed some operations as code.** The budget and
category-group services record an operation as `entity.camelCaseVerb`, and the
page printed that whole, so creating a budget plan read as `budgetPlan.create`
followed by the entity's own name. It reads "Create Budget Plan" now. The stored
operation is unchanged, and so is what the MCP returns. A pre-existing defect
rather than anything this release introduced.

**Re-running the product kit no longer posts its history twice.** Each seeded
entry was posted under a key that carried its date, and an entry still ahead of
today is clamped to today, so a re-run on a later day posted those entries
again, and once the month turned the whole history went in twice — every figure
in the marketing screenshots too high, with nothing on screen to say so. The key
is now the entry's calendar month and its place in the seed
(`scripts/product-kit/entry-key.mjs`), so a re-run against the same database
replays within the month, and once the month turns adds that month's entries
rather than the whole history a second time. A database seeded by an earlier
build shares none of the new keys, so drop it once.

## 0.1.6 - 2026-09-12

**This release upgrades cleanly from 0.1.5.** A deployment starts on the
configuration it already has, every path that answered still answers, and no
client loses a capability it had. Five changes in an earlier draft broke that
and were reverted to warnings, kept precedences and deprecated aliases;
`AGENTS.md` now carries the rule so the next release does not have to
rediscover it.

**Twenty-seven security advisories are closed by this release** — eleven rated
high, sixteen medium — across `fast-uri`, `js-yaml`, `nodemailer`, `hono` and
`qs`. Every one of them is a dependency this project pulls in rather than code
it wrote, and every one is now at or past the version that patches it. The
container's Node base image also moves to the current 24-alpine build, which
carries the Alpine and Node patches released since the digest this project had
pinned.

One change is a judgement call rather than a clean pass, and it is named here
rather than left to be discovered. Every MCP tool now declares a closed argument
object, where 57 of the 71 were open. An agent sending an argument nobody
declared used to have it dropped in silence and now gets an error naming it.
Nothing an agent could successfully do before is impossible now — the dropped
argument never had any effect — but a call that returned success will return a
failure, and that is worth knowing before upgrading. It is the whole point of
the change: an open object accepts a hallucinated argument, answers success, and
teaches the model that the argument works.

### Added

**A category can be put in a group from the categories list.** The control
existed, in a modal behind an unlabeled pencil, and no row ever said which group
a category was already in — so a page with a Groups panel showing "0 categories"
and no way to change it read as a feature that does not work. Every row now
carries its group and changes it in place, the add form files a new category
right away, and a failed read of the groups says so instead of claiming there
are none.

**The forecast can project from what a ledger actually does.** "What happens
next" counted dated recurrences and nothing else, so a household with months of
real spending and no recurrences saw $0.00 in both money columns with nothing
saying why. A third basis — "Recurring plus what you usually spend" — adds the
average of recent finished periods per category, less whatever a recurrence
already covers, and reports that part separately as `typicalSpending` and
`typicalIncome` so a reader can always tell an inferred figure from a scheduled
one. The current period is never part of its own average, matching the rule
`trailing_average` follows on the budgets side. **The browser defaults to it; the
wire default is unchanged**, so no existing client's answer moves.

**The overview says where the budget stands** over the range it is showing, under
Accounts and Spending by category, one row per period the report covers rather
than a total the server never computes — and under it, what the period is made
of: every group and every category you have budgeted, each with what it spent
against what it may actually spend, a bar, and a word for the state it is in. A
budget with nothing spent against it yet is shown like any other, because a
budget is what you set rather than what you spent. A category with no budget is
left out; the panel above already reports that spending, and "$100.00 of —" is
not a budget. Groups are badged the way the budgets page badges them, so a group
budgeted as the sum of its categories is not read as a figure to add to them.
Only the period the range ends in is broken down, which is what keeps a
year-long range from putting twelve expanded periods on a page whose job is a
glance. **And the categories in Spending by category are links** to the
category, carrying the date range with them.

**A long commit and a long import say how far along they are.** Committing fifty
staged rows or more, or staging a CSV of fifty rows or more, now draws a
determinate bar counting the rows as the server works through them — validated,
compared, posted for a commit; staged for an import — with the phase and its
true figures in the sentence beside it. Several thousand rows is a minute or
more, and until now that minute looked identical to nothing happening.

There is nowhere else that progress could have come from. Both writes happen
inside one transaction, so a row written to a progress table would be invisible
to every other connection until the whole thing committed, and a count held in
one process cannot be polled by a deployment running two. So the response
reports its own progress: the browser asks with `Accept: text/event-stream` and
gets Server-Sent Events, ending in a terminal frame carrying byte for byte what
the JSON reply would have. **A caller that does not ask sees no change at all** —
same status, same body, same headers — which includes every MCP client, since
the agent transport answers in a single JSON object and has no channel a
progress notification could travel on. The transaction is untouched: no query
was added, moved or removed, and a refusal partway through still rolls
everything back and now says so on screen.

Operators running their own reverse proxy in front of a single container should
add `proxy_buffering off;` and `proxy_read_timeout 600s;` to it — the snippet in
`docs/deployment.md` now has both, and the images this repository ships already
did. Without them a long commit was already being cut off at sixty seconds; with
them the progress arrives as it happens rather than in one jump at the end.

**Clone transaction**, on the row menu of both the transactions list and the
staged queue. The copy opens the staging form prefilled and lands on Staged for
review rather than in the books, minus the original's bank reference — a copy
carrying it would be swallowed by the next import as already-seen.

**The staged queue edits in place.** A row's date, payee, category and amount
turn into editors where they are — the full form's own editors, with the same
server checks and the same optimistic versioning — so repairing an import is a
click and a keystroke instead of a trip through the modal. A split's category
and amount keep the modal, where the legs they depend on are visible, and a
transfer's category cell stays read-only because a transfer carries none.

**A category can be excluded from the categories report**, from its row's
menu, because one outsized category flattens every other line in the chart.
The footer re-adds from what is on screen, exactly; pills name what is left
out and put it back; nothing stored changes, and agents reading over MCP see
every category either way.

The application says what it is doing, in Prometheus' text format, at
`GET /metrics`. It is off until `METRICS_ENABLED=true`, and then it is
registered rather than refusing, so a deployment that never asked has no such
route at all. Both entrypoints answer: the API reports requests by route and
status, MCP tool calls by tool, ledger writes by kind, idempotent replays, its
connection pool and how long a transaction holds a connection; the scheduler
reports ticks, proposals, reminder sweeps and mail. `component="api"` or
`component="scheduler"` sits on every series, so a split deployment scrapes both
and the two never collide. Node's own heap, event-loop lag and garbage
collection come with it.

Nothing in a metric names a person. No label carries a user, an email, an
account or an amount, and a path with an id in it is counted under its route
pattern, so a ledger with ten thousand transactions is one time series rather
than ten thousand. What a scrape does say is how much a deployment is doing,
which is what `METRICS_TOKEN` is for: set it and the endpoint answers only a
request carrying `Authorization: Bearer`, leave it unset behind a private
network and a scraper needs no configuration at all. The bundled frontend does
not proxy `/metrics`, so the browser's own hostname never exposes it, and
turning it on in production without a token says so once in the log.

The Helm chart carries `config.metrics.enabled` and `secret.metricsToken`, and
`docs/deployment.md` has a scrape config for the two containers.

`LOG_LEVEL` now governs this product's own log lines. It reached exactly one
consumer before — Better Auth's logger — while the thirty-one `console` calls in
`src/server` ignored it, so a deployment asking for `error` still got the
startup banner, the mail notice and the scheduler's warnings. `error` is quiet
now, and is never itself silenced. The three places that warn about
configuration keep writing directly, because the gate has to read the
configuration to know the level and a warning about a setting cannot be gated by
one. Two more sat outside it in a shape nothing was looking for: the graceful
shutdown and the recurrence scheduler took `logger = console` as a default
parameter, so "SIGTERM received, shutting down" printed at every level including
the one chosen to silence it.

**The log now says what the product is doing, and not only that it started.**
`debug` adds a line per HTTP request, per MCP tool call and per message handed
to the relay; `info` gains a line per scheduler tick that proposed a row or sent
a reminder, and a tick that found nothing due drops to `debug`. The gap that
closes is a deployment with `/metrics` off — the default — where a scheduler
that stopped ticking a week ago produced exactly the log of one that was ticking
every five minutes.

None of those lines carries somebody's ledger. A request names its path and
never its query string, a tool call names the tool and never its arguments, a
message names what it was and never who it went to, and a failing query names
the statement and never the values bound into it. That last one was already true
of the HTTP path and was not true of the MCP path, which logged the error whole
— including, on a database hiccup during token exchange, a live access token.

Seven secrets can be read from a file instead of the environment:
`AUTH_SECRET`, `DATABASE_URL`, `DIRECT_DATABASE_URL`, `SMTP_PASSWORD`,
`GOOGLE_CLIENT_SECRET`, `SETUP_TOKEN` and `METRICS_TOKEN`. Point `NAME_FILE` at a file whose contents are the value, and
the value never enters the process environment, so nothing that dumps an
environment can show it.

Set one of `NAME` and `NAME_FILE`. Both set is not an error — the environment
variable wins, which is what happened when `NAME_FILE` did nothing at all — but
it warns and names the file being ignored, because a change to that file will
look like it worked and will not have.

The bundled Helm chart and compose file still pass all seven as environment
variables; `docs/deployment.md` says what using the file form on either takes.

Budgets. A limit per category per period, compared against what was actually
spent, with nothing in it that writes a posting.

A budget is a standing instruction rather than a row per month. Both ends of its
window are snapped to the period, so any day inside a month names that whole
month and a budget set today applies today. One plan covers every period in its
window, so a budget that runs all year is one row and the
months nobody has reached yet are not materialized by anything. Setting an
amount for a single period overrides the plan for that period alone, and the
report says which of the two produced each figure. Windows for one category may
not overlap, which is what keeps last March answering with what last March
intended when the budget is raised in July.

A budget report shows whole periods. Every other report clips a bucket to the
range asked for, and a budget must not: a limit belongs to a whole period, so
weighing it against part of one reads as money still to spend when the month is
already overspent. A range chooses which periods to show. The period still
running is marked as such, because its spending is a total so far.

The comparison runs on the same `date_trunc` grid the reports bucket by, so a
limit and its spending cannot land on different months, and it joins from the
budget to the spending rather than the other way, so a category budgeted at two
hundred and spent nothing on reads as zero of two hundred instead of
disappearing. Splits attribute each leg to its own category and transfers
contribute nothing, both because legs are postings rather than because anything
special was written for them.

Deleting a budget leaves the books exactly as they were, because it never
touched them.

**A budget can carry what a period did not spend into the next one**, which is
the whole of envelope budgeting, and it carries an overspend forward too, as a
debt against the next period rather than something the calendar forgives. A cap
holds the carry inside a number in both directions. Nothing is stored per
period: the carried figures are folded at read time from the same plans, entries
and postings every other figure comes from, so turning it off leaves nothing
behind and a back-dated correction changes every period after it. The fold
reaches back to the budget's own start, up to ten years of months, and a report
that stopped at the bound says so rather than reporting a carry that began from
nothing partway through.

**A budget can be saving up for something**, which is the same machinery with a
target and a date: each period puts aside what is still needed divided by the
periods left, the figure adjusts as the fund fills, and it asks for nothing once
it is full. There is no amount to type and no method to pick — a budget with a
target and a date is a sinking fund because of what it says.

**A budget can work out its own amount three more ways**: the average of what
the last few finished periods actually spent, the previous period's amount plus
a percentage, or a share of the income that arrived in the period before. Each
is named by the parameter it needs rather than by a method somebody picks, and
naming two at once is refused. An amount set for a single period still beats all
of them.

**A forecast.** `GET /api/v1/forecast` and `get_forecast` project the balances
forward from the recurrences that already have dates and amounts, period by
period, from what the accounts hold today. Nothing it returns is a balance:
money dated in the future has not moved, and a test holds that boundary rather
than a paragraph — nothing outside the two transports may import the forecast,
the service writes nothing, and a projected figure is named as one. Budgets are
reported beside the projection and added to it only where a recurrence does not
already cover them, so the rent is never counted twice, and a recurrence with no
amount is named rather than counted as nothing.

**A budget that carries is an envelope, and the report says what is left to
assign**: the money in the accounts the budget is about, less what every
envelope with money still in it has claimed. An account can be taken out of that
perimeter with `inBudget`, which changes no balance and no report; cards are in
it by default, because spending on a card empties an envelope while no cash has
moved. An overspent envelope claims nothing, since the money has already left.

**Categories can be grouped, one level deep.** A group either holds a budget of
its own or is whatever its categories' budgets add up to, and which of the two
is declared when the group is made — there is no default, because both are
defensible and the wrong one silently makes every figure on the page wrong in
the same direction. A group's line is reported beside the category rows rather
than among them, so no total counts the same money twice, and deleting a group
leaves every category where it was.

**And when a period's income will not cover everything, a funding order says
what comes first.** Lower goes first; anything unranked is funded last. The
report then shows how much of each budget the income covers and what is left
unfunded. A ledger that never ranked anything is told none of this, rather than
being told its budgets are unfunded because income happened to land in another
period.

### Changed

**Every page now has one vertical rhythm, and one place that decides it.** The
distance between two sections of a page was a margin on whichever block happened
to be there — eight different numbers across the app, and none at all on the
five blocks that most often sit at page level, so four stacked panels on Budgets
touched and Categories ran four different gaps in one screen. The page container
supplies a single 24px gap now and no section carries a spacing opinion of its
own. `docs/standards/web.md` §7.4 has the rule and `tests/page-stack.test.ts`
holds it.

**A page's buttons sit in the same place on every page.** Transactions had none
in its header at all: its two buttons were a body element dragged up into the
header band by a hardcoded `-48px`, with a second hand-tuned constant for the
four detail pages that embed the same list. And the header bottom-aligned its
actions against the whole text block, so a two-line description pushed them a
line lower — the entire difference between Recurring and Templates. The header
is two rows now, actions beside the title, and both negative margins are gone.

**The Budgets page reads in the order the work happens, and then in time
order**: set a budget, the standing budgets that result, the single-period
exceptions to them, the period that is running, then what happens next. An
earlier arrangement put the projection above the month somebody is actually in,
on the argument that the period tables are the longest and belong last. Length
is the wrong reason to order a page: it meant the first figures under the
budgets were ones that have not happened yet, with the month being spent below
them.

**Settings is two balanced columns.** Three cards shared the narrow one while
Sign-in methods had the wide one to itself, which left a stretch of nothing under
it and stretched single-column password fields across seven hundred pixels. The
sign-in card also did four jobs; the password form is its own card now, with the
note about forgotten passwords back beside it instead of below a Google button.

**Templates' Type filter lines up with the search box beside it.** It was the one
filter in the app wrapped in a form `Field`, which stacked a label above it and
made it twenty pixels taller. Recurring has gained the same filter, and both
search boxes have gained the magnifying glass whose space they were already
reserving.

**Two accessibility failures the guides had recorded and nobody had closed.**
Every table that scrolls sideways is now reachable from the keyboard —
`tabIndex={0}` with a role and a name on all twelve containers, where before not
one was a tab stop and the far columns of a narrow table could not be reached at
all. And the four tables that named their row in a `<td>` now use
`<th scope="row">`, so a row is announced with the thing that identifies it.
Alongside them: every loading region says what it is loading, the categories list
distinguishes "none yet" from "none matching", and the enabled state of a
mass-edit field takes the stronger green a control edge is held to.

A numeric setting outside its range says so at startup instead of falling back
in silence. `CSV_MAX_ROWS`, `CSV_MAX_BYTES`, `RECURRENCE_TICK_SECONDS`,
`RECURRENCE_CATCH_UP_LIMIT`, `RECURRENCE_CLAIM_LIMIT` and `DATABASE_POOL_SIZE`
are all read once as the process comes up, and one that cannot be used is named
in the log with the value it could not use and the number in force instead.

They still fall back. A deployment that meant `CSV_MAX_ROWS=1000` and typed
`1O00` was importing ten thousand rows and being told nothing, and the silence
was the defect — not the fallback. Refusing would have meant a typo in a tuning
knob taking a ledger offline, on a value the previous release accepted, and
nobody types a cap wrong and wants their accounts down for it.

`DATABASE_POOL_SIZE` used to refuse on its own and now falls back with the rest,
which accepts strictly more than before.

The scheduler container checks its mail server at startup, which the API already
did. It is the process that sends every reminder and proposal notice, and nobody
is waiting for one of those, so a relay refusing it failed silently and
indefinitely; it now logs the address it will be sending as, or logs the refusal
and goes on proposing. A scheduler with no mail configured says that in one line
too, because a container that was never handed the SMTP settings and one whose
relay answers look identical in a log that says nothing, and a split deployment
assembled by hand is exactly where that happens. Neither line keeps it from
starting: mail is optional and the schedule is not.

All four images now record the digest of the base they were built on, not only
its tag. `org.opencontainers.image.base.digest` sits beside `base.name`, and
every `FROM` naming a registry image is pinned by digest as well as tag, so the
build is reproducible and the label cannot name a base the image was not built
on. Dependabot watches the bases now, so a pin is raised deliberately rather
than freezing on whatever patches its base had the day it was typed. The runtime
stages still apply the distribution's own updates on every build, so pinned is
not the same as unpatched.

A refund now lowers the category it came back from, instead of raising income.

A deposit credits income and a withdrawal debits expense only when no category
contradicts it. A category whose kind runs against the direction makes the entry
a refund, and its other half posts to the counter-account the direction would
never have asked for. Thirty dollars back from the store was previously refused
outright with "Choose an income category for a deposit", so there was no way to
enter one at all, and a spending figure could only ever go up.

A draft may say `categoryKind` alongside `categoryName`, which is how a refund
into a spending category that does not exist yet is recorded at all: without it
a deposit creates an income category and credits that, and the spending it was
reversing never moves. The transaction form asks the question whenever a name
with nothing behind it is typed — "money you earned" against "a refund of money
you spent" — and stays quiet when the category already exists or the picker is
empty, because there is nothing to decide. A CSV import that may only stage carries the same field
on the staged row, so the kind is the file's decision rather than whichever row
happened to commit first.

A CSV file's rows vote on the kind of a category the file creates: whichever
direction most of them run is what the category is, and a tie is spending. It
used to be created covering both directions when a file held a purchase and its
refund, which is the same defect one layer along, because a category covering
both agrees with whichever direction it is handed.

Naming a category rather than citing its id follows the same rule. A deposit
naming "Groceries" used to widen Groceries to cover both directions, and a
category covering both agrees with whichever direction it is handed, so the
refund credited income, the budget never moved, and every later refund into that
category was broken too. A category running against the direction is now kept as
it is, because that pairing is a reversal rather than an ambiguity. Two rows in
one CSV naming a category nobody has created yet still make one that covers
both, because there is no existing answer to preserve.

One entry may not name both an income and an expense category, because two
counter-accounts would be two movements and only one of them is the one somebody
entered. A bulk edit refuses to turn rows into refunds for the same reason it
refuses to flatten a split: not because it cannot be done, but because it cannot
be done to rows nobody looked at.

Nothing in the reports needed changing. Both counter-accounts already segment as
operating in the cash flow statement, and spending by category already sums
signed postings, so a refund lands correctly without any figure being taught
what a refund is.

Four API paths were renamed to the conventions the rest of them follow.
`POST /api/v1/accounts/{id}/archive` and `POST /api/v1/categories/{id}/archive`
are now `.../archived`, because they take `{"archived": boolean}` and that is a
state rather than a verb, the way `POST /api/v1/transactions/{id}/deleted`
already was. `POST /api/v1/staged-transactions/delete` is now
`.../bulk-delete`, which is how the same operation over committed transactions
has always been spelled; the two remain two routes, because one voids entries by
posting their reversal and the other removes rows that never posted.
`GET /api/v1/staged/{id}/duplicate` is now
`GET /api/v1/staged-transactions/{id}/duplicate`, since there is no `staged`
collection anywhere else. The MCP tools keep their names.

**All four old paths still answer**, on the same handlers, marked `Deprecation`
with a `Sunset` date. The first version of this renamed them outright, on the
argument that `/api/v1` is cookie-only and same-origin so the only client that
could be calling them ships in this image — which is true of this image and not
of the one already running. A browser tab left open across the upgrade is
serving the previous build, and would have met a 404 on the first archive
somebody attempted, with nothing to tell it apart from a bug.

Committing or deleting staged transactions now refuses a selection that leaves
out the version for one of its own rows, and says which row, instead of
reporting it as a version conflict on a row nothing had changed. A repeated id
in the same selection is refused as a duplicate rather than reported as a row
that could not be found. Over MCP both requests also refuse an unrecognized
field rather than dropping it — a body typing `expectedVersion` where the field
is `expectedVersions` is refused by name — and over HTTP they still drop it, as
they did in 0.1.5. Tightening the HTTP side was in an earlier draft of this
release and was taken back out: a client that has been sending a stray field
since 0.1.5 keeps working, and the release that refuses it is a later one.

Both discovery documents still advertise all seven scopes. An earlier draft of
this release narrowed the protected-resource document to
`openid profile email offline_access ledger:read`, on the argument that a client
builds its authorization request from that list and every scope in it is one
more thing somebody is asked to approve before there is anything to approve it
for. That argument still stands and the change does not: a client that read the
document under 0.1.5 and asked for `ledger:write` would have found the scope it
already holds missing from the list it builds its request from, which is a
capability narrowing on an upgrade. It comes back in a release that can
deprecate it first.

A version conflict reaching an agent now says to read the record again and retry
with the version it reports, rather than to refresh and try again. An agent has
nothing to refresh. The browser keeps its own wording, and the two sentences say
the same thing happened.

The repository documents how it is written, in two sets under `docs/standards/`.
One describes the interfaces — the browser app, the MCP surface, the HTTP API,
the CSV format and the container — and the other the source. Every rule in the
second says who enforces it: the compiler, the linter, a named test, or nobody
at all, and the rules in that last group are counted on the index page so the
number is visible and can be argued down. Seven of them became tests in the pass
that followed writing them.

**Used idempotency keys can be pruned, and are not pruned unless you ask.**
Every create, commit and bulk write stores a copy of its response so a retried
request answers the same way twice, and nothing removed those copies — on a busy
deployment that table outgrows the ledger it protects.
`IDEMPOTENCY_RETENTION_HOURS` sets a window and the scheduler's existing tick
enforces it. **It defaults to zero, which means forever**, so nothing about your
data changes on upgrade and the number stays an operator's to pick rather than
one this release imposes.

Setting it is safe because the record makes a retry _quiet_ rather than safe: a
repeated create still meets the duplicate check, a repeated commit finds its
rows already committed, and a repeated bulk write still carries a count and
fingerprint that no longer match the set. The sweep removes a bounded batch per
pass, so a first sweep after a year of records drains over a few ticks instead
of locking the table, and it reads by age through an index added for it.

**A grayed-out button says why it is grayed out.** Eight submit and merge
controls are disabled until the form is ready and one of them had a sentence
beside it. It is the one control that can go completely silent: nothing has been
typed wrongly, so there is no field error, and nothing has been submitted, so
there is no summary — the button is gray and you guess which of the form's
conditions is unmet. Each now carries a sentence under it, wired so a screen
reader hears it as part of the button rather than as text somewhere nearby, and
it names the _first_ thing to fix rather than everything outstanding.

**A line chart no longer relies on color alone.** Ten account colors cannot
all be told apart under color-blind vision — the palette here is the best
available set and is measured at three times the separation of the six it
replaced, which is still not enough by itself. Nine of the ten line series now
carry their own dash rhythm, and the legend swatch beside each one shows the
same rhythm rather than a block of color, so a line can be matched to its
label by shape. The first series stays solid, which is what a single-line chart
should look like.

**What an agent is told about four tools it can call.**
`list_transactions` was 54 characters on the entry point to the biggest
collection in the ledger, saying nothing about the order it comes back in, the
page size, or that a cursor is refused once the ordering or the filters it was
issued for have changed. `list_accounts` did not say that a `balance` counts
future-dated postings, which is the one thing about it an agent would otherwise
get wrong. And the two bulk-selection previews described their count-and-
fingerprint pair as something that goes stale, which reads as a race to beat —
it is not: the write re-resolves the filter and compares, so the pair stops
matching the moment the set changes and there is no window at all.

**Two tools now say in words what the protocol has no field for.** An MCP
annotation can say a tool is destructive and cannot say whether it can be
undone, which are different decisions for whoever approves the call. Merging
categories or payees collapses rows into one and there is nothing to unpick, so
both say so. The four-item list this started from was wrong, and the code caught
it: deleting transactions in bulk already said it posts a reversal that can be
undone, and revoking an agent already said it can be authorized again.

**And a write is counted when it commits.** Every MCP write hands the service a
transaction the transport opened, so the `ledger_writes_total` increment
happened while there was still an idempotency record to write and a commit to
survive — a count that could stand for a write that then rolled back, in a
figure that names the books rather than the traffic.

**Six smaller things a person would meet.** An empty state always has its icon
now — three of the sixteen had none, which left a heading and a sentence
floating in a card, reading as a page that failed to load rather than one that
answered — and its heading takes the level the document needs rather than always
`<h3>`. A right-aligned column header gets the same tabular figures its cells
get, so a header row of period totals on Reports and Budgets lines up with the
column beneath it instead of drifting a pixel per digit. Full-height layouts
measure the viewport somebody actually has, which matters most in a modal: a
tall form's last field and its submit button used to sit below the fold on a
phone until the browser toolbar hid itself. And the generic muted paragraph is a
`Note` component rather than a class called `.settings-note` used on eight files,
none of them Settings; the stacked panel it sat in got the same treatment.

**Every field's label, hint and error now reach the control they are about.**
They were all on screen and none of them was connected: a label associated by
wrapping rather than by name, a hint rendered _after_ the control with nothing
pointing at it, and no error slot at all — no `aria-invalid` anywhere in the
app. So a screen reader read a box with a name and no explanation of what to
type, and a field that was wrong said so in color and in nothing else. A field
that is wrong now says so in three places that agree: the sentence, the control
marked invalid, and the control pointing at the sentence.

One visible consequence: **a hint sits above its control now, not below it.**
That is GOV.UK's order, and it is also what fixes the deeper problem — a name
computed from a label is that label's whole text content, so a hint inside the
label was becoming part of the control's _name_ ("Amount Up to eighteen decimal
places") instead of its description. The old markup got away with it only
because the hint was not associated at all.

**And a split's categories are all named.** `<Field label="Category">` wrapped
up to fifty rows of three inputs, and a label around that binds to the first of
them — so the first leg borrowed the label and every leg after it had no
accessible name, while the amount and note boxes in the same row had one. The
field is a labeled group now and each picker names itself: "Category for split
2", and so on.

**A keyboard user can get past the navigation, and stays where they were.**
Four holes, each the same shape: something moved or vanished and focus was left
behind, so the next Tab started at the top of the document — past eleven
navigation links — to get back to a list somebody was in the middle of.

There is a **skip link** now, first in the tab order, and it lands _in_ the main
region rather than merely scrolling to it. **Following a link** moves focus to
the page it opened and resets the scroll, where `pushState` used to do neither —
only on a real navigation, so changing a filter or a sort leaves focus in the
control you are using. **Finishing a bulk action** puts focus on the sentence
saying what happened, because the button you pressed is inside the selection bar
and the bar goes away with it. And the **mobile navigation drawer** is a drawer:
the page behind it is `inert`, so Tab no longer walks it through the scrim,
Escape closes it, focus moves in when it opens and back to the menu button when
it closes — and it closes itself if you widen the window, which used to leave a
scrim over a page with no way to dismiss it.

**A pagination cursor is signed.** It was base64url of plain JSON, which is
exactly the case AIP-158 names as insufficient obfuscation: a caller could read
it, and worse, build one — and would then be building against an encoding
nothing in this product promises to keep. Every `nextCursor` now carries an
HMAC keyed to a subkey of your `AUTH_SECRET`, so a hand-built cursor is refused
rather than merely validated. Signed and not encrypted, deliberately: the
contents are a boundary value and a row id the caller already holds, so there is
nothing to hide, and a scheme a reader can check beats one they have to trust.

**And it binds the filters it was issued under.** A cursor bound its ordering
and nothing else, so paging through Transactions and changing the search or the
account between pages resumed the walk inside a _different_ collection — rows
from a query nobody asked for, with the row count reporting the truth of the new
collection, so nothing on screen said anything had gone wrong. Every cursor now
carries a fingerprint of the filters, and one that no longer matches is refused
with "This cursor was issued for a different set of filters. Start again from
the first page." Changing the sort order still gets its own sentence, because a
message about the sort when the sort has not moved sends you looking in the
wrong place. Changing the page size does not invalidate anything.

**Nothing you do changes, and a cursor 0.1.5 issued still works.** A cursor is
held rather than stored — a browser tab keeps one in component state, an agent
may send one back minutes later — so a rolling deploy has a window where a
working client legitimately holds an old one, and refusing it would narrow that
client's pagination. The unsigned form is read and never issued, and stops being
read on **March 1, 2027**, the same date the four renamed paths stop answering.
Two consequences: replacing `AUTH_SECRET` invalidates outstanding cursors along
with every session, which is the same thing a sign-out already does to whoever
is mid-list; and every replica needs the same `AUTH_SECRET`, which was already
true. It costs about seven microseconds to sign and seven to verify, against a
page read that costs milliseconds.

**An agent loads 12% less to learn what this server can do.** Every id on the
MCP surface was published as `"format":"uuid"` and, beside it, a 166-character
regular expression saying the same thing — 352 copies of it, 58,432 characters,
11% of the whole `tools/list` payload. The regex bought nothing: a client that
cannot read `format: "uuid"` cannot use this API anyway, since every id it will
ever hold came from a list or a create. One shared schema drops it and leaves
the check alone, so a value that is not a UUID is still refused. The write tier
went from 534,682 characters to 471,674 and the read tier from 191,414 to
166,712 — about sixteen thousand tokens back at the write tier, on every
connection.

**The words on screen now match the ones written down.** `web.md` §16 and
`common.md` settle the voice and neither was checked, so the product had drifted
from both in eleven places. "Invalid" is banned outright — it describes the rule
rather than the input — and it shipped seven times, from the CSV preview's
"Amount has invalid decimal or thousands separators" to a setup code the sign-up
screen called invalid to somebody who had just copied it out of the server log.
A button leads with a verb and takes an object, and two shipped as a bare
"Save". The bulk-action bar said "Mass edit" on Transactions and "Edit selected"
on the other two screens, and "Clear" on one where the others said "Clear
selection". Two pages carried an eyebrow repeating their own title. And a staged
row on the transactions list showed a dash where its category should be, so a
row read as uncategorized on one page and categorized on the next.

`common.md`'s table of worked error sentences is now the sentences the product
actually says. Six of its thirteen rows named messages that were nowhere in the
source, which makes a reference into a wish: the next person writes a fourteenth
message rather than reusing one of the thirteen. Three situations it listed have
no message on purpose, and it now says which and why — an empty required field is
the browser's own sentence in the person's own language, an idempotent replay
succeeded so there is nothing to report, and a row belonging to somebody else is
"Account not found" rather than a bare "Not found".

**Four additive answers on the HTTP API, none of which changes an existing
one.** A malformed request body is now `MALFORMED_BODY` at 400 rather than
`VALIDATION_ERROR`, which meant both 400 and 422 and so carried information the
code did not. A `429` carries `Retry-After`, including on the sign-in routes,
where the library's own non-standard header is mirrored rather than replaced. A
`201` carries `Location`. And both health routes on both processes report which
build is answering, which is the question an operator asks them during a rolling
deploy. `GET /api/v1/audit-events` is the last list on the API to get a
published schema; it read its two parameters by hand, so `?limit=x` reached the
service as `NaN`.

`npm run lint` runs oxlint and `npm run format` runs oxfmt, in place of ESLint
and Prettier. TypeScript 7 forced the linter question — typescript-eslint does
not run on it — and the formatter was measured rather than assumed: oxfmt
reflowed no comment prose in a repository whose comments were 14.9% of its
non-blank source lines at the time, and are around 18% now — the figure moves
with every change, and `docs/standards/code/comments.md` is where it is measured
and held. Neither is visible in the
running application. Adopting the formatter reformatted the tree once, and two
Pulumi deployment files are nothing but that reflow; no other file changed shape
without a reason beside it.

### Fixed

A whole-repository audit before this release ran seventy reviewers over every
file and confirmed 112 defects; every one is fixed. The ones a person could
have met:

**The ledger's own counter-accounts obeyed writes.** Their ids are published
to their owner by the trial balance, and a wrong version guess leaked the real
one to retry with — from there a person could rename the income account, hand
it an opening balance, archive it (which posts its whole balance to equity and
re-shunts every later income posting the same way), or delete it. Every by-id
account path now shares the read's exclusion: a counter-account answers
not-found, before the version is even looked at.

**A bulk edit could make refunds through the other field.** Patching a
category that runs against the rows' direction was refused; patching a
direction that runs against the rows' kept categories was not, so
`patch: {type: "withdrawal"}` over deposits carrying income categories flipped
every row into a refund silently. Both halves of the pair refuse now.

**Merges left standing references behind.** A category merge rewrote
transactions, staged rows, recurrences and budgets, then hard-deleted the
source out from under template drafts, leaving templates that cannot be saved
or used. A payee merge rewrote neither standing reference, so a recurrence
re-created the merged-away spelling on its next occurrence and the merge
undid itself on a schedule. Both merges rewrite both now, audited like the
rest.

**Budget arithmetic, four ways.** A sinking fund accepted a carry cap below
its own target and the cap then discarded each period's saving; the pair is
refused with the way out named. "Left to assign" netted a group envelope's
claim against members that claim nothing and came back overstated. A
share-of-income budget's first period always read zero because the income
query never looked one period back. And the forecast projected an incremental
budget flat at its base while the report compounded it, so the two surfaces
answered the same month with different figures — the projection compounds now,
counts a cross-currency arrival as an occurrence, and names the period units
it did not read instead of counting them as nothing intended.

**The queue and the browser, in smaller ways.** The staged list's search
matched JSON keys, so searching "date" matched every row; its account filter
matched a UUID anywhere in the draft; both filters read the real fields now.
Links that promise rows — the post-import review link, the recurrence
waiting-count — pin the date range that makes those rows visible instead of
opening a this-month queue that hides them. Removing a middle split leg no
longer leaves focus on a button that deletes its neighbor. A refused group
rename no longer stays on screen looking accepted. Restoring an archived
account asks before it moves money, exactly as archiving always did. The
category picker no longer snaps a typed name onto an archived category's id
the server then refuses — the name travels, and revives it, by design. Ledger
writes refresh the budgets page instead of leaving it stale. Timestamps on
Activity and connected agents render where you live, not where the browser
happens to be. And a template holding a cross-currency transfer keeps its
received amount through the browser's editor instead of losing it on every
save; the recurrence form now refuses the mixed split the commit would have
refused every month forever.

**Quietly wrong plumbing.** Better Auth's own rate-limit sweeper deleted the
shared brute-force tally ten seconds into its fifteen-minute window; the rows
now carry their expiry and survive it. A reminder whose relay refused the
message counted as neither sent nor failed while its occurrence was already
consumed; refusals count and warn. A malformed recurrence leg amount was a 500
instead of a validation message. Every catch that logged a database error
whole — whose message embeds someone's payees and amounts — goes through the
narrowing logger. And the deferred category kind on a CSV split rode on the
row, one slot for two answers, so one split naming two new categories gave
whichever vote wrote last to both.

**The net worth, balance sheet and trial balance charts rendered as filled
polygons.** One CSS class set stroke and fill for bars and lines alike, and
source order let its fill defeat the line rule's `fill: none`: every polyline
closed into a shape, and a report meant to be read as lines read as overlap.
An element selector now pins polylines unfilled whatever the order.

**Deployment.** The GCP program selected the GKE ingress controller through a
field GKE ignores, so no load balancer was ever provisioned; the class travels
as the annotation GKE reads. The EKS program enabled three autoscalers with no
metrics-server to feed them; it ships one. The Helm chart's third line-up rule
(upload size versus CSV limit) is now really checked at render time. Three new
indexes back the referential actions that scanned whole tables.

The list of dates on a recurrence form could go on describing a schedule that
was no longer on screen. It walked the rule the parser produced while its
dependency array named the raw fields, and those are not the same set: an
interval of 0 and a blank one both read as no usable number to the fields, and
only the blank one parses, so typing over either with the other left whichever
list was already showing. Both previews are worked out during render now, five
dates being cheaper than the comparison that was avoiding them.

Merging two categories moves the budgets onto the target instead of destroying
them with the source row, and refuses when both are budgeted for the same period
rather than picking a winner. Same failure as the prune below, one door along.

A category is no longer tidied away underneath a budget. Moving the last
transaction off a category prunes it, which is right, and the composite foreign
key then took its budgets with it, which is not: the docstring on that prune
already promised that "a category held only by a standing instruction is held
all the same", and a budget is exactly that. Asking to delete a category still
takes its budgets, because that is a decision somebody made and the story says
a budget is never a reason to refuse one.

Creates that write no postings no longer claim to need an idempotency key they
never had. `AGENTS.md` said every create required one and four of the six did
not, which described the code as broken rather than describing what it does: a
record somebody names is protected by its name being unique, so a second submit
fails instead of duplicating. Only creates that write postings, which have no
natural key, need the key.

Merging two categories can be asked for twice. It is the one write on the API
that nothing protected: a retry after a timeout carries the versions the caller
read before the first attempt, so a merge that had in fact succeeded answered
its own retry with a stale-version refusal, which reads as "it did not happen"
about one that did. `POST /categories/merge` and `merge_categories` now take an
optional `idempotencyKey`, exactly as the payee merge beside them always has,
and the browser sends one per merge rather than per click. Optional because a
0.1.5 client sends nothing; requiring it is a later release's job.

The auth, consent and setup routes answer in a shape the browser's own error
reader can see. Fourteen of them returned a flat `{code, message}` while the
reader looks inside `error`, so a wrong password produced a request that had
plainly failed and no sentence saying why. They send both halves now, and each
Zod field error carries a dotted `field` beside what it already had. Nothing was
taken away: a client reading either shape still works, and dropping the older
half waits for a release where it has been deprecated first.

**A second pass, from the guides rather than from the code.** The standards
guides record what nothing checks about them, and a sweep of those records found
eight shipped defects that had been written down and left. Every one is fixed
and every one now has a test, so the record and the code agree again. The check
that reads those records was part of the problem: it ended a rule at the next
subsection heading, so a top-level rule was never scanned and the last
subsection in a file borrowed the footer beneath it — four rules were answering
to nothing, one of them the **Binding** rule that money is never summed in
JavaScript numbers.

Somebody who asks their system for reduced motion gets a busy indicator again.
The blanket rule at the foot of the stylesheet sets
`animation-iteration-count: 1`, which is right for decoration and froze the
button's spinner into a static icon — a picture of waiting that was not waiting.
It pulses instead of rotating now, which carries the meaning without motion
across the screen.

Four kinds of control show a focus ring when tabbed to. `summary` — the row
menu's trigger — checkboxes, radios and the scrolling table regions had none,
and the CSV file picker's input is visually hidden, so tabbing to it showed
nothing at all. That last one was a WCAG 2.2 AA failure on the import screen.

A row scrolled to with the keyboard no longer lands under something. Nothing in
the stylesheet declared `scroll-padding`, against eight sticky or fixed regions;
the merge panel on Categories and Payees is the one people would have met,
because it appears exactly when the list is long enough to scroll.

On a narrow window, the navigation scrim no longer paints over the merge panel.
Both sat on the same layer and the scrim was written second, so DOM order was
deciding. The whole ladder is written down in one place now.

Selected text is readable in dark mode. It was 2.59:1 against its own
highlight, where 4.5:1 is the floor for text somebody chose to style.

Two touching bars in a grouped chart have an edge between them. Adjacent series
run as close as 1.05:1 against each other, which is fine for lines that rarely
overlap and not for bars that share a border.

A spreadsheet cell led by a full-width `＝`, `＋`, `－` or `＠` is neutralized on
export, as the ASCII forms already were — Excel and Sheets fold them to the
ASCII leader before deciding whether a cell is a formula. So is one led by a
no-break or zero-width space. An older file re-imports unchanged.

Two people creating an account with the same name at the same moment no longer
both succeed. Categories, payees, templates and recurrences each took a lock
before deciding a name was free; accounts had the check and no lock, and there
was no lock to have taken.

**A third pass, over every page, route, tool and service at once.** The second
pass read the guides' own records; this one read the guides against the whole
surface, section by section. Most of what it found was already right, and the
value is in the four places it was not.

An empty list now says which kind of empty it is. The transactions browser, the
staged queue and an account's register all showed one message whether a ledger
had nothing in it or a filter had excluded everything, so narrowing a search to
nothing looked identical to having never imported anything — and the way out of
the two is opposite. Each now reads the filters that are actually set and says
either "nothing yet", with the control that fixes that, or "nothing matches this
view", with the way back. The register keys on its opening balance instead,
because a range with no postings in it is not an empty account.

A template bulk edit described a filter form that does not exist. The
selection's own description offered to act on "everything matching the current
filters" — the wording the transactions and queue lists use, where a filter form
is on the page. The templates list is capped and the browser holds all of it, so
there are no filters to match and the sentence promised a scope the request
cannot express.

The four `LOG_LEVEL` values were written out three times: the type on
`AppConfig`, the `z.enum` that parses the variable, and `ORDER` in `log.ts`,
which decides what is loud enough to print. Nothing connected them, so they
agreed by coincidence, and a fifth level added to two of the three would have
type-checked. They come from one tuple now, in the configuration layer that
`log.ts` already reads. Eight more closed sets were spelled twice the same way —
four response shapes on the client, a transaction type, a category kind and an
auth mode — each with the shared type already imported into the same file. The
check that was meant to catch this only looked at `type X = "a" | "b"`
declarations, so a set restated as a property type was invisible to it; it reads
both now.

And a sweep for dead code found none: no unreachable module, no unused
dependency, and of 263 CSS classes none unreferenced. What it did find was 34
exports nothing outside their own file imported, now narrowed to what actually
uses them, and a client type barrel that is deliberate and stays.

**Five pieces of copy no longer name a position the layout does not keep.** "The
amount above, every period" described where the Amount field sits, and on a
desktop it sits to the left — the form is a wrapping flex row, so "above" was
only ever true once the row broke. It reads "The amount, every period" now,
which says what the rule does — the amount does not change — and is true at
every width.
The duplicate review promised two records "side by side" in the two states where
nothing is on screen at all, and the grid it meant collapses to one column below
980px anyway. A budget alert said the projection failure meant "nothing below is
a projection" while sitting where the projection would have been, with nothing
under it. And the alert about budgets in other period units told you to switch
"the period above", which on that panel is the forecast's own horizon control;
it names "Budgeting by" now, as the identical alert on the same page already did.

**The overview's budget panel could not say it was empty, so it disappeared
instead.** The panel was drawn only when the report was loading, had failed, or
had at least one budgeted period; the "Nothing budgeted in this range" message
inside it was drawn only when the report had loaded, had not failed, and had no
budgeted period — the exact complement, so the message was unreachable and the
whole section vanished. Anybody whose budgets sit in another month, or in
another currency, met an Overview with no budget section and nothing saying why,
which is indistinguishable from the feature never having been built. The panel
is always there now and says which kind of empty it is. It had no test of any
kind, which is how a branch that could never run shipped; it has seven.

**A design review, run across pages rather than down them.** Comparing each
section of the app against the same section on every other page — rather than
reading one page at a time — turned up defects that are invisible from inside
any single screen.

A panel header never stacked. It is a flex row with the title at one end and
what is said about it at the other, and no breakpoint changed that, so on a
phone "September 2026, USD (so far)" ran down three lines beside a sentence
running down three more. It stacks at 560px now, and §15's table of what that
step does says so.

The date range broke in the middle. Wrapping put the two dates and the word
between them on whatever line they fell on, which stranded "to" at the end of
one line with its date on the next. They are one group now, so the bar wraps
around them.

Every table ended in a stub of a rule. The rule that clears the border under the
last row named `td`, and a row's first cell is a `th` — so eight tables drew a
line under their first column and nothing under the rest.

Two standing-budget actions were full-text buttons reading "Change Groceries"
and "Delete Groceries" in a row whose first cell already said Groceries. They
are the icon buttons every other list uses, with the name in the label.

A group's budget policy could not be read: the select was pinned at 160px and
"Adds up its categories' budgets" did not fit, so the control said "Has a budget
of its". It sizes to its longest option now.

The import preview showed a checkmark over "No file yet" — a success mark for
something that had not started. It shows the file icon the rest of the page
uses.

Reports put the date range below its own options bar, the only page that did not
put it directly under the picker.

**Two accessibility defects, one of them on the consent screen.** Denying an
agent's request put the spinner on "Allow access" — the button nobody pressed —
while the pressed one only grayed out. Both buttons now show the state of the
answer actually in flight. And the two CSV preview tables were the only
scrolling regions in the app a keyboard could not reach, so the columns past the
right edge could not be read at all.

**And fourteen buttons went gray without saying why**, against a rule that says
they must. The check meant to catch that had been passing since it was written:
it read a hand-written list of five files, and matched with a pattern that
cannot cross the `>` inside `onClick={() => …}`, so an arrow-function-first
button was invisible even in the five it did read. It saw eight buttons and
eight reasons and reported success. Counting properly finds 22. Ten now carry a
reason they did not have — including "Add transaction" on three pages, which
goes gray before you have an account and used to leave a first-time reader with
a dead button and an empty list telling them to add a transaction.

**Five procedures that kept being rediscovered are written down.** Bringing the
documents back to true after work lands, sweeping the product against the
guides, reviewing the browser app, preparing a release, and cutting one — each
was being worked out again, in the wrong order, every time it came around. They
are `.claude/skills/` now, and `writing.md` names their reader and their mode
beside every other document in the repository.

What keeps them from becoming a second copy of the standards is that a skill
cites a guide and never restates it: a rule written down twice drifts, which is
the defect the guides exist to prevent. What a skill is allowed to hold is the
part a guide has no place for — the order the steps go in, and the traps.
`release-prep` says twice that the recount goes last, because doing it early
cost four passes in a single session.

`tests/skills.test.ts` holds the set on disk to the set `AGENTS.md` promises,
both directions, and refuses a bare dollar-variable in any of them: a `SKILL.md`
is expanded when it loads, so one of the five quoted a defect report about a
figure that "always showed $0" and the loaded skill said it showed the skill's
own name. Command substitution survives; the bare form does not. Neither is
visible in the file, which is why it is a test rather than a note.

**Two pages scrolled sideways on a 320px screen**, which the standards make a
binding failure and nothing had ever measured. `html` and `body` carry a
`min-width: 320px`, and that was mistaken for a promise that what sits inside
them fits. Two things were over it: the budget period bar's checkboxes are 325px
of text that was told never to wrap, and the date range's two inputs were pinned
at 135px each inside a group that could not shrink. Both fixed, and the browser
tier now measures document width against window width on five pages rather than
asserting the rule holds.

**A disabled button gave one fixed reason for a seven-condition predicate.** The
two bulk editors said "Change at least one field above" to somebody who had
changed a field and mistyped a date — the sentence was true in one of the seven
states it was shown in. Each now names the first unmet condition in the order
the form asks for it. And "Create an account first" is no longer asserted while
the accounts are still loading, when nobody knows yet whether there are any.

**The overview's budget line disagreed with its own bar.** It printed what the
period was allowed while the bar and the badge beside it measured what the
period may actually spend, so a budget carrying money forward read "$450.00 of
$100.00" next to a bar at 90% and a "Nearly there" badge. That is the same
disagreement the category rows below it were written to end, and it had been
left in the line directly above them. It also said "Nothing budgeted in this
range" to anybody budgeting at the group level, where the figure behind the
sentence counts category limits only; it says "No category budgeted" now, which
is what it knows.

**Six lists told you they were empty when the truth was that they could not be
read.** Transactions, the staged queue, Templates, Recurring, Payees and the
duplicate review each showed "No transactions yet" — or its equivalent — over
the top of an alert explaining that the request had failed. A query that errored
is not a query that is loading, so it fell past the loading branch straight into
the empty state. Telling somebody their ledger is empty when the truth is that
nothing could be fetched is the most consequential way a list can mislead, and
all six now show the failure in the list's own place instead of beside it.

**Enter now submits the two budget dialogs.** Changing a budget's amount, or
overriding one month, meant reaching for the mouse: both dialogs held their
fields loose in the body with no form around them, alone among the app's
dialogs, so Enter did nothing and the fields sat flush against each other.

**A modal's buttons sit where every other modal's buttons sit.** The footer
carried padding and a border and no layout of its own, so the five dialogs that
passed their buttons directly left them jammed against the left edge and
touching, while the two that happened to wrap theirs in a container looked
right.

**Each report names its first column.** It said "Row" on all six, which pairs
with every row's header cell so a screen reader announced "Row: Rent" — the
table's own structure read out as though it were the data. It says Account,
Category, Line or Movement now, depending on what the report actually lists.

**A disabled button no longer distorts the bar it sits in.** In a selection bar
the reason was laid out as a caption under one button, which made that button as
wide as the sentence — "Commit selected" stretched to 470px while "Edit
selected" beside it stayed normal, sat above the line its siblings were on, and
on a narrower window pushed the duplicate checkbox onto a row of its own. The
sentence takes a line of its own under the whole bar now. In a form the caption
is still under the button, where the actions are the last thing on a stack.

**A budget set on a group and on no category was invisible on the overview.**
The panel kept a period only when its category budgets came to more than zero,
and a group's own budget is not counted there — so somebody budgeting the way
the 50/30/20 recipe describes saw "nothing budgeted in this range" while the
budgets page showed the group, and one unrelated $1 category budget was enough
to make the whole section appear. The gate asks whether anything is budgeted
now, groups included. Where a period has only group budgets its summary line
shows the period's name alone: the line totals the category budgets, so a figure
there would read "$500.00 of $0.00" with a full red bar directly above a group
row saying $500.00 of $800.00.

## 0.1.5 - 2026-08-22

### Added

A dark theme, and a light one, either chosen or left to the machine.

The default is to follow the machine, and that is a standing instruction rather
than a value somebody was assigned: it keeps following, so a screen that goes dark
in the evening takes the app with it. Nothing detects the setting once and stores
the answer, which sounds like the same thing and is not. A stored answer cannot be
told apart from a decision, so the app could either follow the machine or remember
a choice, never both — and the mechanism that would have written it only fires for
an account that has never chosen anything, which no existing account qualifies as,
because saving a timezone counts. Every one of them would have upgraded into a
light app on a dark machine.

So there are three states, not two. Light and Dark stay where you put them.
Follow my system is the default and is the media query, which means it is right on
the first paint with no JavaScript at all. The choice is on the account rather than
in the browser, so it travels to another device, and a `theme` column defaulting to
`system` lands every existing account on the honest answer with no backfill to
guess at.

The moon in the sidebar switches it, next to Sign out — the only part of the shell
that already holds controls about this session rather than about the ledger. It is
a plain button that says what it will do, not a switch reporting what is on: a
two-state control cannot honestly report a three-valued setting. Pressing it while
the setting is Follow my system resolves the machine and sets the opposite
explicitly. Settings has the three-way choice, applying as you pick it rather than
on a Save button, because it is the one preference whose result is visible while
you are choosing it and two controls for one value must not be able to disagree.

Painting it before the page paints took a file rather than the usual inline script,
because the Content-Security-Policy here is `script-src 'self'` with no nonce and
no hash. An inline script would have been refused, reported nowhere — nothing
declares a report endpoint — and would have looked perfect locally, since neither
dev server applies the policy and one of them never serves the shell at all. It
would have reached a release as a flash of the wrong theme on every load.

The stylesheet had one palette written into it in 189 places. It now has two, in
one place each: 57 tokens, every one declared in both themes, with a test that
fails on a color written anywhere else and on a token given a value in only one
theme — which is the bug that makes half an app unreadable while looking fine to
whoever wrote it. Four literals turned out to be two colors sharing a spelling:
white is both a card and the text on a green button, and only one of those is
still white in the dark. The same split runs through the accent, where the green
that reads as a link is not the green a button is filled with, and in dark the
first has to lift while the second stays dark enough to carry white.

Three repairs to the light theme came out of writing the second one down. Six
grays carrying real text were under the contrast a person needs, the input
placeholder worst at 2.65:1. An input's border was 1.39:1 against the field it
edges, which is not a boundary — and an input here is white on a white card, so
that border is the only thing saying where the field is. It holds 3:1 now, and a
focused field is darker again rather than only greener, which is what it had
briefly become once the resting edge moved up to meet it. And the focus ring took
its contrast from whatever happened to be behind it, because it was
semi-transparent; it is opaque now.

The report palette was worse than it looked. Under simulated deuteranopia its
green and its pink were 1.78 apart as CIEDE2000 measures it, which is to say they
were the same color, and that shipped in 0.1.4 when six colors became ten. The
two palettes now reach 5.6 and 4.7 by keeping each slot's hue family across both
themes and varying lightness, which is the channel that survives. An honest limit
on that: ten categorical colors cannot all be told apart by somebody with
dichromatic vision, and a search that held hue identity and the contrast a line
needs could not beat about 7 and 4. The remedy is a second channel that is not
color, which is a change to the charts rather than to the palette. Until then the
legend and the table under every chart carry identity, and both are always there.

Emailed notifications, on a schedule, in two kinds.

A recurrence can say to write when it proposes. One message per proposal however
many rows it holds, naming the dates and pointing at Staged transactions, sent to
the address on the account. It says nothing on a tick that proposes nothing, so a
schedule that has caught up goes quiet rather than arriving every five minutes.
The Recurring list says which recurrences are set to send one.

A template can carry a reminder, which is the other half of the same idea: a
template is filled in by hand, so nothing can make it for you, but something can
tell you it is the day. Once on a date, or repeating on the same schedules a
recurrence offers, and either way at a time of day — the first thing here that
needs more than a date, and it is read on the person's own clock rather than the
server's. The Templates list says which templates have one and whether it
repeats.

A reminder that happens once is a first-class answer rather than a yearly rule
nobody means: its frequency is null, and it refuses the interval and the policies
a repeating rule needs rather than storing leftovers of them. Once sent it says
so and the scheduler stops looking at it.

Both ride the recurrence scheduler's existing tick rather than a loop of their
own, and a backlog collapses into one message: coming back from a week of
downtime brings one reminder, not seven. Neither can be delivered without
`SMTP_HOST` and `MAIL_FROM`, and the form says so rather than accepting a setting
that would quietly never fire.

Reports. Six of them, over one date range, per currency and never added across
currencies: net worth and a balance sheet for what the accounts hold, income
against expense and categories for what moved, a cash flow statement for where
the money that can be spent came from and went to, and a trial balance that
totals zero when the books are whole. Each is a preset over one query that
differs by which accounts it reads, whether it reports a period's movement or
the balance it ends on, and how time is bucketed — weekly, monthly, quarterly,
yearly, or not at all. Reachable at `/reports` and over MCP as `get_report`.

The category report covers income as well as expense. Spending by category on
the dashboard answers only where money went, and the same question about money
arriving had no answer.

A per-account register: every posting in date order with the balance before and
after it, and the balance the window opens and closes on. It is for finding
mistakes rather than for analysis — where a balance goes wrong, this is the row
it went wrong on. An archived account ends at zero with the postings that closed
it out to equity still in the list. On the account page behind **Show register**,
fetched only when asked for so the ordinary visit costs nothing, and
`get_account_register` over MCP.

`whoami` says whether this deployment can send mail at all. A reminder is stored
whether or not it can, so an agent could set one up and had no way to tell
somebody it would never arrive.

The Reminder and Notifies columns sort, ranked by what they are going to tell
you rather than alphabetically by the badge text: a reminder still to come above
one already sent above none at all.

The reminder section of the template form is laid out like the schedule section
of the recurrence form, which is the same kind of thing and did not look like it.
It was a bare fieldset, so it took the browser's own `padding-inline` and its
heading sat indented from every other label on the screen, with eleven controls
stacked against each other for want of a gap. It is the same card now, with the
same small-caps heading, and it ends the way schedule ends: with the next five
dates it will actually send on, and the time each goes at. The note explaining
what a reminder does moved up under the checkbox it explains, from the bottom
where it read as a footnote to the weekend policy.

The notifications section of the recurrence form had the same bare fieldset, one
section below the schedule it was supposed to match. And the template form's
description field was half a row wide, alone inside a two-column grid.

Axes on the report charts, which shipped without any. A line that ended higher
than it started was all either chart actually said: there was no value scale
beside it and no date under it, only a caption naming the range. Both now carry
gridlines on round numbers — worked out in scaled integers, so a tick sits
exactly where its own label says it does — and the dates of the periods they
cover, written as that period is named rather than as a full date, so a year of
months fits.

The axis text is HTML rather than drawn into the SVG. The drawing scales to its
panel, so a label inside it would read as twelve pixels wide on a desktop and
four on a phone, which is an axis nobody can read on the device most likely to
need one. How many dates fit comes from measuring the chart rather than from a
breakpoint, because the same chart is wide on the reports page and narrow in a
card at the same viewport.

Reports sits after Recurring in the sidebar rather than after Transactions. The
sidebar reads in order: where the money is and what moved it, then the work
waiting on you, then the things that file and repeat it, then what it all adds up
to. A test holds the order, because an ordering nothing asserts is one a later
edit reorders by accident.

Each account on the overview opens that account. The whole row rather than the
name, because the balance is what somebody is looking at when they decide to go
in, and the date range travels with them, so the account page opens on the
period they were reading.

The cash flow statement will not agree with income and expense, and the gap is
widest for whoever uses a credit card most: a purchase is an expense the day the
card is swiped, while the cash leaves when the bill is paid, in a different
period and as borrowing rather than spending. Both figures are right. The report
says so on the page rather than leaving it to be discovered.

Staged transactions finds a row that repeats something already recorded,
not just one that repeats another row still waiting. The check it had wanted the
same day and the same payee, which a real import has neither of: the bank posts
when it settles and names the merchant its own way. So the amount is the anchor
now, with the account and the direction to keep two unrelated spends of the same
size apart, and three days of latitude on the date. Payee and category are
ignored, being the two most likely to differ between a bank's record of a
purchase and yours. The same `duplicate` filter finds all of it.

That looser test is advisory. What refuses a commit is unchanged and still
strict, because loosening it would start turning down two genuine coffees bought
on one card in one week.

A run through every flagged row, from **Review N possible duplicates** at the
top of Staged transactions. Each comparison says which one of how many it is and
carries Previous and Next, and dropping a copy lands on the next pair rather than
back at the list, so a dozen duplicates are a dozen decisions instead of a dozen
round trips through the queue to find the next badge. The badge on a single row
still opens that pair directly.

A side-by-side review, reached from the badge on any flagged row. Both records
are open to edit and each saves on its own; a staged row saves rather than
commits. The one already in the books sits second — on the right, or underneath
on a phone — and where both are staged the older one does. Only a staged side
can be dropped, because the way out of a duplicate is to remove the copy that
has not been recorded yet. It is not a diff: the fields that differ are the ones
that always differ, and coloring them says nothing a person reading two
transactions cannot already see.

### Changed

How this describes itself. Every page inside the app already spoke plainly —
"Where your money sits and how it moved", "Everything you track, from checking
and cards to cash and crypto wallets", "Rows waiting on you" — and the marketing
copy was the one place that talked like a spec sheet. It led with the automation,
then with double-entry, then with privacy, none of which is what somebody wants
from a personal accounting app; they are how it delivers what somebody wants.

So the front page, the manifest, the container label and the sign-in screen all
lead with what you get: where your money is and where it went, every account in
one place, statements that file themselves, bills you set up once, reports that
add up. The double-entry books and the MCP server follow as the reasons those
things can be relied on — which is the honest ordering, since the books are what
the agents are being careful with. The Helm chart's own description and the
scheduler image's label had been left on the old framing and now match: those are
what `helm search` and a registry listing show, so they are the front page for
anybody who arrives that way.

The queue in front of the books is called Staged transactions, everywhere. Twenty
places in the app called it "the review queue" instead, which is what it is and
has never been what it is called — so a recurrence promising to propose "into the
review queue" was naming a screen that is not in the sidebar under that name, and
a person who went looking for it would not find it. The name is used wherever
somebody has to go and find it, including the notification mail's subject line;
the description is kept where the sentence is explaining what the screen is for.
One verb phrase covers it throughout — a recurrence adds a row to Staged
transactions — rather than five ways of saying the same thing. The two dialogs on
the page itself say "the queue", because you are already standing on it, and the
consent screen describes what the agent can do rather than where the rows land,
which is what the three scopes beside it do.

An idempotency key means the same thing over MCP as it does over the HTTP API.
Ten MCP writes kept a replay record of their own on top of the one the service
they call already keeps, and the two matched a retry differently: the outer one
against the request as it arrived, the inner against what the service had
normalized. A retry of a mass edit that listed the same rows in a different
order was a different request to one and the same request to the other. They
call their service directly now. Records already written are inert, and no key
in an existing database loses its replay.

`set_preferences` no longer advertises a call it refuses. Every field of the
patch is optional, so an agent reading the schema was told that sending nothing
but an idempotency key was valid, and found out otherwise at runtime.

`create_transaction` says that a near-identical entry is refused and what
`allowDuplicate` is for. Both mass edits say that one split anywhere in a
selection refuses a category or type change for the whole call.

`list_payees` described itself as returning canonical payee names. It returns
every stored spelling, one row each, which is the opposite and the reason
`list_duplicate_payees` exists. Both now say which question they answer.

Recurrences report their shape over MCP. `get_recurrence` and
`list_recurrences` declared it as an unknown value, so the one thing an agent
reads a recurrence for was the one thing the tools would not describe.

Recategorizing the last transaction off a category removes that category. Only
what an edit moved off is considered, so one made ahead of time and standing
empty on purpose is left alone, and anything a recurrence or a template still
names is kept — neither holds a foreign key, so nothing else would stop the
delete and what would be left is a standing instruction naming a category that
is gone. A queue-scoped agent edits the row and leaves the category, on the same
rule that keeps it from creating one.

Payees needed no such change and got none. Every list of them is a group-by over
the rows that name them, so a payee nothing references has already stopped
existing.

### Fixed

The keyboard could not work the choices these forms offer. Six sets of radio
buttons had no shared `name`, which is the attribute that makes a set of radios
one group rather than several unrelated controls — so the arrow keys did nothing
and every option was its own tab stop, putting four presses between a four-option
group and the field after it. React enforces one-of-many through its own state
regardless, which is why it survived: it looked right, it clicked right, and only
the keyboard was wrong. The names are per instance now, so two of the same form on
one page do not share a group and clear each other.

The three transaction type grids are one control, and it now does what it always
claimed. All three declared themselves radio groups with radio children and
implemented none of what that promises, so a screen reader was told to expect a
keyboard interface that was not there. The group is one tab stop, the arrows move
the choice and wrap, and Home and End go to the ends. One of the three was not a
radio group at all: on a template, clicking the chosen type again is how somebody
says there is no type, and a radio has no way to become unset — that one says what
it is, a set of toggles.

Filtering Staged transactions by a payee could return nothing at all. The
comparison folds Unicode presentation forms on the way in — that is what makes
"ﬁ" and "fi" the same payee everywhere else — and this one place did not, so a
payee holding a ligature or a full-width letter never matched anything and the
queue came back empty rather than saying why. The rule is now spelled the same
way in all six places it appears in SQL, and a test fails when they diverge,
because a spelling that differs does not raise: it silently fails to match.

Merging payees left a staged row's fingerprint describing the payee it used to
have. The queue flags a row as repeating another by comparing those fingerprints,
so two rows that had just been made identical stopped being reported as repeats
of each other. Rows keyed on a bank's own reference were never affected, which is
why this was easy to miss.

Resolving a payee to the spelling the ledger already keeps stopped reading the
whole ledger. It runs on every single transaction write, and the expression it
matched on — the same Unicode folding as above — was one no index could serve, so
each save scanned the account's own rows. Both sides of it are indexed now: on
five thousand transactions that is 6.3ms and two hundred buffers becoming 0.02ms
and three.

Staged transactions died on a single row it exists to show. A draft date matching
the shape of a date but naming no real day — `2026-02-30`, `2026-13-01` — was
accepted, filed with a "Date is not valid" issue, and from then on every attempt
to list the queue failed on the cast. The queue was the only place that row could
be seen, so the only cure was deleting it by an id nothing would show you. The
guard now asks what validation already decided instead of trying to out-guess the
calendar. The amount guard had the same hole with no bound on length, where a
draft of two hundred thousand digits overflowed `numeric` and took the default
sort down with it; both now hold to the shape the domain accepts.

Two answers to what day it is. PostgreSQL reads a bare offset timezone with the
POSIX sign convention and `Intl` reads it as ISO, so for anyone whose stored
timezone was an offset rather than a zone name the two disagreed by sixteen
hours. An account archived in that window closed on a day the dashboard had not
reached, and its balance was left out of the headline total while the ledger went
on counting it. One implementation now answers the question, and PostgreSQL is
not asked.

Net worth and the balance sheet took an archived account's history away along
with the account. Excluding it dropped it from every bucket, including the months
it was open and holding money, so a monthly chart lost history it had reported
correctly the day before. Archiving posts the balance out to equity, which is
what carries the account to zero on the day it closed; the row is kept and hidden
only when it is flat at zero across the whole window. So on those two reports
`includeArchived` no longer changes a figure, only which rows are listed, and
each row now carries `archived` — a closed account's past would otherwise read as
money still sitting in the live ones. A currency with nothing left to list is
left out rather than returned as an empty section.

A payee-sorted list paged with a cursor could skip rows or never end. The
ordering was `lower()` in the database and `toLowerCase()` in JavaScript, and
those are different functions — they disagree on a Turkish dotted capital and on
a final sigma, and whether they disagree at all depends on the database's
collation. The cursor now carries the value the database sorted on.

The categories report added income to expenses and headed the answer "Net". Each
row is a magnitude there, on purpose, so the column sum is a total filed rather
than a net, and it says so. The trailing column of a running-balance report is
headed "Closing" rather than "Total", because that is what it holds.

The same report showed one name twice with no way to tell the rows apart. A
category set to cover both sides is two rows there, correctly — one for what came
in under it, one for what went out — and Uncategorized always is. Only a name
that really does span both sides is qualified now; every other row reads as the
person wrote it.

A report chart had six colors and no limit on how many rows it would draw, so a
seventh account shared the first account's line and the legend said two things at
once. There are ten, and a test fails if the stylesheet and the code disagree
about how many.

Every badge in a transaction row sat on a line of its own, doubling the row's
height. The class holding the payee beside it had never been defined in the
stylesheet. Six other class names in the browser named nothing at all and are
gone.

The audit log recorded a template's reminder as having never existed. Three of
the five paths that write a snapshot took a default of null, and in an
append-only record null does not read as "nobody asked" — it reads as "there was
no reminder". A bulk edit therefore claimed to have removed one, and both delete
paths recorded the reminder as never having been there.

A template saved again re-sent a reminder that had already gone. The row is
replaced whole, so an edit to the payee replaced the watermark with it and the
reminder was owed again. A schedule that really did change still starts afresh,
which is what somebody moving the date is asking for.

The rows waiting above a committed list were not narrowed by the filters the
list was. On a category, payee or template page the two read as one list, so
choosing a type or typing into the search box moved the committed rows and left
the staged ones standing above a list they had just been excluded from.

The register's link on each posting carried a parameter no list in the product
accepts, so it was dropped and the row landed on the whole unfiltered
transactions list. It narrows by account and that one day now.

The application shell described the product differently from the manifest the
release publishes, and colored a phone's browser chrome near-black on a
stylesheet that commits to a light scheme.

A staged mass edit left behind a category the identical edit, done one row at a
time, would have cleared. The committed side had the same split and was fixed in
this cycle; the queue had it too. A caller holding only `ledger:stage` still
leaves the category standing, on the rule that a queue token proposes and never
decides.

The reminder sweep claimed rows on a deployment with no mail server. Every claim
advanced a watermark past an occurrence nobody was told about, so configuring
SMTP a month later would have found a schedule that had quietly eaten its own
backlog — the opposite of what the form promises. It leaves before claiming
anything now.

The split deployment served the one document that runs the app without seven of
the headers every other response on the origin carries, including both
`Cross-Origin-*` policies. nginx repeats the whole set now, the list lives in one
place, and a test runs a real response through the middleware and fails if the
two differ by a header or a value. `X-Frame-Options` is `DENY` on both, rather
than Hono's `SAMEORIGIN` contradicting the `frame-ancestors 'none'` beside it.

The generated first-run setup code belonged to one process. On a web tier running
more than one replica — which the chart does by default — the code printed in the
log was rejected by every other pod, so the claim the chart's own notes describe
failed about half the time. It is stored now, like the MCP signing key, so every
replica agrees on it. An operator-chosen `SETUP_TOKEN` still never touches the
database, and Pulumi can supply one, which it could not before.

Validating a staged draft opened a ledger account. Preparation is meant to answer
whether a draft would balance and nothing else, so an agent holding only
`ledger:stage` — the posture that is supposed to be unable to touch the books —
added a counter-account and a new zero row to the trial balance. It looks the
account up now and stands one in when there is none.

Smaller ones. A malformed request body answered 500 with a stack trace instead of 400. A mistyped `/api/v1` path, and any with a trailing slash, came back as the
application shell with a 200. Responses carrying a session token had no
`Cache-Control`. A broken consent cookie 500ed. An `APP_BASE_URL` that was not a
URL, and every strict scalar setting, refused to start without saying which
variable was wrong. A register window opening after today summed future postings
into a balance labeled as of today. The cash flow statement read every posting
in the ledger to answer about one month, at eight times the cost. A failed report
also told a full ledger it was empty, and reports could show figures from before
an edit. The recurring list ordered amounts as text, so 1.50 sorted below 1.45.
One search box had no accessible name.

A table wider than the panel holding it spilled past the edge instead of
scrolling inside it, so the far columns could not be reached at all. The
templates and recurrences pages both wrapped their table in `table-wrap`, a
class nothing in the stylesheet ever defined, and had done since they shipped.
The rule exists now, and a test names any table left without a wrapper that
scrolls.

Cash flow, income and expense, and spending by category asked whether each entry
still runs through an archived account once per posting rather than once per
query. On a ledger of a hundred thousand postings the dashboard's own cash flow
ran that subquery twenty-eight thousand times, reading a hundred and seventy
thousand buffers to produce two rows. The same rule is now one aggregate the
planner turns into a hash anti-join: sixty times fewer buffers and seven times
faster, with the netting that decides membership unchanged.

A duplicate payee group offers the spelling the ledger would itself keep. The
group was ordered by how often each spelling is used and then by name, while a
write reusing a payee breaks a tie by preferring a name already equal to its own
cleaned form. So three equally used spellings of one store offered
`" ACME MARKET "` as the one to merge into, where the ledger would have kept
`"Acme Market"`. Both the browser and the MCP guide say the first entry is the
target, so this was the wrong answer rather than a cosmetic ordering. One rule
now, used by the group and by the write.

Sorting Staged transactions by amount could fail on a row whose amount a CSV left
unreadable. The guard meant to catch that admitted anything with a digit either
side of any character, so `42x50` passed it and then raised on the cast — a
backslash lost to a template literal, in a regex that has been there since the
column was sortable.

The recurrence form's preview test asserted a date that has now gone by, and
would have failed from here on whatever anybody changed.

### Internal

Gates that could not fail. The PostgreSQL job would have gone green having
skipped every integration file if it ever lost its database URL, and nothing
asserted otherwise. The chart's negative gate checked that a render failed
without checking why, so deleting the guard under test still read as "refused".
The NetworkPolicy template was never rendered at all, being off at default
values. A release resolved its tag twice, so a tag moved mid-run could verify one
commit and publish another; it resolves to a commit once now. A dispatched
re-publish inferred that an unsuffixed version was final and moved `latest` on to
a release marked as a prerelease — it asks instead. Two tags could publish at
once and race for `latest`. And no test covered the chart's `appVersion`, the one
version location whose drift installs the previous release's images.

A refused second Ralph run deleted the lock the first one was holding, because
the lock was named before it was taken, leaving a third free to start alongside
the first. The git guard's config scan missed git's one-line
`[section] key = value` form, catching the same key only when written underneath.
`set-version` did not know about the Pulumi project's manifests. They happen to
be current, because the version they were added at is still the version — but
nothing in the root install or the root verify reads them, so nothing would have
said otherwise.

Thirteen schemas in the shared contracts no longer carry an export nothing
outside the file used. Six types the browser had hand-written copies of are
re-exported from the contracts they duplicated.

CI starts the frontend image rather than only building it. Its nginx
configuration is a template the entrypoint renders at startup, so a malformed
`add_header` — or a location-scoped directive in an include the main config
pulls into `http{}` — is a startup error a build never sees, and it would have
reached a release. The shell and a hashed asset are both asked for, because
nginx drops inherited `add_header` from any level with one of its own.

The two lockfiles are held to the same resolved versions rather than only the
same ranges, so installing in one and not the other cannot ship an image running
a version the suite never saw.

`clockTimeIn` had no test. It is what decides whether a reminder goes out at the
hour somebody asked for, by string comparison against a stored `HH:MM`. Covered
now, along with a bare offset read as ISO rather than POSIX, both ends of the
date line, both daylight-saving boundaries, and an unreadable timezone falling
back to UTC rather than throwing inside a loop that serves every tenant.

Both `.env.example` files and the chart's values said a mail server buys a
password reset and address confirmation. It also decides whether any scheduled
reminder is ever delivered, which was in none of them.

`set-version` now rewrites the example image tags in the split-deployment
compose file and the Pulumi README. Six tags a release would have left pinned to
the previous version, on the two pages somebody copies from.

Four indexes are dropped whose leading column another unique constraint on the
same table already leads with. No query loses a plan; four tables stop
maintaining a second copy of their own first column.

Money arithmetic moved out of `components.tsx` into `money.ts`. It was three
hundred lines of exact decimal comparison filed under a name that says React
component, which is not where anybody looks for arithmetic. Two report suites
compared money by casting it to a double, which is the mistake the house rule
exists to forbid, and two brute-force property tests had unbounded scan loops:
an implementation that stopped advancing would have hung the file rather than
failing it.

The README is half the length. Everything it said about how each feature works
moved to a guide of its own, so the front page answers what this is, what is
good about it, and how to start, and the walkthrough is one link away rather
than a hundred and fifty lines down. The architecture notes now cover the mail
half of the scheduler, which had shipped undocumented.

## 0.1.4 - 2026-08-14

### Added

Recurring transactions. Rent, a salary, a subscription: anything that arrives on
a schedule can be set up once and left. Daily, weekly, monthly or yearly, every
N of those, on a day of the month or on a relative day such as the second
Tuesday or the last Friday. You choose what a schedule anchored to the 31st does
in February, and what happens when a date lands on a weekend.

On each due date it puts an ordinary row in the review queue, dated its own
occurrence rather than the day the scheduler ran, and posts nothing. Leave the
amount out and each proposal waits in the queue for a number, which is what the
electric bill wants. A recurrence naming an account that has since been
deleted still proposes its row, flagged and saying which field, rather than
failing where nobody would see it. Deleting a recurrence leaves every row it
proposed alone.

Open the menu on any row, on the transactions list or the review queue, and save
it as a recurring transaction, beside where you would save it as a template. The
row fills the form in, and the date it fell on becomes the day of the month the
schedule keeps to, rather than whatever today happens to be. What it does not
carry is the reference it was imported under, for the reason a template does not
carry one: on every proposal, it would make the next real import of that
statement row look like one already seen. Two accounts in different currencies
say so before you save, since the rate belongs to the day it was got and each
proposal has to wait in the queue for it.

The scheduler runs inside the server process and is on by default, so the
documented single container keeps working with nothing added to it. Set
`RECURRENCE_SCHEDULER=false` to switch it off on replicas that serve the API.
Running several with it on is safe: each recurrence is claimed with `for update
skip locked`, so replicas divide the due list rather than wait on one another,
and a per-occurrence unique key refuses a duplicate proposal even if a claim
were bypassed. Holidays are not modeled; a business day means Monday through
Friday.

Four settings control it: `RECURRENCE_SCHEDULER`, `RECURRENCE_TICK_SECONDS`,
`RECURRENCE_CATCH_UP_LIMIT` and `RECURRENCE_CLAIM_LIMIT`. Only the first is
likely to matter to you, and only if you split the deployment up.

A Helm chart under `deploy/helm/`, a compose file that runs the same split on
one machine under `deploy/compose/`, and Pulumi programs for EKS and GKE under
`deploy/pulumi/`. All three tiers autoscale. The chart provisions no database:
raising a PostgreSQL StatefulSet's replica count gives you empty databases
rather than capacity, so it takes a `DATABASE_URL` and leaves the database to
you.

Set `DIRECT_DATABASE_URL` when PgBouncer or another transaction pooler sits in
front of PostgreSQL. Every lock the ledger takes is transaction-scoped and suits
transaction pooling exactly; the two that are not, the migration lock and the
first-account claim, use this string to go past the pooler.

Three Dockerfiles under `deploy/docker/` split the single container into a
server, an nginx frontend, and a scheduler, for running this under Kubernetes.
Each publishes alongside the single container, on the same tags, as
`simple-balance-server`, `simple-balance-frontend` and
`simple-balance-scheduler`. The single container remains the supported way to
run this. See [deployment](docs/deployment.md).

One transaction can now be split across several categories. The grocery receipt
that is partly food, partly household and partly something for the dog is one
entry with three legs, and each leg is attributed to its own category in
spending reports, on category pages, and over the MCP.

A split is the counter-account side of the entry cut into pieces rather than a
second record of the money, so nothing is counted twice: the categories add up
to exactly the cash that left the account. Every existing rule holds unchanged.
The entry still settles to zero in each currency it touches, postings are still
append-only, a correction still costs the difference and nothing more, and
deleting still voids the entry a leg at a time.

Relabeling a leg writes no postings at all, because the label lives on the leg
and the leg's identity does not change when you rename what it is for. Changing
what a leg is worth writes two, which is right: the money was divided
differently.

Splits work on committed transactions, on rows waiting in the staging queue, and
on templates, where the categories are stored and the amounts left for you to
fill in. A CSV export carries a split by category name and reads back as the
same split in a different ledger or a fresh install. Mass editing category or
type is refused on a split rather than flattening it, and the panel says why.

Upgrading runs three new migrations: 0005 for splits, 0006 for recurrences and
0007 for the shared sign-in attempt table. All three are schema changes rather
than data migrations: nothing existing is rewritten, no row is backfilled, and
every figure reads the same the moment they finish.

### Changed

The license is now the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`), where it was the LGPL. What changes for somebody running this
is nothing: self-hosting it for yourself, your household or your company was
free before and is free now. What section 13 adds is that offering a _modified_
version to people over a network entitles those people to that version's source.

Every release up to and including 0.1.3 was published under the LGPL and remains
available under it. This applies from 0.1.4 onward.

The AGPL is a complete license rather than a set of permissions layered on the
GPL, so the images carry one license file where they used to carry two, and
`COPYING` is gone.

### Security

`NODE_ENV` was compared against one string, so any other spelling, and leaving
it unset, read as development: no first-run setup code, no sign-in rate
limiting, no secure cookies, and nothing to say it had happened. It is parsed
against a closed set now, and a process outside production that has been given a
real `APP_BASE_URL` refuses to start rather than warning about it.

`AUTH_SECRET` clearing 32 characters said nothing about whether it was secret.
The value this project falls back to outside production and the one
`.env.example` carried both cleared it, so a deployment could sign every session
with a published string. Production names and refuses them, and the example file
now ships no placeholder to leave in place. If you copied that line, generate a
real one: `openssl rand -base64 32`.

The agent consent screen read the client name and the scopes it displayed out of
the query string, which is written by whoever wants the grant. A link could show
a familiar client and read-only access while approving a stored request for
something else. Both now come from the record the consent code names.

Guessing the first-run setup code cost nothing: a wrong one was refused before
the rate limiter ever saw the attempt. Attempts are counted per caller now, five
to a fifteen-minute window.

Adding a sign-in password to an account that has only ever used Google took a
session and nothing else, so a borrowed cookie could mint a second permanent
credential in silence. It now needs a session created in the last fifteen
minutes.

Changing or resetting your password revokes every agent's access along with the
approvals behind it. Before, an MCP token an agent already held kept working for
its hour and its refresh token kept minting replacements for a week.

Sign-in attempts were counted in the process, which bounds nothing once more
than one is serving: each replica kept its own tally, so the allowance was
multiplied by the replica count and a guesser only had to spread their attempts.
Both counters, the sign-in one and the first-run setup code, are counted in
PostgreSQL now. A tally in the process still refuses a caller already over the
allowance without asking the database, so a flood does not become a write storm.

Dynamic MCP client registration is unauthenticated and was minting a client
secret for whoever asked, then storing it in the clear. The
`storeClientSecret: "hashed"` setting never reached it: that one belongs to the
OIDC provider's own register endpoint, and discovery advertises a different one.
Clients register as public now. PKCE was already required and plain challenges
already refused, which is what binds a code to its caller.

`stage_csv` created categories, brought archived ones back, and widened what
kind of entry a category may carry, all under `ledger:stage` — the scope for an
agent that may propose and never decide. Those three need `ledger:write` now;
with only staging authority the row is staged under the category's name and
committing it is what makes the category.

The MCP access token carried the opaque grant token as a readable claim. A JWT
is signed and not encrypted, so a proxy or a log holding one held a credential
good for seven days. It names the grant by row id now, which opens nothing on
its own, and a revoked grant stops working immediately rather than at expiry.

The frontend container served the application shell with no content security
policy, no `nosniff` and no framing policy, because those headers are set by the
API process the static files never reach. It also appended to `X-Forwarded-For`
rather than replacing it, against the trust model its own deployment guide
documents, so with `TRUST_PROXY=true` sign-in attempts counted against an
address the caller chose.

Signing in returned to the path in the address bar unfiltered, and
`//elsewhere.example` is a legal path that a browser sends to another origin.

### Fixed

A staged split can now be found under a category one of its legs names. The
queue's filter read only the entry's own category, so a split showed in the
count on the category page and then was missing from the list that count links
to.

Merging a category carries recurring transactions through with everything else,
and deleting one now counts them as a use rather than destroying the category
underneath them. Deleting your whole account also names the recurring
transactions it is about to take.

A stored timezone that has stopped being recognizable, after an ICU update or a
hand-edited row, no longer throws when the dashboard works out what day it is.
It falls back to UTC. The value is free text checked only when it was written,
and the scheduler now reads it in a loop that serves everybody, where one bad
row must not be able to stop the rest.

Deleting a category a template refers to, or an account a recurring transaction
names, is refused rather than leaving a template that cannot be saved or a
schedule that proposes a flagged row every month with nothing saying why.
Neither reference has a foreign key, because both live inside JSON.

The audit trail records a split's legs. Relabeling one is a single update to
the leg: it writes no posting and changes no column on the transaction, so
Activity showed a before and after that were identical for the change most worth
looking up later.

A mass edit no longer drops the record of which template a transaction was
started from.

A search containing `%` or `_` searches for those characters instead of treating
them as wildcards, and the search box waits for you to stop typing rather than
querying the ledger on every keystroke.

The review queue shows a staged row's category even when that category has since
been archived, instead of rendering it as Uncategorized with a blank field in
its editor.

One import stages at most what one action can then commit, edit or delete. The
CSV row limit was 25,000 by default and up to a million, while every mass action
caps at 10,000, so a large import produced a queue nothing could clear in one
go. `CSV_MAX_ROWS` now defaults to 10,000 and cannot be set above it. Lowering
it still works.

"Select all filtered" on a mass edit or delete is refused past 10,000 rows in
the database rather than after every matching row has been read and
fingerprinted in memory, and the CSV preview enforces the same size limit the
import does.

The dashboard runs its three aggregates together instead of one after another,
the CSV export walks the ledger once instead of re-counting it for every page,
and a transaction write asks about the one payee it names rather than grouping
every payee in the ledger.

A CSV export now carries the bank's own reference for each row, and an import
no longer invents one. The file had no column for it, and restoring one wrote
the source ledger's internal id into that field instead, so the check that stops
a statement being imported twice was keying on an identity that means nothing in
the ledger it was read into. Files written by 0.1.3 and earlier still import; their
rows simply carry no reference, which is the honest answer for a file that has
none. One consequence worth knowing: a row with no bank reference, re-imported a
second time under a different account, is no longer refused as a duplicate,
because the invented id that used to catch it is gone.

A transfer keeps its category when an export is restored into another ledger,
and a category whose name begins with `=`, `+`, `-` or `@` no longer gains an
apostrophe on every round trip and becomes a second category each time. The
visible column stays safe to open in a spreadsheet; the value the import trusts
travels beside it where nothing rewrites it.

Archiving an account now closes it at zero on the day you archive it, not on the
date of the last transaction it happens to hold. A single closing entry dated
that last transaction left the account holding a balance on every day in
between, while every total had already stopped counting it: a report for a date
in that window showed money in an account you had retired, and restoring it in
that window put the balance back on top of one that had never left. Accounts
archived before this are re-closed once, the first time the server starts, which
is logged. Nothing is deleted and no total changes for an account whose
transactions are all in the past.

A negative number in a mapped Debit or Credit column no longer has its sign
quietly removed. Where the file has both columns the other one is what a
reversal goes in, so the column decides and a sign changes nothing, which is how
nearly every two-column bank export is written. Where it has only one, the sign
is the only way that file could say the other direction and nothing says which
was meant, so the row is refused with the reason rather than staged in whichever
direction the column implied.

A recurring transaction set to a relative day, such as the second Tuesday, no
longer proposes a date that has already passed, and the form's preview shows the
date the scheduler will actually propose first. Typing a negative interval no
longer freezes the tab.

Editing the amount of a transfer between two accounts in the same currency now
works. The form was sending a received amount from a field it never showed, and
the ledger refused every save. A transfer also keeps its category when you edit
it, rather than losing it to a form that has nowhere to display one.

A staged row filed under a category by name keeps that name when you open it to
review it, instead of committing uncategorized.

Two settings changes made at the same time no longer overwrite one another.

The timezone and currency the browser detects are offered only while nobody has
chosen, and that is now decided by the server at the moment of writing rather
than by the page against the session it loaded with. Choosing a timezone in
Settings on one tab, or on another device, while a Simple Balance page is open
elsewhere could previously have that choice replaced by the other page's guess.

## 0.1.3 - 2026-08-06

### Added

A template holds whatever subset of a transaction you give it, and only the name
is required now. The type is optional like everything else, and a date and a
category name are stored where before they were refused. The import reference is
still refused, and is the only one: copied onto every transaction made from the
template it would make the next real import of that statement row look like one
already seen.

Applying a template fills in the fields it carries and leaves the rest as they
were, so it works on a transaction that already exists as well as on a new one.
The picker is on the edit form now, not only on Add transaction, which is the
point of the change: a template is a quick way to correct a row somebody else's
import got wrong, not only a way to start one.

The exception is a field the previously chosen template set, which goes back to
what the form held before any template. Without that, picking Rent and then
Coffee would leave Rent's amount attached to Coffee, which is a wrong
transaction one click from being committed. Typing a value yourself and then
applying a template keeps what you typed, because no template put it there.

Each template also reports what came of it: how many committed transactions,
how many rows still waiting in the review queue, and the two added together, the
same three numbers the categories and payees lists show. The count is a link to
those transactions, on a screen of the template's own. A transaction records
which template it was started from, and `list_transactions` takes a `templateId`
filter so an agent can read the same thing.

That record is provenance rather than current state, so it carries no foreign
key. Deleting a template is still allowed and still leaves the transactions made
from it untouched; they simply stop being counted. A key would have made a used
template undeletable, or deleted real entries along with it.

Templates have a screen of their own, above Import CSV in the menu, and Settings
no longer has them. Settings was where the feature landed because it arrived as
one small management panel; a list you sort, search, page, and change many rows
of at once is not a setting.

It is the transactions screen's shape. Every column it shows orders by that
column, the search narrows on name, payee, and notes, and the row menu edits or
deletes one. Check some rows and the selection bar offers a mass edit and a mass
delete, both atomic. The screen also creates a template, which Settings could not
do: a management screen with an edit and a delete and no way to add a row sends
you back to the transactions list to invent a transaction you did not want. Saving
one from a transaction or a staged row is unchanged.

A template mass edit has a third answer per field that a transaction mass edit
does not need. A template's fields are blank on purpose, so besides leaving a
field alone and setting it, you can clear it: the template stops carrying an
amount and starts asking for one each time you use it. An empty string is refused
rather than read as a clear, because blank and absent meaning different things is
the whole of what a template records.

Two things the screen decides rather than guesses. Changing a template's type
drops whichever account side the new type cannot hold, because nothing asked for
that side and a template holding an account nothing reads is worse than a blank;
a change that does not touch the type leaves both sides alone. Setting a side the
type cannot hold is refused and names the templates that could not take it,
because something did ask for that one. And a template naming an
account or category that no longer exists now says Unavailable in its row; the
Settings list dropped those silently, which hid the one thing most worth knowing
about an old template.

`bulk_edit_transaction_templates` and `bulk_delete_transaction_templates` give an
agent the same two operations, so the MCP surface still does everything the
browser does. Each names every template outright with the version it was read at,
and one that moved underneath refuses the whole call. There is no fingerprinted
filter selection here: that contract exists for rows a browser has never loaded,
and a person can hold two hundred templates, so naming them all is cheaper and
more honest than describing them.

Templates, for the transactions you enter again and again. Open the menu on any
row, on the transactions list or the review queue, and save it as a template:
what you keep is a starting point, not a copy. Anything you clear before saving
is simply not saved, which is the point of the feature rather than a limitation
of it. A template with a payee and a category and no amount is the one most
people want, because the amount is the part that changes.

Pick one from the new dropdown at the top of Add transaction and the form fills
in. From there it is an ordinary form: change anything, change everything, the
template is untouched. There is no path from that form back to the template, so
that is a property of the code rather than a promise about it.

One thing a template deliberately never keeps: the reference a row came in from
a bank file under, because copying that into every transaction made from the
template would make the next real import of that statement row look like one
already seen.

An account or category the template names is looked up when you use it, and
dropped with a note if it is not there anymore. Templates outlive the accounts
they mention rather than being deleted along with them. Rename, reshape, or
delete them on the Templates screen.

Agents get templates too, through `list_transaction_templates` and the create,
update, and delete tools.

The categories list says how much each category is actually used: how many
committed transactions, how many rows still waiting in the review queue, and the
two added together, the same three numbers the payees list has always shown. You
can sort by any of them, so the category nothing has ever been filed under is
one click away, which is the one worth archiving or merging. A category with
nothing under it is listed at zero rather than left out.

The counts cover the whole ledger rather than a date range, because this page
has no date range on it. A category's own page does, and shows it, so a badge
reading 43 landing on a list of 7 has its reason on screen.

Agents get the same three numbers from `list_categories`, which is the cheapest
way to keep a ledger from accumulating a third spelling of Groceries.

Mass edit for staged rows, on the same terms as committed ones. Select rows in
the review queue, or select everything matching the current filters, and change
the date, payee, category, account, description, notes, or deposit/withdrawal
type in one atomic request. This is the fastest way through the case the queue
exists for: a CSV whose account column meant nothing to the importer leaves
several hundred rows all failing the same check, and one edit fixes all of them.

Every row it writes is validated again, so a batch that was failing on a missing
account comes back ready to commit, and the reply says how many are ready and
how many still need attention. The selection is protected the way a committed
mass edit is: explicit rows carry the version they were read at, and an
all-matching selection carries a server-issued count and `id:version`
fingerprint, so a row that moved underneath makes the whole request stale rather
than quietly taking a value nobody saw.

Account and type are refused on a transfer, which has two accounts and no single
one to move. Setting an account on a row that does not yet say which way the
money went is refused unless the same edit sets the type. Both refuse rather
than skip, so the count of rows changed always matches what was selected.

Agents get the same thing through `bulk_edit_staged_transactions` and
`preview_bulk_staged_selection`, with `dryRun` to see what a change would do
first.

The MCP surface now does everything the web app does. Fourteen tools closed the
gaps that had accumulated: reading and setting the timezone and default
currency, which is the one that mattered most because what counts as today is
decided by the person's timezone and an agent previously had no way to read it
or explain the figures it was given; payee suggestions, which is how an agent
avoids forking a store into a second spelling; previewing a CSV's columns before
staging it and listing the imports still awaiting review; fetching a single
account or category; the five template tools; counting everything in the ledger;
and `whoami`, which also lets a client pick itself out of the list of connected
agents.

Two things stay out of an agent's reach, and they are now the whole of the list
rather than the part somebody remembered to write down: deleting the account,
which destroys the audit trail that makes every other agent action recoverable,
and setting a sign-in password. Both are account management rather than
bookkeeping. A test compares the two surfaces route by route and fails if a
capability lands on one without reaching the other, so the boundary cannot drift
quietly.

### Fixed

An export could only be imported back into the ledger it came from. The importer
recognized its own format and then read the account ids out of the file, and
those ids name accounts of the ledger that wrote it. Into a different account,
a different person's books, or a fresh install they resolved to nothing, so
every row was rejected with "An exported account is unavailable" and staged
blank: no payee, no account, no category, no amount. A 5,334-row file arrived as
5,334 empty rows.

No account is read out of a file anymore, by any import path. The account is
the one chosen on the import screen, which is the only thing that decides where
rows land. The same export now stages with its payees, amounts, categories,
notes, and bank references intact, against whichever account was picked, for
whoever picked it.

An export also needs no column mapping now. Its columns are already known, so
the import screen asks for the account and nothing else, and `stage_csv` takes
one with no `mapping` at all.

Transfers are the one row this cannot decide. A transfer moves between two
accounts and an import names one, so those rows stage with everything else they
carry and ask for both accounts in the queue, where mass edit can answer for
every transfer in a file at once. Which side to put the chosen account on is not
guessed: a transfer pointed the wrong way is a wrong entry one click from being
committed.

A row that cannot be turned into a draft now keeps whatever could be read from
it rather than staging empty, so what reaches the queue is a row missing one
field instead of a row missing everything.

A quality pass over the whole application, driven by nine independent reviews
and by running it and using it. Everything below was found rather than
suspected, and each one has a test that fails without the fix.

Archiving an account could hang forever on a small connection pool. The closing
entry it posts read the person's timezone from the pool while its own
transaction was holding the only connection, so with `DATABASE_POOL_SIZE=1` the
request waited on itself: no answer, no error, nothing in the log. Preference
reads now travel on the transaction the caller already has.

An idle database connection that dropped took the whole container with it. `pg`
reports those on the pool rather than on any request, and with no listener that
is an uncaught exception and an exit, so a database restart or a proxy timeout
became a crash instead of a reconnect.

The accounts list sorted balances through `Number`, which cannot hold the
eighteen decimal places the ledger stores, so two balances differing in the last
of them sorted arbitrarily. Balances now compare exactly, sign included.

A staged row whose date column held something that is not a date turned the
category and payee pages white. `Intl` throws on a date it cannot read, and the
throw unmounted the page. Dates that cannot be read are now shown as they
arrived, which is what somebody needs to see to fix them.

A staged mass edit accepted `currency` and `includeDeleted` filters, advertised
them to agents, and applied neither. Narrowing an edit to one currency would
have had the preview count and the fingerprint agree and then rewritten every
row in the queue. Both are now refused rather than ignored.

A category could become permanently undeletable with nothing on screen to
explain it: the guard counted staged rows that had already been committed, which
keep their draft, so a category showing no transactions at all still refused to
go.

A mistyped id in a URL returned 500 and wrote a Postgres stack trace to the log,
on every `/:id` route. Ids are now checked before they reach a query.

Six pages told people they had nothing when a request had actually failed:
"Create your first account", "No accounts yet", "No categories in this view",
"No activity yet", "Create an account first". Each now shows the error, and none
of them claims emptiness while still loading.

Renaming a category left the old name on the transactions list and in the
spending figures until something else happened to refresh them. Committing a
transaction that created a category or a payee did not refresh either list.

The staged queue's row cap notice was tested against the page rather than the
total, so it could never appear however long the queue was, and a whole-list
selection that hit the cap still said "All … selected". It now says how many of
how many, and a selection that fails partway says so instead of quietly
stopping.

An MCP client configured with a trailing slash was capped at 256 KiB rather than
the CSV-sized limit, so it could complete the OAuth flow and then be refused an
upload the other spelling was allowed. The CHANGELOG entry that claimed
otherwise has been corrected.

The mobile navigation stayed in the tab order while off screen, so tabbing from
the header walked into a menu nobody could see.

Also removed: three CSS rules no component used, two type exports nothing
imported, and a `vitest` run that collected a second copy of every test when a
git worktree sat inside the repo.

The MCP endpoint answers on `/mcp/` as well as `/mcp`. They are different paths
to a router and only the second was registered, so a client configured with the
trailing slash completed OAuth correctly, had its grant recorded in Settings and
a valid token in hand, and then got a bare 404 on every call, which an agent
reports as an authorization problem. Discovery under the resource path accepts
the slash for the same reason, and so does the larger request body an MCP CSV
upload is allowed: the route was registered for both spellings but the body
limit still recognized only one, so a client using the slash could reach the
endpoint and then be refused a payload the other spelling was allowed.

### Changed

Uncategorized spending sits at the bottom of spending by category rather than
wherever its total ranks. It is not a category anybody chose, so putting it
first answers "what needs filing" on a panel that was asked where the money
went. It is still shown, and shown even when the list is cut short, because it
is the one row that says there is filing left to do. Ordered in the summary
itself, so an agent reading `get_financial_summary` sees the same order as the
page.

## 0.1.2 - 2026-08-03

### Added

Deleting your own account, from Settings, taking everything in it: accounts,
transactions and the postings under them, categories, payees, staged rows,
import history, preferences, audit history, sessions, sign-in methods, and every
agent you had connected. What will go is counted and shown first, and the address
on the account has to be typed, because that is the one thing on the screen a
stray click cannot produce. Nothing is kept and there is no undo.

It works by one delete: every table holding a person's data references
`auth_user` with `on delete cascade`, so nothing enumerates tables and a table
added later cannot be forgotten. The test reads the tables out of the database
and asserts not one row of the deleted account is left in any of them, which a
hand-kept list would not have done.

An agent cannot do it. Deleting is reachable only with a session cookie, which
an MCP token never becomes.

### Fixed

Signing up with Google. Better Auth declares its social callback as the route
pattern `/callback/:id` and hands database hooks that pattern rather than the URL
requested, so the policy deciding who may open an account was told
`/callback/:id`, matched nothing, and fell through to refusing. A first-ever
Google sign-up therefore failed with `unable_to_create_user` while linking
Google to an account that already existed kept working, because linking creates
no user. Both forms of the path are now recognized.

The icon. It was in the built bundle and nothing routed to it: only `/assets/*`
was served as files, so a request for `/favicon.svg` fell through to the
single-page shell and a browser was handed HTML under a `text/html` content type
for an image. The whole root of the bundle is served now, and the Apple touch
icon is a PNG rather than an SVG, which iOS does not accept.

### Changed

A new account starts on the timezone and currency its browser implies rather
than UTC and USD. UTC is wrong for most of the world in a way that misdates
entries: something recorded on a California evening lands on tomorrow. The
timezone comes from the browser, which knows it exactly, and the currency from
the region of its language tag, with USD when the tag names no region. Both are
ordinary settings afterward, and nothing is adopted once anybody has chosen.

The sign-in screen and Settings no longer describe anything as "local".
`AUTH_MODE=local` is a name for a deployment mode, not something a person
signing in has any use for, and on a hosted instance it suggests the data lives
on their own machine.

Settings lays its cards out in columns rather than rows, so a short panel no
longer leaves a stretch of nothing beneath it to line up with the tall one
beside it.

## 0.1.1 - 2026-08-03

Two things a first deployment ran into. No schema change, no data migration:
pull the new image and restart.

### Fixed

Reaching a database on another host over TLS. The deployment guide said to
append `?sslmode=require`, which in libpq means "encrypt and do not check the
certificate" but in node-postgres does check it. A self-hosted PostgreSQL almost
always presents a certificate it signed itself, so the setting the guide
recommended was the one that could not work, and it failed with
`DEPTH_ZERO_SELF_SIGNED_CERT` while Node advised installing a root CA that does
not exist. Use `?sslmode=no-verify` for a self-signed server: the connection is
still encrypted, it just stops checking who signed the certificate. The guide
now sets out all three modes and what each does, and the startup failure names
the one to use instead of leaving an operator with a certificate error and no
way forward.

The first-run setup code is no longer printed where it cannot be used. The code
is read only after `ALLOWED_EMAILS` has turned an address away, so a rule
admitting everyone makes it unreachable, and printing one sent operators looking
for a code the sign-up form does not ask for. Where it is still live, the log
now says which it is: the only way in when the rule admits nobody, or the way to
claim the instance with an address the rule would turn away.

## 0.1.0 - 2026-08-02

The first release. Everything below is new, so this reads as a description of
what Simple Balance does rather than a list of differences.

### The ledger

The books are double-entry. Every transaction settles to zero in each currency
it touches, checked before anything is written, with server-owned income,
expense, exchange, and equity accounts doing the balancing. Opening balances
post against equity, so the ledger sums to zero from the first account onward.
None of those counter-accounts appear in a picker, and no transaction can name
one as a side.

Archiving an account posts its remaining balance out to equity, so it closes at
zero and the totals that leave it out stay right. Restoring puts the balance
back. The dashboard stops at today, so an entry dated next month is not counted
as money you have, and its balance, cash flow, and spending all describe the
same set of accounts.

Postings are append-only and carry their own date. Correcting an entry appends
only the difference, so changing an amount costs one adjusting row per side and
an edit that touches only labels writes nothing at all. Deleting posts the
reversal instead of setting a flag, which is why no balance or report has to
remember to exclude deleted rows. A balance as of a date reads an index rather
than scanning the ledger.

Balances, cash flow, and spending by category all come from the postings.

### Accounts and transactions

Accounts for assets and liabilities, each fixed to one currency once it is in
use. Crypto wallets track native quantities and quote no prices. Deposits,
withdrawals, and transfers, including cross-currency conversions that keep the
sent and received amounts separate.

Editing uses optimistic concurrency and creating uses idempotency keys, so a
retry cannot duplicate work and a stale edit fails rather than overwriting
someone else's.

Mass edit and mass delete cover up to 10,000 rows in one atomic request from any
transaction view. Explicit selections carry row versions; all-matching
selections carry a server-issued count and fingerprint, so a concurrent change
makes the request stale rather than silently changing its scope.

### Getting data in and out

Bank CSV import detects the format, maps columns, parses localized dates and
numbers, matches or creates categories and payees, and lands everything in a
review queue. Committing a batch validates every row first and runs as one
transaction. Simple Balance's own export reads back in without loss.

Categories and payees match case-insensitively, surface their own near
duplicates, and merge by rewriting every reference at once. Typing a category on
a transaction is enough: an existing one is matched whatever its capitalization,
and a new one is created on save, so a ledger does not end up with three
spellings of the same thing.

### Using it

Every list sorts by any column it displays, in either direction, and pages by
number. Amounts show at their currency's own precision, with crypto keeping the
digits it needs. Date ranges live in the URL, so a view can be linked to.
Destructive actions ask first, in the app's own dialogs, and say what will
happen and how to undo it.

### Agents

An MCP server over OAuth with separate read, stage, and write scopes, calling
the same ledger code the browser does. Tools outside a token's scope are not
even discoverable. Schema fields carry descriptions, so an agent does not have
to infer that money is a string or that a credit card opens negative. Access
tokens are audience-bound RS256 JWTs backed by revocable records.

Settings lists every agent you have approved and what it may do, and revoking
one deletes its tokens rather than waiting for them to lapse, so it loses access
on its next call. An agent can do the same: listing what is connected needs only
read, and revoking needs write, so a read-only token cannot lock your other
agents out.

### Accounts and who may have one

One deployment holds as many people as you let it. Each has their own accounts,
transactions, categories, payees, totals, and audit history, and none of them
can see or name another's. `ALLOWED_EMAILS` decides who may register: exact
addresses, whole domains such as `example.com`, or `*` for anybody. Leave it
unset and nobody can, which keeps a personal deployment personal.

It governs registration and nothing else, so an address removed from the list
keeps the account it already has rather than losing access to its own books.

Sign in with a password, with Google, or with both on one account. Google
sign-ups must carry a verified address, so a domain entry means what it says.

Give the deployment a mail server, with `SMTP_HOST` and `MAIL_FROM`, and two
things follow: a forgotten password can be reset from the sign-in screen, and a
new account has to open a link sent to its address before it works. That is what
makes a domain entry mean something in password mode too. Leave them unset and
neither happens, which is the right answer for a deployment of one. Accounts
made before a mail server was added keep working after it arrives.

### Running it

One non-root image that never writes to its own filesystem, with PostgreSQL as
the only thing it stores anything in. Migrations run at startup under an
advisory lock, and readiness stays closed until they finish. Local sign-in works
with no configuration at all; Google is optional.

Tagged multi-architecture images publish to GHCR on release.
