import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let port;
const hits = new Map();

// Fake gateway. "FLAKY-n" fails n times then succeeds; "DOWN" always 429s;
// "DENY" is a 403, which must never be retried.
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { state, questions } = JSON.parse(body);
      const text = typeof state === 'string' ? state : JSON.stringify(state);
      hits.set(text, (hits.get(text) || 0) + 1);

      const flaky = text.match(/FLAKY-(\d)/);
      if (text.includes('DOWN') || (flaky && hits.get(text) <= Number(flaky[1]))) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.01' });
        return res.end(JSON.stringify({ message: 'rate limited' }));
      }
      if (text.includes('DENY')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'forbidden' }));
      }
      const strong = /check:/i.test(text);
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = q.type === 'score'
          ? { type: 'score', score: strong ? 1 : 3 }
          : { type: 'boolean', probability: strong ? 0.95 : 0.1 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers, usage: {} }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  process.env.ASSAY_JEV_ENDPOINT = `http://127.0.0.1:${port}/v1/evaluate`;
  process.env.AI_GATEWAY_API_KEY = 'test';
  process.env.ASSAY_MAX_ATTEMPTS = '3';
});

after(() => server.close());

const questions = { q: { type: 'boolean', instructions: 'x' } };

test('a 429 is retried until it succeeds', async () => {
  const { jev } = await import('../src/providers/jev.mjs');
  const out = await jev.evaluate({ state: 'FLAKY-2 Check: y', questions });
  assert.equal(out.answers.q.probability, 0.95);
  assert.equal(hits.get('FLAKY-2 Check: y'), 3);
});

test('a persistent 429 gives up after the attempt limit', async () => {
  const { jev } = await import('../src/providers/jev.mjs');
  await assert.rejects(jev.evaluate({ state: 'DOWN', questions }), /gateway 429/);
  assert.equal(hits.get('DOWN'), 3);
});

test('a 403 is never retried', async () => {
  const { jev } = await import('../src/providers/jev.mjs');
  await assert.rejects(jev.evaluate({ state: 'DENY', questions }), /gateway 403: forbidden/);
  assert.equal(hits.get('DENY'), 1);
});

// Async on purpose: the fake gateway lives in this process, so a synchronous
// spawn would block the event loop and the child would never get an answer.
function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(ROOT, 'bin/assay.mjs'), ...args], {
      cwd,
      env: { ...process.env, ASSAY_HOME: join(cwd, 'home') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function workspace(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'assay-cli-'));
  mkdirSync(join(dir, '.assay'));
  writeFileSync(join(dir, '.assay', 'r.json'), JSON.stringify({
    name: 'r', provider: 'jev',
    questions: { q: { type: 'boolean', instructions: 'x' } },
    thresholds: { q: { min: 0.5 } },
  }));
  writeFileSync(join(dir, 'corpus.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  return dir;
}

const good = (id) => ({ id, label: true, state: `${id} Check: y` });
const bad = (id) => ({ id, label: false, state: `${id} vague` });

test('--write refuses when rows failed, and says so in the exit code', async () => {
  const dir = workspace([good('a'), good('b'), good('c'), bad('d'), bad('e'), { id: 'f', label: false, state: 'DOWN f' }]);
  const before = readFileSync(join(dir, '.assay', 'r.json'), 'utf8');

  const run = await runCli(['calibrate', 'r', '--corpus', 'corpus.jsonl', '--write'], dir);

  assert.equal(run.status, 2);
  assert.match(run.stderr, /refusing to write: 1 of 6 rows failed/);
  assert.equal(readFileSync(join(dir, '.assay', 'r.json'), 'utf8'), before, 'file must be untouched');
});

test('--write succeeds on a complete, balanced run', async () => {
  const dir = workspace([good('a'), good('b'), good('c'), bad('d'), bad('e'), bad('f')]);
  const run = await runCli(['calibrate', 'r', '--corpus', 'corpus.jsonl', '--write'], dir);

  assert.equal(run.status, 0, run.stderr);
  const saved = JSON.parse(readFileSync(join(dir, '.assay', 'r.json'), 'utf8'));
  assert.equal(saved.calibration.complete, true);
  assert.equal(saved.calibration.perQuestion.q.negatives, 3);
  assert.equal(saved.thresholds.q.min, 0.95);
});

test('too few negatives: nothing written for that question, exit 1', async () => {
  const dir = workspace([good('a'), good('b'), good('c'), bad('d')]);
  const run = await runCli(['calibrate', 'r', '--corpus', 'corpus.jsonl', '--write'], dir);

  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, /suggested min/, 'no threshold may be printed for an unusable question');
  const saved = JSON.parse(readFileSync(join(dir, '.assay', 'r.json'), 'utf8'));
  assert.equal(saved.thresholds.q.min, 0.5, 'the old threshold stays');
});
