# Billing operations

For the person who runs the deployment, not the person using it. Everything here
assumes Stripe is configured; on a deployment that sells nothing none of it
applies and none of the routes it mentions exist.

`docs/monetization.md` says what the settings do. This says how to set Stripe
up, and what to do when something needs a hand.

## Setting up Stripe

In this order. The five settings it ends with are in `docs/deployment.md`
§Only for selling a plan, which says what each is for; this is what has to exist
at Stripe before they mean anything. Do it in a sandbox first and again in live
mode when you go live, because nothing made in one mode exists in the other.

1. **One Product, with two recurring Prices in USD: $3.00 every month and
   $30.00 every year.** One product because the two are one plan billed two
   ways, and one currency because moving from monthly to annual updates one
   subscription, which Stripe bills in one currency for its whole life. Copy the
   two `price_…` ids into `STRIPE_PRICE_MONTHLY_ID` and
   `STRIPE_PRICE_YEARLY_ID`.

   The server checks both against what they are sold as — at startup, in both
   the API and the scheduler, and then every time it reads them, at most every
   ten minutes: on the plan tab, before every subscription it starts, and on
   every reconciliation sweep. Each has to be recurring; bill every one month
   or every one year, matching its setting; be active while
   `SB_BILLING_ENABLED` is on; exist in the secret key's own mode, since a test
   price beside a live key is the usual mistake; and share its product and
   currency with the other. Until both fit, nothing is for sale: the log
   carries an error naming what is wrong, the plan tab offers no plan, and
   starting a subscription answers `409` and charges nobody. Replacing a card,
   canceling, paying a renewal's open invoice — **Pay now** on a failed one,
   **Pay what is owed** on an unpaid one — and letting go of a switch still
   waiting for the renewal go on working, because none of them sells anything.
   Asking an unpaid subscription for the other interval is not a payment: it is
   a switch scheduled for the renewal, and it is refused with the other sales.
   A Stripe that cannot be reached to check is a warning and refuses nothing.

2. **The keys.** `pk_…` into `STRIPE_PUBLISHABLE_KEY` and `sk_…` into
   `STRIPE_SECRET_KEY`, both from the same mode. A restricted `rk_…` key works
   in place of `sk_…` if it can make every call this deployment makes, all of
   which are in `src/server/stripe.ts`:

   | Resource | Access | What for |
   | --- | --- | --- |
   | Customers | Write | Created at somebody's first subscription or card, read to check it still exists and to find the card it is billed on, updated when a card is replaced, and deleted with the account |
   | Subscriptions | Write | Created, read, updated for a new price or a new card, and canceled |
   | Subscription schedules | Write | A move to the monthly price waits for the renewal on a schedule, which is created, updated and released |
   | SetupIntents | Write | Created when somebody replaces a card, and read when it is confirmed |
   | Invoices | Write | Read to find a subscription's open invoice and the secret that confirms it, and paid with a replaced card |
   | PaymentMethods | Read | Read, never written, to tell which card Stripe is billing |
   | Prices | Read | The two prices, read for the plan tab and checked as above |

   Stripe refuses a call the key cannot make with a message naming the
   permission it lacked, and the log carries that message beside the failed
   request.

3. **The webhook endpoint**, at `https://your-host/api/billing/webhook`, for
   events on your own account, with snapshot payloads rather than thin ones —
   the handler reads the object the event carries — and set to API version
   `2026-08-26.dahlia`, the one `stripe@22.6.2` pins. Subscribe it to exactly
   these: `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
   `setup_intent.succeeded`, `customer.deleted`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed` and
   `charge.dispute.funds_withdrawn`. `docs/deployment.md` §The webhook, and
   which events it has to be sent says what each is for, and a missing one
   fails in silence. Copy the endpoint's signing secret, `whsec_…`, into
   `STRIPE_WEBHOOK_SECRET`.

