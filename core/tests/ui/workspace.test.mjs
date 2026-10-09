import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountWorkspace } from '../../.build/browser/ui/workspace.js';
import { MemoryStore } from '../../.build/memory-store.js';
import { WorkspaceService } from '../../.build/service.js';
import { createHttpHandler } from '../../.build/http.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { seed, ids, uuid, principalFixtures, entity, projectData, workData, snapshot } from '../contract/fixtures.mjs';
const html = await readFile(new URL('../../.build/public/index.html', import.meta.url), 'utf8');
const origin = 'https://deskly.example';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); }
  assert.ok(predicate(), 'UI operation did not finish');
}
async function harness(t, actor = 'owner', setup) {
  const store = new MemoryStore(); await seed(store); if (setup) await setup(store);
  let active = actor, intercept = null, confirm = true;
  const signer = await createConfirmationSigner(new Uint8Array(32).fill(7));
  const service = new WorkspaceService({ store, signer, clock: { now: () => '2026-03-01T00:00:00Z' }, ids: { next: () => crypto.randomUUID() } });
  const handler = createHttpHandler({ service, origin,
    authenticator: { async authenticate() { return principalFixtures[active] ?? null; } } });
  const requests = [];
  const dom = new JSDOM(html, { url: `${origin}/` });
  const doc = dom.window.document;
  const access = [], scrolls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function(options) { scrolls.push({ id: this.id, options }); };
  const app = mountWorkspace(doc.getElementById('workspace-view'), {
    workspaceId: ids.workspace, memberId: principalFixtures[actor]?.member_id ?? ids.owner,
    now: () => new Date('2026-03-01T00:00:00Z'), confirmDiscard: () => confirm, onAccess: owner => access.push(owner),
    fetch: async (path, options = {}) => {
      assert.ok(path.startsWith(`/api/v1/workspaces/${ids.workspace}`), 'Only existing same-origin workspace API is called');
      requests.push({ path, ...options });
      const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
      if (intercept) { const response = await intercept(path, options); if (response) return response; }
      return handler(new Request(new URL(path, origin), { ...options, headers }));
    },
  });
  t.after(() => { app.destroy(); dom.window.close(); });
  await app.load();
  const text = () => doc.getElementById('workspace-message').textContent;
  const get = id => doc.getElementById(id);
  const click = (label, within = doc) => {
    const node = [...within.querySelectorAll('button')].find(node => node.textContent === label && !node.closest('[hidden]'));
    assert.ok(node, `Button not found: ${label}`); assert.equal(node.disabled, false); node.click(); return node;
  };
  const input = (name, value, within = get('workspace-form')) => {
    const control = within.querySelector(`[name="${name}"]`); assert.ok(control, `Field not found: ${name}`);
    control.value = value; control.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = (form = get('workspace-form')) => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const idle = () => until(() => !get('workspace-refresh').disabled);
  const preview = async () => { submit(); await idle(); assert.equal(get('workspace-preview').hidden, false, text()); };
  const apply = async () => { click('この内容で保存'); await idle(); assert.equal(text(), '保存しました'); };
  const detail = async (id = ids.project) => { click('全体'); click('詳細を見る', get('workspace-all').querySelector(`[data-entity-id="${id}"]`)); await idle(); };
  return { store, service, dom, doc, app, requests, access, scrolls, text, get, click, input, submit, idle, preview, apply, detail,
    actor: value => { active = value; }, intercept: value => { intercept = value; }, confirm: value => { confirm = value; } };
}

test('UI: lists authorized projects, fields and counts; search uses only permitted data', async t => {
  const h = await harness(t, 'viewer');
  assert.equal(h.get('workspace-content').hidden, false);
  assert.equal(h.doc.querySelector('[data-count="projects"] strong').textContent, '1');
  assert.equal(h.doc.querySelector('[data-count="work"] strong').textContent, '1');
  assert.equal(h.doc.querySelector('[data-count="milestones"] strong').textContent, '1');
  assert.equal(h.doc.querySelector('[data-count="unconfirmed"] strong').textContent, '1');
  assert.equal(h.doc.querySelector(`[data-entity-id="${ids.hiddenProject}"]`), null);
  assert.equal(h.get('workspace-access-tab').hidden, true);
  assert.equal(h.get('workspace-editor').hidden, true);
  assert.deepEqual(h.access, [false]);
  assert.ok(h.requests.some(r => r.path.endsWith('/project-roles/me') && r.method === undefined));
  assert.ok(![...h.doc.querySelectorAll('button')].some(b => ['案件を作成', '編集', 'アーカイブ'].includes(b.textContent)));
  h.input('query', '合成確認', h.doc.querySelector('.workspace-search')); h.submit(h.doc.querySelector('.workspace-search'));
  assert.match(h.doc.querySelector('.workspace-search-results').textContent, /1 件.*合成作業/);
  h.click('合成案件 · 合成作業', h.doc.querySelector('.workspace-search-results')); await h.idle();
  assert.equal(h.get('workspace-detail').hidden, false);
  assert.match(h.get('workspace-detail').textContent, /マイルストーン.*合成目標.*作業.*合成作業/s);
  assert.equal(h.get('workspace-detail').querySelector('[data-workspace-mutation]'), null);
  assert.ok(!h.requests.some(r => /commands|search\/|my-work|counts/.test(r.path)));
});

test('UI: project creation is preview → explicit apply, history shows before/after; no double write', async t => {
  const h = await harness(t); const before = await snapshot(h.store);
  h.click('案件を作成'); h.input('name', '合成の新しい案件'); h.input('purpose', '合成の目的を確かめる'); h.input('state', '進行中');
  await h.preview();
  assert.deepEqual(await snapshot(h.store), before);
  assert.match(h.get('workspace-diff').textContent, /— → 合成の新しい案件/);
  const request = h.requests.find(r => r.path.endsWith('/commands/preview'));
  assert.equal(JSON.parse(request.body).expected_version, null);
  const apply = h.get('workspace-apply'); apply.click(); apply.click(); await h.idle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/commands/apply')).length, 1);
  const created = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(p => p.name === '合成の新しい案件'));
  assert.equal(created.version, 1); assert.equal(created.owner_id, ids.owner);
  await h.detail(created.id);
  assert.match(h.get('workspace-detail').querySelector('[data-section="history"]').textContent, /— → 合成の新しい案件/);
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${created.id}"]`)); h.input('state', '終了');
  await h.preview(); assert.match(h.get('workspace-diff').textContent, /進行中 → 終了/); await h.apply();
  const events = await h.store.read(s => s.events.list(ids.workspace)); assert.equal(events.length, 2);
  assert.match(h.doc.querySelector('[data-section="history"]').textContent, /進行中 → 終了/);
});

