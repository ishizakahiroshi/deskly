/* Generated from schema/event.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Append-only normalized workspace/access audit record. Complete before/after snapshots remain authoritative; changes is a derived per-field view. Serialization does not confer access to hidden project/source or identity data.
 */
export type Event = EntityEvent | AccessEvent;
/**
 * Stable operation/event identifier used for idempotency. Same operation plus same caller and payload replays; mismatches conflict.
 */
export type StableId = string;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId1 = string;
/**
 * Authenticated human requester. Server resolved, not accepted from a caller-supplied actor label.
 */
export type StableId2 = string;
export type EntityBefore = null | EntitySnapshot;
export type EntitySnapshot = Project | Milestone | WorkItem | Source | Reference | Observation;
/**
 * Business owner member ID, not a workspace authorization role.
 */
export type StableId3 = string;
export type ProjectState = '未確認' | '進行中' | '保留' | '終了';
export type ItemState = '未確認' | '進行中' | '待ち' | '完了' | '保留';
export type WorkKind = '開発' | '営業' | '運営';
export type Source = {
  [k: string]: unknown;
} & {
  id: StableId1;
  workspace_id: StableId1;
  project_id: null;
  type: 'source';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  label: string;
  adapter: 'contact' | 'external_case';
  /**
   * Logical connection setting name, never a connection URL, token or filesystem path.
   */
  binding: string;
};
export type Reference = {
  [k: string]: unknown;
} & {
  id: StableId1;
  workspace_id: StableId1;
  project_id: StableId1;
  type: 'reference';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  kind: 'md' | 'https' | 'contact' | 'external_case';
  target: string;
  label: string;
  /**
   * Python uses an empty string for an absent optional relationship.
   */
  linked_id: StableId1 | '';
  /**
   * Python uses an empty string for an absent optional relationship.
   */
  source_id: StableId1 | '';
};
/**
 * Derived from complete snapshots, not a second writable history. Presence flags distinguish absent keys from JSON null.
 */
export type FieldChange = {
  [k: string]: unknown;
} & {
  /**
   * Top-level English snake_case field in the normalized snapshot.
   */
  field: string;
  before_present: boolean;
  after_present: boolean;
  before: JsonValue;
  after: JsonValue;
};
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };
/**
 * Deterministic top-level diff of before/after snapshots. Include every changed field, sorted by field; creation has before_present=false. Computed on serialization, not editable.
 */
export type Changes = FieldChange[];
export type AccessBefore = null | AccessSnapshot;

export interface EntityEvent {
  event_kind: 'entity';
  operation_id: StableId;
  workspace_id: StableId1;
  requester_member_id: StableId2;
  /**
   * Server-selected execution route. Route alone never proves the identity of an AI executor.
   */
  route: string;
  /**
   * Current Python emits unknown. Other values are reserved for independently verified transports; they must not be inferred from route or claimed by clients.
   */
  executor_kind: 'unknown' | 'human' | 'ai' | 'service';
  /**
   * Non-secret executor identity reference, only when evidence exists; otherwise null.
   */
  executor_ref: string | null;
  /**
   * Whether executor identity was verified separately from the human requester. Current and migrated Python rows normalize 0 to false.
   */
  executor_verified: boolean;
  reason: string;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  at_utc: string;
  before: EntityBefore;
  after: EntitySnapshot;
  changes: Changes;
  /**
   * Optional internal idempotency digest retained for faithful trusted export. Existing history responses omit it; it is not an authentication token.
   */
  request_hash?: string;
  entity_id: StableId1;
  member_id: StableId1;
}
/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface Project {
  id: StableId1;
  workspace_id: StableId1;
  project_id: null;
  type: 'project';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  name: string;
  purpose: string;
  owner_id: StableId3;
  state: ProjectState;
  next_milestone?: string;
  next_action?: string;
  /**
   * Empty or canonical YYYY-MM-DD; evaluated in workspace timezone, never UTC midnight.
   */
  check_date?: '' | string;
  waiting_reason?: string;
  unconfirmed_count?: number;
}
/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface Milestone {
  id: StableId1;
  workspace_id: StableId1;
  project_id: StableId1;
  type: 'milestone';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  goal: string;
  acceptance: string;
  assignee_id: StableId1;
  /**
   * Empty or canonical YYYY-MM-DD; evaluated in workspace timezone, never UTC midnight.
   */
  check_date: '' | string;
  state: ItemState;
}
/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface WorkItem {
  id: StableId1;
  workspace_id: StableId1;
  project_id: StableId1;
  type: 'work_item';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  kind: WorkKind;
  title: string;
  assignee_id: StableId1;
  next_action: string;
  /**
   * Empty or canonical YYYY-MM-DD; evaluated in workspace timezone, never UTC midnight.
   */
  check_date: '' | string;
  waiting_reason: string;
  state: ItemState;
  /**
   * Python uses an empty string for an absent optional relationship.
   */
  milestone_id: StableId1 | '';
  project_name?: string;
}
/**
 * Fetch metadata only. External source bodies and credentials are never copied into workspace history. Status vocabulary is owned by the source adapter.
 */
export interface Observation {
  id: StableId1;
  workspace_id: StableId1;
  project_id: StableId1;
  type: 'observation';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  reference_id: StableId1;
  status: string;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  last_attempt_at_utc: string;
  last_success_at_utc: string | null;
}
export interface AccessEvent {
  event_kind: 'access';
  operation_id: StableId;
  workspace_id: StableId1;
  requester_member_id: StableId2;
  /**
   * Server-selected execution route. Route alone never proves the identity of an AI executor.
   */
  route: string;
  /**
   * Current Python emits unknown. Other values are reserved for independently verified transports; they must not be inferred from route or claimed by clients.
   */
  executor_kind: 'unknown' | 'human' | 'ai' | 'service';
  /**
   * Non-secret executor identity reference, only when evidence exists; otherwise null.
   */
  executor_ref: string | null;
  /**
   * Whether executor identity was verified separately from the human requester. Current and migrated Python rows normalize 0 to false.
   */
  executor_verified: boolean;
  reason: string;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  at_utc: string;
  before: AccessBefore;
  after: AccessSnapshot;
  changes: Changes;
  /**
   * Optional internal idempotency digest retained for faithful trusted export. Existing history responses omit it; it is not an authentication token.
   */
  request_hash?: string;
  actor_member_id: StableId1;
  target_type: 'identity' | 'member' | 'project_role' | 'source_access' | 'member_credentials';
  target_id: StableId1;
}
/**
 * Owner-only access-history snapshot. Python boolean integers are normalized to JSON booleans. Identity metadata is permission-sensitive, never credential material.
 */
export interface AccessSnapshot {
  id?: StableId1;
  member_id?: StableId1;
  workspace_id?: StableId1;
  name?: string;
  role?: 'owner' | 'member' | 'editor' | 'viewer' | null;
  active?: boolean;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version?: number;
  /**
   * Exact trusted issuer. Service rejects userinfo, query and fragment.
   */
  issuer?: string;
  /**
   * Opaque issuer-scoped subject; not necessarily UUID. Never match identity by display name or email.
   */
  subject?: string;
  project_id?: StableId1;
  source_id?: StableId1;
  allowed?: boolean;
  transferred?: number;
  credential_revoked?: true;
  credential_state?: 'checked' | 'inactive';
}
