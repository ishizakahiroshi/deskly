import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

// Native HTTP models a proxy preserving Host; fetch may discard a supplied Host.
function proxyRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { parseCaseSettingsToml } from '../../.build/case-settings.js';
import { startServer, startFromEnvironment, createDevelopmentAuthenticator, configFromEnvironment, version } from '../../.build/adapters/vps/server.js';
import { ids, principalFixtures, seed } from '../contract/fixtures.mjs';

// Explicitly synthetic and local to this test, never a built-in production token.
const token = 'synthetic-development-test-token';
test('VPS: starts on loopback, reports version, and serves the shared authenticated handler behind configured HTTPS origin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-vps-test-'));
  const authenticator = createDevelopmentAuthenticator(token, principalFixtures.owner, 'development');
  const running = await startServer({ databasePath: join(directory, 'synthetic.sqlite'), origin: 'https://deskly.example', port: 0 },
    { authenticator, signer: await createConfirmationSigner(new Uint8Array(32).fill(7)) });
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  await seed(running.store);
  const address = running.server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { version });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
  const path = `${base}/api/v1/workspaces/${ids.workspace}`;
  const response = await proxyRequest(path, { host: 'deskly.example', authorization: `Bearer ${token}` });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).workspace_id, ids.workspace);
  assert.equal((await proxyRequest(path, { host: 'deskly.example' })).status, 401);
  assert.equal((await proxyRequest(path, { host: 'untrusted.example', authorization: `Bearer ${token}`,
    'x-forwarded-host': 'deskly.example', 'x-forwarded-proto': 'https' })).status, 403);
  assert.equal((await proxyRequest(path, { host: 'deskly.example', authorization: `Bearer ${token}`, origin: 'https://untrusted.example' })).status, 403);
});

// Synthetic app tokens for this test only; the settings file holds just their SHA-256.
const appToken = 'synthetic-vps-app-token-0123456789abcdef';
const fencedToken = 'synthetic-vps-fenced-token-0123456789abcd';
const sha256 = text => createHash('sha256').update(text).digest('hex');
function appSettings() {
  return [
    '[[apps]]', 'name = "app_one"', `keys_sha256 = ["${sha256(appToken)}"]`, 'envs = ["production"]', 'allow_ips = ["127.0.0.1", "::1"]', '',
    '[[apps]]', 'name = "app_two"', `keys_sha256 = ["${sha256(fencedToken)}"]`, 'envs = ["production"]', 'allow_ips = ["192.0.2.0/24"]', '',
    '[[scopes]]', 'app = "app_one"', `workspace_id = "${ids.workspace}"`, 'source = ["app_one"]', 'tenant = ["tenant_a"]', '',
    '[[scopes]]', 'app = "app_two"', `workspace_id = "${ids.workspace}"`, 'source = ["app_two"]', 'tenant = ["*"]', '',
  ].join('\n');
}
function call(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
test('VPS: a sending app creates a case with its Bearer key from the TCP peer address, without Origin', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-vps-app-test-'));
  let running;
  // One hook: close the database before removing its folder (Windows keeps open files locked).
  t.after(async () => { if (running) await running.close(); await rm(directory, { recursive: true, force: true }); });
  const caseSettingsPath = join(directory, 'case-settings.toml');
  const appsConfigPath = join(directory, 'apps.toml');
  await writeFile(caseSettingsPath, await readFile(new URL('../../config/case-settings.example.toml', import.meta.url)));
  await writeFile(appsConfigPath, appSettings());
  assert.ok(!(await readFile(appsConfigPath, 'utf8')).includes(appToken), 'the settings file holds only the hash');
  const config = configFromEnvironment({ DESKLY_SQLITE_PATH: join(directory, 'synthetic.sqlite'), DESKLY_PUBLIC_ORIGIN: 'https://deskly.example',
    DESKLY_PORT: '3000', DESKLY_CASE_SETTINGS_PATH: caseSettingsPath, DESKLY_APPS_CONFIG_PATH: appsConfigPath, DESKLY_APP_ENVIRONMENT: 'production' });
  running = await startServer({ ...config, port: 0 }, {
    authenticator: createDevelopmentAuthenticator(token, principalFixtures.owner, 'development'),
    signer: await createConfirmationSigner(new Uint8Array(32).fill(7)) });
  await seed(running.store);
  const cases = `http://127.0.0.1:${running.server.address().port}/api/v1/workspaces/${ids.workspace}/cases`;
  const [kind] = parseCaseSettingsToml(await readFile(caseSettingsPath, 'utf8')).kinds.values;
  const body = JSON.stringify({ origin: 'human', kind, title: '合成の受付', body: '合成の本文' });
  const headers = (key, extra = {}) => ({ host: 'deskly.example', 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra });
  const created = await call(cases, 'POST', headers(appToken), body);
  assert.equal(created.status, 200, created.text);
  assert.equal(JSON.parse(created.text).number, 'app_one-1');
  const list = await call(cases, 'GET', headers(appToken));
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(JSON.parse(list.text).items.map(({ number, tenant_ref, evidence_missing }) => [number, tenant_ref, evidence_missing]),
    [['app_one-1', 'tenant_a', false]]);
  // The member path is unchanged: the development token still authenticates the owner.
  assert.equal((await call(cases, 'GET', headers(token))).status, 200);
  // Allowed only from 192.0.2.0/24: the loopback peer is refused, and a client-sent header is not trusted.
  for (const extra of [{}, { 'x-forwarded-for': '192.0.2.10', 'x-real-ip': '192.0.2.10' }]) {
    assert.equal((await call(cases, 'GET', headers(fencedToken, extra))).status, 401);
  }
  for (const response of [await call(cases, 'GET', headers('synthetic-unknown-token-0123456789abcdef')),
    await call(cases, 'POST', headers('synthetic-unknown-token-0123456789abcdef'), body)]) {
    assert.ok([401, 403].includes(response.status));
    assert.ok(!response.text.includes(appToken));
  }
});

