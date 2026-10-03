/**
 * Storage rules that every CasePort adapter (memory, SQLite, D1) applies the same
 * way before it writes. Database constraints in the SQL adapters stay the backstop.
 */
import { ConflictError } from './ports.js';
import type { Case } from './ports.js';

/**
 * CasePort.put: null is create-only (a used number or (source, legacy_ref) is
 * duplicate_id); otherwise the revision must match exactly and advance by one,
 * and the issued identity (source, seq, legacy_ref, created_at) never changes.
 * legacyTaken is asked only when creating a case that carries a legacy_ref.
 */
export function checkCasePut(current: Case | null, value: Case, expected: number | null, legacyTaken: () => boolean): void {
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new ConflictError('version_conflict');
  if (expected === null) {
    if (current) throw new ConflictError('duplicate_id');
    if (value.revision !== 1 || value.number !== `${value.source}-${value.seq}`) throw new ConflictError('version_conflict');
    if (value.legacy_ref !== null && legacyTaken()) throw new ConflictError('duplicate_id');
  } else {
    if (!current || current.revision !== expected || value.revision !== expected + 1) throw new ConflictError('version_conflict');
    if (current.source !== value.source || current.seq !== value.seq || current.legacy_ref !== value.legacy_ref
      || current.created_at !== value.created_at) throw new ConflictError('version_conflict');
  }
}

/** Append-only children (events, replies) take exactly the next consecutive seq. */
export function checkNextSeq(seq: number, existing: number): void {
  if (seq !== existing + 1) throw new ConflictError('operation_conflict');
}
