/** Portable adapter contracts. Every returned value is detached from adapter state. */
import type { Workspace } from './generated/workspace.js';
import type { Account } from './generated/account.js';
import type { EntitySnapshot, Event } from './generated/event.js';
import type { ContactRecord } from './generated/contact_record.js';
import type { ContactEvent } from './generated/contact_event.js';
export type { ContactRecord } from './generated/contact_record.js';
export type { ContactEvent } from './generated/contact_event.js';
import type { Membership, WorkspaceRole } from './generated/membership.js';
import type { Case } from './generated/case.js';
import type { CaseEvent } from './generated/case_event.js';
import type { CasePerson } from './generated/case_person.js';
import type { CaseReply } from './generated/case_reply.js';
import type { CaseLink } from './generated/case_link.js';
import type { CaseMemberScope } from './generated/case_member_scope.js';
import type { CaseMemberScopeEvent } from './generated/case_member_scope_event.js';
import type { CaseSettings } from './case-settings.js';
export type { Case } from './generated/case.js';
export type { CaseMemberScope } from './generated/case_member_scope.js';
export type { CaseMemberScopeEvent } from './generated/case_member_scope_event.js';
export type { CaseEvent } from './generated/case_event.js';
export type { CasePerson } from './generated/case_person.js';
export type { CaseReply } from './generated/case_reply.js';
export type { CaseLink } from './generated/case_link.js';

export type Entity = EntitySnapshot;
export interface Principal {
  workspace_id: string;
  member_id: string;
  role: WorkspaceRole;
  active: boolean;
  /** Resolved by the authenticator, never taken from an HTTP actor field. */
  account_subject?: string;
}
export interface Authenticator {
  authenticate(request: Request): Promise<Principal | null>;
}
/**
 * A sending app authenticated by its own key (keys, allowed addresses and the
 * settings loader arrive in C8-2). sources/tenants are its visible scope; ["*"]
 * means all. It is accepted only on case routes, never on member routes.
 */
export interface AppPrincipal {
  kind: 'app';
  workspace_id: string;
  app: string;
  sources: string[];
  tenants: string[];
}
export interface AppAuthenticator {
  authenticate(request: Request): Promise<AppPrincipal | null>;
}
/**
 * Either a workspace member (an active owner, or, while member access is enabled,
 * a member given a case scope) or a sending app.
 */
export type CasePrincipal = Principal | AppPrincipal;
export interface Clock { now(): string }
export interface IdGenerator { next(): string }
/** HMAC-SHA256 and SHA256, provided by a portable implementation or host adapter. */
export interface ConfirmationSigner {
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
  digest(payload: string): Promise<string>;
}
export interface ResourcePort {
  get(workspaceId: string, id: string): Promise<Entity | null>;
  list(workspaceId: string): Promise<Entity[]>;
  /** null means create-only; otherwise compare exactly and increment once. */
  put(value: Entity, expectedVersion: number | null): Promise<void>;
}
export interface WorkspacePort {
  get(workspaceId: string): Promise<Workspace | null>;
  put(value: Workspace): Promise<void>;
}
export interface AccountPort {
  get(subject: string): Promise<Account | null>;
  put(value: Account): Promise<void>;
}
export interface MembershipPort {
  list(workspaceId: string): Promise<Membership[]>;
  /** workspace membership uses null for bootstrap; grants use 0 for absence. */
  put(value: Membership, expectedVersion: number | null): Promise<void>;
}
export interface EventPort {
  get(workspaceId: string, operationId: string): Promise<Event | null>;
  list(workspaceId: string): Promise<Event[]>;
  /** Append-only and unique by operation ID across the workspace. */
  append(value: Event): Promise<void>;
}
export interface ContactPort {
  get(workspaceId: string, sourceId: string, contactId: string): Promise<ContactRecord | null>;
  list(workspaceId: string, sourceId: string): Promise<ContactRecord[]>;
  put(value: ContactRecord, expectedVersion: number | null): Promise<void>;
  event(workspaceId: string, operationId: string): Promise<ContactEvent | null>;
  history(workspaceId: string, sourceId: string, contactId: string): Promise<ContactEvent[]>;
  append(value: ContactEvent): Promise<void>;
}
/**
 * Received cases (display name configurable). There is deliberately no delete:
 * a case, its events, people, replies and links can only be added or updated.
 * Every key is scoped by workspace_id; no foreign key to any app/user/tenant.
 */
