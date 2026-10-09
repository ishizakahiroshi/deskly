import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertPersonal, mappedId, runCli } from '../scripts/migrate-legacy-personal.mjs';
import { SQLiteStore } from '../.build/adapters/sqlite/store.js';
import * as v from '../.build/service-validation.js';
import { WorkspaceService } from '../.build/service.js';
import { createConfirmationSigner } from '../.build/confirmation.js';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const config = { workspace_id: uuid(1), member_id: uuid(2), account_subject: uuid(3), name: '合成個人', login: 'synthetic', identity: { issuer: 'https://access.example', subject: 'synthetic-owner' } };
const at = '2026-10-03T00:00:00.000Z';
function fixture() {
  const meta = { version: 2, created_at: at, updated_at: at, updated_by: 'synthetic-owner' };
  return { format: 'deskly-personal-d1-v2', exported_at: at,
    projects: [{ ...meta, id: 10, name: "合成'案件", purpose: '合成目的', scope: 'hybrid', repository_url: 'https://example.com/repo' }],
    milestones: [{ ...meta, id: 11, project_id: 10, goal: '合成目標', acceptance: '合成条件', check_date: '', state: '未確認' }],
    work_items: [{ ...meta, id: 12, project_id: 10, milestone_id: 11, title: '合成作業', next_action: '合成行動', check_date: '2026-10-04', state: '進行中' }],
    events: [{ id: 1, entity_type: 'project', entity_id: 10, operation: 'create', actor: 'synthetic-old-owner', at_utc: at, before_json: null, after_json: '{"scope":"personal"}' }] };
}
test('lossless raw history, deterministic relationships, runtime validation and SQLiteStore readback', async t => {
  const directory = await mkdtemp(join(tmpdir(),'deskly-migration-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const original = JSON.stringify(fixture(),null,2)+'\n';
  const result = await convertPersonal(original,config);
  const path = join(directory,'new.sqlite3');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON;'); db.exec(result.sql);
    assert.equal(db.prepare('SELECT raw_text FROM legacy_personal_export').get().raw_text,original);
    const raw = db.prepare("SELECT raw_json,sha256 FROM legacy_personal_rows WHERE table_name='events'").get();
    assert.deepEqual(JSON.parse(raw.raw_json),fixture().events[0]);
    assert.equal(raw.sha256,createHash('sha256').update(raw.raw_json).digest('hex'));
    assert.throws(() => db.exec('UPDATE legacy_personal_rows SET raw_json=raw_json'),/append-only/);
    assert.throws(() => db.exec('DELETE FROM legacy_personal_export'),/append-only/);
    assert.throws(() => db.exec('INSERT OR REPLACE INTO legacy_personal_export SELECT * FROM legacy_personal_export'),/append-only/);
    assert.throws(() => db.exec(result.sql),/already exists/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
  const store = await SQLiteStore.open(path);
  try {
    const rows = await store.read(s => s.resources.list(config.workspace_id));
    assert.equal(rows.length,4);
    rows.forEach(row => v.entity(row,config.workspace_id));
    const work = rows.find(r=>r.type==='work_item');
    assert.equal(work.project_id,mappedId('projects',10));
    assert.equal(work.milestone_id,mappedId('milestones',11));
    assert.equal(rows.find(r=>r.type==='reference').target,'https://example.com/repo');
    assert.equal((await store.read(s=>s.events.list(config.workspace_id))).length,3);
    const service = new WorkspaceService({ store, signer: await createConfirmationSigner(new TextEncoder().encode('synthetic-key-for-migration-tests-32-bytes')), clock: { now: ()=>at }, ids: { next: ()=>uuid(99) } });
    const owner = { workspace_id: config.workspace_id, member_id: config.member_id, account_subject: config.account_subject, role: 'owner', active: true };
    assert.equal((await service.workspace(owner,config.workspace_id)).schema_version,3);
    assert.equal((await service.account(owner)).subject,config.account_subject);
    assert.equal((await service.projects(owner,config.workspace_id)).projects.length,1);
    const projectId=mappedId('projects',10);
    assert.equal((await service.events(owner,config.workspace_id,projectId)).events.length,3);
    assert.deepEqual((await store.read(s=>s.memberships.list(config.workspace_id)))[0].identity,config.identity);
    const project=rows.find(r=>r.type==='project');
    const preview=await service.preview(owner,config.workspace_id,{operation_id:uuid(100),action:'update',type:'project',id:project.id,project_id:null,expected_version:project.version,data:{name:project.name,purpose:project.purpose,owner_id:project.owner_id,state:project.state},reason:'合成確認'});
    assert.equal(preview.after.version,3);
  } finally { await store.close(); }
  assert.equal((await convertPersonal(original,config)).sql,result.sql);
});
test('UUID projects retain identity while derived references use a separate namespace', async () => {
  const b=fixture(); const projectId=uuid(10).toUpperCase();
  b.projects[0].id=projectId; b.milestones[0].project_id=projectId; b.work_items[0].project_id=projectId;
  const result=await convertPersonal(JSON.stringify(b),config);
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(result.sql);
    const rows=db.prepare('SELECT id,type FROM resources').all();
    assert.equal(rows.find(r=>r.type==='project').id,projectId.toLowerCase());
    assert.notEqual(rows.find(r=>r.type==='reference').id,projectId.toLowerCase());
  } finally { db.close(); }
});
test('invalid relations, duplicate IDs, and incompatible values fail before SQL output', async () => {
  const cases = [b=>b.work_items[0].milestone_id=999,b=>b.projects.push({...b.projects[0]}),b=>b.projects[0].purpose='',b=>b.projects[0].name='x'.repeat(161),b=>b.milestones[0].state='invalid'];
  for (const mutate of cases) { const b=fixture(); mutate(b); await assert.rejects(convertPersonal(JSON.stringify(b),config)); }
  await assert.rejects(convertPersonal(JSON.stringify(fixture()),{...config,identity:{...config.identity,extra:'invalid'}}));
});
test('CLI preserves input bytes, refuses overwrite and repository outputs', async t => {
  const directory = await mkdtemp(join(tmpdir(),'deskly-migration-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const input=join(directory,'input.json'), settings=join(directory,'config.json'), output=join(directory,'new.sql');
  const text=JSON.stringify(fixture()); await writeFile(input,text); await writeFile(settings,JSON.stringify(config));
  const result=await runCli([input,settings,output]);
  assert.equal(result.counts.events,1); assert.equal(await readFile(input,'utf8'),text);
  await assert.rejects(runCli([input,settings,output]),{code:'EEXIST'});
  await assert.rejects(runCli([input,settings,fileURLToPath(new URL('../rejected.sql',import.meta.url))]),/output_must_be_outside_repository/);
});
