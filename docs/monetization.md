# Monetization

Nothing here is on unless an operator turns it on. A deployment that sets none
of these variables sells nothing, limits nobody, shows no advertising, and opens
no connection to Stripe or to Google — which is what every installation upgrading
from an earlier release keeps doing without being asked anything.

Two things can be switched on independently: **billing**, which sells a plan and
holds a free account to three financial accounts, and **ads**, which shows
AdSense inventory to accounts that are not paying.

## What is on, and when

| `SB_BILLING_ENABLED` | Stripe settings | AdSense settings | Stripe reachable | Plan sold, limit enforced | Ads shown |
| -------------------- | --------------- | ---------------- | ---------------- | ------------------------- | --------- |
| unset or `false`     | unset           | unset            | no               | no                        | no        |
| unset or `false`     | set             | unset            | **yes**          | no                        | no        |
| `true`               | set             | unset            | **yes**          | **yes**                   | no        |
| unset or `false`     | unset           | set              | no               | no                        | no        |
| unset or `false`     | set             | set              | **yes**          | no                        | no        |
| `true`               | set             | set              | **yes**          | **yes**                   | **yes**   |
| `true`               | unset           | —                | refuses to start |                           |           |
| —                    | half set        | —                | refuses to start |                           |           |
| —                    | —               | half set         | refuses to start |                           |           |

`tests/config.test.ts` holds the first four columns. The last is about a person
rather than a deployment, so it is held by
`tests/integration/ad-placement.integration.test.ts` and its wound-down sibling,
which call `getAdPlacement` itself against a real database — the earlier
`tests/ad-placement.test.ts` pins only the _shape_ of the rule, and a gate
inverted in the real function passed it.

**The last column is about a person, not a deployment**, which is why two rows
that configure AdSense still show nothing. An ad is shown only where a _limited_
plan is in force — a free account on a deployment that is selling one. Where
nothing is for sale, nobody is on a limited plan: not on a deployment that never
sold anything, and not on one that has stopped while its subscribers go on being
charged at Stripe. Configuring AdSense on a deployment that sells no plan
therefore shows no ads to anyone, which is worth knowing before setting it.

The fifth row is the one to read twice, because it is the state an operator
reaches by winding a deployment down: Stripe still configured, subscriptions
still being charged, nothing new for sale. Nobody is held to a limit there, and
**nobody is shown an ad there either** — a subscriber who is still paying and an
account that never paid produce the same entitlement while the flag is off, so
the only safe reading is to treat that state as "not a free plan". Ads are shown
where a _limited_ plan is in force, never as the inverse of "is this person on
Premium".

## Why billing takes two settings rather than one

The five Stripe settings answer one question: can this deployment reach Stripe?
`SB_BILLING_ENABLED` answers a different one: is anything for sale?

They are separate because winding a deployment down is not one event. An
operator who stops selling still has subscriptions people are paying for, and
those go on emitting webhooks for months. A single switch would force a choice
between continuing to take new subscribers and going deaf to the existing ones —
and going deaf means this ledger's idea of who has paid quietly drifts away from
Stripe's, which is the state in which somebody is charged for a plan the app no
longer believes they have.

So: leave `SB_BILLING_ENABLED` unset and keep the Stripe settings, and the
deployment honors and reconciles what exists while offering nothing new.

## What the two plans are

**Free** keeps three financial accounts *usable* and sees ads where a
deployment serves them. **Premium** is unlimited and never sees an ad. (`plus`
is the wire value in `plans`, on the session and in `whoami`; `Premium` is the
word a person reads. Renaming the wire value would break every client that has
seen it, and renaming the label would not.) Everything else — every report,
every import, the whole CSV round trip and the entire MCP surface — is the same
on both. There are no transaction quotas.

Counter-accounts the ledger owns do not count against the three, and neither do
archived accounts: the three are the accounts somebody is using. The refusal
names both numbers — the limit and what was counted — and the moves that work,
which are archiving one, deleting one, or upgrading.

**Somebody who already has more than three keeps all of them, and chooses three
to keep using.** The rest are *frozen*: every balance, every entry and every
report still counts them and still shows them, and nothing about them may
change — no new entry, no edit, no delete, not even a rename.

