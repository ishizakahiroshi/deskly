import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createHttpHandler } from '../../.build/http.js';
import { createAppAuthenticator, headerClientAddress, MIN_TOKEN_LENGTH } from '../../.build/app-auth.js';
import { AppConfigError, ipInRange, parseAppConfigJson, parseAppConfigText, parseAppConfigToml, parseIpAddress,
  parseIpRange } from '../../.build/app-config.js';
import { caseSettings as settings } from './case-api.mjs';
import { assertApiSchema, assertHttpContract, spec } from './schema-validation.mjs';
import { ids } from './fixtures.mjs';

// Every token, name and address below is synthetic; addresses are TEST-NET / documentation ranges only.
const tokens = Object.freeze({
  one: 'synthetic-app-one-token-0123456789abcdef',
  staging: 'synthetic-staging-only-token-0123456789ab',
  old: 'synthetic-rotating-old-token-0123456789ab',
  fresh: 'synthetic-rotating-new-token-0123456789ab',
  operator: 'synthetic-operator-token-0123456789abcdef',
  short: 'synthetic-short-token',
  wrong: 'synthetic-unknown-token-0123456789abcdef',
});
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const exampleUrl = new URL('../../config/apps.example.toml', import.meta.url);
const exampleText = await readFile(exampleUrl, 'utf8');
const ADDRESS_HEADER = 'x-synthetic-client-ip';
const origin = 'https://deskly.example';
const workspace = `/api/v1/workspaces/${ids.workspace}`;
const cases = `${workspace}/cases`;
const panelsPath = `${cases}/panels`;

/** A complete synthetic app settings document. Only hashes are ever written into it. */
function appDocument({ rotating = [tokens.old, tokens.fresh] } = {}) {
  return {
    apps: [
      { name: 'app_one', keys_sha256: [sha256(tokens.one)], envs: ['production', 'staging'], allow_ips: ['192.0.2.0/24'] },
      { name: 'app_staging_only', keys_sha256: [sha256(tokens.staging)], envs: ['staging'], allow_ips: ['192.0.2.0/24'] },
      { name: 'app_rotating', keys_sha256: rotating.map(sha256), envs: ['production'], allow_ips: ['198.51.100.7'] },
      { name: 'app_short', keys_sha256: [sha256(tokens.short)], envs: ['production'], allow_ips: ['0.0.0.0/0', '::/0'] },
      { name: 'operator_console', keys_sha256: [sha256(tokens.operator)], envs: ['production'], allow_ips: ['203.0.113.0/24', '2001:db8::/32'] },
    ],
    scopes: [
      { app: 'app_one', workspace_id: ids.workspace, source: ['app_one'], tenant: ['tenant_a'] },
      { app: 'app_staging_only', workspace_id: ids.workspace, source: ['app_one'], tenant: ['tenant_a'] },
      { app: 'app_rotating', workspace_id: ids.workspace, source: ['app_two'], tenant: ['*'] },
      { app: 'app_short', workspace_id: ids.workspace, source: ['app_two'], tenant: ['*'] },
      { app: 'operator_console', workspace_id: ids.workspace, source: ['*'], tenant: ['*'] },
    ],
  };
}
const toml = (document) => [
  ...document.apps.flatMap((app) => ['[[apps]]', `name = ${JSON.stringify(app.name)}`,
    `keys_sha256 = ${JSON.stringify(app.keys_sha256)}`, `envs = ${JSON.stringify(app.envs)}`,
    `allow_ips = ${JSON.stringify(app.allow_ips)}`, '']),
  ...document.scopes.flatMap((scope) => ['[[scopes]]', `app = ${JSON.stringify(scope.app)}`,
    `workspace_id = ${JSON.stringify(scope.workspace_id)}`, `source = ${JSON.stringify(scope.source)}`,
    `tenant = ${JSON.stringify(scope.tenant)}`, '']),
].join('\n');
const authenticatorFor = (environment = 'production', document = appDocument()) => createAppAuthenticator({
  config: parseAppConfigJson(JSON.stringify(document)), environment, clientAddress: headerClientAddress(ADDRESS_HEADER) });
