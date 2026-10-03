import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalWorker } from '../.build/adapters/cloudflare/personal.js';
import { MemoryStore } from '../.build/memory-store.js';
import { seed, principalFixtures, ids } from './contract/fixtures.mjs';
const issuer = 'https://access.example';
const audience = 'synthetic-audience';
const now = 1_800_000_000;
const identity = { subject: 'synthetic-access-subject', email: 'owner@example.com', principal: principalFixtures.owner };
const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}) {
  const text = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: [audience],
    iat: now - 10, exp: now + 60, sub: identity.subject, email: identity.email, ...changes })}`;
  return `${text}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(text))).toString('base64url')}`;
}
const env = { DB: {}, PUBLIC_ORIGIN: 'https://deskly.example', ACCESS_ISSUER: issuer, ACCESS_AUD: audience,
  ACCESS_IDENTITIES: JSON.stringify([identity]), CONFIRMATION_SECRET: 'synthetic-confirmation-key-at-least-32-bytes', REVISION: 'synthetic-revision' };
const request = (path, jwt, method = 'GET', origin = env.PUBLIC_ORIGIN) => new Request(`${origin}${path}`, {
  method, headers: { host: new URL(origin).host, ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}) } });
test('personal boundary rejects missing/other/expired Access on UI, assets, API and health', async () => {
  const worker = createPersonalWorker({ loadKeys: async () => [jwk], now: () => now });
  for (const path of ['/', '/assets/main.js', `/api/v1/workspaces/${ids.workspace}/projects`, '/healthz']) {
    for (const jwt of [undefined, await token({ sub: 'synthetic-other' }), await token({ exp: now }),
      await token({ email: 'other@example.com' }), await token({ iss: 'https://other.example' }),
      await token({ aud: ['synthetic-other-audience'] }), 'bad.token.signature']) {
      assert.equal((await worker.fetch(request(path, jwt), env)).status, 401);
    }
  }
});
test('personal owner reaches shared UI/API and receives only revision from health without database access', async () => {
  const store = new MemoryStore(); await seed(store);
  let calls = 0;
  const worker = createPersonalWorker({ store: () => store, loadKeys: async () => { calls++; return [jwk]; }, now: () => now });
  const jwt = await token();
  const health = await worker.fetch(request('/healthz', jwt), env);
  assert.deepEqual(await health.json(), { revision: env.REVISION });
  assert.equal((await worker.fetch(request('/healthz', jwt, 'HEAD'), env)).status, 200);
  assert.equal((await worker.fetch(request('/healthz', jwt, 'POST'), env)).status, 405);
  assert.equal((await worker.fetch(request('/', jwt), env)).status, 200);
  const before = calls;
  assert.equal((await worker.fetch(request(`/api/v1/workspaces/${ids.workspace}/projects`, jwt), env)).status, 200);
  assert.equal(calls - before, 1);
  assert.equal((await worker.fetch(request('/healthz', jwt, 'GET', 'https://other.example'), env)).status, 403);
});
test('personal boundary fails closed on extra identities, member role, app access and missing secret/revision', async () => {
  const worker = createPersonalWorker({ loadKeys: async () => [jwk], now: () => now });
  for (const change of [{ ACCESS_IDENTITIES: JSON.stringify([identity, identity]) },
    { ACCESS_IDENTITIES: JSON.stringify([{ ...identity, principal: { ...identity.principal, role: 'member' } }]) },
    { CONFIRMATION_SECRET: 'short' }, { REVISION: '' }, { APPS_CONFIG: '{}' }, { DB: undefined }]) {
    assert.equal((await worker.fetch(request('/healthz', await token()), { ...env, ...change })).status, 503);
  }
});
