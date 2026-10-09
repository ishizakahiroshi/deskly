/* Generated from schema/case_link.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Public case number <source>-<seq>, issued only by the ledger.
 */
export type CaseNumber = string;
export type CaseLinkType = 'commit' | 'doc' | 'url';
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
 * Evidence attached to a case: a commit hash, a document reference or a URL. Unique by (case, link_type, ref); sending the same link again adds nothing. The ledger never clones repositories or runs version control.
 */
export interface CaseLink {
  workspace_id: StableId;
  case_number: CaseNumber;
  link_type: CaseLinkType;
  ref: string;
  added_by: CaseActor;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  created_at: string;
}
