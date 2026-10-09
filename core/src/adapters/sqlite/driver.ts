/** The only node:sqlite dependency; replace this narrow boundary for another host. */
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';

export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement {
  run(...parameters: SqlValue[]): { changes: number | bigint };
  get(...parameters: SqlValue[]): SqlRow | undefined;
  all(...parameters: SqlValue[]): SqlRow[];
}
export interface SqlDriver {
  prepare(sql: string): SqlStatement;
  /** Trusted migration scripts only. Application values use prepared parameters. */
  run(sql: string): void;
  transaction<T>(write: boolean, run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// A synchronous SQLite busy handler cannot let another callback on this event loop
// finish. Serialize all connections to the same real file locally; SQLite's write
// lock still provides serialization across processes/workers (never retry callbacks).
const queues = new Map<string | symbol, Promise<void>>();
export class NodeSqliteDriver implements SqlDriver {
  private readonly database: DatabaseSync;
  private readonly key: string | symbol;
  private closing = false;
  private closed = false;
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.key = path === ':memory:' ? Symbol('sqlite') : realpathSync(path);
    try {
      this.database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL;');
    } catch (error) { this.database.close(); throw error; }
  }
  prepare(sql: string): SqlStatement { return this.database.prepare(sql); }
  run(sql: string): void { this.database.exec(sql); }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.key) ?? Promise.resolve()).then(run);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(this.key, tail);
    void tail.then(() => { if (queues.get(this.key) === tail) queues.delete(this.key); });
    return result;
  }
  transaction<T>(write: boolean, run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('SQLite driver is closed'));
    return this.enqueue(async () => {
      this.database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const value = await run();
        this.database.exec('COMMIT');
        return value;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }
  close(): Promise<void> {
    this.closing = true;
    return this.enqueue(async () => {
      if (!this.closed) { this.database.close(); this.closed = true; }
    });
  }
}
