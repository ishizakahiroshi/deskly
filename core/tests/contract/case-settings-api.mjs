import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceService } from '../../.build/service.js';
import { parseCaseSettingsJson } from '../../.build/case-settings.js';
import { caseSettings as settings } from './case-api.mjs';
import { assertApiSchema } from './schema-validation.mjs';
import { ids, principalFixtures } from './fixtures.mjs';

const workspace = `/api/v1/workspaces/${ids.workspace}`;
const settingsPath = `${workspace}/cases/settings`;
const send = (c, app, method, path, body, status = 200) => c.request(null, method, path, body, status, { 'x-contract-app': app });
const errorOnly = (value, code) => {
  assert.deepEqual(Object.keys(value), ['error']);
  assert.equal(value.error, code);
};
const rejects = (run, status, code) => assert.rejects(run, (error) => {
  assert.equal(error.status, status, `${error.code ?? error.name}: ${error.message}`);
  assert.equal(error.code, code);
  return true;
});
/** Wrap one store so a session lacks its case port; never alters stored fixtures. */
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
const withoutCasePort = (store) => facade(store, Object.fromEntries(['read', 'transaction'].map((mode) =>
  [mode, (run) => store[mode]((session) => run(facade(session, { cases: undefined })))])));

/** Added to runContractSuite; every adapter (memory, SQLite, D1) runs every test here. */
export function registerCaseSettingsTests(setup) {
  const caseTest = (name, run) => test(name, async (t) => run(await setup(t), t));

  caseTest('the owner reads the validated case settings, labels included, without any write', async (c) => {
    const before = await c.store.read((session) => session.cases.list(ids.workspace));
    const result = await c.request('owner', 'GET', settingsPath);
    assertApiSchema('CaseSettings', result);
    assert.deepEqual(result, JSON.parse(JSON.stringify(settings)));
    // The same shape is a valid settings file: nothing is renamed, dropped or added.
    assert.deepEqual(parseCaseSettingsJson(JSON.stringify(result)), settings);
    assert.deepEqual(result.statuses.values.toSorted(), [...result.statuses.open, ...result.statuses.terminal].sort());
    for (const status of result.statuses.values) assert.ok(['us', 'them', 'none'].includes(result.statuses.waiting[status]));
    assert.ok(Object.keys(result.labels).length > 0, 'the example settings carry display labels');
    assert.deepEqual(await c.request('owner', 'GET', settingsPath), result, 'every call returns the same settings');
    assert.deepEqual(await c.store.read((session) => session.cases.list(ids.workspace)), before);
    // A caller that changes its copy cannot change what the next caller reads.
    const direct = await c.service.cases.settingsView(principalFixtures.owner, ids.workspace);
    direct.labels.synthetic = { [direct.kinds.values[0]]: '合成の書き換え' };
    direct.statuses.values.pop();
    assert.deepEqual(await c.request('owner', 'GET', settingsPath), result);
    assert.ok(Object.isFrozen(settings.statuses.values), 'the startup settings stay frozen');
  });

  caseTest('apps, non-owners, other workspaces, anonymous callers and queries never read the settings', async (c) => {
    // Even an operator app (["*"] sources and tenants) is not given the settings.
    for (const app of ['app_one', 'app_two', 'operator']) errorOnly(await send(c, app, 'GET', settingsPath, undefined, 403), 'forbidden');
    errorOnly(await send(c, 'foreign', 'GET', settingsPath, undefined, 404), 'not_found');
    for (const actor of ['editor', 'viewer', 'outsider']) errorOnly(await c.request(actor, 'GET', settingsPath, undefined, 403), 'forbidden');
    errorOnly(await c.request('other_owner', 'GET', settingsPath, undefined, 404), 'not_found');
    errorOnly(await c.request(null, 'GET', settingsPath, undefined, 401), 'unauthorized');
    errorOnly(await c.request('owner', 'GET', `${settingsPath}?language=ja`, undefined, 400), 'invalid_query');
    errorOnly(await c.request('owner', 'GET', `/api/v1/workspaces/${ids.otherWorkspace}/cases/settings`, undefined, 404), 'not_found');
    await rejects(() => c.service.cases.settingsView({ ...principalFixtures.owner, active: false }, ids.workspace), 403, 'member_inactive');
    await rejects(() => c.service.cases.settingsView(c.apps.operator, ids.workspace), 403, 'forbidden');
  });

  caseTest('without settings or a CasePort the settings read fails closed', async (c) => {
    const withoutSettings = new WorkspaceService({ ...c.dependencies, caseSettings: undefined });
    const withoutPort = new WorkspaceService({ ...c.dependencies, store: withoutCasePort(c.store) });
    for (const service of [withoutSettings, withoutPort]) {
      await rejects(() => service.cases.settingsView(principalFixtures.owner, ids.workspace), 404, 'cases_not_enabled');
    }
    assertApiSchema('CaseSettings', await c.service.cases.settingsView(principalFixtures.owner, ids.workspace));
  });
}
