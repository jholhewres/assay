import { getProvider } from './providers/index.mjs';

export const PASS = 'pass';
export const REVIEW = 'review';
export const FAIL = 'fail';
export const SKIPPED = 'skipped';

/** Only these calibration verdicts justify judging with a threshold. */
export function isUsable(verdict) {
  return verdict === 'separates' || verdict === 'separates weakly';
}

/**
 * Which questions may judge. An uncalibrated rubric judges everything (and
 * says so). Once a rubric is calibrated, a question that did not separate —
 * or was never measured — is left out: judging it with an inherited default
 * threshold would present a guess as a measurement.
 */
export function judgedQuestions(rubric) {
  const all = Object.keys(rubric.questions);
  if (!rubric.calibration) return { judged: all, skipped: {} };
  const per = rubric.calibration.perQuestion || {};
  const judged = [];
  const skipped = {};
  for (const id of all) {
    const verdict = per[id]?.verdict;
    if (isUsable(verdict)) judged.push(id);
    else skipped[id] = verdict ? `did not calibrate: ${verdict}` : 'not measured in calibration';
  }
  return { judged, skipped };
}

/** The comparable number behind an answer, whatever its type. */
export function scalarOf(answer) {
  if (!answer) return null;
  if (typeof answer.probability === 'number') return answer.probability;
  if (typeof answer.score === 'number') return answer.score;
  if (answer.probabilities && answer.choice) return answer.probabilities[answer.choice] ?? null;
  return null;
}

/**
 * Compare one answer against its threshold.
 *
 * `min` — pass at or above (boolean, choice confidence)
 * `max` — pass at or below (score, where lower is smaller/simpler)
 * `grey` — the far edge of the band that goes to a human instead of failing
 */
export function verdictFor(answer, threshold) {
  const value = scalarOf(answer);
  if (value === null) return { status: REVIEW, value, reason: 'no comparable value' };
  if (!threshold) return { status: REVIEW, value, reason: 'no threshold set' };

  if (typeof threshold.min === 'number') {
    if (value >= threshold.min) return { status: PASS, value };
    if (typeof threshold.grey === 'number' && value >= threshold.grey) {
      return { status: REVIEW, value, reason: `below ${threshold.min}, above grey band` };
    }
    return { status: FAIL, value, reason: `below ${threshold.min}` };
  }

  if (typeof threshold.max === 'number') {
    if (value <= threshold.max) return { status: PASS, value };
    if (typeof threshold.grey === 'number' && value <= threshold.grey) {
      return { status: REVIEW, value, reason: `above ${threshold.max}, inside grey band` };
    }
    return { status: FAIL, value, reason: `above ${threshold.max}` };
  }

  return { status: REVIEW, value, reason: 'threshold has neither min nor max' };
}

/** Worst status wins: fail > review > pass. */
export function rollUp(verdicts) {
  const values = Object.values(verdicts).filter((v) => v.status !== SKIPPED);
  if (values.some((v) => v.status === FAIL)) return FAIL;
  if (values.some((v) => v.status === REVIEW)) return REVIEW;
  return PASS;
}

export function exitCodeFor(status) {
  return status === PASS ? 0 : status === FAIL ? 1 : 2;
}

/** Run one state through a rubric and judge every answer. */
export async function assess(rubric, state, { signal } = {}) {
  const { judged, skipped } = judgedQuestions(rubric);
  if (!judged.length) {
    throw new Error(`rubric "${rubric.name}" is calibrated but no question separated — nothing can judge`);
  }

  const provider = getProvider(rubric.provider);
  // Skipped questions are not sent: they cost tokens and decide nothing.
  const { answers, usage, metadata } = await provider.evaluate({
    state,
    questions: Object.fromEntries(judged.map((id) => [id, rubric.questions[id]])),
    model: rubric.model,
    providerOptions: rubric.providerOptions,
    signal,
  });

  const verdicts = {};
  for (const id of judged) {
    verdicts[id] = {
      ...verdictFor(answers?.[id], rubric.thresholds?.[id]),
      answer: answers?.[id],
    };
  }
  for (const [id, reason] of Object.entries(skipped)) {
    verdicts[id] = { status: SKIPPED, value: null, reason };
  }

  const status = rollUp(verdicts);
  return {
    status,
    verdicts,
    failed: Object.entries(verdicts).filter(([, v]) => v.status === FAIL).map(([id]) => id),
    calibrated: Boolean(rubric.calibration),
    usage,
    metadata,
  };
}
