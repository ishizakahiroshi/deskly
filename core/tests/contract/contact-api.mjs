import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContactLedgerService } from '../../.build/contact-service.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { CONTACT_STATES } from '../../.build/status.js';
import { assertApiSchema } from './schema-validation.mjs';
import { clockTime, contactData, contacts, ids, snapshot, uuid } from './fixtures.mjs';

const workspace = `/api/v1/workspaces/${ids.workspace}`;
const ledger = `${workspace}/sources/${ids.source}`;
const list = `${ledger}/contacts`;
const commands = `${list}/commands`;
const rolePath = `${workspace}/project-roles/me`;
const command = (c, action, data, overrides = {}) => ({ operation_id: c.op(), action,
  contact_id: action === 'add_draft' ? null : contacts.normal,
  expected_version: action === 'add_draft' ? null : 1, data, reason: '合成の連絡操作', ...overrides });
const apply = async (c, request) => {
  assertApiSchema('ContactActionCommand', request);
  const preview = await c.request('owner', 'POST', `${commands}/preview`, request);
  assertApiSchema('ContactActionPreview', preview);
  return { preview, result: await c.request('owner', 'POST', `${commands}/apply`, preview) };
};
const add = (c, fields, overrides = {}) => apply(c, command(c, 'add_draft', fields, overrides));
const errorsOnly = value => {
  assert.deepEqual(Object.keys(value), ['error']);
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_PRIVATE|synthetic_secret|source_hash|source_path|recipient|body|extra/);
};
const insertContacts = (c, rows) => c.store.transaction(async tx => {
  for (const [id, fields] of rows) await tx.contacts.put({ workspace_id: ids.workspace, source_id: ids.source,
    version: 1, contact: contactData(id, fields) }, null);
});

