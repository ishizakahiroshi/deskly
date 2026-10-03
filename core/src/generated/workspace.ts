/* Generated from schema/workspace.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;

/**
 * Metadata for an explicitly initialized workspace. schema_version is the persisted Python storage version, not the contract release number.
 */
export interface Workspace {
  workspace_id: StableId;
  name: string;
  /**
   * IANA timezone identifier, also allowing UTC. Service must validate against the timezone database.
   */
  timezone: string;
  schema_version: number;
}
