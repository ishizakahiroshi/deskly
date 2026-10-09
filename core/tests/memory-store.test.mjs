import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../.build/memory-store.js';
import { project, contact, ids } from './fixtures.mjs';

test('memory sessions cannot escape, read snapshots cannot write, and values are detached', async () => {
  const store = new MemoryStore();
  let escaped;
  const original = structuredClone(project);
  await store.transaction(async tx => { escaped = tx; await tx.resources.put(original, null); });
  original.name = '改変';
  await assert.rejects(escaped.resources.get(project.workspace_id, project.id), /closed/);
  await assert.rejects(store.read(tx => tx.resources.put({ ...project, version: 2 }, 1)), /immutable/);
  const record = await store.read(tx => tx.resources.get(project.workspace_id, project.id));
  record.name = '改変';
  assert.deepEqual(await store.read(tx => tx.resources.get(project.workspace_id, project.id)), project);
});

test('memory rolls back thrown writes and unusable callback results, then allows next transaction', async () => {
  const store = new MemoryStore();
  for (const unusable of [false, true]) {
    await assert.rejects(store.transaction(async tx => {
      await tx.resources.put(project, null);
      if (unusable) return () => {};
      throw new Error('synthetic failure');
    }));
    assert.equal(await store.read(tx => tx.resources.get(project.workspace_id, project.id)), null);
  }
  await store.transaction(tx => tx.resources.put(project, null));
  assert.deepEqual(await store.read(tx => tx.resources.get(project.workspace_id, project.id)), project);
});

test('memory resource/contact CAS rejects zero creation and unsafe next versions', async () => {
  const store = new MemoryStore();
  await assert.rejects(store.transaction(tx => tx.resources.put(project, 0)), { code: 'version_conflict' });
  const grant = { scope: 'project', workspace_id: ids.workspace, project_id: ids.project, member_id: ids.member, role: 'editor', version: 1 };
  await assert.rejects(store.transaction(tx => tx.memberships.put(grant, null)), { code: 'version_conflict' });
  await store.transaction(tx => tx.memberships.put(grant, 0));
  const row = { workspace_id: ids.workspace, source_id: ids.source, version: 1, contact };
  await assert.rejects(store.transaction(tx => tx.contacts.put(row, 0)), { code: 'version_conflict' });
  await store.transaction(tx => tx.resources.put(project, null));
  await assert.rejects(store.transaction(tx => tx.resources.put({ ...project, version: Number.MAX_SAFE_INTEGER + 1 }, Number.MAX_SAFE_INTEGER)), { code: 'version_conflict' });
  assert.deepEqual(await store.read(tx => tx.resources.get(project.workspace_id, project.id)), project);
});
