import { getProvider } from './providers/index.mjs';
import { scalarOf } from './evaluate.mjs';

/**
 * Area under the ROC curve, by rank (Mann-Whitney U).
 * 1.0 = perfect separation, 0.5 = no better than a coin.
 */
export function auc(positives, negatives) {
  if (!positives.length || !negatives.length) return null;
  const all = [
    ...positives.map((v) => ({ v, pos: true })),
    ...negatives.map((v) => ({ v, pos: false })),
  ].sort((a, b) => a.v - b.v);

  // Average ranks across ties so a flat scorer cannot look good.
  let i = 0;
  let rankSumPos = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k].pos) rankSumPos += avgRank;
    i = j + 1;
  }

  const n1 = positives.length;
  const n2 = negatives.length;
  return (rankSumPos - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

function confusionAt(rows, threshold, higherIsPositive) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    const predicted = higherIsPositive ? row.value >= threshold : row.value <= threshold;
    if (row.label && predicted) tp++;
    else if (!row.label && predicted) fp++;
    else if (!row.label && !predicted) tn++;
    else fn++;
  }
  const total = tp + fp + tn + fn;
  return {
    threshold: Number(threshold.toFixed(4)),
    tp, fp, tn, fn,
    accuracy: total ? (tp + tn) / total : 0,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    youden: (tp + fn ? tp / (tp + fn) : 0) - (fp + tn ? fp / (fp + tn) : 0),
  };
}

/** Sweep every value actually observed and keep the best split. */
export function bestThreshold(rows, higherIsPositive) {
  const candidates = [...new Set(rows.map((r) => r.value))].sort((a, b) => a - b);
  let best = null;
  for (const c of candidates) {
    const stats = confusionAt(rows, c, higherIsPositive);
    if (!best || stats.youden > best.youden) best = stats;
  }
  return best;
}

export function separationVerdict(areaUnderCurve) {
  if (areaUnderCurve === null) return 'needs both passing and failing examples';
  if (areaUnderCurve >= 0.85) return 'separates';
  if (areaUnderCurve >= 0.7) return 'separates weakly';
  return 'does not separate';
}

/**
 * Run a rubric over a labelled corpus and report, per question, whether it
 * tells the two populations apart — and what threshold to use if it does.
 *
 * A corpus row is { id, state, label } where label is true when the case
 * SHOULD pass, or { id, state, labels: { questionId: true } } for per-question
 * ground truth.
 */
export async function calibrate(rubric, corpus, { concurrency = 4, onProgress } = {}) {
  const provider = getProvider(rubric.provider);
  const results = new Array(corpus.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= corpus.length) return;
      const row = corpus[index];
      try {
        const { answers } = await provider.evaluate({
          state: row.state,
          questions: rubric.questions,
          model: rubric.model,
          providerOptions: rubric.providerOptions,
        });
        results[index] = { row, answers };
      } catch (err) {
        results[index] = { row, error: err.message };
      }
      onProgress?.(++done, corpus.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, corpus.length) }, worker));

  const errors = results.filter((r) => r.error);
  const perQuestion = {};

  for (const [id, question] of Object.entries(rubric.questions)) {
    // A score rubric usually passes BELOW its threshold, so positives are low.
    const higherIsPositive = !(rubric.thresholds?.[id]?.max !== undefined || question.type === 'score');

    const rows = [];
    for (const result of results) {
      if (!result || result.error) continue;
      const label = result.row.labels ? result.row.labels[id] : result.row.label;
      if (typeof label !== 'boolean') continue;
      const value = scalarOf(result.answers?.[id]);
      if (value === null) continue;
      rows.push({ id: result.row.id, value, label });
    }

    if (!rows.length) {
      perQuestion[id] = { n: 0, verdict: 'no labelled rows' };
      continue;
    }

    const positives = rows.filter((r) => r.label).map((r) => r.value);
    const negatives = rows.filter((r) => !r.label).map((r) => r.value);
    const raw = auc(positives, negatives);
    const area = raw === null ? null : higherIsPositive ? raw : 1 - raw;
    const best = bestThreshold(rows, higherIsPositive);

    perQuestion[id] = {
      n: rows.length,
      positives: positives.length,
      negatives: negatives.length,
      auc: area === null ? null : Number(area.toFixed(3)),
      verdict: separationVerdict(area),
      suggested: higherIsPositive ? { min: best.threshold } : { max: best.threshold },
      atSuggested: best,
      misses: rows
        .filter((r) => (higherIsPositive ? r.value >= best.threshold : r.value <= best.threshold) !== r.label)
        .map((r) => ({ id: r.id, value: r.value, expected: r.label ? 'pass' : 'fail' })),
    };
  }

  return {
    rubric: rubric.name,
    corpusSize: corpus.length,
    evaluated: corpus.length - errors.length,
    errors: errors.map((e) => ({ id: e.row?.id, error: e.error })),
    perQuestion,
    calibratedAt: new Date().toISOString(),
  };
}