const handlerFor = (c, appAuthenticator) => createHttpHandler({ service: c.service, authenticator: c.authenticator, appAuthenticator, origin });
const newCase = (overrides = {}) => ({ origin: 'human', kind: settings.kinds.values[0], title: '合成の受付', body: '合成の本文',
  reporter_ref: 'u-synthetic-1', place: { screen_id: 'synthetic-screen' }, ...overrides });

/** A server-to-server call: Host only, no Origin or Sec-Fetch-Site, plus optional Bearer and client address. */
async function call(handler, method, path, { token, address, body, headers = {} } = {}) {
  const sent = { host: 'deskly.example', ...headers };
  if (token !== undefined) sent.authorization = `Bearer ${token}`;
  if (address !== undefined) sent[ADDRESS_HEADER] = address;
  if (body !== undefined) sent['content-type'] = 'application/json';
  const response = await handler(new Request(`${origin}${path}`, { method, headers: sent,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const text = await response.text();
  const json = JSON.parse(text);
  assertHttpContract(method, path, response.status, json);
  return { status: response.status, text, json };
}
const send = (c, app, method, path, body, status = 200) => c.request(null, method, path, body, status, { 'x-contract-app': app });
const tally = (rows) => {
  const counts = { us: 0, them: 0, none: 0 };
  for (const status of rows) counts[settings.statuses.waiting[status]] += 1;
  return counts;
};
const kindTally = (kinds) => settings.kinds.values.map((kind) => ({ kind, count: kinds.filter((value) => value === kind).length }));

/** Added to runContractSuite; every adapter (memory, SQLite, D1) runs every test here. */
export function registerCaseAppTests(setup) {
  const caseTest = (name, run) => test(name, async (t) => run(await setup(t), t));

  test('app settings load from TOML or the same JSON shape and stop loading on any mismatch', () => {
    const example = parseAppConfigToml(exampleText);
    assert.deepEqual(example.apps.map(({ name }) => name), example.scopes.map(({ app }) => app));
    assert.ok(Object.isFrozen(example) && Object.isFrozen(example.apps[0].keys_sha256));
    assert.ok(example.apps.some(({ keys_sha256 }) => keys_sha256.length === 2), 'the example shows two keys during rotation');
    assert.deepEqual(parseAppConfigText(JSON.stringify(example)), example);
    const document = appDocument();
    assert.deepEqual(parseAppConfigToml(toml(document)), parseAppConfigJson(JSON.stringify(document)));
    assert.deepEqual(parseAppConfigText(`\r\n${toml(document).replaceAll('\n', '\r\n')}`), parseAppConfigJson(JSON.stringify(document)));
    const broken = (mutate) => { const copy = structuredClone(document); mutate(copy); return JSON.stringify(copy); };
    for (const [text, pattern] of [
      [broken((d) => { d.scopes.pop(); }), /operator_console has no matching \[\[scopes\]\]/],
      [broken((d) => { d.apps.pop(); }), /scopes\[4\]\.app has no matching \[\[apps\]\]/],
      [broken((d) => { d.scopes.push({ ...d.scopes[0] }); }), /more than one \[\[scopes\]\]/],
      [broken((d) => { d.scopes[0].source = 'app_one'; }), /scopes\[0\]\.source must be an array/],
      [broken((d) => { d.scopes[0].tenant = 'tenant_a'; }), /scopes\[0\]\.tenant must be an array/],
      [broken((d) => { d.scopes[0].source = ['*', 'app_one']; }), /exactly \["\*"\]/],
      [broken((d) => { d.scopes[0].tenant = []; }), /must not be empty/],
      [broken((d) => { d.scopes[0].source = ['Bad Prefix']; }), /scopes\[0\]\.source\[0\]/],
      [broken((d) => { delete d.scopes[0].workspace_id; }), /missing key scopes\[0\]\.workspace_id/],
      [broken((d) => { d.apps[2].keys_sha256.push(sha256('synthetic-third-token-0123456789abcdef')); }), /at most 2 keys/],
      [broken((d) => { d.apps[0].keys_sha256 = []; }), /must not be empty/],
      [broken((d) => { d.apps[1].keys_sha256 = d.apps[0].keys_sha256; }), /repeats a key of another app/],
      [broken((d) => { d.apps[0].keys_sha256 = [sha256(tokens.one).toUpperCase()]; }), /lowercase hex SHA-256/],
      [broken((d) => { d.apps[0].allow_ips = ['192.0.2.0/33']; }), /allow_ips\[0\]/],
      [broken((d) => { d.apps[0].allow_ips = ['192.0.2.1/24']; }), /allow_ips\[0\]/],
      [broken((d) => { d.apps[0].allow_ips = ['192.0.2.256']; }), /allow_ips\[0\]/],
      [broken((d) => { d.apps[0].allow_ips = ['2001:db8::1::/64']; }), /allow_ips\[0\]/],
      [broken((d) => { d.apps[0].allow_ips = ['*']; }), /allow_ips\[0\]/],
      [broken((d) => { d.apps[0].allow_ips = []; }), /allow_ips must not be empty/],
      [broken((d) => { d.apps[0].envs = ['Production']; }), /envs\[0\]/],
      [broken((d) => { d.apps[0].keys = d.apps[0].keys_sha256; }), /unknown key apps\[0\]\.keys/],
      [broken((d) => { d.scopes[0].extra = true; }), /unknown key scopes\[0\]\.extra/],
      [broken((d) => { d.tokens = []; }), /unknown key tokens/],
      [broken((d) => { d.apps[1].name = d.apps[0].name; }), /repeat a name|more than one/],
      [broken((d) => { d.apps = []; }), /apps must not be empty/],
      [broken((d) => { d.scopes = {}; }), /scopes must be an array of tables/],
    ]) assert.throws(() => parseAppConfigJson(text), (error) => error instanceof AppConfigError && pattern.test(error.message), String(pattern));
    for (const [text, pattern] of [
      [`${toml(document)}\n[[tokens]]\nname = "x"\n`, /line \d+: unknown table \[\[tokens\]\]/],
      [`name = "x"\n${toml(document)}`, /unknown key name/],
      [`${toml(document)}\n[[apps.extra]]\n`, /arrays of tables/],
      [toml(document).replace('[[scopes]]\napp = "app_one"', '[scopes]\napp = "app_one"'), /scopes|already defined/],
      [toml(document).replace(/allow_ips = \["192\.0\.2\.0\/24"\]/, 'allow_ips = 1.5'), /^Invalid app settings: TOML line 5: unsupported value$/],
      [toml(document).replace('envs = ["production","staging"]', 'envs = ["production"'), /TOML line 5: expected , or \] in array/],
    ]) assert.throws(() => parseAppConfigToml(text), (error) => error instanceof AppConfigError && pattern.test(error.message), String(pattern));
  });

  test('a list row is every Case field unchanged plus evidence_missing', async () => {
    const caseSchema = JSON.parse(await readFile(new URL('../../../schema/case.schema.json', import.meta.url), 'utf8'));
    const row = spec.components.schemas.CaseListItem;
    const fields = Object.keys(caseSchema.properties);
    assert.deepEqual(Object.keys(row.properties), [...fields, 'evidence_missing']);
    assert.deepEqual(row.required, [...fields, 'evidence_missing']);
    for (const field of fields) assert.deepEqual(row.properties[field], { $ref: `./case.schema.json#/properties/${field}` });
    assert.equal(spec.components.schemas.CaseCollection.properties.items.items.$ref, '#/components/schemas/CaseListItem');
  });

  test('client addresses: IPv4, IPv6, mapped IPv4 and CIDR ranges are parsed strictly', () => {
    const inRange = (address, range) => ipInRange(parseIpAddress(address), parseIpRange(range));
    assert.ok(inRange('192.0.2.200', '192.0.2.0/24'));
    assert.ok(!inRange('192.0.3.1', '192.0.2.0/24'));
    assert.ok(inRange('::ffff:192.0.2.9', '192.0.2.0/24'), 'an IPv4-mapped peer address matches IPv4 ranges');
    assert.ok(inRange('2001:db8:0:0:0:0:0:1', '2001:db8::/32'));
    assert.ok(inRange('2001:DB8::abcd', '2001:db8::/32'));
    assert.ok(!inRange('2001:db9::1', '2001:db8::/32'));
    assert.ok(!inRange('192.0.2.1', '::/0'), 'IPv4 and IPv6 ranges never mix');
    assert.ok(inRange('198.51.100.7', '198.51.100.7'));
    assert.ok(inRange('203.0.113.1', '0.0.0.0/0'));
    for (const text of ['', '192.0.2', '192.0.2.01', '192.0.2.1:80', '[2001:db8::1]', '2001:db8::1%eth0', '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9', 'example.com', '192.0.2.1, 192.0.2.2']) assert.equal(parseIpAddress(text), null, text);
  });

  caseTest('apps create cases with a Bearer key from an allowed address in an allowed environment; every failure is the same 401', async (c) => {
    const production = handlerFor(c, authenticatorFor('production'));
    const created = await call(production, 'POST', cases, { token: tokens.one, address: '192.0.2.10', body: newCase() });
    assert.equal(created.status, 200, created.text);
    assertApiSchema('CaseCreated', created.json);
    assert.equal(created.json.number, 'app_one-1');
    const detail = await call(production, 'GET', `${cases}/app_one-1`, { token: tokens.one, address: '192.0.2.10' });
    assert.equal(detail.json.case.tenant_ref, 'tenant_a');
    assert.deepEqual(detail.json.events[0].actor, { kind: 'app', app: 'app_one' });
    // IPv4-mapped peers are the same IPv4 address.
    assert.equal((await call(production, 'GET', cases, { token: tokens.one, address: '::ffff:192.0.2.10' })).status, 200);
    const unauthorized = { error: 'unauthorized' };
    for (const [label, options] of [
      ['unknown token', { token: tokens.wrong, address: '192.0.2.10' }],
      ['no token', { address: '192.0.2.10' }],
      ['wrong scheme', { address: '192.0.2.10', headers: { authorization: `Basic ${tokens.one}` } }],
      ['token with trailing data', { token: `${tokens.one} extra`, address: '192.0.2.10' }],
      ['environment not listed', { token: tokens.staging, address: '192.0.2.10' }],
      ['address outside the ranges', { token: tokens.one, address: '198.51.100.10' }],
      ['address unknown', { token: tokens.one }],
      ['address list', { token: tokens.one, address: '192.0.2.10, 192.0.2.11' }],
      ['token shorter than the minimum', { token: tokens.short, address: '192.0.2.10' }],
    ]) {
      const result = await call(production, 'GET', cases, options);
      assert.equal(result.status, 401, label);
      assert.deepEqual(result.json, unauthorized, `${label} reveals no reason`);
    }
    assert.ok(tokens.short.length < MIN_TOKEN_LENGTH);
    // The same key works in another environment only if that environment is listed.
    const staging = handlerFor(c, authenticatorFor('staging'));
    assert.equal((await call(staging, 'GET', cases, { token: tokens.staging, address: '192.0.2.10' })).status, 200);
    assert.equal((await call(staging, 'GET', cases, { token: tokens.one, address: '192.0.2.10' })).status, 200);
    assert.equal((await call(staging, 'GET', cases, { token: tokens.operator, address: '203.0.113.5' })).status, 401);
    // Bearer server-to-server writes need no Origin; without a valid app the browser checks still apply.
    assert.deepEqual((await call(production, 'POST', cases, { token: tokens.wrong, address: '192.0.2.10', body: newCase() })).json, { error: 'forbidden' });
    assert.equal((await call(production, 'POST', cases, { token: tokens.one, address: '192.0.2.10', body: newCase(),
      headers: { origin, 'sec-fetch-site': 'same-origin' } })).status, 200, 'a same-origin Bearer call is accepted too');
    assert.equal((await call(c.handler, 'POST', cases, { address: '192.0.2.10', body: newCase(),
      headers: { 'x-contract-app': 'app_one' } })).status, 403, 'a non-Bearer app identity never skips the browser checks');
    // Apps never authenticate member routes, even with a valid key.
    assert.equal((await call(production, 'GET', `${workspace}/projects`, { token: tokens.operator, address: '203.0.113.5' })).status, 401);
    // A member authenticated first keeps the member path; an app key cannot widen it.
    const member = await c.request('owner', 'GET', cases, undefined, 200, { authorization: `Bearer ${tokens.wrong}` });
    assert.equal(member.items.length, 2);
  });

  caseTest('two keys per app rotate without downtime and a removed key stops working', async (c) => {
    const both = handlerFor(c, authenticatorFor());
    const address = '198.51.100.7';
    assert.equal((await call(both, 'POST', cases, { token: tokens.old, address, body: newCase() })).json.number, 'app_two-1');
    assert.equal((await call(both, 'POST', cases, { token: tokens.fresh, address, body: newCase() })).json.number, 'app_two-2');
    const rotated = handlerFor(c, authenticatorFor('production', appDocument({ rotating: [tokens.fresh] })));
    assert.equal((await call(rotated, 'POST', cases, { token: tokens.old, address, body: newCase(), headers: { origin } })).status, 401);
    assert.equal((await call(rotated, 'POST', cases, { token: tokens.fresh, address, body: newCase() })).json.number, 'app_two-3');
    const list = await call(rotated, 'GET', cases, { token: tokens.fresh, address });
    assert.deepEqual(list.json.items.map(({ number }) => number), ['app_two-1', 'app_two-2', 'app_two-3']);
    assert.ok(list.json.items.every((row) => row.tenant_ref === null));
  });

  caseTest('authenticated scopes cut reads: outside cases are 404 and only operators see the per-source panel', async (c) => {
    const handler = handlerFor(c, authenticatorFor());
    const one = (await call(handler, 'POST', cases, { token: tokens.one, address: '192.0.2.10', body: newCase() })).json.number;
    const two = (await call(handler, 'POST', cases, { token: tokens.fresh, address: '198.51.100.7', body: newCase() })).json.number;
    const hidden = await call(handler, 'GET', `${cases}/${two}`, { token: tokens.one, address: '192.0.2.10' });
    const absent = await call(handler, 'GET', `${cases}/app_two-999`, { token: tokens.one, address: '192.0.2.10' });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.json, absent.json, 'hidden equals absent');
    assert.equal((await call(handler, 'PATCH', `${cases}/${two}`, { token: tokens.one, address: '192.0.2.10',
      body: { expected_revision: 1, status: settings.statuses.terminal[0] } })).status, 404);
    assert.deepEqual((await call(handler, 'GET', cases, { token: tokens.one, address: '192.0.2.10' })).json.items.map(({ number }) => number), [one]);
    const operator = await call(handler, 'GET', cases, { token: tokens.operator, address: '2001:db8::5' });
    assert.deepEqual(operator.json.items.map(({ number }) => number), [one, two]);
    const scoped = (await call(handler, 'GET', panelsPath, { token: tokens.one, address: '192.0.2.10' })).json;
    assert.equal(scoped.open, 1);
    assert.ok(!Object.hasOwn(scoped, 'by_source'));
    const all = (await call(handler, 'GET', panelsPath, { token: tokens.operator, address: '203.0.113.9' })).json;
    assert.equal(all.open, 2);
    assert.deepEqual(all.by_source.map(({ source, open }) => [source, open]), [['app_one', 1], ['app_two', 1]]);
    assert.equal((await call(handler, 'POST', cases, { token: tokens.operator, address: '203.0.113.9', body: newCase() })).json.error, 'source_not_fixed');
  });

  caseTest('tokens never appear in settings, responses, errors or logs', async (c) => {
    const logged = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
    const original = Object.fromEntries(methods.map((name) => [name, console[name]]));
    for (const name of methods) console[name] = (...args) => { logged.push(args.map(String).join(' ')); };
    const seen = [];
    try {
      const document = appDocument();
      const texts = [JSON.stringify(document), toml(document), exampleText];
      const handler = handlerFor(c, authenticatorFor());
      for (const [method, path, options] of [
        ['POST', cases, { token: tokens.one, address: '192.0.2.10', body: newCase() }],
        ['GET', cases, { token: tokens.one, address: '192.0.2.10' }],
        ['GET', panelsPath, { token: tokens.operator, address: '203.0.113.9' }],
        ['GET', cases, { token: tokens.wrong, address: '192.0.2.10' }],
        ['GET', cases, { token: tokens.one, address: '198.51.100.10' }],
        ['GET', cases, { token: tokens.staging, address: '192.0.2.10' }],
        ['POST', cases, { token: tokens.wrong, body: newCase() }],
        ['POST', cases, { token: tokens.one, address: '192.0.2.10', body: { ...newCase(), extra: tokens.wrong } }],
      ]) {
        const result = await call(handler, method, path, options);
        seen.push(result.text);
      }
      // A token pasted where a hash belongs, or into broken syntax, is never echoed back.
      const misplaced = structuredClone(document);
      misplaced.apps[0].keys_sha256 = [tokens.one];
      for (const [parse, text] of [
        [parseAppConfigJson, JSON.stringify(misplaced)],
        [parseAppConfigToml, toml(misplaced)],
        [parseAppConfigJson, `{"apps": [${tokens.one}]}`],
        [parseAppConfigToml, `[[apps]]\nname = "app_one"\nkeys_sha256 = [${tokens.one}]\n`],
        [parseAppConfigToml, `[[apps]]\nname = "app_one"\nkeys_sha256 = ["${tokens.one}`],
      ]) {
        assert.throws(() => parse(text), (error) => { seen.push(error.message, String(error.stack)); return error instanceof AppConfigError; });
      }
      for (const text of [...texts, ...seen, ...logged]) {
        for (const token of Object.values(tokens)) assert.ok(!text.includes(token), 'a token was written out');
      }
    } finally {
      for (const name of methods) console[name] = original[name];
    }
    assert.deepEqual(logged, [], 'authentication writes nothing to the console');
  });

  caseTest('panels count only open cases in scope, without a period cut, with the per-source panel for operators only', async (c) => {
    const [first, second] = settings.kinds.values;
    const needsApproval = settings.kinds.requires_approval[0];
    const them = settings.statuses.open.find((status) => settings.statuses.waiting[status] === 'them');
    const initial = settings.statuses.initial;
    const create = async (app, overrides) => (await send(c, app, 'POST', cases, newCase(overrides))).number;
    await create('app_one', { kind: first, place: { screen_id: 'screen-a' }, promised_due: '2025-12-31' });
    const a2 = await create('app_one', { kind: second, place: { screen_id: 'screen-a' }, promised_due: '2026-01-02' });
    await create('app_one', { kind: first, place: {}, promised_due: '2020-01-01' });
    await create('app_one_b', { kind: first, place: { screen_id: 'screen-b' }, promised_due: '2025-12-01' });
    await create('app_two', { kind: needsApproval, place: { screen_id: 'screen-c' } });
    const closed = await create('app_two', { kind: first, place: { screen_id: 'screen-c' }, promised_due: '2025-01-01' });
    await send(c, 'app_one', 'PATCH', `${cases}/${a2}`, { expected_revision: 1, status: them });
    await send(c, 'app_two', 'PATCH', `${cases}/${closed}`, { expected_revision: 1, status: settings.statuses.terminal[0] });
    const panels = async (app) => {
      const result = app === 'owner' ? await c.request('owner', 'GET', panelsPath) : await send(c, app, 'GET', panelsPath);
      assertApiSchema('CasePanels', result);
      return result;
    };
    const one = await panels('app_one');
    assert.deepEqual(one, { today: '2026-01-01', open: 3, overdue: 2, waiting: tally([initial, them, initial]),
      screens: [{ screen_id: 'screen-a', count: 2 }, { screen_id: null, count: 1 }], kinds: kindTally([first, second, first]) });
    const b = await panels('app_one_b');
    assert.deepEqual([b.open, b.overdue, b.screens], [1, 1, [{ screen_id: 'screen-b', count: 1 }]]);
    const multi = await panels('app_one_multi');
    assert.deepEqual([multi.open, multi.overdue], [4, 3]);
    assert.ok(!Object.hasOwn(multi, 'by_source'), 'several tenants is still not an operator');
    const two = await panels('app_two');
    assert.deepEqual([two.open, two.overdue, two.screens], [1, 0, [{ screen_id: 'screen-c', count: 1 }]],
      'a terminal case is not counted, even when its promised_due has passed');
    for (const scoped of [one, b, multi, two]) assert.ok(!Object.hasOwn(scoped, 'by_source'));
    for (const viewer of ['operator', 'owner']) {
      const all = await panels(viewer);
      assert.equal(all.open, 5);
      assert.equal(all.overdue, 3);
      assert.deepEqual(all.waiting, tally([initial, them, initial, initial, initial]));
      assert.deepEqual(all.screens, [{ screen_id: 'screen-a', count: 2 }, { screen_id: 'screen-b', count: 1 },
        { screen_id: 'screen-c', count: 1 }, { screen_id: null, count: 1 }]);
      assert.deepEqual(all.by_source, [
        { source: 'app_one', open: 4, overdue: 3, waiting: tally([initial, them, initial, initial]), kinds: kindTally([first, second, first, first]) },
        { source: 'app_two', open: 1, overdue: 0, waiting: tally([initial]), kinds: kindTally([needsApproval]) },
      ]);
      // Scoped numbers never exceed the operator's, and the breakdown adds up.
      for (const scoped of [one, b, multi, two]) assert.ok(scoped.open <= all.open && scoped.overdue <= all.overdue);
      assert.equal(all.by_source.reduce((sum, row) => sum + row.open, 0), all.open);
    }
    // Every open case counts regardless of age: moving the clock years ahead changes only overdue.
    c.clock.time = '2030-06-01T00:00:00Z';
    const later = await panels('app_one');
    assert.deepEqual([later.today, later.open, later.overdue], ['2030-06-01', 3, 3]);
    assert.equal((await send(c, 'app_one', 'GET', `${panelsPath}?period=30`, undefined, 400)).error, 'invalid_query');
    assert.equal((await send(c, 'foreign', 'GET', panelsPath, undefined, 404)).error, 'not_found');
    assert.equal((await c.request('editor', 'GET', panelsPath, undefined, 403)).error, 'forbidden');
    assert.equal((await c.request(null, 'GET', panelsPath, undefined, 401)).error, 'unauthorized');
  });

  caseTest('lists float due holds and overdue open cases first and mark terminal cases without evidence', async (c) => {
    const needsApproval = settings.kinds.requires_approval[0];
    const { hold } = settings.approval_states;
    const [firstTerminal, secondTerminal] = settings.statuses.terminal;
    const reopened = settings.statuses.open.find((status) => status !== settings.statuses.initial);
    const create = async (overrides = {}) => (await send(c, 'app_one', 'POST', cases, newCase(overrides))).number;
    const patch = (number, body) => send(c, 'app_one', 'PATCH', `${cases}/${number}`, body);
    const plain = await create();
    const future = await create({ promised_due: '2026-01-05' });
    const heldToday = await create({ kind: needsApproval });
    await patch(heldToday, { expected_revision: 1, approval_state: hold, hold_until: '2026-01-01' });
    const overdue = await create({ promised_due: '2025-12-31' });
    const closedBare = await create({ promised_due: '2025-12-30' });
    await patch(closedBare, { expected_revision: 1, status: firstTerminal });
    const closedLinked = await create();
    await patch(closedLinked, { expected_revision: 1, status: secondTerminal });
    await send(c, 'app_one', 'POST', `${cases}/${closedLinked}/links`, { link_type: 'commit', ref: 'a'.repeat(40) });
    const heldLater = await create({ kind: needsApproval });
    await patch(heldLater, { expected_revision: 1, approval_state: hold, hold_until: '2026-01-02' });
    const list = async () => (await send(c, 'app_one', 'GET', cases)).items;
    let items = await list();
    assert.deepEqual(items.map(({ number }) => number), [heldToday, overdue, plain, future, closedBare, closedLinked, heldLater]);
    assert.deepEqual(Object.fromEntries(items.map(({ number, evidence_missing }) => [number, evidence_missing])),
      { [plain]: false, [future]: false, [heldToday]: false, [overdue]: false, [closedBare]: true, [closedLinked]: false, [heldLater]: false });
    // The operator and the owner see the same marks and order.
    assert.deepEqual((await send(c, 'operator', 'GET', cases)).items, items);
    assert.deepEqual((await c.request('owner', 'GET', cases)).items, items);
    // Derived on read: nothing is stored, and the order follows the clock.
    const stored = await c.store.read((session) => session.cases.list(ids.workspace));
    assert.ok(stored.every((row) => !Object.hasOwn(row, 'evidence_missing')));
    c.clock.time = '2026-01-03T00:00:00Z';
    await patch(closedBare, { expected_revision: 2, status: reopened });
    items = await list();
    assert.deepEqual(items.map(({ number }) => number), [heldToday, overdue, closedBare, heldLater, plain, future, closedLinked]);
    assert.equal(items.find(({ number }) => number === closedBare).evidence_missing, false, 'a reopened case is not terminal');
  });
}
