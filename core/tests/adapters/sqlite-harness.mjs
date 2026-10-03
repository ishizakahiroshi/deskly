import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../../.build/adapters/sqlite/store.js';

/** The same synthetic identities and public-port fixture seeding as MemoryStore. */
export async function createSQLiteHarness({ principals = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-sqlite-contract-'));
  const path = join(directory, 'synthetic.sqlite');
  try {
    const store = await SQLiteStore.open(path);
    return {
      store, path,
      authenticator: { async authenticate(request) {
        const actor = request.headers.get('x-contract-actor');
        return Object.hasOwn(principals, actor) ? structuredClone(principals[actor]) : null;
      } },
      async close() { await store.close(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
