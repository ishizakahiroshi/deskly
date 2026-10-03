/** Optimistic serializable D1 adapter: immutable batch snapshot, buffered writes,
 * then guarded CAS + history in one atomic batch. No callback replay or BEGIN. */
import type { D1Driver, D1Statement, D1Value } from './driver.js';
import { batch } from './driver.js';
import { migrate } from './migrate.js';
// A complete ordered snapshot conservatively guards every read, absence, list and
// authorization assumption (including phantoms). Independent rows may conflict.
const tables = ['workspaces', 'accounts', 'resources', 'workspace_memberships',
  'project_memberships', 'source_memberships', 'contacts', 'events',
  'case_number_sequences', 'cases', 'case_events', 'case_people', 'case_replies', 'case_links',
  'case_member_scopes', 'case_member_scope_events'] as const;
// The column order is also the snapshot order: case children arrive per case in
// seq/position (insertion) order, so the in-memory arrays keep the stored order.
const columns = [
  ['workspace_id', 'data'], ['subject', 'data'],
  ['workspace_id', 'id', 'type', 'project_id', 'version', 'data'],
  ['workspace_id', 'member_id', 'version', 'data'],
  ['workspace_id', 'member_id', 'project_id', 'version', 'data'],
  ['workspace_id', 'member_id', 'source_id', 'version', 'data'],
  ['workspace_id', 'source_id', 'contact_id', 'version', 'data'],
  ['workspace_id', 'operation_id', 'kind', 'source_id', 'contact_id', 'requester_member_id', 'data'],
  ['workspace_id', 'source', 'next_seq'],
  ['workspace_id', 'number', 'source', 'seq', 'legacy_ref', 'revision', 'data'],
  ['workspace_id', 'case_number', 'seq', 'data'],
  ['workspace_id', 'case_number', 'position', 'reporter_ref', 'data'],
  ['workspace_id', 'case_number', 'seq', 'data'],
  ['workspace_id', 'case_number', 'position', 'link_type', 'ref', 'data'],
  ['workspace_id', 'member_id', 'revision', 'data'],
  ['workspace_id', 'seq', 'member_id', 'data'],
];
// One statement reads every table (one column per table), and one statement
// re-checks all of them at commit. Each D1 statement has a fixed round-trip cost,
// so the snapshot no longer grows by a statement per table; each column is still
// its own string, so the per-value size limit applies per table as before.
const parts = tables.map((table, index) =>
  `(SELECT json_group_array(json_array(${columns[index]!.join(', ')})) FROM
    (SELECT * FROM ${table} ORDER BY ${columns[index]!.join(', ')}))`);
const snapshot = `SELECT ${parts.map((part, index) => `${part} AS s${index}`).join(',\n  ')}`;
const guard = `INSERT INTO store_conditions(ok) SELECT 0 FROM (${snapshot})
  WHERE ${parts.map((_, index) => `s${index} IS NOT ?`).join(' OR ')}`;

import type { Account } from '../../generated/account.js';
import type { Event } from '../../generated/event.js';
import type { Membership } from '../../generated/membership.js';
import type { Workspace } from '../../generated/workspace.js';
import { compareTimestamps } from '../../service-validation.js';
import { ConflictError } from '../../ports.js';
import type { Case, CaseEvent, CaseLink, CaseMemberScope, CaseMemberScopeEvent, CasePerson, CaseReply, ContactEvent, ContactRecord,
  Entity, Store, StoreSession } from '../../ports.js';
