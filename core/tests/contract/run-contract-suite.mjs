import assert from 'node:assert/strict';
import { registerContactApiTests } from './contact-api.mjs';
import { appFixtures, caseSettings, exerciseCaseOperations, registerCaseApiTests } from './case-api.mjs';
import { registerCaseAppTests } from './case-app-api.mjs';
import { registerCaseSettingsTests } from './case-settings-api.mjs';
import { exerciseCaseMemberScopeOperations, registerCaseMemberScopeTests } from './case-member-api.mjs';
import { describe, test } from 'node:test';
import { WorkspaceService } from '../../.build/service.js';
import { ContactLedgerService } from '../../.build/contact-service.js';
import { createHttpHandler } from '../../.build/http.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { CONTACT_STATES } from '../../.build/status.js';
import { assertApiSchema, assertEntitySchema, assertHttpContract, operations } from './schema-validation.mjs';
import { clockTime, contactData, contacts, entity, ids, milestoneData, principalFixtures,
  projectData, seed, snapshot, uuid, workData } from './fixtures.mjs';

const workspacePath = `/api/v1/workspaces/${ids.workspace}`;
const projectPath = `${workspacePath}/projects/${ids.project}`;
const contactPath = `${projectPath}/sources/${ids.source}/contacts/${contacts.normal}`;
const dataFor = { project: projectData, milestone: milestoneData, work_item: workData };
const targetFor = { project: ids.project, milestone: ids.milestone, work_item: ids.work };
const clone = (value) => structuredClone(value);
/** Override only selected capabilities; class/private-field methods keep their receiver. */
export function overridePort(target, overrides) {
  return new Proxy(Object.create(null), {
    get(_facade, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_facade, key) { return Object.hasOwn(overrides, key) || key in target; },
  });
}
/** Inject faulty adapter responses, never invalid stored fixtures. */
function withSessions(store, transform, modes = ['read', 'transaction']) {
  return overridePort(store, Object.fromEntries(modes.map((mode) => [mode,
    (run) => store[mode]((session) => run(transform(session))),
  ])));
}
const rejects = (run, status, codes) => assert.rejects(run, (error) => {
  assert.equal(error.status, status, `${error.code ?? error.name}: ${error.message}`);
  if (codes) assert.ok([codes].flat().includes(error.code), `unexpected error ${error.code}`);
  return true;
});
const expectedChanges = (before, after) => [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
  .sort().filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]))
  .map((field) => ({ field, before_present: before !== null && Object.hasOwn(before, field),
    after_present: Object.hasOwn(after, field), before: before?.[field] ?? null, after: after[field] ?? null }));

/**
 * Register the same service + HTTP contract tests for any Store adapter.
 * createHarness({principals}) returns {store, authenticator, close?}; the test-only
 * authenticator resolves x-contract-actor from the supplied synthetic principals.
 * Each test gets a new isolated store, seeded only through public transaction ports.
 * No MemoryStore imports, adapter internals, network server or real home are used.
 */
