import { Miniflare } from 'miniflare';
import { D1Store } from '../../.build/adapters/d1/store.js';

/** In-memory Miniflare D1; dispose the runtime before any temporary resources. */
export async function createD1Harness({ principals = {} } = {}) {
  const runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("synthetic"); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const database = await runtime.getD1Database('DB');
    const store = await D1Store.open(database);
    return { store, database,
      authenticator: { async authenticate(request) {
        const actor = request.headers.get('x-contract-actor');
        return Object.hasOwn(principals, actor) ? structuredClone(principals[actor]) : null;
      } },
      async close() { await runtime.dispose(); },
    };
  } catch (error) { await runtime.dispose(); throw error; }
}
