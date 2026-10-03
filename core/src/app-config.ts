/**
 * Sending-app settings: [[apps]] (key hashes, environments, allowed addresses;
 * the shape every receiving service shares) and [[scopes]] (what each app may
 * see; owned by the case ledger), joined by name. Read once at startup: any
 * problem is an AppConfigError naming the offending key, never echoing a value,
 * so a typo stops startup instead of silently widening or narrowing access.
 * Keys are stored only as lowercase hex SHA-256 of the presented token.
 * Accepted formats: the case-settings TOML subset plus [[apps]]/[[scopes]]
 * headers, or JSON of the same shape. No host I/O.
 */
import { CASE_SOURCE, CaseSettingsError, parseCaseSettingsJson, parseCaseSettingsToml, parseTomlSubset } from './case-settings.js';
import type { CaseSettings } from './case-settings.js';

export interface AppEntry {
  readonly name: string;
  /** Lowercase hex SHA-256 of each accepted token. At most two, so a key can be rotated without downtime. */
  readonly keys_sha256: readonly string[];
  /** Deployment environment names in which this app's keys are accepted. */
  readonly envs: readonly string[];
  /** CIDR ranges (IPv4 or IPv6); a bare address is one host. */
  readonly allow_ips: readonly string[];
}
export interface ScopeEntry {
  readonly app: string;
  /** The Deskly workspace whose cases this app reads and writes. */
  readonly workspace_id: string;
  /** Visible sources; ["*"] means all. */
  readonly source: readonly string[];
  /** Visible tenants; ["*"] means all. */
  readonly tenant: readonly string[];
}
export interface AppConfig {
  readonly apps: readonly AppEntry[];
  readonly scopes: readonly ScopeEntry[];
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(`Invalid app settings: ${message}`);
    this.name = 'AppConfigError';
  }
}

