import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { WorkspaceService } from '../../.build/service.js';
import { CaseSettingsError, caseLabel, caseSourceName, parseCaseSettingsJson, parseCaseSettingsToml } from '../../.build/case-settings.js';
import { assertApiSchema, assertEntitySchema, spec } from './schema-validation.mjs';
import { clockTime, ids } from './fixtures.mjs';

// The example settings file is the only place sample words live; tests read them from it.
const exampleUrl = new URL('../../config/case-settings.example.toml', import.meta.url);
const exampleText = await readFile(exampleUrl, 'utf8');
export const caseSettings = parseCaseSettingsToml(exampleText);
const settings = caseSettings;
const [bug, request, question] = settings.kinds.values;
const needsApproval = settings.kinds.requires_approval[0];
const free = settings.kinds.values.find((kind) => !settings.kinds.requires_approval.includes(kind));
const [firstTerminal, secondTerminal] = settings.statuses.terminal;
const reopened = settings.statuses.open.find((status) => status !== settings.statuses.initial);
const { hold, initial: pendingApproval, initial_free: freeApproval } = settings.approval_states;
const decided = settings.approval_states.values.find((state) => ![hold, pendingApproval, freeApproval].includes(state));

/** Synthetic sending apps; prefixes and tenants are placeholders, never real systems. */
export const appFixtures = Object.freeze({
  app_one: { kind: 'app', workspace_id: ids.workspace, app: 'app_one', sources: ['app_one'], tenants: ['tenant_a'] },
  app_one_b: { kind: 'app', workspace_id: ids.workspace, app: 'app_one_b', sources: ['app_one'], tenants: ['tenant_b'] },
  app_one_multi: { kind: 'app', workspace_id: ids.workspace, app: 'app_one_multi', sources: ['app_one'], tenants: ['tenant_a', 'tenant_b'] },
  app_two: { kind: 'app', workspace_id: ids.workspace, app: 'app_two', sources: ['app_two'], tenants: ['*'] },
  operator: { kind: 'app', workspace_id: ids.workspace, app: 'operator_console', sources: ['*'], tenants: ['*'] },
  foreign: { kind: 'app', workspace_id: ids.otherWorkspace, app: 'app_one', sources: ['app_one'], tenants: ['*'] },
});

const workspace = `/api/v1/workspaces/${ids.workspace}`;
const cases = `${workspace}/cases`;
const casePath = (number, rest = '') => `${cases}/${number}${rest}`;
const newCase = (overrides = {}) => ({ origin: 'human', kind: bug, title: '合成の受付', body: '合成の本文\n二行目 ',
  reporter_ref: 'u-synthetic-1', place: { screen_id: 'synthetic-screen', feature_id: 'save', environment: 'production',
    version: '0.0.1', url: 'https://app.example.com/synthetic' }, fingerprint: null, legacy_ref: null, promised_due: null, ...overrides });
const send = (c, app, method, path, body, status = 200) => c.request(null, method, path, body, status, { 'x-contract-app': app });
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
const withCases = (store, transform) => facade(store, Object.fromEntries(['read', 'transaction'].map((mode) =>
  [mode, (run) => store[mode]((session) => run(transform(session)))])));
/** Every case row and child row of both synthetic workspaces, through public ports only. */
async function caseSnapshot(store) {
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
const create = async (c, app = 'app_one', overrides = {}) => {
  const created = await send(c, app, 'POST', cases, newCase(overrides));
  assertApiSchema('CaseCreated', created);
  return created;
};
const read = (c, number, app = 'operator') => send(c, app, 'GET', casePath(number));

/** Exercise every case operation once for the shared OpenAPI coverage test. */
export async function exerciseCaseOperations(c) {
  const { number } = await create(c);
  await send(c, 'app_one', 'GET', cases);
  await send(c, 'app_one', 'GET', `${cases}/panels`);
  const { case: current } = await read(c, number, 'app_one');
  await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: current.revision, status: reopened });
  await send(c, 'app_one', 'POST', casePath(number, '/people'), { reporter_ref: 'u-synthetic-2' });
  await send(c, 'app_one', 'POST', casePath(number, '/replies'), { body: '合成の返事' });
  await send(c, 'app_one', 'POST', casePath(number, '/links'), { link_type: 'commit', ref: 'a'.repeat(40) });
}

