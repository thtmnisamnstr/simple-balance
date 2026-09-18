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
deployment honours and reconciles what exists while offering nothing new.

## What the two plans are

**Free** keeps three financial accounts and sees ads where a deployment serves
them. **Premium** is unlimited and never sees an ad. (`plus` is the wire value
in `plans`, on the session and in `whoami`; `Premium` is the word a person
reads. Renaming the wire value would break every client that has seen it, and
renaming the label would not.) Everything else — every report,
every import, the whole CSV round trip and the entire MCP surface — is the same
on both. There are no transaction quotas.

Counter-accounts the ledger owns do not count against the three. Archived
accounts do, because the alternative is a quota that resets by archiving and
restoring. The refusal names both numbers — the limit and what was counted — so
somebody who archived an account and expected a free slot can see why they do
not have one.

**An account that already holds more than three keeps all of them.** Turning
billing on does not take anybody's data away, hide an account, or stop an import;
it refuses to create a fourth until the count is back under the limit or the
plan is upgraded.

## The prices, and what they actually net

$20 a year or $2 a month, in USD, both on one Stripe product. The annual plan is
the default offer, and that is an economic decision rather than a presentational
one: at Stripe's standard rate a $2.00 charge loses about 19% to fees, of which
$0.30 is flat and does not care what you charge, while $20.00 once a year loses
about 5.6%. Twelve monthly charges net slightly *more* than one annual charge —
$19.42 against $18.88 — so the annual plan is very nearly free to offer and
removes eleven opportunities a year for a card to decline.

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
file AdSense treats your inventory as unauthorised and pays nothing for it,
which is a silent failure — the ads render, the impressions happen, the revenue
is zero. If you sell through other partners as well you need more lines than
this one, and the way to do that is to serve your own `/ads.txt` from whatever
terminates TLS in front of this deployment; it will take precedence.

**If this deployment is on a subdomain** — `balance.example.com` rather than
`example.com` — crawlers read the **root** domain's `/ads.txt`, not this one.
What that means depends on whether the publisher id is the same in both places:

- **Same publisher id, which is the ordinary case** — the root file's own
  `DIRECT` record already authorises this subdomain and there is nothing more
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
the referral hands the whole authorisation chain to a file that disappears the
moment `ADSENSE_CLIENT_ID` is unset or this deployment is down.

Either way the root file must carry a `DIRECT` record naming the publisher id.
A root `ads.txt` that exists and does **not** name it is the documented state
that stops the domain being monetised at all.

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
out about a page that renders no balances is not worth taking the defence off
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

Google requires a **certified** consent platform to serve _personalised_ ads to
people in the EEA and the UK. Non-personalised and limited ads are not gated on
that. So on the defaults here — `ADSENSE_CONSENT_MANAGED` unset — every ad
request carries `requestNonPersonalizedAds` and needs no platform at all.

That is also the right default for this product on its own merits: the page
beside the ad is showing somebody their own balances, and profiling the person
reading it is not something to switch on by accident.

### If you want personalised ads

Use **Google's own**, which is free and part of the AdSense account you already
have. It is a certified platform — it appears on Google's list as "Google LLC
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

Two things this does not do. It is not legal advice, and cookie consent under
the ePrivacy directive is a separate question from Google's personalisation
rule — Google's own guidance is that consent is required for cookies even with
non-personalised ads where that directive applies. And a hand-built banner is
not an alternative: the requirement is for a _certified_ platform, and
certification is a process with Google and the IAB rather than a property of the
code.

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