**The choice is made once, and after that the only move is filling a place that
has opened up.** An account somebody is using stays that way until they archive
or delete it; nothing lets them park one to make room for another, because
having them in turn is having them all and the limit would mean nothing.
Choosing is one operation over the whole set (`PUT /api/v1/accounts/active`, or
`set_active_accounts` for an agent), and `activeAccountChange` in
`src/shared/domain.ts` is the rule the server enforces. The page mirrors it
through `activeChoicePending` and each account's `frozen`.

**There is no choice at all while nothing is frozen** — on a plan with no limit,
and while the live accounts fit within the one there is — so the call is refused
then with a `409` saying so. A list naming exactly the accounts already active
is the one exception: it changes nothing, and a retry of a call accepted a
moment ago must not come back as a refusal. Accepting a set in those states
would be a capability only an agent had, since the Accounts page shows no
chooser there, and a choice written on the paid plan would bind silently at the
next downgrade, in place of the free first choice that downgrade is owed.

Because the choice is made once, `set_active_accounts` is annotated
destructive, so a client may ask the person before it runs: while the choice is
open it decides which accounts they keep, the set cannot be traded for another
afterward, and the tool's description tells an agent to confirm it with them
first. It is not annotated unrecoverable, because archiving or deleting an
account still opens a place.

Coming back out of the archive needs a free place, and takes it: a restored
account arrives in use. While no place is free the Accounts page disables
Restore with the refusal's own sentence (`restoreAllowance`). Every path that
changes which accounts are live — creating, archiving, restoring, deleting and
choosing — holds the same lock over the person's accounts, so two requests
cannot both take the last place.

`activeChoicePending` says when the question is still open: more live accounts
marked active than the plan keeps. A downgrade leaves exactly that behind, the
column defaulting to true and nothing writing it on the way down — so that call
may name any three and every call after it may only add.

**The column has one other writer, and it is what keeps it true.** Whenever the
live accounts number no more than the free plan's three, every one of them is in
use, so every one is marked active: after an archive, after a delete, and before
a create or a restore, on whatever plan is in force, with an `activate` audit
event for each account it changes and no bump to its version
(`accountsToMarkActive`). Without it a column left saying false would go stale.
Somebody who chose three of five and then archived two of the three would have
the other two back in use while the column said they were not; a paid spell that
opened one more would then lapse with two marked active against a limit of
three, so the choice would stay closed and the two accounts they had been using
for months would be the ones frozen. Nothing is rewritten while more than three
are live, because a spell on the paid plan that opened nothing must leave the
earlier choice standing.

**A spell on the paid plan reopens it, and it has to.** An account opened while
the limit was lifted is marked active beside a choice made about a ledger that
did not contain it, so reading the column as settled would freeze an account
nobody was ever asked about, with no way back but archiving one of the three.
Four marked active against a limit of three is the signal, and it is the same
one: the column cannot be an answer to the question being asked now. Archiving
one of the three puts the count *below* the limit instead, which is a place
opening up and not a new question.

**The limit counts the accounts in use, not every account ever opened.**
Counting archived accounts too is the obvious way to keep a quota from being
cycled by archiving and restoring, and it is not the one used. The cycle is
closed at the other end instead: archiving frees the place it held, and coming
back out of the archive needs a free place of its own. Somebody can accumulate
closed accounts they are not using; nobody can ever use more than three.

**Frozen is worked out, never stored.** `ledger_account.active` is the choice;
`frozenAccountIds` in `src/shared/domain.ts` combines it with the entitlement,
and it has to be that way around because entitlements change with nobody
present. An operator override expires at a moment no code observes, a
`past_due` grace runs out mid-request, and a deployment that stops selling
answers `{billing: false}` while Stripe goes on charging its subscribers — a
column written on the way down would go on saying what it said then, and that
last case would lock paying customers out of their own books.

Until somebody chooses, the oldest of the accounts marked in use stay usable and
the rest are frozen. The first time a plan limits somebody, every account is
marked in use, so those are the oldest of them all; after a spell on Premium
that opened or restored accounts, they are the oldest of the earlier choice and
those accounts. That costs no write at all, which is what makes a subscription
lapsing at three in the morning correct rather than merely handled.

Archiving is a different thing and stays one: an archived account already
refuses every write, so it is never frozen and uses up none of the three.

## The prices, and what they actually net

