# Comments

The one convention in this repository that is genuinely unusual, and the reason
it pays.

**26.5% of the non-blank lines in `src` are comments** — 16,668 of 62,807. That
is far above what most codebases carry and far above what most style guides
recommend. It is deliberate, and this guide exists so that nobody "tidies" it
away and so that the density is spent on the right things.

It was 14.9% when this page was written, which is the reason
`tests/comment-density.test.ts` exists: a percentage quoted in prose goes stale
without anybody noticing, and this one is quoted in `AGENTS.md` too. The test
holds a floor of 14%, because the failure the rule is written against is
somebody tidying the comments away, and it holds the two quotations to within a
point and a half of the truth and to each other. The percentage is deliberately
not held to an exact figure: a number every commit has to update is a number
people update without reading. The pair of counts beside it is, because a band
wide enough to survive a normal week's edits is wide enough to hide three
hundred lines, and the counts are what somebody would recompute to check the
percentage anyway.

*Checked by:* `tests/comment-density.test.ts`, which recounts `src`, fails under
the floor, refuses two documents that quote different numbers, and compares
the pair beside the percentage against the recount exactly.

## 1. What a comment is for here

**House, and the whole point.**

A comment explains **why**, and specifically why the obvious alternative is
wrong. The code says what it does. A comment that repeats that is noise; a
comment that says what was tried, what broke, and what the failure looked like
is the most valuable line in the file.

The test for whether a comment should exist: **if someone deleted this line and
wrote the obvious thing instead, would a test catch it?** If yes, no comment
needed — the test is the explanation. If no, the comment is the only thing
standing between the next reader and reintroducing the bug.

Example, from the category resolver:

> Widening to `both` was right while an entry could only ever name a category of
> its own direction […] It stopped being right when a category running against
> the direction became a refund, and it stopped quietly. Widening destroys the
> very signal that makes an entry a refund, and it does it permanently.

Nothing in the code says that. The code just does not widen. A reader who does
not know why will eventually decide that not widening is an oversight.

## 2. What a comment must not be

**House.**

- **Not a restatement.** `// increment the counter` above `counter += 1`.
- **Not a changelog.** "Changed 2026-03 to fix SB-014." Git holds that. What
  belongs is the *reasoning*, which git holds badly — a commit message is read
  once and a comment is read every time.
- **Not an apology.** "This is a bit hacky." Say what forced it, or fix it.
- **Not a TODO with no owner and no condition.** A TODO that describes a
  decision nobody has made is a comment; a TODO that describes work nobody has
  scheduled is litter.

## 3. Where the density goes

**House.** The distribution matters more than the number. Comments concentrate
where the code is counter-intuitive and thin out where it is ordinary:

| Where | Why |
| --- | --- |
| Anywhere money changes form | Because the wrong thing looks right. |
| Any deliberate sequence | A loop that must not be parallelized says so beside the loop, because the linter would otherwise be right. |
| Any place a rule reverses | The refund rule inverts what a deposit normally does. Every site that participates says so. |
| Any workaround for a tool | `unstubGlobals` in `vitest.config.ts` carries a paragraph on why `restoreAllMocks` is not enough. |
| Any exception to a lint rule | See 5. |

Ordinary CRUD carries almost none, and should not.

## 4. A docstring says what the thing is for

**House.** Exported functions and components carry a `/** … */` that answers
"why does this exist", not "what are its arguments" — the types say that.

The best ones name the alternative they exist to prevent:

> Naming a category rather than creating one first. There is no button here.
> What the person typed travels with the transaction and the server settles it
> on save.

That docstring stops the next person adding an "Add category" button beside the
field, which is the obvious thing and the wrong thing.

**A docstring sits directly on what it describes.** An editor shows a
declaration the docblock immediately above it, so a declaration slid in between
an existing docblock and its code takes that docblock's argument and leaves the
old code with none. Twenty-six had been: `currentBalance`'s explanation hovered
over `userAccountById`, and two docblocks stacked on `fillGroupRows` disagreed
about which function summed a group's limit. A file's own header is the one
docblock a declaration's may follow straight on.

*Checked by:* `tests/docblocks-attached.test.ts`, which refuses a docblock
followed by another docblock, or by a blank line, outside a file's header —
both leave the editor showing nothing on the code beneath.

## 5. A silenced rule carries its reason at the site

**Binding.** Fourteen sites in `src` disable a rule inline rather than in
config, and they name three rules between them: `react/set-state-in-effect`
twelve times, `jsx-a11y/no-static-element-interactions` twice, and
`jsx-a11y/click-events-have-key-events` once. Every one of the fourteen carries
a paragraph arguing why the rule is wrong about that line:

