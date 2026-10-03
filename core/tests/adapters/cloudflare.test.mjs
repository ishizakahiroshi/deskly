import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseCaseSettingsToml } from '../../.build/case-settings.js';
import { createAccessAuthenticator, accessKeyLoader } from '../../.build/adapters/cloudflare/access.js';
import { createWorker } from '../../.build/adapters/cloudflare/worker.js';
import { MemoryStore } from '../../.build/memory-store.js';
import { createD1Harness } from './d1-harness.mjs';
import { seed, principalFixtures, ids } from '../contract/fixtures.mjs';
const issuer = 'https://access.example';
const audience = 'synthetic-audience';
const now = 1_800_000_000;
const principal = principalFixtures.owner;
const identities = [{ subject: 'synthetic-access-subject', email: 'owner@example.com', principal }];
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const claims = { iss: issuer, aud: [audience], iat: now - 10, exp: now + 60, sub: identities[0].subject, email: identities[0].email };
const config = { issuer, audience, identities, loadKeys: async () => [jwk], now: () => now };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}, header = {}, privateKey = keys.privateKey) {
  const message = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header })}.${encode({ ...claims, ...changes })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(message));
  return `${message}.${Buffer.from(signature).toString('base64url')}`;
}
const request = raw => new Request('https://deskly.example/', { headers: { 'Cf-Access-Jwt-Assertion': raw } });
test('Access: correctly signed issuer/audience/lifetime/identity resolves the trusted principal', async () => {
  const auth = createAccessAuthenticator(config); const p = await auth.authenticate(request(await token()));
  assert.deepEqual(p, principal); p.role = 'member';
  assert.deepEqual(await auth.authenticate(request(await token())), principal);
});
for (const [label, changes] of [
  ['expired', { exp: now }], ['wrong audience', { aud: ['synthetic-other-audience'] }],
  ['wrong issuer', { iss: 'https://other.example' }], ['wrong person', { sub: 'synthetic-other-subject' }],
]) test(`Access: rejects ${label}`, async () => {
  assert.equal(await createAccessAuthenticator(config).authenticate(request(await token(changes))), null);
});
test('Access: rejects a signature from a different key', async () => {
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  assert.equal(await createAccessAuthenticator(config).authenticate(request(await token({}, {}, other.privateKey))), null);
});
test('Access: malformed tokens, algorithm confusion, future validity, mismatched email and key errors fail closed', async () => {
  const auth = createAccessAuthenticator(config);
  for (const raw of ['bad', 'a.b.c', 'x'.repeat(8200), await token({}, { alg: 'none' }), await token({}, { kid: 'unknown' }),
    await token({}, { crit: ['unhandled'] }), await token({ nbf: now + 1 }), await token({ iat: now + 61 }),
    await token({ exp: null }), await token({ aud: [audience, 1] }), await token({ email: 'other@example.com' })]) {
    assert.equal(await auth.authenticate(request(raw)), null);
  }
  assert.equal(await auth.authenticate(new Request('https://deskly.example/')), null);
  for (const loadKeys of [async () => { throw new Error('synthetic unavailable'); }, async () => [jwk, jwk], async () => [{ ...jwk, use: 'enc' }]]) {
    assert.equal(await createAccessAuthenticator({ ...config, loadKeys }).authenticate(request(await token())), null);
  }
  assert.equal(await createAccessAuthenticator({ ...config, identities: [{ ...identities[0], principal: { ...principal, active: false } }] })
    .authenticate(request(await token())), null);
  assert.throws(() => createAccessAuthenticator({ ...config, identities: [...identities, ...identities] }), /identity mapping/);
});
test('Access: key endpoint comes only from trusted issuer and redirects are disabled', async () => {
  let seen;
  const loader = accessKeyLoader(issuer, async (url, options) => { seen = { url, options }; return Response.json({ keys: [jwk] }); });
  assert.deepEqual(await loader(), [jwk]); assert.equal(seen.url, `${issuer}/cdn-cgi/access/certs`); assert.equal(seen.options.redirect, 'manual');
  assert.throws(() => accessKeyLoader('http://access.example'), /trusted origin/);
  await assert.rejects(accessKeyLoader(issuer, async () => Response.json({}, { status: 503 }))());
});

test('Access: manual redirect mode rejects 301 and 302 key responses without following Location', async () => {
  for (const status of [301, 302]) {
    let calls = 0;
    const loader = accessKeyLoader(issuer, async (url, options) => {
      calls++;
      assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status, headers: { location: 'https://untrusted.example/keys' } });
    });
    await assert.rejects(loader(), /Access keys unavailable/);
    assert.equal(calls, 1);
  }
});
const bindings = database => ({ DB: database, PUBLIC_ORIGIN: 'https://deskly.example', ACCESS_ISSUER: issuer,
  ACCESS_AUD: audience, ACCESS_IDENTITIES: JSON.stringify(identities), CONFIRMATION_SECRET: 'synthetic-test-confirmation-key-only-32-bytes' });
