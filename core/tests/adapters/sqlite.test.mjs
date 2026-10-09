import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SQLiteStore } from '../../.build/adapters/sqlite/store.js';
import { NodeSqliteDriver } from '../../.build/adapters/sqlite/driver.js';
import { migrate } from '../../.build/adapters/sqlite/migrate.js';
import { createSQLiteHarness } from './sqlite-harness.mjs';
import { clockTime, ids, seed, snapshot, uuid, contacts } from '../contract/fixtures.mjs';

const history = (before, after, operation) => ({
  event_kind: 'entity', workspace_id: ids.workspace, operation_id: uuid(operation), entity_id: after.id,
  member_id: ids.owner, requester_member_id: ids.owner, route: 'dashboard', executor_kind: 'unknown',
  executor_ref: null, executor_verified: false, reason: '合成検査', at_utc: clockTime, before, after, changes: [],
});
async function setup(t) {
  const harness = await createSQLiteHarness();
  // 追加で開いた接続は、一時フォルダを消す前に閉じる（Windows はロックが残ると消せない）
  const deferred = [];
  harness.defer = fn => { deferred.unshift(fn); };
  t.after(async () => {
    for (const fn of deferred) await fn();
    await harness.close();
  });
  await seed(harness.store);
  return harness;
}

test('SQLite: independent worker connections have one CAS winner, one event, and no skipped version', { timeout: 20000 }, async t => {
  const h = await setup(t);
  const writers = [7001, 7002].map(operation => new Worker(new URL('./sqlite-writer.mjs', import.meta.url), { workerData: { path: h.path, operation } }));
  t.after(() => Promise.all(writers.map(worker => worker.terminate())));
  for (const [ready] of await Promise.all(writers.map(worker => once(worker, 'message')))) assert.equal(ready.ready, true);
  const pending = writers.map(worker => once(worker, 'message'));
  writers.forEach(worker => worker.postMessage('apply'));
  const results = (await Promise.all(pending)).map(([value]) => value);
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.find(value => !value.ok).code, 'version_conflict');
  const row = await h.store.read(tx => tx.resources.get(ids.workspace, ids.work));
  const events = await h.store.read(tx => tx.events.list(ids.workspace));
  assert.equal(row.version, 2);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].after, row);
});

test('SQLite: same-event-loop connections serialize without retrying async callbacks', async t => {
  const h = await setup(t);
  const second = await SQLiteStore.open(h.path);
  h.defer(() => second.close());
  let calls = 0;
  const write = store => store.transaction(async tx => {
    calls++;
    const current = await tx.resources.get(ids.workspace, ids.work);
    await new Promise(resolve => setTimeout(resolve, 10));
    await tx.resources.put({ ...current, version: 2 }, 1);
  });
  const results = await Promise.allSettled([write(h.store), write(second)]);
  assert.equal(calls, 2);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'version_conflict');
});

test('SQLite: rollback restores both entities and appended workspace/contact history', async t => {
  const h = await setup(t);
  const before = await snapshot(h.store);
  for (const unusableResult of [false, true]) {
    await assert.rejects(h.store.transaction(async tx => {
      const old = await tx.resources.get(ids.workspace, ids.work);
      const next = { ...old, version: 2, title: '合成未確定' };
      await tx.resources.put(next, 1);
      await tx.events.append(history(old, next, 7101));
      const oldContact = await tx.contacts.get(ids.workspace, ids.source, contacts.normal);
      const nextContact = { ...oldContact, version: 2, contact: { ...oldContact.contact, note: '合成未確定' } };
      await tx.contacts.put(nextContact, 1);
      await tx.contacts.append({ workspace_id: ids.workspace, source_id: ids.source, contact_id: contacts.normal,
        operation_id: uuid(7102), requester_member_id: ids.owner, route: 'dashboard', reason: '合成検査',
        at_utc: clockTime, before: oldContact, after: nextContact, changes: [], request_hash: '0'.repeat(64) });
      if (unusableResult) return () => {};
      throw new Error('Synthetic failure after both history inserts');
    }));
    assert.deepEqual(await snapshot(h.store), before);
  }
});

