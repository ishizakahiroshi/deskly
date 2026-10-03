/* Generated from schema/case_person.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Public case number <source>-<seq>, issued only by the ledger.
 */
export type CaseNumber = string;
/**
 * Opaque identifier already owned by the sending app. Stored as sent; never joined to any user, tenant or app table.
 */
export type CaseRef = string;
/**
 * Authenticated writer resolved by the server: a sending app or a workspace owner. Never taken from a request body.
 */
export type CaseActor =
  | {
      kind: 'app';
      app: CaseAppName;
    }
  | {
      kind: 'member';
      member_id: StableId;
    };
/**
 * Name of the authenticated sending app (the name joining its key and scope settings).
 */
export type CaseAppName = string;

/**
 * Another person who hit the same case. One row per (case, reporter_ref); sending the same person again adds nothing.
 */
export interface CasePerson {
  workspace_id: StableId;
  case_number: CaseNumber;
  reporter_ref: CaseRef;
  added_by: CaseActor;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  created_at: string;
}
