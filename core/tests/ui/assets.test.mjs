import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { uiAssets, uiSecurityHeaders, serveUi } from '../../.build/ui-assets.js';
import { startServer } from '../../.build/adapters/vps/server.js';
import { createWorker } from '../../.build/adapters/cloudflare/worker.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { principalFixtures } from '../contract/fixtures.mjs';
const origin = 'https://deskly.example';
const principal = principalFixtures.owner;
function nodeRequest(base, path, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { host: 'deskly.example', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve(new Response(method === 'HEAD' ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    }); req.on('error', reject); req.end();
  });
}
async function accessToken() {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = 1_800_000_000, issuer = 'https://access.example', audience = 'synthetic-ui-audience';
  const identity = { subject: 'synthetic-ui-subject', email: 'synthetic@example.com', principal };
  const message = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: audience, iat: now - 10, exp: now + 60, sub: identity.subject, email: identity.email })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(message));
  return { token: `${message}.${Buffer.from(signature).toString('base64url')}`, jwk, now,
    env: { DB: {}, PUBLIC_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUD: audience,
      ACCESS_IDENTITIES: JSON.stringify([identity]), CONFIRMATION_SECRET: 'synthetic-ui-confirmation-key-at-least-32' } };
}

test('UI assets: actual Node and Workers entries return identical HTML, modules, CSS and security/cache headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deskly-ui-assets-'));
  const credentials = await accessToken();
  const authenticator = { async authenticate(request) { return request.headers.get('authorization') === 'Bearer synthetic-ui-token' ? principal : null; } };
  const running = await startServer({ databasePath: join(directory, 'synthetic.sqlite'), origin, port: 0 },
    { authenticator, signer: await createConfirmationSigner(new Uint8Array(32).fill(7)) });
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${running.server.address().port}`;
  const worker = createWorker({ loadKeys: async () => [credentials.jwk], now: () => credentials.now,
    store: () => { throw new Error('Static assets must not open the store'); } });
  for (const authorized of [false, true]) for (const path of [...Object.keys(uiAssets), '/workspace']) for (const method of ['GET', 'HEAD']) {
    const vps = await nodeRequest(base, path, method, authorized ? { authorization: 'Bearer synthetic-ui-token' } : {});
    const workers = await worker.fetch(new Request(`${origin}${path}`, { method, headers: authorized ? { 'Cf-Access-Jwt-Assertion': credentials.token } : {} }), credentials.env);
    assert.equal(vps.status, 200, path); assert.equal(workers.status, 200, path);
    const nodeBody = await vps.text(), workerBody = await workers.text(); assert.equal(nodeBody, workerBody, path);
    for (const header of ['content-type', 'cache-control', ...Object.keys(uiSecurityHeaders), 'vary']) assert.equal(vps.headers.get(header), workers.headers.get(header), `${path}: ${header}`);
    assert.equal(vps.headers.get('cache-control'), 'no-store');
    assert.match(vps.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    if (method === 'HEAD') assert.equal(nodeBody, '');
    else if (path === '/' || path === '/workspace') {
      assert.equal(nodeBody.includes(`content="${principal.member_id}"`), authorized);
      assert.doesNotMatch(nodeBody, /synthetic-ui-token|synthetic@example.com|synthetic-ui-subject|account_subject|preview_token/);
    } else assert.equal(nodeBody, uiAssets[path].content);
  }
  for (const [path, method, headers, status] of [
    ['/assets/missing.js', 'GET', {}, 404], ['/favicon.ico', 'GET', {}, 404], ['/', 'POST', {}, 405],
    ['/', 'GET', { origin: 'https://untrusted.example' }, 403],
  ]) {
    assert.equal((await nodeRequest(base, path, method, headers)).status, status);
    assert.equal((await worker.fetch(new Request(`${origin}${path}`, { method, headers }), credentials.env)).status, status);
  }
});

test('UI assets: API stays delegated; no HTML or auth leak on unknown API and unsafe host', async () => {
  const options = { origin, authenticator: { async authenticate() { return principal; } } };
  for (const path of ['/api', '/api/v1/workspaces/unknown', '/api/missing']) assert.equal(await serveUi(new Request(`${origin}${path}`), options), null);
  assert.equal((await serveUi(new Request('https://untrusted.example/'), options)).status, 403);
  assert.equal((await serveUi(new Request(`${origin}/`, { headers: { host: 'untrusted.example' } }), options)).status, 403);
  const hostile = { ...principal, member_id: '"><script>alert(1)</script>' };
  const body = await (await serveUi(new Request(`${origin}/`), { origin, authenticator: { async authenticate() { return hostile; } } })).text();
  assert.doesNotMatch(body, /deskly-member|alert\(1\)/);
  const query = await (await serveUi(new Request(`${origin}/?member=untrusted&role=owner`), options)).text();
  assert.match(query, new RegExp(principal.member_id)); assert.doesNotMatch(query, /untrusted|role=owner/);
});

test('UI assets: build packages the exact source HTML/CSS and tsc-only ES modules', async () => {
  const builtHtml = await readFile(new URL('../../.build/public/index.html', import.meta.url), 'utf8');
  const sourceHtml = await readFile(new URL('../../ui/index.html', import.meta.url), 'utf8');
  assert.equal(builtHtml, sourceHtml); assert.equal(uiAssets['/'].content, sourceHtml);
  assert.equal(uiAssets['/assets/workspace.css'].content, await readFile(new URL('../../ui/workspace.css', import.meta.url), 'utf8'));
  assert.equal(uiAssets['/assets/workspace.js'].content, await readFile(new URL('../../.build/browser/ui/workspace.js', import.meta.url), 'utf8'));
  assert.equal(uiAssets['/assets/cases.js'].content, await readFile(new URL('../../.build/browser/ui/cases.js', import.meta.url), 'utf8'));
  assert.match(uiAssets['/assets/main.js'].content, /import.*\.\/workspace\.js/);
  assert.match(uiAssets['/assets/main.js'].content, /import.*\.\/cases\.js/);
  assert.doesNotMatch(sourceHtml, /<script(?![^>]*src=)[^>]*>[^<]+|\son\w+=/);
});
