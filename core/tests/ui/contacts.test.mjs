import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountContacts, mountDeskly } from '../../.build/browser/ui/main.js';
import { MemoryStore } from '../../.build/memory-store.js';
import { WorkspaceService } from '../../.build/service.js';
import { createHttpHandler } from '../../.build/http.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { seed, ids, contacts, contactData, principalFixtures, snapshot, uuid } from '../contract/fixtures.mjs';
const html = await readFile(new URL('../../.build/public/index.html', import.meta.url), 'utf8');
const origin = 'https://deskly.example';
const ledger = `/api/v1/workspaces/${ids.workspace}/sources/${ids.source}`;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.ok(predicate(), 'UI did not settle'); }
async function harness(t, actor = 'owner', setup) {
  const store = new MemoryStore(); await seed(store); if (setup) await setup(store);
  let active = actor, intercept = null, confirm = true;
  const signer = await createConfirmationSigner(new Uint8Array(32).fill(7));
  const service = new WorkspaceService({ store, signer, clock: { now: () => '2026-03-01T00:00:00Z' }, ids: { next: () => crypto.randomUUID() } });
  const handler = createHttpHandler({ service, origin, authenticator: { async authenticate() { return principalFixtures[active] ?? null; } } });
  const dom = new JSDOM(html, { url: `${origin}/` }), doc = dom.window.document;
  const root = doc.getElementById('contact-view'); const requests = [], access = [];
  const app = mountContacts(root, { workspaceId: ids.workspace, confirmDiscard: () => confirm,
    onAccess: owner => access.push(owner), fetch: async (path, options = {}) => {
      assert.ok(path === '/api/v1/accounts/me' || path.startsWith(`/api/v1/workspaces/${ids.workspace}/`));
      requests.push({ path, ...options });
      if (intercept) { const result = await intercept(path, options); if (result) return result; }
      const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
      return handler(new Request(new URL(path, origin), { ...options, headers }));
    } });
  t.after(() => { app.destroy(); dom.window.close(); });
  const get = id => doc.getElementById(`contact-${id}`);
  const input = (name, value, form = get('form')) => {
    const node = form.querySelector(`[name="${name}"]`); assert.ok(node, `Missing input ${name}`);
    node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const click = (label, parent = root) => {
    const node = [...parent.querySelectorAll('button')].find(b => b.textContent === label && !b.closest('[hidden]'));
    assert.ok(node, `Missing button ${label}`); assert.equal(node.disabled, false); node.click(); return node;
  };
  const submit = (form = get('form')) => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const idle = () => until(() => root.getAttribute('aria-busy') !== 'true');
  const load = async () => { input('source', ids.source, get('source-form')); submit(get('source-form')); await idle(); };
  const detail = async (id = contacts.normal) => { click('連絡の詳細', get('rows').querySelector(`[data-contact-id="${id}"]`)); await idle(); };
  const preview = async () => { submit(); await idle(); assert.equal(get('preview').hidden, false, get('message').textContent); };
  const apply = async () => { click('この連絡を保存'); await idle(); assert.equal(get('message').textContent, '保存しました'); };
  await app.open();
  return { store, service, dom, doc, root, app, get, input, click, submit, idle, load, detail, preview, apply, requests, access,
    actor: a => { active = a; }, intercept: i => { intercept = i; }, confirm: c => { confirm = c; } };
}

async function insert(store, rows) {
  await store.transaction(async tx => {
    for (const [id, fields] of rows) await tx.contacts.put({ workspace_id: ids.workspace, source_id: ids.source,
      version: 1, contact: contactData(id, fields) }, null);
  });
}

test('contacts: owner waiting rows preserve Python API grouping/order, overdue and summaries privacy', async t => {
  const h = await harness(t, 'owner', store => insert(store, [
    ['c-20260101-00000101', { project: '合成期限切れ', due: '2026-02-20', state: '対応中' }],
    ['c-20260101-00000102', { project: '合成期限切れ', due: '2026-02-25', state: '下書き' }],
    ['c-20260101-00000103', { project: '合成将来', due: '2026-04-01', state: '下書き' }],
    ['c-20260101-00000104', { project: '合成相手', due: '2026-02-01', state: '回答待ち' }],
    ['c-20260101-00000105', { project: '', state: '対応中' }],
    ['c-20260101-00000106', { project: '', state: '下書き' }],
  ]));
  await h.load();
  const expected = await h.service.contactLedger.waiting(principalFixtures.owner, ids.workspace, ids.source, { include_summaries: false });
  assert.deepEqual([...h.get('waiting').querySelectorAll('[data-waiting-ref]')].map(n => n.dataset.waitingRef), expected.map(r => r.contact_ids[0]));
  const rows = [...h.get('waiting').querySelectorAll('article')];
  assert.equal(rows[0].querySelector('h3').textContent, '合成期限切れ'); assert.match(rows[0].textContent, /件数: 2/);
  assert.equal(rows.filter(r => r.querySelector('h3').textContent === '案件なし').length, 2);
  assert.equal(h.requests.some(r => r.path.endsWith('/waiting?include_summaries=false')), true);
  assert.doesNotMatch(h.root.textContent, /SYNTHETIC_PRIVATE_CONTACT_BODY/);
  assert.ok(!h.requests.some(r => r.path.endsWith('/body') || r.path.endsWith('/history')));
});

test('contacts: filters combine state, exact project and search using actual memory API', async t => {
  const h = await harness(t, 'owner', store => insert(store, [
    ['c-20260101-00000201', { project: '合成検索案件', state: '回答待ち', recipient: '合成検索宛先' }],
    ['c-20260101-00000202', { project: '合成検索案件', state: '完了', recipient: '合成検索宛先' }],
  ]));
  await h.load();
  for (const [key, value] of Object.entries({ project: '合成検索案件', state: '回答待ち', q: '検索宛先' })) h.input(key, value, h.get('filters'));
  h.submit(h.get('filters')); await h.idle();
  assert.equal(h.get('rows').querySelectorAll('[data-contact-id]').length, 1);
  assert.equal(h.get('rows').querySelector('[data-contact-id]').dataset.contactId, 'c-20260101-00000201');
  assert.match(h.requests.at(-1).path, /state=/); assert.equal(h.dom.window.location.href, `${origin}/`);
});

test('contacts: create draft preview is read-only, explicit apply saves once and removes body editor', async t => {
  const h = await harness(t); await h.load(); const before = await snapshot(h.store);
  h.click('下書きを追加');
  assert.equal(h.doc.activeElement.name, 'project');
  assert.ok(h.get('editor').compareDocumentPosition(h.get('waiting')) & h.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  h.input('project', '合成新規案件'); h.input('recipient', '合成宛先'); h.input('body', 'SYNTHETIC_NEW_PRIVATE_BODY');
  await h.preview(); assert.deepEqual(await snapshot(h.store), before);
  assert.match(h.get('diff').textContent, /合成新規案件.*下書き/s);
  const details = h.get('diff').querySelector('details'); assert.equal(details.open, false);
  assert.equal(h.get('diff').firstElementChild.tagName, 'DL'); assert.equal(h.get('diff').lastElementChild, details);
  assert.doesNotMatch(h.get('diff').firstElementChild.textContent, /workspace ID|版番号|接続元 ID/);
  assert.doesNotMatch(h.get('diff').textContent, /SYNTHETIC_NEW_PRIVATE_BODY/);
  h.get('apply').click(); h.get('apply').click(); await h.idle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/commands/apply')).length, 1);
  const saved = await h.store.read(async s => (await s.contacts.list(ids.workspace, ids.source)).find(c => c.contact.project === '合成新規案件'));
  assert.equal(saved.contact.state, '下書き'); assert.equal(saved.contact.body, 'SYNTHETIC_NEW_PRIVATE_BODY');
  assert.equal(h.get('editor').hidden, true); assert.equal(h.get('fields').children.length, 0); assert.equal(h.get('preview').hidden, true);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_NEW_PRIVATE_BODY/);
  assert.equal(h.dom.window.localStorage.length, 0); assert.equal(h.dom.window.sessionStorage.length, 0);
  h.get('apply').click(); await h.idle(); assert.equal(h.requests.filter(r => r.path.endsWith('/commands/apply')).length, 1);
});

test('contacts: all six states, manual sent record, reply and history do not send or expose body', async t => {
  const h = await harness(t); await h.load(); await h.detail();
  h.click('状態を変更');
  assert.deepEqual([...h.get('fields').querySelector('select').options].map(o => o.value), ['下書き', '送信済み', '回答待ち', '対応中', '完了', '送らない']);
  h.input('state', '送信済み'); await h.preview(); await h.apply();
  assert.equal((await h.store.read(s => s.contacts.get(ids.workspace, ids.source, contacts.normal))).contact.state, '送信済み');
  h.click('返信を記録'); h.input('summary', '合成の返信を確認'); await h.preview(); await h.apply();
  const saved = await h.store.read(s => s.contacts.get(ids.workspace, ids.source, contacts.normal));
  assert.equal(saved.contact.state, '対応中'); assert.match(saved.contact.note, /返信要約: 合成の返信を確認/);
  h.click('履歴を見る'); await h.idle();
  assert.match(h.get('detail').querySelector('[data-history]').textContent, /送信済み.*対応中/s);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_PRIVATE_CONTACT_BODY/);
  assert.ok(h.requests.filter(r => r.method).every(r => r.method === 'POST' && /\/contacts\/commands\/(preview|apply)$/.test(r.path)));
});