$30 a year or $3 a month, in USD, both on one Stripe product. The annual plan is
the default offer, and what offering it costs is worth stating rather than
assuming. Calculated at Stripe's published US rates — 2.9% and a flat $0.30 on
the card and 0.7% for Billing, so 3.6% and $0.30 on a subscription charge — a
$3.00 charge loses about 14% to fees and $30.00 once a year loses about 4.6%.
Twelve monthly charges net $31.10 against one annual charge's $28.62, so the
year is not free to offer: it costs about $2.48 a subscriber, in exchange for
removing eleven opportunities a year for a card to decline.

The flat $0.30 is what decides that, and it does not move with the price. Giving
away two months costs twice the monthly price whatever that price is, while the
fee saved by charging once instead of twelve times is eleven times $0.30 plus
3.6% of the discount. At $2 a month the fee saved covered 86% of what the year
gave away and the annual plan was very nearly free to offer; at $3 it covers
59%. Raising the monthly price makes the year cost more to offer, not less.

**No tax is in those figures, because this release collects none.** No
subscription is created with automatic tax and no customer address is asked for,
so turning Stripe Tax on in the dashboard collects nothing. Collecting it is
code rather than configuration: `automatic_tax` on the subscription, carried
through the schedule phases in `src/server/stripe.ts`, and an address to
calculate it from. Whether a deployment has to is its operator's decision, and
it has not been made here.

## What turning ads on costs

AdSense publishes no list of the hosts it loads from, as a matter of policy, so
there is no allowlist to write. Serving it means widening this app's content
security policy on every page that renders your balances — including allowing
scripts to be evaluated at runtime, and allowing frames and network requests to
any HTTPS origin. A deployment that sets none of the AdSense variables keeps the
`default-src 'self'` policy the container ships with.

Ads are never shown to a paying account, never on the plan and billing tab,
never on sign-in, and never on paper — each of those is enforced in code rather
than promised, and `tests/integration/ad-placement.integration.test.ts`,
`tests/ad-slot-ui.test.tsx` and the print rule in `styles.css` hold them. A CSV
export is a file this server writes and carries no markup at all, so there is
nothing to put an ad in.

**What does reach Google.** The publisher id, and the address of the page the ad
is on. That address is not nothing: this app's paths carry record ids —
`/accounts/<uuid>`, `/categories/<uuid>` — so a page's URL identifies a row,
though not a person, a name or an amount. The one address that would carry
text from the ledger is the payee view, `/payees/transactions?name=…`, and it
never carries an ad: no slot mounts while the page's address, or the one it
was opened from, holds a payee name, and no link leaving that view forwards the
name (`addressCarriesLedgerText` and `withoutLedgerText` in
`src/client/router.tsx`, held by `tests/ledger-text-in-urls.test.ts`). A payee is
a person's name and who they pay, and handing that to an advertiser would be a
leak and a breach of the program's policy at once. No account name, no
balance, no figure, no email address and no identifier of yours is sent as a
targeting parameter. The browser's `Referer` tells another origin this site's address and
never a page's path: the pages that can carry an ad send
`strict-origin-when-cross-origin` rather than the `same-origin` every other page
keeps, because Google's consent message does not serve under `same-origin` —
its own troubleshooting says so — and that policy still keeps the record ids in
a URL off every request to another origin. If a URL naming a record is more than
you want to send a third party, the answer is not to serve ads on this
deployment.

Each operator supplies their own publisher id and verifies their own domain with
Google. There is no shared publisher id and none ships with this software: the
id travels from your environment to the browser on the session response, the
same way the Stripe publishable key does, so one published image serves every
operator with their own account. Nothing is compiled in.

## What you have to do at Google, and what this does for you

**Done for you, with one thing you must add.** `/ads.txt` is served
automatically at this deployment's own root, derived from `ADSENSE_CLIENT_ID`: `google.com, pub-…, DIRECT, f08c47fec0942fa0`. Without that
file AdSense treats your inventory as unauthorized and pays nothing for it,
which is a silent failure — the ads render, the impressions happen, the revenue
is zero. If you sell through other partners as well you need more lines than
this one, and the way to do that is to serve your own `/ads.txt` from whatever
terminates TLS in front of this deployment; it will take precedence.

