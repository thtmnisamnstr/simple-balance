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

Six lines. The tables below price the last five, and of those only compute and
block storage are large. The first is yours to choose, and so is priced by
whoever runs it:

1. **The database**, wherever it runs. This profile runs the application and
   Caddy and connects to a PostgreSQL somebody else keeps, so the database is
   always a line of its own — see
   [below](#the-database-which-this-profile-does-not-include).
2. **Compute**, by the hour, whether or not anybody visits.
3. **Block storage**, per GB-month, for the boot disk and the data disk, whether
   or not they are full.
4. **A public IPv4 address.** AWS charges for every one since February 2024,
   including an Elastic IP attached to a running instance. Oracle does not.
5. **Egress.** Free up to a threshold, then per GB. For this application the
   threshold is never approached — see below.
6. **Snapshots**, if you take any. This profile does not: it takes `pg_dump`
   backups onto the data disk, which is storage you are already paying for.

There is no load balancer bill and no Kubernetes control-plane bill, and their
absence is most of why this profile is cheap; the `ha` profile adds both, and a
database of its own on top.

## The database, which this profile does not include

None of the figures below include it, and what it costs depends entirely on
where it is:

- **A server you already keep** costs nothing new if it has room. The ledger is
  small — a million transactions is 1.2 GB, `docs/deployment-sizing.md` has the
  arithmetic — and this deployment holds eleven connections.
- **A managed PostgreSQL** — RDS on AWS, or any provider's own — is billed by
  the hour whether or not anybody visits, like the compute line, and its storage
  on top. `docs/deployment-sizing.md` has the settings for a server of each
  size, and the smallest instance that holds the ledger is the one to start on.
- **On Oracle Cloud, OCI Database with PostgreSQL**, in the private subnet
  `oci-single` makes when `simple-balance:databaseSubnet` is `true` —
  `deploy/pulumi/README.md` walks through it. **It is not part of Always Free**,
  and no managed PostgreSQL is, so with it an Oracle deployment is $0 for the
  machine and not $0 overall. Check its rates in Oracle's estimator. A
  PostgreSQL you run yourself — on a server you have, or on what `small` leaves
  of the Always Free Ampere allowance — adds no bill, but it is yours to keep
  running and backed up.

## Per month, by size

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | `t4g.medium` + 40 GiB — **about $31** | `VM.Standard.A1.Flex` 2/4 + 100 GB — **$0, within Always Free** |
| `medium` | `m7g.xlarge` + 70 GiB — **about $128** | 4 OCPU / 16 GB + 100 GB — **$0, within Always Free** |
| `large` | `m7g.2xlarge` + 120 GiB — **about $251** | 8 OCPU / 32 GB + 150 GB — **about $97** |

The machine only: the database is the line above. The AWS figures include $3.65
for the IPv4 address and both disks at gp3's $0.08 per GB-month, and are
Graviton throughout: the images this project publishes carry `linux/arm64`, and
the x86 equivalent of each row is roughly a fifth more for the same work. The
Oracle storage is the 50 GB boot volume plus the data volume, which
`oci-single` never makes smaller than OCI's 50 GB minimum, so `small` gets 50
there rather than the 20 the sizing table names.

### Oracle's Always Free tier, and its catch

Oracle gives every tenancy 4 Ampere OCPUs, 24 GB of memory, 200 GB of block
storage and 10 TB of egress a month, indefinitely and without a card charge.
The `small` and `medium` machines fit inside it, which is why two rows above are
zero. OCI's managed database does not, and is billed on its own.

The catch is real and worth knowing before planning around it: **Always Free A1
capacity is frequently unavailable.** `Out of host capacity` on instance launch
is the normal experience in busy regions, sometimes for weeks. A paid tenancy is
served from a different pool and does not have the problem. Treat the free tier
as a pleasant surprise rather than as the plan.

When a launch fails that way, try another availability domain rather than
another region: Always Free is served only in the tenancy's home region.

```sh
pulumi -C oci-single config set simple-balance:availabilityDomain 2
pulumi -C oci-single up
```

Settle it before the first `up` that succeeds and leave it there, because the
data volume lives in the domain, and changing it afterward replaces the volume
along with the secret, `env.local` and the backups on it.

That helps only in a home region with more than one domain. Many have exactly
one, and the program then refuses any other value, naming the one there is.
There, retry later, or move to a paid tenancy, whose capacity comes from a
different pool.

## Egress, which is the line that surprises people

It does not here. This application serves a browser bundle of a few hundred
kilobytes, cached with a content hash and revalidated once per page load, and
JSON responses measured in kilobytes. A busy single-deployment year is a few
gigabytes. A database outside the machine's own network adds its queries and
the nightly dump to the traffic, and its own provider may charge for what it
sends back; at this workload that stays small too.

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
  units to do what it already does, and would put a second hop in front of the
  application whose `X-Forwarded-For` has to come out right for `TRUST_PROXY` —
  `docs/deployment-profiles.md` has the rule.
- **Turn off what you do not use.** Nothing in this profile bills for Stripe,
  AdSense, metrics or mail unless configured — but an SMTP relay is its own
  subscription, and with the database it is one of the two recurring costs this
  document cannot price.

## Against the alternatives

| | Roughly | What you get |
| --- | --- | --- |
| This profile, `small`, on Oracle | $0, plus the database | One machine and a database you choose, with your own data in it |
| This profile, `small`, on AWS | $31, plus the database | The same, in an account you probably already have |
| The `ha` profile on EKS | $220+ | Control plane $73, two nodes, a load balancer, and a managed PostgreSQL on top |
| A hosted personal-finance service | $60–180/yr | Somebody else's copy of your transactions |

The `ha` row is a floor and not an estimate: it is the control plane, the
smallest sensible node pair and one load balancer, before the database. It buys
surviving the loss of a machine. That is worth paying for when it is worth
paying for, and `docs/deployment-profiles.md` is where the decision is argued.

## What this document cannot tell you

A domain name, which is $10–15 a year and not optional — Let's Encrypt will not
issue for an address. What the database costs, which depends on where it runs.
Whatever your SMTP relay charges, if you turn mail on. And your own time, which
is the real difference between this and a hosted service and is not a line on
anybody's bill.
