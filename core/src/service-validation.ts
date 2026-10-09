/** Runtime validation for the portable service. Generated interfaces are not guards. */
import type { EntitySnapshot, Changes, JsonValue } from './generated/event.js';
import { ServiceError } from './ports.js';
import { PROJECT_STATES, ITEM_STATES, WORK_ITEM_KINDS, CONTACT_STATES } from './status.js';

export type JsonObject = Record<string, unknown>;
export type CommandKind = 'project' | 'milestone' | 'work_item';
export type CommandAction = 'create' | 'update' | 'archive' | 'restore';
export const FIELDS = {
  project: ['name', 'purpose', 'owner_id', 'state'],
  milestone: ['goal', 'acceptance', 'assignee_id', 'check_date', 'state'],
  work_item: ['kind', 'title', 'assignee_id', 'next_action', 'check_date', 'waiting_reason', 'state', 'milestone_id'],
  source: ['label', 'adapter', 'binding'],
  reference: ['kind', 'target', 'label', 'linked_id', 'source_id'],
  observation: ['reference_id', 'status', 'last_attempt_at_utc', 'last_success_at_utc'],
} as const;
const META = ['id', 'workspace_id', 'project_id', 'type', 'version', 'archived'];
const REQUIRED = new Set(['name', 'purpose', 'owner_id', 'state', 'goal', 'acceptance', 'assignee_id', 'kind', 'title', 'next_action', 'label', 'adapter', 'binding', 'target', 'status']);
const LONG = new Set(['purpose', 'acceptance', 'next_action', 'waiting_reason', 'target']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function object(value: unknown, code = 'invalid_fields'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ServiceError(code);
  }
  return value as JsonObject;
}
export function exact(value: unknown, fields: readonly string[], code = 'invalid_fields'): JsonObject {
  const result = object(value, code);
  const keys = Object.keys(result);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new ServiceError(code);
  return result;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ServiceError('invalid_id');
  return value;
}
export function integer(value: unknown, minimum = 1, code = 'invalid_version'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new ServiceError(code);
  return value;
}
export function text(value: unknown, required = false, limit = 120): string {
  if (typeof value !== 'string' || [...value].length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ServiceError('invalid_field');
  }
  const clean = value.trim();
  if (required && !clean) throw new ServiceError('required_field');
  return clean;
}
export function date(value: unknown): string {
  const clean = text(value, false, 10);
  if (!clean) return clean;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) throw new ServiceError('invalid_date');
  const [year = 0, month = 0, day = 0] = clean.split('-').map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) throw new ServiceError('invalid_date');
  return clean;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new ServiceError('invalid_timestamp');
  date(value.slice(0, 10));
  const time = value.slice(11, 19).split(':').map(Number);
  if ((time[0] ?? 24) > 23 || (time[1] ?? 60) > 59 || (time[2] ?? 60) > 59) throw new ServiceError('invalid_timestamp');
  return value;
}
/** Chronological UTC ordering without losing sub-millisecond precision. */
export function compareTimestamps(left: string, right: string): number {
  const seconds = left.slice(0, 19).localeCompare(right.slice(0, 19));
  if (seconds) return seconds;
  const a = left.slice(19, -1).replace(/^\./, '');
  const b = right.slice(19, -1).replace(/^\./, '');
  const length = Math.max(a.length, b.length);
  return a.padEnd(length, '0').localeCompare(b.padEnd(length, '0'));
}
/** Keep contact update stamps increasing, including same-clock writes.
 * Legacy contact timestamps are unconstrained strings; recognize RFC 3339
 * (including Python's +00:00 form), and leave unparseable legacy values alone.
 * Passing a previously chosen preview stamp is stable and never bumps twice.
 */