export interface CasePort {
  get(workspaceId: string, number: string): Promise<Case | null>;
  list(workspaceId: string): Promise<Case[]>;
  /** The unique case for (source, legacy_ref), if any. */
  findByLegacyRef(workspaceId: string, source: string, legacyRef: string): Promise<Case | null>;
  /**
   * Issue the next seq of one source (first is 1) and advance the per-source
   * sequence row in the same transaction. A rolled-back transaction issues nothing.
   */
  allocate(workspaceId: string, source: string): Promise<number>;
  /**
   * null is create-only: reject a used number or (source, legacy_ref) with
   * duplicate_id. Otherwise compare revision exactly and increment once.
   * number, source, seq and workspace never change on update.
   */
  put(value: Case, expectedRevision: number | null): Promise<void>;
  /** Append-only, ordered by seq; unique by (workspace, case, seq). */
  events(workspaceId: string, number: string): Promise<CaseEvent[]>;
  appendEvent(value: CaseEvent): Promise<void>;
  /** Unique by (workspace, case, reporter_ref); ordered by insertion. */
  people(workspaceId: string, number: string): Promise<CasePerson[]>;
  addPerson(value: CasePerson): Promise<void>;
  /** Append-only, ordered by seq; unique by (workspace, case, seq). */
  replies(workspaceId: string, number: string): Promise<CaseReply[]>;
  addReply(value: CaseReply): Promise<void>;
  /** Unique by (workspace, case, link_type, ref); ordered by insertion. */
  links(workspaceId: string, number: string): Promise<CaseLink[]>;
  addLink(value: CaseLink): Promise<void>;
}
/**
 * The case scope given to a workspace member (used only while [member_access] is
 * enabled). There is no delete: a revocation is a put with role null and empty
 * lists, so a revision never goes back. History is append-only.
 */
export interface CaseMemberScopePort {
  get(workspaceId: string, memberId: string): Promise<CaseMemberScope | null>;
  /** Every scope row of the workspace (revoked ones included), ordered by member_id. */
  list(workspaceId: string): Promise<CaseMemberScope[]>;
  /**
   * 0 is create-only (a row for the member must not exist, revision must be 1);
   * otherwise compare revision exactly and advance once. workspace and member never change.
   */
  put(value: CaseMemberScope, expectedRevision: number): Promise<void>;
  /** Append-only, ordered by seq; unique by (workspace, seq), seq starts at 1 per workspace. */
  events(workspaceId: string): Promise<CaseMemberScopeEvent[]>;
  appendEvent(value: CaseMemberScopeEvent): Promise<void>;
}
export interface StoreSession {
  workspaces: WorkspacePort;
  resources: ResourcePort;
  accounts: AccountPort;
  memberships: MembershipPort;
  events: EventPort;
  contacts: ContactPort;
  /**
   * Received cases. Every adapter (memory, SQLite, D1) provides it; the service
   * still fails closed with cases_not_enabled if a wrapped session lacks it.
   */
  cases: CasePort;
  /**
   * Case scopes of members. Every adapter provides it; the case service reads it
   * only while member access is enabled, and fails closed if a session lacks it.
   */
  caseMemberScopes: CaseMemberScopePort;
}
export interface Store {
  /** Consistent immutable read snapshot. Mutation methods must reject. */
  read<T>(run: (session: StoreSession) => Promise<T>): Promise<T>;
  /**
   * Serializable, all-or-nothing unit of work. Authorization reads, CAS writes,
   * and append-only events belong to the same transaction. On any rejection,
   * roll back everything. Concurrent transactions may never lose updates.
   * Sessions must not escape the callback. Adapters must not retry callbacks.
   */
  transaction<T>(run: (session: StoreSession) => Promise<T>): Promise<T>;
}
export interface ServiceDependencies {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  signer: ConfirmationSigner;
  /** Server-selected route, independent of any client-controlled header/body. */
  route?: 'dashboard' | 'shared-cli' | 'shared-admin-cli' | 'workspace-access';
  /** Validated case settings. Without them every case operation fails closed. */
  caseSettings?: CaseSettings;
}
export type ConflictCode = 'version_conflict' | 'operation_conflict' | 'stale_preview' |
  'duplicate_id' | 'archived' | 'assigned_work_remaining' | 'sharing_not_enabled' | 'invalid_project';
export class ServiceError extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 401 | 403 | 404 | 409 = 400) {
    super(code);
    this.name = 'ServiceError';
  }
}
export class ConflictError extends ServiceError {
  constructor(public override readonly code: ConflictCode) {
    super(code, 409);
    this.name = 'ConflictError';
  }
}
