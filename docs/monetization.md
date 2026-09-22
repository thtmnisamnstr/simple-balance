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
Plus".

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

Counter-accounts the ledger owns do not count against the three. Archived
accounts do, because the alternative is a quota that resets by archiving and
restoring. The refusal names both numbers — the limit and what was counted — so
somebody who archived an account and expected a free slot can see why they do
not have one.

**Somebody who already has more than three keeps all of them, and chooses three
to keep using.** The rest are *frozen*: every balance, every entry and every
report still counts them and still shows them, and nothing about them may
change — no new entry, no edit, no delete, not even a rename. Choosing is one
operation over the whole set (`PUT /api/v1/accounts/active`, or
`set_active_accounts` for an agent), because swapping which three are live is
one decision and a switch per account would make somebody pass through a state
their plan forbids.

**Frozen is worked out, never stored.** `ledger_account.active` is the choice;
`frozenAccountIds` in `src/shared/domain.ts` combines it with the entitlement,
and it has to be that way round because entitlements change with nobody
present. An operator override expires at a moment no code observes, a
`past_due` grace runs out mid-request, and a deployment that stops selling
answers `{billing: false}` while Stripe goes on charging its subscribers — a
column written on the way down would go on saying what it said then, and that
last case would lock paying customers out of their own books.

Until somebody chooses, the oldest accounts stay usable and the rest go quiet.
That costs no write at all, which is what makes a subscription lapsing at three
in the morning correct rather than merely handled.

Archiving is a different thing and stays one: an archived account already
refuses every write, so it is never frozen and uses up none of the three.

## The prices, and what they actually net

$30 a year or $3 a month, in USD, both on one Stripe product. The annual plan is
the default offer, and what offering it costs is worth stating rather than
assuming. Reckoned at Stripe's published US rates — 2.9% and a flat $0.30 on the
card, 0.7% for Billing and 0.5% for Tax where it applies, so 4.1% and $0.30 on
a subscription charge — a $3.00 charge loses about 14% to fees and $30.00 once
a year loses about 5.1%. Twelve monthly charges net $30.92 against one annual
charge's $28.47, so the year is not free to offer: it costs about $2.45 a
subscriber, in exchange for removing eleven opportunities a year for a card to
decline.

The flat $0.30 is what decides that, and it does not move with the price. Giving
away two months costs twice the monthly price whatever that price is, while the
fee saved by charging once instead of twelve times is eleven times $0.30 plus
4.1% of the discount. At $2 a month that saving covered 86% of what the year
gave away and the annual plan was very nearly free to offer; at $3 it covers
59%. Raising the monthly price makes the year cost more to offer, not less.

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
though not a person, a name or an amount. No account name, no balance, no
figure, no email address and no identifier of yours is sent as a targeting
parameter, and the browser's `Referer` is held to `same-origin` so it does not
travel either. If a URL naming a record is more than you want to send a third
party, the answer is not to serve ads on this deployment.

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
that stops the domain being monetized at all.

**Yours to do.**

- **Get the account approved and verify the domain.** Ads do not serve before
  that, and nothing here can tell you whether it has happened.
- **Publish a privacy policy and point `PRIVACY_POLICY_URL` at it.** This is
  now enforced: the server refuses to start with AdSense configured and no
  policy, because an operator who serves ads without one is in breach of
  Google's terms from the first impression.
- **Turn Auto ads off.** They are an account setting, not a property of the tag
  this app writes, and they inject formats this code never asks for — including
  the interstitials and vignettes this product promises not to show. There is no
  page-level code that disables them, so leaving them on overrides that promise
  from outside the software.

  What _is_ enforced here is where the script loads at all. It is fetched by the
  first ad slot that mounts, and no slot mounts on the plan and billing tab, on
  sign-in, or for anybody on a paid plan — so Auto ads cannot reach those pages
  whatever the account says, because the script is not on them. The setting
  governs the format on pages that do carry ads.

- **Decide whether you need a consent platform at all**, and see below. On the
  default settings you do not.

- **Publish a privacy policy that says what AdSense does.** Google's terms
  require one, naming third-party cookies and the vendors that set them, with a
  way for a person to opt out. This software ships no privacy policy and cannot
  write yours: what it does is one input to it, and the rest is who you are and
  what else you run.

- **Decide what you are telling people.** This deployment holds somebody's
  finances. Turning on advertising means a third party's script runs on pages
  showing their balances, and the honest thing is to say so where they will see
  it before it starts.

## Where the plan is managed

`/settings/plan`, reached from a card at the top of Settings, and only on a
deployment where Stripe is configured. It shows the plan, how much of the
account limit is used, the price read from Stripe, and the controls to change or
cancel.

Settings and the plan tab are two documents with a tab strip across them rather
than two panels on one page, and the strip navigates with plain anchors. Stripe's payment form loads a script and an iframe
from Stripe, so that one page is served under a wider content security policy
than the rest of the app — and a policy belongs to the document it arrived with.
Navigating there without a reload would keep the strict policy and the payment
form would silently fail to appear. The cost is a full page load on a page most
people open twice.

Every other page keeps `default-src 'self'` exactly as before. Turning billing on
does not weaken the policy anywhere a balance is rendered, and leaving the plan
tab is a document load for the same reason arriving is — otherwise its policy
would follow you onto the pages that do render balances.

## Rehearsing the policy before it bites

Stripe publishes only part of the host list Elements actually reaches, so the
policy above carries hosts that were established by watching a working payment
form rather than by reading a document. `SB_CSP_REPORT_ONLY=true` makes the plan
tab report what its policy _would_ have blocked and block nothing, and registers
`POST /api/csp-report` for the reports to arrive at. Open the page, sign in,
start an upgrade, and read the log.

It reaches that one page. Every other page goes on enforcing, because finding
out about a page that renders no balances is not worth taking the defense off
every page that does.

In the split deployment set it on the frontend container as well as the server:
nginx serves the plan tab's document, so it is nginx that decides which of the
two headers the page arrives with.

Turn it off afterwards. The process says so at startup, every time, while it is
on.

## What the ads policy allows, and how much of it is known

The widened policy is broad because it has to be: Google publishes no list of
the hosts AdSense loads from, so there is nothing to narrow it to. Scripts,
frames, styles, fonts and connections to any HTTPS origin, plus `unsafe-eval`.

It is also the one content security policy in this product that was not derived
from a vendor's documentation, because no such document exists. It was assembled
from what a working ad and a working consent message are observed to fetch. If
something you serve is refused, `SB_CSP_REPORT_ONLY=true` will tell you what —
that switch exists for exactly this.

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
you already have. Turn it on for the consent notice whether or not you want
personalized ads; set `ADSENSE_CONSENT_MANAGED=true` only when you do. It is a certified platform — it appears on Google's list as "Google LLC
CMP" — so this is not a second vendor, a second contract or a second script.

1. In AdSense, open **Privacy and messaging** and create a **European
   regulations** message.
2. Choose the sites it applies to and the wording, and publish it.
3. Set `ADSENSE_CONSENT_MANAGED=true` on this deployment and restart.

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

Removing `SB_BILLING_ENABLED` stops the plan being sold and stops the limit
binding. **It does not cancel anything at Stripe.** Subscriptions go on renewing
and cards go on being charged until somebody cancels them, which is a decision
this software will not make on an operator's behalf.

Removing the AdSense variables stops the ads and restores the original content
security policy at the next restart.

`docs/billing-operations.md` has the order to do it in when there are live
subscriptions, and the step that charges somebody for nothing if it is taken
early.

See `docs/deployment.md` for every variable, its default and what happens when it
is set wrong.
