import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountCases } from '../../.build/browser/ui/cases.js';
import { mountDeskly } from '../../.build/browser/ui/main.js';
import { MemoryStore } from '../../.build/memory-store.js';
import { WorkspaceService } from '../../.build/service.js';
import { createHttpHandler } from '../../.build/http.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { caseSettings, parseCaseSettingsToml } from '../../.build/case-settings.js';
import { seed, ids, principalFixtures } from '../contract/fixtures.mjs';

const html = await readFile(new URL('../../.build/public/index.html', import.meta.url), 'utf8');
const origin = 'https://deskly.example';
const cases = `/api/v1/workspaces/${ids.workspace}/cases`;
const today = '2026-03-01';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await flush(); } assert.ok(predicate(), 'UI did not settle'); }

// Synthetic settings with identifiers and words no organization uses; one label is left out on purpose.
const settings = caseSettings({
  kinds: { values: ['kind_a', 'kind_b', 'kind_c'], requires_approval: ['kind_b'] },
  statuses: { values: ['step_new', 'step_wait', 'step_work', 'step_done', 'step_drop'], open: ['step_new', 'step_wait', 'step_work'],
    terminal: ['step_done', 'step_drop'], initial: 'step_new',
    waiting: { step_new: 'us', step_wait: 'them', step_work: 'us', step_done: 'none', step_drop: 'none' } },
  approval_states: { values: ['ap_free', 'ap_wait', 'ap_ok', 'ap_hold'], initial: 'ap_wait', initial_free: 'ap_free', hold: 'ap_hold' },
  labels: { ja: { kind_a: '合成種別甲', kind_b: '合成種別乙', step_new: '合成段階一', step_wait: '合成段階二', step_work: '合成段階三',
    step_done: '合成段階四', step_drop: '合成段階五', ap_free: '合成承認無', ap_wait: '合成承認待', ap_ok: '合成承認済', ap_hold: '合成承認止' } },
  numbering: { display_names: { app_one: '合成アプリ一' } },
});
const identifiers = [...settings.kinds.values, ...settings.statuses.values, ...settings.approval_states.values];
const app = (name) => ({ kind: 'app', workspace_id: ids.workspace, app: name, sources: [name], tenants: ['*'] });
const owner = principalFixtures.owner;

/** Six synthetic cases covering overdue, hold that has come, missing evidence, evidence, future dates and two sources. */
async function seedCases(service) {
  const create = (source, overrides) => service.cases.create(app(source), ids.workspace, { origin: 'human', kind: 'kind_a',
    title: '合成の受付', body: 'SYNTHETIC_CASE_BODY', reporter_ref: 'u-synthetic', place: { screen_id: 'screen-x' }, ...overrides });
  const update = async (number, change) => {
    const { case: current } = await service.cases.read(owner, ids.workspace, number);
    return service.cases.update(owner, ids.workspace, number, { expected_revision: current.revision, reason: '合成の準備', ...change });
  };
  await create('app_one', { title: '合成の期限切れ', promised_due: '2026-02-20' });
  await create('app_one', { title: '合成の保留', kind: 'kind_b' });
  await update('app_one-2', { status: 'step_wait', approval_state: 'ap_hold', hold_until: '2026-02-25' });
  await create('app_one', { title: '合成の証拠なし' });
  await update('app_one-3', { status: 'step_done' });
  await create('app_one', { title: '合成の証拠あり', kind: 'kind_c' });
  await service.cases.addLink(owner, ids.workspace, 'app_one-4', { link_type: 'commit', ref: 'a'.repeat(40) });
  await update('app_one-4', { status: 'step_drop' });
  await create('app_two', { title: '合成の別アプリ', promised_due: '2026-04-01', place: {} });
  await update('app_two-1', { status: 'step_work' });
  await create('app_two', { title: '合成の先の保留', kind: 'kind_b' });
  await update('app_two-2', { approval_state: 'ap_hold', hold_until: '2026-05-01' });
}