test('contacts: 409 from real CAS clears preview and requires fresh reload without silent overwrite', async t => {
  const h = await harness(t); await h.load(); await h.detail(); h.click('状態を変更'); h.input('state', '完了'); await h.preview();
  const other = await h.service.contactLedger.previewCommand(principalFixtures.owner, ids.workspace, ids.source, {
    operation_id: uuid(701), action: 'set_state', contact_id: contacts.normal, expected_version: 1, data: { state: '回答待ち' }, reason: '合成の先行更新' });
  await h.service.contactLedger.applyCommand(principalFixtures.owner, ids.workspace, ids.source, other);
  h.click('この連絡を保存'); await h.idle();
  assert.match(h.get('message').textContent, /他の人が先に更新しました.*連絡を再読込/);
  assert.equal(h.get('preview').hidden, true);
  assert.equal((await h.store.read(s => s.contacts.get(ids.workspace, ids.source, contacts.normal))).contact.state, '回答待ち');
  h.click('連絡を再読込'); await h.idle(); assert.equal(h.get('editor').hidden, true);
  await h.detail(); assert.match(h.get('detail').textContent, /回答待ち/);
});

test('contacts: nonowners never request private ledgers, and revoked owner clears detail/body/editor', async t => {
  for (const actor of ['editor', 'viewer', 'outsider']) {
    const h = await harness(t, actor);
    assert.equal(h.get('content').hidden, true); assert.equal(h.get('message').textContent, 'この画面を見る権限がありません');
    assert.ok(!h.requests.some(r => r.path.includes('/sources/'))); assert.equal(h.access.at(-1), false);
  }
  const h = await harness(t); await h.load(); await h.detail(); h.click('本文を見る'); await h.idle();
  assert.equal(h.get('body').textContent, 'SYNTHETIC_PRIVATE_CONTACT_BODY');
  h.actor('viewer'); h.click('連絡を再読込'); await h.idle();
  assert.equal(h.get('content').hidden, true); assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_PRIVATE_CONTACT_BODY/);
  assert.equal(h.get('detail').children.length, 0);
});

