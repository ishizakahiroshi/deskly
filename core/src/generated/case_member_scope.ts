/* Generated from schema/case_member_scope.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId1 = string;
/**
 * viewer reads only. editor also adds replies, links and people and changes status, approval and deadlines. null is the retained, revoked scope.
 */
export type CaseMemberRole = 'viewer' | 'editor' | null;
/**
 * A case source prefix, or * (only as the single item) for all sources.
 */
export type CaseScopeSource = string;
/**
 * Opaque identifier already owned by the sending app. Stored as sent; never joined to any user, tenant or app table.
 */
export type CaseRef = string;
/**
 * Public case number <source>-<seq>, issued only by the ledger.
 */
export type CaseNumber = string;
/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId2 = string;

/**
 * What one workspace member may see of the received cases, used only while [member_access] enabled = true in the case settings. The same source and tenant rule as a sending app scope applies, optionally narrowed to explicit case numbers. Cases outside the scope are indistinguishable from absent ones (404). A revoked scope is kept with role null and empty lists so its revision never goes back; it grants nothing.
 */
export interface CaseMemberScope {
  workspace_id: StableId;
  member_id: StableId1;
  role: CaseMemberRole;
  /**
   * Visible case sources; ["*"] means all. Empty only on a revoked scope.
   *
   * @maxItems 200
   */
  sources: CaseScopeSource[];
  /**
   * Visible tenants (tenant_ref values); ["*"] means all, including cases without a tenant. Empty only on a revoked scope.
   *
   * @maxItems 200
   */
  tenants: CaseRef[];
  /**
   * Case numbers the member works on (an external collaborator). Empty means no narrowing: the source and tenant match alone decides. When not empty, only these numbers that also match sources and tenants are visible.
   *
   * @maxItems 1000
   */
  numbers: CaseNumber[];
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  revision: number;
  updated_by: StableId2;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  updated_at: string;
}