/** Added unchanged to runContractSuite; every adapter (memory, SQLite, D1) runs every case test. */
export function registerCaseApiTests(setup) {
  const caseTest = (name, run) => test(name, async (t) => run(await setup(t), t));

  test('case settings load from TOML or the same JSON shape and stop startup on any inconsistency', async () => {
    assert.ok(settings.kinds.values.length > 0 && settings.statuses.values.length > 0);
    assert.ok(settings.statuses.open.includes(settings.statuses.initial));
    assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings.statuses.values));
    assert.deepEqual(parseCaseSettingsJson(JSON.stringify(settings)), settings);
    for (const status of settings.statuses.values) assert.ok(['us', 'them', 'none'].includes(settings.statuses.waiting[status]));
    // Labels are display only; an unknown language or identifier shows the identifier itself.
    for (const language of Object.keys(settings.labels)) {
      for (const [identifier, label] of Object.entries(settings.labels[language])) {
        assert.equal(caseLabel(settings, language, identifier), label);
        assert.notEqual(label, identifier);
      }
    }
    assert.equal(caseLabel(settings, 'zz', bug), bug);
    assert.equal(caseLabel(settings, Object.keys(settings.labels)[0], 'synthetic_unlabeled'), 'synthetic_unlabeled');
    for (const [source, name] of Object.entries(settings.numbering.display_names)) assert.equal(caseSourceName(settings, source), name);
    assert.equal(caseSourceName(settings, 'synthetic_unnamed'), 'synthetic_unnamed');

    const document = JSON.parse(JSON.stringify(settings));
    const broken = (mutate) => { const copy = structuredClone(document); mutate(copy); return JSON.stringify(copy); };
    for (const [text, pattern] of [
      [broken((d) => { d.database = { max_total_bytes: 0 }; }), /unknown key database/],
      [broken((d) => { d.kinds.extra = []; }), /unknown key kinds\.extra/],
      [broken((d) => { delete d.statuses.initial; }), /missing key statuses\.initial/],
      [broken((d) => { d.statuses.initial = d.statuses.terminal[0]; }), /statuses\.initial/],
      [broken((d) => { d.statuses.open.push(d.statuses.terminal[0]); }), /exactly one/],
      [broken((d) => { d.statuses.terminal.pop(); }), /exactly one/],
      [broken((d) => { delete d.statuses.waiting[d.statuses.values[0]]; }), /missing key statuses\.waiting/],
      [broken((d) => { d.statuses.waiting[d.statuses.values[0]] = 'someone'; }), /statuses\.waiting/],
      [broken((d) => { d.kinds.requires_approval = ['synthetic_missing']; }), /kinds\.requires_approval/],
      [broken((d) => { d.kinds.values.push(d.kinds.values[0]); }), /must not repeat/],
      [broken((d) => { d.kinds.values = []; }), /must not be empty/],
      [broken((d) => { d.kinds.values[0] = 'Upper Case'; }), /identifier/],
      [broken((d) => { d.approval_states.hold = 'synthetic_missing'; }), /approval_states\.hold/],
      [broken((d) => { d.labels.ja = { synthetic_missing: '合成' }; }), /labels\.ja\.synthetic_missing/],
      [broken((d) => { d.labels['not a language'] = {}; }), /language/],
      [broken((d) => { d.labels.en[d.kinds.values[0]] = ' '; }), /labels\.en/],
      [broken((d) => { d.numbering.display_names = { 'Bad Prefix': '合成' }; }), /source prefix/],
      ['{', /JSON syntax/],
    ]) assert.throws(() => parseCaseSettingsJson(text), (error) => error instanceof CaseSettingsError && pattern.test(error.message));
    for (const [text, pattern] of [
      [`${exampleText}\n[kinds]\nvalues = ["x"]\n`, /line \d+: key kinds is already defined/],
      [exampleText.replace('[kinds]', '[kinds]\nvalues = ["a"]'), /already defined/],
      [`${exampleText}\n[attachments]\nmax_total_bytes = 0\n`, /unknown key attachments/],
      [`${exampleText}\n[[apps]]\nname = "x"\n`, /arrays of tables/],
      ['[kinds]\nvalues = 1.5\n', /line 2: unsupported value 1\.5/],
      ['[kinds]\nvalues = ["a\n', /unterminated string/],
      ['[kinds]\nvalues = """a"""\n', /multi-line/],
      ['[kinds] trailing\n', /end of line/],
    ]) assert.throws(() => parseCaseSettingsToml(text), (error) => error instanceof CaseSettingsError && pattern.test(error.message));
    // Different organizations use entirely different identifiers; nothing is built in.
    const custom = parseCaseSettingsToml([
      '[kinds]', 'values = ["alpha", "beta"]', 'requires_approval = []',
      '[statuses]', 'values = [\'open_a\', "closed_z"]', 'open = ["open_a"]', 'terminal = ["closed_z"]', 'initial = "open_a"',
      'waiting = { open_a = "us", "closed_z" = "none" }',
      '[approval_states]', 'values = ["free_x", "hold_y"] # comment', 'initial = "hold_y"', 'initial_free = "free_x"', 'hold = "hold_y"',
      '[labels."en-GB"]', 'alpha = "A \\u00e9"',
    ].join('\r\n'));
    assert.deepEqual(custom.statuses.values, ['open_a', 'closed_z']);
    assert.equal(custom.labels['en-GB'].alpha, 'A é');
    assert.throws(() => new WorkspaceService({ store: null, clock: null, ids: null, signer: null,
      caseSettings: { kinds: {} } }), CaseSettingsError, 'invalid settings stop service construction');
  });

  test('case code and case schemas contain no configured identifier or display word', async () => {
    const words = new Set([...settings.kinds.values, ...settings.statuses.values, ...settings.approval_states.values,
      ...Object.values(settings.labels).flatMap((labels) => Object.values(labels)),
      ...Object.keys(settings.numbering.display_names), ...Object.values(settings.numbering.display_names)]);
    const sources = new URL('../../src/', import.meta.url);
    const schemas = new URL('../../../schema/', import.meta.url);
    const files = [
      ...(await readdir(sources)).filter((name) => /^case-.*\.ts$/.test(name)).map((name) => new URL(name, sources)),
      ...(await readdir(schemas)).filter((name) => /^case.*\.schema\.json$/.test(name)).map((name) => new URL(name, schemas)),
    ];
    assert.ok(files.length >= 8);
    const caseComponents = JSON.stringify(Object.fromEntries(Object.entries(spec.components.schemas).filter(([name]) => /Case/.test(name))));
    for (const [label, content] of [...await Promise.all(files.map(async (file) => [file.pathname, await readFile(file, 'utf8')])),
      ['openapi case components', caseComponents]]) {
      for (const word of words) {
        for (const quote of ["'", '"', '`']) assert.ok(!content.includes(`${quote}${word}${quote}`), `${label} hard-codes ${word}`);
      }
    }
  });

  caseTest('the ledger issues consecutive numbers per source, initial values from settings and a creation event', async (c) => {
    const first = await create(c);
    assert.deepEqual(first, { number: 'app_one-1', status: settings.statuses.initial });
    assert.equal((await create(c, 'app_one', { kind: needsApproval })).number, 'app_one-2');
    assert.equal((await create(c, 'app_two', { kind: question })).number, 'app_two-1');
    assert.equal((await create(c)).number, 'app_one-3');
    const detail = await read(c, 'app_one-1', 'app_one');
    assertApiSchema('CaseDetail', detail);
    assertEntitySchema('case', detail.case);
    const sent = newCase();
    assert.deepEqual(detail.case, { workspace_id: ids.workspace, number: 'app_one-1', source: 'app_one', tenant_ref: 'tenant_a',
      seq: 1, origin: 'human', kind: bug, status: settings.statuses.initial, approval_state: freeApproval,
      title: sent.title, body: sent.body, reporter_ref: sent.reporter_ref, ...sent.place, fingerprint: null,
      promised_due: null, hold_until: null, closed_at: null, duplicate_of: null, legacy_ref: null, revision: 1,
      created_at: clockTime, updated_at: clockTime });
    assert.deepEqual(detail.events, [{ workspace_id: ids.workspace, case_number: 'app_one-1', seq: 1, action: 'create',
      actor: { kind: 'app', app: 'app_one' }, actor_ref: null, reason: null, at_utc: clockTime, changes: [
        { field: 'status', before: null, after: settings.statuses.initial },
        { field: 'approval_state', before: null, after: freeApproval }] }]);
    assert.equal((await read(c, 'app_one-2')).case.approval_state, pendingApproval);
    assert.equal((await read(c, 'app_two-1')).case.tenant_ref, null, 'a ["*"] tenant scope stores no tenant');
    // Detected cases carry a fingerprint and no reporter; the same fingerprint is never merged.
    const detected = { origin: 'detected', reporter_ref: null, fingerprint: 'f'.repeat(64) };
    const one = await create(c, 'app_two', detected);
    const two = await create(c, 'app_two', detected);
    assert.notEqual(one.number, two.number);
    for (const body of [{ origin: 'detected' }, { fingerprint: 'f'.repeat(64) }]) {
      errorOnly(await send(c, 'app_two', 'POST', cases, newCase(body), 400));
    }
  });

  caseTest('concurrent creation issues distinct consecutive numbers and a failed write issues none', async (c) => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      create(c, index % 2 ? 'app_one' : 'app_two', { title: `合成の並行 ${index}` })));
    for (const source of ['app_one', 'app_two']) {
      const seqs = results.map(({ number }) => number).filter((number) => number.startsWith(`${source}-`))
        .map((number) => Number(number.slice(source.length + 1))).sort((a, b) => a - b);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    }
    assert.equal((await send(c, 'operator', 'GET', cases)).items.length, 12);
    const before = await caseSnapshot(c.store);
    const sentinel = new Error('Synthetic case event failure');
    const failing = new WorkspaceService({ ...c.dependencies, store: withCases(c.store, (session) => facade(session, {
      cases: facade(session.cases, { appendEvent: async () => { throw sentinel; } }),
    })) });
    await assert.rejects(() => failing.cases.create(c.apps.app_one, ids.workspace, newCase()), (error) => error === sentinel);
    assert.deepEqual(await caseSnapshot(c.store), before, 'no case, number or event exists unless the whole write succeeded');
    assert.equal((await create(c)).number, 'app_one-7');
  });

  caseTest('(source, legacy_ref) never creates a second case, even when sent concurrently', async (c) => {
    const first = await create(c, 'app_one', { legacy_ref: '1042' });
    assert.deepEqual(await create(c, 'app_one', { legacy_ref: '1042', title: '合成の書き直し' }), first);
    const racing = await Promise.all([1, 2, 3].map(() => create(c, 'app_one_multi', { legacy_ref: '2001', tenant_ref: 'tenant_b' })));
    assert.equal(new Set(racing.map(({ number }) => number)).size, 1);
    assert.notEqual((await create(c, 'app_two', { legacy_ref: '1042' })).number, first.number, 'another source has its own legacy IDs');
    const rows = (await send(c, 'operator', 'GET', cases)).items;
    assert.equal(rows.filter((row) => row.legacy_ref === '1042').length, 2);
    assert.equal(rows.length, 3);
    assert.equal((await read(c, first.number)).case.title, newCase().title, 'the resend does not rewrite what was stored');
    assert.equal((await read(c, first.number)).events.length, 1);
    // The tenant_b sender cannot learn tenant_a's case through the duplicate.
    errorOnly(await send(c, 'app_one_b', 'POST', cases, newCase({ legacy_ref: '1042' }), 409), 'duplicate_id');
  });

  caseTest('unknown kinds, statuses, approval states, fields and over-long titles are rejected without writes', async (c) => {
    const { number } = await create(c);
    const before = await caseSnapshot(c.store);
    const exact = '題'.repeat(200);
    for (const [body, code] of [
      [newCase({ kind: 'synthetic_unknown' }), 'invalid_kind'],
      [newCase({ kind: caseLabel(settings, 'ja', bug) }), 'invalid_kind'],
      [newCase({ title: `${exact}x` }), 'title_too_long'],
      [newCase({ title: ' ' }), 'required_field'],
      [newCase({ title: 'line\nbreak' }), 'invalid_field'],
      [newCase({ origin: 'synthetic' }), 'invalid_origin'],
      [newCase({ source: 'app_two' }), 'invalid_fields'],
      [newCase({ number: 'app_one-99' }), 'invalid_fields'],
      [newCase({ status: settings.statuses.terminal[0] }), 'invalid_fields'],
      [newCase({ promised_due: '2026-02-30' }), 'invalid_date'],
      [newCase({ reporter_ref: '' }), 'required_field'],
      [newCase({ place: { screen_id: 'x', unknown: 'y' } }), 'invalid_fields'],
      [newCase({ place: { url: 'javascript:alert(1)' } }), 'invalid_url'],
    ]) errorOnly(await send(c, 'app_one', 'POST', cases, body, 400), code);
    for (const [body, code] of [
      [{ expected_revision: 1, status: 'synthetic_unknown' }, 'invalid_status'],
      [{ expected_revision: 1, status: caseLabel(settings, 'en', firstTerminal) }, 'invalid_status'],
      [{ expected_revision: 1, approval_state: 'synthetic_unknown' }, 'invalid_approval_state'],
      [{ expected_revision: 1 }, 'no_changes'],
      [{ expected_revision: 1, title: '合成の改題' }, 'invalid_fields'],
      [{ expected_revision: 1, closed_at: clockTime }, 'invalid_fields'],
      [{ status: firstTerminal }, 'required_field'],
      [{ expected_revision: true, status: firstTerminal }, 'invalid_version'],
    ]) errorOnly(await send(c, 'app_one', 'PATCH', casePath(number), body, 400), code);
    assert.deepEqual(await caseSnapshot(c.store), before);
    const stored = await create(c, 'app_one', { title: ` ${exact.slice(2)} ` });
    assert.equal((await read(c, stored.number)).case.title, ` ${exact.slice(2)} `, 'titles are stored exactly, not trimmed');
    assert.equal((await read(c, stored.number)).case.body, newCase().body, 'bodies are stored exactly');
  });

  caseTest('closed_at follows terminal statuses, unchanged PATCH writes nothing and every change appends one event', async (c) => {
    const { number } = await create(c);
    const later = '2026-01-02T03:04:05Z';
    c.clock.time = later;
    const closed = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, status: firstTerminal,
      reason: '合成の完了理由', actor_ref: 'u-synthetic-admin' });
    assertEntitySchema('case', closed);
    assert.equal(closed.closed_at, later);
    assert.equal(closed.revision, 2);
    assert.equal(closed.updated_at, later);
    c.clock.time = '2026-01-03T00:00:00Z';
    const other = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 2, status: secondTerminal });
    assert.equal(other.closed_at, later, 'moving between terminal statuses keeps the original closed_at');
    const unchanged = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 3, status: secondTerminal });
    assert.deepEqual(unchanged, other);
    const reopenedCase = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 3, status: reopened });
    assert.equal(reopenedCase.closed_at, null, 'reopening clears closed_at');
    const { events } = await read(c, number);
    for (const event of events) assertEntitySchema('case_event', event);
    assert.deepEqual(events.map(({ seq, action }) => [seq, action]), [[1, 'create'], [2, 'update'], [3, 'update'], [4, 'update']]);
    assert.deepEqual(events[1].changes, [{ field: 'status', before: settings.statuses.initial, after: firstTerminal },
      { field: 'closed_at', before: null, after: later }]);
    assert.equal(events[1].reason, '合成の完了理由');
    assert.equal(events[1].actor_ref, 'u-synthetic-admin');
    assert.deepEqual(events[2].changes, [{ field: 'status', before: firstTerminal, after: secondTerminal }]);
    assert.deepEqual(events[3].changes, [{ field: 'status', before: secondTerminal, after: reopened },
      { field: 'closed_at', before: later, after: null }]);
    // Append-only: later writes never change earlier events, including through a member owner.
    const owner = await c.request('owner', 'PATCH', casePath(number), { expected_revision: 4, promised_due: '2026-02-01' });
    assert.equal(owner.promised_due, '2026-02-01');
    const after = (await read(c, number)).events;
    assert.deepEqual(after.slice(0, 4), events);
    assert.deepEqual(after[4].actor, { kind: 'member', member_id: ids.owner });
    assert.deepEqual(after[4].changes, [{ field: 'promised_due', before: null, after: '2026-02-01' }]);
  });

  caseTest('hold_until exists only in the configured hold state and approval applies only to kinds that need it', async (c) => {
    const { number } = await create(c, 'app_one', { kind: needsApproval });
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, hold_until: '2026-03-01' }, 400), 'hold_until_requires_hold');
    const held = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, approval_state: hold, hold_until: '2026-03-01' });
    assert.equal(held.hold_until, '2026-03-01');
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 2, approval_state: decided }, 400), 'hold_until_requires_hold');
    const released = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 2, approval_state: decided, hold_until: null });
    assert.equal(released.hold_until, null);
    assert.deepEqual((await read(c, number)).events.at(-1).changes, [{ field: 'approval_state', before: hold, after: decided },
      { field: 'hold_until', before: '2026-03-01', after: null }]);
    const plain = await create(c, 'app_one', { kind: free });
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(plain.number), { expected_revision: 1, approval_state: pendingApproval }, 400), 'approval_not_required');
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(plain.number), { expected_revision: 1, approval_state: hold, hold_until: '2026-03-01' }, 400), 'approval_not_required');
  });

  caseTest('links and people are unique, replies append, and delivery is separate from saving', async (c) => {
    const { number } = await create(c);
    const commit = { link_type: 'commit', ref: '0123456789abcdef0123456789abcdef01234567' };
    const first = await send(c, 'app_one', 'POST', casePath(number, '/links'), commit);
    assertEntitySchema('case_link', first);
    assert.deepEqual(await send(c, 'app_one', 'POST', casePath(number, '/links'), commit), first);
    await send(c, 'app_one', 'POST', casePath(number, '/links'), { link_type: 'doc', ref: commit.ref });
    await send(c, 'app_one', 'POST', casePath(number, '/links'), { link_type: 'url', ref: 'https://docs.example.com/synthetic' });
    for (const link of [{ link_type: 'commit', ref: 'XYZ' }, { link_type: 'commit', ref: 'ABCDEF0' },
      { link_type: 'url', ref: 'ftp://example.com/x' }, { link_type: 'issue', ref: '1' }, { link_type: 'doc', ref: 'two words' }]) {
      errorOnly(await send(c, 'app_one', 'POST', casePath(number, '/links'), link, 400));
    }
    const person = await send(c, 'app_one', 'POST', casePath(number, '/people'), { reporter_ref: 'u-synthetic-2' });
    assertEntitySchema('case_person', person);
    assert.deepEqual(await send(c, 'app_one', 'POST', casePath(number, '/people'), { reporter_ref: 'u-synthetic-2' }), person);
    const saved = await send(c, 'app_one', 'POST', casePath(number, '/replies'), { body: '合成の返事', author_ref: 'u-synthetic-admin' });
    assert.equal(saved.delivered_at, null, 'saving a reply is not delivering it');
    const delivered = await send(c, 'app_one', 'POST', casePath(number, '/replies'),
      { body: '合成の返事', delivered_at: '2026-01-01T00:00:01Z' });
    assert.deepEqual([saved.seq, delivered.seq], [1, 2]);
    for (const reply of [saved, delivered]) assertEntitySchema('case_reply', reply);
    for (const reply of [{ body: '' }, { body: 'x', delivered_at: '2026-01-01T09:00:00+09:00' }, { body: 'x', author: 'u' }]) {
      errorOnly(await send(c, 'app_one', 'POST', casePath(number, '/replies'), reply, 400));
    }
    const detail = await read(c, number);
    assert.equal(detail.links.length, 3);
    assert.equal(detail.people.length, 1);
    assert.equal(detail.replies.length, 2);
    assert.equal(detail.case.revision, 1, 'children do not rewrite the case row');
  });

  caseTest('app scopes cut source and tenant on every read and write; only owners among members may use cases', async (c) => {
    const a = (await create(c, 'app_one')).number;
    const b = (await create(c, 'app_one_b')).number;
    const two = (await create(c, 'app_two')).number;
    const visible = async (app) => (await send(c, app, 'GET', cases)).items.map(({ number }) => number);
    assert.deepEqual(await visible('app_one'), [a]);
    assert.deepEqual(await visible('app_one_b'), [b]);
    assert.deepEqual(await visible('app_one_multi'), [a, b]);
    assert.deepEqual(await visible('app_two'), [two]);
    assert.deepEqual(await visible('operator'), [a, b, two]);
    assert.deepEqual((await c.request('owner', 'GET', cases)).items.map(({ number }) => number), [a, b, two]);
    const before = await caseSnapshot(c.store);
    for (const [app, hidden] of [['app_one', b], ['app_one', two], ['app_one_b', a], ['app_two', a]]) {
      const missing = await send(c, app, 'GET', casePath(hidden), undefined, 404);
      assert.deepEqual(missing, await send(c, app, 'GET', casePath('app_one-999'), undefined, 404), 'hidden equals absent');
      errorOnly(await send(c, app, 'PATCH', casePath(hidden), { expected_revision: 1, status: firstTerminal }, 404), 'not_found');
      errorOnly(await send(c, app, 'POST', casePath(hidden, '/people'), { reporter_ref: 'u-x' }, 404), 'not_found');
      errorOnly(await send(c, app, 'POST', casePath(hidden, '/replies'), { body: 'x' }, 404), 'not_found');
      errorOnly(await send(c, app, 'POST', casePath(hidden, '/links'), { link_type: 'doc', ref: 'x' }, 404), 'not_found');
    }
    errorOnly(await send(c, 'app_one', 'POST', cases, newCase({ tenant_ref: 'tenant_b' }), 403), 'forbidden');
    errorOnly(await send(c, 'app_one_multi', 'POST', cases, newCase(), 400), 'tenant_required');
    errorOnly(await send(c, 'operator', 'POST', cases, newCase(), 403), 'source_not_fixed');
    errorOnly(await c.request('owner', 'POST', cases, newCase(), 403), 'source_not_fixed');
    errorOnly(await send(c, 'foreign', 'GET', cases, undefined, 404));
    errorOnly(await send(c, 'foreign', 'POST', cases, newCase(), 404));
    for (const actor of ['editor', 'viewer', 'outsider']) {
      c.principals[actor].role = 'owner'; // An asserted role cannot replace a persisted owner.
      errorOnly(await c.request(actor, 'GET', cases, undefined, 403));
      errorOnly(await c.request(actor, 'GET', casePath(a), undefined, 403));
      errorOnly(await c.request(actor, 'PATCH', casePath(a), { expected_revision: 1, status: firstTerminal }, 403));
      errorOnly(await c.request(actor, 'POST', casePath(a, '/links'), { link_type: 'doc', ref: 'x' }, 403));
    }
    errorOnly(await c.request('other_owner', 'GET', cases, undefined, 404));
    assert.deepEqual(await caseSnapshot(c.store), before);
    // Apps never authenticate member routes, and malformed app scopes are unauthenticated.
    errorOnly(await send(c, 'operator', 'GET', `${workspace}/projects`, undefined, 401));
    for (const sources of [['*', 'app_one'], [], ['Bad Prefix']]) {
      c.apps.operator.sources = sources;
      errorOnly(await send(c, 'operator', 'GET', cases, undefined, 401));
    }
    errorOnly(await send(c, 'app_one', 'GET', `${cases}?tenant_ref=tenant_b`, undefined, 400));
  });

  caseTest('stale revisions return a bare 409 and concurrent updates admit exactly one', async (c) => {
    const { number } = await create(c);
    const results = await Promise.allSettled([firstTerminal, reopened].map((status) =>
      c.service.cases.update(c.apps.app_one, ids.workspace, number, { expected_revision: 1, status })));
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const failure = results.find(({ status }) => status === 'rejected').reason;
    assert.equal(failure.status, 409);
    assert.equal(failure.code, 'version_conflict');
    const before = await caseSnapshot(c.store);
    const conflict = await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, status: settings.statuses.initial }, 409);
    assertApiSchema('Conflict', conflict);
    assert.deepEqual(conflict, { error: 'version_conflict' });
    assert.deepEqual(await caseSnapshot(c.store), before);
    assert.equal((await read(c, number)).events.length, 2);
  });

  caseTest('cases cannot be deleted: no route, no port method and no field removes one', async (c) => {
    const { number } = await create(c);
    errorOnly(await send(c, 'app_one', 'DELETE', casePath(number), undefined, 404), 'not_found');
    errorOnly(await c.request('owner', 'DELETE', casePath(number), undefined, 404), 'not_found');
    assert.ok(!Object.values(spec.paths).some((item) => Object.hasOwn(item, 'delete')));
    const methods = await c.store.read(async (session) => {
      const names = new Set();
      for (let value = session.cases; value && value !== Object.prototype; value = Object.getPrototypeOf(value)) {
        for (const name of Object.getOwnPropertyNames(value)) names.add(name);
      }
      return [...names];
    });
    assert.ok(!methods.some((name) => /delete|remove|drop|purge|clear/i.test(name)), methods.join(','));
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, deleted: true }, 400));
    // Withdrawn cases stay, marked by a terminal status.
    await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, status: secondTerminal });
    assert.equal((await read(c, number)).case.status, secondTerminal);
    assert.equal((await send(c, 'app_one', 'GET', cases)).items.length, 1);
  });

  caseTest('every stored time is UTC and a non-UTC clock or delivery time is rejected without writing', async (c) => {
    const { number } = await create(c);
    const detail = await read(c, number);
    for (const value of [detail.case.created_at, detail.case.updated_at, detail.events[0].at_utc]) assert.match(value, /Z$/);
    const before = await caseSnapshot(c.store);
    c.clock.time = '2026-01-01T09:00:00+09:00';
    errorOnly(await send(c, 'app_one', 'POST', cases, newCase(), 400), 'invalid_timestamp');
    errorOnly(await send(c, 'app_one', 'PATCH', casePath(number), { expected_revision: 1, status: firstTerminal }, 400), 'invalid_timestamp');
    errorOnly(await send(c, 'app_one', 'POST', casePath(number, '/people'), { reporter_ref: 'u-x' }, 400), 'invalid_timestamp');
    assert.deepEqual(await caseSnapshot(c.store), before);
    c.clock.time = clockTime;
    errorOnly(await send(c, 'app_one', 'POST', casePath(number, '/replies'), { body: 'x', delivered_at: '2026-01-01T00:00:00' }, 400), 'invalid_timestamp');
  });

  caseTest('without settings or a CasePort every case operation fails closed', async (c) => {
    const { number } = await create(c);
    const withoutSettings = new WorkspaceService({ ...c.dependencies, caseSettings: undefined });
    const withoutPort = new WorkspaceService({ ...c.dependencies,
      store: withCases(c.store, (session) => facade(session, { cases: undefined })) });
    for (const service of [withoutSettings, withoutPort]) {
      for (const run of [
        () => service.cases.list(c.apps.operator, ids.workspace),
        () => service.cases.read(c.apps.operator, ids.workspace, number),
        () => service.cases.create(c.apps.app_one, ids.workspace, newCase()),
        () => service.cases.update(c.apps.app_one, ids.workspace, number, { expected_revision: 1, status: firstTerminal }),
        () => service.cases.addLink(c.apps.app_one, ids.workspace, number, { link_type: 'doc', ref: 'x' }),
      ]) await rejects(run, 404, 'cases_not_enabled');
    }
    assert.equal((await read(c, number)).case.revision, 1);
  });
}
