/**
 * In-memory CasePort for the reference MemoryStore. The D1 adapter reuses it over
 * its immutable snapshot; SQLite applies the same rules from case-rules.ts.
 */
import { ConflictError, ServiceError } from './ports.js';
import type { Case, CaseEvent, CaseLink, CasePerson, CasePort, CaseReply } from './ports.js';
import { checkCasePut, checkNextSeq } from './case-rules.js';

export interface CaseTables {
  cases: Map<string, Case>;
  /** case_number_sequences: one row per (workspace, source) holding the next seq. */
  sequences: Map<string, number>;
  events: Map<string, CaseEvent[]>;
  people: Map<string, CasePerson[]>;
  replies: Map<string, CaseReply[]>;
  links: Map<string, CaseLink[]>;
}
export function createCaseTables(): CaseTables {
  return { cases: new Map(), sequences: new Map(), events: new Map(), people: new Map(), replies: new Map(), links: new Map() };
}
const copy = <T>(value: T): T => structuredClone(value);
/** Map key of every CaseTables entry: (workspace, number) or, for sequences, (workspace, source). */
export const caseTableKey = (...values: string[]): string => JSON.stringify(values);
const key = caseTableKey;

/** `check(true)` must throw outside a write transaction; `check()` outside any open session. */
export function caseMemoryPort(t: CaseTables, check: (writing?: boolean) => void): CasePort {
  const parent = (workspaceId: string, number: string): string => {
    const id = key(workspaceId, number);
    if (!t.cases.has(id)) throw new ServiceError('not_found', 404);
    return id;
  };
  const rows = <T>(map: Map<string, T[]>, workspaceId: string, number: string): T[] =>
    copy(map.get(key(workspaceId, number)) ?? []);
  const append = <T>(map: Map<string, T[]>, id: string, value: T): void => {
    map.set(id, [...(map.get(id) ?? []), copy(value)]);
  };
  return {
    get: async (w, number) => { check(); return copy(t.cases.get(key(w, number)) ?? null); },
    list: async (w) => {
      check();
      return copy([...t.cases.values()].filter(row => row.workspace_id === w)
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || a.seq - b.seq));
    },
    findByLegacyRef: async (w, source, legacyRef) => {
      check();
      return copy([...t.cases.values()].find(row => row.workspace_id === w && row.source === source
        && row.legacy_ref === legacyRef) ?? null);
    },
    allocate: async (w, source) => {
      check(true);
      const id = key(w, source);
      const next = t.sequences.get(id) ?? 1;
      t.sequences.set(id, next + 1);
      return next;
    },
    put: async (value, expected) => {
      check(true);
      const id = key(value.workspace_id, value.number);
      checkCasePut(t.cases.get(id) ?? null, value, expected, () => [...t.cases.values()].some(row =>
        row.workspace_id === value.workspace_id && row.source === value.source && row.legacy_ref === value.legacy_ref));
      t.cases.set(id, copy(value));
    },
    events: async (w, number) => { check(); return rows(t.events, w, number); },
    appendEvent: async (value) => {
      check(true);
      const id = parent(value.workspace_id, value.case_number);
      checkNextSeq(value.seq, t.events.get(id)?.length ?? 0);
      append(t.events, id, value);
    },
    people: async (w, number) => { check(); return rows(t.people, w, number); },
    addPerson: async (value) => {
      check(true);
      const id = parent(value.workspace_id, value.case_number);
      if ((t.people.get(id) ?? []).some(row => row.reporter_ref === value.reporter_ref)) throw new ConflictError('duplicate_id');
      append(t.people, id, value);
    },
    replies: async (w, number) => { check(); return rows(t.replies, w, number); },
    addReply: async (value) => {
      check(true);
      const id = parent(value.workspace_id, value.case_number);
      checkNextSeq(value.seq, t.replies.get(id)?.length ?? 0);
      append(t.replies, id, value);
    },
    links: async (w, number) => { check(); return rows(t.links, w, number); },
    addLink: async (value) => {
      check(true);
      const id = parent(value.workspace_id, value.case_number);
      if ((t.links.get(id) ?? []).some(row => row.link_type === value.link_type && row.ref === value.ref)) throw new ConflictError('duplicate_id');
      append(t.links, id, value);
    },
  };
}