test('VPS: behind a trusted proxy the configured header carries the client address', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-vps-proxy-test-'));
  let running;
  t.after(async () => { if (running) await running.close(); await rm(directory, { recursive: true, force: true }); });
  const caseSettingsPath = join(directory, 'case-settings.toml');
  const appsConfigPath = join(directory, 'apps.toml');
  await writeFile(caseSettingsPath, await readFile(new URL('../../config/case-settings.example.toml', import.meta.url)));
  await writeFile(appsConfigPath, appSettings());
  running = await startServer({ databasePath: join(directory, 'synthetic.sqlite'), origin: 'https://deskly.example', port: 0,
    caseSettingsPath, appsConfigPath, appEnvironment: 'production', clientIpHeader: 'X-Real-IP' }, {
    authenticator: createDevelopmentAuthenticator(token, principalFixtures.owner, 'development'),
    signer: await createConfirmationSigner(new Uint8Array(32).fill(7)) });
  await seed(running.store);
  const cases = `http://127.0.0.1:${running.server.address().port}/api/v1/workspaces/${ids.workspace}/cases`;
  const headers = extra => ({ host: 'deskly.example', authorization: `Bearer ${fencedToken}`, ...extra });
  assert.equal((await call(cases, 'GET', headers({ 'x-real-ip': '192.0.2.10' }))).status, 200);
  for (const extra of [{}, { 'x-real-ip': '198.51.100.10' }, { 'x-real-ip': '192.0.2.10, 192.0.2.11' }, { 'x-forwarded-for': '192.0.2.10' }]) {
    assert.equal((await call(cases, 'GET', headers(extra))).status, 401);
  }
});

