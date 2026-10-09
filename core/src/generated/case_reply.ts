/* Generated from schema/case_reply.schema.json. Do not edit. Run pnpm run generate. */

/**
 * Canonical lowercase UUID; stable across renames, exports and restores. Never a display name or email.
 */
export type StableId = string;
/**
 * Public case number <source>-<seq>, issued only by the ledger.
 */
export type CaseNumber = string;
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
 * Opaque identifier already owned by the sending app. Stored as sent; never joined to any user, tenant or app table.
 */
export type CaseRef = string;

/**
 * What was returned to the reporter. created_at is when the ledger saved it; delivered_at is when it reached the person (null until then). Saving is not delivery.
 */
export interface CaseReply {
  workspace_id: StableId;
  case_number: CaseNumber;
  /**
   * Append order within one case, starting at 1.
   */
  seq: number;
  /**
   * Reply text stored exactly as received.
   */
  body: string;
  author: CaseActor;
  author_ref: CaseRef | null;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  created_at: string;
  delivered_at: string | null;
}
