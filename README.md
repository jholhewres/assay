# assay

Measure an artifact against a rubric — and calibrate the rubric against cases
whose answer you already know.

```
$ assay story-refinement < story.md

  acceptanceTestable  0.11        FAIL    below 0.8
  startable           0.23        FAIL    below 0.75
  size                2.80        FAIL    above 2.0

  story-refinement: FAIL

$ echo $?
1
```

## Why

Most quality gates around a language model ask the model whether it is happy
with its own work. That makes completion a matter of persuasion, and once the
criteria live only in the conversation, compaction takes them away.

A typed answer gives you a number instead — and a calibrated threshold does not
negotiate. But a rubric written by the person who also wrote the examples only
tests the direction that person already thought of, so this ships the half
nobody builds: **a harness that tells you whether your rubric actually
separates cases you already know the answer to.**

## The model

The default driver calls an **evaluation model** over the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/evaluation):
state goes in, typed answers come out, no text to parse. Every question in a
rubric is answered in one round trip.

Out of the box that is [Jev](https://vercel.com/ai-gateway/models/jev) from
TypeSafe AI (`typesafe-ai/jev`):

| type | returns |
|---|---|
| `boolean` | a probability from 0 to 1 |
| `choice` | one option from a set you name, plus each option's probability |
| `score` | a position on an ordered scale you define |

Measured on a four-question rubric: **432 in / 73 out tokens, 0.65–0.78s** per
call, billed per token through the Gateway. Zero-data-retention and no-training
are available per request. Nothing here depends on it — see
[Providers](#providers).

## Install

```
/plugin marketplace add jholhewres/assay
/plugin install assay@assay
```

Or standalone:

```bash
git clone https://github.com/jholhewres/assay
ln -s "$PWD/assay/bin/assay.mjs" ~/.local/bin/assay
assay init                      # bundled rubrics into ~/.assay
```

Either way, `export AI_GATEWAY_API_KEY=...`. Node 20+, no dependencies.

## Use

State comes from stdin — a file is never required.

```bash
assay story-refinement < story.md
jira issue view ABC-123 --plain | assay story-refinement
assay story-refinement --batch backlog.jsonl     # or - for stdin
```

| exit | meaning |
|------|---------|
| `0` | every question passed |
| `1` | at least one question failed |
| `2` | needs a human, or the rubric was never calibrated |

```
  id      acceptanceTestable  startable   size        verdict
  ------------------------------------------------------------
  S-001   0.94 +              0.88 +      1.20 +      PASS
  S-002   0.31 x              0.79 +      1.80 +      FAIL

  26 evaluated · 7 failed · 2 need review
```

The 19 that passed never reach a language model. That is the saving — not the
price of the evaluation call.

## Calibrate

Feed it cases you already know the answer to. `label` is `true` when the case
*should* pass:

```json
{"id":"S-001","label":true,"state":"..."}
{"id":"S-002","label":false,"state":"..."}
{"id":"S-003","labels":{"acceptanceTestable":false},"state":"..."}
```

You probably already have this: items that stalled versus ones that closed
cleanly, changes sent back in review versus merged first time, commits that
reverted another commit. Anything a person already sorted is a label. Twenty
honest rows beat two hundred invented ones.

```
$ assay calibrate story-refinement --corpus corpus.jsonl

  acceptanceTestable
    auc 0.94  separates  (18 pass / 8 fail)
    suggested min 0.71  accuracy 92%  precision 94%  recall 94%
    misses: S-014(0.68, wanted pass), S-022(0.77, wanted fail)

  singlePurpose
    auc 0.58  does not separate  (18 pass / 8 fail)
```

| verdict | what to do |
|---|---|
| `separates` (auc ≥ 0.85) | take the suggested threshold |
| `separates weakly` (≥ 0.7) | keep a grey band, do not automate |
| `does not separate` | the question is wrong — no threshold saves it |

`--write` stores the measured thresholds and leaves out every question that is
not usable — including any with fewer than **3 examples on either side**, where
the curve describes the sample rather than the question. It **refuses to write
at all if any row failed to evaluate**: the rows that fail are not a random
sample, and the survivors can be all of one class. Transient gateway errors
(429, 5xx) are retried with backoff before a row counts as failed.

Keep the corpus beside the rubric: a threshold without the cases that produced
it cannot be audited.

## Rubrics

Questions plus thresholds. Three ship with the tool: `story-refinement`,
`task-complete`, `code-review`.

```json
{
  "questions": {
    "size": {
      "type": "score",
      "instructions": "How much work is this?",
      "criteria": ["trivial", "about a day", "a few days", "more than one iteration"]
    }
  },
  "thresholds": { "size": { "max": 2.0, "grey": 2.5 } }
}
```

`grey` is the far edge of the band that goes to a person instead of failing.

Resolution walks up from the working directory, so one `.assay/` above a group
of repositories serves all of them, and local wins key by key:

```
~/.assay/story-refinement.json      the questions
<any ancestor>/.assay/…             the thresholds, and what the terms mean here
```

*The question travels, the number does not.* What counts as testable differs
per repository. Write the local one first.

## Providers

A provider is anything that returns a number per question:

```js
register({
  id: 'mine',
  async evaluate({ state, questions }) {
    return { answers: { someQuestion: { type: 'boolean', probability: 0.8 } } };
  },
});
```

Set `"provider": "mine"` in the rubric. The harness is the durable part; the
model behind it is a detail.

## Gating an agent loop

`examples/stop-hook.mjs` reads the criteria from disk, measures the work, and
stops for three distinct reasons:

```
pass            → mark it done
fail, improving → hand back the failed question, not "keep going"
fail, flat 3x   → stop and ask a person
```

The third is the one loops usually lack.

## Claude Code skill

`skills/assay-init/SKILL.md` sets up `.assay/` for a repository: read the
conventions, find the ground truth the repo already produced, calibrate against
it, write the file. Installing the plugin registers it.

It refuses to write a threshold it could not measure. That refusal is the
feature.

## Caveats

- Uncalibrated rubrics exit `2` and warn on every run, by design.
- Published guidance for these models is in English. Evaluating in another
  language worked in testing — calibrate in that language before relying on it.
- Your state is billed per token; a diff plus test output is not a three-line
  example.
- One evaluation model is a single point of failure. Providers are swappable.

## License

MIT
