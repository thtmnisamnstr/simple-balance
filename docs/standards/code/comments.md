# Comments

The one convention in this repository that is genuinely unusual, and the reason
it pays.

**16.8% of the non-blank lines in `src` are comments** — 6,503 of 38,660. That
is far above what most codebases carry and far above what most style guides
recommend. It is deliberate, and this guide exists so that nobody "tidies" it
away and so that the density is spent on the right things.

It was 14.9% when this page was written, which is the reason
`tests/comment-density.test.ts` exists: a percentage quoted in prose goes stale
without anybody noticing, and this one is quoted in `AGENTS.md` too. The test
holds a floor of 14%, because the failure the rule is written against is
somebody tidying the comments away, and it holds the two quotations to within a
point and a half of the truth and to each other. Not to an exact figure: a
number every commit has to update is a number people update without reading.

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

**Binding.** Two lint rules are disabled inline rather than in config, and both
carry a paragraph:

```
// The handler and the interactive role arrive together, both gated on the
// same `allowNone`, so the element carrying a key handler is always a
// radiogroup. The rule reads the two attributes separately and cannot see
// that they agree.
// oxlint-disable-next-line jsx-a11y/no-static-element-interactions
```

(src/client/forms.tsx:467,
and src/client/components.tsx:401.)

A bare disable is a claim that the rule is wrong, made without argument. Rules
turned off across the whole repository carry their reason in
[`index.md`](index.md) instead, where the count of them is visible.

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

Everything in this guide. There is no test for comment quality and there should
not be one — a density check would be gamed by exactly the restatement comments
section 2 bans.

The one mechanical check that exists is section 6's: the formatter must not
change comment prose, and that is verified by measurement when the formatter
changes rather than on every run.

| Rule | Why it is only a sentence |
| --- | --- |
| 1 What a comment is for | Judgement, and the judgement is the guide. |
| 2 What a comment must not be | A restatement detector would flag good comments too. |
| 3 Where the density goes | Distribution, not a threshold. |
| 4 Docstrings say what a thing is for | Editorial. |
| 7 Prose style | Editorial. |

**Five `human` rules, and that is every rule here that is not about a tool.**
This is the guide that argues rather than enforces, which is appropriate for the
one convention here that a newcomer is most likely to think is a mistake.