/** Added unchanged to runContractSuite for memory, SQLite and D1. */
export function registerContactApiTests(setup) {
  test('contact API lists every state with combined exact project and Unicode search filters', async t => {
    const c = await setup(t);
    const rows = CONTACT_STATES.map((state, i) => [`c-20260101-${(i + 100).toString(16).padStart(8, '0')}`,
      { state, project: '合成の検索案件', recipient: i === 0 ? 'Straße' : '合成宛先', body: `合成本文 ${i}`,
        extra: { marker: 'synthetic_secret' }, source_path: 'synthetic_secret' }]);
    await insertContacts(c, rows);
    for (const [index, state] of CONTACT_STATES.entries()) {
      const query = new URLSearchParams({ state, project: '合成の検索案件' });
      const { items } = await c.request('owner', 'GET', `${list}?${query}`);
      assert.deepEqual(items.map(row => row.contact.id), [rows[index][0]]);
    }
    const query = new URLSearchParams({ project: '合成の検索案件', q: ' STRASSE ' });
    query.append('state', '下書き'); query.append('state', '完了');
    assert.deepEqual((await c.request('owner', 'GET', `${list}?${query}`)).items.map(row => row.contact.id), [rows[0][0]]);
    assert.deepEqual((await c.request('owner', 'GET', `${list}?project=${encodeURIComponent('合成の検索')}`)).items, []);
    assert.deepEqual((await c.request('owner', 'GET', `${list}?q=synthetic_secret`)).items, []);
    const all = (await c.request('owner', 'GET', list)).items;
    const expected = [...all].sort((a, b) => a.contact.created_at < b.contact.created_at ? -1 : a.contact.created_at > b.contact.created_at ? 1 : a.contact.id.localeCompare(b.contact.id));
    assert.deepEqual(all, expected);
    for (const query of ['state=waiting', 'q=', 'q=%20', 'q=%C2%85', 'state=', 'project=a&project=b', 'q=a&q=b', 'actor=owner', 'limit=1'])
      errorsOnly(await c.request('owner', 'GET', `${list}?${query}`, undefined, 400));
  });

  test('new owner-only contact HTTP routes deny project members and never leak private fields', async t => {
    const c = await setup(t);
    const request = command(c, 'set_state', { state: '完了' });
    const preview = await c.request('owner', 'POST', `${commands}/preview`, request);
    const before = await snapshot(c.store);
    const paths = [list, `${list}/${contacts.normal}`, `${list}/${contacts.sensitive}`,
      `${list}/${contacts.normal}/history`, `${list}/${contacts.normal}/body`, `${ledger}/waiting`];
    for (const actor of ['editor', 'viewer', 'outsider']) {
      c.principals[actor].role = 'owner'; // An asserted role cannot replace a persisted owner.
      for (const path of paths) errorsOnly(await c.request(actor, 'GET', path, undefined, 403));
      errorsOnly(await c.request(actor, 'POST', `${commands}/preview`, request, 403));
      errorsOnly(await c.request(actor, 'POST', `${commands}/apply`, preview, 403));
    }
    for (const path of paths) errorsOnly(await c.request('other_owner', 'GET', path, undefined, 404));
    const owner = await c.request('owner', 'GET', `${list}/${contacts.sensitive}`);
    assert.equal(owner.contact.sensitive, '合成の制限');
    assert.equal((await c.request('owner', 'GET', `${list}/${contacts.normal}/body`)).body, 'SYNTHETIC_PRIVATE_CONTACT_BODY');
    assert.deepEqual(await snapshot(c.store), before);
    errorsOnly(await c.request('owner', 'GET', `${list}/c-20260101-ffffffff/history`, undefined, 404));
  });

  test('draft preview is read-only and apply retains every field, stable identity and private history', async t => {
    const c = await setup(t);
    const before = await snapshot(c.store);
    const request = command(c, 'add_draft', { project: '合成案件', body: '合成本文\n次の行', note: '合成補足',
      due: '日時未確認', sensitive: '合成制限', source_path: '/synthetic/private.txt', source_hash: 'synthetic_hash',
      extra: { synthetic_header: '合成値' } });
    const preview = await c.request('owner', 'POST', `${commands}/preview`, request);
    assert.equal(preview.before, null);
    assert.match(preview.request.contact_id, /^c-20260101-[0-9a-f]{8}$/);
    assert.equal(preview.after.contact.state, '下書き');
    assert.equal(preview.after.contact.state_inferred, false);
    assert.equal(preview.after.contact.created_at, clockTime);
    assert.deepEqual(await snapshot(c.store), before);
    const result = await c.request('owner', 'POST', `${commands}/apply`, preview);
    assert.deepEqual(result, preview.after);
    const after = await snapshot(c.store);
    assert.deepEqual(await c.request('owner', 'POST', `${commands}/apply`, preview), result);
    assert.deepEqual(await snapshot(c.store), after);
    const history = await c.request('owner', 'GET', `${list}/${result.contact.id}/history`);
    assert.equal(history.events.length, 1);
    const event = history.events[0];
    assert.equal(event.requester_member_id, ids.owner);
    assert.equal(event.at_utc, clockTime);
    assert.deepEqual(event.before, null);
    assert.deepEqual(event.after, result);
    assert.equal(event.reason, request.reason);
    for (const [field, value] of Object.entries(result.contact)) {
      const change = event.changes.find(row => row.field === field);
      assert.deepEqual(change, { field, before_present: false, after_present: true, before: null, after: value });
    }
    assert.deepEqual(await c.store.read(tx => tx.events.list(ids.workspace)), []);
    assert.deepEqual((await c.request('owner', 'GET', `${list}/${result.contact.id}`)), result);
  });

  test('all 36 state transitions follow Python and unchanged states are true no-ops', async t => {
    const c = await setup(t);
    for (const [i, from] of CONTACT_STATES.entries()) for (const [j, to] of CONTACT_STATES.entries()) {
      const id = `c-20260101-${(300 + i * 6 + j).toString(16).padStart(8, '0')}`;
      await insertContacts(c, [[id, { state: from, state_inferred: true }]]);
      const before = await c.request('owner', 'GET', `${list}/${id}`);
      const { preview, result } = await apply(c, command(c, 'set_state', { state: to }, { contact_id: id }));
      assert.deepEqual(preview.before, before);
      assert.equal(result.contact.state, to);
      assert.equal(result.contact.state_inferred, from === to);
      assert.equal(result.version, from === to ? 1 : 2);
      const history = await c.request('owner', 'GET', `${list}/${id}/history`);
      assert.equal(history.events.length, from === to ? 0 : 1);
      if (from === to) assert.deepEqual(result, before);
      else {
        assert.notEqual(result.contact.updated_at, before.contact.updated_at);
        const change = history.events[0].changes.find(row => row.field === 'state');
        assert.equal(change.before, from); assert.equal(change.after, to);
      }
      assert.deepEqual(await c.request('owner', 'POST', `${commands}/apply`, preview), result);
    }
  });

  test('reply records trimmed multiline summary and clears inferred status only when state changes', async t => {
    const c = await setup(t);
    const first = await add(c, { note: '合成の前の補足', state_inferred: true });
    const { result } = await apply(c, command(c, 'record_reply', { summary: '  合成の返信\n次の行  ' },
      { contact_id: first.result.contact.id, expected_version: 1 }));
    assert.equal(result.contact.note, '合成の前の補足\n返信要約: 合成の返信\n次の行');
    assert.equal(result.contact.state, '対応中');
    assert.equal(result.contact.state_inferred, false);
    const history = await c.request('owner', 'GET', `${list}/${result.contact.id}/history`);
    assert.equal(history.events.length, 2);
    assert.deepEqual(history.events[1].before, first.result);
    assert.deepEqual(history.events[1].after, result);
    const id = 'c-20260101-00000300';
    await insertContacts(c, [[id, { state: '対応中', state_inferred: true }]]);
    const already = await apply(c, command(c, 'record_reply', { summary: '合成返信' }, { contact_id: id }));
    assert.equal(already.result.contact.state_inferred, true);
    assert.equal(already.result.contact.note, '返信要約: 合成返信');
    const bom = await apply(c, command(c, 'record_reply', { summary: '\uFEFF' }, { contact_id: id, expected_version: 2 }));
    assert.equal(bom.result.contact.note, '返信要約: 合成返信\n返信要約: \uFEFF');
  });

  test('contact command input rejects foreign fields and invalid words without writes', async t => {
    const c = await setup(t);
    const before = await snapshot(c.store);
    const bad = [
      command(c, 'set_state', { state: '待ち' }), command(c, 'set_state', { state: 1 }),
      command(c, 'set_state', { state: '完了', body: '合成' }), command(c, 'record_reply', { summary: ' \n\t ' }),
      command(c, 'record_reply', { summary: 1 }), command(c, 'record_reply', { summary: '\u0085\u001c' }), command(c, 'add_draft', { state: '完了' }),
      command(c, 'add_draft', { created_at: clockTime }), command(c, 'add_draft', { updated_at: clockTime }),
      command(c, 'add_draft', { id: contacts.normal }), command(c, 'add_draft', { extra: { bad: 1 } }),
      command(c, 'add_draft', { state_inferred: 1 }), command(c, 'add_draft', { body: null }),
      command(c, 'set_state', { state: '完了' }, { expected_version: true }),
      command(c, 'set_state', { state: '完了' }, { expected_version: 0 }),
      command(c, 'add_draft', {}, { expected_version: 1 }), command(c, 'set_state', { state: '完了' }, { contact_id: null }),
      { ...command(c, 'add_draft', {}), actor: ids.owner },
    ];
    for (const input of bad) errorsOnly(await c.request('owner', 'POST', `${commands}/preview`, input, 400));
    assert.deepEqual(await snapshot(c.store), before);
  });

  test('contact stale versions, tampering, cross-source and operation collisions are typed and atomic', async t => {
    const c = await setup(t);
    const request = command(c, 'set_state', { state: '完了' });
    const stale = await c.request('owner', 'POST', `${commands}/preview`, request);
    const { result } = await apply(c, command(c, 'record_reply', { summary: '合成返信' }));
    const before = await snapshot(c.store);
    assert.deepEqual(await c.request('owner', 'POST', `${commands}/apply`, stale, 409), { error: 'version_conflict' });
    assert.deepEqual(await c.request('owner', 'POST', `${commands}/preview`, request, 409), { error: 'version_conflict' });
    const altered = structuredClone(stale); altered.after.contact.body = '合成の改ざん';
    errorsOnly(await c.request('owner', 'POST', `${commands}/apply`, altered, 403));
    errorsOnly(await c.request('owner', 'POST', `${workspace}/sources/${ids.otherSource}/contacts/commands/apply`, stale, 403));
    assert.deepEqual(await snapshot(c.store), before);
    const next = await apply(c, command(c, 'set_state', { state: '完了' }, { expected_version: result.version }));
    const collision = command(c, 'record_reply', { summary: '合成の別操作' },
      { operation_id: next.preview.request.operation_id, expected_version: next.result.version });
    const preview = await c.request('owner', 'POST', `${commands}/preview`, collision);
    assert.deepEqual(await c.request('owner', 'POST', `${commands}/apply`, preview, 409), { error: 'operation_conflict' });
    const noOp = await c.request('owner', 'POST', `${commands}/preview`, command(c, 'set_state', { state: '完了' }, { expected_version: next.result.version }));
    await apply(c, command(c, 'set_state', { state: '下書き' }, { expected_version: next.result.version }));
    errorsOnly(await c.request('owner', 'POST', `${commands}/apply`, noOp, 409));
  });

  test('contact action applies roll back contact and history together and bind route', async t => {
    const c = await setup(t);
    const request = command(c, 'record_reply', { summary: '合成返信' });
    const preview = await c.service.contactLedger.previewCommand(c.principals.owner, ids.workspace, ids.source, request);
    const before = await snapshot(c.store);
    const failing = new ContactLedgerService({ ...c.dependencies, store: {
      read: c.store.read.bind(c.store),
      transaction: run => c.store.transaction(tx => run(new Proxy(tx, { get(target, key) {
        if (key !== 'contacts') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        return new Proxy(target.contacts, { get(port, name) {
          if (name === 'append') return async () => { throw new Error('synthetic history failure'); };
          const value = Reflect.get(port, name, port); return typeof value === 'function' ? value.bind(port) : value;
        } });
      } }))),
    } });
    await assert.rejects(() => failing.applyCommand(c.principals.owner, ids.workspace, ids.source, preview), /synthetic history failure/);
    assert.deepEqual(await snapshot(c.store), before);
    const otherRoute = new ContactLedgerService({ ...c.dependencies, route: 'shared-cli' });
    await assert.rejects(() => otherRoute.applyCommand(c.principals.owner, ids.workspace, ids.source, preview), e => e.code === 'invalid_preview');
    const signer = await createConfirmationSigner(new Uint8Array(32).fill(8));
    const otherSigner = new ContactLedgerService({ ...c.dependencies, signer });
    await assert.rejects(() => otherSigner.applyCommand(c.principals.owner, ids.workspace, ids.source, preview), e => e.code === 'invalid_preview');
    const results = await Promise.allSettled([c.service.contactLedger.applyCommand(c.principals.owner, ids.workspace, ids.source, preview),
      c.service.contactLedger.applyCommand(c.principals.owner, ids.workspace, ids.source, preview)]);
    const successful = results.filter(result => result.status === 'fulfilled');
    assert.ok(successful.length >= 1);
    for (const result of results) {
      if (result.status === 'fulfilled') assert.deepEqual(result.value, successful[0].value);
      else { assert.equal(result.reason.status, 409); assert.equal(result.reason.code, 'version_conflict'); }
    }
    // An optimistic adapter may detect the concurrent transaction before replay;
    // retrying the exact same signed operation then returns the committed result.
    assert.deepEqual(await c.service.contactLedger.applyCommand(c.principals.owner, ids.workspace, ids.source, preview), successful[0].value);
    assert.equal((await c.service.contactLedger.history(c.principals.owner, ids.workspace, ids.source, contacts.normal)).length, 1);
  });

  test('whose-turn rows mirror Python project grouping, active precedence, due dates and summaries', async t => {
    const c = await setup(t);
    const cid = n => `c-20260101-${n.toString(16).padStart(8, '0')}`;
    await insertContacts(c, [
      [cid(700), { project: ' 合成A ', state: '回答待ち', due: ' 2026-01-03 ', body: '\n 要約   A\nignored' }],
      [cid(701), { project: '合成A', state: '対応中', due: '2025-12-31', body: '要約 A' }],
      [cid(702), { project: '合成A', state: '完了', due: '2020-01-01', body: 'closed summary' }],
      [cid(703), { project: '合成B', state: '回答待ち', due: '2026-02-30', body: '', source_path: 'C:\\synthetic\\topic.final.md' }],
      [cid(704), { project: '', state: '下書き', due: '2026-01-01', body: '' }],
      [cid(705), { project: '   ', state: '回答待ち', due: '', body: '別の連絡' }],
      [cid(706), { project: '合成C', state: '送信済み', due: '2020-01-01', body: 'closed summary' }],
      [cid(707), { project: '合成C', state: '送らない', body: 'closed summary' }],
    ]);
    const rows = (await c.request('owner', 'GET', `${ledger}/waiting?today=2026-01-01`)).items;
    const a = rows.find(row => row.project === '合成A');
    assert.deepEqual(a, { project: '合成A', turn: 'こちら', due: '2025-12-31', overdue: true,
      states: ['回答待ち', '対応中'], summaries: ['要約 A'], contact_ids: [cid(700), cid(701)], count: 2,
      ledger_names: [], contact_refs: [cid(700), cid(701)] });
    assert.equal(rows[0].project, '合成A');
    assert.equal(rows.filter(row => row.project === null).length, 2);
    assert.equal(rows.find(row => row.contact_ids.includes(cid(704))).overdue, false);
    assert.equal(rows.find(row => row.project === '合成B').due, null);
    assert.deepEqual(rows.find(row => row.project === '合成B').summaries, ['topic.final']);
    assert.ok(!rows.some(row => row.project === '合成C'));
    const all = (await c.request('owner', 'GET', `${ledger}/waiting?include_all=true&include_summaries=false&today=2026-01-01`)).items;
    const closed = all.find(row => row.project === '合成C');
    assert.equal(closed.turn, null); assert.equal(closed.due, null); assert.equal(closed.overdue, false);
    assert.equal(closed.count, 2);
    assert.deepEqual(all.find(row => row.project === '合成A').contact_ids, [cid(700), cid(701), cid(702)]);
    assert.ok(all.every(row => row.summaries.length === 0));
    assert.equal(new Set(all.filter(row => row.project !== null).map(row => row.project)).size, all.filter(row => row.project !== null).length);
    for (const query of ['include_all=1', 'include_summaries=no', 'today=2026-02-30', 'today=2026-1-01', 'today=', 'today=%202026-01-01%20', 'include_all=true&include_all=false'])
      errorsOnly(await c.request('owner', 'GET', `${ledger}/waiting?${query}`, undefined, 400));
  });

  test('whose-turn default today uses workspace calendar day and exact Python summary behavior', async t => {
    const c = await setup(t);
    await c.store.transaction(async tx => { const w = await tx.workspaces.get(ids.workspace); await tx.workspaces.put({ ...w, timezone: 'America/Los_Angeles' }); });
    const id = 'c-20260101-00000400';
    await insertContacts(c, [[id, { project: '合成の時差', due: '2025-12-31', body: '\n\t\nline\t spaced\u2028next' }]]);
    const row = (await c.request('owner', 'GET', `${ledger}/waiting`)).items.find(r => r.project === '合成の時差');
    assert.equal(row.overdue, false);
    assert.deepEqual(row.summaries, ['line spaced']);
    const next = (await c.request('owner', 'GET', `${ledger}/waiting?today=2026-01-01`)).items.find(r => r.project === '合成の時差');
    assert.equal(next.overdue, true);
    const draft = await add(c, {});
    assert.match(draft.result.contact.id, /^c-20251231-[0-9a-f]{8}$/);
  });

  test('my project roles expose only authenticated self and effective persisted grants', async t => {
    const c = await setup(t);
    assert.deepEqual(await c.request('owner', 'GET', rolePath), { member_id: ids.owner,
      items: [{ project_id: ids.project, role: 'owner' }, { project_id: ids.hiddenProject, role: 'owner' }] });
    for (const [actor, role] of [['editor', 'editor'], ['viewer', 'viewer']]) {
      c.principals[actor].role = 'owner';
      assert.deepEqual(await c.request(actor, 'GET', rolePath), { member_id: ids[actor], items: [{ project_id: ids.project, role }] });
    }
    assert.deepEqual(await c.request('outsider', 'GET', rolePath), { member_id: ids.outsider, items: [] });
    await c.store.transaction(async tx => {
      const project = await tx.resources.get(ids.workspace, ids.hiddenProject);
      await tx.resources.put({ ...project, archived: true, version: 2 }, 1);
    });
    assert.deepEqual((await c.request('owner', 'GET', rolePath)).items,
      [{ project_id: ids.project, role: 'owner' }, { project_id: ids.hiddenProject, role: 'owner' }]);
    for (const query of [`member_id=${ids.owner}`, `subject=${c.principals.owner.account_subject}`, 'actor=owner'])
      errorsOnly(await c.request('viewer', 'GET', `${rolePath}?${query}`, undefined, 400));
    errorsOnly(await c.request('viewer', 'GET', `${workspace}/project-roles/${ids.owner}`, undefined, 404));
    errorsOnly(await c.request('other_owner', 'GET', rolePath, undefined, 404));
    await c.store.transaction(async tx => {
      await tx.memberships.put({ scope: 'project', workspace_id: ids.workspace, member_id: ids.viewer,
        project_id: ids.project, role: null, version: 2 }, 1);
    });
    assert.deepEqual(await c.request('viewer', 'GET', rolePath), { member_id: ids.viewer, items: [] });
    await c.store.transaction(async tx => {
      const m = (await tx.memberships.list(ids.workspace)).find(row => row.scope === 'workspace' && row.member_id === ids.viewer);
      await tx.memberships.put({ ...m, active: false, version: 2 }, 1);
    });
    errorsOnly(await c.request('viewer', 'GET', rolePath, undefined, 403));
  });
}
