// Synthetic records for every adapter; no real home, account, or service is read.
export const uuid = (number) => `00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
export const ids = Object.freeze({
  workspace: uuid(1), otherWorkspace: uuid(2), owner: uuid(11), editor: uuid(12),
  viewer: uuid(13), outsider: uuid(14), otherOwner: uuid(21),
  project: uuid(31), hiddenProject: uuid(32), otherProject: uuid(33),
  milestone: uuid(41), hiddenMilestone: uuid(42), work: uuid(51), hiddenWork: uuid(52),
  source: uuid(61), otherSource: uuid(62), foreignSource: uuid(63),
  reference: uuid(71), hiddenReference: uuid(72), secondReference: uuid(73), sensitiveReference: uuid(74),
});
export const contacts = Object.freeze({ normal: 'c-20260101-00000001', second: 'c-20260101-00000002',
  sensitive: 'c-20260101-00000003', unlinked: 'c-20260101-00000004' });
export const clockTime = '2026-01-01T00:00:00Z';
export const principalFixtures = Object.freeze(Object.fromEntries([
  ['owner', ids.owner, ids.workspace, 'owner', uuid(101)],
  ['editor', ids.editor, ids.workspace, 'member', uuid(102)],
  ['viewer', ids.viewer, ids.workspace, 'member', uuid(103)],
  ['outsider', ids.outsider, ids.workspace, 'member', uuid(104)],
  ['other_owner', ids.otherOwner, ids.otherWorkspace, 'owner', uuid(105)],
].map(([name, member_id, workspace_id, role, account_subject]) => [name,
  { workspace_id, member_id, role, active: true, account_subject }])));

export const projectData = (overrides = {}) => ({
  name: '合成案件', purpose: '合成の目的', owner_id: ids.owner, state: '進行中', ...overrides,
});
export const milestoneData = (overrides = {}) => ({
  goal: '合成目標', acceptance: '合成の完了条件', assignee_id: ids.owner,
  check_date: '', state: '未確認', ...overrides,
});
export const workData = (overrides = {}) => ({
  kind: '開発', title: '合成作業', assignee_id: ids.owner, next_action: '合成確認',
  check_date: '2026-02-28', waiting_reason: '', state: '未確認', milestone_id: ids.milestone,
  ...overrides,
});
export const contactData = (id = contacts.normal, overrides = {}) => ({
  id, state: '下書き', state_inferred: false, project: '同じ表示名でも結合しない',
  recipient: '合成宛先', channel: '合成経路', sent_at: '', due: '', promise: '', agreement: '',
  sensitive: '', basis: '', note: '', references: '', shared_url: '',
  body: 'SYNTHETIC_PRIVATE_CONTACT_BODY', source_path: '', source_hash: '', extra: {},
  created_at: clockTime, updated_at: clockTime, ...overrides,
});
export const entity = (type, id, data, project_id = ids.project, workspace_id = ids.workspace) => ({
  id, workspace_id, project_id: type === 'project' || type === 'source' ? null : project_id,
  type, version: 1, archived: false, ...data,
});

/** Seed only through public Store ports, shared unchanged by future database adapters. */
export async function seed(store) {
  await store.transaction(async (session) => {
    for (const workspace_id of [ids.workspace, ids.otherWorkspace]) {
      await session.workspaces.put({ workspace_id, name: '合成workspace', timezone: 'UTC', schema_version: 3 });
    }
    for (const [label, principal] of Object.entries(principalFixtures)) {
      await session.accounts.put({ subject: principal.account_subject, login: `synthetic_${label}`, active: true, revision: 1 });
      await session.memberships.put({ scope: 'workspace', workspace_id: principal.workspace_id,
        member_id: principal.member_id, name: '合成member', role: principal.role, active: true, version: 1 }, null);
    }
    const resources = [
      entity('project', ids.project, projectData()),
      entity('project', ids.hiddenProject, projectData()),
      entity('project', ids.otherProject, projectData({ owner_id: ids.otherOwner }), null, ids.otherWorkspace),
      entity('milestone', ids.milestone, milestoneData()),
      entity('milestone', ids.hiddenMilestone, milestoneData(), ids.hiddenProject),
      entity('work_item', ids.work, workData()),
      entity('work_item', ids.hiddenWork, workData({ milestone_id: ids.hiddenMilestone }), ids.hiddenProject),
      entity('source', ids.source, { label: '合成接続元', adapter: 'contact', binding: 'synthetic_main' }),
      entity('source', ids.otherSource, { label: '合成接続元', adapter: 'contact', binding: 'synthetic_aux' }),
      entity('source', ids.foreignSource, { label: '合成接続元', adapter: 'contact', binding: 'synthetic_foreign' }, null, ids.otherWorkspace),
      ...[
        [ids.reference, ids.project, ids.source, contacts.normal],
        [ids.hiddenReference, ids.hiddenProject, ids.source, contacts.normal],
        [ids.secondReference, ids.project, ids.otherSource, contacts.second],
        [ids.sensitiveReference, ids.project, ids.source, contacts.sensitive],
      ].map(([id, project, source, contact]) => entity('reference', id,
        { kind: 'contact', target: contact, label: '合成連絡参照', linked_id: '', source_id: source }, project)),
    ];
    for (const record of resources) await session.resources.put(record, null);
    for (const [member_id, role] of [[ids.editor, 'editor'], [ids.viewer, 'viewer']]) {
      await session.memberships.put({ scope: 'project', workspace_id: ids.workspace,
        project_id: ids.project, member_id, role, version: 1 }, 0);
    }
    for (const member_id of [ids.editor, ids.viewer, ids.outsider]) {
      await session.memberships.put({ scope: 'source', workspace_id: ids.workspace,
        source_id: ids.source, member_id, allowed: true, version: 1 }, 0);
    }
    for (const [source_id, id, overrides] of [
      [ids.source, contacts.normal, {}], [ids.otherSource, contacts.second, {}],
      [ids.source, contacts.sensitive, { sensitive: '合成の制限' }],
      [ids.source, contacts.unlinked, {}],
    ]) await session.contacts.put({ workspace_id: ids.workspace, source_id, version: 1,
      contact: contactData(id, overrides) }, null);
  });
}

/** Complete public-port snapshot for atomicity/read-only assertions. */
export async function snapshot(store) {
  return store.read(async (session) => {
    const result = [];
    for (const workspace of [ids.workspace, ids.otherWorkspace]) result.push({
      workspace: await session.workspaces.get(workspace),
      resources: await session.resources.list(workspace),
      memberships: await session.memberships.list(workspace),
      events: await session.events.list(workspace),
      contacts: await Promise.all([ids.source, ids.otherSource, ids.foreignSource].map((source) => session.contacts.list(workspace, source))),
      contact_events: await Promise.all([ids.source, ids.otherSource].flatMap((source) =>
        Object.values(contacts).map((contact) => session.contacts.history(workspace, source, contact)))),
    });
    return result;
  });
}
