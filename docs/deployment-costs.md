# What a `single` deployment costs

**The figures below are indicative and dated: list prices for a US region, as of
September 2026, and not a quote.** Cloud prices move, they differ by region by
tens of percent, and neither provider's calculator agrees with a table in a
repository for long. Check
[AWS's calculator](https://calculator.aws/) and
[Oracle's](https://www.oracle.com/cloud/costestimator.html) before committing to
anything. What is durable here is the *shape* of the bill and the comparison,
not the digits.

## The shape of the bill

Five lines, and only the first two are large:

1. **Compute**, by the hour, whether or not anybody visits.
2. **Block storage**, per GB-month, for the boot disk and the data disk, whether
   or not they are full.
3. **A public IPv4 address.** AWS charges for every one since February 2024,
   including an Elastic IP attached to a running instance. Oracle does not.
4. **Egress.** Free up to a threshold, then per GB. For this application the
   threshold is never approached — see below.
5. **Snapshots**, if you take any. This profile does not: it takes `pg_dump`
   backups onto the data disk, which is storage you are already paying for.

There is no managed database bill, no load balancer bill and no Kubernetes
control-plane bill, and their absence is most of why this profile is cheap. The
`ha` profile adds all three.

## Per month, by size

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | `t4g.medium` + 40 GiB — **about $31** | `VM.Standard.A1.Flex` 2/4 + 70 GB — **$0, within Always Free** |
| `medium` | `m7g.xlarge` + 70 GiB — **about $128** | 4 OCPU / 16 GB + 100 GB — **$0, within Always Free** |
| `large` | `m7g.2xlarge` + 120 GiB — **about $251** | 8 OCPU / 32 GB + 150 GB — **about $97** |

The AWS figures include $3.65 for the IPv4 address and both disks at gp3's
$0.08 per GB-month. Graviton throughout: the images this project publishes carry
`linux/arm64`, and the x86 equivalent of each row is roughly a fifth more for
the same work.

### Oracle's Always Free tier, and its catch

Oracle gives every tenancy 4 Ampere OCPUs, 24 GB of memory, 200 GB of block
storage and 10 TB of egress a month, indefinitely and without a card charge.
Both `small` and `medium` fit inside it, which is why two rows above are zero.

The catch is real and worth knowing before planning around it: **Always Free A1
capacity is frequently unavailable.** `Out of host capacity` on instance launch
is the normal experience in busy regions, sometimes for weeks. A paid tenancy is
served from a different pool and does not have the problem. Treat the free tier
as a pleasant surprise rather than as the plan, and pick a region with room.

## Egress, which is the line that surprises people

It does not here. This application serves a browser bundle of a few hundred
kilobytes, cached with a content hash and revalidated once per page load, and
JSON responses measured in kilobytes. A busy single-deployment year is a few
gigabytes.

AWS gives 100 GB a month free and charges $0.09 per GB after it. Oracle gives
10 TB. Neither is reachable by this workload unless something is wrong — and the
thing that would be wrong is CSV exports of a very large ledger, downloaded
repeatedly, which is worth a moment's thought only if you are running this for
other people.

## Reducing it

- **Stay on `small`.** The sizing document's capacity table is not a typo: a
  million transactions is 1.2 GB. Most deployments that reach for `medium` are
  reaching for memory they are not using.
- **Commit, if the deployment is permanent.** A one-year AWS Savings Plan on
  `t4g.medium` takes roughly a third off the compute line, which is most of the
  bill. Oracle's equivalent is a Universal Credits commitment, which is worth
  asking about above about $100 a month and not below.
- **Do not pay for a load balancer.** Caddy terminates TLS on the instance and
  obtains its own certificate. An ALB would add about $18 a month plus capacity
  units to do what it already does, and would make `SB_TRUSTED_PROXY_CIDR` a
  thing to get right.
- **Turn off what you do not use.** Nothing in this profile bills for Stripe,
  AdSense, metrics or mail unless configured — but an SMTP relay is its own
  subscription, and it is the one recurring cost this document cannot price.

## Against the alternatives

| | Roughly | What you get |
| --- | --- | --- |
| This profile, `small`, on Oracle | $0 | One machine, your own data, no third party in the path |
| This profile, `small`, on AWS | $31 | The same, in an account you probably already have |
| The `ha` profile on EKS | $220+ | Control plane $73, two nodes, a load balancer, and a managed PostgreSQL on top |
| A hosted personal-finance service | $60–180/yr | Somebody else's copy of your transactions |

The `ha` row is a floor and not an estimate: it is the control plane, the
smallest sensible node pair and one load balancer, before the database. It buys
surviving the loss of a machine. That is worth paying for when it is worth
paying for, and `docs/deployment-profiles.md` is where the decision is argued.

## What this document cannot tell you

A domain name, which is $10–15 a year and not optional — Let's Encrypt will not
issue for an address. Whatever your SMTP relay charges, if you turn mail on. And
your own time, which is the real difference between this and a hosted service
and is not a line on anybody's bill.
