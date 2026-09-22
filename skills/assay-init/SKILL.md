---
name: assay-init
description: Set up assay rubrics for the current repository — discover what a term like "testable" means here, find cases whose answer is already known, calibrate the thresholds against them, and write .assay/. Use when the user wants to gate story refinement, agent-loop completion, or review findings on a measurement instead of a model's opinion.
---

# assay-init

Write a calibrated `.assay/` for this repository.

## The command

Resolve the CLI once, so this works whether assay is on PATH or only shipped
with the plugin:

```bash
ASSAY="$(command -v assay || echo "node ${CLAUDE_PLUGIN_ROOT}/bin/assay.mjs")"
```

Every `assay ...` below means `$ASSAY ...`. It needs `AI_GATEWAY_API_KEY` in
the environment; if it is unset, say so and stop rather than reporting a
failure as a result.

The questions are nearly fixed and ship with the tool. Your job is the two
things only someone reading this repository can do:

1. find out what the rubric's terms mean **here**
2. find the cases whose answer is **already known**

A rubric written without step 2 is a guess in JSON. Do not skip it, and do not
write a threshold you did not measure.

## Steps

### 1. Read the repository

Look for the vocabulary and the conventions before writing anything:

- any context or architecture document at the root
- decision records, if the project keeps them
- the test suite: what a test actually looks like here, and what it can assert
- existing plan or backlog files, to see how work is described

Write down the local meaning of each term the rubric leans on. "Testable"
means something different in a repo with browser tests than in one with only
unit tests, and the rubric must say which.

### 2. Pick the rubrics

Run `assay list` to see what is installed. Start with one. Adding three
uncalibrated rubrics is worse than shipping one that works.

### 3. Find the corpus — the step that decides everything

You need cases where you already know the right answer. Look for ground truth
the repository has produced on its own:

- work items that stalled or were reopened, against ones that closed cleanly
- items sent back in review, against items merged first time
- commits that reverted another commit
- anything a human already labelled, sorted, or triaged

Twenty rows with honest labels beat two hundred invented ones. If you cannot
find at least a handful of each outcome, **say so and stop**. Report that the
rubric cannot be calibrated here yet, and leave the thresholds unset.

Write the corpus as JSONL:

```
{"id":"...","label":true,"state":"..."}
{"id":"...","label":false,"state":"..."}
```

`label` is true when the case *should* pass.

### 4. Calibrate

```bash
assay calibrate <rubric> --corpus corpus.jsonl
```

Read the report with the user:

- **separates** — the rubric tells the two populations apart. Take the
  suggested threshold.
- **separates weakly** — usable with a grey band, not for automation.
- **does not separate** — the question is wrong. A threshold will not save it.
  Rewrite the question and calibrate again.

Look at the misses by hand. A false positive usually means the question is
catching something legitimate, which is the same failure as a pattern that
matches a normal case. That is information about the question, not noise.

### 5. Write it

```bash
assay calibrate <rubric> --corpus corpus.jsonl --write
```

This writes `.assay/<rubric>.json` with the measured thresholds and a
`calibration` block recording what it was measured against. Questions that did
not separate are left out on purpose.

Keep the corpus in the repository next to the rubric. A threshold without the
cases that produced it cannot be audited or re-measured later.

## What this skill does not do

It does not run the gate. Running belongs to the CLI and to whatever hook or
pipeline calls it — a conversation can negotiate, and the point of the gate is
that it cannot.
