# Billing operations

For the person who runs the deployment, not the person using it. Everything here
assumes Stripe is configured; on a deployment that sells nothing none of it
applies and none of the routes it mentions exist.

`docs/monetization.md` says what the settings do. This says what to do when
something needs a hand.

## Granting a plan by hand

`billing_override` puts somebody on a plan without Stripe. Use it for the cases
money cannot answer: a friend of the project, somebody whose payment went wrong
in a way support could not unwind, a deployment run for one household where
nobody is paying anybody.

An override beats everything. `resolveEntitlement` reads it first, so an
unexpired override grants its plan whether or not there is a subscription, and
whatever state that subscription is in.

```sql
-- Put somebody on Plus for a year. Find the id by the address they sign in with.
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

A dispute that Stripe resolves by cancelling the subscription needs nothing
either. That cancellation is a `customer.subscription.updated` like any other.

## When a webhook was missed

Nothing has to be replayed by hand. Every live subscription is re-read from
Stripe when it has not been heard about for twelve hours, fifty per scheduler
tick, oldest first. A deployment whose webhook endpoint was misconfigured for a
weekend is correct again within a day of it being fixed.

To see it working, watch `simple_balance_billing_sweeps_total` — `written`
climbs when the sweep is repairing something and stays flat when there is
nothing to repair. `off` means the deployment sells nothing.

To hurry it along for one person, replay from Stripe's dashboard an event this
deployment never received — one the endpoint was misconfigured during, which is
the case the sweep exists for. Stripe's resend reuses the event's own id, so
replaying one that *did* land does nothing: it is claimed already. That is the
protection working rather than a limitation, and it is why the sweep rather than
a replay is the general answer.

Anything the person can reach themselves also forces a re-read: opening the plan
tab re-reads a subscription that is waiting for payment, and replacing a card
re-reads it afterwards.

## Changing a price

A Stripe Price cannot be edited: the amount is fixed when it is created.
Raising one means creating a second Price on the same Product, pointing
`STRIPE_PRICE_MONTHLY_ID` or `STRIPE_PRICE_YEARLY_ID` at the new id, and
restarting. Archive the old Price in Stripe afterwards so nothing new is sold
at it; archiving changes nothing about what anybody is already charged.

**Nobody's bill moves because you did that.** Every subscription that exists
goes on billing at the price it was created with, for as long as it lives.
What changed is what somebody arriving now is offered.

Somebody on the old price sees **"On a price this deployment no longer sells"**
on their plan tab, with their real status and renewal date beside it.
`intervalOfPrice` recognises neither interval for an id that is not one of the
two configured, and the page says so rather than guessing: telling an annual
subscriber "Monthly" would put a figure and a renewal date on the screen that
are both wrong.

They move when they choose to, and the move lands at their renewal rather than
today. `subscriptionAction` returns `schedule` for anybody whose current
interval is unrecognised, whichever button they press — deliberately, because
the immediate path bills the difference on the spot, and charging somebody now
and moving a renewal date they have already been billed against is not a thing
to do off a value that means "I do not recognise this". Nothing here ever moves
somebody to a new price on their behalf; doing that is a Stripe-side decision
with whatever notice your terms promise attached to it.

**And the repository half, in the same commit.** `docs/product/facts.json`
declares the price to the marketing site, which is a separate repository that
will otherwise go on advertising the old figure. It is generated: edit
`declared.prices` in `scripts/build-product-facts.mjs` and re-run it. The
`product-kit` skill has the procedure.

## Stopping selling

Set `SB_BILLING_ENABLED=false` and restart. Do not remove the Stripe settings.

| What                                   | After the flag goes off                                      |
| -------------------------------------- | ------------------------------------------------------------ |
| New subscriptions and interval changes | Refused, `409`                                               |
| Cancelling                             | **Still works.** Trapping people is not a pause              |
| Replacing a card                       | Still works, and pays the outstanding invoice with it        |
| The account limit                      | Not enforced — nobody is held to a plan that is not for sale |
| Webhooks                               | Still received, still reconciled                             |
| The reconciliation sweep               | Still runs                                                   |
| Existing subscriptions at Stripe       | **Still charging.** Cancel them in Stripe                    |

The flag stops the shop; it does not stop the till. People who subscribed are
still being billed by Stripe until somebody cancels them there, and until then
they keep their plan here — which is the honest arrangement, since they are
still paying for it.

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

They cannot, while a subscription might still be charging them. `deleteOwnAccount`
deletes the Stripe customer first — which cancels everything it owns, immediately
and idempotently — and refuses the deletion with a `409` if Stripe cannot be
reached to confirm it.

That refusal is the right one. The `billing_customer` row cascades away with the
account, so a subscription that outlived the deletion would belong to nobody:
still charging a card, invisible to the sweep, and unreachable from anything left
in the database.

If it keeps failing, cancel the subscription in Stripe's dashboard and delete the
customer there, then ask them to try again. The second attempt finds nothing to
cancel and goes through.
