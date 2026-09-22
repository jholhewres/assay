const ENDPOINT = process.env.ASSAY_JEV_ENDPOINT || 'https://ai-gateway.vercel.sh/v1/evaluate';
const DEFAULT_MODEL = 'typesafe-ai/jev';

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

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        state,
        questions,
        ...(providerOptions ? { providerOptions } : {}),
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text);
        detail = parsed.message || parsed.error?.message || detail;
      } catch {}
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