**If this deployment is on a subdomain** — `balance.example.com` rather than
`example.com` — crawlers read the **root** domain's `/ads.txt`, not this one.
What that means depends on whether the publisher id is the same in both places:

- **Same publisher id, which is the ordinary case** — the root file's own
  `DIRECT` record already authorizes this subdomain and there is nothing more
  to do. Google is explicit: *"You only need to do this if the authorized
  seller or your publisher ID are different for the subdomain when compared to
  the root domain."*
- **A different id or a different seller on the subdomain** — and only then —
  the root file needs a referral line:

  ```
  subdomain=balance.example.com
  ```

An earlier version of this page stated the referral as mandatory. It is not,
and adding one where it is not needed is actively worse: a referral makes
crawlers consume the subdomain's file *instead of* the root's, and this
application only registers the `/ads.txt` route while ads are configured — so
the referral hands the whole authorization chain to a file that disappears the
moment `ADSENSE_CLIENT_ID` is unset or this deployment is down.

Either way the root file must carry a `DIRECT` record naming the publisher id.
A root `ads.txt` that exists and does **not** name it is the documented state
that keeps the domain from being monetized at all.

**Yours to do, in this order.** This is the one list; anything else that
describes turning ads on points here rather than keeping a copy.

1. **Create the AdSense account.** Its publisher id — `pub-` and sixteen digits,
   which this application takes as `ca-pub-…` — exists as soon as the account
   does, before any review.
2. **Add the site under Sites, and prove you own it before requesting review.**
   AdSense offers its code snippet, an `ads.txt` snippet or a meta tag, and this
   deployment can carry none of them yet: its own `/ads.txt` exists only once
   the ad settings are set, and those include slot ids that do not exist until
   after approval. So serve the `ads.txt` line —
   `google.com, pub-…, DIRECT, f08c47fec0942fa0` — at the root of the domain
   from whatever answers there, a site of its own or the proxy in front of this
   deployment, or put `<meta name="google-adsense-account" content="ca-pub-…">`
   in the `<head>` of the site at the root.
3. **Request review, and wait.** Ads do not serve before approval, and nothing
   here can tell you whether it has happened.
4. **Create the display ad units** — one for the banner in the application
   shell, and a second for the bottom of the page if you want one — and note
   their ten-digit slot ids.
5. **Turn Auto ads off.** They are an account setting, not a property of the tag
   this app writes, and they inject formats this code never asks for — including
   the interstitials and vignettes this product promises not to show. There is
   no page-level code that disables them, so leaving them on overrides that
   promise from outside the software.

   What _is_ enforced here is where the script loads at all. It is fetched by the
   first ad slot that mounts, and no slot mounts on the plan and billing tab, on
   sign-in, or for anybody on a paid plan — so Auto ads cannot reach those pages
   whatever the account says, because the script is not on them. The setting
   governs the format on pages that do carry ads.

6. **If you serve the EEA, the UK or Switzerland, publish a European
   regulations message.** Those regions need a consent notice whatever this
   deployment's settings say, and Google's own platform is the free, certified
   way to give one; the consent section below says why no other vendor is
   needed. In AdSense, open **Privacy and messaging**, create a **European
   regulations** message, choose the sites it applies to and its wording, and
   publish it. Leave `ADSENSE_CONSENT_MANAGED` unset unless you want
   personalized ads.
7. **Publish a privacy policy that says what AdSense does.** Google's terms
   require one, naming third-party cookies and the vendors that set them, with a
   way for a person to opt out. This software ships no privacy policy and cannot
   write yours: what it does is one input to it, and the rest is who you are and
   what else you run.