4. **Customer emails.** The plan tab promises that receipts and invoices come
   from Stripe by email, and this deployment sends no billing mail of its own,
   so Stripe's are the only messages about money anybody gets. In the customer
   email settings, turn on emails for successful payments, and for refunds if
   you want them. In the Billing settings for subscriptions and emails, turn on
   the emails sent when a card payment fails, and "Send a Stripe-hosted link for
   customers to confirm their payments when required", with its reminders. A
   renewal the bank wants authenticated with 3-D Secure happens with nobody on
   the page, and that link is how the person is asked. Somebody who opens the
   plan tab meanwhile sees "Pay now", which confirms the same invoice there.

5. **Retries, and what happens when they run out**, under Revenue recovery. A
   failed renewal keeps Premium for fifteen days counted from the failure, and
   at fifteen days exactly the plan is free. That is sized to Stripe's
   recommended default of eight tries within two weeks, with a day over for a
   webhook that lands late. This deployment cannot see the setting, so keep the
   retry window at two weeks or less: a window of three weeks or more outlasts
   the grace, and a subscriber Stripe is still retrying drops to Free before the
   retry that was always going to come, with every account past three frozen.
   Then choose what happens if all retries for a payment fail:

   | If all retries fail | What the plan tab shows |
   | --- | --- |
   | Cancel the subscription | The plan drops to Free and the tab offers the plans again, as it does to somebody who never subscribed |
   | Mark the subscription as unpaid | "Unpaid", with "Pay what is owed", which pays the open invoice. The plan is Free until it is paid |
   | Leave the subscription past due | "Payment failed", with "Pay now". The plan stays Premium for fifteen days from the failure and then drops to Free, while Stripe goes on raising invoices nobody pays |

   Choose one of the first two. The third leaves a subscription that looks alive
   at Stripe and grants nothing here.

6. **Payment method domains.** Register the domain this deployment answers on,
   in live mode and in each sandbox you use. Cards work without it; registering
   it is what turns on Link, Apple Pay and Google Pay in the payment form, and
   Apple Pay needs it outright.

7. **Tax: nothing to set, because this release collects none.** No subscription
   is created with automatic tax and no address is asked for, so turning Stripe
   Tax on in the dashboard collects nothing. `docs/monetization.md` §The prices,
   and what they actually net says what collecting it would take.

Then set the five settings and restart. Once both prices fit, the log says
`Stripe is configured, and both prices fit the plans they are sold as.`, from
the check at startup or, if Stripe could not be reached then, the first one
after it that could. Putting the plan on sale is the separate step
`SB_BILLING_ENABLED=true` takes — read §Turning selling on before you take it.

### Going live, or changing Stripe account

Nothing made in one mode exists in the other: a live key cannot see a test
customer, subscription, price or webhook endpoint, and a key for another account
sees none of this one's. So going live is the list above again in live mode, and
then:

1. **Clear what the test mode left behind**, one of two ways. Either delete the
   test customers in the test-mode dashboard *while the test
   `STRIPE_WEBHOOK_SECRET` is still set*: each deletion arrives as a
   `customer.deleted`, which drops that mapping and marks the person's
   subscriptions canceled. Or, after the swap and before anybody subscribes for
   real:

   ```sql
   delete from billing_subscription;
   delete from billing_customer;
   ```

   Leave `billing_webhook_event` alone either way. It records which deliveries
   Stripe has already been answered for, which is the deployment's fact rather
   than a mode's.

2. **Replace all five `STRIPE_*` settings together**, then restart: the live
   `pk_live_…`, the live `sk_live_…` or `rk_live_…`, the live endpoint's own
   `whsec_…` — a live endpoint's secret is not the test one's — and the live
   price ids, because test `price_…` ids do not exist in live mode. The first
   price check in the log says whether they fit.
3. **Disable the test-mode webhook endpoint**, so Stripe stops sending
   deliveries this deployment can no longer verify.
4. **Expire any `billing_override` granted for trying the plan out**, as
   §Granting a plan by hand shows, so nobody keeps Premium on the strength of a
   test.

