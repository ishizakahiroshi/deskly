// Synthetic data only. These IDs do not identify people or production records.
export const ids = Object.freeze({
  workspace: '00000000-0000-0000-0000-000000000001',
  member: '00000000-0000-0000-0000-000000000002',
  project: '00000000-0000-0000-0000-000000000003',
  milestone: '00000000-0000-0000-0000-000000000004',
  work: '00000000-0000-0000-0000-000000000005',
  operation: '00000000-0000-0000-0000-000000000006',
  source: '00000000-0000-0000-0000-000000000007',
});
export const project = {
  id: ids.project, workspace_id: ids.workspace, project_id: null,
  type: 'project', version: 1, archived: false,
  name: '合成案件', purpose: '合成の目的', owner_id: ids.member, state: '未確認',
};
export const milestone = {
  id: ids.milestone, workspace_id: ids.workspace, project_id: ids.project,
  type: 'milestone', version: 1, archived: false,
  goal: '合成目標', acceptance: '合成の完了条件', assignee_id: ids.member,
  check_date: '', state: '待ち',
};
export const workItem = {
  id: ids.work, workspace_id: ids.workspace, project_id: ids.project,
  type: 'work_item', version: 1, archived: false,
  kind: '開発', title: '合成作業', assignee_id: ids.member, next_action: '合成確認',
  check_date: '', waiting_reason: '', state: '未確認', milestone_id: '',
};
export const contact = {
  id: 'c-20260101-0123abcd', state: '下書き', state_inferred: false,
  project: '', recipient: '', channel: '', sent_at: '', due: '', promise: '',
  agreement: '', sensitive: '', basis: '', note: '', references: '', shared_url: '',
  body: '合成本文', source_path: '', source_hash: '', extra: {}, created_at: '', updated_at: '',
};
export const event = {
  event_kind: 'entity', operation_id: ids.operation, workspace_id: ids.workspace,
  entity_id: ids.project, member_id: ids.member, requester_member_id: ids.member,
  route: 'dashboard', executor_kind: 'unknown', executor_ref: null, executor_verified: false,
  reason: '合成の記録', at_utc: '2026-01-01T00:00:00Z', before: null, after: project,
  changes: Object.keys(project).sort().map((field) => ({
    field, before_present: false, after_present: true, before: null, after: project[field],
  })),
};
export const examples = {
  workspace: { workspace_id: ids.workspace, name: '合成workspace', timezone: 'UTC', schema_version: 3 },
  project,
  milestone,
  work_item: workItem,
  contact,
  event,
  account: { subject: ids.member, login: 'synthetic_account', active: true, revision: 1 },
  membership: { scope: 'project', workspace_id: ids.workspace, project_id: ids.project,
    member_id: ids.member, role: 'editor', version: 1 },
};
