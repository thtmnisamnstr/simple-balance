# Comments

The one convention in this repository that is genuinely unusual, and the reason
it pays.

**17.9% of the non-blank lines in `src` are comments** — 7,853 of 43,812. That
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
`7,853 of 43,812` against the recount exactly.

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
| Any deliberate sequence | A loop that must not be parallelised says so beside the loop, because the linter would otherwise be right. |
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

## 5. A silenced rule carries its reason at the site

**Binding.** Fourteen sites in `src` disable a rule inline rather than in
config, and they name three rules between them: `react/set-state-in-effect`
twelve times, `jsx-a11y/no-static-element-interactions` twice, and
`jsx-a11y/click-events-have-key-events` once. Every one of the fourteen carries
a paragraph arguing why the rule is wrong about that line:

```
// The handler and the interactive role arrive together, both gated on the
// same `allowNone`, so the element carrying a key handler is always a
// radiogroup. The rule reads the two attributes separately and cannot see
// that they agree.
// oxlint-disable-next-line jsx-a11y/no-static-element-interactions
```

That one is src/client/forms.tsx:497`. `src/client/components.tsx:497`
silences two rules in a single comment and does not borrow this argument: it
makes its own, that a keyboard user's activation of the buttons inside bubbles
to the same handler, so the element is a catcher for its children's events
rather than a mouse-only control. Thirteen of the fourteen paragraphs sit
directly above the disable. The exception is src/client/forms.tsx:1553`, where
the reason is about the whole effect and sits above it, and the disable reaches
only the one line inside that assigns.

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

## 6. Comments and the formatter

**Binding, and this is why the formatter was allowed in.**

oxfmt was measured against this convention before adoption: **0 of the 8,604
comment lines then in the tree had their prose changed.** It re-indents a
comment when the code around it moves and does nothing else. Had it reflowed them, it would not be here — a
formatter that rewrites the reasoning is not worth consistent brace placement.

If the formatter is ever changed, re-run that measurement first. The check is:
strip every comment line, normalise whitespace, compare before and after.

## 7. Prose style

**House**, inherited from [`docs/standards/writing.md`](../writing.md), with two
additions for comments specifically:

- **Full sentences, and British spelling**, matching the product's copy.
- **Say what happened, not what might.** "This used to credit income and the
  budget never moved" beats "this could cause issues". The first is a fact
  somebody can check; the second is a feeling.

## 8. What is not enforced

Every rule in this guide, and no longer the number at the top of it.
`tests/comment-density.test.ts` recounts `src` on every run, fails under a floor
of 14%, and holds the counts this page quotes to that recount exactly. That is a
check against the comments being tidied away, which is a different thing from a
check that they are any good. There is no test for comment quality and there
should not be one — quality measured as density is gamed by exactly the
restatement comments section 2 bans, and the floor is set low enough that nobody
is ever tempted to pad towards it.

The other mechanical check is section 6's: the formatter must not change comment
prose, and that is verified by measurement when the formatter changes rather
than on every run.

| Rule | Why it is only a sentence |
| --- | --- |
| 1 What a comment is for | Judgement, and the judgement is the guide. |
| 2 What a comment must not be | A restatement detector would flag good comments too. |
| 3 Where the density goes | The floor holds the total. Where it lands is distribution, and nothing reads that. |
| 4 Docstrings say what a thing is for | Editorial. |
| 7 Prose style | Editorial. |

**Five `human` rules, and that is every rule here that is not about a tool.**
This is the guide that argues rather than enforces, which is appropriate for the
one convention here that a newcomer is most likely to think is a mistake.
