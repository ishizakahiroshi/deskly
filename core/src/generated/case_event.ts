/* Generated from schema/case_event.schema.json. Do not edit. Run pnpm run generate. */

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
 * Append-only status, approval and deadline history. Never overwritten or deleted. actor is the authenticated writer; actor_ref is the app's own identifier of the person who acted (for example an approver).
 */
export interface CaseEvent {
  workspace_id: StableId;
  case_number: CaseNumber;
  /**
   * Append order within one case, starting at 1.
   */
  seq: number;
  action: 'create' | 'update';
  actor: CaseActor;
  actor_ref: CaseRef | null;
  reason: string | null;
  /**
   * UTC RFC 3339 timestamp. Current Python writes second precision.
   */
  at_utc: string;
  /**
   * @minItems 1
   */
  changes: [CaseChange, ...CaseChange[]];
}
export interface CaseChange {
  field: 'status' | 'approval_state' | 'promised_due' | 'hold_until' | 'closed_at';
  before: string | null;
  after: string | null;
}
