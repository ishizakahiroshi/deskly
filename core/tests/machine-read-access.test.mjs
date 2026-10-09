import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPersonalWorker } from '../.build/adapters/cloudflare/personal.js';
import { createWorker } from '../.build/adapters/cloudflare/worker.js';
import { createAccessAuthenticator, createMachineReadAuthenticator, parseMachineReadScopes } from '../.build/adapters/cloudflare/access.js';
import { MemoryStore } from '../.build/memory-store.js';
import { seed, snapshot, principalFixtures, ids, uuid } from './contract/fixtures.mjs';

const issuer = 'https://access.example';
const audience = 'synthetic-machine-audience';
const now = 1_800_000_000;
const client = 'Opaque:synthetic+read/client=V2.access';
const scope = { client_id: client, workspace_id: ids.workspace, project_ids: [ids.project] };
const identity = { subject: 'synthetic-owner-subject', email: 'owner@example.com', principal: principalFixtures.owner };
const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'synthetic-read-key', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}, header = {}) {
  const text = `${encode({ alg: 'RS256', kid: jwk.kid, ...header })}.${encode({ type: 'app', iss: issuer, aud: [audience],
    iat: now - 10, exp: now + 60, sub: '', common_name: client, ...changes })}`;
  return `${text}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(text))).toString('base64url')}`;
}
const env = { DB: {}, PUBLIC_ORIGIN: 'https://deskly.example', ACCESS_ISSUER: issuer, ACCESS_AUD: audience,
  ACCESS_IDENTITIES: JSON.stringify([identity]), ACCESS_MACHINE_READ_SCOPES: JSON.stringify([scope]),
  CONFIRMATION_SECRET: 'synthetic-confirmation-key-at-least-32-bytes', REVISION: 'synthetic-revision' };
const base = `/api/v1/workspaces/${ids.workspace}`;
const projects = `${base}/projects`;
const project = `${projects}/${ids.project}`;
const items = `${project}/work-items`;
const request = (path, jwt, method = 'GET', headers = {}) => new Request(`${env.PUBLIC_ORIGIN}${path}`, {
  method, headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...headers } });
const dependencies = store => ({ store: () => store, loadKeys: async () => [jwk], now: () => now });

