/** SQLite persistence only. Authorization stays in the shared service's transaction. */
import type { Account } from '../../generated/account.js';
import type { Event } from '../../generated/event.js';
import type { Membership } from '../../generated/membership.js';
import type { Workspace } from '../../generated/workspace.js';
import { ConflictError, ServiceError } from '../../ports.js';
import type { Case, CaseEvent, CaseLink, CaseMemberScope, CaseMemberScopeEvent, CasePerson, CaseReply, ContactEvent, ContactRecord,
  Entity, Store, StoreSession } from '../../ports.js';
import { checkCasePut, checkNextSeq } from '../../case-rules.js';
import { checkCaseMemberScopePut, sortCaseMemberScopes } from '../../case-access.js';
import { compareTimestamps } from '../../service-validation.js';
import { NodeSqliteDriver } from './driver.js';
import type { SqlDriver, SqlRow, SqlValue } from './driver.js';
import { migrate } from './migrate.js';

const decode = <T>(row: SqlRow | undefined): T | null => row ? JSON.parse(String(row.data)) as T : null;
function cas(current: { version: number } | null, next: number, expected: number | null, grant = false): void {
  if (!Number.isSafeInteger(next) || next < 1 || (!grant && expected === 0) || (grant && expected === null)) {
    throw new ConflictError('version_conflict');
  }
  if (expected === null) {
    if (current) throw new ConflictError('duplicate_id');
    if (next !== 1) throw new ConflictError('version_conflict');
  } else if (!Number.isSafeInteger(expected) || expected < 0 || (current?.version ?? 0) !== expected || next !== expected + 1) {
    throw new ConflictError('version_conflict');
  }
}
const membershipKey = (value: Membership): string => JSON.stringify([value.workspace_id, value.scope,
  value.member_id, value.scope === 'project' ? value.project_id : value.scope === 'source' ? value.source_id : '']);
const chronological = <T extends { at_utc: string; operation_id: string }>(a: T, b: T): number =>
  compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id);