test('contacts: body loads only explicitly, export requires confirmation and destroys DOM/object URL after download', async t => {
  const h = await harness(t); await h.load(); await h.detail();
  const before = await snapshot(h.store); const downloads = [], urls = [], revoked = [];
  h.dom.window.URL.createObjectURL = blob => { urls.push(blob); return 'blob:synthetic'; };
  h.dom.window.URL.revokeObjectURL = url => revoked.push(url);
  h.dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };
  assert.ok(!h.requests.some(r => r.path.endsWith('/body')));
  h.click('本文の書き出しを確認'); await h.idle();
  assert.equal(h.get('body').textContent, 'SYNTHETIC_PRIVATE_CONTACT_BODY'); assert.equal(downloads.length, 0);
  assert.deepEqual(await snapshot(h.store), before); h.click('この本文を書き出す');
  assert.equal(downloads.length, 1); assert.equal(urls.length, 1); assert.deepEqual(revoked, ['blob:synthetic']);
  assert.equal(h.get('body-panel').hidden, true); assert.equal(h.get('body').textContent, '');
  assert.ok(!h.requests.some(r => r.method)); assert.equal(h.dom.window.location.href, `${origin}/`);
  h.click('本文を見る'); await h.idle(); h.click('本文を閉じる'); assert.equal(h.get('body').textContent, '');
  h.click('本文を見る'); await h.idle(); assert.equal(h.app.canNavigate(), true);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_PRIVATE_CONTACT_BODY/);
});

