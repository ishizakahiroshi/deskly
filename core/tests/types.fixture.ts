import type { Account, Contact, Event, Membership, Milestone, Project, WorkItem, Workspace } from '../src/index.js';
import { nextProjectWork } from '../src/index.js';

const id = '00000000-0000-0000-0000-000000000001';
const project = {
  id, workspace_id: id, project_id: null, type: 'project', version: 1, archived: false,
  name: '合成案件', purpose: '合成の目的', owner_id: id, state: '未確認',
} satisfies Project;
const work = {
  id, workspace_id: id, project_id: id, type: 'work_item', version: 1, archived: false,
  kind: '開発', title: '合成作業', assignee_id: id, next_action: '合成確認',
  check_date: '', waiting_reason: '', state: '待ち', milestone_id: '',
} satisfies WorkItem;

// These real assignments catch generator regressions (e.g. string & object types).
export const typedExamples = {
  workspace: { workspace_id: id, name: '合成workspace', timezone: 'UTC', schema_version: 3 },
  project,
  milestone: { id, workspace_id: id, project_id: id, type: 'milestone', version: 1,
    archived: false, goal: '合成目標', acceptance: '合成の条件', assignee_id: id,
    check_date: '', state: '未確認' },
  work,
  contact: { id: 'c-20260101-0123abcd', state: '下書き', state_inferred: false,
    project: '', recipient: '', channel: '', sent_at: '', due: '', promise: '',
    agreement: '', sensitive: '', basis: '', note: '', references: '', shared_url: '',
    body: '', source_path: '', source_hash: '', extra: {}, created_at: '', updated_at: '' },
  event: { event_kind: 'entity', operation_id: id, workspace_id: id, entity_id: id,
    member_id: id, requester_member_id: id, route: 'dashboard', executor_kind: 'unknown',
    executor_ref: null, executor_verified: false, reason: '合成理由',
    at_utc: '2026-01-01T00:00:00Z', before: null, after: project, changes: [] },
  account: { subject: id, login: 'synthetic_account', active: true, revision: 1 },
  memberships: [
    { scope: 'workspace', workspace_id: id, member_id: id, name: '合成member', role: 'owner', active: true },
    { scope: 'project', workspace_id: id, project_id: id, member_id: id, role: null, version: 2 },
    { scope: 'source', workspace_id: id, source_id: id, member_id: id, allowed: true, version: 1 },
  ],
} satisfies {
  workspace: Workspace; project: Project; milestone: Milestone; work: WorkItem;
  contact: Contact; event: Event; account: Account; memberships: Membership[];
};

export const next = nextProjectWork(project, [work]);
// @ts-expect-error Contact states must never accept work-item state vocabulary.
export const invalidContactState: Contact['state'] = '待ち';
// @ts-expect-error Project uses 終了, while work items use 完了.
export const invalidProjectState: Project['state'] = '完了';

// Event discriminants must narrow the required audit aliases in generated types.
export function eventActor(event: Event): string {
  if (event.event_kind === 'entity') {
    const entity: string = event.entity_id;
    const member: string = event.member_id;
    return `${entity}:${member}`;
  }
  const actor: string = event.actor_member_id;
  const target: string = event.target_id;
  return `${event.target_type}:${target}:${actor}`;
}
const { entity_id: omittedEntityId, ...eventWithoutEntityId } = typedExamples.event;
const { member_id: omittedMemberId, ...eventWithoutMemberId } = typedExamples.event;
void omittedEntityId;
void omittedMemberId;
// @ts-expect-error Entity events require entity_id, not only an event_kind label.
export const invalidMissingEntity: Event = eventWithoutEntityId;
// @ts-expect-error Entity events require the legacy member_id audit alias.
export const invalidMissingMember: Event = eventWithoutMemberId;
// @ts-expect-error Closed Event branches reject arbitrary audit fields.
export const invalidEventExtra: Event = { ...typedExamples.event, unexpected_audit: true };
const accessExample = {
  event_kind: 'access', operation_id: id, workspace_id: id, actor_member_id: id,
  target_type: 'project_role', target_id: id, requester_member_id: id, route: 'workspace-access',
  executor_kind: 'unknown', executor_ref: null, executor_verified: false,
  reason: '合成理由', at_utc: '2026-01-01T00:00:00Z', before: null,
  after: { role: 'viewer', version: 2 }, changes: [],
} satisfies Event;
const { actor_member_id: omittedActorId, ...eventWithoutActorId } = accessExample;
void omittedActorId;
// @ts-expect-error Access events require actor_member_id, not entity member_id.
export const invalidMissingActor: Event = eventWithoutActorId;
// @ts-expect-error Entity snapshots cannot be access-only partial grant records.
export const invalidEntitySnapshot: Event = { ...typedExamples.event, after: { role: 'viewer', version: 2 } };

// Verify the narrow port accepts the actual Workers binding without a cast.
export function cloudflareBinding(database: import('@cloudflare/workers-types').D1Database): import('../src/adapters/d1/driver.js').D1Driver {
  return database;
}