test('UI: milestone and work item all fields round-trip through memory HTTP preview/apply', async t => {
  const h = await harness(t); await h.detail();
  h.click('マイルストーンを作成');
  for (const [name, value] of Object.entries({ goal: '合成の目標追加', acceptance: '合成の受入条件', assignee_id: ids.editor, check_date: '2026-03-10', state: '進行中' })) h.input(name, value);
  await h.preview(); await h.apply();
  const milestone = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(m => m.goal === '合成の目標追加'));
  assert.equal(milestone.assignee_id, ids.editor); assert.equal(milestone.state, '進行中');
  h.click('編集', h.doc.querySelector(`[data-entity-id="${milestone.id}"]`)); h.input('acceptance', '合成の修正条件'); h.input('state', '完了');
  await h.preview(); await h.apply();
  assert.equal((await h.store.read(s => s.resources.get(ids.workspace, milestone.id))).acceptance, '合成の修正条件');
  h.click('作業を作成');
  const values = { title: '合成の追加作業', kind: '営業', assignee_id: ids.editor, next_action: '合成の次の行動', check_date: '2026-03-11', waiting_reason: '合成の待ち理由', state: '待ち', milestone_id: milestone.id };
  for (const [name, value] of Object.entries(values)) h.input(name, value);
  await h.preview(); await h.apply();
  const work = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(w => w.title === values.title));
  for (const [name, value] of Object.entries(values)) assert.equal(work[name], value);
  h.click('編集', h.doc.querySelector(`[data-entity-id="${work.id}"]`)); h.input('kind', '運営'); h.input('state', '保留'); h.input('milestone_id', '');
  await h.preview(); await h.apply();
  const updated = await h.store.read(s => s.resources.get(ids.workspace, work.id));
  assert.equal(updated.kind, '運営'); assert.equal(updated.state, '保留'); assert.equal(updated.milestone_id, ''); assert.equal(updated.version, 2);
});