test('contacts: cancel, changed input, source/filter navigation, pagehide/BFCache and late responses dispose body and stale previews', async t => {
  const h = await harness(t); await h.load(); const before = await snapshot(h.store);
  h.click('下書きを追加'); h.input('body', 'SYNTHETIC_UNSAVED_BODY'); await h.preview();
  h.input('body', 'SYNTHETIC_CHANGED_BODY'); assert.equal(h.get('preview').hidden, true); h.get('apply').click(); await h.idle();
  assert.deepEqual(await snapshot(h.store), before);
  await h.preview(); h.confirm(false); assert.equal(h.app.canNavigate(), false); assert.equal(h.get('editor').hidden, false);
  h.confirm(true); assert.equal(h.app.canNavigate(), true); assert.equal(h.get('fields').textContent, '');
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_(UNSAVED|CHANGED)_BODY/);
  await h.load(); await h.detail();
  let resolve; const response = new Promise(r => { resolve = r; });
  h.intercept(path => path.endsWith('/body') ? response : null); h.click('本文を見る');
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide'));
  resolve(Response.json({ body: 'SYNTHETIC_LATE_BODY' })); await h.idle();
  assert.equal(h.get('body').textContent, ''); assert.doesNotMatch(h.root.textContent, /SYNTHETIC_LATE_BODY/);
  h.intercept(null); h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true })); await h.idle();
  assert.equal(h.get('body').textContent, ''); assert.equal(h.get('preview').hidden, true);
});

test('contacts: raw API errors stay hidden, authentication expiry clears private content, malformed source makes no ledger call', async t => {
  const h = await harness(t); h.input('source', 'not-a-source', h.get('source-form')); h.submit(h.get('source-form')); await h.idle();
  assert.match(h.get('message').textContent, /UUID/); assert.ok(!h.requests.some(r => r.path.includes('/sources/')));
  await h.load(); h.intercept(() => Response.json({ error: 'SYNTHETIC_SERVER_SECRET <script>bad()</script>' }, { status: 500 }));
  h.click('連絡を再読込'); await h.idle(); assert.match(h.get('message').textContent, /通信状態/);
  assert.doesNotMatch(h.root.textContent, /SYNTHETIC_SERVER_SECRET|bad\(\)/);
  h.intercept(null); h.actor(null); h.click('連絡を再読込'); await h.idle();
  assert.equal(h.get('message').textContent, 'ログインが必要です'); assert.equal(h.get('content').hidden, true);
});

