/* Generated from schema/milestone.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
export type ItemState = '未確認' | '進行中' | '待ち' | '完了' | '保留';

/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface Milestone {
  id: StableId;
  workspace_id: StableId;
  project_id: StableId;
  type: 'milestone';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  goal: string;
  acceptance: string;
  assignee_id: StableId;
  /**
   * Empty or canonical YYYY-MM-DD; evaluated in workspace timezone, never UTC midnight.
   */
  check_date: '' | string;
  state: ItemState;
}
