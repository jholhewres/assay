#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRubric, findLocalDir, GLOBAL_DIR } from '../src/config.mjs';
import { assess, exitCodeFor, PASS, FAIL, REVIEW } from '../src/evaluate.mjs';
import { calibrate } from '../src/calibrate.mjs';
import { renderAssessment, renderBatch, renderCalibration } from '../src/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `assay — measure an artifact against a rubric, instead of asking a model whether it is happy

  assay <rubric> [--json] [--force]        judge the state on stdin
  assay <rubric> --batch <file.jsonl|->    judge many states ("-" reads stdin)
  assay calibrate <rubric> --corpus <file.jsonl|-> [--write]
  assay init [--force]                     install the bundled rubrics into ~/.assay
  assay list                               show the rubrics in scope

exit codes
  0  every question passed
  1  at least one question failed
  2  needs a human, or the rubric was never calibrated

State comes from stdin — a file is never required. Pipe it from anything:
  jira issue view ABC-123 --plain | assay story-refinement
  curl -s "$API/issue/ABC-123" | jq '{summary,description}' | assay story-refinement

A corpus row is one JSON object per line:
  {"id":"001","state":"...","label":true}
  {"id":"002","state":"...","labels":{"acceptanceTestable":false}}

  label / labels is the ground truth you ALREADY have — cases you know the
  answer to. Without it there is nothing to calibrate against.
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) flags[key] = inline;
      else if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseCorpus(raw, label) {
  raw = raw.trim();
  if (!raw) throw new Error(`${label} is empty`);
  const rows = raw.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`${label}:${index + 1}: ${err.message}`);
    }
  });
  return rows.map((row, index) => ({ id: row.id ?? String(index + 1), ...row }));
}

/** A dash means stdin, so a corpus can come straight out of another command. */
async function readCorpus(path) {
  if (path === '-' || path === true) return parseCorpus(await readStdin(), 'stdin');
  return parseCorpus(readFileSync(path, 'utf8'), path);
}

/** Parse a state that may be plain text or JSON — both are valid input. */
function coerceState(text) {
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fail(message) {
  process.stderr.write(`assay: ${message}\n`);
  process.exit(2);
}

async function cmdInit(flags) {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  const source = join(ROOT, 'rubrics');
  let written = 0;
  for (const file of readdirSync(source).filter((f) => f.endsWith('.json'))) {
    const target = join(GLOBAL_DIR, file);
    if (existsSync(target) && !flags.force) {
      process.stdout.write(`  kept    ${target}\n`);
      continue;
    }
    copyFileSync(join(source, file), target);
    process.stdout.write(`  wrote   ${target}\n`);
    written++;
  }
  process.stdout.write(`\n  ${written} rubric(s) installed. They are uncalibrated on purpose —\n`);
  process.stdout.write('  run `assay calibrate` against cases you already know before trusting them.\n');
}

function cmdList() {
  const localDir = findLocalDir();
  const scan = (dir) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];

  const global = scan(GLOBAL_DIR);
  const local = localDir ? scan(localDir) : [];

  process.stdout.write(`  global  ${GLOBAL_DIR}\n`);
  for (const name of global) process.stdout.write(`    ${name}${local.includes(name) ? '  (overridden here)' : ''}\n`);
  if (!global.length) process.stdout.write('    (none — run `assay init`)\n');

  if (localDir) {
    process.stdout.write(`\n  local   ${localDir}\n`);
    for (const name of local) process.stdout.write(`    ${name}\n`);
    if (!local.length) process.stdout.write('    (none)\n');
  }
}

async function cmdCalibrate(name, flags) {
  if (!flags.corpus) fail('calibrate needs --corpus <file.jsonl>');
  const rubric = loadRubric(name);
  const corpus = await readCorpus(flags.corpus);

  const labelled = corpus.filter((r) => typeof r.label === 'boolean' || r.labels);
  if (!labelled.length) fail('no row in the corpus carries a label — there is nothing to calibrate against');

  const quiet = Boolean(flags.json);
  const report = await calibrate(rubric, corpus, {
    concurrency: Number(flags.concurrency) || 4,
    onProgress: quiet ? undefined : (done, total) => process.stderr.write(`\r  evaluating ${done}/${total}`),
  });
  if (!quiet) process.stderr.write('\r\x1b[K');

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('\n' + renderCalibration(report) + '\n');
  }

  if (flags.write) {
    const dir = findLocalDir() || GLOBAL_DIR;
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${name}.json`);
    const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { name };
    existing.thresholds = existing.thresholds || {};
    for (const [id, stats] of Object.entries(report.perQuestion)) {
      if (!stats.n || stats.verdict === 'does not separate') continue;
      existing.thresholds[id] = { ...(existing.thresholds[id] || {}), ...stats.suggested };
    }
    existing.calibration = {
      calibratedAt: report.calibratedAt,
      corpus: flags.corpus,
      n: report.evaluated,
      perQuestion: Object.fromEntries(
        Object.entries(report.perQuestion).map(([id, s]) => [id, { auc: s.auc, verdict: s.verdict, n: s.n }]),
      ),
    };
    writeFileSync(target, JSON.stringify(existing, null, 2) + '\n');
    process.stdout.write(`\n  wrote ${target}\n`);

    const skipped = Object.entries(report.perQuestion).filter(([, s]) => s.n && s.verdict === 'does not separate');
    if (skipped.length) {
      process.stdout.write(
        `  left uncalibrated (no separation): ${skipped.map(([id]) => id).join(', ')}\n` +
          '  rewrite those questions — a threshold would not save them.\n',
      );
    }
  }
}

async function cmdAssess(name, flags) {
  const rubric = loadRubric(name);

  if (!rubric.calibration && !flags.force && !flags.json) {
    process.stderr.write(`  note: "${name}" is uncalibrated — treat the verdict as a guess (--force to silence)\n`);
  }

  if (flags.batch) {
    const corpus = await readCorpus(flags.batch);
    const rows = [];
    for (const row of corpus) {
      const result = await assess(rubric, row.state);
      rows.push({ id: row.id, result });
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    } else {
      process.stdout.write('\n' + renderBatch(rows) + '\n');
    }
    process.exit(rows.some((r) => r.result.status === FAIL) ? 1 : rows.some((r) => r.result.status === REVIEW) ? 2 : 0);
  }

  const input = await readStdin();
  if (!input) fail('no state on stdin');

  const result = await assess(rubric, coerceState(input));
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('\n' + renderAssessment(result, { name }) + '\n');
  }
  process.exit(exitCodeFor(result.status));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, second] = positional;

  if (!command || flags.help || command === 'help') {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 2);
  }

  try {
    if (command === 'init') return await cmdInit(flags);
    if (command === 'list') return cmdList();
    if (command === 'calibrate') {
      if (!second) fail('calibrate needs a rubric name');
      return await cmdCalibrate(second, flags);
    }
    return await cmdAssess(command, flags);
  } catch (err) {
    fail(err.message);
  }
}

main();
