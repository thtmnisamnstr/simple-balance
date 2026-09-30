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

Six lines, and the profile now pays all six rather than five:

1. **Compute**, by the hour, whether or not anybody visits — and it is **two
   machines** now, the application node and the database node.
2. **Block storage**, per GB-month, for four disks: a boot disk and a data disk
   on each machine, whether or not they are full.
3. **A public IPv4 address**, one, for the application node. AWS charges for
   every one since February 2024, including an Elastic IP attached to a running
   instance. Oracle does not.
4. **A NAT gateway**, so the database node can reach the internet at all —
   Ubuntu's archive and the image registry at first boot, unattended-upgrades
   afterward. **Free on Oracle Cloud, about $33 a month on AWS**, and it is the
   line that surprises people. See below for how to not pay it.
5. **Egress.** Free up to a threshold, then per GB. For this application the
   threshold is never approached — see below.
6. **Snapshots**, if you take any. This profile does not: it takes `pg_dump`
   backups onto the application node's data disk, which is storage you are
   already paying for.

There is no managed-database bill, no load balancer bill and no Kubernetes
control-plane bill. The absence of the last two is most of why this profile is
cheap; the `ha` profile adds both and a bigger database on top.

## The database, which this profile now includes

The figures below cover it. `simple-balance:databaseSize` picks its row of
`docs/deployment-sizing.md`'s table separately from the application node's, and
defaults to the same one — so `small` means two `small` machines unless you say
otherwise. Sizing them apart is usually the cheaper answer: the application node
wants a couple of cores and very little memory, and PostgreSQL wants the
opposite.

**Bringing your own instead is a setting, and the tables below price that too.**
`simple-balance:databaseNode: false` builds no database node, no private subnet
and no NAT gateway, and what it costs then depends entirely on where the
database is:

- **A server you already keep** costs nothing new if it has room. The ledger is
  small — a million transactions is 1.2 GB, `docs/deployment-sizing.md` has the
  arithmetic — and this deployment holds eleven connections.
- **A managed PostgreSQL** — RDS on AWS, or any provider's own — is billed by
  the hour whether or not anybody visits, like the compute line, and its storage
  on top. `docs/deployment-sizing.md` has the settings for a server of each
  size, and the smallest instance that holds the ledger is the one to start on.
- **On Oracle Cloud, OCI Database with PostgreSQL**, in the private subnet
  `oci-single` still makes when `simple-balance:databaseSubnet` asks for it —
  `deploy/pulumi/README.md` walks through it. **It is
  not part of Always Free**, and no managed PostgreSQL is, so with it an Oracle
  deployment is $0 for the machine and not $0 overall. Check its rates in
  Oracle's estimator.

## Per month, by size

Both machines, four disks, and on AWS the NAT gateway:

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | two `t4g.medium` + 80 GiB + NAT — **about $96** | two `VM.Standard.A1.Flex` 2/4 + 100 GB each — **$0, exactly at the Always Free ceiling** |
| `medium` | two `m7g.xlarge` + 140 GiB + NAT — **about $290** | two 4 OCPU / 16 GB + 100 GB each — **about $99** |
| `large` | two `m7g.2xlarge` + 240 GiB + NAT — **about $536** | two 8 OCPU / 32 GB + 150 GB each — **about $195** |

And the same stacks with `simple-balance:databaseNode: false`, which is one
machine and no NAT gateway — the figures this page carried before the profile
grew a database, plus whatever the database you bring costs:

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | `t4g.medium` + 40 GiB — **about $31** | `VM.Standard.A1.Flex` 2/4 + 100 GB — **$0, within Always Free** |
| `medium` | `m7g.xlarge` + 70 GiB — **about $128** | 4 OCPU / 16 GB + 100 GB — **$0, within Always Free** |
| `large` | `m7g.2xlarge` + 120 GiB — **about $251** | 8 OCPU / 32 GB + 150 GB — **about $97** |

The AWS figures include $3.65 for the application node's IPv4 address, both
machines' disks at gp3's $0.08 per GB-month, and — in the first table — about
$33 for the NAT gateway and $3.65 for the address it holds. They are Graviton
throughout: the images this project publishes carry `linux/arm64`, and the x86
equivalent of each row is roughly a fifth more for the same work. The Oracle
storage is a 50 GB boot volume plus the data volume on each machine, which
`oci-single` never makes smaller than OCI's 50 GB minimum, so `small` gets 50
there rather than the 20 the sizing table names.

### Oracle's Always Free tier, and its two catches

Oracle gives every tenancy 4 Ampere OCPUs, 24 GB of memory, 200 GB of block
storage and 10 TB of egress a month, indefinitely and without a card charge.
OCI's managed database does not fit in it, and neither does a NAT gateway need
to: OCI charges nothing for one.

**The arithmetic at `small` lands on the allowance exactly, and it is worth
doing rather than trusting.** Two `small` machines are 2 OCPUs and 4 GB each:
**4 OCPUs of the 4** and 8 GB of the 24. Storage is a 50 GB boot volume and a
50 GB data volume on each machine, because OCI's minimum raises `small`'s 20 GiB
data disk: **50 + 50 + 50 + 50 = 200 GB of the 200**. Nothing is left over. So
there is no room for a `medium` on either side, no room for a `databaseSize`
above `small`, and no room for a second Simple Balance stack in the same
tenancy. `medium` is now billed on Oracle where it used to be free, and that is
the price of the profile owning its database.

