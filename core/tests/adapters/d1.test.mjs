import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1Harness } from './d1-harness.mjs';
import { D1Store } from '../../.build/adapters/d1/store.js';
import { migrate } from '../../.build/adapters/d1/migrate.js';
import { migrations, checksum } from '../../.build/adapters/sql/migrations.js';
import { ConflictError } from '../../.build/ports.js';
import { clockTime, ids, seed, snapshot, uuid } from '../contract/fixtures.mjs';
const event = (before, after, operation) => ({ event_kind: 'entity', workspace_id: ids.workspace,
  operation_id: uuid(operation), entity_id: after.id, member_id: ids.owner, requester_member_id: ids.owner,
  route: 'dashboard', executor_kind: 'unknown', executor_ref: null, executor_verified: false,
  reason: '合成検査', at_utc: clockTime, before, after, changes: [] });
async function setup(t) {
  const h = await createD1Harness(); t.after(() => h.close()); await seed(h.store); return h;
}
function gate() {
  let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release };
}
const conflict = error => error instanceof ConflictError && error.status === 409 && error.code === 'version_conflict';

test('D1: two independent adapters racing on one snapshot have one winner, one event, and no skipped version', async t => {
  const h = await setup(t); const other = new D1Store(h.database); const ready = gate(); let arrivals = 0;
  const write = (store, operation) => store.transaction(async tx => {
    const before = await tx.resources.get(ids.workspace, ids.work);
    if (++arrivals === 2) ready.release(); await ready.wait;
    const after = { ...before, version: before.version + 1, title: '合成競合' };
    await tx.resources.put(after, before.version); await tx.events.append(event(before, after, operation));
  });
  const results = await Promise.allSettled([write(h.store, 7001), write(other, 7002)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(conflict(results.find(r => r.status === 'rejected').reason));
  const row = await h.store.read(tx => tx.resources.get(ids.workspace, ids.work));
  const events = await h.store.read(tx => tx.events.list(ids.workspace));
  assert.equal(row.version, 2); assert.equal(events.length, 1); assert.deepEqual(events[0].after, row);
});

test('D1: failed CAS condition after entity and history writes rolls the entire batch back', async t => {
  const h = await setup(t); const before = await snapshot(h.store);
  // Inject a late zero-row CAS through the narrow prepare port. The real D1
  // batch first executes one entity update and its event, then must undo both.
  let armed = false;
  const driver = {
    prepare: sql => h.database.prepare(armed && sql.startsWith('UPDATE resources')
      ? sql.replace('AND version = ?', 'AND version = (? + 100)') : sql),
    batch: statements => h.database.batch(statements),
  };
  await assert.rejects(new D1Store(driver).transaction(async tx => {
    const row = await tx.resources.get(ids.workspace, ids.work);
    const after = { ...row, version: 2, title: '合成取り消し' };
    await tx.resources.put(after, 1); await tx.events.append(event(row, after, 7010));
    armed = true;
    const second = await tx.resources.get(ids.workspace, ids.milestone);
    await tx.resources.put({ ...second, version: 2 }, 1);
  }), conflict);
  assert.deepEqual(await snapshot(h.store), before);
  assert.equal((await h.database.prepare('SELECT COUNT(*) AS count FROM store_conditions').first()).count, 0);
});

test('D1: permission revocation between read and commit reject every buffered write', async t => {
  const h = await setup(t); const started = gate(); const finish = gate(); let calls = 0;
  const pending = h.store.transaction(async tx => {
    calls++;
    const members = await tx.memberships.list(ids.workspace); assert.ok(members.length);
    const before = await tx.resources.get(ids.workspace, ids.work);
    await tx.resources.put({ ...before, version: 2 }, 1);
    await tx.events.append(event(before, { ...before, version: 2 }, 7020)); started.release(); await finish.wait;
  });
  await started.wait;
  await new D1Store(h.database).transaction(async tx => {
    const member = (await tx.memberships.list(ids.workspace)).find(m => m.scope === 'project' && m.member_id === ids.editor);
    await tx.memberships.put({ ...member, role: null, version: 2 }, 1);
  });
  finish.release(); await assert.rejects(pending, conflict); assert.equal(calls, 1);
  assert.equal((await h.store.read(tx => tx.resources.get(ids.workspace, ids.work))).version, 1);
  assert.equal((await h.store.read(tx => tx.events.list(ids.workspace))).length, 0);
});

test('D1: shared migrations are idempotent and verify every name/version/checksum', async t => {
  const h = await setup(t); const before = await snapshot(h.store);
  await migrate(h.database); await migrate(h.database); assert.deepEqual(await snapshot(h.store), before);
  const applied = (await h.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all()).results;
  assert.equal(applied.length, migrations.length);
  for (const [index, migration] of migrations.entries()) assert.deepEqual(applied[index], {
    version: index + 1, name: migration.name, checksum: await checksum(migration.sql),
  });
  await h.database.batch([h.database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').bind('synthetic-mismatch')]);
  await assert.rejects(migrate(h.database), /migration history/); assert.deepEqual(await snapshot(h.store), before);
});

test('D1: read snapshots stay immutable across concurrent commits and sessions expire', async t => {
  const h = await setup(t); let escaped;
  await h.store.read(async tx => {
    escaped = tx; const before = await tx.resources.get(ids.workspace, ids.work);
    await new D1Store(h.database).transaction(async other => other.resources.put({ ...before, version: 2 }, 1));
    assert.deepEqual(await tx.resources.get(ids.workspace, ids.work), before);
    for (const port of ['workspaces', 'accounts', 'resources', 'memberships', 'contacts']) await assert.rejects(tx[port].put({}, null), /immutable/);
    for (const port of ['events', 'contacts']) await assert.rejects(tx[port].append({}), /immutable/);
  });
  await assert.rejects(escaped.resources.list(ids.workspace), /closed/);
});

test('D1: inserting a previously absent list member invalidates the committing snapshot', async t => {
  const h = await setup(t); const started = gate(); const finish = gate();
  const pending = h.store.transaction(async tx => {
    await tx.resources.list(ids.workspace);
    assert.equal(await tx.resources.get(ids.workspace, uuid(7999)), null);
    const row = await tx.resources.get(ids.workspace, ids.work);
    await tx.resources.put({ ...row, version: 2 }, 1); started.release(); await finish.wait;
  });
  await started.wait;
  await new D1Store(h.database).transaction(async tx => {
    const row = await tx.resources.get(ids.workspace, ids.work);
    await tx.resources.put({ ...row, id: uuid(7999), version: 1 }, null);
  });
  finish.release(); await assert.rejects(pending, conflict);
  assert.equal((await h.store.read(tx => tx.resources.get(ids.workspace, ids.work))).version, 1);
  assert.equal((await h.store.read(tx => tx.resources.get(ids.workspace, uuid(7999)))).version, 1);
});
