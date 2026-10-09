import { MemoryStore } from '../../.build/memory-store.js';

/** Test-only identity adapter; tokens are synthetic labels, never production credentials. */
export async function createMemoryHarness({ principals }) {
  return {
    store: new MemoryStore(),
    authenticator: {
      async authenticate(request) {
        const actor = request.headers.get('x-contract-actor');
        return Object.hasOwn(principals, actor) ? structuredClone(principals[actor]) : null;
      },
    },
  };
}