test('SQLite: reopening retains data and appended history', async t => {
  const h = await setup(t);
  await h.store.transaction(async tx => {
    const before = await tx.resources.get(ids.workspace, ids.work);
    const after = { ...before, version: 2 };
    await tx.resources.put(after, 1);
    await tx.events.append(history(before, after, 7201));
  });
  const before = await snapshot(h.store);
  await h.store.close();
  const reopened = await SQLiteStore.open(h.path);
  h.defer(() => reopened.close());
  assert.deepEqual(await snapshot(reopened), before);
  assert.deepEqual(await reopened.read(tx => tx.accounts.get(uuid(101))),
    { subject: uuid(101), login: 'synthetic_owner', active: true, revision: 1 });
});

test('SQLite: migrations apply twice without changing data and record version plus checksum', async t => {
  const h = await setup(t);
  const before = await snapshot(h.store);
  const driver = new NodeSqliteDriver(h.path);
  h.defer(() => driver.close());
  await migrate(driver);
  await migrate(driver);
  const migrations = driver.prepare('SELECT * FROM schema_migrations').all();
  assert.deepEqual(migrations.map(({ name }) => name), ['001_initial.sql', '002_conditions.sql', '003_cases.sql',
    '004_case_member_scopes.sql']);
  assert.equal(migrations[0].version, 1);
  assert.equal(migrations[0].name, '001_initial.sql');
  assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(await snapshot(h.store), before);
});

test('SQLite: migration rejects altered history without overwriting persisted data', async t => {
  const h = await setup(t);
  const before = await snapshot(h.store);
  const driver = new NodeSqliteDriver(h.path);
  h.defer(() => driver.close());
  driver.prepare('UPDATE schema_migrations SET checksum = ?').run('synthetic mismatch');
  await assert.rejects(migrate(driver), /migration history/);
  assert.deepEqual(await snapshot(h.store), before);
});

test('SQLite: WAL, busy timeout, foreign keys and append-only history are enforced by the database', async t => {
  const h = await setup(t);
  const driver = new NodeSqliteDriver(h.path);
  h.defer(() => driver.close());
  assert.equal(driver.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(driver.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(driver.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.throws(() => driver.prepare('INSERT INTO contacts(workspace_id, source_id, contact_id, version, data) VALUES (?, ?, ?, 1, ?)')
    .run(ids.workspace, uuid(99999), 'c-synthetic', '{}'), /FOREIGN KEY/);
  await h.store.transaction(async tx => {
    const row = await tx.resources.get(ids.workspace, ids.work);
    await tx.events.append(history(null, row, 7301));
  });
  for (const sql of ["UPDATE events SET data = '{}'", 'DELETE FROM events', 'INSERT OR REPLACE INTO events SELECT * FROM events']) {
    assert.throws(() => driver.run(sql), /append-only/);
  }
  assert.equal((await h.store.read(tx => tx.events.list(ids.workspace))).length, 1);
});

test('SQLite: sessions expire, read sessions reject all writes, and failed callbacks are not retried', async t => {
  const h = await setup(t);
  let escaped;
  await h.store.read(async tx => { escaped = tx; });
  await assert.rejects(escaped.resources.list(ids.workspace), /closed/);
  await assert.rejects(escaped.resources.put({}, null), /closed/);
  await h.store.read(async tx => {
    for (const port of ['workspaces', 'accounts', 'resources', 'memberships', 'contacts']) await assert.rejects(tx[port].put({}, null), /immutable/);
    for (const port of ['events', 'contacts']) await assert.rejects(tx[port].append({}), /immutable/);
  });
  let calls = 0;
  await assert.rejects(h.store.transaction(async () => { calls++; throw new Error('Synthetic failure'); }));
  assert.equal(calls, 1);
});