Skip the first step and the server copes on its own, more slowly, once the live
keys are in. A stored customer the key reports deleted, or reports missing once
a live key has found both configured prices in live mode, is forgotten: the
mapping is dropped, that person's subscription rows are marked canceled, and a
new customer is made the next time they subscribe or replace a card. Deleted is
believed whatever the key, because only a key in the customer's own mode can see
that it was deleted. The reconciliation sweep does the same for a subscription
that live key has no record of, when it next reaches that row, which is within
about twelve hours of its last read. Until then a test subscription still reads
as active and still grants Premium.

When a test key, or a key for an account other than the one that owns the
configured prices, says a customer or subscription is missing, nothing is
dropped or canceled. To that key every customer is missing, and so is every live customer to a test key, and believing either
would end every paying subscriber's plan. The rows are kept and every use of
them fails instead: the sweep counts each one failed and tries it again after
the same twelve hours, subscribing or replacing a card fails at Stripe, and
deleting the account is refused, because the mapping it would take with it is
the only thing left that could reach a subscription still charging. So a
deployment that stays on test keys keeps its rows too — one moving from one
sandbox to another, or one whose test data was purged at Stripe — and clearing
the tables by hand, as in step 1, is the way out.

**Never point a live deployment at test keys, even to rehearse.** Nothing is
canceled, but nobody who already has a live customer can subscribe, replace a
card or delete their account until the live keys are back, and the sweep fails
every row it reads. Worse, the store stays open: the test prices pass the price
check, so anybody without a live customer can subscribe with Stripe's public
test card and hold Premium for nothing until the live keys are back and the
sweep reaches the row. Rehearse on a deployment of its own.

## Granting a plan by hand

`billing_override` puts somebody on a plan without Stripe. Use it for the cases
money cannot answer: a friend of the project, somebody whose payment went wrong
in a way support could not unwind, a deployment run for one household where
nobody is paying anybody.

An override beats everything. `resolveEntitlement` reads it first, so an
unexpired override grants its plan whether or not there is a subscription, and
whatever state that subscription is in.

```sql
-- Put somebody on Premium ('plus', the wire value) for a year. Find the id by
-- the address they sign in with.
insert into billing_override (user_id, plan, expires_at, reason, operator)
select id, 'plus', now() + interval '1 year',
       'Beta tester, agreed 2026-09-13', 'gavin'
from auth_user where lower(email) = lower('them@example.com')
on conflict (user_id) do update
  set plan = excluded.plan,
      expires_at = excluded.expires_at,
      reason = excluded.reason,
      operator = excluded.operator,
      updated_at = now();
```

`expires_at` may be `null`, which means forever. Prefer a date: an override that
never expires is one nobody ever revisits, and the free plan is generous enough
that a lapsed one is not a crisis.

To end an override, expire it rather than deleting it:

```sql
update billing_override set expires_at = now(), updated_at = now()
where user_id = (select id from auth_user where lower(email) = lower('them@example.com'));
```

The row that stays is the record of what was done. Deleting it leaves nothing.

### Why this writes no `audit_event`

Because it would have to lie. `audit_event.actor_source` is a closed set of the
three ways this application acts — `web`, `mcp`, `schedule` — and an operator at
a `psql` prompt is none of them. Recording one as `web` would put a false row in
the one table whose whole value is that its rows are not false.

The `billing_override` row is the record instead, which is what `reason` and
`operator` are for, alongside `created_at` and `updated_at`. Fill them in. The
person it is about can see the override on their plan tab, so it is not a
decision made about somebody behind their back.

## Refunds and disputes

Issue both in Stripe's dashboard. Neither changes anything here on its own, and
that is deliberate: a refund does not say whether the person should keep the
plan they were refunded for, and only a person can answer that.

