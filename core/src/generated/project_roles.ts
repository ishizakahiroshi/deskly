/* Generated from schema/project_roles.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Effective authorization vocabulary. owner is workspace-wide; editor and viewer are project grants, not workspace membership roles.
 */
export type EffectiveRole = 'owner' | 'editor' | 'viewer';

export interface CurrentProjectRoles {
  member_id: StableId;
  items: {
    project_id: StableId;
    role: EffectiveRole;
  }[];
}