import { caseMemoryPort, caseTableKey, createCaseTables } from '../../case-memory.js';
import type { CaseTables } from '../../case-memory.js';
import { caseMemberScopeKey, caseMemberScopeMemoryPort, createCaseMemberScopeTables } from '../../case-access.js';
import type { CaseMemberScopeTables } from '../../case-access.js';
interface State {
  workspaces: Map<string, Workspace>; resources: Map<string, Entity>;
  accounts: Map<string, Account>; memberships: Map<string, Membership>;
  events: Map<string, Event>; contacts: Map<string, ContactRecord>;
  contactEvents: Map<string, ContactEvent>;
  cases: CaseTables;
  caseMemberScopes: CaseMemberScopeTables;
}
const copy = <T>(value: T): T => structuredClone(value);
const key = (...values: string[]): string => JSON.stringify(values);
function membershipKey(v: Membership): string {
  return key(v.workspace_id, v.scope, v.member_id, v.scope === 'project' ? v.project_id : v.scope === 'source' ? v.source_id : '');
}
function cas(current: { version: number } | undefined, next: { version: number }, expected: number | null, grant = false): void {
  if (!Number.isSafeInteger(next.version) || next.version < 1 || (!grant && expected === 0) || (grant && expected === null)) throw new ConflictError('version_conflict');
  if (expected === null) {
    if (current) throw new ConflictError('duplicate_id');
    if (next.version !== 1) throw new ConflictError('version_conflict');
  } else if (!Number.isSafeInteger(expected) || expected < 0 || (current?.version ?? 0) !== expected || next.version !== expected + 1) {
    throw new ConflictError('version_conflict');
  }
}
export class D1Store implements Store {
  /**
   * Write transactions of this one adapter run one after another, each on a
   * snapshot taken after the previous commit, so they never conflict with each
   * other (concurrent case creations on one instance all get numbers). Other
   * instances and isolates stay optimistic: a racing loser gets version_conflict.
   */
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly driver: D1Driver) {}
  static async open(driver: D1Driver): Promise<D1Store> {
    await migrate(driver); return new D1Store(driver);
  }
  read<T>(run: (session: StoreSession) => Promise<T>): Promise<T> { return this.execute(false, run); }
  transaction<T>(run: (session: StoreSession) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.execute(true, run));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async execute<T>(write: boolean, run: (session: StoreSession) => Promise<T>): Promise<T> {
      const [initial] = await batch<Record<string, unknown>>(this.driver, [this.driver.prepare(snapshot)]);
      const serialized = tables.map((_, index) => {
        const value = initial?.results[0]?.[`s${index}`];
        if (typeof value !== 'string') throw new Error('Invalid D1 snapshot');
        return value;
      });
      const rows = <V>(index: number): V[] => (JSON.parse(serialized[index]!) as unknown[][])
        .map(row => JSON.parse(String(row.at(-1))) as V);
      const s: State = {
        workspaces: new Map(rows<Workspace>(0).map(value => [value.workspace_id, value])),
        accounts: new Map(rows<Account>(1).map(value => [value.subject, value])),
        resources: new Map(rows<Entity>(2).map(value => [key(value.workspace_id, value.id), value])),
        memberships: new Map([3, 4, 5].flatMap(index => rows<Membership>(index)).map(value => [membershipKey(value), value])),
        contacts: new Map(rows<ContactRecord>(6).map(value => [key(value.workspace_id, value.source_id, value.contact.id), value])),
        events: new Map(), contactEvents: new Map(), cases: createCaseTables(),
        caseMemberScopes: createCaseMemberScopeTables(),
      };
      for (const row of JSON.parse(serialized[7]!) as unknown[][]) {
        const value = JSON.parse(String(row.at(-1))) as Event | ContactEvent;
        const id = key(value.workspace_id, value.operation_id);
        if (row[2] === 'workspace') s.events.set(id, value as Event);
        else s.contactEvents.set(id, value as ContactEvent);
      }
      for (const row of JSON.parse(serialized[8]!) as unknown[][]) {
        const next = row[2];
        if (typeof next !== 'number' || !Number.isSafeInteger(next)) throw new Error('Invalid D1 snapshot');
        s.cases.sequences.set(caseTableKey(String(row[0]), String(row[1])), next);
      }
      for (const value of rows<Case>(9)) s.cases.cases.set(caseTableKey(value.workspace_id, value.number), value);
      const children = <V extends { workspace_id: string; case_number: string }>(map: Map<string, V[]>, index: number): void => {
        for (const value of rows<V>(index)) {
          const id = caseTableKey(value.workspace_id, value.case_number);
          const list = map.get(id);
          if (list) list.push(value); else map.set(id, [value]);
        }
      };
      children<CaseEvent>(s.cases.events, 10);
      children<CasePerson>(s.cases.people, 11);
      children<CaseReply>(s.cases.replies, 12);
      children<CaseLink>(s.cases.links, 13);
      for (const value of rows<CaseMemberScope>(14)) s.caseMemberScopes.scopes.set(caseMemberScopeKey(value.workspace_id, value.member_id), value);
      // Ordered by workspace, then seq: each workspace's list keeps the stored order.
      for (const value of rows<CaseMemberScopeEvent>(15)) {
        const id = caseMemberScopeKey(value.workspace_id);
        const list = s.caseMemberScopes.events.get(id);
        if (list) list.push(value); else s.caseMemberScopes.events.set(id, [value]);
      }
      const writes: D1Statement[] = [];
      const queue = (sql: string, ...values: D1Value[]): void => { writes.push(this.driver.prepare(sql).bind(...values)); };
      const changed = (): void => queue('INSERT INTO store_conditions(ok) SELECT 0 WHERE changes() <> 1');
      const append = (kind: 'workspace' | 'contact', value: Event | ContactEvent): void => {
        const contact = kind === 'contact' ? value as ContactEvent : null;
        queue(`INSERT INTO events(workspace_id, operation_id, kind, source_id, contact_id, requester_member_id, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, value.workspace_id, value.operation_id, kind,
          contact?.source_id ?? null, contact?.contact_id ?? null, value.requester_member_id, JSON.stringify(value));
      };
      let active = true;
      const check = (writing = false): void => {
        if (!active) throw new Error('Store session is closed');
        if (writing && !write) throw new Error('Read session is immutable');
      };
      const session: StoreSession = {
        workspaces: {
          get: async id => { check(); return copy(s.workspaces.get(id) ?? null); },
          put: async value => { check(true); s.workspaces.set(value.workspace_id, copy(value));
            queue(`INSERT INTO workspaces(workspace_id, data) VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data`, value.workspace_id, JSON.stringify(value)); },
        },
        accounts: {
          get: async subject => { check(); return copy(s.accounts.get(subject) ?? null); },
          put: async value => { check(true); s.accounts.set(value.subject, copy(value));
            queue(`INSERT INTO accounts(subject, data) VALUES (?, ?)
              ON CONFLICT(subject) DO UPDATE SET data = excluded.data`, value.subject, JSON.stringify(value)); },
        },
        resources: {
          get: async (w, id) => { check(); return copy(s.resources.get(key(w, id)) ?? null); },
          list: async w => { check(); return copy([...s.resources.values()].filter(v => v.workspace_id === w).sort((a, b) => a.id.localeCompare(b.id))); },
          put: async (value, expected) => {
            check(true); const id = key(value.workspace_id, value.id); const current = s.resources.get(id);
            cas(current, value, expected);
            if (current && (current.type !== value.type || current.project_id !== value.project_id)) throw new ConflictError('version_conflict');
            s.resources.set(id, copy(value));
            if (!current) queue(`INSERT INTO resources(workspace_id, id, type, project_id, version, data) VALUES (?, ?, ?, ?, ?, ?)`,
              value.workspace_id, value.id, value.type, value.project_id, value.version, JSON.stringify(value));
            else {
              queue('UPDATE resources SET version = ?, data = ? WHERE workspace_id = ? AND id = ? AND version = ?',
                value.version, JSON.stringify(value), value.workspace_id, value.id, expected);
              changed();
            }
          },
        },
        memberships: {
          list: async w => { check(); return copy([...s.memberships.values()].filter(v => v.workspace_id === w).sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)))); },
          put: async (value, expected) => {
            check(true); const id = membershipKey(value); const current = s.memberships.get(id);
            cas(current ? { version: current.version ?? 1 } : undefined, { version: value.version ?? 1 }, expected, value.scope !== 'workspace');
            s.memberships.set(id, copy(value));
            const config = value.scope === 'project' ? { table: 'project_memberships', column: 'project_id', target: value.project_id }
              : value.scope === 'source' ? { table: 'source_memberships', column: 'source_id', target: value.source_id }
              : { table: 'workspace_memberships', column: null, target: null };
            const where = `workspace_id = ? AND member_id = ?${config.column ? ` AND ${config.column} = ?` : ''}`;
            const keys: D1Value[] = [value.workspace_id, value.member_id, ...(config.target === null ? [] : [config.target])];
            if (!current) queue(`INSERT INTO ${config.table}(workspace_id, member_id, ${config.column ? `${config.column}, ` : ''}version, data)
              VALUES (${config.column ? '?, ' : ''}?, ?, ?, ?)`, ...keys, value.version ?? 1, JSON.stringify(value));
            else {
              queue(`UPDATE ${config.table} SET version = ?, data = ? WHERE ${where} AND version = ?`,
                value.version ?? 1, JSON.stringify(value), ...keys, expected);
              changed();
            }
          },
        },
        events: {
          get: async (w, op) => { check(); return copy(s.events.get(key(w, op)) ?? null); },
          list: async w => { check(); return copy([...s.events.values()].filter(v => v.workspace_id === w).sort((a, b) => compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id))); },
          append: async value => {
            check(true); const id = key(value.workspace_id, value.operation_id);
            if (s.events.has(id) || s.contactEvents.has(id)) throw new ConflictError('operation_conflict');
            s.events.set(id, copy(value)); append('workspace', value);
          },
        },
        contacts: {
          get: async (w, source, id) => { check(); return copy(s.contacts.get(key(w, source, id)) ?? null); },
          list: async (w, source) => { check(); return copy([...s.contacts.values()].filter(v => v.workspace_id === w && v.source_id === source).sort((a, b) => a.contact.id.localeCompare(b.contact.id))); },
          put: async (value, expected) => {
            check(true); const id = key(value.workspace_id, value.source_id, value.contact.id);
            const current = s.contacts.get(id);
            cas(current, value, expected); s.contacts.set(id, copy(value));
            const keys = [value.workspace_id, value.source_id, value.contact.id];
            if (!current) queue('INSERT INTO contacts(workspace_id, source_id, contact_id, version, data) VALUES (?, ?, ?, ?, ?)',
              ...keys, value.version, JSON.stringify(value));
            else {
              queue(`UPDATE contacts SET version = ?, data = ? WHERE workspace_id = ? AND source_id = ? AND contact_id = ? AND version = ?`,
                value.version, JSON.stringify(value), ...keys, expected);
              changed();
            }
          },
          event: async (w, op) => { check(); return copy(s.contactEvents.get(key(w, op)) ?? null); },
          history: async (w, source, id) => { check(); return copy([...s.contactEvents.values()].filter(v => v.workspace_id === w && v.source_id === source && v.contact_id === id).sort((a, b) => compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id))); },
          append: async value => {
            check(true); const id = key(value.workspace_id, value.operation_id);
            if (s.events.has(id) || s.contactEvents.has(id)) throw new ConflictError('operation_conflict');
            s.contactEvents.set(id, copy(value)); append('contact', value);
          },
        },
        cases: (() => {
          // The memory port checks every rule against this transaction's snapshot and
          // updates it; each successful write is then buffered for the guarded batch.
          const port = caseMemoryPort(s.cases, check);
          const position = (map: Map<string, unknown[]>, w: string, number: string): number =>
            map.get(caseTableKey(w, number))?.length ?? 0;
          return {
            ...port,
            allocate: async (w, source) => {
              const previous = s.cases.sequences.get(caseTableKey(w, source));
              const seq = await port.allocate(w, source);
              if (previous === undefined) {
                queue('INSERT INTO case_number_sequences(workspace_id, source, next_seq) VALUES (?, ?, ?)', w, source, seq + 1);
              } else {
                queue('UPDATE case_number_sequences SET next_seq = ? WHERE workspace_id = ? AND source = ? AND next_seq = ?',
                  seq + 1, w, source, previous);
                changed();
              }
              return seq;
            },
            put: async (value, expected) => {
              await port.put(value, expected);
              if (expected === null) {
                queue('INSERT INTO cases(workspace_id, number, source, seq, legacy_ref, revision, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  value.workspace_id, value.number, value.source, value.seq, value.legacy_ref, value.revision, JSON.stringify(value));
              } else {
                queue('UPDATE cases SET revision = ?, data = ? WHERE workspace_id = ? AND number = ? AND revision = ?',
                  value.revision, JSON.stringify(value), value.workspace_id, value.number, expected);
                changed();
              }
            },
            appendEvent: async value => {
              await port.appendEvent(value);
              queue('INSERT INTO case_events(workspace_id, case_number, seq, data) VALUES (?, ?, ?, ?)',
                value.workspace_id, value.case_number, value.seq, JSON.stringify(value));
            },
            addPerson: async value => {
              await port.addPerson(value);
              queue('INSERT INTO case_people(workspace_id, case_number, reporter_ref, position, data) VALUES (?, ?, ?, ?, ?)',
                value.workspace_id, value.case_number, value.reporter_ref,
                position(s.cases.people, value.workspace_id, value.case_number), JSON.stringify(value));
            },
            addReply: async value => {
              await port.addReply(value);
              queue('INSERT INTO case_replies(workspace_id, case_number, seq, data) VALUES (?, ?, ?, ?)',
                value.workspace_id, value.case_number, value.seq, JSON.stringify(value));
            },
            addLink: async value => {
              await port.addLink(value);
              queue('INSERT INTO case_links(workspace_id, case_number, link_type, ref, position, data) VALUES (?, ?, ?, ?, ?, ?)',
                value.workspace_id, value.case_number, value.link_type, value.ref,
                position(s.cases.links, value.workspace_id, value.case_number), JSON.stringify(value));
            },
          } satisfies StoreSession['cases'];
        })(),
        caseMemberScopes: (() => {
          // Same approach as cases: the memory port checks the rules on this snapshot,
          // and each successful write is buffered for the guarded batch.
          const port = caseMemberScopeMemoryPort(s.caseMemberScopes, check);
          return {
            ...port,
            put: async (value, expected) => {
              await port.put(value, expected);
              if (expected === 0) {
                queue('INSERT INTO case_member_scopes(workspace_id, member_id, revision, data) VALUES (?, ?, ?, ?)',
                  value.workspace_id, value.member_id, value.revision, JSON.stringify(value));
              } else {
                queue('UPDATE case_member_scopes SET revision = ?, data = ? WHERE workspace_id = ? AND member_id = ? AND revision = ?',
                  value.revision, JSON.stringify(value), value.workspace_id, value.member_id, expected);
                changed();
              }
            },
            appendEvent: async value => {
              await port.appendEvent(value);
              queue('INSERT INTO case_member_scope_events(workspace_id, seq, member_id, data) VALUES (?, ?, ?, ?)',
                value.workspace_id, value.seq, value.member_id, JSON.stringify(value));
            },
          } satisfies StoreSession['caseMemberScopes'];
        })(),
      };
      let value: T;
      try { value = copy(await run(session)); }
      finally { active = false; }
      if (write && writes.length) {
        try { await batch(this.driver, [this.driver.prepare(guard).bind(...serialized), ...writes]); }
        catch (error) {
          // Only our named CHECK is an optimistic/CAS rejection. Storage faults
          // remain faults; never claim that an unknown failure is a safe conflict.
          if (error instanceof Error && /store_condition_failed/.test(error.message)) throw new ConflictError('version_conflict');
          throw error;
        }
      }
      return value;
  }
}