8. **Set this deployment's settings, together, and restart.**

   - `ADSENSE_CLIENT_ID=ca-pub-…` and `ADSENSE_BANNER_SLOT_ID`, and
     `ADSENSE_FOOTER_SLOT_ID` if you made the second unit.
   - `PRIVACY_POLICY_URL`, the absolute `https://` address of that policy. The
     server refuses to start with AdSense configured and no policy, because an
     operator who serves ads without one is in breach of Google's terms from the
     first impression.
   - `SB_BILLING_ENABLED=true` with the five `STRIPE_*` settings, because an ad
     is shown only where a limited plan is in force. Without them the ids widen
     the policy and serve `/ads.txt`, and nobody is shown an ad; the process
     says so at every start. That also puts the plan on sale, which freezes
     every account past three for anybody without a subscription or an
     override the moment the process starts — your own ledger included. Read
     `docs/billing-operations.md` §Turning selling on, and grant the overrides
     it describes, before you set it.
   - In the split deployment, `SB_ADS_CONFIGURED=true` on the frontend as well.
     The compose recipe derives it from `ADSENSE_CLIENT_ID`, and so does the
     Helm chart from an `ADSENSE_CLIENT_ID` in `config.extraEnv`; set
     `frontend.adsConfigured` only if the id is kept in an `existingSecret`.

   On the single machines the Pulumi programs build, that is: edit
   `/var/lib/simple-balance/env.local`, then
   `sudo systemctl restart simple-balance`. A `single` profile installed by hand
   keeps its settings in `/opt/simple-balance/.env` instead.

9. **Check that both `ads.txt` files name you.** `curl` this deployment's
   `/ads.txt` and, where it is on a subdomain, the root domain's too: each has
   to carry the `DIRECT` line for your publisher id, as the subdomain case above
   describes.
10. **Decide what you are telling people.** This deployment holds somebody's
    finances. Turning on advertising means a third party's script runs on pages
    showing their balances, and the honest thing is to say so where they will
    see it before it starts.

## Where the plan is managed

`/settings/plan`, the **Plan and billing** tab in the strip across the top of
Settings, which appears only on a deployment where Stripe is configured. It
shows the plan, how much of the account limit is used, the price read from
Stripe, and the controls to change or cancel. Stripe's script loads there and
nowhere else, and only once there is something to confirm — a payment or a
card — so no other page fetches it, sign-in included.

Settings and the plan tab are two documents with a tab strip across them rather
than two panels on one page, and the strip navigates with plain anchors.
Stripe's payment form loads a script and an iframe from Stripe, so that one page
is served under a wider content security policy than the rest of the app — and
a policy belongs to the document it arrived with.
Navigating there without a reload would keep the strict policy and the payment
form would silently fail to appear. The cost is a full page load on a page most
people open twice.

Every other page keeps `default-src 'self'` exactly as before. Turning billing on
does not weaken the policy anywhere a balance is rendered, and leaving the plan
tab is a document load for the same reason arriving is — otherwise its policy
would follow you onto the pages that do render balances.

## Rehearsing the policy before it bites

The plan tab's policy is Stripe's published set for Stripe.js and its set for
Link, plus four hosts this project added — `*.hcaptcha.com`, `m.stripe.com`,
`q.stripe.com` and `errors.stripe.com` — each with its reason in
`src/server/http-security.ts`. Which of the four a live account actually
contacts, and whether a Link sign-in needs anything beyond Link's own two hosts,
has not been observed by anybody: no live Stripe account has run this form, and
`docs/acceptance.md` carries it as outstanding. `SB_CSP_REPORT_ONLY=true` is how
to find out without enforcing anything. It makes the plan tab report what its
policy _would_ have blocked and block nothing, and registers
`POST /api/csp-report` for the reports to arrive at. Open the page, sign in,
start an upgrade, and read the log.

It reaches that one page. Every other page goes on enforcing, because finding
out about a page that renders no balances is not worth taking the defense off
every page that does. That includes every page that can carry an ad, so the
switch tells you nothing about AdSense; the next section says where to look
instead.

In the split deployment set it on the frontend container as well as the server:
nginx serves the plan tab's document, so it is nginx that decides which of the
two headers the page arrives with.

Turn it off afterward. The process says so at startup, every time, while it is
on.