```ts
// The handler and the interactive role arrive together, both gated on the
// same `allowNone`, so the element carrying a key handler is always a
// radiogroup. The rule reads the two attributes separately and cannot see
// that they agree.
// oxlint-disable-next-line jsx-a11y/no-static-element-interactions
```

That one is `src/client/forms.tsx:575`. `src/client/components.tsx:952`
silences two rules in a single comment and does not borrow this argument: it
makes its own, that a keyboard user's activation of the buttons inside bubbles
to the same handler, so the element is a catcher for its children's events
rather than a mouse-only control. Thirteen of the fourteen paragraphs sit
directly above the disable. The exception is `src/client/forms.tsx:1793`, where
the reason is about the whole effect and sits above it, and the disable reaches
only the first of the two lines inside that assign. The second lints clean
anyway — the rule reports once per effect, on the first setter it sees — which
is worth knowing before reading the lone disable as full coverage: strip it and
the effect reports one line, never two.

A bare disable is a claim that the rule is wrong, made without argument. Rules
turned off across the whole repository carry their reason in
[`index.md`](index.md) instead, where the count of them is visible.

Those counts are of the day this was written and nothing holds them there;
`grep -rn "oxlint-disable" src` recounts them. It said two when this page was
written, both of them `jsx-a11y`. The twelve that arrived after it are what
denying `react/set-state-in-effect` cost: taking it off its budget left every
surviving site to argue for itself, which is the point of
[`client.md`](client.md) §1.3 and the reason none of them could be a bulk fix.
So a count going up is not the failure. A count going up faster than the
paragraphs is.

**Placement note.** An `oxlint-disable-next-line` has to be on the line directly
above the element the rule reports. Inside a JSX attribute list it targets the
attribute and does nothing; at the top of a `return (` it works, and for a JSX
child it must be the `{/* … */}` form.

*Checked by:* `tests/lint-config-documented.test.ts`, which walks up from every
`oxlint-disable` in `src` and requires the run of comment lines directly above it
to carry an argument — two words, so a URL or the rule name repeated back is not
mistaken for one. Contiguous rather than nearby: a check that accepted any
comment within a dozen lines passed on a bare disable in a file commented as
densely as these, which is every file here. It allows the two shapes above — a
JSX comment whose last line ends in `*/}`, and the one disable whose paragraph
sits above the `useEffect(` that opens the block — and nothing else. The count is
deliberately not pinned: this section says a rising count is not the failure, and
a count rising faster than the paragraphs is what this refuses.

## 6. Comments and the formatter

**Binding, and this is why the formatter was allowed in.**

oxfmt was measured against this convention before adoption: **0 of the 8,604
comment lines then in the tree had their prose changed.** It re-indents a
comment when the code around it moves and does nothing else. Had it reflowed them, it would not be here — a
formatter that rewrites the reasoning is not worth consistent brace placement.

If the formatter is ever changed, re-run that measurement first. The check is:
strip every comment line, normalize whitespace, compare before and after.

## 7. Prose style

**House**, inherited from [`docs/standards/writing.md`](../writing.md), with two
additions for comments specifically:

- **Full sentences, and American spelling**, matching the product's copy.
  `docs/standards/common.md` §Naming owns that rule; this is where it lands.
- **Say what happened, not what might.** "This used to credit income and the
  budget never moved" beats "this could cause issues". The first is a fact
  somebody can check; the second is a feeling.

*Checked by:* `tests/american-wording.test.ts`, for the spelling half — the half
a machine can have. It reads each file as written rather than as code, so a
comment is in scope beside the string under it, and it refuses the British
idioms a word map cannot see. `tests/mcp-measurements.test.ts` holds the same
spelling on the agent surface. The second bullet has nothing behind it and
cannot: "this could cause issues" is a well-formed American sentence, and what
is wrong with it is that it says nothing. Where that scan stops, and what is
outside it, is `docs/standards/common.md` §Naming's own business and is recorded
there — section 8 below is the same boundary seen from this side.

## 8. The convention covers the deployment code, and the floor does not

**House.** Every mechanism named above stops at `src`, and `src` stopped being
all the first-party TypeScript in this tree.

The deployment profiles are Pulumi programs. This release added seven files of
them — `deploy/pulumi/aws-single/`, `deploy/pulumi/oci-single/`, and the
`deploy/pulumi/single-common/` the two share — and nearly five thousand
non-blank lines. They are written to this convention and then some. Counted at
`cb67604`, the ten first-party programs under `deploy/pulumi` carry 3,061
comment lines across 6,407 non-blank ones, **47.8%**, which is nearly twice the
figure at the top of this page; `deploy/pulumi/aws-single/platform.ts` alone
reads 68.2%. Those are a measurement rather than a floor, counted the way
`docs/standards/common.md` §Naming counts its own backlog, and nothing holds
them.