test('UI: archive/restore projects and both child kinds always preview before a write', async t => {
  const h = await harness(t);
  for (const id of [ids.work, ids.milestone, ids.project]) {
    await h.detail();
    const box = h.get('workspace-detail').querySelector(`[data-entity-id="${id}"]`);
    h.click('アーカイブ', box); await h.idle();
    assert.equal((await h.store.read(s => s.resources.get(ids.workspace, id))).archived, false);
    assert.match(h.get('workspace-diff').textContent, /いいえ → はい/); await h.apply();
    assert.equal((await h.store.read(s => s.resources.get(ids.workspace, id))).archived, true);
    if (id === ids.project) h.click('全体');
    const parent = h.get(id === ids.project ? 'workspace-all' : 'workspace-detail');
    h.click('アーカイブ解除', parent.querySelector(`[data-entity-id="${id}"]`)); await h.idle();
    assert.match(h.get('workspace-diff').textContent, /はい → いいえ/); await h.apply();
    assert.equal((await h.store.read(s => s.resources.get(ids.workspace, id))).archived, false);
  }
});

test('UI: my work sorts overdue/date/undated, uses workspace timezone and excludes complete/archived/other assignees', async t => {
  const h = await harness(t, 'owner', async store => store.transaction(async s => {
    await s.workspaces.put({ workspace_id: ids.workspace, name: '合成workspace', timezone: 'America/Los_Angeles', schema_version: 3 });
    for (const [n, title, check_date, state, assignee_id, archived] of [
      [201, '合成期限前', '2026-02-27', '待ち', ids.owner, false], [202, '合成当日', '2026-02-28', '未確認', ids.owner, false],
      [203, '合成日付なし', '', '保留', ids.owner, false], [204, '合成完了', '2026-02-01', '完了', ids.owner, false],
      [205, '合成他担当', '2026-02-01', '未確認', ids.editor, false], [206, '合成保管', '2026-02-01', '未確認', ids.owner, true],
    ]) await s.resources.put({ ...entity('work_item', uuid(n), workData({ title, check_date, state, assignee_id })), archived }, null);
  }));
  h.click('自分の仕事');
  const cards = [...h.get('workspace-mine').querySelectorAll('[data-entity-id]')];
  assert.equal(cards[0].dataset.entityId, uuid(201)); assert.equal(cards.at(-1).dataset.entityId, uuid(203));
  assert.equal(h.get('workspace-mine').querySelectorAll('.workspace-overdue').length, 1);
  assert.doesNotMatch(h.get('workspace-mine').textContent, /合成完了|合成他担当|合成保管/);
});

test('UI: only owner sees access, grant/revoke local preview does not write until confirmed PUT', async t => {
  const h = await harness(t); assert.equal(h.get('workspace-access-tab').hidden, false); h.click('メンバーと権限');
  const grantForm = () => h.get('workspace-access').querySelector(`[data-member-id="${ids.outsider}"] form[data-project-id="${ids.project}"]`);
  h.input('role', 'viewer', grantForm()); h.input('reason', '合成閲覧権限', grantForm());
  const before = await snapshot(h.store); h.submit(grantForm());
  assert.deepEqual(await snapshot(h.store), before); assert.equal(h.get('workspace-preview').hidden, false);
  assert.match(h.get('workspace-diff').textContent, /— → 閲覧/); await h.apply();
  let grant = await h.store.read(async s => (await s.memberships.list(ids.workspace)).find(m => m.scope === 'project' && m.project_id === ids.project && m.member_id === ids.outsider));
  assert.equal(grant.role, 'viewer'); assert.equal(grant.version, 1);
  h.input('role', 'editor', grantForm()); h.input('reason', '合成編集権限', grantForm()); h.submit(grantForm()); await h.apply();
  h.input('role', '', grantForm()); h.input('reason', '合成権限取消', grantForm()); h.submit(grantForm()); await h.apply();
  grant = await h.store.read(async s => (await s.memberships.list(ids.workspace)).find(m => m.scope === 'project' && m.project_id === ids.project && m.member_id === ids.outsider));
  assert.equal(grant.role, null); assert.equal(grant.version, 3);
  const events = await h.store.read(s => s.events.list(ids.workspace));
  assert.equal(events.filter(e => e.event_kind === 'access').length, 3);
  assert.equal(events.find(e => e.reason === '合成権限取消').after.role, null); // Current events API intentionally exposes entity history only.
  await h.detail();
  h.actor('viewer'); h.click('台帳を再読込'); await h.idle();
  assert.equal(h.get('workspace-access-tab').hidden, true); assert.equal(h.get('workspace-access').textContent, '');
  assert.equal(h.get('workspace-editor').hidden, true);
});

