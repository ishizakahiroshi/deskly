import { parentPort, workerData } from 'node:worker_threads';
import { SQLiteStore } from '../../.build/adapters/sqlite/store.js';
import { WorkspaceService } from '../../.build/service.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { ids, principalFixtures, uuid, workData, clockTime } from '../contract/fixtures.mjs';

const store = await SQLiteStore.open(workerData.path);
const signer = await createConfirmationSigner(new Uint8Array(32).fill(7));
const service = new WorkspaceService({ store, signer, clock: { now: () => clockTime }, ids: { next: () => uuid(9900) } });
const preview = await service.preview(principalFixtures.owner, ids.workspace, {
  operation_id: uuid(workerData.operation), action: 'update', type: 'work_item', id: ids.work,
  project_id: ids.project, expected_version: 1, data: workData({ title: `合成writer${workerData.operation}` }), reason: '合成の並行検査',
});
parentPort.postMessage({ ready: true });
parentPort.once('message', async () => {
  try { parentPort.postMessage({ ok: true, value: await service.apply(principalFixtures.owner, ids.workspace, preview) }); }
  catch (error) { parentPort.postMessage({ ok: false, code: error.code, message: error.message }); }
  finally { await store.close(); parentPort.close(); }
});
