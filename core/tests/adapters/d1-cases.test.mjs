import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { createD1Harness } from './d1-harness.mjs';
import { D1Store } from '../../.build/adapters/d1/store.js';
import { migrate } from '../../.build/adapters/d1/migrate.js';
import { migrations, checksum, statements } from '../../.build/adapters/sql/migrations.js';
import { ConflictError } from '../../.build/ports.js';
import { assertCaseReadOnly, caseEvent, caseRecord, caseRows, caseService, fillCases, newCase, app, writeCase } from './case-fixtures.mjs';
import { ids, seed } from '../contract/fixtures.mjs';

async function setup(t) {
  const h = await createD1Harness(); t.after(() => h.close()); await seed(h.store); return h;
}
/** A Miniflare D1 kept in memory, or persisted under a temporary folder to survive a restart. */
const runtimeAt = persist => new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("synthetic"); } }',
  compatibilityDate: '2026-07-01', d1Databases: ['DB'], ...(persist ? { d1Persist: persist } : {}) });
function gate() {
  let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release };
}
const conflict = error => error instanceof ConflictError && error.status === 409 && error.code === 'version_conflict';
const duplicate = error => error instanceof ConflictError && error.code === 'duplicate_id';
const created = async (cases, overrides) => (await cases.create(app('app_one'), ids.workspace, newCase(overrides))).number;
const bySeq = (a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]);
const issued = count => Array.from({ length: count }, (_, index) => `app_one-${index + 1}`);
/** Two adapters on one database both take their snapshot, then both try to commit. */
async function race(h, write) {
  const ready = gate(); let arrivals = 0;
  const run = store => store.transaction(async tx => write(tx, async () => { if (++arrivals === 2) ready.release(); await ready.wait; }));
  return Promise.allSettled([run(h.store), run(new D1Store(h.database))]);
}

test('D1: concurrent creations on one adapter are consecutive; racing adapters have one winner and no gap', async t => {
  const h = await setup(t);
  const cases = await caseService(h.store);
  const numbers = await Promise.all(Array.from({ length: 8 }, (_, index) => created(cases, { title: `合成の並行 ${index}` })));
  assert.deepEqual([...numbers].sort(bySeq), issued(8));
  const results = await race(h, async (tx, arrive) => {
    const seq = await tx.cases.allocate(ids.workspace, 'app_one');
    await arrive();
    const record = caseRecord(seq);
    await tx.cases.put(record, null);
    await tx.cases.appendEvent(caseEvent(record.number));
    return record.number;
  });
  assert.deepEqual(results.filter(r => r.status === 'fulfilled').map(r => r.value), ['app_one-9']);
  assert.ok(conflict(results.find(r => r.status === 'rejected').reason));
  assert.equal(await created(cases), 'app_one-10', 'the losing adapter consumed no number');
  const rows = await caseRows(h.store);
  assert.deepEqual(rows.map(({ row }) => row.number).sort(bySeq), issued(10));
  assert.ok(rows.every(({ events }) => events.length === 1));
});

test('D1: a rolled-back creation issues no number and leaves no row behind', async t => {
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

test('D1: (source, legacy_ref) is unique across racing adapters, in the port and in the database', async t => {
  const h = await setup(t);
  const cases = await caseService(h.store);
  const first = await created(cases, { legacy_ref: 'legacy-1' });
  assert.equal(await created(cases, { legacy_ref: 'legacy-1' }), first);
  await assert.rejects(h.store.transaction(tx => writeCase(tx, { legacy_ref: 'legacy-1' })), duplicate);
  const results = await race(h, async (tx, arrive) => {
    assert.equal(await tx.cases.findByLegacyRef(ids.workspace, 'app_one', 'legacy-2'), null);
    await arrive();
    return writeCase(tx, { legacy_ref: 'legacy-2' });
  });
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(conflict(results.find(r => r.status === 'rejected').reason));
  const rawCase = (number, seq, legacy) => h.database.prepare(`INSERT INTO cases(workspace_id, number, source, seq, legacy_ref, revision, data)
    VALUES (?, ?, 'app_one', ?, ?, 1, '{}')`).bind(ids.workspace, number, seq, legacy);
  const step = h.database.prepare("UPDATE case_number_sequences SET next_seq = next_seq + 1 WHERE source = 'app_one'");
  await assert.rejects(h.database.batch([step, rawCase('app_one-3', 3, 'legacy-1')]), /UNIQUE/);
  await assert.rejects(h.database.batch([rawCase('app_one-99', 99, null)]), /issued by the ledger/);
  const rows = await caseRows(h.store);
  assert.deepEqual(rows.map(({ row }) => [row.number, row.legacy_ref]), [[first, 'legacy-1'], ['app_one-2', 'legacy-2']]);
  assert.equal(await created(cases), 'app_one-3', 'the rejected raw batch rolled back its sequence step');
});

test('D1: case history is append-only and cases and numbers cannot be removed by the database', async t => {
  const h = await setup(t);
  await fillCases(await caseService(h.store));
  const before = await caseRows(h.store);
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
  ]) await assert.rejects(h.database.batch([h.database.prepare(sql)]), pattern, sql);
  assert.deepEqual(await caseRows(h.store), before);
  await assertCaseReadOnly(assert, h.store);
});

test('D1: a restarted runtime on the same persisted database keeps cases, history and the next number', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-d1-cases-'));
  let runtime = runtimeAt(directory);
  t.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const first = await D1Store.open(await runtime.getD1Database('DB'));
  await seed(first);
  await fillCases(await caseService(first));
  const before = await caseRows(first);
  assert.equal(before.length, 2);
  await runtime.dispose();
  runtime = runtimeAt(directory);
  const reopened = await D1Store.open(await runtime.getD1Database('DB'));
  assert.deepEqual(await caseRows(reopened), before);
  assert.equal(await created(await caseService(reopened)), 'app_one-3');
});

test('D1: the case migration upgrades an existing v2 database once and then repeats as a no-op', async t => {
  const runtime = runtimeAt();
  t.after(() => runtime.dispose());
  const database = await runtime.getD1Database('DB');
  // A database created before 003: only the first two migrations and their records.
  await database.batch([database.prepare(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;`)]);
  for (const [index, script] of migrations.slice(0, 2).entries()) {
    await database.batch([...statements(script.sql).map(sql => database.prepare(sql)),
      database.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)')
        .bind(index + 1, script.name, await checksum(script.sql))]);
  }
  const store = await D1Store.open(database);
  await seed(store);
  await fillCases(await caseService(store));
  const before = await caseRows(store);
  await migrate(database);
  await migrate(database);
  const applied = (await database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()).results;
  assert.deepEqual(applied.map(({ name }) => name), ['001_initial.sql', '002_conditions.sql', '003_cases.sql',
    '004_case_member_scopes.sql']);
  for (const [index, script] of migrations.entries()) {
    assert.deepEqual(applied[index], { version: index + 1, name: script.name, checksum: await checksum(script.sql) });
  }
  assert.deepEqual(await caseRows(store), before);
});
