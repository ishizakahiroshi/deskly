import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceService } from '../../.build/service.js';
import { createHttpHandler } from '../../.build/http.js';
import { CaseSettingsError, parseCaseSettingsJson, parseCaseSettingsToml } from '../../.build/case-settings.js';
import { caseSettings as settings } from './case-api.mjs';
import { assertApiSchema, assertEntitySchema, assertHttpContract } from './schema-validation.mjs';
import { clockTime, ids, uuid } from './fixtures.mjs';

// Member case scopes (C8-5). Every member, app, tenant and title below is synthetic.
const origin = 'https://deskly.example';
const workspace = `/api/v1/workspaces/${ids.workspace}`;
const cases = `${workspace}/cases`;
const scopesPath = `${cases}/member-scopes`;
const mePath = `${scopesPath}/me`;
const scopePath = (member) => `${scopesPath}/${member}`;
const casePath = (number, rest = '') => `${cases}/${number}${rest}`;
const [firstKind] = settings.kinds.values;
const needsApproval = settings.kinds.requires_approval[0];
const [firstTerminal] = settings.statuses.terminal;
const { hold, initial: pendingApproval } = settings.approval_states;
const decided = settings.approval_states.values.find((state) => ![hold, pendingApproval, settings.approval_states.initial_free].includes(state));
/** The example settings with only [member_access] turned on, as an operator would after the organization agrees. */
const enabledSettings = parseCaseSettingsJson(JSON.stringify({ ...JSON.parse(JSON.stringify(settings)), member_access: { enabled: true } }));

const newCase = (overrides = {}) => ({ origin: 'human', kind: firstKind, title: '合成の受付', body: '合成の本文',
  reporter_ref: 'u-synthetic-1', place: { screen_id: 'synthetic-screen' }, ...overrides });
const errorOnly = (value, code) => {
  assert.deepEqual(Object.keys(value), ['error']);
  if (code) assert.equal(value.error, code);
};
const rejects = (run, status, code) => assert.rejects(run, (error) => {
  assert.equal(error.status, status, `${error.code ?? error.name}: ${error.message}`);
  if (code) assert.equal(error.code, code);
  return true;
});
/** Wrap one store so selected session ports misbehave; never alters stored fixtures. */
function facade(target, overrides) {
  return new Proxy(Object.create(null), {
    get(_facade, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_facade, key) { return Object.hasOwn(overrides, key) || key in target; },
  });
}
const withSessions = (store, transform) => facade(store, Object.fromEntries(['read', 'transaction'].map((mode) =>
  [mode, (run) => store[mode]((session) => run(transform(session)))])));