test('UI: 409 from actual memory CAS invalidates preview and reloads latest content; inputs never silently overwrite', async t => {
  const h = await harness(t); h.click('編集', h.get('workspace-all').querySelector(`[data-entity-id="${ids.project}"]`)); h.input('name', '合成の手元入力');
  await h.preview();
  const other = await h.service.preview(principalFixtures.owner, ids.workspace, { operation_id: uuid(601), action: 'update', type: 'project', id: ids.project,
    project_id: null, expected_version: 1, data: projectData({ name: '合成の先行更新' }), reason: '合成の同時更新' });
  await h.service.apply(principalFixtures.owner, ids.workspace, other);
  h.click('この内容で保存'); await h.idle();
  assert.match(h.text(), /他の人が先に更新しました.*台帳を再読込/);
  assert.equal(h.get('workspace-preview').hidden, true); assert.equal(h.get('workspace-form').elements.name.value, '合成の手元入力');
  h.confirm(false); h.click('台帳を再読込'); assert.equal(h.get('workspace-form').elements.name.value, '合成の手元入力');
  h.confirm(true); h.click('台帳を再読込'); await h.idle();
  assert.match(h.get('workspace-all').textContent, /合成の先行更新/); assert.equal(h.get('workspace-editor').hidden, true);
  assert.equal((await h.store.read(s => s.resources.get(ids.workspace, ids.project))).name, '合成の先行更新');
});

test('UI: permission CAS conflict retains server role and offers fresh reload', async t => {
  const h = await harness(t); h.click('メンバーと権限');
  const form = h.get('workspace-access').querySelector(`[data-member-id="${ids.viewer}"] form[data-project-id="${ids.project}"]`);
  h.input('role', 'editor', form); h.input('reason', '合成変更', form); h.submit(form);
  await h.service.setProjectMembership(principalFixtures.owner, ids.workspace, ids.project, ids.viewer,
    { operation_id: uuid(602), expected_version: 1, role: null, reason: '合成の先行取消' });
  h.click('この内容で保存'); await h.idle(); assert.match(h.text(), /他の人が先に更新しました/); assert.equal(h.get('workspace-preview').hidden, true);
  h.click('台帳を再読込'); await h.idle();
  assert.equal(h.get('workspace-access').querySelector(`[data-member-id="${ids.viewer}"] form[data-project-id="${ids.project}"] [name="role"]`).value, '');
});

test('UI: expired authentication from real API clears private views and shows Japanese 401 message', async t => {
  const h = await harness(t); assert.deepEqual(h.access, [true]); h.click('案件を作成'); h.input('name', '合成の未保存情報'); h.input('purpose', '合成目的'); await h.preview();
  h.actor(null); h.click('この内容で保存'); await h.idle();
  assert.equal(h.text(), 'ログインが必要です'); assert.equal(h.get('workspace-content').hidden, true);
  assert.equal(h.access.at(-1), false);
  assert.equal(h.get('workspace-preview').hidden, true); assert.equal(h.get('workspace-all').textContent, ''); assert.equal(h.get('workspace-fields').textContent, '');
  const unauthenticated = await harness(t, 'invalid'); assert.equal(unauthenticated.text(), 'ログインが必要です');
});