A `charge.refunded` or `charge.dispute.*` delivery is logged and acknowledged.
If the answer is that they should lose the plan, cancel the subscription in
Stripe — the cancellation arrives as its own delivery and the ledger follows it.
If the answer is that they keep it, do nothing; they already have it.

A dispute that Stripe resolves by canceling the subscription needs nothing
either. That cancellation is a `customer.subscription.updated` like any other.

## When a webhook was missed

Nothing has to be replayed by hand. Every live subscription is re-read from
Stripe when it has not been heard about for twelve hours, fifty per scheduler
tick, oldest first. A deployment whose webhook endpoint was misconfigured for a
weekend is correct again within a day of it being fixed.

To see it working, watch `simple_balance_billing_sweeps_total` — `written`
climbs when the sweep is repairing something and stays flat when there is
nothing to repair. `off` means the deployment sells nothing.

A subscription Stripe cannot answer about is tried again after the same twelve
hours as everything else, rather than first on every tick: the sweep stamps it
with the time the attempt began, which moves it to the back of the line without
changing what it says. Rows that fail every time used to keep the oldest stamps
in the table, and fifty of them were every row the sweep would ever read.

To hurry it along for one person, replay from Stripe's dashboard an event this
deployment never received — one the endpoint was misconfigured during, which is
the case the sweep exists for. Stripe's resend reuses the event's own id, so
replaying one that *did* land does nothing: it is claimed already. That is the
protection working rather than a limitation, and it is why the sweep rather than
a replay is the general answer.

Anything the person can reach themselves also forces a re-read: opening the plan
tab re-reads a subscription that is waiting for payment, and replacing a card
re-reads it afterward.

## Changing a price

A Stripe Price cannot be edited: the amount is fixed when it is created.
Raising one means creating a second Price on the same Product, pointing
`STRIPE_PRICE_MONTHLY_ID` or `STRIPE_PRICE_YEARLY_ID` at the new id, and
restarting. Archive the old Price in Stripe afterward so nothing new is sold
at it; archiving changes nothing about what anybody is already charged.

**Nobody's bill moves because you did that.** Every subscription that exists
goes on billing at the price it was created with, for as long as it lives.
What changed is what somebody arriving now is offered. The new Price has to
fit the same rules as the old one — §Setting up Stripe, step 1 — or the
deployment stops selling until it does, and says why in the log.

Somebody on the old price sees **"On a price this deployment no longer sells"**
on their plan tab, with their real status and renewal date beside it.
`intervalOfPrice` recognizes neither interval for an id that is not one of the
two configured, and the page says so rather than guessing: telling an annual
subscriber "Monthly" would put a figure and a renewal date on the screen that
are both wrong.

They move when they choose to, and the move lands at their renewal rather than
today. `subscriptionAction` returns `schedule` for anybody whose current
interval is unrecognized, whichever button they press — deliberately, because
the immediate path bills the difference on the spot, and charging somebody now
and moving a renewal date they have already been billed against is not a thing
to do off a value that means "I do not recognize this". Nothing here ever moves
somebody to a new price on their behalf; doing that is a Stripe-side decision
with whatever notice your terms promise attached to it.

**And the repository half, in the same commit.** `docs/product/facts.json`
declares the price to the marketing site, which is a separate repository that
will otherwise go on advertising the old figure. It is generated: edit
`declared.prices` in `scripts/build-product-facts.mjs` and re-run it. The
`product-kit` skill has the procedure.

## Turning selling on

`SB_BILLING_ENABLED=true`, and restart. Read this first, because what it does
to anybody who already has more than three accounts happens the moment the
process starts, with nobody asked.

Everybody without a subscription or an unexpired override is on the free plan
from then on, and the free plan keeps three accounts in use. Nobody at or under
three notices anything. Above it nothing is archived, hidden or deleted — every
account stays listed, readable and counted in every balance, report and export —
but only three stay usable: the three oldest, until the person makes their
one-time choice on the Accounts page, or an agent makes it with
`set_active_accounts`. The rest are frozen and refuse every write: a new entry,
an edit, a delete, a rename, and a payee or category merge that would touch one,
which refuses whole. A staged or imported row that names one gets an issue
instead of committing. `docs/monetization.md` has the whole rule, and why the
choice is made only once.

