import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStore } from '../../.build/adapters/sqlite/store.js';
import { NodeSqliteDriver } from '../../.build/adapters/sqlite/driver.js';
import { migrate } from '../../.build/adapters/sqlite/migrate.js';
import { migrations, checksum } from '../../.build/adapters/sql/migrations.js';
import { ConflictError } from '../../.build/ports.js';
import { createSQLiteHarness } from './sqlite-harness.mjs';
import { app, assertCaseReadOnly, caseRows, caseService, fillCases, newCase, writeCase } from './case-fixtures.mjs';
import { ids, seed } from '../contract/fixtures.mjs';

async function setup(t) {
  const harness = await createSQLiteHarness();
  // Extra connections close before the temporary folder is removed (Windows keeps locks).
  const deferred = [];
  harness.defer = fn => { deferred.unshift(fn); };
  t.after(async () => {
    for (const fn of deferred) await fn();
    await harness.close();
  });
  await seed(harness.store);
  return harness;
}
const created = async (cases, overrides) => (await cases.create(app('app_one'), ids.workspace, newCase(overrides))).number;
const duplicate = error => error instanceof ConflictError && error.code === 'duplicate_id';

test('SQLite: independent worker connections issue every case number once, without gaps', { timeout: 30000 }, async t => {
  const h = await setup(t);
  const writers = ['a', 'b'].map(name => new Worker(new URL('./sqlite-case-writer.mjs', import.meta.url),
    { workerData: { path: h.path, name, count: 6 } }));
  t.after(() => Promise.all(writers.map(worker => worker.terminate())));
  for (const [ready] of await Promise.all(writers.map(worker => once(worker, 'message')))) assert.equal(ready.ready, true);
  const pending = writers.map(worker => once(worker, 'message'));
  writers.forEach(worker => worker.postMessage('create'));
  const results = (await Promise.all(pending)).map(([value]) => value);
  assert.ok(results.every(value => value.ok), JSON.stringify(results));
  const numbers = results.flatMap(value => value.numbers).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  assert.deepEqual(numbers, Array.from({ length: 12 }, (_, index) => `app_one-${index + 1}`));
  const rows = await caseRows(h.store);
  assert.equal(rows.length, 12);
  assert.ok(rows.every(({ events }) => events.length === 1));
  assert.equal(await created(await caseService(h.store)), 'app_one-13');
});

test('SQLite: a rolled-back creation issues no number and leaves no row behind', async t => {
  const h = await setup(t);
  const cases = await caseService(h.store);
  await created(cases);
  const before = await caseRows(h.store);
  await assert.rejects(h.store.transaction(async tx => {
    assert.equal(await writeCase(tx), 'app_one-2');
    throw new Error('Synthetic failure after the number was allocated');
  }), /Synthetic failure/);
  assert.deepEqual(await caseRows(h.store), before);
  assert.equal(await created(cases), 'app_one-2');
});

test('SQLite: (source, legacy_ref) is unique in the port and in the database itself', async t => {
  const h = await setup(t);
  const cases = await caseService(h.store);
  const first = await created(cases, { legacy_ref: 'legacy-1' });
  assert.equal(await created(cases, { legacy_ref: 'legacy-1' }), first);
  await assert.rejects(h.store.transaction(tx => writeCase(tx, { legacy_ref: 'legacy-1' })), duplicate);
  const driver = new NodeSqliteDriver(h.path);
  h.defer(() => driver.close());
  driver.run("UPDATE case_number_sequences SET next_seq = next_seq + 1 WHERE source = 'app_one'");
  assert.throws(() => driver.prepare(`INSERT INTO cases(workspace_id, number, source, seq, legacy_ref, revision, data)
    VALUES (?, 'app_one-2', 'app_one', 2, 'legacy-1', 1, '{}')`).run(ids.workspace), /UNIQUE/);
  // A number the ledger never issued cannot be inserted either.
  assert.throws(() => driver.prepare(`INSERT INTO cases(workspace_id, number, source, seq, legacy_ref, revision, data)
    VALUES (?, 'app_one-99', 'app_one', 99, NULL, 1, '{}')`).run(ids.workspace), /issued by the ledger/);
  const rows = await caseRows(h.store);
  assert.deepEqual(rows.map(({ row }) => [row.number, row.legacy_ref]), [[first, 'legacy-1']]);
});

test('SQLite: case history is append-only and cases and numbers cannot be removed by the database', async t => {
  const h = await setup(t);
  await fillCases(await caseService(h.store));
  const before = await caseRows(h.store);
  const driver = new NodeSqliteDriver(h.path);
  h.defer(() => driver.close());
  for (const [sql, pattern] of [
    ["UPDATE case_events SET data = '{}'", /append-only/],
    ['DELETE FROM case_events', /append-only/],
    ['INSERT OR REPLACE INTO case_events SELECT * FROM case_events', /append-only/],
    [`INSERT INTO case_events(workspace_id, case_number, seq, data) VALUES ('${ids.workspace}', 'app_one-1', 9, '{}')`, /append-only/],
    ['DELETE FROM case_replies', /append-only/],
    ['DELETE FROM case_people', /never deleted/],
    ['DELETE FROM case_links', /never deleted/],
    ['DELETE FROM cases', /never deleted/],
    ['INSERT OR REPLACE INTO cases SELECT * FROM cases', /never deleted/],
    ["UPDATE cases SET seq = 7, number = source || '-7'", /identity is fixed/],
    ['UPDATE cases SET revision = revision + 2', /revisions advance by one/],
    ['DELETE FROM case_number_sequences', /never reissued/],
    ['UPDATE case_number_sequences SET next_seq = 1', /never reissued/],
  ]) assert.throws(() => driver.run(sql), pattern, sql);
  assert.deepEqual(await caseRows(h.store), before);
  await assertCaseReadOnly(assert, h.store);
});

test('SQLite: reopening keeps cases, children, history and the next number', async t => {
  const h = await setup(t);
  await fillCases(await caseService(h.store));
  const before = await caseRows(h.store);
  assert.equal(before.length, 2);
  await h.store.close();
  const reopened = await SQLiteStore.open(h.path);
  h.defer(() => reopened.close());
  assert.deepEqual(await caseRows(reopened), before);
  assert.equal(await created(await caseService(reopened)), 'app_one-3');
});

test('SQLite: the case migration upgrades an existing v2 database once and then repeats as a no-op', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-sqlite-cases-'));
  const path = join(directory, 'synthetic.sqlite');
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  });
  // A database created before 003: only the first two migrations and their records.
  const legacy = new NodeSqliteDriver(path);
  await legacy.transaction(true, async () => {
    legacy.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;');
    for (const [index, script] of migrations.slice(0, 2).entries()) {
      legacy.run(script.sql);
      legacy.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)')
        .run(index + 1, script.name, await checksum(script.sql));
    }
  });
  await legacy.close();
  const store = await SQLiteStore.open(path);
  closers.push(() => store.close());
  await seed(store);
  await fillCases(await caseService(store));
  const before = await caseRows(store);
  const driver = new NodeSqliteDriver(path);
  closers.push(() => driver.close());
  await migrate(driver);
  await migrate(driver);
  const applied = driver.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(applied.map(({ name }) => name), ['001_initial.sql', '002_conditions.sql', '003_cases.sql',
    '004_case_member_scopes.sql']);
  for (const [index, script] of migrations.entries()) {
    assert.deepEqual({ ...applied[index] }, { version: index + 1, name: script.name, checksum: await checksum(script.sql) });
  }
  assert.deepEqual(await caseRows(store), before);
});
