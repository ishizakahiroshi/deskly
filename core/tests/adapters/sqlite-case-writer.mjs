import { parentPort, workerData } from 'node:worker_threads';
import { SQLiteStore } from '../../.build/adapters/sqlite/store.js';
import { app, caseService, newCase } from './case-fixtures.mjs';
import { ids } from '../contract/fixtures.mjs';

// An independent connection that creates cases through the shared service on a signal.
const store = await SQLiteStore.open(workerData.path);
const cases = await caseService(store);
parentPort.postMessage({ ready: true });
parentPort.once('message', async () => {
  try {
    const created = await Promise.all(Array.from({ length: workerData.count }, (_, index) =>
      cases.create(app('app_one'), ids.workspace, newCase({ title: `合成の並行 ${workerData.name} ${index}` }))));
    parentPort.postMessage({ ok: true, numbers: created.map(({ number }) => number) });
  } catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message }); }
  finally { await store.close(); parentPort.close(); }
});