**So grant an override first** to everybody who should keep every account —
yourself included, if your own ledger is on this deployment — with the statement
in §Granting a plan by hand. An override outranks every subscription, so it
holds whatever Stripe says later.

## Stopping selling

Set `SB_BILLING_ENABLED=false` and restart. Do not remove the Stripe settings.
On the single machines the Pulumi programs build, that is an edit to
`/var/lib/simple-balance/env.local` followed by
`sudo systemctl restart simple-balance`; a `single` profile installed by hand
keeps its settings in `/opt/simple-balance/.env`.

| What                                                                | After the flag goes off                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| New subscriptions, interval changes, and finishing a first payment  | Refused, `409`: each of them is a sale                                           |
| Canceling                                                           | **Still works.** Trapping people is not a pause                                  |
| Replacing a card                                                    | Still works, and pays the outstanding invoice with it                            |
| Paying a renewal's open invoice (**Pay now**, **Pay what is owed**) | Still works. It settles a subscription that already exists and sells nothing new |
| Choosing the current plan again, to let go of a pending switch      | Still works. It keeps the plan already paid for and sells nothing                |
| The account limit                                                   | Not enforced — nobody is held to a plan that is not for sale                     |
| Frozen accounts                                                     | None. Nothing is frozen while nothing is for sale                                |
| Advertising                                                         | Shown to nobody, because an ad needs a limited plan in force                     |
| Webhooks                                                            | Still received, still reconciled                                                 |
| The reconciliation sweep                                            | Still runs                                                                       |
| Existing subscriptions at Stripe                                    | **Still charging.** Cancel them in Stripe                                        |

The flag closes the store; it does not stop the register. People who
subscribed are still being billed by Stripe until somebody cancels them there,
and until then they keep their plan here — which is the honest arrangement,
since they are still paying for it.

## Shutting billing down completely

In this order, or somebody gets charged for nothing:

1. `SB_BILLING_ENABLED=false`, restart. Nothing new is sold.
2. Cancel every subscription in Stripe, or let them run to the end of their
   paid periods. The cancellations arrive as deliveries and are reconciled.
3. Confirm nothing is live: `select status, count(*) from billing_subscription
group by status;` should show only `canceled` and `incomplete_expired`.
4. Remove the `STRIPE_*` settings and restart.

Step 4 last, and this is the step to get wrong. Removing them takes the webhook
route away entirely — the path answers `404` — so Stripe retries for 72 hours
and then marks the endpoint as failing. Do it while subscriptions are live and
the ledger stops hearing about them while the cards keep being charged.

Disable the endpoint in Stripe's dashboard as well, so it stops being retried
against a deployment that no longer has it.

## When somebody deletes their account

They cannot, while a subscription might still be charging them.
`deleteOwnAccount` deletes the Stripe customer first — which cancels everything
it owns, immediately and idempotently — and refuses the deletion with a `409`
if that cannot be confirmed: when Stripe cannot be reached, and when Stripe says
it has no such customer to a key that cannot vouch for it. A customer that reads
back as deleted is gone whatever the key. One that is only missing is believed
from a live key that has found both configured prices in live mode, and from no
other, because to a test key or a key for the wrong account every live customer
is missing; §Going live, or changing Stripe account has the rest.

That refusal is the right one. The `billing_customer` row cascades away with the
account, so a subscription that outlived the deletion would belong to nobody:
still charging a card, invisible to the sweep, and unreachable from anything left
in the database.

If it keeps failing, cancel the subscription in Stripe's dashboard and delete the
customer there, then ask them to try again. The second attempt finds the
customer deleted and goes through. Under a test key or the wrong account's key
it cannot, because to either one the live customer is missing rather than
deleted, so put the live keys back first.