for (const [label, make] of [['personal outer boundary', createPersonalWorker], ['inner Worker/API', createWorker]]) {
  test(`${label}: machine reads exact projects/items without human ports or changing store/history`, async () => {
    const store = new MemoryStore(); await seed(store);
    const before = await snapshot(store);
    let reads = 0;
    const guarded = { transaction: async () => assert.fail('machine must not write'), read: callback => store.read(session => {
      reads++;
      return callback(new Proxy(session, { get(target, property) {
        if (['accounts', 'memberships', 'contacts', 'events', 'cases'].includes(property)) assert.fail(`machine accessed ${property}`);
        return Reflect.get(target, property);
      } }));
    }) };
    const worker = make(dependencies(guarded));
    const jwt = await token();
    const listed = await worker.fetch(request(projects, jwt), env);
    assert.equal(listed.status, 200);
    const result = await listed.json();
    assert.deepEqual(result.projects.map(row => row.id), [ids.project]);
    assert.deepEqual(result.archived_projects, []);
    assert.equal(JSON.stringify(result).includes(ids.hiddenProject), false);
    for (const [path, field, expected] of [[project, 'id', ids.project], [`${items}/${ids.work}`, 'id', ids.work]]) {
      const response = await worker.fetch(request(path, jwt), env);
      assert.equal(response.status, 200); assert.equal((await response.json())[field], expected);
    }
    const response = await worker.fetch(request(items, jwt), env);
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).items.map(row => row.id), [ids.work]);
    assert.equal(reads, 4);
    assert.deepEqual(await snapshot(store), before);
  });
  test(`${label}: authentication validates signed service shape, issuer/audience/time and ignores spoofed headers`, async () => {
    const store = new MemoryStore(); await seed(store);
    const worker = make(dependencies(store));
    const good = await token();
    const [head, payload, signature] = good.split('.');
    const tampered = `${head}.${encode({ ...JSON.parse(Buffer.from(payload, 'base64url')), common_name: 'synthetic-forged.access' })}.${signature}`;
    const invalid = [undefined, 'bad.token.signature', tampered,
      await token({ iss: 'https://other.example' }), await token({ aud: ['other'] }), await token({ exp: now }),
      await token({ iat: now + 120 }), await token({ nbf: now + 1 }), await token({ common_name: 'unknown.access' }), await token({ common_name: client + 'x' }),
      await token({ common_name: client.toLowerCase() }), await token({ common_name: ` ${client}` }),
      await token({ type: 'org' }), await token({ sub: identity.subject }), await token({ email: identity.email }),
      await token({ common_name: undefined }), await token({}, { alg: 'HS256' }), await token({}, { kid: 'unknown' })];
    for (const jwt of invalid) {
      const response = await worker.fetch(request(project, jwt, 'GET', { 'CF-Access-Client-Id': client,
        'CF-Access-Client-Secret': 'synthetic-client-secret', Authorization: 'Bearer synthetic-bearer' }), env);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    // Changing the unsigned Client ID cannot expand the signed JWT scope.
    const response = await worker.fetch(request(`${projects}/${ids.hiddenProject}`, good, 'GET', { 'CF-Access-Client-Id': 'other.access' }), env);
    assert.equal(response.status, 404);
    assert.equal((await worker.fetch(request(project, good), { ...env, ACCESS_MACHINE_READ_SCOPES: '[]' })).status, 401);
    assert.equal((await worker.fetch(request(project, good), { ...env, ACCESS_MACHINE_READ_SCOPES: undefined })).status, 401);
    const badKeys = make({ ...dependencies(store), loadKeys: async () => [{ ...jwk, n: jwk.n.slice(0, -2) + 'AA' }] });
    assert.equal((await badKeys.fetch(request(project, good), env)).status, 401);
  });
  test(`${label}: scope/archived parent/foreign child return identical non-leaking 404`, async () => {
    const store = new MemoryStore(); await seed(store);
    const worker = make(dependencies(store)); const jwt = await token();
    const absent = uuid(999);
    for (const path of [`/api/v1/workspaces/${ids.otherWorkspace}/projects`, `/api/v1/workspaces/${absent}/projects`,
      `${projects}/${ids.hiddenProject}`, `${projects}/${absent}`, `${items}/${ids.hiddenWork}`, `${items}/${absent}`,
      `${projects}/${ids.hiddenProject}/work-items/${ids.hiddenWork}`, `${projects}/${absent}/work-items/${absent}`]) {
      const response = await worker.fetch(request(path, jwt), env);
      assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
    }
    await store.transaction(async session => {
      const child = await session.resources.get(ids.workspace, ids.work);
      await session.resources.put({ ...child, archived: true, version: child.version + 1 }, child.version);
    });
    assert.deepEqual(await (await worker.fetch(request(items, jwt), env)).json(), { items: [] });
    assert.equal((await worker.fetch(request(`${items}/${ids.work}`, jwt), env)).status, 404);
    await store.transaction(async session => {
      const child = await session.resources.get(ids.workspace, ids.work);
      await session.resources.put({ ...child, archived: false, version: child.version + 1 }, child.version);
      const parent = await session.resources.get(ids.workspace, ids.project);
      await session.resources.put({ ...parent, archived: true, version: parent.version + 1 }, parent.version);
    });
    // Child remains active: parent's archival alone must remove every entry path.
    assert.equal((await store.read(session => session.resources.get(ids.workspace, ids.work))).archived, false);
    for (const path of [project, items, `${items}/${ids.work}`]) {
      const response = await worker.fetch(request(path, jwt), env);
      assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'not_found' });
    }
    assert.deepEqual(await (await worker.fetch(request(projects, jwt), env)).json(), { projects: [], archived_projects: [] });
  });
  test(`${label}: every other API and all mutation methods are rejected before store access`, async () => {
    const api = JSON.parse(await readFile(new URL('../../schema/openapi.json', import.meta.url), 'utf8'));
    const store = { read: async () => assert.fail('denied route read the store'), transaction: async () => assert.fail('denied route wrote') };
    const worker = make(dependencies(store)); const jwt = await token();
    const permitted = new Set(['/api/v1/workspaces/{workspace_id}/projects', '/api/v1/workspaces/{workspace_id}/projects/{project_id}',
      '/api/v1/workspaces/{workspace_id}/projects/{project_id}/work-items', '/api/v1/workspaces/{workspace_id}/projects/{project_id}/work-items/{work_item_id}']);
    for (const [template, operations] of Object.entries(api.paths)) {
      const path = template.replace(/\{[^}]+\}/g, field => field === '{workspace_id}' ? ids.workspace : field === '{project_id}' ? ids.project : ids.work);
      for (const method of Object.keys(operations).filter(method => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))) {
        if (method === 'get' && permitted.has(template)) continue;
        const response = await worker.fetch(request(path, jwt, method.toUpperCase(), { Origin: env.PUBLIC_ORIGIN }), env);
        assert.equal(response.status, 403, `${method} ${template}`);
      }
    }
    for (const path of [project, projects, items, `${items}/${ids.work}`, '/unknown', '/', '/assets/main.js', '/healthz']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        assert.equal((await worker.fetch(request(path, jwt, method, { Origin: env.PUBLIC_ORIGIN }), env)).status, 403, `${method} ${path}`);
      }
    }
    for (const path of ['/', '/assets/main.js', '/healthz', `${project}/events`, `${project}?include=history`, `${items}?source=all`]) {
      assert.equal((await worker.fetch(request(path, jwt), env)).status, 403);
    }
  });
  test(`${label}: invalid scope configuration closes instead of fallback`, async () => {
    const worker = make(dependencies(new MemoryStore()));
    for (const value of ['', 'null', '{}', '{', JSON.stringify([{}]), JSON.stringify([{ ...scope, project_ids: [] }]),
      JSON.stringify([scope, scope]), JSON.stringify([{ ...scope, project_ids: [ids.project, ids.project] }]),
      JSON.stringify([{ ...scope, workspace_id: 'not-an-id' }]), JSON.stringify([{ ...scope, role: 'owner' }]),
      ...['', ` ${client}`, `${client} `, 'bad\nvalue', 'x'.repeat(257)].map(client_id => JSON.stringify([{ ...scope, client_id }]))]) {
      assert.equal((await worker.fetch(request(project, await token()), { ...env, ACCESS_MACHINE_READ_SCOPES: value })).status, 503);
    }
  });
}