/** The same request as the suite's c.request, through another handler; successes count for OpenAPI coverage. */
async function call(handler, covered, actor, method, path, body, expectedStatus = 200, extraHeaders = {}) {
  const headers = { host: 'deskly.example', origin, 'sec-fetch-site': 'same-origin', ...extraHeaders };
  if (actor !== null) headers['x-contract-actor'] = actor;
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  const response = await handler(new Request(`${origin}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${await response.clone().text()}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const result = await response.json();
  const operationId = assertHttpContract(method, path, response.status, result);
  if (response.status === 200 && operationId) covered.add(operationId);
  return result;
}
/** A service and handler over the same store with member access enabled (the restart after the settings change). */
function enabled(c) {
  const service = new WorkspaceService({ ...c.dependencies, caseSettings: enabledSettings });
  const handler = createHttpHandler({ service, authenticator: c.authenticator, appAuthenticator: c.appAuthenticator, origin });
  const request = (actor, method, path, body, status = 200, headers = {}) => call(handler, c.covered, actor, method, path, body, status, headers);
  return { service, request, send: (app, method, path, body, status = 200) => request(null, method, path, body, status, { 'x-contract-app': app }) };
}
const send = (c, app, method, path, body, status = 200) => c.request(null, method, path, body, status, { 'x-contract-app': app });
const scopeBody = (expected_revision, role, sources, tenants, extra = {}) => ({ expected_revision, role, sources, tenants, ...extra });
const grant = (e, member, body, status = 200) => e.request('owner', 'PUT', scopePath(member), body, status);
const numbersOf = (result) => result.items.map(({ number }) => number);

/**
 * Four synthetic cases: a1 and a2 (source app_one, tenant_a), b1 (app_one, tenant_b)
 * and t1 (app_two, no tenant). Listed in created_at, source, seq order: a1, b1, a2, t1.
 */
async function fourCases(c) {
  const a1 = (await send(c, 'app_one', 'POST', cases, newCase({ title: '合成の見える題名' }))).number;
  const b1 = (await send(c, 'app_one_b', 'POST', cases, newCase({ title: '合成の別顧客の題名', place: { screen_id: 'synthetic-hidden' } }))).number;
  const a2 = (await send(c, 'app_one', 'POST', cases, newCase({ kind: needsApproval, place: { screen_id: 'synthetic-other' } }))).number;
  const t1 = (await send(c, 'app_two', 'POST', cases, newCase({ title: '合成の別アプリの題名' }))).number;
  return { a1, b1, a2, t1 };
}
/** Every case row and child row of both synthetic workspaces, through public ports only. */
function caseSnapshot(store) {
  return store.read(async (session) => {
    const result = [];
    for (const w of [ids.workspace, ids.otherWorkspace]) {
      for (const row of await session.cases.list(w)) {
        result.push({ row, events: await session.cases.events(w, row.number), people: await session.cases.people(w, row.number),
          replies: await session.cases.replies(w, row.number), links: await session.cases.links(w, row.number) });
      }
    }
    return result;
  });
}
/** Every member scope and history row of both synthetic workspaces. */
function scopeSnapshot(store) {
  return store.read(async (session) => Promise.all([ids.workspace, ids.otherWorkspace].map(async (w) => ({
    items: await session.caseMemberScopes.list(w), events: await session.caseMemberScopes.events(w) }))));
}

/** Exercise every member-scope operation once (with member access enabled) for the shared OpenAPI coverage test. */
export async function exerciseCaseMemberScopeOperations(c) {
  const e = enabled(c);
  await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a']));
  await e.request('owner', 'GET', scopesPath);
  await e.request('viewer', 'GET', mePath);
}

/** Added to runContractSuite; every adapter (memory, SQLite, D1) runs every test here. */
export function registerCaseMemberScopeTests(setup) {
  const caseTest = (name, run) => test(name, async (t) => run(await setup(t), t));

  test('[member_access] is off unless written as true and stops startup when malformed', () => {
    assert.equal(settings.member_access.enabled, false, 'the example settings keep member access off');
    const document = JSON.parse(JSON.stringify(settings));
    delete document.member_access;
    assert.deepEqual(parseCaseSettingsJson(JSON.stringify(document)).member_access, { enabled: false }, 'an absent table means off');
    assert.equal(enabledSettings.member_access.enabled, true);
    assert.ok(Object.isFrozen(enabledSettings.member_access));
    for (const [access, pattern] of [
      [{ enabled: 'true' }, /member_access\.enabled must be true or false/],
      [{ enabled: 1 }, /member_access\.enabled/],
      [{}, /missing key member_access\.enabled/],
      [{ enabled: true, everyone: true }, /unknown key member_access\.everyone/],
      [true, /member_access must be a table/],
    ]) {
      assert.throws(() => parseCaseSettingsJson(JSON.stringify({ ...document, member_access: access })),
        (error) => error instanceof CaseSettingsError && pattern.test(error.message));
    }
    const toml = (value) => `[kinds]\nvalues = ["alpha"]\n[statuses]\nvalues = ["open_a", "closed_z"]\nopen = ["open_a"]\n`
      + `terminal = ["closed_z"]\ninitial = "open_a"\nwaiting = { open_a = "us", closed_z = "none" }\n`
      + `[approval_states]\nvalues = ["free_x"]\ninitial = "free_x"\ninitial_free = "free_x"\nhold = "free_x"\n${value}`;
    assert.equal(parseCaseSettingsToml(toml('[member_access]\nenabled = true\n')).member_access.enabled, true);
    assert.equal(parseCaseSettingsToml(toml('')).member_access.enabled, false);
    assert.throws(() => parseCaseSettingsToml(toml('[member_access]\nenabled = "yes"\n')), CaseSettingsError);
  });

  caseTest('disabled (the default): members other than the owner are refused as before and no member scope is read', async (c) => {
    const { a1 } = await fourCases(c);
    // A scope row written straight into storage changes nothing while member access is off.
    await c.store.transaction(async (session) => {
      const row = { workspace_id: ids.workspace, member_id: ids.viewer, role: 'editor', sources: ['*'], tenants: ['*'], numbers: [],
        revision: 1, updated_by: ids.owner, updated_at: clockTime };
      await session.caseMemberScopes.put(row, 0);
      await session.caseMemberScopes.appendEvent({ workspace_id: ids.workspace, seq: 1, member_id: ids.viewer, action: 'grant',
        actor_member_id: ids.owner, reason: null, at_utc: clockTime, before: null, after: row });
    });
    const before = await caseSnapshot(c.store);
    for (const actor of ['viewer', 'editor', 'outsider']) {
      for (const path of [cases, `${cases}/panels`, `${cases}/settings`, casePath(a1)]) {
        errorOnly(await c.request(actor, 'GET', path, undefined, 403), 'forbidden');
      }
      errorOnly(await c.request(actor, 'PATCH', casePath(a1), { expected_revision: 1, status: firstTerminal }, 403), 'forbidden');
      errorOnly(await c.request(actor, 'POST', casePath(a1, '/replies'), { body: '合成の返事' }, 403), 'forbidden');
    }
    assert.deepEqual(await caseSnapshot(c.store), before);
    // The member-scope API does not exist while member access is off, for anyone.
    for (const actor of ['owner', 'viewer']) {
      errorOnly(await c.request(actor, 'GET', scopesPath, undefined, 404), 'member_access_not_enabled');
      errorOnly(await c.request(actor, 'GET', mePath, undefined, 404), 'member_access_not_enabled');
      errorOnly(await c.request(actor, 'PUT', scopePath(ids.editor), scopeBody(0, 'viewer', ['*'], ['*']), 404), 'member_access_not_enabled');
    }
    errorOnly(await send(c, 'operator', 'GET', scopesPath, undefined, 404), 'member_access_not_enabled');
    // A service whose member-scope port fails on any use works exactly as before: the port is never touched.
    const touched = [];
    const trap = new Proxy(Object.create(null), { get: (_target, key) => async () => { touched.push(String(key)); throw new Error('synthetic scope read'); } });
    const service = new WorkspaceService({ ...c.dependencies, store: withSessions(c.store, (session) => facade(session, { caseMemberScopes: trap })) });
    assert.equal((await service.cases.list(c.principals.owner, ids.workspace)).length, 4);
    assert.equal((await service.cases.list(c.apps.app_one, ids.workspace)).length, 2);
    await service.cases.panels(c.principals.owner, ids.workspace);
    await service.cases.settingsView(c.principals.owner, ids.workspace);
    await service.cases.read(c.principals.owner, ids.workspace, a1);
    await service.cases.addReply(c.principals.owner, ids.workspace, a1, { body: '合成の返事' });
    for (const actor of ['viewer', 'editor', 'outsider']) {
      await rejects(() => service.cases.list(c.principals[actor], ids.workspace), 403, 'forbidden');
      await rejects(() => service.cases.read(c.principals[actor], ids.workspace, a1), 403, 'forbidden');
    }
    await rejects(() => service.cases.memberScopes(c.principals.owner, ids.workspace), 404, 'member_access_not_enabled');
    assert.deepEqual(touched, []);
  });

  caseTest('enabled: a viewer reads only its scope, cut by source and by tenant', async (c) => {
    const e = enabled(c);
    const { a1, b1, a2, t1 } = await fourCases(c);
    const granted = await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a'], { reason: '合成の付与' }));
    assertEntitySchema('case_member_scope', granted);
    assert.deepEqual(granted, { workspace_id: ids.workspace, member_id: ids.viewer, role: 'viewer', sources: ['app_one'],
      tenants: ['tenant_a'], numbers: [], revision: 1, updated_by: ids.owner, updated_at: clockTime });
    const list = await e.request('viewer', 'GET', cases);
    assertApiSchema('CaseCollection', list);
    assert.deepEqual(numbersOf(list), [a1, a2]);
    assert.equal((await e.request('viewer', 'GET', casePath(a1))).case.number, a1);
    for (const hidden of [b1, t1]) {
      const missing = await e.request('viewer', 'GET', casePath(hidden), undefined, 404);
      assert.deepEqual(missing, await e.request('viewer', 'GET', casePath('app_one-999'), undefined, 404), 'hidden equals absent');
    }
    // Tenant only: every source, one tenant. A case without a tenant is outside a tenant list.
    await grant(e, ids.viewer, scopeBody(1, 'viewer', ['*'], ['tenant_b']));
    assert.deepEqual(numbersOf(await e.request('viewer', 'GET', cases)), [b1]);
    // Source only: one source, every tenant (including none).
    await grant(e, ids.viewer, scopeBody(2, 'viewer', ['app_two'], ['*']));
    assert.deepEqual(numbersOf(await e.request('viewer', 'GET', cases)), [t1]);
    await grant(e, ids.viewer, scopeBody(3, 'viewer', ['app_one', 'app_two'], ['tenant_a', 'tenant_b']));
    assert.deepEqual(numbersOf(await e.request('viewer', 'GET', cases)), [a1, b1, a2]);
    await grant(e, ids.viewer, scopeBody(4, 'viewer', ['*'], ['*']));
    assert.deepEqual(numbersOf(await e.request('viewer', 'GET', cases)), [a1, b1, a2, t1]);
    // The owner and the apps see exactly what they saw before; a member without a scope is still refused.
    assert.deepEqual(numbersOf(await e.request('owner', 'GET', cases)), [a1, b1, a2, t1]);
    assert.deepEqual(numbersOf(await e.send('app_one', 'GET', cases)), [a1, a2]);
    for (const path of [cases, casePath(a1), `${cases}/panels`, `${cases}/settings`]) {
      errorOnly(await e.request('outsider', 'GET', path, undefined, 403), 'forbidden');
    }
    // An asserted role or an inactive principal never replaces the persisted row.
    c.principals.outsider.role = 'owner';
    errorOnly(await e.request('outsider', 'GET', cases, undefined, 403), 'forbidden');
    c.principals.viewer.active = false;
    errorOnly(await e.request('viewer', 'GET', cases, undefined, 403), 'member_inactive');
  });

  caseTest('numbers narrow an external collaborator to the cases it works on', async (c) => {
    const e = enabled(c);
    const { a1, b1, a2, t1 } = await fourCases(c);
    await grant(e, ids.outsider, scopeBody(0, 'editor', ['*'], ['*'], { numbers: [a2, t1, 'app_one-999'] }));
    assert.deepEqual(numbersOf(await e.request('outsider', 'GET', cases)), [a2, t1]);
    errorOnly(await e.request('outsider', 'GET', casePath(a1), undefined, 404), 'not_found');
    errorOnly(await e.request('outsider', 'POST', casePath(a1, '/replies'), { body: '合成の返事' }, 404), 'not_found');
    assert.equal((await e.request('outsider', 'POST', casePath(a2, '/replies'), { body: '合成の返事' })).seq, 1);
    // A listed number outside the sources/tenants stays hidden: numbers only narrow, never widen.
    await grant(e, ids.outsider, scopeBody(1, 'viewer', ['app_one'], ['tenant_a'], { numbers: [a1, b1, t1] }));
    assert.deepEqual(numbersOf(await e.request('outsider', 'GET', cases)), [a1]);
    for (const hidden of [b1, t1, a2]) errorOnly(await e.request('outsider', 'GET', casePath(hidden), undefined, 404), 'not_found');
    const panels = await e.request('outsider', 'GET', `${cases}/panels`);
    assert.equal(panels.open, 1);
    assert.ok(!Object.hasOwn(panels, 'by_source'), 'a number-narrowed scope is not an operator, even with ["*"]');
  });

  caseTest('outside the scope every read and write is the same 404; a viewer cannot write (403)', async (c) => {
    const e = enabled(c);
    const { a1, b1, t1 } = await fourCases(c);
    await grant(e, ids.editor, scopeBody(0, 'editor', ['app_one'], ['tenant_a']));
    await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a']));
    const before = await caseSnapshot(c.store);
    for (const hidden of [b1, t1]) {
      errorOnly(await e.request('editor', 'GET', casePath(hidden), undefined, 404), 'not_found');
      errorOnly(await e.request('editor', 'PATCH', casePath(hidden), { expected_revision: 1, status: firstTerminal }, 404), 'not_found');
      errorOnly(await e.request('editor', 'POST', casePath(hidden, '/people'), { reporter_ref: 'u-synthetic-x' }, 404), 'not_found');
      errorOnly(await e.request('editor', 'POST', casePath(hidden, '/replies'), { body: '合成の返事' }, 404), 'not_found');
      errorOnly(await e.request('editor', 'POST', casePath(hidden, '/links'), { link_type: 'doc', ref: 'synthetic-doc' }, 404), 'not_found');
    }
    // The viewer refusal depends on the scope only, never on the case, so it reveals nothing either.
    for (const number of [a1, b1, 'app_one-999']) {
      errorOnly(await e.request('viewer', 'PATCH', casePath(number), { expected_revision: 1, status: firstTerminal }, 403), 'forbidden');
      errorOnly(await e.request('viewer', 'POST', casePath(number, '/people'), { reporter_ref: 'u-synthetic-x' }, 403), 'forbidden');
      errorOnly(await e.request('viewer', 'POST', casePath(number, '/replies'), { body: '合成の返事' }, 403), 'forbidden');
      errorOnly(await e.request('viewer', 'POST', casePath(number, '/links'), { link_type: 'doc', ref: 'synthetic-doc' }, 403), 'forbidden');
    }
    // Members never create cases: a new case needs the source fixed by an app.
    for (const actor of ['editor', 'viewer']) errorOnly(await e.request(actor, 'POST', cases, newCase(), 403), 'source_not_fixed');
    assert.deepEqual(await caseSnapshot(c.store), before);
    // Direct service calls cut the same way.
    await rejects(() => e.service.cases.addLink(c.principals.viewer, ids.workspace, a1, { link_type: 'doc', ref: 'x' }), 403, 'forbidden');
    await rejects(() => e.service.cases.read(c.principals.editor, ids.workspace, b1), 404, 'not_found');
  });

  caseTest('an editor replies, links, adds people and changes status, approval and deadlines, recorded as the member', async (c) => {
    const e = enabled(c);
    const { a1, a2 } = await fourCases(c);
    await grant(e, ids.editor, scopeBody(0, 'editor', ['app_one'], ['tenant_a']));
    const actor = { kind: 'member', member_id: ids.editor };
    c.clock.time = '2026-01-02T03:04:05Z';
    const closed = await e.request('editor', 'PATCH', casePath(a1), { expected_revision: 1, status: firstTerminal, reason: '合成の完了理由' });
    assertEntitySchema('case', closed);
    assert.equal(closed.closed_at, '2026-01-02T03:04:05Z');
    const held = await e.request('editor', 'PATCH', casePath(a2), { expected_revision: 1, approval_state: hold, hold_until: '2026-03-01' });
    assert.equal(held.hold_until, '2026-03-01');
    const approved = await e.request('editor', 'PATCH', casePath(a2), { expected_revision: 2, approval_state: decided, hold_until: null,
      promised_due: '2026-02-01' });
    assert.deepEqual([approved.approval_state, approved.promised_due, approved.revision], [decided, '2026-02-01', 3]);
    const person = await e.request('editor', 'POST', casePath(a1, '/people'), { reporter_ref: 'u-synthetic-2' });
    const reply = await e.request('editor', 'POST', casePath(a1, '/replies'), { body: '合成の返事', author_ref: 'u-synthetic-admin' });
    const link = await e.request('editor', 'POST', casePath(a1, '/links'), { link_type: 'commit', ref: 'b'.repeat(40) });
    assert.deepEqual([person.added_by, reply.author, link.added_by], [actor, actor, actor]);
    const detail = await e.request('editor', 'GET', casePath(a1));
    assert.deepEqual(detail.events.at(-1).actor, actor);
    assert.deepEqual(detail.events.at(-1).changes, [{ field: 'status', before: settings.statuses.initial, after: firstTerminal },
      { field: 'closed_at', before: null, after: '2026-01-02T03:04:05Z' }]);
    assert.deepEqual((await e.request('editor', 'GET', casePath(a2))).events.map(({ actor: who }) => who.kind), ['app', 'member', 'member']);
    // Optimistic concurrency applies to members exactly as to owners and apps.
    errorOnly(await e.request('editor', 'PATCH', casePath(a1), { expected_revision: 1, status: settings.statuses.initial }, 409), 'version_conflict');
  });

  caseTest('panels and settings never count or name anything outside the member scope', async (c) => {
    const e = enabled(c);
    const { a1, b1, t1 } = await fourCases(c);
    await send(c, 'app_one_b', 'POST', cases, newCase({ title: '合成の別顧客の題名', promised_due: '2025-12-01' }));
    await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a']));
    await grant(e, ids.editor, scopeBody(0, 'editor', ['*'], ['*']));
    const panels = await e.request('viewer', 'GET', `${cases}/panels`);
    assertApiSchema('CasePanels', panels);
    // The same scope as the app_one sender gives exactly the same numbers, without the per-source breakdown.
    assert.deepEqual(panels, await e.send('app_one', 'GET', `${cases}/panels`));
    assert.equal(panels.open, 2);
    assert.equal(panels.overdue, 0);
    assert.ok(!Object.hasOwn(panels, 'by_source'));
    // A member scope over everything is an operator view: the same panels as the owner.
    const all = await e.request('editor', 'GET', `${cases}/panels`);
    assert.deepEqual(all, await e.request('owner', 'GET', `${cases}/panels`));
    assert.ok(Array.isArray(all.by_source));
    // Nothing of the hidden cases appears in any response the viewer gets.
    const ownerSettings = await e.request('owner', 'GET', `${cases}/settings`);
    const viewerSettings = await e.request('viewer', 'GET', `${cases}/settings`);
    assertApiSchema('CaseSettings', viewerSettings);
    assert.deepEqual(viewerSettings.numbering.display_names,
      Object.fromEntries(Object.entries(ownerSettings.numbering.display_names).filter(([source]) => source === 'app_one')));
    assert.deepEqual({ ...viewerSettings, numbering: null }, { ...ownerSettings, numbering: null });
    assert.deepEqual(ownerSettings, JSON.parse(JSON.stringify(enabledSettings)), 'the owner still reads the settings unchanged');
    const seen = JSON.stringify([await e.request('viewer', 'GET', cases), panels, viewerSettings, await e.request('viewer', 'GET', casePath(a1))]);
    for (const hidden of [b1, t1, '合成の別顧客の題名', '合成の別アプリの題名', 'synthetic-hidden', 'tenant_b', 'app_two']) {
      assert.ok(!seen.includes(hidden), `the viewer's responses mention ${hidden}`);
    }
  });

  caseTest('a revocation applies to the very next request, without a restart', async (c) => {
    const e = enabled(c);
    const { a1 } = await fourCases(c);
    await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a']));
    assert.equal(numbersOf(await e.request('viewer', 'GET', cases)).length, 2);
    const revoked = await grant(e, ids.viewer, { expected_revision: 1, role: null, reason: '合成の取り消し' });
    assertEntitySchema('case_member_scope', revoked);
    assert.deepEqual([revoked.role, revoked.sources, revoked.tenants, revoked.numbers, revoked.revision], [null, [], [], [], 2]);
    for (const path of [cases, casePath(a1), `${cases}/panels`, `${cases}/settings`]) {
      errorOnly(await e.request('viewer', 'GET', path, undefined, 403), 'forbidden');
    }
    errorOnly(await e.request('viewer', 'GET', mePath, undefined, 404), 'not_found');
    // Revoking twice is refused; granting again continues the same revision line.
    errorOnly(await grant(e, ids.viewer, { expected_revision: 2, role: null }, 400), 'invalid_grant');
    const again = await grant(e, ids.viewer, scopeBody(2, 'viewer', ['app_one'], ['tenant_a']));
    assert.equal(again.revision, 3);
    assert.equal(numbersOf(await e.request('viewer', 'GET', cases)).length, 2);
    // A deactivated member loses access at once even with a scope, and can still be revoked but not granted.
    const row = (await c.store.read((session) => session.memberships.list(ids.workspace)))
      .find((membership) => membership.scope === 'workspace' && membership.member_id === ids.viewer);
    await c.store.transaction((session) => session.memberships.put({ ...row, active: false, version: 2 }, 1));
    errorOnly(await e.request('viewer', 'GET', cases, undefined, 403), 'forbidden');
    errorOnly(await grant(e, ids.viewer, scopeBody(3, 'editor', ['*'], ['*']), 403), 'invalid_member');
    assert.equal((await grant(e, ids.viewer, { expected_revision: 3, role: null })).role, null);
  });

  caseTest('only the owner grants, changes or revokes, and only for an active member of the workspace', async (c) => {
    const e = enabled(c);
    await grant(e, ids.editor, scopeBody(0, 'editor', ['*'], ['*']));
    const before = await scopeSnapshot(c.store);
    const body = scopeBody(0, 'viewer', ['*'], ['*']);
    // A member with an editor scope still cannot hand out scopes; nor can any app.
    for (const actor of ['editor', 'viewer', 'outsider']) errorOnly(await e.request(actor, 'PUT', scopePath(ids.viewer), body, 403), 'forbidden');
    for (const app of ['app_one', 'operator']) errorOnly(await e.send(app, 'PUT', scopePath(ids.viewer), body, 403), 'forbidden');
    errorOnly(await e.send('foreign', 'PUT', scopePath(ids.viewer), body, 404), 'not_found');
    errorOnly(await e.request('other_owner', 'PUT', scopePath(ids.viewer), body, 404), 'not_found');
    errorOnly(await e.request(null, 'PUT', scopePath(ids.viewer), body, 401), 'unauthorized');
    // Targets: never an owner, a member of another workspace, an unknown member or a malformed ID.
    for (const target of [ids.owner, ids.otherOwner, uuid(999)]) errorOnly(await grant(e, target, body, 403), 'invalid_member');
    errorOnly(await grant(e, 'not-a-uuid', body, 400), 'invalid_id');
    for (const [input, code] of [
      [{}, 'required_field'],
      [{ expected_revision: 0 }, 'required_field'],
      [{ expected_revision: 0, role: 'viewer', tenants: ['*'] }, 'required_field'],
      [{ ...body, role: 'owner' }, 'invalid_role'],
      [{ ...body, role: 'editor ' }, 'invalid_role'],
      [{ ...body, sources: [] }, 'invalid_scope'],
      [{ ...body, sources: ['*', 'app_one'] }, 'invalid_scope'],
      [{ ...body, sources: ['Bad Prefix'] }, 'invalid_scope'],
      [{ ...body, sources: ['app_one', 'app_one'] }, 'invalid_scope'],
      [{ ...body, sources: 'app_one' }, 'invalid_scope'],
      [{ ...body, tenants: [' '] }, 'invalid_scope'],
      [{ ...body, tenants: ['tenant_a', '*'] }, 'invalid_scope'],
      [{ ...body, numbers: ['*'] }, 'invalid_scope'],
      [{ ...body, numbers: ['not a number'] }, 'invalid_scope'],
      [{ ...body, numbers: ['app_one-0'] }, 'invalid_scope'],
      [{ ...body, member_id: ids.viewer }, 'invalid_fields'],
      [{ expected_revision: 1, role: null, sources: [] }, 'invalid_fields'],
      [{ expected_revision: 0, role: null }, 'invalid_grant'],
      [{ ...body, expected_revision: -1 }, 'invalid_version'],
      [{ ...body, expected_revision: true }, 'invalid_version'],
      [{ ...body, reason: ' ' }, 'required_field'],
    ]) errorOnly(await grant(e, ids.viewer, input, 400), code);
    errorOnly(await e.request('owner', 'PUT', `${scopePath(ids.viewer)}?apply=true`, body, 400), 'invalid_query');
    errorOnly(await e.request('owner', 'GET', `${scopesPath}?member_id=${ids.viewer}`, undefined, 400), 'invalid_query');
    // Revisions are compared exactly: a second create and a stale change are bare 409s.
    errorOnly(await grant(e, ids.editor, body, 409), 'version_conflict');
    errorOnly(await grant(e, ids.editor, scopeBody(2, 'viewer', ['*'], ['*']), 409), 'version_conflict');
    errorOnly(await grant(e, ids.viewer, { expected_revision: 1, role: null }, 409), 'version_conflict');
    assert.deepEqual(await scopeSnapshot(c.store), before, 'no refused request wrote a scope or an event');
    // Concurrent grants for the same member admit exactly one.
    const results = await Promise.allSettled(['viewer', 'editor'].map((role) =>
      e.service.cases.setMemberScope(c.principals.owner, ids.workspace, ids.viewer, scopeBody(0, role, ['*'], ['*']))));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.find(({ status }) => status === 'rejected').reason.status, 409);
  });

  caseTest('every grant, change and revocation is kept with who, when and what, and nothing removes it', async (c) => {
    const e = enabled(c);
    await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a'], { reason: '合成の付与' }));
    c.clock.time = '2026-01-02T00:00:00Z';
    const changed = await grant(e, ids.viewer, scopeBody(1, 'editor', ['app_one'], ['tenant_a'], { numbers: ['app_one-1'] }));
    // An identical request passes the checks but writes nothing.
    assert.deepEqual(await grant(e, ids.viewer, scopeBody(2, 'editor', ['app_one'], ['tenant_a'], { numbers: ['app_one-1'] })), changed);
    c.clock.time = '2026-01-03T00:00:00Z';
    const revoked = await grant(e, ids.viewer, { expected_revision: 2, role: null, reason: '合成の取り消し' });
    await grant(e, ids.outsider, scopeBody(0, 'viewer', ['*'], ['*']));
    const result = await e.request('owner', 'GET', scopesPath);
    assertApiSchema('CaseMemberScopeCollection', result);
    assert.deepEqual(result.items.map(({ member_id, role }) => [member_id, role]), [[ids.viewer, null], [ids.outsider, 'viewer']].sort());
    for (const event of result.events) assertEntitySchema('case_member_scope_event', event);
    assert.deepEqual(result.events.map(({ seq, member_id, action, actor_member_id, at_utc, reason }) =>
      [seq, member_id, action, actor_member_id, at_utc, reason]), [
      [1, ids.viewer, 'grant', ids.owner, clockTime, '合成の付与'],
      [2, ids.viewer, 'change', ids.owner, '2026-01-02T00:00:00Z', null],
      [3, ids.viewer, 'revoke', ids.owner, '2026-01-03T00:00:00Z', '合成の取り消し'],
      [4, ids.outsider, 'grant', ids.owner, '2026-01-03T00:00:00Z', null],
    ]);
    assert.equal(result.events[0].before, null);
    assert.deepEqual(result.events[1].before, result.events[0].after);
    assert.deepEqual(result.events[1].after, changed);
    assert.deepEqual(result.events[2].after, revoked);
    assert.deepEqual(revoked.updated_by, ids.owner);
    // A failed history write leaves no scope behind: the scope and its event are one transaction.
    const before = await scopeSnapshot(c.store);
    const sentinel = new Error('Synthetic scope event failure');
    const failing = new WorkspaceService({ ...c.dependencies, caseSettings: enabledSettings, store: withSessions(c.store, (session) =>
      facade(session, { caseMemberScopes: facade(session.caseMemberScopes, { appendEvent: async () => { throw sentinel; } }) })) });
    await assert.rejects(() => failing.cases.setMemberScope(c.principals.owner, ids.workspace, ids.editor,
      scopeBody(0, 'viewer', ['*'], ['*'])), (error) => error === sentinel);
    assert.deepEqual(await scopeSnapshot(c.store), before);
    // The port has no way to remove a scope or a history row, and its rules hold on every adapter.
    const methods = await c.store.read(async (session) => {
      const names = new Set();
      for (let value = session.caseMemberScopes; value && value !== Object.prototype; value = Object.getPrototypeOf(value)) {
        for (const name of Object.getOwnPropertyNames(value)) names.add(name);
      }
      return [...names];
    });
    assert.ok(!methods.some((name) => /delete|remove|drop|purge|clear/i.test(name)), methods.join(','));
    const stored = (await scopeSnapshot(c.store))[0];
    const outsiderRow = stored.items.find(({ member_id }) => member_id === ids.outsider);
    await assert.rejects(c.store.transaction((session) => session.caseMemberScopes.put({ ...outsiderRow, revision: 3 }, 1)),
      (error) => error.code === 'version_conflict');
    await assert.rejects(c.store.transaction((session) => session.caseMemberScopes.put({ ...outsiderRow, revision: 1 }, 0)),
      (error) => error.code === 'duplicate_id');
    await assert.rejects(c.store.transaction((session) => session.caseMemberScopes.appendEvent({ ...stored.events[0], seq: 2 })),
      (error) => error.code === 'operation_conflict');
    await assert.rejects(c.store.read((session) => session.caseMemberScopes.put({ ...outsiderRow, revision: 2 }, 1)), /immutable/);
    await assert.rejects(c.store.read((session) => session.caseMemberScopes.appendEvent({ ...stored.events[0], seq: 5 })), /immutable/);
    assert.deepEqual(await scopeSnapshot(c.store), before);
  });

  caseTest('no member reads another member\'s scope; each reads only its own', async (c) => {
    const e = enabled(c);
    await grant(e, ids.viewer, scopeBody(0, 'viewer', ['app_one'], ['tenant_a']));
    const editorScope = await grant(e, ids.editor, scopeBody(0, 'editor', ['app_two'], ['*'], { numbers: ['app_two-1'] }));
    for (const actor of ['viewer', 'editor', 'outsider']) errorOnly(await e.request(actor, 'GET', scopesPath, undefined, 403), 'forbidden');
    for (const app of ['app_one', 'operator']) errorOnly(await e.send(app, 'GET', scopesPath, undefined, 403), 'forbidden');
    errorOnly(await e.request('other_owner', 'GET', scopesPath, undefined, 404), 'not_found');
    errorOnly(await e.request(null, 'GET', scopesPath, undefined, 401), 'unauthorized');
    const own = await e.request('viewer', 'GET', mePath);
    assertEntitySchema('case_member_scope', own);
    assert.equal(own.member_id, ids.viewer);
    assert.deepEqual([own.sources, own.tenants, own.numbers], [['app_one'], ['tenant_a'], []]);
    assert.ok(!JSON.stringify(own).includes('app_two'), 'the viewer never sees the editor scope');
    assert.deepEqual(await e.request('editor', 'GET', mePath), editorScope);
    // No scope, the owner (who needs none) and other workspaces: not found. Apps are not members.
    for (const actor of ['outsider', 'owner', 'other_owner']) errorOnly(await e.request(actor, 'GET', mePath, undefined, 404), 'not_found');
    for (const app of ['app_one', 'operator']) errorOnly(await e.send(app, 'GET', mePath, undefined, 403), 'forbidden');
    errorOnly(await e.request('viewer', 'GET', `${mePath}?member_id=${ids.editor}`, undefined, 400), 'invalid_query');
    // The member ID in the principal is the only key: asserting another role changes nothing.
    c.principals.viewer.role = 'owner';
    errorOnly(await e.request('viewer', 'GET', scopesPath, undefined, 403), 'forbidden');
    assert.equal((await e.request('viewer', 'GET', mePath)).member_id, ids.viewer);
  });
}
