/* Generated from schema/membership.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Explicitly scoped membership and grants; no flattening of owner/member into editor/viewer.
 */
export type Membership = WorkspaceMembership | ProjectMembership | SourceMembership;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId1 = string;
/**
 * owner manages the workspace. member confers no project or source access by itself.
 */
export type WorkspaceRole = 'owner' | 'member';
/**
 * Project-scoped grant; null is the retained, versioned revoked grant. Workspace owners need no grant.
 */
export type ProjectRole = 'editor' | 'viewer' | null;

export interface WorkspaceMembership {
  scope: 'workspace';
  workspace_id: StableId;
  member_id: StableId1;
  name: string;
  role: WorkspaceRole;
  active: boolean;
  /**
   * Optional public member-view version: Python uses 1 active / 2 inactive, not a persisted members table revision.
   */
  version?: number;
  identity?: Identity;
}
/**
 * Optional owner/operator-only identity binding. Omit from ordinary member listings; never infer it from login or email.
 */
export interface Identity {
  /**
   * Exact trusted issuer. Service rejects userinfo, query and fragment.
   */
  issuer: string;
  /**
   * Opaque issuer-scoped subject; not necessarily UUID. Never match identity by display name or email.
   */
  subject: string;
}
/**
 * A project-scoped grant. Retain role=null and its version after revocation to avoid stale grant reactivation. Workspace owners cannot be granted editor/viewer as a replacement role.
 */
export interface ProjectMembership {
  scope: 'project';
  workspace_id: StableId;
  project_id: StableId;
  member_id: StableId;
  role: ProjectRole;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
}
/**
 * Independent source permission; does not imply project access, and project access does not imply this permission.
 */
export interface SourceMembership {
  scope: 'source';
  workspace_id: StableId;
  source_id: StableId;
  member_id: StableId;
  allowed: boolean;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  version: number;
}
