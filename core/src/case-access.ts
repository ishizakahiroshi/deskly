/**
 * Case scopes of workspace members ([member_access] in the case settings; off by
 * default). A member scope uses the same source x tenant rule as a sending app,
 * optionally narrowed to explicit case numbers (an external collaborator), plus a
 * role: viewer reads only, editor also writes. This module holds the request and
 * stored-row validation, the storage rules every adapter applies and the
 * in-memory port; the case service decides who may use them.
 */
import { ConflictError, ServiceError } from './ports.js';
import type { CaseMemberScope, CaseMemberScopeEvent, CaseMemberScopePort } from './ports.js';
import { CASE_SOURCE } from './case-settings.js';
import { checkNextSeq } from './case-rules.js';
import { integer, object, text } from './service-validation.js';

export type CaseMemberRole = 'viewer' | 'editor';
const ROLES: readonly CaseMemberRole[] = ['viewer', 'editor'];
const REQUEST_FIELDS = ['expected_revision', 'role', 'sources', 'tenants', 'numbers', 'reason'];
const LIST_FIELDS = ['sources', 'tenants', 'numbers'];
const LIST_LIMIT = 200;
const NUMBER_LIMIT = 1000;
const REF_LIMIT = 200;
const NUMBER = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9_])?-[1-9][0-9]{0,14}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** A validated PUT body: role null revokes and carries empty lists. */
export interface CaseMemberScopeRequest {
  expected_revision: number;
  role: CaseMemberRole | null;
  sources: string[];
  tenants: string[];
  numbers: string[];
  reason: string | null;
}
/** What an active stored scope lets its member see; null numbers means "not narrowed". */
export interface ActiveCaseMemberScope {
  role: CaseMemberRole;
  sources: '*' | readonly string[];
  tenants: '*' | readonly string[];
  numbers: readonly string[] | null;
}

const validSource = (item: string): boolean => CASE_SOURCE.test(item);
const validTenant = (item: string): boolean => [...item].length <= REF_LIMIT && !CONTROL.test(item) && item.trim() !== '';
const validNumber = (item: string): boolean => item.length <= 80 && NUMBER.test(item);
/** Distinct strings, "*" only as the single item when allowed; null when anything is off. */
function list(value: unknown, valid: (item: string) => boolean, all: boolean, minimum: number, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > limit) return null;
  if (value.some(item => typeof item !== 'string')) return null;
  const items = value as string[];
  if (new Set(items).size !== items.length) return null;
  if (items.includes('*') ? !all || items.length !== 1 : items.some(item => !valid(item))) return null;
  return [...items];
}

/** Validate a PUT .../cases/member-scopes/{member_id} body. Nothing is trimmed or reordered. */
export function caseMemberScopeRequest(input: unknown): CaseMemberScopeRequest {
  const data = object(input, 'invalid_request');
  if (Object.keys(data).some(key => !REQUEST_FIELDS.includes(key))) throw new ServiceError('invalid_fields');
  for (const key of ['expected_revision', 'role']) if (!Object.hasOwn(data, key)) throw new ServiceError('required_field');
  const expected = integer(data.expected_revision, 0);
  if (data.role !== null && !(ROLES as readonly unknown[]).includes(data.role)) throw new ServiceError('invalid_role');
  const role = data.role as CaseMemberRole | null;
  const reason = Object.hasOwn(data, 'reason') ? text(data.reason, true, 240) : null;
  if (role === null) {
    // A revocation grants nothing, so it carries no lists; there must be something to revoke.
    if (LIST_FIELDS.some(key => Object.hasOwn(data, key))) throw new ServiceError('invalid_fields');
    if (expected === 0) throw new ServiceError('invalid_grant');
    return { expected_revision: expected, role, sources: [], tenants: [], numbers: [], reason };
  }
  if (!Object.hasOwn(data, 'sources') || !Object.hasOwn(data, 'tenants')) throw new ServiceError('required_field');
  const sources = list(data.sources, validSource, true, 1, LIST_LIMIT);
  const tenants = list(data.tenants, validTenant, true, 1, LIST_LIMIT);
  const numbers = Object.hasOwn(data, 'numbers') ? list(data.numbers, validNumber, false, 0, NUMBER_LIMIT) : [];
  if (!sources || !tenants || !numbers) throw new ServiceError('invalid_scope');
  return { expected_revision: expected, role, sources, tenants, numbers, reason };
}