test('UI: untrusted text stays inert and raw server errors are never rendered', async t => {
  const h = await harness(t, 'owner', async store => store.transaction(async s => {
    const project = await s.resources.get(ids.workspace, ids.project);
    await s.resources.put({ ...project, version: 2, name: '<img src=x onerror=alert(1)>' }, 1);
  }));
  assert.match(h.get('workspace-all').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(h.get('workspace-all').querySelector('img'), null);
  h.click('案件を作成'); h.input('name', '合成の入力'); h.input('purpose', '合成目的');
  h.intercept(path => path.endsWith('/commands/preview') ? Response.json({ error: 'SYNTHETIC_SERVER_SECRET <script>bad()</script>' }, { status: 500 }) : null);
  h.submit(); await h.idle(); assert.match(h.text(), /通信状態/); assert.doesNotMatch(h.doc.body.textContent, /SYNTHETIC_SERVER_SECRET|bad\(\)/);
});

test('UI: changed forms, cancel/close/navigation and repeated clicks cannot apply a stale preview', async t => {
  const h = await harness(t); const before = await snapshot(h.store);
  h.click('案件を作成'); h.input('name', '合成の保存前'); h.input('purpose', '合成目的'); await h.preview();
  h.input('name', '合成の変更後'); assert.equal(h.get('workspace-preview').hidden, true);
  h.get('workspace-apply').click(); await h.idle(); assert.deepEqual(await snapshot(h.store), before);
  await h.preview(); h.click('戻る'); assert.equal(h.get('workspace-preview').hidden, true);
  h.confirm(false); h.click('編集を閉じる'); assert.equal(h.get('workspace-editor').hidden, false);
  h.click('自分の仕事'); assert.equal(h.get('workspace-mine').hidden, true);
  h.confirm(true); h.click('自分の仕事'); assert.equal(h.get('workspace-editor').hidden, true); assert.equal(h.get('workspace-preview').hidden, true);
  assert.deepEqual(await snapshot(h.store), before);
  h.click('全体'); h.click('案件を作成'); h.input('name', '合成の連続操作'); h.input('purpose', '合成目的');
  h.submit(); h.submit(); await h.idle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/commands/preview')).length, 3);
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true })); await h.idle();
  assert.equal(h.get('workspace-preview').hidden, true); assert.equal(h.get('workspace-editor').hidden, true);
  assert.deepEqual(await snapshot(h.store), before);
});

test('UI: lost apply response retries the same operation idempotently, without duplicate history', async t => {
  const h = await harness(t); h.click('案件を作成'); h.input('name', '合成の再試行案件'); h.input('purpose', '合成目的'); await h.preview();
  let first = true;
  h.intercept(async (path, options) => {
    if (path.endsWith('/commands/apply') && first) {
      first = false; await h.service.apply(principalFixtures.owner, ids.workspace, JSON.parse(options.body));
      return Response.json({ error: 'synthetic_lost_response' }, { status: 503 });
    }
    return null;
  });
  h.click('この内容で保存'); await h.idle();
  assert.match(h.text(), /通信状態/); assert.equal(h.get('workspace-preview').hidden, false);
  await h.apply();
  const applies = h.requests.filter(r => r.path.endsWith('/commands/apply'));
  assert.equal(applies.length, 2); assert.equal(applies[0].body, applies[1].body);
  const events = await h.store.read(s => s.events.list(ids.workspace)); assert.equal(events.length, 1);
});

test('UI: editor mutates only its editable project through server preview/apply; owner controls stay hidden', async t => {
  const h = await harness(t, 'editor', async store => store.transaction(s => s.memberships.put({
    scope: 'project', workspace_id: ids.workspace, project_id: ids.hiddenProject, member_id: ids.editor, role: 'viewer', version: 1,
  }, 0)));
  assert.deepEqual(h.access, [false]);
  assert.equal(h.get('workspace-access-tab').hidden, true);
  assert.match(h.get('workspace-all').textContent, /編集権限がある案件/);
  assert.ok(![...h.doc.querySelectorAll('button')].some(b => b.textContent === '案件を作成'));
  assert.ok(h.requests.some(r => r.path.endsWith('/project-roles/me') && r.method === undefined));
  const readOnlyProject = h.get('workspace-all').querySelector(`[data-entity-id="${ids.hiddenProject}"]`);
  assert.equal(readOnlyProject.querySelector('[data-workspace-mutation]'), null);
  await h.detail(ids.hiddenProject);
  assert.equal(h.get('workspace-detail').querySelector('[data-workspace-mutation]'), null);
  await h.detail();
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${ids.project}"]`));
  assert.equal(h.get('workspace-form').elements.owner_id.value, ids.owner, 'Existing owner remains available without member-directory access');
  h.input('name', '合成編集できる案件');
  const before = await snapshot(h.store); await h.preview(); assert.deepEqual(await snapshot(h.store), before); await h.apply();
  assert.equal((await h.store.read(s => s.resources.get(ids.workspace, ids.project))).name, '合成編集できる案件');
  h.click('マイルストーンを作成'); h.input('goal', '合成編集者の目標'); h.input('acceptance', '合成の確認条件');
  assert.equal(h.get('workspace-form').elements.assignee_id.value, ids.editor);
  await h.preview(); await h.apply();
  const milestone = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(item => item.goal === '合成編集者の目標'));
  assert.equal(milestone.assignee_id, ids.editor);
  h.click('作業を作成'); h.input('title', '合成編集者の作業'); h.input('next_action', '合成の次の確認');
  h.input('milestone_id', milestone.id); await h.preview(); await h.apply();
  const work = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(item => item.title === '合成編集者の作業'));
  assert.equal(work.assignee_id, ids.editor); assert.equal(work.milestone_id, milestone.id);
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${work.id}"]`));
  h.input('next_action', '合成編集済み'); await h.preview(); await h.apply();
  assert.equal((await h.store.read(s => s.resources.get(ids.workspace, work.id))).next_action, '合成編集済み');
  for (const id of [work.id, milestone.id, ids.project]) {
    await h.detail();
    h.click('アーカイブ', h.get('workspace-detail').querySelector(`[data-entity-id="${id}"]`)); await h.idle(); await h.apply();
    assert.equal((await h.store.read(s => s.resources.get(ids.workspace, id))).archived, true);
    if (id === ids.project) h.click('全体');
    h.click('アーカイブ解除', h.get(id === ids.project ? 'workspace-all' : 'workspace-detail').querySelector(`[data-entity-id="${id}"]`));
    await h.idle(); await h.apply();
    assert.equal((await h.store.read(s => s.resources.get(ids.workspace, id))).archived, false);
  }
  assert.ok(!h.requests.some(r => r.method === 'PUT' || r.path.includes('/contacts')));
});

