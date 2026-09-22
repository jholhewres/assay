const ENDPOINT = process.env.ASSAY_JEV_ENDPOINT || 'https://ai-gateway.vercel.sh/v1/evaluate';
const DEFAULT_MODEL = 'typesafe-ai/jev';
const MAX_ATTEMPTS = Number(process.env.ASSAY_MAX_ATTEMPTS || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rate limits and upstream hiccups are worth waiting out; nothing else is. */
function isTransient(status) {
  return status === 429 || status === 408 || status >= 500;
}

function backoffMs(attempt, retryAfter) {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/**
 * Driver for evaluation models served by the Vercel AI Gateway.
 * State goes in, typed answers come out — no generated text to parse.
 */
export const jev = {
  id: 'jev',

  requiredEnv: ['AI_GATEWAY_API_KEY'],

  async evaluate({ state, questions, model, providerOptions, signal }) {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) throw new Error('AI_GATEWAY_API_KEY is not set');

    const payload = JSON.stringify({
      model: model || DEFAULT_MODEL,
      state,
      questions,
      ...(providerOptions ? { providerOptions } : {}),
    });

    let text;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: payload,
      });

      text = await res.text();
      if (res.ok) break;

      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.error?.message || detail;
      } catch {}

      if (isTransient(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      throw new Error(`gateway ${res.status}: ${detail}`);
    }

    const body = JSON.parse(text);
    return {
      answers: body.answers,
      usage: body.usage,
      metadata: body.providerMetadata,
    };
  },
};
