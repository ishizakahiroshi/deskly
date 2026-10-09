/* Generated from schema/work_item.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
export type WorkKind = '開発' | '営業' | '運営';
export type ItemState = '未確認' | '進行中' | '待ち' | '完了' | '保留';

/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface WorkItem {
  id: StableId;
  workspace_id: StableId;
  project_id: StableId;
  type: 'work_item';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  kind: WorkKind;
  title: string;
  assignee_id: StableId;
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
  milestone_id: StableId | '';
  project_name?: string;
}
