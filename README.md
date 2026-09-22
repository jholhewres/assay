# assay

Measure an artifact against a rubric — and calibrate the rubric against cases
whose answer you already know.

```
$ assay story-refinement < story.md

  acceptanceTestable  0.11        FAIL    below 0.8
  startable           0.23        FAIL    below 0.75
  singlePurpose       0.64        REVIEW  no threshold set
  size                2.80        FAIL    above 2.0

  story-refinement: FAIL
  failed: acceptanceTestable, startable, size

$ echo $?
1
```

## Why

Most quality gates around a language model ask the model whether it is happy
with its own work. That makes completion a matter of persuasion. Loop long
enough and the answer drifts, because nothing in the loop is measuring
anything — and once the criteria live only in the conversation, compaction
eventually takes them away.

An evaluation model answers a *typed* question instead: a probability, a named
choice, a score on a scale you defined. That gives you a number. A number can
carry a threshold, a threshold can be calibrated, and a calibrated threshold
is a gate that does not negotiate.

The catch is that a rubric written by the person who also wrote the examples
only ever tests the direction that person already thought of. It looks right
and fails in production. So this tool ships the boring half nobody builds:
**a harness that takes your rubric and cases you already know the answer to,
and tells you whether the rubric actually separates them.**

## Install

```bash
npm install -g assay-cli
assay init                 # copies the bundled rubrics into ~/.assay
export AI_GATEWAY_API_KEY=...
```

Node 20+. The default driver calls an evaluation model through the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/evaluation);
see [Providers](#providers) to point it somewhere else.

## Use

### Judge one thing

```bash
assay story-refinement < story.md
assay code-review --json < finding.json
```

Exit codes, so it works in a pipeline without anyone parsing JSON:

| code | meaning |
|------|---------|
| `0` | every question passed |
| `1` | at least one question failed |
| `2` | needs a human, or the rubric was never calibrated |

### Judge a batch

```bash
$ assay story-refinement --batch backlog.jsonl

  id      acceptanceTestable  startable   size        verdict
  ------------------------------------------------------------
  S-001   0.94 +              0.88 +      1.20 +      PASS
  S-002   0.31 x              0.79 +      1.80 +      FAIL
  S-007   0.11 x              0.23 x      2.80 x      FAIL

  26 evaluated · 7 failed · 2 need review
```

The 19 that passed never reach a language model. That is where the saving is —
not in the price of the evaluation call.

### Calibrate — the part that matters

```bash
$ assay calibrate story-refinement --corpus corpus.jsonl

  rubric: story-refinement
  corpus: 26/26 evaluated

  acceptanceTestable
    auc 0.94  separates  (18 pass / 8 fail)
    suggested min 0.71  accuracy 92%  precision 94%  recall 94%
    misses: S-014(0.68, wanted pass), S-022(0.77, wanted fail)

  singlePurpose
    auc 0.58  does not separate  (18 pass / 8 fail)
    suggested min 0.5  accuracy 61%  precision 72%  recall 72%
```

`does not separate` means the question is wrong. No threshold rescues a
question that cannot tell the two populations apart — rewrite it and measure
again.

```bash
assay calibrate story-refinement --corpus corpus.jsonl --write
```

Writes `.assay/story-refinement.json` with the measured thresholds and a
record of what they were measured against. Questions that did not separate are
deliberately left uncalibrated, and the CLI keeps warning about them.

### The corpus

One JSON object per line. `label` is `true` when the case *should* pass.

```json
{"id":"S-001","label":true,"state":"..."}
{"id":"S-002","label":false,"state":"..."}
{"id":"S-003","labels":{"acceptanceTestable":false,"startable":true},"state":"..."}
```

You almost certainly already have this and have not noticed. Work items that
stalled versus ones that closed cleanly. Changes sent back in review versus
merged first time. Commits that reverted another commit. Anything a person
already sorted is a label.

Twenty honest rows beat two hundred invented ones — invented rows only encode
the direction you already thought of, which is the failure this harness exists
to catch.

## Rubrics

A rubric is questions plus thresholds. Three ship with the tool:

| rubric | judges |
|---|---|
| `story-refinement` | a work item, before it enters a plan |
| `task-complete` | whether a unit of work is actually finished |
| `code-review` | a single review finding, once it exists |

Questions come in three shapes: `boolean` returns a probability, `choice`
picks one option from a set you name, and `score` rates against an ordered
scale you define.

```json
{
  "questions": {
    "acceptanceTestable": {
      "type": "boolean",
      "instructions": "Does the acceptance criteria describe a check that fails before the change and passes after it?"
    },
    "size": {
      "type": "score",
      "instructions": "How much work is this?",
      "criteria": ["trivial", "about a day", "a few days", "more than one iteration"]
    }
  },
  "thresholds": {
    "acceptanceTestable": { "min": 0.8, "grey": 0.6 },
    "size": { "max": 2.0, "grey": 2.5 }
  }
}
```

`grey` is the far edge of the band that goes to a person instead of failing —
three outcomes, not two.

### Global and local

```
~/.assay/story-refinement.json     the questions
./.assay/story-refinement.json     the thresholds, and what the terms mean here
```

Local wins key by key. The split is deliberate: *the question travels, the
number does not*. "Is the acceptance criteria testable?" is the same question
everywhere, but what counts as testable differs per repository, and a
threshold you accept on a personal project is not one you accept on code with
a reviewer and a customer behind it.

Write the local one first. A question promoted to global before surviving two
different repositories is a guess wearing a uniform.

## Providers

The default driver is an evaluation model on the Vercel AI Gateway. Nothing
above depends on it — a provider is anything that returns a number per
question:

```js
import { register } from 'assay-cli/src/providers/index.mjs';

register({
  id: 'mine',
  async evaluate({ state, questions }) {
    return { answers: { someQuestion: { type: 'boolean', probability: 0.8 } } };
  },
});
```

Set `"provider": "mine"` in the rubric. The calibration harness is the durable
part; the model behind it is a detail.

## Gating an agent loop

`examples/stop-hook.mjs` shows the shape: read the criteria from disk, measure
the work, and stop for three distinct reasons.

```
pass            → mark it done
fail, improving → hand back the failed question, not "keep going"
fail, flat 3x   → stop and ask a person
```

The third case is the one loops usually lack. Work that does not improve
across attempts is not underspecified effort — it is stuck, and more
iterations will not find that out.

## Claude Code skill

`skill/SKILL.md` sets up `.assay/` for a repository: read the conventions,
find the ground truth the repo already produced, calibrate against it, write
the file. Copy it into `~/.claude/skills/assay-init/`.

It will refuse to write thresholds it could not measure. That refusal is the
feature.

## Caveats

- **Calibrate before you trust it.** Uncalibrated rubrics exit `2` and warn on
  every run, on purpose.
- **Published rubric guidance is English.** If you evaluate in another
  language, calibrate in that language before relying on the numbers.
- **The state is billed per token.** A diff plus test output is not the
  three-line example in a vendor's documentation — measure your real cost.
- **A single evaluation model is a single point of failure.** Providers are
  swappable for exactly this reason.

## License

MIT