The plan tab also sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`
rather than the `same-origin` every other page keeps, so that Google Pay, where
it completes in a popup, can hand the payment back to the page that opened it.
An opener policy is not part of the content policy, so the rehearsal cannot show
it either way, and it has not been watched against a live account either.

## What the ads policy allows, and how much of it is known

The widened policy is broad because it has to be: Google publishes no list of
the hosts AdSense loads from, so there is nothing to narrow it to. Scripts,
frames, styles, fonts and connections to any HTTPS origin, plus `unsafe-eval`.

It is also the one content security policy in this product that was not derived
from a list a vendor publishes, because no such list exists. It is derived from
how Google documents its tag and its consent message behaving, and it has not
yet been seen serving either: no AdSense unit has ever rendered on this
product, and `docs/acceptance.md` carries that as outstanding. The first
operator to serve an ad is the first to see the policy hold.

**`SB_CSP_REPORT_ONLY` does not reach it, and nothing rehearses it.** That switch
covers the plan tab, where no ad renders. What the ads policy refuses is read in
the browser instead: sign in as a free account on a deployment that is selling a
plan, open any page with an ad slot, and read the developer console. A refused
ad or consent-message fetch shows up there, and in the Issues panel, as a
Content-Security-Policy violation naming the directive and the address it
blocked, while the page goes on enforcing. A refusal nobody reads there looks
exactly like having no inventory.

## Consent, and why the default needs no extra vendor

Two different rules, and conflating them is the mistake to avoid.

**Google's rule** is that a _certified_ consent platform is required to serve
_personalized_ ads in the EEA, the UK and Switzerland. Non-personalized and
limited ads are not gated on it. So on the defaults here —
`ADSENSE_CONSENT_MANAGED` unset — every ad request carries
`requestNonPersonalizedAds`, and Google asks for no certified platform.

**The ePrivacy rule is separate and still applies.** Consent is required for
storing anything non-essential on somebody's device, and a non-personalized ad
still sets cookies for frequency capping and fraud prevention. Google's own
guidance says so. So a deployment serving ads to people in the EEA, the UK or
Switzerland needs a consent notice whatever this setting says — the default
avoids Google's *certification* requirement, not the *consent* requirement.

The practical answer to both is the same and is below: Google's own platform is
free, certified, and part of the AdSense account, so it satisfies the strict
rule and the loose one at once. The only configuration that needs no consent
notice at all is one that serves no ads to those regions.

That is also the right default for this product on its own merits: the page
beside the ad is showing somebody their own balances, and profiling the person
reading it is not something to switch on by accident.

### The consent notice, and personalized ads

Use **Google's own platform**, which is free and part of the AdSense account
you already have. It is a certified platform — it appears on Google's list as
"Google LLC CMP" — so this is not a second vendor, a second contract or a second
script. Publishing its European regulations message is step 6 of the list above,
and it is the whole of the consent notice, whether or not you want personalized
ads.

Setting `ADSENSE_CONSENT_MANAGED=true` on this deployment, and restarting, is a
separate decision and only for personalized ads: make it once that message is
published, and not otherwise.

**Nothing is added to this application.** Google's documentation is explicit
that the existing ad tag delivers the message — "you don't need to re-tag at
all" — and that tag is already loaded by the first ad slot that renders. The
content security policy ads require is wide enough to carry the message, so
there is nothing to widen either.

What the setting changes is one line: with it on, the ad request stops forcing
`requestNonPersonalizedAds` and lets the platform's answer decide. That is the
point rather than an omission — forcing it on top of a platform would override
somebody who consented as surely as it protects somebody who did not, which
would leave the platform ornamental. Nothing here can check the platform exists,
so leaving the setting off is always the safe answer.

Two things this does not do. It is not legal advice. And a hand-built banner is
not an alternative for personalized ads: that requirement is for a _certified_
platform, and certification is a process with Google and the IAB rather than a
property of the code. A hand-built banner could satisfy the ePrivacy consent
requirement for non-personalized ads on its own, but there is little reason to
build one when the certified platform is free and already in the account.

## Turning it off

Removing `SB_BILLING_ENABLED` keeps the plan from being sold and the limit from
binding, and since an ad is shown only where a plan is for sale, it stops the
ads too. **It does not cancel anything at Stripe.** Subscriptions go on renewing
and cards go on being charged until somebody cancels them, which is a decision
this software will not make on an operator's behalf.

Removing the AdSense variables stops the ads and restores the original content
security policy at the next restart.

On the single machines the Pulumi programs build, either change is an edit to
`/var/lib/simple-balance/env.local` followed by
`sudo systemctl restart simple-balance`; a `single` profile installed by hand
keeps its settings in `/opt/simple-balance/.env`.

`docs/billing-operations.md` has the order to do it in when there are live
subscriptions, and the step that charges somebody for nothing if it is taken
early.

See `docs/deployment.md` for every variable, its default and what happens when it
is set wrong.
