/** Reference adapter: isolated snapshots, serial transactions, atomic CAS + history. */
import type { Account } from './generated/account.js';
import type { Event } from './generated/event.js';
import type { Membership } from './generated/membership.js';
import type { Workspace } from './generated/workspace.js';
import { compareTimestamps } from './service-validation.js';
import { ConflictError } from './ports.js';
import type { ContactEvent, ContactRecord, Entity, Store, StoreSession } from './ports.js';
import { caseMemoryPort, createCaseTables } from './case-memory.js';
import type { CaseTables } from './case-memory.js';
import { caseMemberScopeMemoryPort, createCaseMemberScopeTables } from './case-access.js';
import type { CaseMemberScopeTables } from './case-access.js';
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
export class MemoryStore implements Store {
  private state: State = { workspaces: new Map(), resources: new Map(), accounts: new Map(), memberships: new Map(), events: new Map(), contacts: new Map(), contactEvents: new Map(), cases: createCaseTables(), caseMemberScopes: createCaseMemberScopeTables() };
  private tail: Promise<void> = Promise.resolve();
  read<T>(run: (session: StoreSession) => Promise<T>): Promise<T> { return this.execute(false, run); }
  transaction<T>(run: (session: StoreSession) => Promise<T>): Promise<T> { return this.execute(true, run); }
  private execute<T>(write: boolean, run: (session: StoreSession) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const s = copy(this.state);
      let active = true;
      const check = (writing = false): void => {
        if (!active) throw new Error('Store session is closed');
        if (writing && !write) throw new Error('Read session is immutable');
      };
      const session: StoreSession = {
        workspaces: {
          get: async id => { check(); return copy(s.workspaces.get(id) ?? null); },
          put: async value => { check(true); s.workspaces.set(value.workspace_id, copy(value)); },
        },
        accounts: {
          get: async subject => { check(); return copy(s.accounts.get(subject) ?? null); },
          put: async value => { check(true); s.accounts.set(value.subject, copy(value)); },
        },
        resources: {
          get: async (w, id) => { check(); return copy(s.resources.get(key(w, id)) ?? null); },
          list: async w => { check(); return copy([...s.resources.values()].filter(v => v.workspace_id === w).sort((a, b) => a.id.localeCompare(b.id))); },
          put: async (value, expected) => {
            check(true); const id = key(value.workspace_id, value.id); const current = s.resources.get(id);
            cas(current, value, expected);
            if (current && (current.type !== value.type || current.project_id !== value.project_id)) throw new ConflictError('version_conflict');
            s.resources.set(id, copy(value));
          },
        },
        memberships: {
          list: async w => { check(); return copy([...s.memberships.values()].filter(v => v.workspace_id === w).sort((a, b) => membershipKey(a).localeCompare(membershipKey(b)))); },
          put: async (value, expected) => {
            check(true); const id = membershipKey(value); const current = s.memberships.get(id);
            cas(current ? { version: current.version ?? 1 } : undefined, { version: value.version ?? 1 }, expected, value.scope !== 'workspace');
            s.memberships.set(id, copy(value));
          },
        },
        events: {
          get: async (w, op) => { check(); return copy(s.events.get(key(w, op)) ?? null); },
          list: async w => { check(); return copy([...s.events.values()].filter(v => v.workspace_id === w).sort((a, b) => compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id))); },
          append: async value => {
            check(true); const id = key(value.workspace_id, value.operation_id);
            if (s.events.has(id) || s.contactEvents.has(id)) throw new ConflictError('operation_conflict');
            s.events.set(id, copy(value));
          },
        },
        contacts: {
          get: async (w, source, id) => { check(); return copy(s.contacts.get(key(w, source, id)) ?? null); },
          list: async (w, source) => { check(); return copy([...s.contacts.values()].filter(v => v.workspace_id === w && v.source_id === source).sort((a, b) => a.contact.id.localeCompare(b.contact.id))); },
          put: async (value, expected) => {
            check(true); const id = key(value.workspace_id, value.source_id, value.contact.id);
            cas(s.contacts.get(id), value, expected); s.contacts.set(id, copy(value));
          },
          event: async (w, op) => { check(); return copy(s.contactEvents.get(key(w, op)) ?? null); },
          history: async (w, source, id) => { check(); return copy([...s.contactEvents.values()].filter(v => v.workspace_id === w && v.source_id === source && v.contact_id === id).sort((a, b) => compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id))); },
          append: async value => {
            check(true); const id = key(value.workspace_id, value.operation_id);
            if (s.events.has(id) || s.contactEvents.has(id)) throw new ConflictError('operation_conflict');
            s.contactEvents.set(id, copy(value));
          },
        },
        cases: caseMemoryPort(s.cases, check),
        caseMemberScopes: caseMemberScopeMemoryPort(s.caseMemberScopes, check),
      };
      try { const value = copy(await run(session)); if (write) this.state = s; return value; }
      finally { active = false; }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