test('UI: editor revocation between preview and apply is rejected and clears stale mutation controls', async t => {
  const h = await harness(t, 'editor'); await h.detail();
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${ids.work}"]`)); h.input('title', '合成保存してはいけない作業');
  await h.preview();
  await h.service.setProjectMembership(principalFixtures.owner, ids.workspace, ids.project, ids.editor,
    { operation_id: uuid(603), expected_version: 1, role: null, reason: '合成編集権限の取消' });
  const revoked = await snapshot(h.store);
  h.click('この内容で保存'); await h.idle();
  assert.match(h.text(), /権限がないか/);
  assert.equal(h.get('workspace-preview').hidden, true); assert.equal(h.get('workspace-editor').hidden, true);
  assert.equal(h.doc.querySelector('[data-workspace-mutation]'), null); assert.equal(h.access.at(-1), false);
  assert.deepEqual(await snapshot(h.store), revoked);
  const applies = h.requests.filter(r => r.path.endsWith('/commands/apply')).length;
  h.get('workspace-apply').click(); await h.idle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/commands/apply')).length, applies);
  h.click('台帳を再読込'); await h.idle();
  assert.equal(h.doc.querySelector(`[data-entity-id="${ids.project}"]`), null);
  assert.match(h.get('workspace-all').textContent, /表示できる案件はありません/);
});

test('UI: editor downgrade before preview is denied by the API and reload shows viewer-only controls', async t => {
  const h = await harness(t, 'editor'); await h.detail();
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${ids.project}"]`)); h.input('name', '合成拒否された更新');
  await h.service.setProjectMembership(principalFixtures.owner, ids.workspace, ids.project, ids.editor,
    { operation_id: uuid(604), expected_version: 1, role: 'viewer', reason: '合成閲覧への変更' });
  const downgraded = await snapshot(h.store); h.submit(); await h.idle();
  assert.match(h.text(), /権限がないか/); assert.equal(h.get('workspace-preview').hidden, true);
  assert.deepEqual(await snapshot(h.store), downgraded);
  h.click('台帳を再読込'); await h.idle();
  assert.match(h.get('workspace-all').textContent, /閲覧モード/);
  assert.equal(h.doc.querySelector('[data-workspace-mutation]'), null);
  assert.ok(h.doc.querySelector(`[data-entity-id="${ids.project}"]`));
});