test('machine principal has no member/owner identity; authenticated owner remains a human', async () => {
  const config = { issuer, audience, loadKeys: async () => [jwk], now: () => now };
  const machine = createMachineReadAuthenticator({ ...config, scopes: parseMachineReadScopes(JSON.stringify([scope])) });
  const principal = await machine.authenticate(request(project, await token()));
  assert.deepEqual(principal, { kind: 'machine-read', service_id: client, workspace_id: ids.workspace, project_ids: [ids.project] });
  const human = createAccessAuthenticator({ ...config, identities: [identity] });
  assert.equal(await human.authenticate(request(project, await token())), null);
  const jwt = await token({ sub: identity.subject, email: identity.email, common_name: undefined });
  assert.deepEqual(await human.authenticate(request(project, jwt)), principalFixtures.owner);
  assert.equal(await machine.authenticate(request(project, jwt)), null);
});

for (const [label, module, factory] of [
  ['SQLite', './adapters/sqlite-harness.mjs', 'createSQLiteHarness'],
  ['D1', './adapters/d1-harness.mjs', 'createD1Harness'],
]) {
  test(`${label}: machine read and rejected preview preserve the complete persistent snapshot`, async t => {
    const harness = await (await import(module))[factory](); t.after(() => harness.close());
    await seed(harness.store);
    const before = await snapshot(harness.store);
    const worker = createPersonalWorker(dependencies(harness.store)); const jwt = await token();
    for (const path of [projects, project, items, `${items}/${ids.work}`]) {
      assert.equal((await worker.fetch(request(path, jwt), env)).status, 200);
    }
    assert.equal((await worker.fetch(request(`${base}/commands/preview`, jwt, 'POST', { Origin: env.PUBLIC_ORIGIN }), env)).status, 403);
    assert.deepEqual(await snapshot(harness.store), before);
  });
}