async function harness(t, { actor = 'owner', withSettings = true, language, memberRole, memberEnabled = false } = {}) {
  const store = new MemoryStore(); await seed(store);
  let active = actor, intercept = null, confirm = true;
  const signer = await createConfirmationSigner(new Uint8Array(32).fill(7));
  const service = new WorkspaceService({ store, signer, clock: { now: () => `${today}T00:00:00Z` }, ids: { next: () => crypto.randomUUID() },
    ...(withSettings ? { caseSettings: memberRole || memberEnabled ? caseSettings({ ...settings, member_access: { enabled: true } }) : settings } : {}) });
  if (withSettings) await seedCases(service);
  if (memberRole) await service.cases.setMemberScope(owner, ids.workspace, principalFixtures[actor].member_id,
    { expected_revision: 0, role: memberRole, sources: ['app_one'], tenants: ['*'] });
  const handler = createHttpHandler({ service, origin, authenticator: { async authenticate() { return principalFixtures[active] ?? null; } } });
  const dom = new JSDOM(html, { url: `${origin}/` }), doc = dom.window.document;
  const root = doc.getElementById('case-view'); const requests = [], access = [];
  const view = mountCases(root, { workspaceId: ids.workspace, confirmDiscard: () => confirm, ...(language ? { language } : {}),
    onAccess: owned => access.push(owned), fetch: async (path, options = {}) => {
      assert.ok(path.startsWith(cases) || path.endsWith('/memberships'), path);
      requests.push({ path, ...options });
      if (intercept) { const result = await intercept(path, options); if (result) return result; }
      const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
      return handler(new Request(new URL(path, origin), { ...options, headers }));
    } });
  t.after(() => { view.destroy(); dom.window.close(); });
  const get = id => doc.getElementById(`case-${id}`);
  const idle = () => until(() => root.getAttribute('aria-busy') !== 'true');
  const click = (label, parent = root) => {
    const node = [...parent.querySelectorAll('button')].find(b => b.textContent === label && !b.closest('[hidden]'));
    assert.ok(node, `Missing button ${label}`); assert.equal(node.disabled, false); node.click(); return node;
  };
  const set = (name, value, form = get('form')) => {
    const node = form.querySelector(`[name="${name}"]`); assert.ok(node, `Missing input ${name}`);
    if (node.type === 'checkbox') node.checked = value; else node.value = value;
    node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    return node;
  };
  const numbers = () => [...get('rows').querySelectorAll('[data-case-number]')].map(n => n.dataset.caseNumber);
  const card = number => get('rows').querySelector(`[data-case-number="${number}"]`);
  const detail = async number => { click('受付の詳細', card(number)); await idle(); };
  const confirmChange = async () => {
    get('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await idle();
    assert.equal(get('preview').hidden, false, get('message').textContent);
  };
  const writes = () => requests.filter(r => r.method);
  await view.open(); await idle();
  return { store, service, dom, doc, root, view, get, idle, click, set, numbers, card, detail, confirmChange, requests, writes, access,
    actor: a => { active = a; }, intercept: i => { intercept = i; }, confirm: c => { confirm = c; } };
}
const read = (h, number) => h.service.cases.read(owner, ids.workspace, number);

test('cases: granted viewers read their scope without edit controls; editors update and revocation clears private text', async t => {
  const fullOwner = await harness(t, { memberEnabled: true });
  await fullOwner.detail('app_one-1');
  assert.ok([...fullOwner.get('detail').querySelectorAll('button')].some(button => button.textContent === '返事を追加'));
  assert.ok(fullOwner.requests.some(request => request.path.endsWith('/memberships')));
  const viewer = await harness(t, { actor: 'viewer', memberRole: 'viewer' });
  assert.equal(viewer.get('content').hidden, false);
  assert.ok(viewer.numbers().every(number => number.startsWith('app_one-')));
  await viewer.detail('app_one-1');
  assert.match(viewer.get('detail').textContent, /SYNTHETIC_CASE_BODY/);
  assert.equal(viewer.get('detail').querySelectorAll('button').length, 0);
  assert.equal(viewer.writes().length, 0);
  await viewer.service.cases.setMemberScope(owner, ids.workspace, ids.viewer, { expected_revision: 1, role: null });
  viewer.click('受付を再読込'); await viewer.idle();
  assert.equal(viewer.get('content').hidden, true);
  assert.doesNotMatch(viewer.doc.documentElement.outerHTML, /SYNTHETIC_CASE_BODY|合成の期限切れ/);

  const editor = await harness(t, { actor: 'editor', memberRole: 'editor' });
  await editor.detail('app_one-1'); editor.click('返事を追加'); editor.set('body', '合成の編集者の返事');
  await editor.confirmChange(); editor.click('この内容で受付を保存'); await editor.idle();
  assert.equal((await read(editor, 'app_one-1')).replies.at(-1).body, '合成の編集者の返事');
  await editor.service.cases.setMemberScope(owner, ids.workspace, ids.editor,
    { expected_revision: 1, role: 'viewer', sources: ['app_one'], tenants: ['*'] });
  editor.click('受付を再読込'); await editor.idle(); await editor.detail('app_one-1');
  assert.equal(editor.get('detail').querySelectorAll('button').length, 0);
});

test('cases: four panels and the operator breakdown show the API numbers with display names from settings', async t => {
  const h = await harness(t);
  const panels = await h.service.cases.panels(owner, ids.workspace);
  const panel = name => h.get('panels').querySelector(`[data-panel="${name}"]`);
  assert.equal(panels.overdue, 1); assert.equal(panels.open, 4);
  assert.equal(panel('overdue').querySelector('.case-count').textContent, '1 件');
  assert.match(panel('waiting').textContent, new RegExp(`こちら待ち${panels.waiting.us} 件相手待ち${panels.waiting.them} 件待ちなし${panels.waiting.none} 件`));
  assert.match(panel('screens').textContent, /screen-x3 件.*画面の指定なし1 件/s);
  assert.match(panel('kinds').textContent, /合成種別甲2 件（50%）合成種別乙2 件（50%）kind_c0 件（0%）/);
  const sources = [...panel('sources').querySelectorAll('[data-source]')];
  assert.deepEqual(sources.map(n => n.dataset.source), ['app_one', 'app_two']);
  assert.equal(sources[0].querySelector('h4').textContent, '合成アプリ一'); assert.equal(sources[1].querySelector('h4').textContent, 'app_two');
  assert.match(sources[0].textContent, /未完了 2 件 · 期限切れ 1 件/);
  assert.equal(h.get('content').hidden, false); assert.deepEqual(h.access, [true]);
  assert.ok(!h.writes().length, 'opening the screen writes nothing');
});

test('cases: list keeps the API order with hold and overdue first, marks evidence and filters without reordering', async t => {
  const h = await harness(t);
  const expected = (await h.service.cases.list(owner, ids.workspace)).map(row => row.number);
  assert.deepEqual(expected.slice(0, 2), ['app_one-1', 'app_one-2']);
  assert.deepEqual(h.numbers(), expected);
  assert.ok(h.card('app_one-1').querySelector('.case-mark-overdue'));
  assert.ok(h.card('app_one-2').querySelector('.case-mark-hold'));
  assert.equal(h.card('app_two-2').querySelector('.case-mark-hold'), null, 'a future hold_until does not float');
  assert.equal(h.card('app_one-3').querySelector('.case-mark-evidence').textContent, '証拠なし');
  assert.equal(h.card('app_one-4').querySelector('.case-mark-evidence'), null, 'a terminal case with a link has evidence');
  assert.equal(h.card('app_two-1').querySelector('.case-marks'), null);
  const filters = h.get('filters');
  assert.deepEqual([...filters.querySelector('[name="status"]').options].map(o => [o.value, o.textContent]),
    [['', 'すべて'], ...settings.statuses.values.map(v => [v, settings.labels.ja[v]])]);
  h.set('status', 'step_new', filters); assert.deepEqual(h.numbers(), ['app_one-1', 'app_two-2']);
  h.set('status', '', filters); h.set('kind', 'kind_b', filters); assert.deepEqual(h.numbers(), ['app_one-2', 'app_two-2']);
  h.set('kind', '', filters); h.set('source', 'app_two', filters); assert.deepEqual(h.numbers(), ['app_two-1', 'app_two-2']);
  assert.deepEqual([...filters.querySelector('[name="source"]').options].map(o => o.textContent), ['すべて', '合成アプリ一', 'app_two']);
  h.set('source', '', filters); h.set('waiting', 'them', filters); assert.deepEqual(h.numbers(), ['app_one-2']);
  h.set('waiting', '', filters); h.set('overdue', true, filters); assert.deepEqual(h.numbers(), ['app_one-1']);
  assert.match(h.get('rows').querySelector('h2').textContent, /1 件（全 6 件）/);
  assert.equal(h.requests.filter(r => r.path === cases).length, 1, 'filters never call the API, which accepts no query');
});

test('cases: kinds, statuses and approval states are shown by their configured labels, never by identifiers', async t => {
  const h = await harness(t); await h.detail('app_one-2');
  const visible = h.root.textContent;
  for (const word of ['合成段階二', '合成承認止', '合成種別乙', '合成アプリ一']) assert.ok(visible.includes(word), word);
  for (const identifier of identifiers.filter(value => value !== 'kind_c')) assert.ok(!visible.includes(identifier), `${identifier} is shown`);
  assert.ok(visible.includes('kind_c'), 'a missing label shows the identifier itself');
  assert.match(h.get('detail').querySelector('[data-case-history]').textContent, /合成段階一 → 合成段階二/);
  assert.match(h.get('detail').querySelector('[data-case-history]').textContent, /合成承認待 → 合成承認止/);
  // A language the settings do not have shows identifiers, never another language.
  const other = await harness(t, { language: 'zz' });
  assert.match(other.get('panels').textContent, /kind_a2 件/);
  assert.ok(!other.root.textContent.includes('合成種別甲'));
});

test('cases: the screen code embeds no configured identifier or display word', async () => {
  const example = parseCaseSettingsToml(await readFile(new URL('../../config/case-settings.example.toml', import.meta.url), 'utf8'));
  const words = new Set();
  for (const source of [example, settings]) {
    for (const value of [...source.kinds.values, ...source.statuses.values, ...source.approval_states.values,
      ...Object.values(source.labels).flatMap(labels => Object.values(labels)), ...Object.values(source.numbering.display_names)]) words.add(value);
  }
  const code = await readFile(new URL('../../ui/cases.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../../ui/index.html', import.meta.url), 'utf8');
  const caseSection = page.slice(page.indexOf('<section id="case-view"'), page.indexOf('</section>\n    <footer'));
  assert.ok(caseSection.includes('case-filters'));
  for (const word of words) {
    for (const quote of ["'", '"', '`']) assert.ok(!code.includes(`${quote}${word}${quote}`), `cases.ts hard-codes ${word}`);
    assert.ok(!code.includes(`「${word}」`) && !caseSection.includes(`>${word}<`) && !caseSection.includes(`"${word}"`), `screen embeds ${word}`);
  }
});

test('cases: a status change is confirmed first, then sent once with expected_revision and recorded in history', async t => {
  const h = await harness(t); await h.detail('app_one-1');
  const before = await read(h, 'app_one-1');
  h.click('状態を変更');
  const select = h.get('fields').querySelector('[name="status"]');
  assert.deepEqual([...select.options].map(o => o.textContent), settings.statuses.values.map(v => settings.labels.ja[v]));
  assert.equal(h.doc.activeElement, select);
  h.set('status', 'step_done');
  await h.confirmChange();
  assert.match(h.get('diff').textContent, /状態合成段階一 → 合成段階四/);
  assert.match(h.get('diff').textContent, /証拠なし/);
  assert.equal(h.get('diff').querySelector('details').open, false);
  assert.deepEqual(await read(h, 'app_one-1'), before, 'confirming writes nothing');
  assert.ok(!h.writes().length);
  h.get('apply').click(); h.get('apply').click(); await h.idle();
  const patches = h.writes();
  assert.equal(patches.length, 1); assert.equal(patches[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(patches[0].body), { expected_revision: 1, reason: '受付の状況を更新', status: 'step_done' });
  const after = await read(h, 'app_one-1');
  assert.equal(after.case.status, 'step_done'); assert.equal(after.case.revision, 2); assert.equal(after.events.length, 2);
  assert.equal(h.get('message').textContent, '保存しました');
  assert.equal(h.get('editor').hidden, true); assert.equal(h.get('preview').hidden, true);
  assert.ok(h.card('app_one-1').querySelector('.case-mark-evidence'), 'the refreshed list marks missing evidence');
  assert.match(h.get('detail').textContent, /合成段階四/);
});

test('cases: 409 from a real revision conflict asks for a reload and never overwrites', async t => {
  const h = await harness(t); await h.detail('app_one-1');
  h.click('状態を変更'); h.set('status', 'step_work'); await h.confirmChange();
  await h.service.cases.update(owner, ids.workspace, 'app_one-1', { expected_revision: 1, status: 'step_wait' });
  h.click('この内容で受付を保存'); await h.idle();
  assert.equal(h.get('message').textContent, '他の人が先に更新しました。「受付を再読込」で最新の内容を確認し、もう一度変更を確認してください。');
  assert.equal(h.get('preview').hidden, true);
  assert.equal((await read(h, 'app_one-1')).case.status, 'step_wait');
  h.click('受付を再読込'); await h.idle(); assert.equal(h.get('editor').hidden, true);
  await h.detail('app_one-1'); assert.match(h.get('detail').textContent, /合成段階二/);
});

test('cases: hold_until can be entered only while the configured hold approval state is chosen', async t => {
  const h = await harness(t); await h.detail('app_one-1');
  assert.equal([...h.get('detail').querySelectorAll('button')].some(b => b.textContent === '承認状態を変更'), false, 'kinds without approval have no approval editor');
  h.click('期日を変更');
  assert.equal(h.get('fields').querySelector('[name="hold_until"]').disabled, true);
  assert.match(h.get('fields').textContent, /承認状態が「合成承認止」のときだけ/);
  h.set('promised_due', '2026-03-10'); await h.confirmChange();
  h.click('この内容で受付を保存'); await h.idle();
  assert.equal((await read(h, 'app_one-1')).case.promised_due, '2026-03-10');
  assert.equal(h.card('app_one-1').querySelector('.case-mark-overdue'), null);

  await h.detail('app_two-2');
  h.click('承認状態を変更');
  const hold = h.get('fields').querySelector('[name="hold_until"]');
  assert.equal(hold.disabled, false); assert.equal(hold.value, '2026-05-01');
  h.set('approval_state', 'ap_ok'); assert.equal(hold.disabled, true); assert.equal(hold.value, '');
  h.set('approval_state', 'ap_hold'); assert.equal(hold.disabled, false);
  h.set('hold_until', '2026-06-01'); await h.confirmChange();
  assert.match(h.get('diff').textContent, /保留の解除期限2026-05-01 → 2026-06-01/);
  h.click('この内容で受付を保存'); await h.idle();
  assert.equal((await read(h, 'app_two-2')).case.hold_until, '2026-06-01');
  // Leaving the hold state clears hold_until in the same request, so the API invariant holds.
  h.click('承認状態を変更'); h.set('approval_state', 'ap_ok'); await h.confirmChange();
  h.click('この内容で受付を保存'); await h.idle();
  assert.deepEqual(JSON.parse(h.writes().at(-1).body), { expected_revision: 3, reason: '受付の状況を更新', approval_state: 'ap_ok', hold_until: null });
  const saved = (await read(h, 'app_two-2')).case;
  assert.equal(saved.approval_state, 'ap_ok'); assert.equal(saved.hold_until, null);
});

test('cases: replies and links are confirmed, stored once, and a link removes the missing-evidence mark', async t => {
  const h = await harness(t); await h.detail('app_one-3');
  assert.match(h.get('detail').querySelector('[data-case-links]').textContent, /証拠なし/);
  h.click('返事を追加');
  assert.equal(h.get('reason-label').hidden, true);
  h.set('body', '合成の返事です');
  await h.confirmChange();
  assert.match(h.get('diff').textContent, /相手へは送信しません/); assert.match(h.get('diff').textContent, /合成の返事です/);
  h.click('この内容で受付を保存'); await h.idle();
  assert.equal((await read(h, 'app_one-3')).replies.length, 1);
  assert.match(h.get('detail').querySelector('[data-case-replies]').textContent, /合成の返事です/);
  h.click('関連を追加'); h.set('link_type', 'url'); h.set('ref', 'https://docs.example.com/synthetic');
  await h.confirmChange(); assert.match(h.get('diff').textContent, /外部 URL/);
  h.click('この内容で受付を保存'); await h.idle();
  assert.deepEqual(h.writes().map(r => [r.method, r.path.slice(cases.length)]), [['POST', '/app_one-3/replies'], ['POST', '/app_one-3/links']]);
  assert.equal(h.card('app_one-3').querySelector('.case-mark-evidence'), null);
  assert.doesNotMatch(h.get('detail').querySelector('[data-case-links]').textContent, /証拠なし/);
});

test('cases: server errors become fixed Japanese messages and a lost write is not resent', async t => {
  const h = await harness(t); await h.detail('app_one-3');
  h.click('関連を追加'); h.set('ref', 'NOT-A-HASH'); await h.confirmChange();
  h.click('この内容で受付を保存'); await h.idle();
  assert.match(h.get('message').textContent, /コミットは 7〜64 文字の小文字の 16 進数/);
  assert.equal((await read(h, 'app_one-3')).links.length, 0);
  h.intercept(() => Response.json({ error: 'SYNTHETIC_SERVER_SECRET <script>bad()</script>' }, { status: 500 }));
  h.click('受付を再読込'); await h.idle();
  assert.match(h.get('message').textContent, /通信状態/);
  assert.doesNotMatch(h.root.textContent, /SYNTHETIC_SERVER_SECRET|bad\(\)/);
  h.intercept(null); h.click('受付を再読込'); await h.idle(); await h.detail('app_one-3');
  h.click('返事を追加'); h.set('body', '合成の返事'); await h.confirmChange();
  h.intercept(async (path, options) => {
    if (path.endsWith('/replies')) {
      await h.service.cases.addReply(owner, ids.workspace, 'app_one-3', JSON.parse(options.body));
      return Response.json({ error: 'SYNTHETIC_LOST_RESPONSE' }, { status: 503 });
    }
    return null;
  });
  h.click('この内容で受付を保存'); await h.idle();
  assert.match(h.get('message').textContent, /保存できたかを確認できませんでした/);
  assert.equal(h.get('preview').hidden, true, 'an uncertain reply is not kept ready for a blind resend');
  assert.equal(h.writes().filter(r => r.path.endsWith('/replies')).length, 1);
  assert.equal((await read(h, 'app_one-3')).replies.length, 1);
});

test('cases: non-owners and anonymous callers see only the access message and never the case API data', async t => {
  for (const [actor, text] of [['editor', 'この画面を見る権限がありません'], ['viewer', 'この画面を見る権限がありません'],
    ['outsider', 'この画面を見る権限がありません'], [null, 'ログインが必要です']]) {
    const h = await harness(t, { actor });
    assert.equal(h.get('content').hidden, true); assert.equal(h.get('message').textContent, text);
    assert.deepEqual(h.requests.map(r => r.path), [`${cases}/settings`]);
    assert.deepEqual(h.access, [false]);
  }
  const h = await harness(t); await h.detail('app_one-1');
  assert.match(h.root.textContent, /SYNTHETIC_CASE_BODY/);
  h.actor('viewer'); h.click('受付を再読込'); await h.idle();
  assert.equal(h.get('content').hidden, true);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_CASE_BODY|合成の期限切れ/);
  const disabled = await harness(t, { withSettings: false });
  assert.match(disabled.get('message').textContent, /受付は有効になっていません/); assert.equal(disabled.get('content').hidden, true);
});

test('cases: leaving, pagehide and unsaved input protect and then dispose case text', async t => {
  const h = await harness(t); await h.detail('app_one-1');
  h.click('返事を追加'); h.set('body', 'SYNTHETIC_UNSAVED_REPLY');
  h.confirm(false); assert.equal(h.view.canNavigate(), false);
  assert.equal(h.get('fields').querySelector('[name="body"]').value, 'SYNTHETIC_UNSAVED_REPLY');
  h.confirm(true); assert.equal(h.view.canNavigate(), true);
  assert.doesNotMatch(h.doc.documentElement.outerHTML, /SYNTHETIC_UNSAVED_REPLY|SYNTHETIC_CASE_BODY/);
  assert.equal(h.dom.window.localStorage.length, 0); assert.equal(h.dom.window.sessionStorage.length, 0);
  await h.view.open(); await h.idle(); await h.detail('app_one-1');
  h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide'));
  assert.equal(h.get('detail').children.length, 0); assert.equal(h.get('rows').children.length, 0);
  assert.equal(h.dom.window.location.href, `${origin}/`);
});

test('cases: the composed page exposes granted member cases separately from private owner contacts', async t => {
  for (const actor of ['editor', 'viewer']) {
    const h = await harness(t, { actor, memberRole: actor === 'editor' ? 'editor' : 'viewer' });
    h.view.destroy(); h.root.hidden = true;
    const handler = createHttpHandler({ service: h.service, origin, authenticator: { async authenticate() { return principalFixtures[actor]; } } });
    const page = mountDeskly(h.doc, { workspaceId: ids.workspace, memberId: principalFixtures[actor].member_id,
      fetch: async (path, options = {}) => {
        const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        return handler(new Request(new URL(path, origin), { ...options, headers }));
      } });
    await page.load();
    assert.equal(h.doc.getElementById('open-contacts').hidden, true);
    assert.equal(h.doc.getElementById('open-cases').hidden, false);
    h.doc.getElementById('open-cases').click();
    await until(() => h.root.getAttribute('aria-busy') !== 'true' && h.get('rows').children.length > 0);
    assert.ok([...h.get('rows').querySelectorAll('[data-case-number]')].every(node => node.dataset.caseNumber.startsWith('app_one-')));
    await h.service.cases.setMemberScope(owner, ids.workspace, principalFixtures[actor].member_id, { expected_revision: 1, role: null });
    h.doc.getElementById('open-workspace').click();
    await until(() => h.doc.getElementById('open-cases').hidden);
    assert.equal(h.doc.getElementById('open-cases').hidden, true);
    assert.equal(h.get('content').hidden, true);
    assert.equal(h.get('rows').children.length, 0);
    page.destroy();
  }
});

test('cases: the composed page shows ungranted case entry to owners only and navigation discards case text', async t => {
  for (const actor of ['owner', 'editor', 'viewer']) {
    const store = new MemoryStore(); await seed(store);
    const signer = await createConfirmationSigner(new Uint8Array(32).fill(9));
    const service = new WorkspaceService({ store, signer, clock: { now: () => `${today}T00:00:00Z` }, ids: { next: () => crypto.randomUUID() }, caseSettings: settings });
    await seedCases(service);
    let confirm = false;
    const handler = createHttpHandler({ service, origin, authenticator: { async authenticate() { return principalFixtures[actor]; } } });
    const dom = new JSDOM(html, { url: `${origin}/` }), doc = dom.window.document;
    const page = mountDeskly(doc, { workspaceId: ids.workspace, memberId: principalFixtures[actor].member_id, confirmDiscard: () => confirm,
      fetch: async (path, options = {}) => {
        const headers = new Headers(options.headers); headers.set('origin', origin); headers.set('sec-fetch-site', 'same-origin');
        return handler(new Request(new URL(path, origin), { ...options, headers }));
      } });
    t.after(() => { page.destroy(); dom.window.close(); }); await page.load();
    const casesButton = doc.getElementById('open-cases');
    assert.equal(casesButton.hidden, actor !== 'owner');
    assert.equal(doc.getElementById('case-access-message').hidden, actor === 'owner');
    if (actor !== 'owner') { assert.equal(doc.getElementById('case-content').hidden, true); continue; }
    const caseView = doc.getElementById('case-view');
    casesButton.click(); await until(() => caseView.getAttribute('aria-busy') !== 'true' && doc.querySelector('#case-rows [data-case-number]'));
    assert.equal(doc.getElementById('workspace-view').hidden, true); assert.equal(caseView.hidden, false);
    assert.equal(casesButton.getAttribute('aria-current'), 'page');
    doc.querySelector('#case-rows [data-case-number="app_one-1"] button').click();
    await until(() => caseView.getAttribute('aria-busy') !== 'true' && doc.querySelector('#case-detail button'));
    [...doc.querySelectorAll('#case-detail button')].find(b => b.textContent === '返事を追加').click();
    doc.querySelector('#case-fields [name="body"]').value = 'SYNTHETIC_NAVIGATION_REPLY';
    doc.getElementById('open-contacts').click(); assert.equal(caseView.hidden, false, 'unsaved input keeps the view');
    confirm = true; doc.getElementById('open-workspace').click();
    await until(() => !doc.getElementById('workspace-refresh').disabled);
    assert.equal(caseView.hidden, true); assert.equal(doc.getElementById('workspace-view').hidden, false);
    assert.doesNotMatch(doc.documentElement.outerHTML, /SYNTHETIC_NAVIGATION_REPLY|SYNTHETIC_CASE_BODY/);
  }
});

test('cases: untrusted case text stays inert', async t => {
  const h = await harness(t);
  await h.service.cases.create(app('app_one'), ids.workspace, { origin: 'human', kind: 'kind_a', title: '<img src=x onerror=alert(1)>',
    body: '<script>bad()</script>', place: { url: 'https://app.example.com/<b>' } });
  h.click('受付を再読込'); await h.idle();
  assert.equal(h.get('rows').querySelector('img'), null);
  await h.detail('app_one-5');
  assert.equal(h.get('detail').querySelector('script, img, b, a'), null);
  assert.match(h.get('detail').textContent, /<script>bad\(\)<\/script>/);
});
