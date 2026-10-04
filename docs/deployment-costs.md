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

Seven lines. A `single` deployment that configures nothing pays the first four
on AWS, and the first three on Oracle Cloud, where the NAT gateway is free.
The last three are zero, optional, or not taken:

1. **Compute**, by the hour, whether or not anybody visits — and it is **two
   machines** now, the application node and the database node.
2. **Block storage**, per GB-month, for four disks: a boot disk and a data disk
   on each machine, whether or not they are full. The two data disks are sized
   separately and very differently — `docs/deployment-sizing.md` has the
   arithmetic, and the application node's is usually the larger of the two,
   because it holds fifteen daily dumps of a ledger the other machine holds once.
3. **A public IPv4 address**, one, for the application node. AWS charges for
   every one since February 2024, including an Elastic IP attached to a running
   instance. Oracle does not.
4. **A NAT gateway**, so the database node can reach the internet at all —
   Ubuntu's archive at first boot and every day after, the image registry at
   first boot, and **Session Manager**, which is the shell AWS gives you onto a
   machine with no public address. **Free on Oracle Cloud, $36.50 a month on
   AWS**, and it is the line that surprises people.
   [Below](#the-aws-nat-gateway-and-how-to-not-pay-for-it) is how to not pay it.
5. **Egress.** Free up to a threshold, then per GB. For this application the
   threshold is never approached — see below.
6. **A customer-managed key**, if you ask for one. $1 a month on AWS and $0 on
   Oracle Cloud for a software-protected key. Nothing is billed here unless
   `simple-balance:kmsKeyArn` or `simple-balance:kmsKeyOcid` is set, and unset
   is the default — [below](#customer-managed-keys-and-what-they-cost).
7. **Snapshots**, if you take any. This profile does not: it takes `pg_dump`
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

Both machines, four disks, and on AWS the NAT gateway. The two machines take
different shapes now, because `docs/deployment-sizing.md` sizes them apart:

**Every Oracle figure on this page is list price first and the credited figure
second, in that order, and the same rule governs both tables below.** Oracle's
Always Free allowance — 3,000 OCPU-hours, 18,000 GB-hours of memory and 200 GB
of block storage a month — is applied as a *credit against usage* rather than as
a separate free stack, so a row that overruns it pays only for the overrun. That
distinction is worth four times the money at `medium`, which is why it is stated
here rather than three paragraphs down. Check any of it in Oracle's own
estimator before relying on it: how a partly-free stack prices is Oracle's
arithmetic and not this page's.

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | `t4g.medium` + `t4g.medium`, 90 GiB of disk, NAT — **about $96** | two `VM.Standard.A1.Flex` 2/4 + 100 GB each — about $43, or **$0** against Always Free, exactly at the ceiling |
| `medium` | `t4g.medium` + `m7g.xlarge`, 250 GiB, NAT — **about $204** | 2/4 with 160 GB and 4/16 with 150 GB — about $74, or **about $17** against Always Free |
| `large` | `t4g.large` + `m7g.2xlarge`, 680 GiB, NAT — **about $382** | 2/8 with 390 GB and 8/32 with 350 GB — about $136, or **about $74** against Always Free |

**`medium` and `large` are about 30% cheaper on AWS than they were, and carry
nearly twice the disk at `medium` and nearly three times at `large`**, and none
of it is a discount. The application node used to buy
the same machine as the database node — an `m7g.xlarge` at `medium` — and
`docs/capacity.md` measured it needing half a core and 745 MiB while serving ten
thousand people. It is a `t4g.medium` at two of the three sizes now. The
database node keeps every core it had, because its memory is what turns into
cache, and what the application node gave up paid for disk: `medium` carries
250 GiB where it carried 140, and `large` 680 where it carried 240, which is
what it takes to hold the ledgers those rows claim and fifteen daily dumps of
them.

And the same stacks with `simple-balance:databaseNode: false`, which is one
machine and no NAT gateway — plus whatever the database you bring costs. The
disk is still the application node's, and it still holds the dumps:

| | AWS | Oracle Cloud |
| --- | --- | --- |
| `small` | `t4g.medium` + 40 GiB — **about $31** | `VM.Standard.A1.Flex` 2/4 + 100 GB — about $22, or **$0** against Always Free |
| `medium` | `t4g.medium` + 130 GiB — **about $39** | 2/4 + 160 GB — about $23, or **$0** against Always Free |
| `large` | `t4g.large` + 360 GiB — **about $82** | 2/8 + 390 GB — about $33, or **about $5** against Always Free, all of it disk |

Both tables leave out one line each, because it is too small to move a
figure: where the stack's settings are kept. On AWS that is one Secrets
Manager secret, **$0.40 a month**, plus about four cents for the reads the
machine's five-minute check makes. On Oracle Cloud it is a DEFAULT vault with a
software-protected key and one secret, **$0** against Always Free, which
covers all three.

The AWS figures are us-east-1 on-demand at 730 hours a month: `t4g.medium`
$0.0336 an hour, `t4g.large` $0.0672, `m7g.xlarge` $0.1632, `m7g.2xlarge`
$0.3264; every disk at gp3's $0.08 per GB-month, which is a 20 GiB boot disk on
each machine plus the two data disks; $3.65 for the application node's IPv4
address; and, in the first table, $32.85 for the NAT gateway and $3.65 for the
address it holds. They are Graviton throughout — the images this project
publishes carry `linux/arm64` — and Nitro throughout, which is what encrypts the
hop between an instance and its encrypted volume. The x86 equivalent of each row
is roughly a fifth more for the same work.

**Neither table carries a customer-managed key**, because no stack has one
unless it asks. A stack that sets `simple-balance:kmsKeyArn` adds **$1.00 a
month** to its AWS row, or $3.00 with automatic rotation; one that sets
`simple-balance:kmsKeyOcid` against a software-protected key adds **nothing** to
its Oracle row, and against an HSM-protected key adds whatever Oracle charges
per key version. [Below](#customer-managed-keys-and-what-they-cost) is the whole
of it, and `docs/deployment-profiles.md` §Encryption is what to read before
setting either, because the money is the smallest thing a CMK costs.

The Oracle figures are `VM.Standard.A1.Flex` at $0.01 per OCPU-hour and $0.0015
per GB-hour, and block storage at $0.0255 per GB-month: a 50 GB boot volume plus
the data volume on each machine, which `oci-single` never makes smaller than
OCI's 50 GB minimum, so `small` gets 50 and 50 there rather than the 20 and 30
the sizing table names. **The application node's disk is the one that moves**,
and on Oracle Cloud that is the only disk that moves at all below 50 GB.

### Oracle's Always Free tier, and its two catches

Oracle gives every tenancy 4 Ampere OCPUs, 24 GB of memory, 200 GB of block
storage and 10 TB of egress a month, indefinitely and without a card charge.
OCI's managed database does not fit in it, and neither does a NAT gateway need
to: OCI charges nothing for one.

**The arithmetic at `small` lands on the allowance exactly, and it is worth
doing rather than trusting.** Two `small` machines are 2 OCPUs and 4 GB each:
**4 OCPUs of the 4** and 8 GB of the 24. Storage is a 50 GB boot volume and a
50 GB data volume on each machine, because OCI's minimum raises `small`'s 20 GiB
and 30 GiB data disks alike: **50 + 50 + 50 + 50 = 200 GB of the 200**. Nothing
is left over. So there is no room for a `medium` on either side, no room for a
`databaseSize` above `small`, and no room for a second Simple Balance stack in
the same tenancy.

**`medium` is billed, and the application node is no longer why.** It asks for
2 OCPUs on one machine and 4 on the other — six of the four allowed — so 1,380
of its 4,380 OCPU-hours are billed, at $13.80. Its memory is not: 20 GB across
the two machines is 14,600 GB-hours of the 18,000 allowed, and the allowance is
spent on hours rather than on shapes. Its 310 GB of disk overruns the 200 by
110 GB, at $2.81. That is the **about $17** in the table, against a list price
of $74 — and it is the arithmetic worth doing before dismissing the step up from
`small`. It is also a third less than it was: the application node used to ask
for a second 4 OCPUs and 16 GB it had no use for.

**Where the free tier is worth chasing is `databaseNode: false`.** One machine
at 2 OCPUs and 4 GB is inside the allowance at `small` and at `medium` alike,
and even `large`'s 2 OCPUs and 8 GB is — only its 390 GB of disk is not, and the
190 GB over is about $5 a month. That is the shape for somebody who already
keeps a PostgreSQL.

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
along with the secret, the backups — and the ledger. While
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

**$36.50 a month in us-east-1**: $32.85 for the gateway's own hours at $0.045,
and $3.65 for the Elastic IP it holds. That hour is regional and is the largest
of the per-hour rates this page compares — $0.093 in sa-east-1, where the same
gateway is $71.54 — so every $36.50 below is the US figure and
[the table](#what-ssm-costs-where-you-actually-run-it) has the rest.
Data processing is $0.045 per GB and at this workload is
pennies — the database node fetches roughly 250 to 300 MB at first boot and half
a gigabyte to two gigabytes a month afterward, which is under a dime. So
**99.9% of the line is the hour**, and nothing that only reduces bytes saves
anything. It is 38% of the `small` bill on AWS. Oracle Cloud charges nothing for
its NAT gateway, so all of this is AWS-only.

It exists because the database node has no public address — which is the point
of the profile — and three things still have to reach it:

- **Ubuntu's archive**, at first boot for `docker.io`, `docker-compose-v2` and
  `unattended-upgrades`, and every day after for security updates.
- **The image registry**, once, for `postgres:18`.
- **Session Manager**, continuously. This is the one the old version of this
  page left out, and it is the one that makes "just go without egress" wrong:
  `pulumi stack output databaseShell` is the only shell onto the machine holding
  the ledger, and removing the gateway takes it away unless something is put
  back in its place. The three ways off the gateway below differ mostly in what
  they put back.

`simple-balance:databaseEgress` is the setting. It defaults to `nat`, which is
what every stack built so far has, and a stack that leaves it unset plans no
change at all.

| `databaseEgress` | Per month | What it gives up |
| --- | --- | --- |
| `nat`, the default | **$36.50** in us-east-1, and [regional](#what-ssm-costs-where-you-actually-run-it) | Nothing. This is the supported shape, and the only one with no trade at all |
| `ssm` | **$14.60** in us-east-1, and [regional](#what-ssm-costs-where-you-actually-run-it) | The in-region Ubuntu mirror, and a dependence on Docker Hub's IPv6. It keeps the Session Manager shell and needs no SSH key |
| `ipv6` | **$0** | Those two *and* the Session Manager shell. The database node is reached by SSH from the application node instead, so it requires `simple-balance:sshPublicKey` |
| `databaseNode: false` | **$0**, and no second machine | Somebody else's PostgreSQL, and its own bill |

**`ssm` is `ipv6` plus two interface endpoints, and that is not an
implementation detail — it is the whole reason the option works.** Interface
endpoints reach AWS services. Neither thing this machine must fetch at first
boot is an AWS service: `<region>.ec2.archive.ubuntu.com` is Canonical's own EC2
fleet and Docker Hub's layers are on Cloudflare, so no endpoint of any kind
carries `apt` or `postgres:18`. Endpoints **on their own** would build a machine
that comes up `running`, answers Session Manager, and has no database on it —
`apt-get` times out, `docker.io` never installs, first boot dies before
`docker compose up`, and the application node fails its `simple-balance-waitdb`
five minutes later on the other machine. That is the cruellest shape this
failure could take, because the $14.60 shell is the one part that works. So
`ssm` builds the IPv6 egress-only gateway too, always, as one setting rather
than two that can be set apart; there is no spelling of the stack that asks for
one without the other.

**One thing it checks against the zone you landed in, and when the answer
arrives depends on whether you have landed yet.** An interface endpoint has to
sit in an availability zone that offers the service, and this program names no
zone — it takes whichever one AWS gives the first subnet. So it asks AWS which
zones offer `ssm` and `ssmmessages` and refuses, naming your zone and the ones
that would work. The answer there is another region, or `nat`, or `ipv6`; there
is no zone to move to, because none was chosen.

Switching an existing stack over, which is the ordinary case, that refusal is a
failed `pulumi preview` and nothing is touched: the zone is already in the
stack's state. On a **brand-new** stack it cannot be, because the subnet does
not exist yet and Pulumi will not evaluate a check over a value it does not
have. There the preview is clean and the refusal arrives during `pulumi up`, at
the first endpoint — after the VPC, both subnets, the gateways and the security
groups, and before either machine or either data volume. `pulumi destroy` on an
empty network is cheap, but it is not nothing, and this page would rather say so
than claim a preview it does not always get. Pinning a zone would fix it and
would replace the subnets of every stack that already exists, which is a worse
trade.

What each half does: the egress-only gateway and the Amazon-provided `/56` cost
nothing and carry apt and Docker Hub. The two endpoints cost $14.60 and carry
Session Manager, over IPv4, inside the VPC on the implicit `local` route — which
is why the database subnet having no IPv4 default route does not matter. AWS
puts it plainly: with PrivateLink you need no internet gateway, NAT device or
virtual private gateway.

**Two endpoints, not three, and the number in the table is the real one.**
`com.amazonaws.<region>.ssm` carries the heartbeat and registration — without it
the node never becomes a managed node and `start-session` answers
`TargetNotConnected`. `com.amazonaws.<region>.ssmmessages` carries the session's
data channel. The third one every guide lists, `ec2messages`, is **not needed,
and adding it out of caution would be worse than useless**: from SSM Agent
3.3.40.0 onward Systems Manager uses `ssmmessages` wherever it is available,
regions launched in 2024 or later support only `ssmmessages`, AWS tells you to
remove `ec2messages` permissions in the older ones — and AWS is retiring the
`ec2messages` endpoint itself on 2026-09-30. A third endpoint would make this
$21.90 a month, and the $7.30 would be buying a service being switched off.
`s3` and `ec2` are for agent self-update, Distributor and VSS
snapshots, not for opening a shell — an S3 **gateway** endpoint is free and
worth having for the first of those, but it is not a condition of the shell and
this profile does not build one.

#### What `ssm` costs where you actually run it

**$14.60 is a US number — and so is $36.50.** Both hours are regional, and an
earlier version of this table got only half of that right: it priced the
endpoints region by region and then subtracted each one from the *US* NAT
gateway. That understates the saving everywhere outside the United States and
reverses the answer in sa-east-1, where the gateway is $71.54 rather than
$36.50. Both columns below are from AWS's published price list, retrieved
2026-09-30: two endpoints in the single availability zone this profile uses, at
730 hours, against `NatGateway-Hours` at 730 hours plus the $3.65 for the
gateway's in-use IPv4 address — $0.005 an hour, which is the one rate that is
the same in every region here.

| Region | Endpoint-hour | Two endpoints | NAT-hour | NAT gateway | `ssm` saves |
| --- | --- | --- | --- | --- | --- |
| us-east-1 | $0.010 | **$14.60** | $0.045 | $36.50 | **$21.90** |
| us-west-2 | $0.010 | **$14.60** | $0.045 | $36.50 | **$21.90** |
| eu-west-1 | $0.011 | **$16.06** | $0.048 | $38.69 | **$22.63** |
| ca-central-1 | $0.011 | **$16.06** | $0.050 | $40.15 | **$24.09** |
| eu-central-1 | $0.012 | **$17.52** | $0.052 | $41.61 | **$24.09** |
| ap-south-1 | $0.013 | **$18.98** | $0.056 | $44.53 | **$25.55** |
| ap-southeast-2 | $0.013 | **$18.98** | $0.059 | $46.72 | **$27.74** |
| sa-east-1 | $0.021 | **$30.66** | $0.093 | $71.54 | **$40.88** |

**sa-east-1 is the largest saving this setting offers anywhere**, and it is the
row that used to say the opposite. Both hours roughly double between Virginia
and São Paulo — $0.010 to $0.021, $0.045 to $0.093 — but the gateway hour starts
four and a half times larger, so the same proportional rise moves it $35.04
where the endpoints move $16.06. That is the whole of why the gap widens, and
why the $5.84 this table used to print was São Paulo's endpoints against
Virginia's gateway.

**A region that is not in the table is between these two.** Priced across all
34 commercial regions on the same day, $21.90 is the smallest saving anywhere —
us-east-1, us-east-2, us-west-2 and eu-north-1 — and sa-east-1's $40.88 is the
largest. So the US figure is the floor rather than the headline: wherever you
are, `ssm` saves at least $21.90 a month and possibly twice that. The eight rows
above are the ones an operator is most likely to be reading from; the others sit
inside that range, with ap-east-1 ($30.22) and the Tokyo/Osaka pair ($28.47) the
next largest after São Paulo.

The rows are one per region rather than grouped by endpoint-hour, because
eu-west-1 and ca-central-1 share an endpoint price and differ on the gateway, as
do ap-south-1 and ap-southeast-2. A grouped row would hide exactly the number
being decided on.

Data processing is $0.01 per GB and rounds to nothing here. The agent calls
`UpdateInstanceInformation` every five minutes and otherwise holds an idle
control channel: roughly 8,760 small calls a month across both machines, well
under a gigabyte, so under a cent. Unlike the NAT gateway, where 99.9% of the
line is the hour, here it is 100%.

**What `ssm` gives up.** Two of the three trades `ipv6` makes, and not the
third. It keeps the Session Manager shell and needs no SSH key — which also
sidesteps the two-rebuild replacement described under `ipv6` below, since
nothing has to acquire a `keyName`. It still gives up the in-region Ubuntu
mirror and still rests on Docker Hub's IPv6, for the same reasons and with the
same consequences, because its egress is the same egress-only gateway.

**One trap worth knowing before you set it**, because it can take away a shell
that works today. Private DNS on an interface endpoint overrides
`ssm.<region>.amazonaws.com` for the **whole VPC**, not for the subnet the
endpoint sits in, so the *application* node starts resolving it to the
endpoint's private address too. The endpoint's security group therefore admits
443 from **both** node security groups, not just the database node's. Were it to
admit only one, this setting would silently remove Session Manager from the
machine that was fine.

**What `ipv6` gives up, stated rather than hidden.** An egress-only internet
gateway is the IPv6 analogue of a NAT gateway and carries no hourly and no
per-GB charge, and an Amazon-provided `/56` on the VPC costs nothing either. But
three things are true of it here and each is a real trade:

- **Session Manager stops working on the database node.** The subnet keeps its
  IPv4 range, because the database's certificate names the machine by its
  Amazon-provided internal DNS name, so the node is dual-stack and SSM Agent
  resolves `ssm.<region>.amazonaws.com`, which publishes no IPv6 address. With
  the gateway gone there is nothing for it to reach. The setting therefore
  requires an SSH key and opens 22 on the database node from the application
  node's security group, which is free — and a setting that silently removed the
  only shell to the machine holding the ledger would be worse than the $36.50.

  There is probably a way to have both for nothing, and it is written down here
  rather than offered because it has not been proven. `ssm.<region>.api.aws` and
  `ssmmessages.<region>.api.aws` are the dual-stack spellings of the same two
  services and both answer AAAA — checked in us-east-1 and eu-west-1 — and SSM
  Agent accepts `Ssm.Endpoint` and `Mgs.Endpoint` overrides, so `ipv6` could
  keep Session Manager without the two interface endpoints `ssm` pays $14.60 a
  month for. Two things stop it being shipped: Ubuntu installs the agent as a
  snap, so its configuration is under `/var/snap/amazon-ssm-agent/current/`
  rather than the `/etc/amazon/ssm/` every guide names, and
  `ec2messages.<region>.api.aws` resolves to nothing at all, so a wrong override
  has no fallback. An option whose failure mode is a machine with no shell is
  one to measure on a real instance before offering, not after.
- **The in-region Ubuntu mirror is given up.** The node's sources are rewritten
  to `archive.ubuntu.com` in a cloud-init `bootcmd`, which is the only stage
  earlier than the first `apt-get update`. Slower, and one more hop outside the
  region. **The reason that rewrite was added has since expired, and it is worth
  saying so rather than leaving a stale fact to decide something else wrongly:**
  `<region>.ec2.archive.ubuntu.com` published no AAAA record when this was
  written and now publishes several, in every region checked. The rewrite is
  kept anyway — it is harmless, it is what every stack built so far has, and
  dropping it is a behaviour change that wants proving from inside a VPC rather
  than from a laptop's DNS lookup — but it now buys an out-of-region hop for
  nothing, and removing it is a reasonable thing for a later release to do.
- **It rests on Docker Hub's IPv6.** `registry-1.docker.io` publishes IPv6
  addresses today and Cloudflare, where the layers are, is dual-stack. If either
  stops, the failure is a first boot that hangs at `docker compose up` with
  nothing in the logs about the network.

**Two things that look free and are not the answer**, worth writing down because
they are the first two anyone suggests:

- **An S3 gateway VPC endpoint** really is free, and it does nothing here. It
  diverts traffic bound for S3's own address ranges in this region, and neither
  destination qualifies: Ubuntu's `<region>.ec2.archive.ubuntu.com` is
  Canonical's own EC2 fleet, which replaced the S3-backed mirrors years ago, and
  `security.ubuntu.com` never was S3; Docker Hub's layers are on Cloudflare R2.
  The pattern is real on Amazon Linux, whose repositories genuinely are S3
  buckets. This profile runs Ubuntu on both clouds so that `aws-single` and
  `oci-single` are the same program twice, and changing that to save $32.85
  would cost more than it saves.
- **Interface VPC endpoints instead of the gateway** are $7.30 each per
  availability zone, and they do not replace it. They reach AWS services, and
  the two things this machine must fetch are not AWS services. ECR is two more
  endpoints at $14.60 and still leaves `apt` with nowhere to go — and it would
  mean mirroring `postgres:18` into your own registry, which this program does
  not do. Five endpoints is $36.50 in a US region: the NAT gateway's price
  there, with more parts and less coverage. The coincidence is a US one — five
  endpoints in sa-east-1 are $76.65 against a gateway at $71.54 — and it is the
  shape of the argument rather than the number that carries. **This is the half-truth `databaseEgress: ssm` corrects rather
  than contradicts.** Two endpoints do buy something real, the Session Manager
  shell, and they buy it for $14.60 — but only *beside* the free IPv6 gateway
  that carries apt and the image, never instead of it.

**And one that is free and unsupported.** Making the application node the NAT —
a route from the database subnet to its network interface, `sourceDestCheck`
off, `ip_forward` on and one `MASQUERADE` rule — works, and the programs do not
build it. It makes the machine serving the internet the router for the machine
holding the ledger; it couples the database's ability to patch itself to the
application node being up; and it has a first-boot race Pulumi cannot order
away, because `dependsOn` proves the application instance is running and not
that its cloud-init installed the rule, while the database node's first act is
`apt-get update`.

### Customer-managed keys, and what they cost

Every disk on both clouds is encrypted at rest with the provider's own key
unless you say otherwise, and that costs nothing. A customer-managed key is a
setting — `simple-balance:kmsKeyArn` on AWS, `simple-balance:kmsVaultOcid` and
`simple-balance:kmsKeyOcid` on Oracle Cloud — and it adds a line:

| | Per month |
| --- | --- |
| AWS, one KMS key for all four volumes | **$1.00** |
| AWS, the same with automatic rotation | **$3.00** — the first and second rotation add $1 each, and it is capped there |
| AWS KMS requests | **$0.00** — one per volume created and one per attach, against a free tier of 20,000 a month |
| Oracle Cloud, a `DEFAULT` vault with a software-protected key | **$0.00** |
| Oracle Cloud, an HSM-protected key | billed per key version. Oracle's price list is the place to read the rate; this page does not print one it could not verify |

**One key, not four.** Four keys buy no isolation — one program, one operator,
one blast radius — and cost four times as much.

**Two traps that are money rather than data**, and the data ones are in
`docs/deployment-profiles.md` §Encryption, which is where to read before setting
either key:

- **`protectionMode` on an Oracle key defaults to HSM**, which is the billed
  mode, and Oracle says it cannot be changed after the key is created. A key
  made without `--protection-mode SOFTWARE` is billed for as long as it exists,
  and on a `small` stack that is the first thing to take the Always Free row off
  $0.
- **A `VIRTUAL_PRIVATE` vault is billed by the hour** and includes a thousand
  key versions. That is two orders of magnitude more vault than this profile
  wants; `DEFAULT` is the type to create.

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

- **Stay on `small`.** The sizing document's numbers are not a typo: a million
  transactions is 1.2 GB, and `small`'s database disk holds nine million of
  them. Most deployments that reach for `medium` are reaching for memory they
  are not using.
- **Lower `backupKeep` before buying disk.** It defaults to 14, and fifteen
  dumps are 2.175 times the live ledger, which is why the application node's
  disk is the largest thing on the bill at `medium` and `large`. At 3 it is
  0.58 times, and `small`'s 20 GiB then holds dumps of a ledger nearly four
  times larger — 21 million transactions against 5.6. Copy the dumps off the box, which
  `docs/deployment-sizing.md` tells you to do anyway, and this is free.
- **Raise `databaseSize` before `size`, and know what each buys.**
  `databaseSize` buys the machine that holds the ledger and the memory that
  caches it; `size` buys the machine that holds the dumps. At `size: small` and
  `databaseSize: medium` on AWS the bill is about $197, against $204 for
  `medium` on both — a smaller gap than it used to be, because the row now sizes
  the application node down for you. The catch is the disk: `small`'s 20 GiB
  will not hold fifteen dumps of a ledger a `medium` database can store, so
  lower `backupKeep` in the same breath or raise `size` too.
- **Take the NAT gateway off the bill.** It is $36.50 a month on AWS in a US
  region — more elsewhere, up to $71.54 in sa-east-1 — and 38% of the `small`
  stack, and there are three ways off it.
  `simple-balance:databaseEgress: ssm` is $14.60 in a US region and gives up
  nothing you are likely to notice — it keeps the Session Manager shell and
  needs no SSH key, which makes it the one to reach for first. It saves more the
  further you are from the US, not less.
  `simple-balance:databaseEgress: ipv6` is $0 and costs that shell;
  `simple-balance:databaseNode: false` is $0 and costs you a database to run
  elsewhere.
  [Above](#the-aws-nat-gateway-and-how-to-not-pay-for-it) is the whole
  comparison. Oracle Cloud charges nothing for its NAT gateway and needs none
  of this.
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
| This profile, `small`, on AWS, `databaseEgress: ssm` | $75 | The same without the NAT gateway, with the Session Manager shell kept by two interface endpoints and no SSH key needed. A US region; [more elsewhere](#what-ssm-costs-where-you-actually-run-it) |
| This profile, `small`, on AWS, `databaseEgress: ipv6` | $60 | The same without the NAT gateway either, reached by SSH from the application node rather than by Session Manager |
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
