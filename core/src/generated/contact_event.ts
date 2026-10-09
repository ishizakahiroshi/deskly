/* Generated from schema/contact_event.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Legacy contact identifier; retained unchanged, never recast as a UUID.
 */
export type ContactId = string;
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
export type ContactState = '下書き' | '送信済み' | '回答待ち' | '対応中' | '完了' | '送らない';

/**
 * Owner-only contact history, distinct from workspace/project events. Exact field changes, timestamp, actor and complete before/after versions.
 */
export interface ContactEvent {
  operation_id: StableId;
  workspace_id: StableId;
  source_id: StableId;
  contact_id: ContactId;
  requester_member_id: StableId;
  route: string;
  reason: string;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  at_utc: string;
  changes: FieldChange[];
  before: ContactRecord | null;
  after: ContactRecord;
  request_hash: string;
}
/**
 * Owner-only private contact ledger envelope; never a project-member projection.
 */
export interface ContactRecord {
  workspace_id: StableId;
  source_id: StableId;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  contact: Contact;
}
/**
 * Complete legacy Contact dataclass, including import metadata. This full shape is for existing authorized ledger/import/export boundaries, not an allowlist for shared Web output.
 */
export interface Contact {
  id: ContactId;
  state: ContactState;
  state_inferred: boolean;
  /**
   * Legacy display/matching string only. Never join or authorize by this value; use workspace_id, source_id and contact_id in explicit references.
   */
  project: string;
  recipient: string;
  channel: string;
  /**
   * Preserved legacy string; it may be empty or non-ISO. Not silently converted to a timestamp.
   */
  sent_at: string;
  /**
   * Preserved legacy string; it may be empty or non-ISO. Not silently converted to a date.
   */
  due: string;
  promise: string;
  agreement: string;
  /**
   * Any nonempty value requires suppressing this entire record from shared responses; not merely hiding this field.
   */
  sensitive: string;
  basis: string;
  note: string;
  references: string;
  shared_url: string;
  body: string;
  /**
   * Legacy private import path; excluded from shared contact projections.
   */
  source_path: string;
  source_hash: string;
  /**
   * Unknown legacy import headers. Keys and values are strings; never dropped by migration.
   */
  extra: {
    [k: string]: string;
  };
  created_at: string;
  updated_at: string;
}
