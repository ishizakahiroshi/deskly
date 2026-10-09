/* Generated from schema/contact_command.schema.json. Do not edit. Run pnpm run generate. */

/**
 * All writes require preview then explicit apply. Any of the six states may follow any other; unchanged state is a no-op. Reply appends a trimmed summary and sets 対応中. add_draft never accepts state or client timestamps. Preview allocates contact_id when null.
 */
export type ContactActionCommand = AddDraft | SetState | RecordReply;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Legacy contact identifier; retained unchanged, never recast as a UUID.
 */
export type ContactId = string;
export type ContactState = '下書き' | '送信済み' | '回答待ち' | '対応中' | '完了' | '送らない';

export interface AddDraft {
  operation_id: StableId;
  action: 'add_draft';
  contact_id: ContactId | null;
  expected_version: null;
  data: {
    state_inferred?: boolean;
    /**
     * Legacy display/matching string only. Never join or authorize by this value; use workspace_id, source_id and contact_id in explicit references.
     */
    project?: string;
    recipient?: string;
    channel?: string;
    /**
     * Preserved legacy string; it may be empty or non-ISO. Not silently converted to a timestamp.
     */
    sent_at?: string;
    /**
     * Preserved legacy string; it may be empty or non-ISO. Not silently converted to a date.
     */
    due?: string;
    promise?: string;
    agreement?: string;
    /**
     * Any nonempty value requires suppressing this entire record from shared responses; not merely hiding this field.
     */
    sensitive?: string;
    basis?: string;
    note?: string;
    references?: string;
    shared_url?: string;
    body?: string;
    /**
     * Legacy private import path; excluded from shared contact projections.
     */
    source_path?: string;
    source_hash?: string;
    extra?: Extra;
  };
  reason: string;
}
/**
 * Unknown legacy import headers. Keys and values are strings; never dropped by migration.
 */
export interface Extra {
  [k: string]: string;
}
export interface SetState {
  operation_id: StableId;
  action: 'set_state';
  contact_id: ContactId;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  expected_version: number;
  data: {
    state: ContactState;
  };
  reason: string;
}
export interface RecordReply {
  operation_id: StableId;
  action: 'record_reply';
  contact_id: ContactId;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  expected_version: number;
  data: {
    summary: string;
  };
  reason: string;
}