test('contacts: uncertain apply response retries the same signed operation exactly once without duplicate history', async t => {
  const h = await harness(t); await h.load(); await h.detail(); h.click('状態を変更'); h.input('state', '完了'); await h.preview();
  let first = true;
  h.intercept(async (path, options) => {
    if (path.endsWith('/commands/apply') && first) {
      first = false; await h.service.contactLedger.applyCommand(principalFixtures.owner, ids.workspace, ids.source, JSON.parse(options.body));
      return Response.json({ error: 'SYNTHETIC_LOST_RESPONSE' }, { status: 503 });
    }
    return null;
  });
  h.click('この連絡を保存'); await h.idle(); assert.equal(h.get('preview').hidden, false); await h.apply();
  const writes = h.requests.filter(r => r.path.endsWith('/commands/apply')); assert.equal(writes.length, 2); assert.equal(writes[0].body, writes[1].body);
  assert.equal((await h.store.read(s => s.contacts.history(ids.workspace, ids.source, contacts.normal))).length, 1);
});

test('contacts: composed entry is owner-only, cross-view navigation removes draft bodies and follows fresh authority', async t => {
  for (const actor of ['owner', 'editor', 'viewer']) {
    const store = new MemoryStore(); await seed(store);
    const signer = await createConfirmationSigner(new Uint8Array(32).fill(9));
    const service = new WorkspaceService({ store, signer, clock: { now: () => '2026-03-01T00:00:00Z' }, ids: { next: () => crypto.randomUUID() } });
    let active = actor, confirm = false;
    const handler = createHttpHandler({ service, origin, authenticator: { async authenticate() { return principalFixtures[active]; } } });
    const dom = new JSDOM(html, { url: `${origin}/` }), doc = dom.window.document;
    const app = mountDeskly(doc, { workspaceId: ids.workspace, memberId: principalFixtures[actor].member_id, confirmDiscard: () => confirm,
      fetch: async (path, options = {}) => {
        const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        return handler(new Request(new URL(path, origin), { ...options, headers }));
      } });
    t.after(() => { app.destroy(); dom.window.close(); }); await app.load();
    const contactButton = doc.getElementById('open-contacts');
    assert.equal(contactButton.hidden, actor !== 'owner');
    assert.equal(doc.getElementById('contact-access-message').hidden, actor === 'owner');
    if (actor !== 'owner') continue;
    doc.getElementById('open-workspace').click();
    contactButton.click(); await until(() => doc.getElementById('contact-view').getAttribute('aria-busy') !== 'true');
    assert.equal(doc.getElementById('workspace-view').hidden, true);
    doc.getElementById('contact-source').value = ids.source;
    doc.getElementById('contact-source-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await until(() => doc.getElementById('contact-view').getAttribute('aria-busy') !== 'true');
    doc.getElementById('contact-add').click();
    doc.querySelector('#contact-fields [name="body"]').value = 'SYNTHETIC_NAVIGATION_BODY';
    contactButton.click(); assert.equal(doc.querySelector('#contact-fields [name="body"]').value, 'SYNTHETIC_NAVIGATION_BODY');
    doc.getElementById('open-workspace').click(); assert.equal(doc.getElementById('workspace-view').hidden, true);
    confirm = true; doc.getElementById('open-workspace').click();
    await until(() => !doc.getElementById('workspace-refresh').disabled);
    assert.equal(doc.getElementById('workspace-view').hidden, false);
    assert.equal(doc.getElementById('contact-view').hidden, true);
    assert.equal(doc.querySelector('#contact-fields [name="body"]'), null);
    assert.doesNotMatch(doc.documentElement.outerHTML, /SYNTHETIC_NAVIGATION_BODY/);
    active = 'viewer'; await app.load(); assert.equal(contactButton.hidden, true);
    assert.equal(doc.getElementById('contact-content').hidden, true);
  }
});

test('contacts: related waiting rows include legacy whitespace-grouped contacts without using display name as identity', async t => {
  const h = await harness(t, 'owner', store => insert(store, [
    ['c-20260101-00000301', { project: ' 合成まとまり ', state: '下書き' }],
    ['c-20260101-00000302', { project: '合成まとまり', state: '回答待ち' }],
  ]));
  await h.load();
  const card = [...h.get('waiting').querySelectorAll('article')].find(n => n.querySelector('h3').textContent === '合成まとまり');
  h.click('関連する連絡', card); await h.idle();
  assert.deepEqual([...h.get('rows').querySelectorAll('[data-contact-id]')].map(n => n.dataset.contactId), ['c-20260101-00000301', 'c-20260101-00000302']);
});

test('contacts: late preview cannot reintroduce sensitive snapshots after the form changes', async t => {
  const h = await harness(t); await h.load(); h.click('下書きを追加'); h.input('body', 'SYNTHETIC_OLD_PREVIEW_BODY');
  let resolve; const response = new Promise(r => { resolve = r; }); let actual;
  h.intercept(async (path, options) => {
    if (path.endsWith('/commands/preview')) {
      actual = await h.service.contactLedger.previewCommand(principalFixtures.owner, ids.workspace, ids.source, JSON.parse(options.body));
      return response;
    }
    return null;
  });
  h.submit(); await until(() => actual);
  h.input('body', 'SYNTHETIC_NEWER_INPUT'); resolve(Response.json(actual)); await h.idle();
  assert.equal(h.get('preview').hidden, true); assert.equal(h.get('diff').textContent, '');
  h.get('apply').click(); await h.idle(); assert.ok(!h.requests.some(r => r.path.endsWith('/commands/apply')));
  h.app.canNavigate(); assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_(OLD_PREVIEW_BODY|NEWER_INPUT)/);
});