export function nextTimestamp(now: string, previous = ''): string {
  timestamp(now);
  const micros = (value: string): bigint | null => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const base = match[1]!;
    try { timestamp(`${base}Z`); } catch { return null; }
    const milliseconds = Date.parse(`${base}${match[3]}`);
    if (!Number.isFinite(milliseconds)) return null;
    return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').slice(0, 6).padEnd(6, '0'));
  };
  const current = micros(now)!;
  const prior = micros(previous);
  if (prior === null || current > prior) return now;
  const next = prior + 1n;
  let seconds = next / 1_000_000n;
  let fraction = next % 1_000_000n;
  if (fraction < 0n) { seconds -= 1n; fraction += 1_000_000n; }
  const result = `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(fraction).padStart(6, '0')}Z`;
  return timestamp(result);
}
export function contactId(value: unknown): string {
  if (typeof value !== 'string' || !/^c-[0-9]{8}-[0-9a-f]{8}$/.test(value)) throw new ServiceError('invalid_reference');
  return value;
}
export function contactState(value: unknown): string {
  if (typeof value !== 'string' || !(CONTACT_STATES as readonly string[]).includes(value)) throw new ServiceError('invalid_state');
  return value;
}
export function referenceTarget(value: unknown, kind: string): string {
  const clean = text(value, true, 500);
  if (kind === 'md') {
    if (clean.startsWith('/') || clean.includes('\\') || clean.split('/').includes('..')
      || /[:?#]/.test(clean) || !clean.endsWith('.md')) throw new ServiceError('invalid_reference');
  } else if (kind === 'https') {
    try {
      const url = new URL(clean);
      if (!/^https:\/\//.test(clean) || url.protocol !== 'https:' || !url.hostname || url.username || url.password
        || url.search || url.hash || !/^[A-Za-z0-9.-]+$/.test(url.hostname) || clean.includes('\\')) {
        throw new ServiceError('invalid_reference');
      }
    } catch { throw new ServiceError('invalid_reference'); }
  } else throw new ServiceError('invalid_reference');
  return clean;
}
export function data(kind: keyof typeof FIELDS, input: unknown): JsonObject {
  const raw = exact(input, FIELDS[kind]);
  const result: JsonObject = {};
  for (const key of FIELDS[kind]) {
    const value = raw[key];
    if (key.endsWith('_at_utc')) result[key] = key === 'last_success_at_utc' && value === null ? null : timestamp(value);
    else if (key.endsWith('_id')) result[key] = value === '' && (key === 'milestone_id' || key === 'linked_id' || key === 'source_id') ? '' : uuid(value);
    else if (key === 'check_date') result[key] = date(value);
    else result[key] = text(value, REQUIRED.has(key), LONG.has(key) ? 500 : 120);
  }
  if (kind === 'project' && !(PROJECT_STATES as readonly unknown[]).includes(result.state)) throw new ServiceError('invalid_state');
  if ((kind === 'milestone' || kind === 'work_item') && !(ITEM_STATES as readonly unknown[]).includes(result.state)) throw new ServiceError('invalid_state');
  if (kind === 'work_item' && !(WORK_ITEM_KINDS as readonly unknown[]).includes(result.kind)) throw new ServiceError('invalid_kind');
  if (kind === 'source' && ((result.adapter !== 'contact' && result.adapter !== 'external_case')
    || !/^[a-z][a-z0-9_-]*$/.test(String(result.binding))
    || (result.adapter === 'external_case' && result.binding !== 'issuepost'))) throw new ServiceError('invalid_source');
  if (kind === 'reference') {
    if (result.kind === 'md' || result.kind === 'https') {
      if (result.source_id !== '') throw new ServiceError('invalid_source');
      result.target = referenceTarget(result.target, result.kind);
    } else if (result.kind === 'contact' || result.kind === 'external_case') {
      uuid(result.source_id);
      result.target = result.kind === 'contact' ? contactId(result.target) : text(result.target, true, 120);
    } else throw new ServiceError('invalid_reference');
  }
  return result;
}
/** Persisted snapshots are closed: projections must be derived after authorization. */
export function entity(input: unknown, workspaceId: string): EntitySnapshot {
  const raw = object(input);
  const kind = raw.type;
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) throw new ServiceError('invalid_target', 404);
  const type = kind as keyof typeof FIELDS;
  exact(raw, [...META, ...FIELDS[type]]);
  uuid(raw.id);
  if (uuid(raw.workspace_id) !== workspaceId) throw new ServiceError('not_found', 404);
  if (type === 'project' || type === 'source') {
    if (raw.project_id !== null) throw new ServiceError('invalid_project');
  } else uuid(raw.project_id);
  integer(raw.version);
  if (typeof raw.archived !== 'boolean') throw new ServiceError('invalid_field');
  const fields = Object.fromEntries(FIELDS[type].map((key) => [key, raw[key]]));
  const normalized = data(type, fields);
  // A corrupted persisted row is never silently repaired into an authorized row.
  if (canonical(fields) !== canonical(normalized)) throw new ServiceError('invalid_fields');
  return raw as unknown as EntitySnapshot;
}
/** Deterministic JSON; reject non-JSON inputs instead of silently dropping them. */
export function canonical(value: unknown): string {
  const visiting = new Set<object>();
  const encode = (item: unknown, depth = 0): string => {
    if (depth > 128) throw new ServiceError('invalid_request');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || visiting.has(item)) throw new ServiceError('invalid_request');
    visiting.add(item);
    let out: string;
    if (Array.isArray(item)) out = `[${Array.from(item, (child) => encode(child, depth + 1)).join(',')}]`;
    else out = `{${Object.keys(object(item, 'invalid_request')).sort().map((key) => `${JSON.stringify(key)}:${encode((item as JsonObject)[key], depth + 1)}`).join(',')}}`;
    visiting.delete(item);
    return out;
  };
  return encode(value);
}
export function changes(before: object | null, after: object): Changes {
  const left = (before ?? {}) as Record<string, JsonValue>;
  const right = after as Record<string, JsonValue>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((field) => {
    const beforePresent = Object.hasOwn(left, field);
    const afterPresent = Object.hasOwn(right, field);
    if (beforePresent === afterPresent && canonical(left[field]) === canonical(right[field])) return [];
    return [{ field, before_present: beforePresent, after_present: afterPresent,
      before: beforePresent ? left[field]! : null, after: afterPresent ? right[field]! : null }];
  });
}
