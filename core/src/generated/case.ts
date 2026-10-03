/* Generated from schema/case.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Public case number <source>-<seq>, issued only by the ledger.
 */
export type CaseNumber = string;
/**
 * Sending app prefix, fixed by the authenticated app scope and never taken from a request body. Stored prefixes never change.
 */
export type CaseSource = string;
export type NullableRef = CaseRef | null;
/**
 * Opaque identifier already owned by the sending app. Stored as sent; never joined to any user, tenant or app table.
 */
export type CaseRef = string;
/**
 * Consecutive number within one source, starting at 1.
 */
export type Seq = number;
export type CaseOrigin = 'human' | 'detected';
/**
 * Configured identifier (kind, status or approval state). Display labels are separate settings and are never stored.
 */
export type CaseIdentifier = string;
/**
 * Rejected, never truncated, when longer than 200 characters.
 */
export type CaseTitle = string;
/**
 * Text written by a person or the detected content, stored exactly as received.
 */
export type CaseBody = string;
export type NullableUrl = CaseUrl | null;
export type CaseUrl = string;
export type NullableDate = CaseDate | null;
/**
 * Calendar date YYYY-MM-DD, compared in UTC.
 */
export type CaseDate = string;

/**
 * One received case (display name is configurable; the stored identifier is case). The ledger stores what the sending app sent and never rewrites it. number is issued only by the ledger as <source>-<seq>. kind, status and approval_state are configured identifiers, never display words; the service checks them against the loaded settings. version is the app version where the case happened; revision is the optimistic concurrency counter. Cases are never deleted. All timestamps are UTC.
 */
export interface Case {
  workspace_id: StableId;
  number: CaseNumber;
  source: CaseSource;
  tenant_ref: NullableRef;
  seq: Seq;
  origin: CaseOrigin;
  kind: CaseIdentifier;
  status: CaseIdentifier;
  approval_state: CaseIdentifier;
  title: CaseTitle;
  body: CaseBody;
  reporter_ref: NullableRef;
  screen_id: NullableRef;
  feature_id: NullableRef;
  environment: NullableRef;
  version: NullableRef;
  url: NullableUrl;
  fingerprint: NullableRef;
  promised_due: NullableDate;
  hold_until: NullableDate;
  closed_at: string | null;
  duplicate_of: CaseNumber | null;
  legacy_ref: NullableRef;
  /**
   * Persisted optimistic concurrency version; JSON booleans are not integers.
   */
  revision: number;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  created_at: string;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  updated_at: string;
}