test('contacts: changing source protects unsaved draft and confirmed switch removes its body', async t => {
  const h = await harness(t); await h.load(); h.click('下書きを追加'); h.input('body', 'SYNTHETIC_SOURCE_DRAFT');
  h.confirm(false); h.input('source', ids.otherSource, h.get('source-form'));
  assert.equal(h.get('source').value, ids.source); assert.equal(h.get('editor').hidden, false);
  assert.equal(h.get('fields').querySelector('[name="body"]').value, 'SYNTHETIC_SOURCE_DRAFT');
  h.confirm(true); h.input('source', ids.otherSource, h.get('source-form'));
  assert.equal(h.get('editor').hidden, true); assert.equal(h.get('fields').children.length, 0);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_SOURCE_DRAFT/);
  h.submit(h.get('source-form')); await h.idle();
  assert.equal(h.get('rows').querySelector('[data-contact-id]').dataset.contactId, contacts.second);
});

test('contacts: pending body read aborted by BFCache return queues fresh authorization after stale request settles', async t => {
  const h = await harness(t); await h.load(); await h.detail();
  let resolve; const response = new Promise(r => { resolve = r; });
  h.intercept(path => path.endsWith('/body') ? response : null);
  const before = h.requests.filter(r => r.path === '/api/v1/accounts/me').length;
  h.click('本文を見る');
  const request = h.requests.at(-1); assert.equal(request.signal.aborted, false);
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide'));
  assert.equal(request.signal.aborted, true);
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  h.actor('viewer'); resolve(Response.json({ body: 'SYNTHETIC_BFCACHE_BODY' })); await h.idle();
  assert.equal(h.requests.filter(r => r.path === '/api/v1/accounts/me').length, before + 1);
  assert.equal(h.get('content').hidden, true); assert.equal(h.get('message').textContent, 'この画面を見る権限がありません');
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_BFCACHE_BODY/);
});

test('contacts: untrusted contact text and body remain inert text', async t => {
  const h = await harness(t, 'owner', store => insert(store, [
    ['c-20260101-00000401', { project: '<img src=x onerror=alert(1)>', body: '<script>bad()</script>' }],
  ]));
  await h.load(); assert.equal(h.get('rows').querySelector('img'), null);
  await h.detail('c-20260101-00000401'); h.click('本文を見る'); await h.idle();
  assert.equal(h.get('body').textContent, '<script>bad()</script>'); assert.equal(h.get('body').querySelector('script'), null);
});
