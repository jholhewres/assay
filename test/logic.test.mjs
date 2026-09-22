import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, bestThreshold, separationVerdict } from '../src/calibrate.mjs';
import { verdictFor, rollUp, scalarOf, exitCodeFor, PASS, FAIL, REVIEW } from '../src/evaluate.mjs';

test('auc is 1 when the populations are cleanly split', () => {
  assert.equal(auc([0.9, 0.95, 0.8], [0.1, 0.2, 0.3]), 1);
});

test('auc is 0.5 when every value is identical', () => {
  assert.equal(auc([0.5, 0.5], [0.5, 0.5]), 0.5);
});

test('auc is null without both populations', () => {
  assert.equal(auc([0.9], []), null);
});

test('auc handles ties by averaging ranks', () => {
  // Three clear wins plus one tie, which counts as half: 3.5 of 4 pairs.
  assert.equal(auc([0.8, 0.5], [0.5, 0.1]), 0.875);
});

test('separation verdict names the weak middle', () => {
  assert.equal(separationVerdict(0.95), 'separates');
  assert.equal(separationVerdict(0.75), 'separates weakly');
  assert.equal(separationVerdict(0.5), 'does not separate');
  assert.equal(separationVerdict(null), 'needs both passing and failing examples');
});

test('bestThreshold finds the split that maximises separation', () => {
  const rows = [
    { id: 'a', value: 0.9, label: true },
    { id: 'b', value: 0.85, label: true },
    { id: 'c', value: 0.2, label: false },
    { id: 'd', value: 0.1, label: false },
  ];
  const best = bestThreshold(rows, true);
  assert.equal(best.threshold, 0.85);
  assert.equal(best.tp, 2);
  assert.equal(best.fp, 0);
  assert.equal(best.accuracy, 1);
});

test('bestThreshold respects a rubric where lower is better', () => {
  const rows = [
    { id: 'a', value: 1.0, label: true },
    { id: 'b', value: 1.5, label: true },
    { id: 'c', value: 3.0, label: false },
  ];
  const best = bestThreshold(rows, false);
  assert.equal(best.threshold, 1.5);
  assert.equal(best.fp, 0);
});

test('scalarOf reads every answer shape', () => {
  assert.equal(scalarOf({ type: 'boolean', probability: 0.9 }), 0.9);
  assert.equal(scalarOf({ type: 'score', score: 2.4 }), 2.4);
  assert.equal(scalarOf({ type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 } }), 0.9);
  assert.equal(scalarOf(undefined), null);
});

test('a min threshold passes above, fails below, and reviews inside the grey band', () => {
  const t = { min: 0.8, grey: 0.6 };
  assert.equal(verdictFor({ probability: 0.81 }, t).status, PASS);
  assert.equal(verdictFor({ probability: 0.7 }, t).status, REVIEW);
  assert.equal(verdictFor({ probability: 0.4 }, t).status, FAIL);
});

test('a max threshold inverts the comparison', () => {
  const t = { max: 2.0, grey: 2.5 };
  assert.equal(verdictFor({ score: 1.2 }, t).status, PASS);
  assert.equal(verdictFor({ score: 2.3 }, t).status, REVIEW);
  assert.equal(verdictFor({ score: 3.1 }, t).status, FAIL);
});

test('a missing threshold asks for a human rather than guessing', () => {
  assert.equal(verdictFor({ probability: 0.99 }, undefined).status, REVIEW);
});

test('the worst verdict decides the whole', () => {
  assert.equal(rollUp({ a: { status: PASS }, b: { status: REVIEW } }), REVIEW);
  assert.equal(rollUp({ a: { status: FAIL }, b: { status: REVIEW } }), FAIL);
  assert.equal(rollUp({ a: { status: PASS } }), PASS);
});

test('exit codes map to the three outcomes', () => {
  assert.equal(exitCodeFor(PASS), 0);
  assert.equal(exitCodeFor(FAIL), 1);
  assert.equal(exitCodeFor(REVIEW), 2);
});

test('the global directory is never mistaken for a local override', async (t) => {
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = mkdtempSync(join(tmpdir(), 'assay-'));
  const global = join(home, '.assay');
  mkdirSync(global);
  const nested = join(home, 'some', 'project');
  mkdirSync(nested, { recursive: true });

  process.env.ASSAY_HOME = global;
  const { findLocalDir } = await import('../src/config.mjs?fresh=' + Date.now());
  t.after(() => { delete process.env.ASSAY_HOME; rmSync(home, { recursive: true, force: true }); });

  assert.equal(findLocalDir(nested), null, 'walking up into home must not adopt the global dir');

  const own = join(nested, '.assay');
  mkdirSync(own);
  assert.equal(findLocalDir(nested), own, 'a real local dir is still found');
});
