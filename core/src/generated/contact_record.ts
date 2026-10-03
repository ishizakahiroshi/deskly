/* Generated from schema/contact_record.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Legacy contact identifier; retained unchanged, never recast as a UUID.
 */
export type ContactId = string;
export type ContactState = '下書き' | '送信済み' | '回答待ち' | '対応中' | '完了' | '送らない';

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
