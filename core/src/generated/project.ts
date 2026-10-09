/* Generated from schema/project.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Business owner member ID, not a workspace authorization role.
 */
export type StableId1 = string;
export type ProjectState = '未確認' | '進行中' | '保留' | '終了';

/**
 * Normalized Python workspace entity. All persisted data fields are required; optional projections are read-only and must not be sent as mutable data.
 */
export interface Project {
  id: StableId;
  workspace_id: StableId;
  project_id: null;
  type: 'project';
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
  archived: boolean;
  name: string;
  purpose: string;
  owner_id: StableId1;
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