async function api(raw, origin = 'https://deskly.example') {
  return new Request(`${origin}/api/v1/workspaces/${ids.workspace}/projects`, {
    headers: { host: new URL(origin).host, ...(raw ? { 'Cf-Access-Jwt-Assertion': raw } : {}) },
  });
}
test('Worker: fetch serves unchanged HTTP routes against Miniflare D1 and rejects invalid authentication', async t => {
  const h = await createD1Harness(); t.after(() => h.close()); await seed(h.store);
  const worker = createWorker({ loadKeys: async actualIssuer => { assert.equal(actualIssuer, issuer); return [jwk]; }, now: () => now });
  const env = bindings(h.database);
  const valid = await worker.fetch(await api(await token()), env); assert.equal(valid.status, 200);
  const result = await valid.json(); assert.ok(JSON.stringify(result).includes(ids.project));
  assert.equal((await worker.fetch(await api(), env)).status, 401);
  assert.equal((await worker.fetch(await api(await token({ sub: 'synthetic-other-subject' })), env)).status, 401);
  assert.equal((await worker.fetch(await api(await token(), 'https://untrusted.example'), env)).status, 403);
  assert.equal((await worker.fetch(await api(await token()), { ...env, ACCESS_AUD: '' })).status, 503);
});
test('Worker: a sending app creates a case with its Bearer key from the configured client address header', async t => {
  const h = await createD1Harness(); t.after(() => h.close()); await seed(h.store);
  const worker = createWorker({ loadKeys: async () => [jwk], now: () => now });
  // Synthetic token for this test only; the binding holds just its SHA-256.
  const appToken = 'synthetic-worker-app-token-0123456789abcd';
  const caseSettingsText = await readFile(new URL('../../config/case-settings.example.toml', import.meta.url), 'utf8');
  const [kind] = parseCaseSettingsToml(caseSettingsText).kinds.values;
  const apps = { apps: [{ name: 'app_one', keys_sha256: [createHash('sha256').update(appToken).digest('hex')], envs: ['production'],
    allow_ips: ['192.0.2.0/24', '2001:db8::/32'] }],
  scopes: [{ app: 'app_one', workspace_id: ids.workspace, source: ['app_one'], tenant: ['*'] }] };
  const env = { ...bindings(h.database), CASE_SETTINGS: caseSettingsText, APPS_CONFIG: JSON.stringify(apps),
    APP_ENVIRONMENT: 'production', CLIENT_IP_HEADER: 'CF-Connecting-IP' };
  assert.ok(!env.APPS_CONFIG.includes(appToken));
  const cases = `https://deskly.example/api/v1/workspaces/${ids.workspace}/cases`;
  const call = (method, headers, key = appToken) => new Request(cases, { method, headers: { host: 'deskly.example',
    ...(key ? { authorization: `Bearer ${key}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify({ origin: 'human', kind, title: '合成の受付', body: '合成の本文' }) } : {}) });
  const created = await worker.fetch(call('POST', { 'CF-Connecting-IP': '192.0.2.10' }), env);
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal((await created.json()).number, 'app_one-1');
  const listed = await worker.fetch(call('GET', { 'CF-Connecting-IP': '2001:db8::7' }), env);
  assert.deepEqual((await listed.json()).items.map(({ number, evidence_missing }) => [number, evidence_missing]), [['app_one-1', false]]);
  for (const [headers, key, bindingChanges] of [
    [{ 'CF-Connecting-IP': '198.51.100.10' }, appToken, {}],
    [{}, appToken, {}],
    [{ 'X-Forwarded-For': '192.0.2.10' }, appToken, {}],
    [{ 'CF-Connecting-IP': '192.0.2.10' }, 'synthetic-unknown-token-0123456789abcdef', {}],
    [{ 'CF-Connecting-IP': '192.0.2.10' }, appToken, { APP_ENVIRONMENT: 'staging' }],
  ]) {
    const response = await worker.fetch(call('GET', headers, key), { ...env, ...bindingChanges });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  // Incomplete or inconsistent bindings make the Worker unavailable instead of open.
  const broken = { ...apps, scopes: [] };
  for (const changes of [{ CLIENT_IP_HEADER: undefined }, { APP_ENVIRONMENT: undefined }, { CASE_SETTINGS: undefined },
    { APPS_CONFIG: JSON.stringify(broken) }, { APPS_CONFIG: 'x = [' }]) {
    assert.equal((await worker.fetch(call('GET', { 'CF-Connecting-IP': '192.0.2.10' }), { ...env, ...changes })).status, 503);
  }
  // Members keep the Access path; without case settings every case route fails closed.
  const member = new Request(cases, { headers: { host: 'deskly.example', 'Cf-Access-Jwt-Assertion': await token() } });
  assert.equal((await worker.fetch(member, env)).status, 200);
  const disabled = await worker.fetch(member, bindings(h.database));
  assert.equal(disabled.status, 404);
  assert.deepEqual(await disabled.json(), { error: 'cases_not_enabled' });
});
test('Worker: injected Store and key provider make configuration request-scoped', async () => {
  const store = new MemoryStore(); await seed(store);
  const worker = createWorker({ store: () => store, loadKeys: async () => [jwk], now: () => now });
  const env = bindings({});
  assert.equal((await worker.fetch(await api(await token()), env)).status, 200);
  assert.equal((await worker.fetch(await api(await token()), { ...env, ACCESS_AUD: 'synthetic-other-audience' })).status, 401);
});