Nothing above reaches them either. The density measurement walks one directory
(`tests/comment-density.test.ts:30`), the silenced-rule check globs one
(`tests/lint-config-documented.test.ts:72`), the formatter is handed three paths
(`package.json:28`), and the root compiler's include list names neither
(`tsconfig.json:27-35`) — `deploy/pulumi` is typechecked by a configuration of
its own, in CI.

**The practical hole is in rule 5, which is Binding.** `npm run lint` is a bare
`oxlint` (`package.json:26`), so it walks the whole tree and a rule silenced
under `deploy/` is a rule really silenced. The check that demands the paragraph
reads `src/**` alone, so a bare `oxlint-disable-next-line` there is a claim that
the rule is wrong, made without argument, and nothing anywhere would say so.
There are none today, which is the whole reason to close it now rather than
later: a check that arrives at zero stays at zero. One that arrives after the
population does not — which is what became of the spelling half of rule 7, whose
scan stops at `src` for the same reason, and where
`docs/standards/common.md` §Naming now records a backlog instead of a rule.

**Widening the floor to the whole repository is the obvious alternative, and it
is wrong.** The three populations do not measure alike — at `cb67604`, `deploy`
reads 47.8% and `tests` reads 20.1%, on either side of the application's — and a
floor is one number over whatever it is handed. Keep 14% and it stops defending
the application outright: `tests` is larger than `src`, so `src` could lose
*every comment in it* and the union would still clear the floor. Raise it until
it would mean something for `src` — anywhere near the figure at the top of this
page — and the union fails on the day it is written, because it reads 23.4% and
what holds it there is `tests`, where a table of cases is its own explanation
and a comment on every row is the restatement section 2 bans. Scope and floor
are different questions. This rule answers the first:
the convention, and rule 5's paragraph in particular, applies wherever this
repository's own TypeScript is. The floor stays on `src`, which is the code the
rule about tidying was written against.

*Checked by:* `tests/comments-guide.test.ts`, which discovers the deployment
TypeScript with `repoFiles` rather than listing it — a list is a claim about
what exists, made once — and requires every `oxlint-disable` under `deploy/` to
carry an argument above it, on the terms rule 5's own check applies to `src`. It
holds the premise too, because the rule rests on it: that `npm run lint` is
given no paths and the lint config excludes no part of `deploy`, so the disable
it is looking for would be silencing something real. The population is zero, so
it also runs the predicate over a bare disable and an argued one — a walk that
found nothing would otherwise pass in silence. It recomputes the counterfactual
in the paragraph above and holds no density figure of its own, because this rule
is that the floor does not go there.

## 9. What is not enforced

Five of the eight rules here, and no longer the number at the top of the page.
`tests/comment-density.test.ts` recounts `src` on every run, fails under a floor
of 14%, and holds the counts this page quotes to that recount exactly. That is a
check against the comments being tidied away, which is a different thing from a
check that they are any good. There is no test for comment quality and there
should not be one — quality measured as density is gamed by exactly the
restatement comments section 2 bans, and the floor is set low enough that nobody
is ever tempted to pad towards it.

Three rules name a mechanism of their own, and each names it at the rule rather
than here: 5, the spelling half of 7, and 8. Section 6's is mechanical and still
in the table below, because it is verified by measurement when the formatter
changes rather than on every run.

| Rule | Why it is only a sentence |
| --- | --- |
| 1 What a comment is for | Judgement, and the judgement is the guide. |
| 2 What a comment must not be | A restatement detector would flag good comments too. |
| 3 Where the density goes | The floor holds the total. Where it lands is distribution, and nothing reads that. |
| 4 Docstrings say what a thing is for | Editorial. |
| 6 Comments and the formatter | The measurement is run when the formatter changes rather than on every run, because it compares the tree against itself before and after a tool this repository is not currently changing. |

**Five `human` rules**, which is this guide's whole share of the set
[`index.md`](index.md) counts. The count came down because rule 7 turned out to
have a mechanism, not because a rule was dropped — and it had had one since
`ca11350`, on this branch, which is the shape worth recognizing: a rule's text
and its new test went in together and the row in this table was left saying
"Editorial". A half-done edit does not look like a defect from either end. It
looks like two guides one link apart giving opposite answers about the same
rule, which is what anybody reading them found.

The sentence that stood here called these every rule not about a tool. That was
never true, and the table it sat under already said so: rule 6 is about a tool
by its own heading and is in the table, while rule 5 is about a tool and is not.
What decides is whether the failure leaves something a program can find. A bare
disable does. A restatement does not, and nothing about tools changes that. This
is still the guide that argues rather than enforces, which is appropriate for
the one convention here that a newcomer is most likely to think is a mistake.