export class SQLiteStore implements Store {
  private constructor(private readonly driver: SqlDriver) {}
  /** A file path is explicit: never look up the user's home or legacy database. */
  static async open(path: string): Promise<SQLiteStore> {
    return SQLiteStore.fromDriver(new NodeSqliteDriver(path));
  }
  /** Owns the injected driver, including closing it if migration fails. */
  static async fromDriver(driver: SqlDriver): Promise<SQLiteStore> {
    try { await migrate(driver); return new SQLiteStore(driver); }
    catch (error) { await driver.close(); throw error; }
  }
  close(): Promise<void> { return this.driver.close(); }
  read<T>(run: (session: StoreSession) => Promise<T>): Promise<T> { return this.execute(false, run); }
  transaction<T>(run: (session: StoreSession) => Promise<T>): Promise<T> { return this.execute(true, run); }
  private execute<T>(write: boolean, run: (session: StoreSession) => Promise<T>): Promise<T> {
    return this.driver.transaction(write, async () => {
      let active = true;
      const check = (writing = false): void => {
        if (!active) throw new Error('Store session is closed');
        if (writing && !write) throw new Error('Read session is immutable');
      };
      const one = <V>(sql: string, ...parameters: SqlValue[]): V | null => {
        check(); return decode<V>(this.driver.prepare(sql).get(...parameters));
      };
      const all = <V>(sql: string, ...parameters: SqlValue[]): V[] => {
        check(); return this.driver.prepare(sql).all(...parameters).map(row => decode<V>(row)!);
      };
      const update = (sql: string, ...parameters: SqlValue[]): void => {
        if (Number(this.driver.prepare(sql).run(...parameters).changes) !== 1) throw new ConflictError('version_conflict');
      };
      const append = (kind: 'workspace' | 'contact', value: Event | ContactEvent): void => {
        check(true);
        if (this.driver.prepare('SELECT 1 FROM events WHERE workspace_id = ? AND operation_id = ?').get(value.workspace_id, value.operation_id)) {
          throw new ConflictError('operation_conflict');
        }
        const contact = kind === 'contact' ? value as ContactEvent : null;
        this.driver.prepare(`INSERT INTO events(workspace_id, operation_id, kind, source_id, contact_id, requester_member_id, data)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(value.workspace_id, value.operation_id, kind,
          contact?.source_id ?? null, contact?.contact_id ?? null, value.requester_member_id, JSON.stringify(value));
      };
      // Case children: table names come only from this fixed list, never from data.
      type CaseChild = 'case_events' | 'case_people' | 'case_replies' | 'case_links';
      const caseOrder = { case_events: 'seq', case_people: 'position', case_replies: 'seq', case_links: 'position' } as const;
      const caseParent = (w: string, number: string): void => {
        check(true);
        if (!this.driver.prepare('SELECT 1 FROM cases WHERE workspace_id = ? AND number = ?').get(w, number)) {
          throw new ServiceError('not_found', 404);
        }
      };
      const caseChildren = <V>(table: CaseChild, w: string, number: string): V[] =>
        all<V>(`SELECT data FROM ${table} WHERE workspace_id = ? AND case_number = ? ORDER BY ${caseOrder[table]}`, w, number);
      const caseChildCount = (table: CaseChild, w: string, number: string): number =>
        Number(this.driver.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND case_number = ?`).get(w, number)?.count ?? 0);
      const session: StoreSession = {
        workspaces: {
          get: async id => one<Workspace>('SELECT data FROM workspaces WHERE workspace_id = ?', id),
          put: async value => {
            check(true);
            this.driver.prepare(`INSERT INTO workspaces(workspace_id, data) VALUES (?, ?)
              ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data`).run(value.workspace_id, JSON.stringify(value));
          },
        },
        accounts: {
          get: async subject => one<Account>('SELECT data FROM accounts WHERE subject = ?', subject),
          put: async value => {
            check(true);
            this.driver.prepare(`INSERT INTO accounts(subject, data) VALUES (?, ?)
              ON CONFLICT(subject) DO UPDATE SET data = excluded.data`).run(value.subject, JSON.stringify(value));
          },
        },
        resources: {
          get: async (w, id) => one<Entity>('SELECT data FROM resources WHERE workspace_id = ? AND id = ?', w, id),
          list: async w => all<Entity>('SELECT data FROM resources WHERE workspace_id = ?', w).sort((a, b) => a.id.localeCompare(b.id)),
          put: async (value, expected) => {
            check(true);
            const current = one<Entity>('SELECT data FROM resources WHERE workspace_id = ? AND id = ?', value.workspace_id, value.id);
            cas(current, value.version, expected);
            if (current && (current.type !== value.type || current.project_id !== value.project_id)) throw new ConflictError('version_conflict');
            if (!current) {
              this.driver.prepare(`INSERT INTO resources(workspace_id, id, type, project_id, version, data) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(value.workspace_id, value.id, value.type, value.project_id, value.version, JSON.stringify(value));
            } else {
              update('UPDATE resources SET version = ?, data = ? WHERE workspace_id = ? AND id = ? AND version = ?',
                value.version, JSON.stringify(value), value.workspace_id, value.id, expected);
            }
          },
        },
        memberships: {
          list: async w => all<Membership>(`SELECT data FROM workspace_memberships WHERE workspace_id = ?
            UNION ALL SELECT data FROM project_memberships WHERE workspace_id = ?
            UNION ALL SELECT data FROM source_memberships WHERE workspace_id = ?`, w, w, w)
            .sort((a, b) => membershipKey(a).localeCompare(membershipKey(b))),
          put: async (value, expected) => {
            check(true);
            // Identifiers come only from this fixed map, never from data or a caller.
            const config = value.scope === 'project' ? { table: 'project_memberships', column: 'project_id', target: value.project_id }
              : value.scope === 'source' ? { table: 'source_memberships', column: 'source_id', target: value.source_id }
              : { table: 'workspace_memberships', column: null, target: null };
            const where = `workspace_id = ? AND member_id = ?${config.column ? ` AND ${config.column} = ?` : ''}`;
            const keys: SqlValue[] = [value.workspace_id, value.member_id, ...(config.target === null ? [] : [config.target])];
            const current = this.driver.prepare(`SELECT version FROM ${config.table} WHERE ${where}`).get(...keys);
            const version = value.version ?? 1;
            cas(current ? { version: Number(current.version) } : null, version, expected, value.scope !== 'workspace');
            if (!current) {
              this.driver.prepare(`INSERT INTO ${config.table}(workspace_id, member_id, ${config.column ? `${config.column}, ` : ''}version, data)
                VALUES (${config.column ? '?, ' : ''}?, ?, ?, ?)`).run(...keys, version, JSON.stringify(value));
            } else {
              update(`UPDATE ${config.table} SET version = ?, data = ? WHERE ${where} AND version = ?`, version, JSON.stringify(value), ...keys, expected);
            }
          },
        },
        events: {
          get: async (w, op) => one<Event>("SELECT data FROM events WHERE workspace_id = ? AND operation_id = ? AND kind = 'workspace'", w, op),
          list: async w => all<Event>("SELECT data FROM events WHERE workspace_id = ? AND kind = 'workspace'", w).sort(chronological),
          append: async value => append('workspace', value),
        },
        contacts: {
          get: async (w, source, id) => one<ContactRecord>('SELECT data FROM contacts WHERE workspace_id = ? AND source_id = ? AND contact_id = ?', w, source, id),
          list: async (w, source) => all<ContactRecord>('SELECT data FROM contacts WHERE workspace_id = ? AND source_id = ?', w, source)
            .sort((a, b) => a.contact.id.localeCompare(b.contact.id)),
          put: async (value, expected) => {
            check(true);
            const keys = [value.workspace_id, value.source_id, value.contact.id];
            const where = 'workspace_id = ? AND source_id = ? AND contact_id = ?';
            const current = one<ContactRecord>(`SELECT data FROM contacts WHERE ${where}`, ...keys);
            cas(current, value.version, expected);
            if (!current) {
              this.driver.prepare('INSERT INTO contacts(workspace_id, source_id, contact_id, version, data) VALUES (?, ?, ?, ?, ?)')
                .run(...keys, value.version, JSON.stringify(value));
            } else {
              update(`UPDATE contacts SET version = ?, data = ? WHERE ${where} AND version = ?`, value.version, JSON.stringify(value), ...keys, expected);
            }
          },
          event: async (w, op) => one<ContactEvent>("SELECT data FROM events WHERE workspace_id = ? AND operation_id = ? AND kind = 'contact'", w, op),
          history: async (w, source, id) => all<ContactEvent>(`SELECT data FROM events WHERE workspace_id = ? AND kind = 'contact'
            AND source_id = ? AND contact_id = ?`, w, source, id).sort(chronological),
          append: async value => append('contact', value),
        },
        cases: {
          get: async (w, number) => one<Case>('SELECT data FROM cases WHERE workspace_id = ? AND number = ?', w, number),
          list: async w => all<Case>('SELECT data FROM cases WHERE workspace_id = ? ORDER BY source, seq', w),
          findByLegacyRef: async (w, source, legacyRef) => one<Case>(
            'SELECT data FROM cases WHERE workspace_id = ? AND source = ? AND legacy_ref = ?', w, source, legacyRef),
          allocate: async (w, source) => {
            check(true);
            // The upsert runs inside this BEGIN IMMEDIATE transaction: a rollback issues nothing.
            const row = this.driver.prepare(`INSERT INTO case_number_sequences(workspace_id, source, next_seq) VALUES (?, ?, 2)
              ON CONFLICT(workspace_id, source) DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq`).get(w, source);
            const next = Number(row?.next_seq);
            if (!Number.isSafeInteger(next) || next < 2) throw new Error('Invalid case number sequence');
            return next - 1;
          },
          put: async (value, expected) => {
            check(true);
            const current = one<Case>('SELECT data FROM cases WHERE workspace_id = ? AND number = ?', value.workspace_id, value.number);
            checkCasePut(current, value, expected, () => Boolean(this.driver.prepare(
              'SELECT 1 FROM cases WHERE workspace_id = ? AND source = ? AND legacy_ref = ?').get(value.workspace_id, value.source, value.legacy_ref)));
            if (expected === null) {
              this.driver.prepare('INSERT INTO cases(workspace_id, number, source, seq, legacy_ref, revision, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(value.workspace_id, value.number, value.source, value.seq, value.legacy_ref, value.revision, JSON.stringify(value));
            } else {
              update('UPDATE cases SET revision = ?, data = ? WHERE workspace_id = ? AND number = ? AND revision = ?',
                value.revision, JSON.stringify(value), value.workspace_id, value.number, expected);
            }
          },
          events: async (w, number) => caseChildren<CaseEvent>('case_events', w, number),
          appendEvent: async value => {
            caseParent(value.workspace_id, value.case_number);
            checkNextSeq(value.seq, caseChildCount('case_events', value.workspace_id, value.case_number));
            this.driver.prepare('INSERT INTO case_events(workspace_id, case_number, seq, data) VALUES (?, ?, ?, ?)')
              .run(value.workspace_id, value.case_number, value.seq, JSON.stringify(value));
          },
          people: async (w, number) => caseChildren<CasePerson>('case_people', w, number),
          addPerson: async value => {
            caseParent(value.workspace_id, value.case_number);
            if (this.driver.prepare('SELECT 1 FROM case_people WHERE workspace_id = ? AND case_number = ? AND reporter_ref = ?')
              .get(value.workspace_id, value.case_number, value.reporter_ref)) throw new ConflictError('duplicate_id');
            this.driver.prepare('INSERT INTO case_people(workspace_id, case_number, reporter_ref, position, data) VALUES (?, ?, ?, ?, ?)')
              .run(value.workspace_id, value.case_number, value.reporter_ref,
                caseChildCount('case_people', value.workspace_id, value.case_number) + 1, JSON.stringify(value));
          },
          replies: async (w, number) => caseChildren<CaseReply>('case_replies', w, number),
          addReply: async value => {
            caseParent(value.workspace_id, value.case_number);
            checkNextSeq(value.seq, caseChildCount('case_replies', value.workspace_id, value.case_number));
            this.driver.prepare('INSERT INTO case_replies(workspace_id, case_number, seq, data) VALUES (?, ?, ?, ?)')
              .run(value.workspace_id, value.case_number, value.seq, JSON.stringify(value));
          },
          links: async (w, number) => caseChildren<CaseLink>('case_links', w, number),
          addLink: async value => {
            caseParent(value.workspace_id, value.case_number);
            if (this.driver.prepare('SELECT 1 FROM case_links WHERE workspace_id = ? AND case_number = ? AND link_type = ? AND ref = ?')
              .get(value.workspace_id, value.case_number, value.link_type, value.ref)) throw new ConflictError('duplicate_id');
            this.driver.prepare('INSERT INTO case_links(workspace_id, case_number, link_type, ref, position, data) VALUES (?, ?, ?, ?, ?, ?)')
              .run(value.workspace_id, value.case_number, value.link_type, value.ref,
                caseChildCount('case_links', value.workspace_id, value.case_number) + 1, JSON.stringify(value));
          },
        },
        caseMemberScopes: {
          get: async (w, member) => one<CaseMemberScope>('SELECT data FROM case_member_scopes WHERE workspace_id = ? AND member_id = ?', w, member),
          list: async w => sortCaseMemberScopes(all<CaseMemberScope>('SELECT data FROM case_member_scopes WHERE workspace_id = ?', w)),
          put: async (value, expected) => {
            check(true);
            const current = one<CaseMemberScope>('SELECT data FROM case_member_scopes WHERE workspace_id = ? AND member_id = ?',
              value.workspace_id, value.member_id);
            checkCaseMemberScopePut(current, value, expected);
            if (expected === 0) {
              this.driver.prepare('INSERT INTO case_member_scopes(workspace_id, member_id, revision, data) VALUES (?, ?, ?, ?)')
                .run(value.workspace_id, value.member_id, value.revision, JSON.stringify(value));
            } else {
              update('UPDATE case_member_scopes SET revision = ?, data = ? WHERE workspace_id = ? AND member_id = ? AND revision = ?',
                value.revision, JSON.stringify(value), value.workspace_id, value.member_id, expected);
            }
          },
          events: async w => all<CaseMemberScopeEvent>('SELECT data FROM case_member_scope_events WHERE workspace_id = ? ORDER BY seq', w),
          appendEvent: async value => {
            check(true);
            if (!this.driver.prepare('SELECT 1 FROM case_member_scopes WHERE workspace_id = ? AND member_id = ?').get(value.workspace_id, value.member_id)) {
              throw new ServiceError('not_found', 404);
            }
            const count = Number(this.driver.prepare('SELECT COUNT(*) AS count FROM case_member_scope_events WHERE workspace_id = ?')
              .get(value.workspace_id)?.count ?? 0);
            checkNextSeq(value.seq, count);
            this.driver.prepare('INSERT INTO case_member_scope_events(workspace_id, seq, member_id, data) VALUES (?, ?, ?, ?)')
              .run(value.workspace_id, value.seq, value.member_id, JSON.stringify(value));
          },
        },
      };
      // Detach before COMMIT: an unusable result must roll back as in MemoryStore.
      try { return structuredClone(await run(session)); }
      finally { active = false; }
    });
  }
}