test('UI: preview and history put meaningful fields first with identity/version metadata collapsed', async t => {
  const h = await harness(t); h.click('案件を作成'); h.input('name', '合成確認しやすい案件'); h.input('purpose', '合成確認しやすい目的');
  await h.preview();
  const diff = h.get('workspace-diff'), metadata = diff.querySelector('details');
  const primaryLabels = [...diff.children].filter(node => node.tagName === 'DT').map(node => node.textContent);
  assert.deepEqual(primaryLabels, ['名前', '目的', '主担当', '状態', 'アーカイブ', '管理情報']);
  assert.equal(metadata.open, false); assert.equal(metadata.querySelector('summary').textContent, 'ID・版番号など');
  assert.match(metadata.textContent, /ID.*workspace ID.*案件 ID.*版番号.*種類/s);
  assert.match(metadata.textContent, new RegExp(ids.workspace));
  assert.match(diff.querySelector('dd').textContent, /— → 合成確認しやすい案件/);
  await h.apply();
  const created = await h.store.read(async s => (await s.resources.list(ids.workspace)).find(item => item.name === '合成確認しやすい案件'));
  await h.detail(created.id);
  const history = h.get('workspace-detail').querySelector('[data-section="history"]');
  assert.equal(history.querySelector('details').open, false);
  assert.equal(history.querySelector('dl > dt').textContent, '名前');
  h.click('編集', h.get('workspace-detail').querySelector(`[data-entity-id="${created.id}"]`)); h.input('state', '終了');
  await h.preview();
  assert.equal(h.get('workspace-diff').querySelector('dt').textContent, '状態');
  assert.match(h.get('workspace-diff').querySelector('details').textContent, /版番号1 → 2/);
});

test('UI: editors focus and scroll to meaningful input and preview; sibling navigation protects unsaved work', async t => {
  const h = await harness(t, 'editor'); await h.detail(); h.click('作業を作成');
  assert.equal(h.doc.activeElement, h.get('workspace-form').elements.title);
  assert.deepEqual(h.scrolls.at(-1), { id: 'workspace-editor', options: { block: 'start' } });
  h.input('title', '合成フォーカス作業'); h.input('next_action', '合成確認');
  h.confirm(false); assert.equal(h.app.canNavigate(), false); assert.equal(h.get('workspace-editor').hidden, false);
  await h.preview();
  assert.equal(h.doc.activeElement, h.get('workspace-preview'));
  assert.deepEqual(h.scrolls.at(-1), { id: 'workspace-preview', options: { block: 'start' } });
  h.click('戻る'); assert.equal(h.doc.activeElement, h.get('workspace-form').elements.title);
  assert.deepEqual(h.scrolls.at(-1), { id: 'workspace-editor', options: { block: 'start' } });
  h.confirm(true); assert.equal(h.app.canNavigate(), true);
  assert.equal(h.get('workspace-editor').hidden, true); assert.equal(h.get('workspace-preview').hidden, true);
  assert.ok(!h.requests.some(r => r.path.endsWith('/commands/apply')));
});

test('UI: sibling navigation cannot interrupt an in-flight preview', async t => {
  const h = await harness(t, 'editor'); await h.detail(); h.click('作業を作成');
  h.input('title', '合成読込中の作業'); h.input('next_action', '合成確認');
  let release;
  h.intercept(path => path.endsWith('/commands/preview') ? new Promise(resolve => { release = () => resolve(null); }) : null);
  h.submit(); assert.equal(h.get('workspace-refresh').disabled, true);
  assert.equal(h.app.canNavigate(), false); assert.equal(h.get('workspace-editor').hidden, false);
  release(); await h.idle(); assert.equal(h.get('workspace-preview').hidden, false);
});

test('UI: refreshed current-role identity supplies the editor self-assignee rather than stale HTML context', async t => {
  const h = await harness(t); h.actor('editor'); h.click('台帳を再読込'); await h.idle();
  assert.equal(h.access.at(-1), false); await h.detail(); h.click('作業を作成');
  assert.equal(h.get('workspace-form').elements.assignee_id.value, ids.editor);
  assert.equal(h.get('workspace-form').elements.assignee_id.selectedOptions[0].textContent, '自分');
  assert.equal(h.doc.querySelector(`[data-entity-id="${ids.hiddenProject}"]`), null);
});

test('UI: BFCache restore during a pending request queues a fresh permission load', async t => {
  const h = await harness(t, 'editor'); await h.detail(); h.click('作業を作成');
  h.input('title', '合成復帰前の作業'); h.input('next_action', '合成確認');
  let release;
  h.intercept(path => path.endsWith('/commands/preview') ? new Promise(resolve => { release = () => resolve(null); }) : null);
  h.submit();
  const reads = h.requests.filter(r => r.path.endsWith('/project-roles/me')).length;
  h.actor('viewer'); h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(h.get('workspace-editor').hidden, true); release(); await h.idle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/project-roles/me')).length, reads + 1);
  assert.equal(h.get('workspace-preview').hidden, true); assert.equal(h.doc.querySelector('[data-workspace-mutation]'), null);
  assert.match(h.get('workspace-all').textContent, /閲覧モード/);
});
