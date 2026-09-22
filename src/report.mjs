import { PASS, REVIEW, FAIL, SKIPPED, scalarOf } from './evaluate.mjs';

const MARK = { [PASS]: 'PASS', [REVIEW]: 'REVIEW', [FAIL]: 'FAIL', [SKIPPED]: 'SKIP' };

function fmt(value) {
  if (value === null || value === undefined) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function pad(text, width) {
  return String(text).padEnd(width);
}

export function renderAssessment(result, { name } = {}) {
  const ids = Object.keys(result.verdicts);
  const width = Math.max(8, ...ids.map((id) => id.length));
  const lines = [];

  for (const id of ids) {
    const v = result.verdicts[id];
    const extra = v.answer?.choice ? ` (${v.answer.choice})` : '';
    const why = v.reason ? `  ${v.reason}` : '';
    lines.push(`  ${pad(id, width)}  ${pad(fmt(v.value) + extra, 12)}${pad(MARK[v.status], 8)}${why}`);
  }

  lines.push('');
  lines.push(`  ${name || 'rubric'}: ${MARK[result.status]}`);
  if (result.failed.length) lines.push(`  failed: ${result.failed.join(', ')}`);
  if (!result.calibrated) {
    lines.push('  warning: this rubric has never been calibrated — the thresholds are guesses');
  }
  return lines.join('\n');
}

export function renderBatch(rows) {
  const ids = rows.length ? Object.keys(rows[0].result.verdicts) : [];
  const idWidth = Math.max(4, ...rows.map((r) => String(r.id).length));
  const colWidth = Math.max(10, ...ids.map((i) => i.length + 2));

  const header = `  ${pad('id', idWidth)}  ${ids.map((i) => pad(i, colWidth)).join('')}verdict`;
  const lines = [header, '  ' + '-'.repeat(header.length - 2)];

  for (const row of rows) {
    const cells = ids.map((id) => {
      const v = row.result.verdicts[id];
      const glyph = v.status === PASS ? '+' : v.status === FAIL ? 'x' : v.status === SKIPPED ? '' : '?';
      return pad(`${fmt(v.value)} ${glyph}`, colWidth);
    });
    lines.push(`  ${pad(row.id, idWidth)}  ${cells.join('')}${MARK[row.result.status]}`);
  }

  const failed = rows.filter((r) => r.result.status === FAIL).length;
  const review = rows.filter((r) => r.result.status === REVIEW).length;
  lines.push('');
  lines.push(`  ${rows.length} evaluated · ${failed} failed · ${review} need review`);
  return lines.join('\n');
}

export function renderCalibration(report) {
  const lines = [`  rubric: ${report.rubric}`, `  corpus: ${report.evaluated}/${report.corpusSize} evaluated`];
  if (!report.complete) {
    lines.push(`  INCOMPLETE — ${report.errors.length} row(s) failed; this measurement is not trustworthy`);
  }
  lines.push('');

  for (const [id, stats] of Object.entries(report.perQuestion)) {
    lines.push(`  ${id}`);
    if (!stats.n) {
      lines.push(`    ${stats.verdict}`);
      lines.push('');
      continue;
    }
    const key = stats.suggested.min !== undefined ? 'min' : 'max';
    lines.push(`    auc ${stats.auc ?? '-'}  ${stats.verdict}  (${stats.positives} pass / ${stats.negatives} fail)`);
    // An unusable question gets no printed threshold: a number on screen gets copied.
    if (!stats.usable) {
      lines.push(
        stats.verdict === 'does not separate'
          ? '    no threshold — check that the labels measure what this question asks, then the question'
          : '    no threshold — not enough evidence to set one',
      );
      lines.push('');
      continue;
    }
    lines.push(
      `    suggested ${key} ${stats.suggested[key]}  ` +
        `accuracy ${(stats.atSuggested.accuracy * 100).toFixed(0)}%  ` +
        `precision ${(stats.atSuggested.precision * 100).toFixed(0)}%  ` +
        `recall ${(stats.atSuggested.recall * 100).toFixed(0)}%`,
    );
    if (stats.misses.length) {
      const shown = stats.misses.slice(0, 5).map((m) => `${m.id}(${fmt(m.value)}, wanted ${m.expected})`);
      lines.push(`    misses: ${shown.join(', ')}${stats.misses.length > 5 ? ` +${stats.misses.length - 5}` : ''}`);
    }
    lines.push('');
  }

  if (report.errors.length) {
    lines.push(`  ${report.errors.length} row(s) errored: ${report.errors.slice(0, 3).map((e) => e.error).join('; ')}`);
  }
  return lines.join('\n');
}

export { scalarOf };
