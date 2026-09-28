const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const base = join(__dirname, '..');
const script = join(base, 'restore-json.mjs');
const migrations = ['0001_init.sql', '0002_milestones.sql'].map((name) =>
  readFileSync(join(base, 'migrations', name), 'utf8'));
const backup = {
  format: 'deskly-personal-d1-v2',
  exported_at: '2026-09-28T00:00:00.000Z',
  projects: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic project',
    purpose: 'Synthetic purpose', repository_url: '', scope: 'personal', version: 1,
    created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z',
    updated_by: 'synthetic-owner' }],
  milestones: [{ id: '22222222-2222-4222-8222-222222222222',
    project_id: '11111111-1111-4111-8111-111111111111', goal: 'Synthetic goal',
    acceptance: '', check_date: '', state: '未確認', version: 1,
    created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z',
    updated_by: 'synthetic-owner' }],
  work_items: [{ id: '33333333-3333-4333-8333-333333333333',
    project_id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic action',
    next_action: 'Synthetic next step', check_date: '', state: '進行中', version: 1,
    created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z',
    updated_by: 'synthetic-owner', milestone_id: '22222222-2222-4222-8222-222222222222' }],
  events: [{ id: 1, entity_type: 'project', entity_id: '11111111-1111-4111-8111-111111111111',
    operation: 'create', actor: 'synthetic-owner', at_utc: '2026-09-28T00:00:00.000Z',
    before_json: null, after_json: '{"name":"Synthetic project"}' }],
};

function createDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrations) db.exec(migration);
  return db;
}

function withRestoreSql(run) {
  const dir = mkdtempSync(join(tmpdir(), 'deskly-restore-test-'));
  try {
    const input = join(dir, 'backup.json');
    const output = join(dir, 'restore.sql');
    writeFileSync(input, JSON.stringify(backup), { flag: 'wx' });
    const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    run(readFileSync(output, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('restore succeeds against an empty migrated database and preserves its snapshot', () => {
  withRestoreSql((sql) => {
    const db = createDb();
    try {
      db.exec(sql);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_items').get().n, 1);
      assert.deepEqual(db.prepare('SELECT id, actor, after_json FROM events').all().map((row) => ({ ...row })),
        [{ id: 1, actor: 'synthetic-owner', after_json: '{"name":"Synthetic project"}' }]);
      assert.equal(db.prepare('SELECT milestone_id FROM work_items').get().milestone_id,
        '22222222-2222-4222-8222-222222222222');
    } finally { db.close(); }
  });
});

test('restore rejects a database with project data before changing any table', () => {
  withRestoreSql((sql) => {
    const db = createDb();
    try {
      db.prepare(`INSERT INTO projects(id,name,scope,created_at,updated_at,updated_by)
        VALUES(?,?,?,?,?,?)`).run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Existing project',
        'personal', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z', 'existing-owner');
      const before = Object.fromEntries(['projects', 'milestones', 'work_items', 'events'].map((table) =>
        [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
      assert.throws(() => db.exec(sql), /UNIQUE constraint failed/);
      const after = Object.fromEntries(['projects', 'milestones', 'work_items', 'events'].map((table) =>
        [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
      assert.deepEqual(after, before);
    } finally { db.close(); }
  });
});

test('restore rejects event-only data before inserting backup rows or deleting history', () => {
  withRestoreSql((sql) => {
    const db = createDb();
    try {
      db.prepare(`INSERT INTO events(id,entity_type,entity_id,operation,actor,at_utc,before_json,after_json)
        VALUES(?,?,?,?,?,?,?,?)`).run(77, 'project', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'create', 'existing-owner', '2026-09-27T00:00:00.000Z', null, '{"name":"Existing"}');
      const before = Object.fromEntries(['projects', 'milestones', 'work_items', 'events'].map((table) =>
        [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((row) => ({ ...row }))]));
      assert.throws(() => db.exec(sql), /UNIQUE constraint failed/);
      const after = Object.fromEntries(['projects', 'milestones', 'work_items', 'events'].map((table) =>
        [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((row) => ({ ...row }))]));
      assert.deepEqual(after, before);
    } finally { db.close(); }
  });
});
