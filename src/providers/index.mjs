import { jev } from './jev.mjs';

const providers = new Map([[jev.id, jev]]);

/** Register your own driver: anything that returns a number per question. */
export function register(provider) {
  providers.set(provider.id, provider);
}

export function getProvider(id = 'jev') {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`unknown provider "${id}". Known: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}