/**
 * The visible scope of a stored row, or null when it grants nothing: absent,
 * revoked, for another workspace or member, or malformed (fail closed).
 */
export function activeCaseMemberScope(row: CaseMemberScope | null, workspaceId: string, memberId: string): ActiveCaseMemberScope | null {
  if (!row || typeof row !== 'object' || row.workspace_id !== workspaceId || row.member_id !== memberId) return null;
  if (!(ROLES as readonly unknown[]).includes(row.role)) return null;
  const sources = list(row.sources, validSource, true, 1, LIST_LIMIT);
  const tenants = list(row.tenants, validTenant, true, 1, LIST_LIMIT);
  const numbers = list(row.numbers, validNumber, false, 0, NUMBER_LIMIT);
  if (!sources || !tenants || !numbers) return null;
  return { role: row.role as CaseMemberRole, sources: sources[0] === '*' ? '*' : sources, tenants: tenants[0] === '*' ? '*' : tenants,
    numbers: numbers.length === 0 ? null : numbers };
}

/** True when two rows give the same role and lists (in the same order). */
export function sameCaseMemberScope(a: CaseMemberScope, b: CaseMemberScope): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((item, index) => item === y[index]);
  return a.role === b.role && same(a.sources, b.sources) && same(a.tenants, b.tenants) && same(a.numbers, b.numbers);
}

/**
 * CaseMemberScopePort.put: 0 is create-only (an existing row is duplicate_id);
 * otherwise the stored revision must equal expected. Either way the new revision
 * is exactly expected + 1. Every adapter applies this before it writes.
 */
export function checkCaseMemberScopePut(current: CaseMemberScope | null, value: CaseMemberScope, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || value.revision !== expected + 1) throw new ConflictError('version_conflict');
  if (expected === 0) {
    if (current) throw new ConflictError('duplicate_id');
  } else if (!current || current.revision !== expected) throw new ConflictError('version_conflict');
}

const byMember = (a: CaseMemberScope, b: CaseMemberScope): number => (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : 0);
const bySeq = (a: CaseMemberScopeEvent, b: CaseMemberScopeEvent): number => a.seq - b.seq;
/** Rows of one workspace, in the port's documented order. */
export const sortCaseMemberScopes = (rows: CaseMemberScope[]): CaseMemberScope[] => rows.sort(byMember);
export const sortCaseMemberScopeEvents = (rows: CaseMemberScopeEvent[]): CaseMemberScopeEvent[] => rows.sort(bySeq);

export interface CaseMemberScopeTables {
  /** Keyed by (workspace, member). */
  scopes: Map<string, CaseMemberScope>;
  /** Keyed by workspace; each list is in seq order. */
  events: Map<string, CaseMemberScopeEvent[]>;
}
export function createCaseMemberScopeTables(): CaseMemberScopeTables {
  return { scopes: new Map(), events: new Map() };
}
/** Map keys of CaseMemberScopeTables. */
export const caseMemberScopeKey = (...values: string[]): string => JSON.stringify(values);
const copy = <T>(value: T): T => structuredClone(value);

/** `check(true)` must throw outside a write transaction; `check()` outside any open session. */
export function caseMemberScopeMemoryPort(t: CaseMemberScopeTables, check: (writing?: boolean) => void): CaseMemberScopePort {
  const key = caseMemberScopeKey;
  return {
    get: async (w, member) => { check(); return copy(t.scopes.get(key(w, member)) ?? null); },
    list: async (w) => { check(); return copy(sortCaseMemberScopes([...t.scopes.values()].filter(row => row.workspace_id === w))); },
    put: async (value, expected) => {
      check(true);
      const id = key(value.workspace_id, value.member_id);
      checkCaseMemberScopePut(t.scopes.get(id) ?? null, value, expected);
      t.scopes.set(id, copy(value));
    },
    events: async (w) => { check(); return copy(t.events.get(key(w)) ?? []); },
    appendEvent: async (value) => {
      check(true);
      if (!t.scopes.has(key(value.workspace_id, value.member_id))) throw new ServiceError('not_found', 404);
      const id = key(value.workspace_id);
      const existing = t.events.get(id) ?? [];
      checkNextSeq(value.seq, existing.length);
      t.events.set(id, [...existing, copy(value)]);
    },
  };
}
