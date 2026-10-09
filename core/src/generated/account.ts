/* Generated from schema/account.schema.json. Do not edit. Run pnpm run generate. */

/**
 * accounts.subject, generated once. The identity issuer+subject pair resolves a distinct workspace member ID.
 */
export type StableId = string;

/**
 * Safe local account metadata. subject is the stable local account identifier; authentication secrets and sessions are deliberately absent. Availability of this contract does not expose an account-management endpoint.
 */
export interface Account {
  subject: StableId;
  login: string;
  active: boolean;
  /**
   * Credential revision used for revocation checks; not an entity update version.
   */
  revision: number;
}