export const MAX_KEYS_PER_APP = 2;
const HASH = /^[0-9a-f]{64}$/;
const ENVIRONMENT = /^[a-z0-9](?:[a-z0-9_.-]{0,30}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TENANT_LIMIT = 200;

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => value !== null && typeof value === 'object' && !Array.isArray(value);
function table(value: unknown, path: string): Table {
  if (!isTable(value)) throw new AppConfigError(`${path} must be a table`);
  return value;
}
function keys(value: Table, path: string, required: readonly string[]): void {
  for (const key of Object.keys(value)) if (!required.includes(key)) throw new AppConfigError(`unknown key ${path}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new AppConfigError(`missing key ${path}.${key}`);
}
/** Values are never echoed: a misplaced token must not reach a log through an error message. */
function list(value: unknown, path: string, valid: (item: string) => boolean, rule: string): string[] {
  if (!Array.isArray(value)) throw new AppConfigError(`${path} must be an array`);
  if (value.length === 0) throw new AppConfigError(`${path} must not be empty`);
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !valid(item)) throw new AppConfigError(`${path}[${index}] must be ${rule}`);
  });
  const items = value as string[];
  if (new Set(items).size !== items.length) throw new AppConfigError(`${path} must not repeat a value`);
  return [...items];
}
function scopeList(value: unknown, path: string, valid: (item: string) => boolean, rule: string): string[] {
  const items = list(value, path, item => item === '*' || valid(item), `"*" or ${rule}`);
  if (items.includes('*') && items.length !== 1) throw new AppConfigError(`${path} must be exactly ["*"] when it contains "*"`);
  return items;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** An IP address as bytes; IPv4-mapped IPv6 addresses are reported as IPv4. */
export interface IpAddress { readonly version: 4 | 6; readonly bytes: readonly number[] }
export interface IpRange extends IpAddress { readonly prefix: number }

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // Leading zeros are rejected: some parsers read them as octal.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}
function parseIpv6(text: string): number[] | null {
  if (text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string, last: boolean): number[] | null => {
    if (part === '') return [];
    const result: number[] = [];
    const items = part.split(':');
    for (const [index, item] of items.entries()) {
      if (last && index === items.length - 1 && item.includes('.')) {
        const v4 = parseIpv4(item);
        if (!v4) return null;
        result.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(item)) return null;
        result.push(Number.parseInt(item, 16));
      }
    }
    return result;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  const count = head.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const all = [...head, ...Array<number>(8 - count).fill(0), ...tail];
  return all.flatMap(group => [group >> 8, group & 0xff]);
}
/** Parse one textual address (no zone, no brackets, no port). */
export function parseIpAddress(text: string): IpAddress | null {
  const v4 = parseIpv4(text);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(text);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? { version: 4, bytes: v6.slice(12) } : { version: 6, bytes: v6 };
}
/** Parse "address/prefix" or a bare address (a single host). Host bits must be zero. */
export function parseIpRange(text: string): IpRange | null {
  const [address, prefixText, extra] = text.split('/');
  if (extra !== undefined || address === undefined) return null;
  const v4 = parseIpv4(address);
  const v6 = v4 ? null : parseIpv6(address);
  const bytes = v4 ?? v6;
  if (!bytes) return null;
  const bits = bytes.length * 8;
  let prefix = bits;
  if (prefixText !== undefined) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > bits) return null;
  }
  for (let bit = prefix; bit < bits; bit++) if ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1) return null;
  return { version: v4 ? 4 : 6, bytes, prefix };
}
export function ipInRange(address: IpAddress, range: IpRange): boolean {
  if (address.version !== range.version) return false;
  for (let bit = 0; bit < range.prefix; bit++) {
    const mask = 1 << (7 - (bit & 7));
    if ((address.bytes[bit >> 3]! & mask) !== (range.bytes[bit >> 3]! & mask)) return false;
  }
  return true;
}

const validTenant = (item: string): boolean => item.trim() !== '' && [...item].length <= TENANT_LIMIT && !CONTROL.test(item);

/** Validate a parsed document (from TOML or JSON) and return a frozen copy. */
export function appConfig(input: unknown): AppConfig {
  const root = table(input, 'app settings');
  for (const key of Object.keys(root)) if (key !== 'apps' && key !== 'scopes') throw new AppConfigError(`unknown key ${key}`);
  for (const key of ['apps', 'scopes']) {
    if (!Array.isArray(root[key])) throw new AppConfigError(`${key} must be an array of tables ([[${key}]])`);
    if ((root[key] as unknown[]).length === 0) throw new AppConfigError(`${key} must not be empty`);
  }
  const hashes = new Set<string>();
  const apps = (root.apps as unknown[]).map((value, index): AppEntry => {
    const path = `apps[${index}]`;
    const entry = table(value, path);
    keys(entry, path, ['name', 'keys_sha256', 'envs', 'allow_ips']);
    const name = entry.name;
    if (typeof name !== 'string' || !CASE_SOURCE.test(name)) throw new AppConfigError(`${path}.name must match ${CASE_SOURCE.source}`);
    const keyHashes = list(entry.keys_sha256, `${path}.keys_sha256`, item => HASH.test(item), 'a lowercase hex SHA-256 (64 characters) of the token, never the token itself');
    if (keyHashes.length > MAX_KEYS_PER_APP) throw new AppConfigError(`${path}.keys_sha256 must hold at most ${MAX_KEYS_PER_APP} keys`);
    for (const hash of keyHashes) {
      if (hashes.has(hash)) throw new AppConfigError(`${path}.keys_sha256 repeats a key of another app`);
      hashes.add(hash);
    }
    return { name, keys_sha256: keyHashes,
      envs: list(entry.envs, `${path}.envs`, item => ENVIRONMENT.test(item), `an environment name matching ${ENVIRONMENT.source}`),
      allow_ips: list(entry.allow_ips, `${path}.allow_ips`, item => parseIpRange(item) !== null, 'an IPv4/IPv6 address or CIDR range without host bits') };
  });
  const names = apps.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new AppConfigError('apps must not repeat a name');
  const scopes = (root.scopes as unknown[]).map((value, index): ScopeEntry => {
    const path = `scopes[${index}]`;
    const entry = table(value, path);
    keys(entry, path, ['app', 'workspace_id', 'source', 'tenant']);
    const app = entry.app;
    if (typeof app !== 'string' || !CASE_SOURCE.test(app)) throw new AppConfigError(`${path}.app must match ${CASE_SOURCE.source}`);
    if (!names.includes(app)) throw new AppConfigError(`${path}.app has no matching [[apps]] entry`);
    if (typeof entry.workspace_id !== 'string' || !UUID.test(entry.workspace_id)) throw new AppConfigError(`${path}.workspace_id must be a canonical UUID`);
    return { app, workspace_id: entry.workspace_id,
      source: scopeList(entry.source, `${path}.source`, item => CASE_SOURCE.test(item), `a source prefix matching ${CASE_SOURCE.source}`),
      tenant: scopeList(entry.tenant, `${path}.tenant`, validTenant, `a non-blank single-line tenant of at most ${TENANT_LIMIT} characters`) };
  });
  // Missing is never read as "sees everything", and a scope without an app is a typo.
  for (const name of names) {
    const count = scopes.filter(scope => scope.app === name).length;
    if (count === 0) throw new AppConfigError(`apps entry ${name} has no matching [[scopes]] entry`);
    if (count > 1) throw new AppConfigError(`apps entry ${name} has more than one [[scopes]] entry`);
  }
  return freeze({ apps, scopes });
}

export function parseAppConfigJson(text: string): AppConfig {
  let value: unknown;
  // The parser's own message may quote the input, so only the fact is reported.
  try { value = JSON.parse(text); } catch { throw new AppConfigError('JSON syntax error'); }
  return appConfig(value);
}

const ARRAY_HEADER = /^[ \t]*\[\[[ \t]*([A-Za-z0-9_-]+)[ \t]*\]\][ \t]*(?:#[^\r\n]*)?$/;
/**
 * The case-settings TOML subset, plus [[apps]] / [[scopes]] array-of-tables
 * headers. Each section is parsed by the same strict subset parser; error lines
 * refer to the whole file and never quote a value.
 */
export function parseAppConfigToml(text: string): AppConfig {
  // CRLF and LF both end a line; a lone CR stays in the text and is rejected by the parser.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const document: Record<string, Table[]> = {};
  let section: { name: string | null; first: number; lines: string[] } = { name: null, first: 1, lines: [] };
  const flush = (): void => {
    let parsed: Table;
    try { parsed = parseTomlSubset(section.lines.join('\n')); } catch (error) {
      if (!(error instanceof CaseSettingsError)) throw error;
      const match = /TOML line (\d+): (.*)$/.exec(error.message);
      const detail = (match?.[2] ?? 'syntax error').replace(/^unsupported value .*$/, 'unsupported value');
      throw new AppConfigError(`TOML line ${match ? section.first + Number(match[1]) - 1 : section.first}: ${detail}`);
    }
    if (section.name === null) {
      const stray = Object.keys(parsed)[0];
      if (stray !== undefined) throw new AppConfigError(`unknown key ${stray}`);
      return;
    }
    (document[section.name] ??= []).push(parsed);
  };
  lines.forEach((line, index) => {
    const header = ARRAY_HEADER.exec(line);
    if (!header) { section.lines.push(line); return; }
    flush();
    const name = header[1]!;
    if (name !== 'apps' && name !== 'scopes') throw new AppConfigError(`TOML line ${index + 1}: unknown table [[${name}]]`);
    section = { name, first: index + 2, lines: [] };
  });
  flush();
  return appConfig(document);
}

/** TOML or JSON, told apart by the first non-blank character (a TOML document never starts with "{"). */
export function parseAppConfigText(text: string): AppConfig {
  return /^﻿?\s*\{/.test(text) ? parseAppConfigJson(text) : parseAppConfigToml(text);
}
/** Case settings from a file or binding: TOML or JSON, told apart the same way. */
export function parseCaseSettingsText(text: string): CaseSettings {
  return /^﻿?\s*\{/.test(text) ? parseCaseSettingsJson(text) : parseCaseSettingsToml(text);
}
