#!/usr/bin/env node
/**
 * Example: gate an agent loop on a measurement.
 *
 * The usual loop asks the model whether it is done and re-injects "not done,
 * keep going" when it says no. That turns completion into persuasion, and the
 * criteria live in the conversation, where compaction eventually eats them.
 *
 * This reads the criteria from disk, measures the work against them, and
 * stops for three distinct reasons instead of one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const TASKS_FILE = process.env.TASKS_FILE || 'tasks.json';
const RUBRIC = process.env.ASSAY_RUBRIC || 'task-complete';
const STALL_LIMIT = Number(process.env.ASSAY_STALL_LIMIT || 3);

const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
const current = tasks.items.find((t) => !t.passes);

if (!current) {
  process.stdout.write('all items pass\n');
  process.exit(0);
}

// The state is evidence, not narration: what the task asked for, and what happened.
const state = {
  task: current.title,
  acceptance: current.acceptance,
  diff: execFileSync('git', ['diff', '--stat', 'HEAD']).toString().slice(0, 4000),
  tests: readFileSync(process.env.TEST_OUTPUT || '/dev/null', 'utf8').slice(-4000),
};

const run = spawnSync('assay', [RUBRIC, '--json'], {
  input: JSON.stringify(state),
  encoding: 'utf8',
});

if (run.error) {
  process.stderr.write(`assay unavailable: ${run.error.message}\n`);
  process.exit(0); // never let the gate itself block the loop
}

const result = JSON.parse(run.stdout);
const judged = Object.values(result.verdicts).filter((v) => v.status !== 'skipped');
const confidence = Math.min(...judged.map((v) => v.value ?? 0));

if (run.status === 0) {
  current.passes = true;
  current.stalls = 0;
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  process.stdout.write(`"${current.title}" passes\n`);
  process.exit(0);
}

// No progress means the work is not underspecified effort — it is stuck.
const improved = confidence > (current.bestConfidence ?? 0) + 0.02;
current.bestConfidence = Math.max(confidence, current.bestConfidence ?? 0);
current.stalls = improved ? 0 : (current.stalls ?? 0) + 1;
writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

if (current.stalls >= STALL_LIMIT) {
  process.stdout.write(
    `stopping: "${current.title}" failed ${result.failed.join(', ')} ` +
      `${STALL_LIMIT} times without improving. This needs a person.\n`,
  );
  process.exit(0);
}

// Hand back the specific failure, not "keep going".
process.stderr.write(
  `Not done. Failed: ${result.failed.join(', ')}.\n` +
    `Acceptance: ${current.acceptance}\n` +
    `Address only what failed.\n`,
);
process.exit(2);