The second catch is the one that was always here: **Always Free A1 capacity is
frequently unavailable.** `Out of host capacity` on instance launch is the normal
experience in busy regions, sometimes for weeks, and this profile now asks for
two instances rather than one. A paid tenancy is served from a different pool
and does not have the problem. Treat the free tier as a pleasant surprise rather
than as the plan.

When a launch fails that way, try another availability domain rather than
another region: Always Free is served only in the tenancy's home region.

```sh
pulumi -C oci-single config set simple-balance:availabilityDomain 2
pulumi -C oci-single up
```

Settle it before the first `up` that succeeds and leave it there, because both
data volumes live in the domain, and changing it afterward would replace them
along with the secret, `env.local`, the backups — and the ledger. While
`simple-balance:protectDataVolume` is on, as it is by default, the program
refuses that `up` before it touches either machine or either volume. Until a
launch succeeds the domain is free to change, because the volumes are built only
after the machines. For Always Free, `oci:region` has to name that same home
region.

That helps only in a home region with more than one domain. Many have exactly
one, and the program then refuses any other value, naming the one there is.
There, retry later, or move to a paid tenancy, whose capacity comes from a
different pool.

### The AWS NAT gateway, and how to not pay for it

About $33 a month, plus $3.65 for the address it holds and $0.045 per GB
processed, which at this workload is pennies. It roughly triples the `small`
bill. It exists because the database node has no public address — which is the
point of the profile — and still has to reach Ubuntu's archive and the image
registry at first boot, and unattended-upgrades every day after.

Two ways out, and the first is the supported one:

- **`simple-balance:databaseNode: false`**, and point `DATABASE_URL` at a
  database you keep. No second machine, no private subnet, no NAT gateway, and
  the second table above is the bill.
- **Make the application node the NAT**, by hand. A route from the database
  subnet to the application node's network interface, `sourceDestCheck` off,
  `ip_forward` on and one `MASQUERADE` rule. It is free and it works. It is not
  what the program builds, because it makes the machine serving the internet
  also the router for the machine holding the ledger, and it couples the
  database's ability to patch itself to the application node being up.

Oracle Cloud needs neither: its NAT gateway carries no hourly charge.

## Egress, which is the line that surprises people

It does not here. This application serves a browser bundle of a few hundred
kilobytes, cached with a content hash and revalidated once per page load, and
JSON responses measured in kilobytes. A busy single-deployment year is a few
gigabytes. The application node's traffic to the database node stays inside the
VPC or VCN and is not egress at all, which is one more reason the database is on
the provider's private network rather than across the internet.

AWS gives 100 GB a month free and charges $0.09 per GB after it. Oracle gives
10 TB. Neither is reachable by this workload unless something is wrong — and the
thing that would be wrong is CSV exports of a very large ledger, downloaded
repeatedly, which is worth a moment's thought only if you are running this for
other people.

## Reducing it

- **Stay on `small`.** The sizing document's capacity table is not a typo: a
  million transactions is 1.2 GB. Most deployments that reach for `medium` are
  reaching for memory they are not using.
- **Size the two machines apart.** `simple-balance:size` at `small` and
  `simple-balance:databaseSize` at `medium` is the shape most deployments that
  outgrow `small` actually want: the application node stays a `t4g.medium` and
  only PostgreSQL gets the bigger machine. On AWS that is about $193 rather
  than the $290 of two `medium` machines.
- **Commit, if the deployment is permanent.** A one-year AWS Savings Plan on
  `t4g.medium` takes roughly a third off the compute line, which is most of the
  bill. Oracle's equivalent is a Universal Credits commitment, which is worth
  asking about above about $100 a month and not below.
- **Do not pay for a load balancer.** Caddy terminates TLS on the application
  node and obtains its own certificate. An ALB would add about $18 a month plus
  capacity units to do what it already does, and would put a second hop in front
  of the application whose `X-Forwarded-For` has to come out right for
  `TRUST_PROXY` — `docs/deployment-profiles.md` has the rule.
- **Turn off what you do not use.** Nothing in this profile bills for Stripe,
  AdSense, metrics or mail unless configured — but an SMTP relay is its own
  subscription, and it is now the one recurring cost this document cannot price.

## Against the alternatives

| | Roughly | What you get |
| --- | --- | --- |
| This profile, `small`, on Oracle | $0 | Two machines and a PostgreSQL 18 you run, with your own data in it |
| This profile, `small`, on AWS | $96 | The same, in an account you probably already have |
| This profile, `small`, on AWS, database elsewhere | $31, plus the database | One machine, and somebody else's PostgreSQL bill |
| The `ha` profile, one node per service | $220+ | Control plane $73, two nodes, a load balancer, the database's own volumes, and the ledger already distributed |
| The `ha` profile, highly available | $350+ | The same with more nodes, because six database pods with their standbys do not fit beside the web tier on two |
| A hosted personal-finance service | $60–180/yr | Somebody else's copy of your transactions |

The two `ha` rows are floors and not estimates: control plane, nodes and one
load balancer, with the database's own storage on top, and nothing for the
traffic. What they buy is surviving the loss of a machine, in the second row,
and a ledger that is already distributed in both. That is worth paying for when it is worth paying for, and
`docs/deployment-profiles.md` is where the decision is argued.

## What this document cannot tell you

A domain name, which is $10–15 a year and not optional — Let's Encrypt will not
issue for an address. Whatever your SMTP relay charges, if you turn mail on. And
your own time, which is the real difference between this and a hosted service
and is not a line on anybody's bill — running your own PostgreSQL is part of
that time now, which is what the backup timer and the verified restore are for.
