/**
 * Received-case service (display name configurable; stored identifier "case").
 * The ledger keeps what the sending app sent, issues numbers itself, derives
 * closed_at, appends history and never deletes. Scope (source x tenant, and for
 * a member scope optionally explicit numbers) is cut here on every read and
 * write; callers are never trusted to filter.
 * Kinds, statuses, approval states and labels come only from CaseSettings.
 * Member scopes are read only while [member_access] is enabled (off by default).
 */
import { ConflictError, ServiceError } from './ports.js';
import type { AppPrincipal, Case, CaseEvent, CaseLink, CaseMemberScope, CaseMemberScopeEvent, CaseMemberScopePort,
  CasePerson, CasePort, CasePrincipal, CaseReply, Principal, ServiceDependencies, StoreSession } from './ports.js';
import type { WorkspaceMembership } from './generated/membership.js';
import { CASE_SOURCE, caseSettings } from './case-settings.js';
import type { CaseSettings } from './case-settings.js';
import { casePanels, needsAttention } from './case-panels.js';
import type { CaseListItem, CasePanels } from './case-panels.js';
import { activeCaseMemberScope, caseMemberScopeRequest, sameCaseMemberScope, sortCaseMemberScopeEvents,
  sortCaseMemberScopes } from './case-access.js';
import { compareTimestamps, date, integer, object, text, timestamp, uuid } from './service-validation.js';

/** Protocol values fixed by the design (where a case came from, evidence kinds), not organization words. */
const ORIGINS: readonly string[] = ['human', 'detected'];
const LINK_TYPES: readonly string[] = ['commit', 'doc', 'url'];
const TITLE_LIMIT = 200;
const BODY_LIMIT = 50_000;
const REF_LIMIT = 200;
const URL_LIMIT = 2000;
const NUMBER = /^([a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9_])?)-([1-9][0-9]{0,14})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TRACKED = ['status', 'approval_state', 'promised_due', 'hold_until', 'closed_at'] as const;
const PLACE = ['screen_id', 'feature_id', 'environment', 'version', 'url'] as const;
const CREATE_FIELDS = ['origin', 'kind', 'title', 'body', 'reporter_ref', 'tenant_ref', 'place', 'fingerprint', 'legacy_ref', 'promised_due'];
const PATCH_FIELDS = ['expected_revision', 'status', 'approval_state', 'promised_due', 'hold_until', 'reason', 'actor_ref'];
const PATCHABLE = ['status', 'approval_state', 'promised_due', 'hold_until'] as const;

type Actor = CaseEvent['actor'];
type Change = CaseEvent['changes'][number];
interface Scope {
  actor: Actor;
  sources: '*' | readonly string[];
  tenants: '*' | readonly string[];
  /** Explicit case numbers of a member scope; null when not narrowed. */
  numbers: readonly string[] | null;
  /** false only for a member whose case scope is viewer. */
  write: boolean;
}
/** The authenticated caller before any case scope is applied. */
type Caller = { kind: 'app'; app: AppPrincipal }
  | { kind: 'member'; member_id: string; row: WorkspaceMembership | null };
export interface CaseCreated { number: string; status: string }
export interface CaseDetail { case: Case; people: CasePerson[]; replies: CaseReply[]; links: CaseLink[]; events: CaseEvent[] }
export interface CaseMemberScopeCollection { items: CaseMemberScope[]; events: CaseMemberScopeEvent[] }

