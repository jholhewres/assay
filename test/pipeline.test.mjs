import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../src/providers/index.mjs';
import { assess, PASS, FAIL } from '../src/evaluate.mjs';
import { calibrate } from '../src/calibrate.mjs';

// A stub that scores on the presence of the word "Check:" — enough to exercise
// the whole pipeline without a network call.
register({
  id: 'stub',
  async evaluate({ state }) {
    const text = typeof state === 'string' ? state : JSON.stringify(state);
    const strong = /check:/i.test(text);
    return {
      answers: {
        acceptanceTestable: { type: 'boolean', probability: strong ? 0.95 : 0.15 },
        size: { type: 'score', score: strong ? 1.2 : 2.9 },
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  },
});

const rubric = {
  name: 'stub-rubric',
  provider: 'stub',
  questions: {
    acceptanceTestable: { type: 'boolean', instructions: 'testable?' },
    size: { type: 'score', instructions: 'effort', criteria: ['small', 'medium', 'large'] },
  },
  thresholds: {
    acceptanceTestable: { min: 0.8, grey: 0.6 },
    size: { max: 2.0, grey: 2.5 },
  },
};

test('a good artifact passes every question', async () => {
  const result = await assess(rubric, 'Export CSV. Check: expect 4 rows.');
  assert.equal(result.status, PASS);
  assert.deepEqual(result.failed, []);
  assert.equal(result.calibrated, false);
});

test('a vague artifact fails and names which questions', async () => {
  const result = await assess(rubric, 'Make reports better.');
  assert.equal(result.status, FAIL);
  assert.deepEqual(result.failed.sort(), ['acceptanceTestable', 'size']);
});

test('calibration reports separation and a usable threshold', async () => {
  const corpus = [
    { id: 'a', label: true, state: 'Check: asserts something' },
    { id: 'b', label: true, state: 'Check: asserts another thing' },
    { id: 'c', label: true, state: 'Check: asserts a third thing' },
    { id: 'd', label: false, state: 'make it nicer' },
    { id: 'e', label: false, state: 'improve things' },
    { id: 'f', label: false, state: 'should work correctly' },
  ];
  const report = await calibrate(rubric, corpus, { concurrency: 2 });

  assert.equal(report.evaluated, 6);
  assert.equal(report.complete, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.perQuestion.acceptanceTestable.auc, 1);
  assert.equal(report.perQuestion.acceptanceTestable.verdict, 'separates');
  assert.equal(report.perQuestion.acceptanceTestable.suggested.min, 0.95);
  assert.equal(report.perQuestion.acceptanceTestable.misses.length, 0);

  // A score question is inverted: passing cases sit BELOW the threshold.
  assert.equal(report.perQuestion.size.verdict, 'separates');
  assert.equal(report.perQuestion.size.suggested.max, 1.2);
});

test('one negative example is not evidence, however good the auc looks', async () => {
  // The reported failure: 12 rows measured, only 1 on the failing side.
  const corpus = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, label: true, state: 'Check: x' })),
    { id: 'n0', label: false, state: 'vague' },
  ];
  const report = await calibrate(rubric, corpus);
  const q = report.perQuestion.acceptanceTestable;
  assert.equal(q.negatives, 1);
  assert.equal(q.usable, false);
  assert.match(q.verdict, /too few examples/);
});

test('a run with failed rows is marked incomplete', async () => {
  register({
    id: 'flaky',
    async evaluate({ state }) {
      if (state === 'boom') throw new Error('gateway 429: rate limited');
      return { answers: { acceptanceTestable: { type: 'boolean', probability: 0.9 } } };
    },
  });
  const report = await calibrate({ ...rubric, provider: 'flaky' }, [
    { id: 'a', label: true, state: 'ok' },
    { id: 'b', label: false, state: 'boom' },
  ]);
  assert.equal(report.complete, false);
  assert.equal(report.errors.length, 1);
});

test('an unlabelled row is skipped rather than guessed at', async () => {
  const report = await calibrate(rubric, [
    { id: 'a', label: true, state: 'Check: x' },
    { id: 'b', state: 'no label here' },
    { id: 'c', label: false, state: 'vague' },
  ]);
  assert.equal(report.perQuestion.acceptanceTestable.n, 2);
});

test('a provider failure is reported, not swallowed', async () => {
  register({ id: 'broken', async evaluate() { throw new Error('gateway 500'); } });
  const report = await calibrate({ ...rubric, provider: 'broken' }, [{ id: 'a', label: true, state: 'x' }]);
  assert.equal(report.evaluated, 0);
  assert.equal(report.errors[0].error, 'gateway 500');
});