export function runContractSuite(createHarness) {
  async function setup(t) {
    const principals = clone(principalFixtures);
    const harness = await createHarness({ principals });
    assert.equal(typeof harness.store.transaction, 'function');
    assert.equal(typeof harness.authenticator.authenticate, 'function');
    t.after(async () => { if (harness.close) await harness.close(); });
    await seed(harness.store);
    const signer = await createConfirmationSigner(new Uint8Array(32).fill(7)); // Synthetic test key only.
    let generated = 5000;
    let operation = 1000;
    const clock = { time: clockTime, now() { return clock.time; } };
    const dependencies = { store: harness.store, clock,
      ids: { next: () => uuid(generated++) }, signer, route: 'dashboard', caseSettings };
    const service = new WorkspaceService(dependencies);
    const apps = clone(appFixtures);
    const appAuthenticator = { async authenticate(request) {
      const name = request.headers.get('x-contract-app');
      return Object.hasOwn(apps, name) ? structuredClone(apps[name]) : null;
    } };
    const handler = createHttpHandler({ service, authenticator: harness.authenticator, appAuthenticator, origin: 'https://deskly.example' });
    const covered = new Set();
    const context = { ...harness, principals, service, handler, dependencies, signer, covered, clock, apps,
      appAuthenticator, caseSettings,
      op: () => uuid(operation++),
      command(kind = 'work_item', action = 'update', overrides = {}) {
        return { operation_id: uuid(operation++), action, type: kind,
          id: action === 'create' ? null : targetFor[kind],
          project_id: kind === 'project' ? null : ids.project,
          expected_version: action === 'create' ? null : 1,
          data: ['create', 'update'].includes(action) ? dataFor[kind]() : null,
          reason: '合成の変更理由', ...overrides };
      },
      async request(actor, method, path, body, expectedStatus = 200, extraHeaders = {}) {
        const headers = { host: 'deskly.example', origin: 'https://deskly.example',
          'sec-fetch-site': 'same-origin', ...extraHeaders };
        if (actor !== null) headers['x-contract-actor'] = actor;
        if (body !== undefined) headers['content-type'] ??= 'application/json';
        const response = await handler(new Request(`https://deskly.example${path}`, {
          method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }));
        assert.equal(response.status, expectedStatus, `${method} ${path}: ${await response.clone().text()}`);
        assert.match(response.headers.get('content-type') ?? '', /application\/json/);
        const result = await response.json();
        const operationId = assertHttpContract(method, path, response.status, result);
        if (response.status === 200 && operationId) covered.add(operationId);
        return result;
      },
    };
    return context;
  }
  const previewApply = async (ctx, command, actor = 'owner') => {
    const preview = await ctx.service.preview(ctx.principals[actor], ids.workspace, command);
    assertApiSchema('CommandPreview', preview);
    const result = await ctx.service.apply(ctx.principals[actor], ids.workspace, preview);
    assertApiSchema('CommandResult', result);
    return { preview, result };
  };
  const projectGrant = (ctx, role, expected_version = 1, member = ids.editor) =>
    ctx.service.setProjectMembership(ctx.principals.owner, ids.workspace, ids.project, member,
      { operation_id: ctx.op(), expected_version, role, reason: '合成の権限変更' });
  const sourceGrant = (ctx, allowed, expected_version = 1, member = ids.viewer) =>
    ctx.service.setSourceMembership(ctx.principals.owner, ids.workspace, ids.source, member,
      { operation_id: ctx.op(), expected_version, allowed, reason: '合成の接続元権限変更' });

  describe('portable Store / service / HTTP contract', () => {
    registerContactApiTests(setup);
    registerCaseApiTests(setup);
    registerCaseAppTests(setup);
    registerCaseSettingsTests(setup);
    registerCaseMemberScopeTests(setup);
    test('fault wrappers preserve prototype methods, private receivers and accessors', async () => {
      class Port {
        #value = 'synthetic';
        get label() { return this.#value; }
        async get() { return this.#value; }
        async append(value) { this.#value = value; }
      }
      class Session {
        #events = new Port();
        get events() { return this.#events; }
        async identity() { return this.#events.label; }
      }
      const original = new Session();
      const wrapped = overridePort(original, { events: overridePort(original.events, {
        append: async () => { throw new Error('synthetic append failure'); },
      }) });
      assert.equal(await wrapped.identity(), 'synthetic');
      assert.equal(await wrapped.events.get(), 'synthetic');
      assert.equal(wrapped.events.label, 'synthetic');
      await assert.rejects(() => wrapped.events.append('changed'), /synthetic append failure/);
      assert.equal(await original.events.get(), 'synthetic');
    });

    test('every OpenAPI operation returns a schema-valid response through the shared handler', async (t) => {
      const c = await setup(t);
      const reads = [
        workspacePath, '/api/v1/accounts/me', `${workspacePath}/projects`, projectPath,
        `${projectPath}/milestones`, `${projectPath}/milestones/${ids.milestone}`,
        `${projectPath}/work-items`, `${projectPath}/work-items/${ids.work}`, contactPath,
        `${projectPath}/events`, `${workspacePath}/memberships`,
        `${workspacePath}/project-roles/me`, `${workspacePath}/sources/${ids.source}/contacts`,
        `${workspacePath}/sources/${ids.source}/contacts/${contacts.normal}`,
        `${workspacePath}/sources/${ids.source}/contacts/${contacts.normal}/history`,
        `${workspacePath}/sources/${ids.source}/contacts/${contacts.normal}/body`,
        `${workspacePath}/sources/${ids.source}/waiting`,
      ];
      for (const path of reads) await c.request('owner', 'GET', path);
      await c.request('owner', 'PUT', `${projectPath}/memberships/${ids.outsider}`,
        { operation_id: c.op(), expected_version: 0, role: 'viewer', reason: '合成の付与' });
      await c.request('owner', 'PUT', `${workspacePath}/sources/${ids.otherSource}/memberships/${ids.viewer}`,
        { operation_id: c.op(), expected_version: 0, allowed: true, reason: '合成の付与' });
      const before = await snapshot(c.store);
      const preview = await c.request('owner', 'POST', `${workspacePath}/commands/preview`, c.command('work_item', 'create'));
      assert.deepEqual(await snapshot(c.store), before, 'HTTP preview must not write');
      await c.request('owner', 'POST', `${workspacePath}/commands/apply`, preview);
      await c.request('owner', 'GET', `${projectPath}/events`);
      const ledgerCommands = `${workspacePath}/sources/${ids.source}/contacts/commands`;
      const contactPreview = await c.request('owner', 'POST', `${ledgerCommands}/preview`, {
        operation_id: c.op(), action: 'add_draft', contact_id: null, expected_version: null,
        data: { body: '合成の本文' }, reason: '合成の追加',
      });
      await c.request('owner', 'POST', `${ledgerCommands}/apply`, contactPreview);
      await exerciseCaseOperations(c);
      await c.request('owner', 'GET', `${workspacePath}/cases/settings`);
      await exerciseCaseMemberScopeOperations(c);
      assert.deepEqual([...c.covered].sort(), operations.map(({ operation }) => operation.operationId).sort());
    });

    test('all create/update/archive/restore commands preserve complete before/after history', async (t) => {
      const c = await setup(t);
      for (const kind of ['project', 'milestone', 'work_item']) {
        const initial = await snapshot(c.store);
        const create = c.command(kind, 'create');
        const preview = await c.service.preview(c.principals.owner, ids.workspace, create);
        assertApiSchema('CommandPreview', preview);
        assert.equal(preview.before, null);
        assert.ok(preview.request.id);
        assert.deepEqual(await snapshot(c.store), initial);
        let current = await c.service.apply(c.principals.owner, ids.workspace, preview);
        for (const action of ['update', 'archive', 'restore']) {
          const command = c.command(kind, action, { id: current.id, expected_version: current.version,
            data: action === 'update' ? dataFor[kind](kind === 'project'
              ? { purpose: '合成の変更目的' } : kind === 'milestone'
                ? { acceptance: '合成の変更条件' } : { waiting_reason: '合成の待ち理由', state: '待ち' }) : null });
          const prior = clone(current);
          const result = await previewApply(c, command);
          assert.deepEqual(result.preview.before, prior);
          assert.equal(result.result.version, prior.version + 1);
          assert.equal(result.result.archived, action === 'archive');
          const event = await c.store.read((session) => session.events.get(ids.workspace, command.operation_id));
          assertApiSchema('Event', event);
          assert.deepEqual(event.before, prior);
          assert.deepEqual(event.after, result.result);
          assert.deepEqual(event.changes, expectedChanges(prior, result.result));
          assert.equal(event.requester_member_id, ids.owner);
          assert.equal(event.member_id, ids.owner);
          assert.equal(event.at_utc, clockTime);
          assert.equal(event.reason, command.reason);
          assert.equal(event.route, 'dashboard');
          assert.equal(event.executor_kind, 'unknown');
          assert.equal(event.executor_ref, null);
          assert.equal(event.executor_verified, false);
          current = result.result;
        }
        const created = await c.store.read((session) => session.events.get(ids.workspace, create.operation_id));
        assert.equal(created.before, null);
        assert.deepEqual(created.changes, expectedChanges(null, preview.after));
      }
    });

    test('successful replays return the original result and never add an event', async (t) => {
      const c = await setup(t);
      const first = await previewApply(c, c.command());
      const second = await previewApply(c, c.command('work_item', 'update', {
        expected_version: first.result.version, data: workData({ title: '合成の次の版' }),
      }));
      const before = await snapshot(c.store);
      assert.deepEqual(await c.service.apply(c.principals.owner, ids.workspace, first.preview), first.result);
      assert.deepEqual(await snapshot(c.store), before);
      assert.equal((await c.service.workItem(c.principals.owner, ids.workspace, ids.project, ids.work)).version, second.result.version);
    });

    test('stale versions, duplicate IDs, altered operations and preview tampering cannot write', async (t) => {
      const c = await setup(t);
      const command = c.command();
      const stale = await c.service.preview(c.principals.owner, ids.workspace, command);
      const { result } = await previewApply(c, c.command());
      await rejects(() => c.service.apply(c.principals.owner, ids.workspace, stale), 409, ['version_conflict', 'stale_preview']);
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace, command), 409, 'version_conflict');
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace,
        c.command('project', 'create', { id: ids.project })), 409, 'duplicate_id');
      const used = await previewApply(c, c.command('work_item', 'update', { expected_version: result.version }));
      const different = await c.service.preview(c.principals.owner, ids.workspace, c.command('work_item', 'update', {
        operation_id: used.preview.request.operation_id, expected_version: used.result.version,
        data: workData({ title: '合成の異なる操作' }),
      }));
      await rejects(() => c.service.apply(c.principals.owner, ids.workspace, different), 409, 'operation_conflict');
      const valid = await c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'update', { expected_version: used.result.version }));
      const before = await snapshot(c.store);
      for (const altered of [
        { ...valid, after: { ...valid.after, next_action: '合成の改変' } },
        { ...valid, request: { ...valid.request, reason: '合成の改変' } },
        { ...valid, preview_token: '0'.repeat(64) },
      ]) await rejects(() => c.service.apply(c.principals.owner, ids.workspace, altered), 403, 'invalid_preview');
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('concurrent compare-and-update admits exactly one write and its matching event', async (t) => {
      const c = await setup(t);
      const previews = await Promise.all(['合成A', '合成B'].map((title) => c.service.preview(c.principals.owner,
        ids.workspace, c.command('work_item', 'update', { data: workData({ title }) }))));
      const results = await Promise.allSettled(previews.map((preview) => c.service.apply(c.principals.owner, ids.workspace, preview)));
      assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
      const failure = results.find(({ status }) => status === 'rejected');
      assert.equal(failure.reason.status, 409);
      const current = await c.service.workItem(c.principals.owner, ids.workspace, ids.project, ids.work);
      assert.equal(current.version, 2);
      const events = await c.store.read((session) => session.events.list(ids.workspace));
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].after, current);
    });

    test('store transactions roll back mutations and append failures atomically', async (t) => {
      const c = await setup(t);
      const before = await snapshot(c.store);
      const sentinel = new Error('Synthetic transaction failure');
      await assert.rejects(() => c.store.transaction(async (session) => {
        const current = await session.resources.get(ids.workspace, ids.work);
        await session.resources.put({ ...current, version: 2, title: '合成の未確定' }, 1);
        throw sentinel;
      }), (error) => error === sentinel);
      assert.deepEqual(await snapshot(c.store), before);
      let appendAttempts = 0;
      const failingStore = withSessions(c.store, (session) => overridePort(session, {
        events: overridePort(session.events, { append: async () => {
          appendAttempts += 1; throw sentinel;
        } }),
      }), ['transaction']);
      const service = new WorkspaceService({ ...c.dependencies, store: failingStore });
      const preview = await service.preview(c.principals.owner, ids.workspace, c.command());
      await assert.rejects(() => service.apply(c.principals.owner, ids.workspace, preview), (error) => error === sentinel);
      assert.equal(appendAttempts, 1);
      assert.deepEqual(await snapshot(c.store), before, 'CAS update must roll back when history append fails');
      const success = await c.service.apply(c.principals.owner, ids.workspace, preview);
      assert.equal(success.version, 2, 'a failed append must not consume the version or operation ID');
    });

    test('read snapshots and returned records cannot mutate persistent state', async (t) => {
      const c = await setup(t);
      const before = await snapshot(c.store);
      const row = await c.store.read((session) => session.resources.get(ids.workspace, ids.work));
      row.title = '合成の外部改変';
      await assert.rejects(() => c.store.read(async (session) => {
        const original = await session.resources.get(ids.workspace, ids.work);
        await session.resources.put({ ...original, version: 2, title: '合成の読取中改変' }, 1);
      }));
      const projected = await c.service.project(c.principals.owner, ids.workspace, ids.project);
      projected.name = '合成の返却後改変';
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('owner/editor/viewer and identical display names never broaden project scope', async (t) => {
      const c = await setup(t);
      assert.equal((await c.service.projects(c.principals.owner, ids.workspace)).projects.length, 2);
      for (const actor of ['editor', 'viewer']) {
        const visible = await c.service.projects(c.principals[actor], ids.workspace);
        assert.deepEqual(visible.projects.map(({ id }) => id), [ids.project]);
        await c.request(actor, 'GET', projectPath);
        await c.request(actor, 'GET', `${workspacePath}/projects/${ids.hiddenProject}`, undefined, 404);
      }
      await previewApply(c, c.command(), 'editor');
      await rejects(() => c.service.preview(c.principals.viewer, ids.workspace,
        c.command('work_item', 'update', { expected_version: 2 })), 404);
      await rejects(() => c.service.preview(c.principals.editor, ids.workspace, c.command('project', 'create')), 403);
      await rejects(() => c.service.memberships(c.principals.viewer, ids.workspace), 403);
      assert.deepEqual((await c.service.projects(c.principals.outsider, ids.workspace)).projects, []);
      await rejects(() => c.service.preview({ ...c.principals.editor, role: 'owner' }, ids.workspace,
        c.command('project', 'create')), 403);
    });

    test('workspace and parent IDs isolate reads, writes and linked milestones', async (t) => {
      const c = await setup(t);
      await c.request('other_owner', 'GET', projectPath, undefined, 404);
      await c.request('owner', 'GET', `/api/v1/workspaces/${ids.otherWorkspace}`, undefined, 404);
      await c.request('owner', 'GET', `${projectPath}/work-items/${ids.hiddenWork}`, undefined, 404);
      await c.request('owner', 'GET', `${projectPath}/milestones/${ids.hiddenMilestone}`, undefined, 404);
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'update', { id: ids.hiddenWork })), 404);
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'create', { data: workData({ milestone_id: ids.hiddenMilestone }) })), 400);
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'create', { data: workData({ assignee_id: ids.otherOwner }) })), 403);
    });

    test('permission revocation invalidates both pending previews and old replays', async (t) => {
      const c = await setup(t);
      const applied = await previewApply(c, c.command(), 'editor');
      const pending = await c.service.preview(c.principals.editor, ids.workspace,
        c.command('work_item', 'update', { expected_version: 2 }));
      await projectGrant(c, null);
      const before = await snapshot(c.store);
      await rejects(() => c.service.apply(c.principals.editor, ids.workspace, pending), 404);
      await rejects(() => c.service.apply(c.principals.editor, ids.workspace, applied.preview), 404);
      assert.deepEqual(await snapshot(c.store), before);
      await projectGrant(c, 'editor', 2);
      assert.deepEqual(await c.service.apply(c.principals.editor, ids.workspace, applied.preview), applied.result);
    });

    test('preview signatures bind the authenticated member and execution route', async (t) => {
      const c = await setup(t);
      const preview = await c.service.preview(c.principals.owner, ids.workspace, c.command());
      await rejects(() => c.service.apply(c.principals.editor, ids.workspace, preview), 403, 'invalid_preview');
      const cli = new WorkspaceService({ ...c.dependencies, route: 'shared-cli' });
      await rejects(() => cli.apply(c.principals.owner, ids.workspace, preview), 403, 'invalid_preview');
      assert.equal((await c.store.read((session) => session.events.list(ids.workspace))).length, 0);
    });

    test('inactive members are checked again instead of trusting a cached principal', async (t) => {
      const c = await setup(t);
      const preview = await c.service.preview(c.principals.editor, ids.workspace, c.command());
      await c.store.transaction(async (session) => {
        const member = (await session.memberships.list(ids.workspace)).find((record) => record.scope === 'workspace' && record.member_id === ids.editor);
        await session.memberships.put({ ...member, active: false, version: 2 }, 1);
      });
      await rejects(() => c.service.apply(c.principals.editor, ids.workspace, preview), 403);
      await c.request('editor', 'GET', projectPath, undefined, 403);
    });

    test('archive/restore is versioned and cannot restore a child into an archived project', async (t) => {
      const c = await setup(t);
      await previewApply(c, c.command('work_item', 'archive'));
      await previewApply(c, c.command('project', 'archive'));
      const restore = c.command('work_item', 'restore', { expected_version: 2 });
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace, restore), 409, 'invalid_project');
      await previewApply(c, c.command('project', 'restore', { expected_version: 2 }));
      const restored = await previewApply(c, restore);
      assert.equal(restored.result.version, 3);
      assert.equal(restored.result.archived, false);
      assert.deepEqual((await c.service.workItems(c.principals.owner, ids.workspace, ids.project)).items.map(({ id }) => id), [ids.work]);
    });

    test('versioned membership grants keep tombstones, reject stale writes and replay once', async (t) => {
      const c = await setup(t);
      const input = { operation_id: c.op(), expected_version: 0, role: 'viewer', reason: '合成の付与' };
      const added = await c.service.setProjectMembership(c.principals.owner, ids.workspace, ids.project, ids.outsider, input);
      assert.equal(added.version, 1);
      assert.deepEqual(await c.service.setProjectMembership(c.principals.owner, ids.workspace, ids.project, ids.outsider, input), added);
      const revoked = await projectGrant(c, null, 1, ids.outsider);
      assert.equal(revoked.role, null);
      assert.equal(revoked.version, 2);
      await rejects(() => projectGrant(c, 'viewer', 0, ids.outsider), 409, 'version_conflict');
      assert.equal((await projectGrant(c, 'editor', 2, ids.outsider)).version, 3);
      await rejects(() => c.service.setProjectMembership(c.principals.owner, ids.workspace, ids.project, ids.outsider,
        { ...input, role: 'editor' }), 409, 'operation_conflict');
      const source = await sourceGrant(c, false);
      assert.equal(source.version, 2);
      assert.equal(source.allowed, false);
      await rejects(() => sourceGrant(c, true, 0), 409, 'version_conflict');
      assert.equal((await sourceGrant(c, true, 2)).version, 3);
      for (const event of await c.store.read((session) => session.events.list(ids.workspace))) assertApiSchema('Event', event);
      await rejects(() => c.service.setProjectMembership(c.principals.viewer, ids.workspace, ids.project, ids.outsider,
        { ...input, operation_id: c.op() }), 403);
    });

    test('grant downgrade/revocation cannot abandon assigned unfinished work', async (t) => {
      const c = await setup(t);
      const assigned = await previewApply(c, c.command('work_item', 'update', { data: workData({ assignee_id: ids.editor }) }));
      const before = await snapshot(c.store);
      await rejects(() => projectGrant(c, 'viewer'), 409, 'assigned_work_remaining');
      await rejects(() => projectGrant(c, null), 409, 'assigned_work_remaining');
      assert.deepEqual(await snapshot(c.store), before);
      await previewApply(c, c.command('work_item', 'update', { expected_version: assigned.result.version,
        data: workData({ assignee_id: ids.editor, state: '完了' }) }));
      assert.equal((await projectGrant(c, 'viewer')).role, 'viewer');
    });

    test('linked contacts require both project and source permission and an exact explicit link', async (t) => {
      const c = await setup(t);
      const shared = await c.request('viewer', 'GET', contactPath);
      assert.equal(shared.body, contactData().body);
      for (const key of ['sensitive', 'source_path', 'source_hash', 'extra']) assert.ok(!Object.hasOwn(shared, key));
      await c.request('outsider', 'GET', contactPath, undefined, 404);
      await c.request('viewer', 'GET', `${projectPath}/sources/${ids.otherSource}/contacts/${contacts.second}`, undefined, 404);
      await c.request('owner', 'GET', `${projectPath}/sources/${ids.source}/contacts/${contacts.unlinked}`, undefined, 404);
      await c.request('owner', 'GET', `${projectPath}/sources/${ids.foreignSource}/contacts/${contacts.normal}`, undefined, 404);
      await sourceGrant(c, false);
      await c.request('viewer', 'GET', contactPath, undefined, 404);
      await c.request('owner', 'GET', contactPath);
    });

    test('sensitive contacts are entirely indistinguishable from missing records, never copied to events', async (t) => {
      const c = await setup(t);
      const before = await snapshot(c.store);
      const hidden = await c.request('owner', 'GET', `${projectPath}/sources/${ids.source}/contacts/${contacts.sensitive}`, undefined, 404);
      const missing = await c.request('owner', 'GET', `${projectPath}/sources/${ids.source}/contacts/c-20260101-ffffffff`, undefined, 404);
      assert.deepEqual(hidden, missing);
      assert.deepEqual(await snapshot(c.store), before, 'read-only contact retrieval must not create history or copies');
      await previewApply(c, c.command());
      const history = await c.request('owner', 'GET', `${projectPath}/events`);
      const serialized = JSON.stringify(history);
      assert.ok(!serialized.includes(contactData().body));
      assert.ok(!serialized.includes('合成の制限'));
      assert.ok(!serialized.includes('source_path'));
    });

    test('historical source retargeting cannot expose reference or observation events', async (t) => {
      const c = await setup(t);
      const makeEvent = (operation_id, before, after) => ({
        event_kind: 'entity', operation_id, workspace_id: ids.workspace, entity_id: after.id,
        member_id: ids.owner, requester_member_id: ids.owner, route: 'dashboard',
        executor_kind: 'unknown', executor_ref: null, executor_verified: false,
        reason: '合成の参照履歴', at_utc: clockTime, before, after,
        changes: expectedChanges(before, after), request_hash: 'a'.repeat(64),
      });
      await c.store.transaction(async (session) => {
        const initial = await session.resources.get(ids.workspace, ids.reference);
        const hidden = { ...initial, source_id: ids.otherSource, target: contacts.second, version: 2 };
        const visible = { ...initial, version: 3 };
        await session.resources.put(hidden, 1);
        await session.events.append(makeEvent(c.op(), initial, hidden));
        await session.resources.put(visible, 2);
        await session.events.append(makeEvent(c.op(), hidden, visible));
        const observation = entity('observation', uuid(81), { reference_id: ids.reference, status: 'ok',
          last_attempt_at_utc: clockTime, last_success_at_utc: clockTime });
        await session.resources.put(observation, null);
        await session.events.append(makeEvent(c.op(), null, observation));
      });
      const owner = await c.request('owner', 'GET', `${projectPath}/events`);
      assert.equal(owner.events.length, 3);
      assert.deepEqual(await c.request('viewer', 'GET', `${projectPath}/events`), { events: [] });
      await c.service.setSourceMembership(c.principals.owner, ids.workspace, ids.otherSource, ids.viewer,
        { operation_id: c.op(), expected_version: 0, allowed: true, reason: '合成の接続元付与' });
      assert.equal((await c.request('viewer', 'GET', `${projectPath}/events`)).events.length, 3);
      await sourceGrant(c, false);
      assert.deepEqual(await c.request('viewer', 'GET', `${projectPath}/events`), { events: [] });
    });

    test('malformed adapter source/reference records and unverifiable executor metadata fail closed', async (t) => {
      const c = await setup(t);
      const corruptedService = (resourceTransform, eventTransform = (value) => value) => new WorkspaceService({
        ...c.dependencies, store: withSessions(c.store, (session) => overridePort(session, {
            resources: overridePort(session.resources, {
              get: async (...args) => { const value = await session.resources.get(...args); return value ? resourceTransform(value) : null; },
              list: async (...args) => (await session.resources.list(...args)).map(resourceTransform),
            }),
            events: overridePort(session.events, { list: async (...args) => (await session.events.list(...args)).map(eventTransform) }),
          })),
      });
      for (const [target, patch] of [
        [ids.source, { adapter: 'unknown' }], [ids.source, { binding: 'invalid binding' }],
        [ids.reference, { source_id: '' }], [ids.reference, { linked_id: ids.hiddenWork }],
      ]) {
        const broken = corruptedService((row) => row.id === target ? { ...row, ...patch } : row);
        await rejects(() => broken.linkedContact(c.principals.owner, ids.workspace, ids.project, ids.source, contacts.normal), 404);
      }
      await previewApply(c, c.command());
      for (const patch of [
        { executor_kind: 'unknown', executor_verified: true },
        { executor_kind: 'unknown', executor_ref: 'client-claim' },
        { executor_kind: 'ai', executor_verified: true, executor_ref: null },
      ]) {
        const broken = corruptedService((row) => row, (row) => ({ ...row, ...patch }));
        assert.deepEqual(await broken.events(c.principals.owner, ids.workspace, ids.project), { events: [] });
      }
    });

    test('archiving preserves fields even after a parent archive or former assignee deactivation', async (t) => {
      const c = await setup(t);
      const assigned = await previewApply(c, c.command('work_item', 'update', { data: workData({ assignee_id: ids.editor }) }));
      await previewApply(c, c.command('project', 'archive'));
      await c.store.transaction(async (session) => {
        const member = (await session.memberships.list(ids.workspace)).find((record) => record.scope === 'workspace' && record.member_id === ids.editor);
        await session.memberships.put({ ...member, active: false, version: 2 }, 1);
      });
      const archived = await previewApply(c, c.command('work_item', 'archive', { expected_version: assigned.result.version }));
      assert.equal(archived.result.archived, true);
      assert.equal(archived.result.assignee_id, ids.editor);
      assert.equal(archived.result.next_action, assigned.result.next_action);
      await rejects(() => c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'restore', { expected_version: archived.result.version })), 409, 'invalid_project');
    });

    test('malformed workspace/source identities and truthy inactive membership fail closed', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      const command = { operation_id: c.op(), action: 'update', expected_version: 1,
        data: contactData(), reason: '合成の更新' };
      const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, command);
      const before = await snapshot(c.store);
      for (const [wrap, status] of [
        [(session) => overridePort(session, { workspaces: overridePort(session.workspaces, {
          get: async (...args) => ({ ...await session.workspaces.get(...args), workspace_id: ids.otherWorkspace }),
        }) }), 404],
        [(session) => overridePort(session, { resources: overridePort(session.resources, {
          get: async (...args) => { const row = await session.resources.get(...args);
            return row?.id === ids.source ? { ...row, id: ids.otherSource } : row; },
        }) }), 404],
        [(session) => overridePort(session, { resources: overridePort(session.resources, {
          get: async (...args) => { const row = await session.resources.get(...args);
            return row?.id === ids.source ? { ...row, workspace_id: ids.otherWorkspace } : row; },
        }) }), 404],
        [(session) => overridePort(session, { memberships: overridePort(session.memberships, {
          list: async (...args) => (await session.memberships.list(...args)).map((row) =>
            row.scope === 'workspace' && row.member_id === ids.owner ? { ...row, active: 'false' } : row),
        }) }), 403],
      ]) {
        const store = withSessions(c.store, wrap);
        const broken = new ContactLedgerService({ ...c.dependencies, store });
        const workspace = new WorkspaceService({ ...c.dependencies, store });
        await rejects(() => broken.read(c.principals.owner, ids.workspace, ids.source, contacts.normal), status);
        await rejects(() => broken.list(c.principals.owner, ids.workspace, ids.source), status);
        await rejects(() => broken.history(c.principals.owner, ids.workspace, ids.source, contacts.normal), status);
        await rejects(() => broken.preview(c.principals.owner, ids.workspace, ids.source, command), status);
        await rejects(() => broken.apply(c.principals.owner, ids.workspace, ids.source, preview), status);
        await rejects(() => workspace.linkedContact(c.principals.owner, ids.workspace, ids.project, ids.source, contacts.normal), status);
      }
      for (const [workspace, source] of [['invalid', ids.source], [ids.workspace, 'invalid']]) {
        await rejects(() => ledger.read(c.principals.owner, workspace, source, contacts.normal), 400, 'invalid_id');
      }
      await rejects(() => ledger.read({ ...c.principals.owner, active: 'false' }, ids.workspace, ids.source, contacts.normal), 403);
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('numeric UTC offsets are not accepted as IANA workspace timezones', async (t) => {
      const c = await setup(t);
      for (const timezone of ['+01:00', '-05:00', 'NoSuch/Zone']) {
        const store = withSessions(c.store, (session) => overridePort(session, {
          workspaces: overridePort(session.workspaces, {
            get: async (...args) => ({ ...await session.workspaces.get(...args), timezone }),
          }),
        }));
        const service = new WorkspaceService({ ...c.dependencies, store });
        await rejects(() => service.workspace(c.principals.owner, ids.workspace), 400, 'invalid_timezone');
        await rejects(() => service.preview(c.principals.owner, ids.workspace, c.command()), 400, 'invalid_timezone');
      }
      assert.equal((await c.service.workspace(c.principals.owner, ids.workspace)).timezone, 'UTC');
    });

    test('all six contact states survive authorized read-only projection without new states', async (t) => {
      const c = await setup(t);
      let version = 1;
      for (const state of CONTACT_STATES) {
        await c.store.transaction(async (session) => {
          const current = await session.contacts.get(ids.workspace, ids.source, contacts.normal);
          await session.contacts.put({ ...current, version: version + 1, contact: { ...current.contact, state } }, version);
        });
        version += 1;
        assert.equal((await c.request('viewer', 'GET', contactPath)).state, state);
      }
      assert.equal((await c.store.read((session) => session.events.list(ids.workspace))).length, 0);
    });

    test('unknown actor fields, malformed dates, IDs and field types are rejected without writes', async (t) => {
      const c = await setup(t);
      const valid = c.command();
      const invalid = [
        ...['actor', 'member_id', 'requester_member_id', 'executor_kind', 'route'].map((field) => ({ ...valid, [field]: 'client-claim' })),
        ...[true, 0, -1, 1.5, '1', null].map((expected_version) => ({ ...valid, expected_version })),
        { ...valid, operation_id: 'not-a-uuid' }, { ...valid, id: 'not-a-uuid' },
        { ...valid, reason: ' ' }, { ...valid, data: { ...valid.data, check_date: '2025-02-29' } },
        { ...valid, data: { ...valid.data, check_date: '2026-1-01' } },
        { ...valid, data: { ...valid.data, state: '対応中' } },
        { ...valid, data: { ...valid.data, archived: true } },
        { ...valid, data: { ...valid.data, title: 3 } },
        { ...valid, data: { ...valid.data, title: 'a'.repeat(121) } },
        { ...valid, data: { ...valid.data, next_action: 'line\nbreak' } },
        { ...valid, data: { ...valid.data, milestone_id: null } },
      ];
      const missing = clone(valid); delete missing.data.next_action; invalid.push(missing);
      const before = await snapshot(c.store);
      for (const body of invalid) await c.request('owner', 'POST', `${workspacePath}/commands/preview`, body, 400);
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('unauthenticated requests fail every declared route, and account responses contain no secrets', async (t) => {
      const c = await setup(t);
      const replacements = { workspace_id: ids.workspace, project_id: ids.project, milestone_id: ids.milestone,
        work_item_id: ids.work, source_id: ids.source, contact_id: contacts.normal, member_id: ids.viewer };
      for (const entry of operations) {
        const path = entry.path.replace(/\{([^}]+)\}/g, (_, name) => replacements[name]);
        await c.request(null, entry.method, path, entry.method === 'GET' ? undefined : {}, 401);
      }
      const account = await c.request('editor', 'GET', '/api/v1/accounts/me');
      assert.equal(account.subject, c.principals.editor.account_subject);
      assert.deepEqual(Object.keys(account).sort(), ['subject', 'login', 'active', 'revision'].sort());
    });

    test('trusted-owner contact writes preserve all fields, six states and private audit history', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      let current = await ledger.read(c.principals.owner, ids.workspace, ids.source, contacts.normal);
      for (const state of CONTACT_STATES) {
        const command = { operation_id: c.op(), action: 'update', expected_version: current.version,
          data: { ...current.contact, state, extra: { synthetic_header: '合成の未知欄' } }, reason: '合成の状態変更' };
        const before = await snapshot(c.store);
        const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, command);
        assert.deepEqual(await snapshot(c.store), before);
        const updated = await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview);
        assertEntitySchema('contact', updated.contact);
        assert.deepEqual(Object.keys(updated.contact).sort(), Object.keys(contactData()).sort());
        assert.equal(updated.contact.state, state);
        assert.equal(updated.version, current.version + 1);
        assert.equal(updated.contact.created_at, current.contact.created_at);
        assert.deepEqual(updated.contact.extra, command.data.extra);
        const event = await c.store.read((session) => session.contacts.event(ids.workspace, command.operation_id));
        assert.deepEqual(event.before, current);
        assert.deepEqual(event.after, updated);
        assert.deepEqual(event.changes, expectedChanges(current.contact, updated.contact));
        assert.equal(event.requester_member_id, ids.owner);
        assert.equal(event.reason, command.reason);
        assert.equal(event.at_utc, clockTime);
        const after = await snapshot(c.store);
        assert.deepEqual(await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview), updated);
        assert.deepEqual(await snapshot(c.store), after);
        current = updated;
      }
      assert.equal((await ledger.history(c.principals.owner, ids.workspace, ids.source, contacts.normal)).length, CONTACT_STATES.length);
      assert.ok((await ledger.list(c.principals.owner, ids.workspace, ids.source)).some((row) => row.contact.id === contacts.normal));
      assert.deepEqual(await c.service.events(c.principals.owner, ids.workspace, ids.project), { events: [] });
      await c.request('owner', 'POST', contactPath, {}, 404);
    });

    test('contact creation fixes timestamps at preview and apply checks versions and operation reuse', async (t) => {
      const c = await setup(t);
      let now = clockTime;
      const ledger = new ContactLedgerService({ ...c.dependencies, clock: { now: () => now } });
      const id = 'c-20260101-00000005';
      const command = { operation_id: c.op(), action: 'create', expected_version: null,
        data: contactData(id, { created_at: 'legacy', updated_at: 'legacy', due: '合成の未確定日付' }), reason: '合成の登録' };
      const before = await snapshot(c.store);
      const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, command);
      assert.equal(preview.before, null);
      assert.equal(preview.after.contact.created_at, clockTime);
      assert.equal(preview.after.contact.updated_at, clockTime);
      assert.deepEqual(await snapshot(c.store), before);
      now = '2026-01-01T00:01:00Z';
      const created = await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview);
      assert.equal(created.contact.updated_at, clockTime, 'confirmed preview timestamp must stay unchanged');
      assert.equal(created.version, 1);
      const event = await c.store.read((session) => session.contacts.event(ids.workspace, command.operation_id));
      assert.equal(event.at_utc, now);
      assert.deepEqual(event.changes, expectedChanges(null, created.contact));
      await rejects(() => ledger.preview(c.principals.owner, ids.workspace, ids.source,
        { ...command, operation_id: c.op() }), 409, 'duplicate_id');
      const changed = await ledger.preview(c.principals.owner, ids.workspace, ids.source,
        { ...command, action: 'update', expected_version: 1, data: { ...created.contact, note: '合成の別操作' } });
      await rejects(() => ledger.apply(c.principals.owner, ids.workspace, ids.source, changed), 409, 'operation_conflict');
      const next = await ledger.preview(c.principals.owner, ids.workspace, ids.source,
        { ...command, operation_id: c.op(), action: 'update', expected_version: 1, data: created.contact });
      await ledger.apply(c.principals.owner, ids.workspace, ids.source, next);
      await rejects(() => ledger.preview(c.principals.owner, ids.workspace, ids.source,
        { ...next.request, operation_id: c.op() }), 409, 'version_conflict');
      assert.deepEqual(await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview), created);
    });

    test('private contact read/write/history remain owner-only and source-scoped', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      const command = { operation_id: c.op(), action: 'update', expected_version: 1,
        data: contactData(), reason: '合成の更新' };
      const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, command);
      for (const actor of ['editor', 'viewer', 'outsider']) {
        await rejects(() => ledger.read(c.principals[actor], ids.workspace, ids.source, contacts.normal), 403);
        await rejects(() => ledger.list(c.principals[actor], ids.workspace, ids.source), 403);
        await rejects(() => ledger.history(c.principals[actor], ids.workspace, ids.source, contacts.normal), 403);
        await rejects(() => ledger.preview(c.principals[actor], ids.workspace, ids.source, command), 403);
        await rejects(() => ledger.apply(c.principals[actor], ids.workspace, ids.source, preview), 403);
      }
      await rejects(() => ledger.read(c.principals.other_owner, ids.workspace, ids.source, contacts.normal), 404);
      await rejects(() => ledger.apply(c.principals.owner, ids.workspace, ids.otherSource, preview), 403, 'invalid_preview');
      await c.store.transaction(async (session) => {
        const source = await session.resources.get(ids.workspace, ids.source);
        await session.resources.put({ ...source, archived: true, version: 2 }, 1);
      });
      await rejects(() => ledger.apply(c.principals.owner, ids.workspace, ids.source, preview), 404);
      await c.request('owner', 'GET', contactPath, undefined, 404);
    });

    test('private contact records validate returned workspace, source and contact identities', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      const command = { operation_id: c.op(), action: 'update', expected_version: 1,
        data: contactData(), reason: '合成の更新' };
      const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, command);
      const before = await snapshot(c.store);
      for (const [transform, listMustFail, status] of [
        [(row) => ({ ...row, workspace_id: ids.otherWorkspace }), true, 404],
        [(row) => ({ ...row, source_id: ids.otherSource }), true, 404],
        [(row) => ({ ...row, contact: { ...row.contact, id: contacts.second } }), false, 404],
        [(row) => ({ ...row, contact: { ...row.contact, id: 'invalid' } }), true, 400],
      ]) {
        const store = withSessions(c.store, (session) => overridePort(session, {
          contacts: overridePort(session.contacts, {
            get: async (...args) => { const row = await session.contacts.get(...args); return row ? transform(row) : null; },
            list: async (...args) => (await session.contacts.list(...args)).map(transform),
          }),
        }));
        const broken = new ContactLedgerService({ ...c.dependencies, store });
        await rejects(() => broken.read(c.principals.owner, ids.workspace, ids.source, contacts.normal), status);
        if (listMustFail) await rejects(() => broken.list(c.principals.owner, ids.workspace, ids.source), status);
        await rejects(() => broken.preview(c.principals.owner, ids.workspace, ids.source, command), status);
        await rejects(() => broken.apply(c.principals.owner, ids.workspace, ids.source, preview), status);
      }
      assert.deepEqual(await snapshot(c.store), before);
      await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview);
      const applied = await snapshot(c.store);
      for (const [transform, replayStatus] of [
        [(event) => ({ ...event, workspace_id: ids.otherWorkspace }), 404],
        [(event) => ({ ...event, source_id: ids.otherSource }), 409],
        [(event) => ({ ...event, contact_id: contacts.second }), 404],
        [(event) => ({ ...event, before: { ...event.before, source_id: ids.otherSource } }), 404],
        [(event) => ({ ...event, after: { ...event.after, workspace_id: ids.otherWorkspace } }), 404],
        [(event) => ({ ...event, after: { ...event.after, contact: { ...event.after.contact, id: contacts.second } } }), 404],
      ]) {
        const store = withSessions(c.store, (session) => overridePort(session, {
          contacts: overridePort(session.contacts, {
            event: async (...args) => { const row = await session.contacts.event(...args); return row ? transform(row) : null; },
            history: async (...args) => (await session.contacts.history(...args)).map(transform),
          }),
        }));
        const broken = new ContactLedgerService({ ...c.dependencies, store });
        await rejects(() => broken.history(c.principals.owner, ids.workspace, ids.source, contacts.normal), 404);
        await rejects(() => broken.apply(c.principals.owner, ids.workspace, ids.source, preview), replayStatus);
      }
      assert.deepEqual(await snapshot(c.store), applied);
    });

    test('contact timestamps advance at frozen/backwards clocks and retain signed preview stamps', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      for (const [previous, expected] of [
        [clockTime, '2026-01-01T00:00:00.000001Z'],
        ['2026-01-02T23:59:59.999999Z', '2026-01-03T00:00:00.000000Z'],
        ['2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00.000001Z'],
      ]) {
        // Legacy contact timestamps are schema-valid strings, unlike corruption fixtures.
        await c.store.transaction(async (session) => {
          const row = await session.contacts.get(ids.workspace, ids.source, contacts.normal);
          await session.contacts.put({ ...row, version: row.version + 1,
            contact: { ...row.contact, updated_at: previous } }, row.version);
        });
        const row = await ledger.read(c.principals.owner, ids.workspace, ids.source, contacts.normal);
        const preview = await ledger.preview(c.principals.owner, ids.workspace, ids.source, {
          operation_id: c.op(), action: 'update', expected_version: row.version,
          data: { ...row.contact, note: '合成の時刻更新' }, reason: '合成の更新',
        });
        assert.equal(preview.after.contact.updated_at, expected);
        const applied = await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview);
        assert.equal(applied.contact.updated_at, expected);
        assert.deepEqual(await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview), applied);
        const event = await c.store.read((session) => session.contacts.event(ids.workspace, preview.request.operation_id));
        assert.equal(event.after.contact.updated_at, expected);
      }
    });

    test('history orders mixed timestamp precision chronologically in every adapter', async (t) => {
      const c = await setup(t);
      let now = clockTime;
      const dependencies = { ...c.dependencies, clock: { now: () => now } };
      const workspace = new WorkspaceService(dependencies);
      const ledger = new ContactLedgerService(dependencies);
      const workspaceOperations = [];
      const contactOperations = [];
      let version = 1;
      for (const at of ['2026-01-01T00:00:00.1Z', clockTime, '2026-01-01T00:00:00.11Z']) {
        now = at;
        const command = c.command('work_item', 'update', { expected_version: version,
          data: workData({ title: `合成の第${version}版` }) });
        workspaceOperations.push(command.operation_id);
        await workspace.apply(c.principals.owner, ids.workspace,
          await workspace.preview(c.principals.owner, ids.workspace, command));
        const contactCommand = { operation_id: c.op(), action: 'update', expected_version: version,
          data: contactData(contacts.normal, { note: `合成の第${version}版` }), reason: '合成の更新' };
        contactOperations.push(contactCommand.operation_id);
        await ledger.apply(c.principals.owner, ids.workspace, ids.source,
          await ledger.preview(c.principals.owner, ids.workspace, ids.source, contactCommand));
        version++;
      }
      const chronological = (operations) => [operations[1], operations[0], operations[2]];
      const eventIds = (events) => events.map(({ operation_id }) => operation_id);
      assert.deepEqual(eventIds((await workspace.events(c.principals.owner, ids.workspace, ids.project)).events), chronological(workspaceOperations));
      assert.deepEqual(eventIds(await c.store.read((session) => session.events.list(ids.workspace))), chronological(workspaceOperations));
      assert.deepEqual(eventIds(await ledger.history(c.principals.owner, ids.workspace, ids.source, contacts.normal)), chronological(contactOperations));
    });

    test('contact CAS concurrency, append failure and workspace operation IDs remain atomic', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      const command = (overrides = {}) => ({ operation_id: c.op(), action: 'update', expected_version: 1,
        data: contactData(), reason: '合成の更新', ...overrides });
      const previews = await Promise.all(['合成A', '合成B'].map((note) => ledger.preview(c.principals.owner,
        ids.workspace, ids.source, command({ data: contactData(contacts.normal, { note }) }))));
      const results = await Promise.allSettled(previews.map((preview) => ledger.apply(c.principals.owner, ids.workspace, ids.source, preview)));
      assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
      assert.equal(results.find(({ status }) => status === 'rejected').reason.status, 409);
      const before = await snapshot(c.store);
      const sentinel = new Error('Synthetic contact append failure');
      let attempted = 0;
      const failingStore = withSessions(c.store, (session) => overridePort(session, {
        contacts: overridePort(session.contacts, { append: async () => { attempted += 1; throw sentinel; } }),
      }), ['transaction']);
      const failing = new ContactLedgerService({ ...c.dependencies, store: failingStore });
      const preview = await failing.preview(c.principals.owner, ids.workspace, ids.source, command({ expected_version: 2 }));
      await assert.rejects(() => failing.apply(c.principals.owner, ids.workspace, ids.source, preview), (error) => error === sentinel);
      assert.equal(attempted, 1);
      assert.deepEqual(await snapshot(c.store), before);
      const applied = await ledger.apply(c.principals.owner, ids.workspace, ids.source, preview);
      assert.equal(applied.version, 3);
      const collidingWorkspace = await c.service.preview(c.principals.owner, ids.workspace,
        c.command('work_item', 'update', { operation_id: preview.request.operation_id }));
      await rejects(() => c.service.apply(c.principals.owner, ids.workspace, collidingWorkspace), 409, 'operation_conflict');
      const workspace = await previewApply(c, c.command());
      const collidingContact = await ledger.preview(c.principals.owner, ids.workspace, ids.source,
        command({ expected_version: 3, operation_id: workspace.preview.request.operation_id }));
      await rejects(() => ledger.apply(c.principals.owner, ids.workspace, ids.source, collidingContact), 409, 'operation_conflict');
    });

    test('contact commands reject unknown actor fields, invalid states and lossy full-record updates', async (t) => {
      const c = await setup(t);
      const ledger = new ContactLedgerService(c.dependencies);
      const valid = { operation_id: c.op(), action: 'update', expected_version: 1,
        data: contactData(), reason: '合成の更新' };
      const invalid = [
        { ...valid, actor: ids.owner }, { ...valid, expected_version: true },
        { ...valid, expected_version: 0 }, { ...valid, operation_id: 'invalid' },
        { ...valid, data: { ...valid.data, state: '待ち' } },
        { ...valid, data: { ...valid.data, state_inferred: 1 } },
        { ...valid, data: { ...valid.data, extra: { synthetic: 1 } } },
        { ...valid, data: { ...valid.data, body: null } },
        { ...valid, data: { ...valid.data, unknown: '' } },
      ];
      for (const key of Object.keys(contactData())) {
        const data = clone(valid.data); delete data[key]; invalid.push({ ...valid, data });
      }
      const before = await snapshot(c.store);
      for (const value of invalid) await rejects(() => ledger.preview(c.principals.owner, ids.workspace, ids.source, value), 400);
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('HTTP rejects bad origin, foreign host and malformed transport input without leaking exceptions', async (t) => {
      const c = await setup(t);
      const path = `${workspacePath}/commands/preview`;
      const before = await snapshot(c.store);
      await c.request('owner', 'POST', path, c.command(), 403, { origin: 'https://other.example' });
      await c.request('owner', 'POST', path, c.command(), 403, { 'sec-fetch-site': 'cross-site' });
      await c.request('owner', 'POST', path, c.command(), 403, { host: 'other.example' });
      await c.request('owner', 'POST', path, c.command(), 403, { 'sec-fetch-site': 'same-site' });
      await c.request('owner', 'POST', path, c.command(), 403, { 'sec-fetch-site': 'none' });
      for (const [url, headers] of [
        [`https://other.example${path}`, { origin: 'https://other.example' }],
        [`https://deskly.example${path}`, { 'sec-fetch-site': 'same-origin' }],
      ]) {
        const denied = await c.handler(new Request(url, { method: 'POST',
          headers: { 'x-contract-actor': 'owner', 'content-type': 'application/json', ...headers }, body: JSON.stringify(c.command()) }));
        assert.equal(denied.status, 403);
        assertApiSchema('Error', await denied.json());
      }
      await c.request('owner', 'POST', path, c.command(), 400, { 'content-type': 'text/plain' });
      for (const body of ['{', 'x'.repeat(1_048_577)]) {
        const response = await c.handler(new Request(`https://deskly.example${path}`, { method: 'POST',
          headers: { 'x-contract-actor': 'owner', 'content-type': 'application/json',
            host: 'deskly.example', origin: 'https://deskly.example', 'sec-fetch-site': 'same-origin' }, body }));
        assert.equal(response.status, 400);
        assertApiSchema('Error', await response.json());
      }
      const broken = createHttpHandler({ service: c.service, origin: 'https://deskly.example', authenticator: { async authenticate() {
        throw new Error('SYNTHETIC_PRIVATE_ERROR_DETAIL');
      } } });
      const response = await broken(new Request(`https://deskly.example${path}`));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'internal_error' });
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.deepEqual(await snapshot(c.store), before);
    });

    test('409 HTTP conflicts reveal no latest hidden object and preserve unsaved input', async (t) => {
      const c = await setup(t);
      const input = c.command();
      const savedInput = clone(input);
      const stale = await c.request('owner', 'POST', `${workspacePath}/commands/preview`, input);
      await previewApply(c, c.command());
      const conflict = await c.request('owner', 'POST', `${workspacePath}/commands/apply`, stale, 409);
      assertApiSchema('Conflict', conflict);
      assert.deepEqual(Object.keys(conflict), ['error']);
      assert.deepEqual(input, savedInput);
    });

    test('HTTP rejects duplicate decoded keys, excessive nesting and oversized chunked bodies', async (t) => {
      const c = await setup(t);
      const command = c.command();
      const encoded = JSON.stringify(command);
      const path = `${workspacePath}/commands/preview`;
      const before = await snapshot(c.store);
      const headers = { 'x-contract-actor': 'owner', 'content-type': 'application/json',
        host: 'deskly.example', origin: 'https://deskly.example', 'sec-fetch-site': 'same-origin' };
      const rawRequest = async (body, extra = {}) => c.handler(new Request(`https://deskly.example${path}`, {
        method: 'POST', headers: { ...headers, ...extra }, body,
        ...(typeof body === 'string' ? {} : { duplex: 'half' }),
      }));
      for (const body of [
        `{"operation_id":"${command.operation_id}",${encoded.slice(1)}`,
        `{"\\u006fperation_id":"${command.operation_id}",${encoded.slice(1)}`,
        encoded.replace('"state":"未確認"', '"state":"完了","state":"未確認"'),
        encoded.replace('"state":"未確認"', '"st\\u0061te":"完了","state":"未確認"'),
        `{"nested":${'['.repeat(128)}0${']'.repeat(128)}}`,
      ]) {
        const response = await rawRequest(body);
        assert.equal(response.status, 400, body.slice(0, 100));
        const error = await response.json();
        assertApiSchema('Error', error);
        assert.deepEqual(error, { error: 'invalid_json' });
      }
      // Key-looking text inside JSON strings is ordinary data, not an object key.
      const valid = await rawRequest(JSON.stringify({ ...command, reason: '合成 { "state": "state", [ ] }' }));
      assert.equal(valid.status, 200);
      assertApiSchema('CommandPreview', await valid.json());
      for (const extra of [{}, { 'content-length': '1' }]) {
        let cancelled = false;
        const chunk = new TextEncoder().encode(' '.repeat(65_536));
        const stream = new ReadableStream({
          pull(controller) { controller.enqueue(chunk); },
          cancel() { cancelled = true; },
        });
        const response = await rawRequest(stream, extra);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'request_too_large' });
        assert.equal(cancelled, true, 'oversized chunked streams must be cancelled');
      }
      const invalidUtf8 = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])); controller.close();
      } });
      const invalid = await rawRequest(invalidUtf8);
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: 'invalid_json' });
      assert.deepEqual(await snapshot(c.store), before);
    });
  });
}