function fields(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  const data = object(value, 'invalid_request');
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new ServiceError('invalid_fields');
  for (const key of required) if (!Object.hasOwn(data, key)) throw new ServiceError('required_field');
  return data;
}
const given = (data: Record<string, unknown>, key: string): unknown => Object.hasOwn(data, key) ? data[key] : null;
/** An app-owned opaque identifier: stored exactly as sent, never trimmed or joined. */
function ref(value: unknown, nullable = true): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || [...value].length > REF_LIMIT || CONTROL.test(value)) throw new ServiceError('invalid_field');
  if (!value.trim()) throw new ServiceError('required_field');
  return value;
}
function title(value: unknown): string {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new ServiceError('invalid_field');
  if (!value.trim()) throw new ServiceError('required_field');
  // Rejected, never truncated: truncating would change what the app sent.
  if ([...value].length > TITLE_LIMIT) throw new ServiceError('title_too_long');
  return value;
}
function body(value: unknown, required = false): string {
  if (typeof value !== 'string' || value.includes('\u0000')) throw new ServiceError('invalid_field');
  if ([...value].length > BODY_LIMIT) throw new ServiceError('body_too_long');
  if (required && !value.trim()) throw new ServiceError('required_field');
  return value;
}
function url(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > URL_LIMIT || !/^https?:\/\/[^\u0000- \u007f-\u009f]+$/u.test(value)) throw new ServiceError('invalid_url');
  try { new URL(value); } catch { throw new ServiceError('invalid_url'); }
  return value;
}
function day(value: unknown): string | null {
  if (value === null) return null;
  const result = date(value);
  if (!result) throw new ServiceError('invalid_date');
  return result;
}
function choice(value: unknown, allowed: readonly string[], code: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new ServiceError(code);
  return value;
}
export function caseNumber(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !NUMBER.test(value)) throw new ServiceError('invalid_case_number');
  return value;
}
/** Validate an authenticator-supplied app principal; anything malformed is unauthenticated. */
export function appPrincipal(value: unknown): AppPrincipal {
  const invalid = (): never => { throw new ServiceError('unauthorized', 401); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  const allowed = ['kind', 'workspace_id', 'app', 'sources', 'tenants'];
  if (Object.keys(data).length !== allowed.length || allowed.some(key => !Object.hasOwn(data, key))) return invalid();
  if (data.kind !== 'app' || typeof data.app !== 'string' || !CASE_SOURCE.test(data.app)) return invalid();
  const list = (items: unknown, valid: (item: string) => boolean): string[] => {
    if (!Array.isArray(items) || items.length === 0 || items.some(item => typeof item !== 'string')) return invalid();
    const values = items as string[];
    if (new Set(values).size !== values.length || (values.includes('*') && values.length !== 1)) return invalid();
    if (values.some(item => item !== '*' && !valid(item))) return invalid();
    return [...values];
  };
  let workspace: string;
  try { workspace = uuid(data.workspace_id); } catch { return invalid(); }
  return { kind: 'app', workspace_id: workspace, app: data.app,
    sources: list(data.sources, item => CASE_SOURCE.test(item)),
    tenants: list(data.tenants, item => { try { return ref(item, false) === item; } catch { return false; } }) };
}
const isApp = (principal: CasePrincipal): boolean =>
  principal !== null && typeof principal === 'object' && (principal as { kind?: unknown }).kind === 'app';
function visible(scope: Scope, row: Case): boolean {
  return (scope.sources === '*' || scope.sources.includes(row.source))
    && (scope.tenants === '*' || (row.tenant_ref !== null && scope.tenants.includes(row.tenant_ref)))
    && (scope.numbers === null || scope.numbers.includes(row.number));
}
function tracked(before: Case | null, after: Case): Change[] {
  return TRACKED.flatMap((field): Change[] => {
    const previous = before === null ? null : before[field];
    return previous === after[field] ? [] : [{ field, before: previous, after: after[field] }];
  });
}

export class CaseService {
  private readonly config: CaseSettings | null;
  constructor(private readonly dependencies: ServiceDependencies) {
    // Fail at startup, not on the first request, when settings are malformed.
    this.config = dependencies.caseSettings === undefined ? null : caseSettings(dependencies.caseSettings);
  }
  private settings(): CaseSettings {
    if (!this.config) throw new ServiceError('cases_not_enabled', 404);
    return this.config;
  }
  private port(tx: StoreSession): CasePort {
    if (!tx.cases) throw new ServiceError('cases_not_enabled', 404);
    return tx.cases;
  }
  /** [member_access] enabled = true in the startup settings; false by default. */
  private memberAccess(): boolean {
    return this.config?.member_access.enabled === true;
  }
  /** The member-scope API exists only while member access is enabled. */
  private memberAccessSettings(): void {
    this.settings();
    if (!this.memberAccess()) throw new ServiceError('member_access_not_enabled', 404);
  }
  private scopes(tx: StoreSession): CaseMemberScopePort {
    if (!tx.caseMemberScopes) throw new ServiceError('cases_not_enabled', 404);
    return tx.caseMemberScopes;
  }
  private now(): string {
    // Every stored time is UTC; a non-UTC clock is rejected instead of converted.
    return timestamp(this.dependencies.clock.now());
  }
  private async workspace(tx: StoreSession, w: string): Promise<void> {
    const workspace = await tx.workspaces.get(w);
    if (!workspace || workspace.workspace_id !== w) throw new ServiceError('not_found', 404);
    if (workspace.schema_version !== 3) throw new ConflictError('sharing_not_enabled');
  }
  /**
   * Authenticate the caller inside the operation's snapshot/transaction. A member
   * carries its persisted active workspace row, or null; asserted roles never count.
   */
  private async caller(tx: StoreSession, principal: CasePrincipal, w: string): Promise<Caller> {
    uuid(w);
    if (principal === null || typeof principal !== 'object') throw new ServiceError('unauthorized', 401);
    if (isApp(principal)) {
      const app = appPrincipal(principal);
      if (app.workspace_id !== w) throw new ServiceError('not_found', 404);
      await this.workspace(tx, w);
      return { kind: 'app', app };
    }
    const member = principal as Principal;
    if (typeof member.member_id !== 'string') throw new ServiceError('unauthorized', 401);
    uuid(member.member_id);
    if (member.active !== true) throw new ServiceError('member_inactive', 403);
    if (member.workspace_id !== w) throw new ServiceError('not_found', 404);
    await this.workspace(tx, w);
    const rows = (await tx.memberships.list(w)).filter((row): row is WorkspaceMembership =>
      row.scope === 'workspace' && row.workspace_id === w && row.member_id === member.member_id);
    const row = rows[0];
    return { kind: 'member', member_id: member.member_id,
      row: rows.length === 1 && row && row.scope === 'workspace' && row.active === true ? row : null };
  }
  /** Resolve the caller's visible scope inside the same snapshot/transaction as the operation. */
  private async scope(tx: StoreSession, principal: CasePrincipal, w: string): Promise<Scope> {
    const caller = await this.caller(tx, principal, w);
    if (caller.kind === 'app') {
      const { app } = caller;
      return { actor: { kind: 'app', app: app.app }, sources: app.sources[0] === '*' ? '*' : app.sources,
        tenants: app.tenants[0] === '*' ? '*' : app.tenants, numbers: null, write: true };
    }
    const actor: Actor = { kind: 'member', member_id: caller.member_id };
    // A persisted active owner sees every case; project grants and asserted roles do not count.
    if (caller.row?.role === 'owner') return { actor, sources: '*', tenants: '*', numbers: null, write: true };
    // Member access disabled (the default): the scope table is not even read, and
    // every other member is refused exactly as before.
    if (!this.memberAccess() || caller.row?.role !== 'member') throw new ServiceError('forbidden', 403);
    // Read on every request, so a revocation applies to the very next one.
    const grant = activeCaseMemberScope(await this.scopes(tx).get(w, caller.member_id), w, caller.member_id);
    if (!grant) throw new ServiceError('forbidden', 403);
    return { actor, sources: grant.sources, tenants: grant.tenants, numbers: grant.numbers, write: grant.role === 'editor' };
  }
  /** A viewer scope reads only; the check does not depend on any case, so it reveals nothing. */
  private writable(scope: Scope): void {
    if (!scope.write) throw new ServiceError('forbidden', 403);
  }
  /** Only a persisted active workspace owner manages member scopes; returns the owner's member_id. */
  private async owner(tx: StoreSession, principal: CasePrincipal, w: string): Promise<string> {
    const caller = await this.caller(tx, principal, w);
    if (caller.kind !== 'member' || caller.row?.role !== 'owner') throw new ServiceError('forbidden', 403);
    return caller.member_id;
  }
  /** A case outside the scope is indistinguishable from a missing one. */
  private async visibleCase(port: CasePort, scope: Scope, w: string, number: string): Promise<Case> {
    const row = await port.get(w, number);
    if (!row || row.workspace_id !== w || row.number !== number || !visible(scope, row)) throw new ServiceError('not_found', 404);
    return row;
  }

  async create(principal: CasePrincipal, w: string, input: unknown): Promise<CaseCreated> {
    const settings = this.settings();
    const data = fields(input, CREATE_FIELDS, ['origin', 'kind', 'title', 'body']);
    const origin = choice(data.origin, ORIGINS, 'invalid_origin') as Case['origin'];
    const kind = choice(data.kind, settings.kinds.values, 'invalid_kind');
    const caseTitle = title(data.title);
    const caseBody = body(data.body);
    const reporter = ref(given(data, 'reporter_ref'));
    const fingerprint = ref(given(data, 'fingerprint'));
    if (origin === 'detected' && reporter !== null) throw new ServiceError('reporter_not_allowed');
    if (origin === 'human' && fingerprint !== null) throw new ServiceError('fingerprint_not_allowed');
    const rawPlace = Object.hasOwn(data, 'place') ? fields(data.place, PLACE, []) : {};
    const place = { screen_id: ref(given(rawPlace, 'screen_id')), feature_id: ref(given(rawPlace, 'feature_id')),
      environment: ref(given(rawPlace, 'environment')), version: ref(given(rawPlace, 'version')), url: url(given(rawPlace, 'url')) };
    const legacy = ref(given(data, 'legacy_ref'));
    const promised = day(given(data, 'promised_due'));
    const requestedTenant = ref(given(data, 'tenant_ref'));
    return this.dependencies.store.transaction(async tx => {
      const scope = await this.scope(tx, principal, w);
      // source comes from the authenticated scope, never from the body.
      if (scope.actor.kind !== 'app' || scope.sources === '*' || scope.sources.length !== 1) throw new ServiceError('source_not_fixed', 403);
      const source = scope.sources[0]!;
      let tenant: string | null;
      if (requestedTenant === null) {
        if (scope.tenants === '*') tenant = null;
        else if (scope.tenants.length === 1) tenant = scope.tenants[0]!;
        else throw new ServiceError('tenant_required');
      } else {
        if (scope.tenants !== '*' && !scope.tenants.includes(requestedTenant)) throw new ServiceError('forbidden', 403);
        tenant = requestedTenant;
      }
      const port = this.port(tx);
      if (legacy !== null) {
        const existing = await port.findByLegacyRef(w, source, legacy);
        if (existing) {
          if (existing.workspace_id !== w || existing.source !== source || existing.legacy_ref !== legacy) throw new ServiceError('not_found', 404);
          // The same (source, legacy_ref) never makes a second case; resending returns the issued number.
          if (!visible(scope, existing)) throw new ConflictError('duplicate_id');
          return { number: existing.number, status: existing.status };
        }
      }
      const now = this.now();
      const seq = integer(await port.allocate(w, source), 1, 'invalid_sequence');
      const number = caseNumber(`${source}-${seq}`);
      const record: Case = { workspace_id: w, number, source, tenant_ref: tenant, seq, origin, kind,
        status: settings.statuses.initial,
        approval_state: settings.kinds.requires_approval.includes(kind) ? settings.approval_states.initial : settings.approval_states.initial_free,
        title: caseTitle, body: caseBody, reporter_ref: reporter, ...place, fingerprint, promised_due: promised, hold_until: null, closed_at: null, duplicate_of: null, legacy_ref: legacy,
        revision: 1, created_at: now, updated_at: now };
      await port.put(record, null);
      await port.appendEvent({ workspace_id: w, case_number: number, seq: 1, action: 'create', actor: scope.actor,
        actor_ref: null, reason: null, at_utc: now, changes: tracked(null, record) as CaseEvent['changes'] });
      return { number, status: record.status };
    });
  }

  /** Every visible row, in created_at, source and seq order (code points, so every adapter agrees). */
  private async visibleRows(tx: StoreSession, scope: Scope, w: string): Promise<Case[]> {
    return (await this.port(tx).list(w)).filter(row => row.workspace_id === w && visible(scope, row))
      .sort((a, b) => compareTimestamps(a.created_at, b.created_at) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || a.seq - b.seq);
  }

  /**
   * Open cases whose hold_until has come or whose promised_due has passed come
   * first; each group keeps created_at, source, seq order. evidence_missing marks
   * terminal cases without any case_links row. Both are derived, never stored.
   */
  async list(principal: CasePrincipal, w: string): Promise<CaseListItem[]> {
    const settings = this.settings();
    const today = this.now().slice(0, 10);
    return this.dependencies.store.read(async tx => {
      const scope = await this.scope(tx, principal, w);
      const port = this.port(tx);
      const items: CaseListItem[] = [];
      for (const row of await this.visibleRows(tx, scope, w)) {
        const missing = settings.statuses.terminal.includes(row.status) && (await port.links(w, row.number)).length === 0;
        items.push({ ...row, evidence_missing: missing });
      }
      const attention = items.filter(row => needsAttention(settings, row, today));
      return [...attention, ...items.filter(row => !attention.includes(row))];
    });
  }

  /**
   * The four panels over open cases in the caller's scope. Only an operator
   * (owner, or an app or member scope whose sources and tenants are both ["*"]
   * and that lists no numbers) gets by_source.
   */
  async panels(principal: CasePrincipal, w: string): Promise<CasePanels> {
    const settings = this.settings();
    const today = this.now().slice(0, 10);
    return this.dependencies.store.read(async tx => {
      const scope = await this.scope(tx, principal, w);
      return casePanels(settings, await this.visibleRows(tx, scope, w), today,
        scope.sources === '*' && scope.tenants === '*' && scope.numbers === null);
    });
  }

  /**
   * The validated settings (identifiers, open/terminal, waiting map, labels and
   * source display names) that a screen needs to show display words instead of
   * identifiers. A persisted active owner reads them, and so does a member with
   * a case scope (only the display names of sources in that scope); an app never does.
   */
  async settingsView(principal: CasePrincipal, w: string): Promise<CaseSettings> {
    const settings = this.settings();
    return this.dependencies.store.read(async tx => {
      const scope = await this.scope(tx, principal, w);
      this.port(tx);
      if (scope.actor.kind !== 'member') throw new ServiceError('forbidden', 403);
      // A copy: no caller can change what the next caller reads.
      const copy = structuredClone(settings) as { -readonly [K in keyof CaseSettings]: CaseSettings[K] };
      const sources = scope.sources;
      if (sources !== '*') {
        // Other apps' names are not cases, but they are not this member's business either.
        copy.numbering = { display_names: Object.fromEntries(Object.entries(settings.numbering.display_names)
          .filter(([source]) => sources.includes(source))) };
      }
      return copy;
    });
  }

  async read(principal: CasePrincipal, w: string, number: string): Promise<CaseDetail> {
    this.settings();
    caseNumber(number);
    return this.dependencies.store.read(async tx => {
      const scope = await this.scope(tx, principal, w);
      const port = this.port(tx);
      const row = await this.visibleCase(port, scope, w, number);
      const bySeq = <T extends { seq: number }>(items: T[]): T[] => items.sort((a, b) => a.seq - b.seq);
      return { case: row, people: await port.people(w, number), replies: bySeq(await port.replies(w, number)),
        links: await port.links(w, number), events: bySeq(await port.events(w, number)) };
    });
  }

  async update(principal: CasePrincipal, w: string, number: string, input: unknown): Promise<Case> {
    const settings = this.settings();
    caseNumber(number);
    const data = fields(input, PATCH_FIELDS, ['expected_revision']);
    const expected = integer(data.expected_revision);
    if (!PATCHABLE.some(key => Object.hasOwn(data, key))) throw new ServiceError('no_changes');
    const requested: Partial<Pick<Case, typeof PATCHABLE[number]>> = {};
    if (Object.hasOwn(data, 'status')) requested.status = choice(data.status, settings.statuses.values, 'invalid_status');
    if (Object.hasOwn(data, 'approval_state')) requested.approval_state = choice(data.approval_state, settings.approval_states.values, 'invalid_approval_state');
    if (Object.hasOwn(data, 'promised_due')) requested.promised_due = day(data.promised_due);
    if (Object.hasOwn(data, 'hold_until')) requested.hold_until = day(data.hold_until);
    const reason = Object.hasOwn(data, 'reason') ? text(data.reason, true, 240) : null;
    const actorRef = ref(given(data, 'actor_ref'));
    return this.dependencies.store.transaction(async tx => {
      const scope = await this.scope(tx, principal, w);
      this.writable(scope);
      const port = this.port(tx);
      const current = await this.visibleCase(port, scope, w, number);
      if (current.revision !== expected) throw new ConflictError('version_conflict');
      const next: Case = { ...current, ...requested };
      if (next.approval_state !== current.approval_state && !settings.kinds.requires_approval.includes(current.kind)
        && next.approval_state !== settings.approval_states.initial_free) throw new ServiceError('approval_not_required');
      if (next.hold_until !== null && next.approval_state !== settings.approval_states.hold) throw new ServiceError('hold_until_requires_hold');
      const now = this.now();
      // Derived from the received status, never a rewrite of it.
      const wasTerminal = settings.statuses.terminal.includes(current.status);
      const isTerminal = settings.statuses.terminal.includes(next.status);
      if (!isTerminal) next.closed_at = null;
      else if (!wasTerminal) next.closed_at = now;
      const diff = tracked(current, next);
      // An unchanged request still passes scope and revision checks but writes nothing.
      if (diff.length === 0) return current;
      next.revision = current.revision + 1;
      next.updated_at = now;
      await port.put(next, expected);
      const seq = (await port.events(w, number)).length + 1;
      await port.appendEvent({ workspace_id: w, case_number: number, seq, action: 'update', actor: scope.actor,
        actor_ref: actorRef, reason, at_utc: now, changes: diff as CaseEvent['changes'] });
      return next;
    });
  }

  async addPerson(principal: CasePrincipal, w: string, number: string, input: unknown): Promise<CasePerson> {
    this.settings();
    caseNumber(number);
    const data = fields(input, ['reporter_ref'], ['reporter_ref']);
    const reporter = ref(data.reporter_ref, false)!;
    return this.dependencies.store.transaction(async tx => {
      const scope = await this.scope(tx, principal, w);
      this.writable(scope);
      const port = this.port(tx);
      await this.visibleCase(port, scope, w, number);
      const existing = (await port.people(w, number)).find(row => row.reporter_ref === reporter);
      if (existing) return existing;
      const person: CasePerson = { workspace_id: w, case_number: number, reporter_ref: reporter, added_by: scope.actor, created_at: this.now() };
      await port.addPerson(person);
      return person;
    });
  }

  async addReply(principal: CasePrincipal, w: string, number: string, input: unknown): Promise<CaseReply> {
    this.settings();
    caseNumber(number);
    const data = fields(input, ['body', 'author_ref', 'delivered_at'], ['body']);
    const replyBody = body(data.body, true);
    const author = ref(given(data, 'author_ref'));
    const delivered = given(data, 'delivered_at') === null ? null : timestamp(data.delivered_at);
    return this.dependencies.store.transaction(async tx => {
      const scope = await this.scope(tx, principal, w);
      this.writable(scope);
      const port = this.port(tx);
      await this.visibleCase(port, scope, w, number);
      const reply: CaseReply = { workspace_id: w, case_number: number, seq: (await port.replies(w, number)).length + 1,
        body: replyBody, author: scope.actor, author_ref: author, created_at: this.now(), delivered_at: delivered };
      await port.addReply(reply);
      return reply;
    });
  }

  async addLink(principal: CasePrincipal, w: string, number: string, input: unknown): Promise<CaseLink> {
    this.settings();
    caseNumber(number);
    const data = fields(input, ['link_type', 'ref'], ['link_type', 'ref']);
    const type = choice(data.link_type, LINK_TYPES, 'invalid_link_type') as CaseLink['link_type'];
    const target = data.ref;
    if (typeof target !== 'string' || !target || target.length > URL_LIMIT || /[\u0000- \u007f-\u009f]/u.test(target)) throw new ServiceError('invalid_link');
    if (type === 'commit' && !/^[0-9a-f]{7,64}$/.test(target)) throw new ServiceError('invalid_link');
    if (type === 'url') {
      try { url(target); } catch { throw new ServiceError('invalid_link'); }
    }
    return this.dependencies.store.transaction(async tx => {
      const scope = await this.scope(tx, principal, w);
      this.writable(scope);
      const port = this.port(tx);
      await this.visibleCase(port, scope, w, number);
      // (case, link_type, ref) is unique: resending the same evidence adds nothing.
      const existing = (await port.links(w, number)).find(row => row.link_type === type && row.ref === target);
      if (existing) return existing;
      const link: CaseLink = { workspace_id: w, case_number: number, link_type: type, ref: target, added_by: scope.actor, created_at: this.now() };
      await port.addLink(link);
      return link;
    });
  }

  /** Owner only: every member scope (revoked ones included) and the grant history. */
  async memberScopes(principal: CasePrincipal, w: string): Promise<CaseMemberScopeCollection> {
    this.memberAccessSettings();
    return this.dependencies.store.read(async tx => {
      await this.owner(tx, principal, w);
      const port = this.scopes(tx);
      return { items: sortCaseMemberScopes((await port.list(w)).filter(row => row.workspace_id === w)),
        events: sortCaseMemberScopeEvents((await port.events(w)).filter(row => row.workspace_id === w)) };
    });
  }

  /** The caller's own active scope; no member reads another's. Owners need none (404). */
  async myMemberScope(principal: CasePrincipal, w: string): Promise<CaseMemberScope> {
    this.memberAccessSettings();
    return this.dependencies.store.read(async tx => {
      const caller = await this.caller(tx, principal, w);
      if (caller.kind !== 'member' || !caller.row) throw new ServiceError('forbidden', 403);
      if (caller.row.role !== 'member') throw new ServiceError('not_found', 404);
      const row = await this.scopes(tx).get(w, caller.member_id);
      if (!row || !activeCaseMemberScope(row, w, caller.member_id)) throw new ServiceError('not_found', 404);
      return row;
    });
  }

  /**
   * Owner only: grant (role viewer/editor), change, or revoke (role null) one
   * member's scope, with exactly one history event per effective change in the
   * same transaction. The target is an active member (role member) of this
   * workspace; a revocation also accepts an inactive one.
   */
  async setMemberScope(principal: CasePrincipal, w: string, memberId: string, input: unknown): Promise<CaseMemberScope> {
    this.memberAccessSettings();
    uuid(memberId);
    const request = caseMemberScopeRequest(input);
    return this.dependencies.store.transaction(async tx => {
      const owner = await this.owner(tx, principal, w);
      const port = this.scopes(tx);
      const rows = (await tx.memberships.list(w)).filter((row): row is WorkspaceMembership =>
        row.scope === 'workspace' && row.workspace_id === w && row.member_id === memberId);
      const target = rows[0];
      if (rows.length !== 1 || !target || target.role !== 'member' || (request.role !== null && target.active !== true)) {
        throw new ServiceError('invalid_member', 403);
      }
      const current = await port.get(w, memberId);
      if (current && (current.workspace_id !== w || current.member_id !== memberId)) throw new ServiceError('invalid_grant');
      if ((current?.revision ?? 0) !== request.expected_revision) throw new ConflictError('version_conflict');
      if (request.role === null && (!current || current.role === null)) throw new ServiceError('invalid_grant');
      const now = this.now();
      const next: CaseMemberScope = { workspace_id: w, member_id: memberId, role: request.role, sources: request.sources,
        tenants: request.tenants, numbers: request.numbers, revision: request.expected_revision + 1, updated_by: owner, updated_at: now };
      // An identical request still passes the owner and revision checks but writes nothing.
      if (current && sameCaseMemberScope(current, next)) return current;
      await port.put(next, request.expected_revision);
      const action: CaseMemberScopeEvent['action'] = !current || current.role === null ? 'grant' : request.role === null ? 'revoke' : 'change';
      await port.appendEvent({ workspace_id: w, seq: (await port.events(w)).length + 1, member_id: memberId, action,
        actor_member_id: owner, reason: request.reason, at_utc: now, before: current, after: next });
      return next;
    });
  }
}