test('VPS: case and app settings are read and checked before the database opens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-vps-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'synthetic.sqlite');
  const caseSettingsPath = join(directory, 'case-settings.toml');
  const appsConfigPath = join(directory, 'apps.toml');
  await writeFile(caseSettingsPath, await readFile(new URL('../../config/case-settings.example.toml', import.meta.url)));
  // An [[apps]] entry without its [[scopes]] entry stops startup.
  await writeFile(appsConfigPath, appSettings().split('[[scopes]]').slice(0, 2).join('[[scopes]]'));
  const dependencies = { authenticator: createDevelopmentAuthenticator(token, principalFixtures.owner, 'development'),
    signer: await createConfirmationSigner(new Uint8Array(32).fill(7)) };
  const base = { databasePath, origin: 'https://deskly.example', port: 0 };
  await assert.rejects(startServer({ ...base, caseSettingsPath, appsConfigPath, appEnvironment: 'production' }, dependencies),
    /app_two has no matching \[\[scopes\]\]/);
  await assert.rejects(startServer({ ...base, caseSettingsPath, appsConfigPath }, dependencies), /DESKLY_APP_ENVIRONMENT/);
  await assert.rejects(startServer({ ...base, appsConfigPath, appEnvironment: 'production' }, dependencies), /DESKLY_CASE_SETTINGS_PATH/);
  await assert.rejects(startServer({ ...base, caseSettingsPath: join(directory, 'missing.toml') }, dependencies), /Cannot read the case settings file/);
  await assert.rejects(stat(databasePath), 'no database was created');
  assert.deepEqual(configFromEnvironment({ DESKLY_SQLITE_PATH: '/tmp/synthetic.sqlite', DESKLY_CASE_SETTINGS_PATH: '/tmp/case.toml',
    DESKLY_APPS_CONFIG_PATH: '/tmp/apps.toml', DESKLY_APP_ENVIRONMENT: 'production', DESKLY_CLIENT_IP_HEADER: 'X-Real-IP' }), {
    databasePath: '/tmp/synthetic.sqlite', hostname: '127.0.0.1', port: 3000, origin: 'http://127.0.0.1:3000',
    caseSettingsPath: '/tmp/case.toml', appsConfigPath: '/tmp/apps.toml', appEnvironment: 'production', clientIpHeader: 'X-Real-IP',
  });
  assert.throws(() => configFromEnvironment({ DESKLY_SQLITE_PATH: '/tmp/synthetic.sqlite', DESKLY_APPS_CONFIG_PATH: ' ' }), /DESKLY_APPS_CONFIG_PATH/);
});

test('VPS: environment is explicit and fixed-token CLI is development-only', async () => {
  assert.deepEqual(configFromEnvironment({ DESKLY_SQLITE_PATH: '/tmp/synthetic.sqlite' }), {
    databasePath: '/tmp/synthetic.sqlite', hostname: '127.0.0.1', port: 3000, origin: 'http://127.0.0.1:3000',
  });
  assert.deepEqual(configFromEnvironment({ DESKLY_SQLITE_PATH: '/tmp/synthetic.sqlite', DESKLY_PORT: '4321',
    DESKLY_HOST: '127.0.0.2', DESKLY_PUBLIC_ORIGIN: 'https://deskly.example' }), {
    databasePath: '/tmp/synthetic.sqlite', hostname: '127.0.0.2', port: 4321, origin: 'https://deskly.example',
  });
  assert.throws(() => configFromEnvironment({}), /DESKLY_SQLITE_PATH/);
  for (const value of ['0', '-1', '65536', '1.5', 'abc', '']) assert.throws(() => configFromEnvironment({ DESKLY_SQLITE_PATH: '/tmp/synthetic.sqlite', DESKLY_PORT: value }), /DESKLY_PORT/);
  for (const mode of [undefined, 'test', 'production']) {
    assert.throws(() => createDevelopmentAuthenticator(token, principalFixtures.owner, mode), /development/);
    await assert.rejects(startFromEnvironment({ NODE_ENV: mode }), /production Authenticator/);
  }
  assert.throws(() => createDevelopmentAuthenticator('', principalFixtures.owner, 'development'), /token/);
  await assert.rejects(startFromEnvironment({ NODE_ENV: 'development', DESKLY_DEV_TOKEN: token }), /canonical UUIDs/);
  const principal = structuredClone(principalFixtures.owner);
  const authenticator = createDevelopmentAuthenticator(token, principal, 'development');
  principal.active = false;
  const first = await authenticator.authenticate(new Request('https://deskly.example', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(first.active, true);
  first.active = false;
  assert.equal((await authenticator.authenticate(new Request('https://deskly.example', { headers: { authorization: `Bearer ${token}` } }))).active, true);
  assert.equal(await authenticator.authenticate(new Request('https://deskly.example')), null);
});
