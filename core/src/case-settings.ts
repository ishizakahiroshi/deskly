/**
 * Case settings: every organization-specific word (kinds, statuses, approval
 * states, display labels, source display names) lives in settings, never here.
 * Settings are read once at startup; any problem is a CaseSettingsError naming
 * the offending key, so a typo stops startup instead of silently defaulting.
 * Accepted formats: a small TOML subset (tables, strings, integers, booleans,
 * arrays, inline tables) or JSON of the same shape. No host I/O.
 */

export type CaseWaiting = 'us' | 'them' | 'none';
const WAITING: readonly CaseWaiting[] = ['us', 'them', 'none'];
export interface CaseSettings {
  readonly kinds: { readonly values: readonly string[]; readonly requires_approval: readonly string[] };
  readonly statuses: {
    readonly values: readonly string[];
    readonly open: readonly string[];
    readonly terminal: readonly string[];
    readonly initial: string;
    readonly waiting: Readonly<Record<string, CaseWaiting>>;
  };
  readonly approval_states: {
    readonly values: readonly string[];
    readonly initial: string;
    readonly initial_free: string;
    readonly hold: string;
  };
  /** labels[language][identifier]; missing labels fall back to the identifier itself. */
  readonly labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly numbering: { readonly display_names: Readonly<Record<string, string>> };
  /**
   * [member_access]: whether members other than the workspace owner may be given
   * a case scope. false when the table is absent; changing it takes a restart.
   */
  readonly member_access: { readonly enabled: boolean };
}

export class CaseSettingsError extends Error {
  constructor(message: string) {
    super(`Invalid case settings: ${message}`);
    this.name = 'CaseSettingsError';
  }
}

export const CASE_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;
export const CASE_SOURCE = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => value !== null && typeof value === 'object' && !Array.isArray(value);
function table(value: unknown, path: string): Table {
  if (!isTable(value)) throw new CaseSettingsError(`${path} must be a table`);
  return value;
}
function keys(value: Table, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new CaseSettingsError(`unknown key ${path}${path ? '.' : ''}${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new CaseSettingsError(`missing key ${path}${path ? '.' : ''}${key}`);
  }
}
function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !CASE_IDENTIFIER.test(value)) {
    throw new CaseSettingsError(`${path} must be an identifier matching ${CASE_IDENTIFIER.source}`);
  }
  return value;
}
function identifiers(value: unknown, path: string, nonEmpty = true): string[] {
  if (!Array.isArray(value)) throw new CaseSettingsError(`${path} must be an array`);
  const result = value.map((item, index) => identifier(item, `${path}[${index}]`));
  if (nonEmpty && result.length === 0) throw new CaseSettingsError(`${path} must not be empty`);
  if (new Set(result).size !== result.length) throw new CaseSettingsError(`${path} must not repeat a value`);
  return result;
}
function subset(values: readonly string[], of: readonly string[], path: string, ofPath: string): void {
  for (const value of values) if (!of.includes(value)) throw new CaseSettingsError(`${path} contains ${value}, which is not in ${ofPath}`);
}
function member(value: string, of: readonly string[], path: string, ofPath: string): string {
  if (!of.includes(value)) throw new CaseSettingsError(`${path} = ${value} is not in ${ofPath}`);
  return value;
}
function label(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 120 || CONTROL.test(value)) {
    throw new CaseSettingsError(`${path} must be a non-blank single-line string of at most 120 characters`);
  }
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Validate a parsed settings document (from TOML or JSON) and return a frozen copy. */
export function caseSettings(input: unknown): CaseSettings {
  const root = table(input, 'settings');
  keys(root, '', ['kinds', 'statuses', 'approval_states'], ['labels', 'numbering', 'member_access']);

  const kindsTable = table(root.kinds, 'kinds');
  keys(kindsTable, 'kinds', ['values'], ['requires_approval']);
  const kinds = identifiers(kindsTable.values, 'kinds.values');
  const requiresApproval = Object.hasOwn(kindsTable, 'requires_approval')
    ? identifiers(kindsTable.requires_approval, 'kinds.requires_approval', false) : [];
  subset(requiresApproval, kinds, 'kinds.requires_approval', 'kinds.values');

  const statusTable = table(root.statuses, 'statuses');
  keys(statusTable, 'statuses', ['values', 'open', 'terminal', 'initial', 'waiting']);
  const statuses = identifiers(statusTable.values, 'statuses.values');
  const open = identifiers(statusTable.open, 'statuses.open');
  const terminal = identifiers(statusTable.terminal, 'statuses.terminal');
  subset(open, statuses, 'statuses.open', 'statuses.values');
  subset(terminal, statuses, 'statuses.terminal', 'statuses.values');
  for (const status of statuses) {
    if (open.includes(status) === terminal.includes(status)) {
      throw new CaseSettingsError(`statuses.values contains ${status}, which must be in exactly one of statuses.open and statuses.terminal`);
    }
  }
  const initial = member(identifier(statusTable.initial, 'statuses.initial'), open, 'statuses.initial', 'statuses.open');
  const waitingTable = table(statusTable.waiting, 'statuses.waiting');
  keys(waitingTable, 'statuses.waiting', statuses);
  const waiting: Record<string, CaseWaiting> = {};
  for (const status of statuses) {
    const value = waitingTable[status];
    if (typeof value !== 'string' || !(WAITING as readonly string[]).includes(value)) {
      throw new CaseSettingsError(`statuses.waiting.${status} must be one of ${WAITING.join(', ')}`);
    }
    waiting[status] = value as CaseWaiting;
  }

  const approvalTable = table(root.approval_states, 'approval_states');
  keys(approvalTable, 'approval_states', ['values', 'initial', 'initial_free', 'hold']);
  const approvals = identifiers(approvalTable.values, 'approval_states.values');
  const approval = {
    values: approvals,
    initial: member(identifier(approvalTable.initial, 'approval_states.initial'), approvals, 'approval_states.initial', 'approval_states.values'),
    initial_free: member(identifier(approvalTable.initial_free, 'approval_states.initial_free'), approvals, 'approval_states.initial_free', 'approval_states.values'),
    hold: member(identifier(approvalTable.hold, 'approval_states.hold'), approvals, 'approval_states.hold', 'approval_states.values'),
  };

  const known = new Set([...kinds, ...statuses, ...approvals]);
  const labels: Record<string, Record<string, string>> = {};
  if (Object.hasOwn(root, 'labels')) {
    for (const [language, values] of Object.entries(table(root.labels, 'labels'))) {
      if (!LANGUAGE.test(language)) throw new CaseSettingsError(`labels.${language} is not a language tag`);
      const entries: Record<string, string> = {};
      for (const [key, value] of Object.entries(table(values, `labels.${language}`))) {
        if (!known.has(key)) throw new CaseSettingsError(`labels.${language}.${key} is not a configured kind, status or approval state`);
        entries[key] = label(value, `labels.${language}.${key}`);
      }
      labels[language] = entries;
    }
  }

  const displayNames: Record<string, string> = {};
  if (Object.hasOwn(root, 'numbering')) {
    const numbering = table(root.numbering, 'numbering');
    keys(numbering, 'numbering', [], ['display_names']);
    if (Object.hasOwn(numbering, 'display_names')) {
      for (const [source, value] of Object.entries(table(numbering.display_names, 'numbering.display_names'))) {
        if (!CASE_SOURCE.test(source)) throw new CaseSettingsError(`numbering.display_names.${source} is not a valid source prefix`);
        displayNames[source] = label(value, `numbering.display_names.${source}`);
      }
    }
  }

  // Off unless written as true: widening who sees cases is an explicit operator decision.
  let memberAccess = false;
  if (Object.hasOwn(root, 'member_access')) {
    const access = table(root.member_access, 'member_access');
    keys(access, 'member_access', ['enabled']);
    if (typeof access.enabled !== 'boolean') throw new CaseSettingsError('member_access.enabled must be true or false');
    memberAccess = access.enabled;
  }

  return freeze({
    kinds: { values: kinds, requires_approval: requiresApproval },
    statuses: { values: statuses, open, terminal, initial, waiting },
    approval_states: approval,
    labels,
    numbering: { display_names: displayNames },
    member_access: { enabled: memberAccess },
  });
}

/** Display word for a stored identifier; an unknown language or label shows the identifier itself. */
export function caseLabel(settings: CaseSettings, language: string, value: string): string {
  const labels = Object.hasOwn(settings.labels, language) ? settings.labels[language] : undefined;
  return labels && Object.hasOwn(labels, value) ? labels[value]! : value;
}

/** Display name for a stored source prefix; the prefix itself never changes. */
export function caseSourceName(settings: CaseSettings, source: string): string {
  return Object.hasOwn(settings.numbering.display_names, source) ? settings.numbering.display_names[source]! : source;
}

export function parseCaseSettingsJson(text: string): CaseSettings {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    throw new CaseSettingsError(`JSON syntax: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
  return caseSettings(value);
}

export function parseCaseSettingsToml(text: string): CaseSettings {
  return caseSettings(parseTomlSubset(text));
}

/**
 * Strict TOML subset: comments, [table] and [dotted.table] headers, bare/quoted
 * (dotted) keys, basic and literal single-line strings, decimal integers,
 * booleans, (multi-line) arrays and single-line inline tables. Anything else —
 * floats, dates, multi-line strings, arrays of tables — is rejected with its line.
 */
export function parseTomlSubset(text: string): Table {
  const source = text.replace(/^﻿/, '');
  let index = 0;
  const root: Table = {};
  const explicit = new Set<Table>();
  const closed = new Set<Table>();
  const line = (): number => source.slice(0, index).split('\n').length;
  const fail = (message: string): never => { throw new CaseSettingsError(`TOML line ${line()}: ${message}`); };
  const peek = (): string => source[index] ?? '';
  const spaces = (): void => { while (peek() === ' ' || peek() === '\t') index++; };
  const comment = (): void => {
    if (peek() !== '#') return;
    while (index < source.length && peek() !== '\n') {
      if (CONTROL.test(peek()) && peek() !== '\t' && peek() !== '\r') fail('control character in comment');
      index++;
    }
  };
  const newline = (): boolean => {
    if (peek() === '\n') { index++; return true; }
    if (peek() === '\r' && source[index + 1] === '\n') { index += 2; return true; }
    return false;
  };
  const blank = (): void => { for (;;) { spaces(); comment(); if (!newline()) return; } };
  const endOfLine = (): void => {
    spaces(); comment();
    if (index < source.length && !newline()) fail('expected end of line');
  };
  const basicString = (): string => {
    index++;
    let result = '';
    for (;;) {
      const character = peek();
      if (!character || character === '\n' || character === '\r') fail('unterminated string');
      index++;
      if (character === '"') return result;
      if (character === '\\') {
        const escape = peek(); index++;
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.hasOwn(simple, escape)) result += simple[escape];
        else if (escape === 'u' || escape === 'U') {
          const length = escape === 'u' ? 4 : 8;
          const hex = source.slice(index, index + length);
          if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) fail('invalid unicode escape');
          const code = Number.parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('invalid unicode scalar');
          result += String.fromCodePoint(code);
          index += length;
        } else fail('invalid escape');
      } else if (CONTROL.test(character) && character !== '\t') fail('control character in string');
      else result += character;
    }
  };
  const literalString = (): string => {
    index++;
    const start = index;
    while (peek() !== "'") {
      if (!peek() || peek() === '\n' || peek() === '\r') fail('unterminated string');
      if (CONTROL.test(peek()) && peek() !== '\t') fail('control character in string');
      index++;
    }
    const result = source.slice(start, index);
    index++;
    return result;
  };
  const simpleKey = (): string => {
    if (peek() === '"') return basicString();
    if (peek() === "'") return literalString();
    const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
    if (!match) return fail('expected a key');
    index += match[0].length;
    return match[0];
  };
  const dottedKey = (): string[] => {
    const parts = [simpleKey()];
    for (;;) {
      spaces();
      if (peek() !== '.') return parts;
      index++; spaces();
      parts.push(simpleKey());
    }
  };
  const child = (parent: Table, key: string, implicit: boolean): Table => {
    if (!Object.hasOwn(parent, key)) {
      const created: Table = {};
      Object.defineProperty(parent, key, { value: created, enumerable: true, writable: true, configurable: true });
      return created;
    }
    const existing = parent[key];
    if (!isTable(existing) || closed.has(existing) || (!implicit && explicit.has(existing))) fail(`key ${key} is already defined`);
    return existing as Table;
  };
  const assign = (target: Table, path: string[], value: unknown): void => {
    let current = target;
    for (const part of path.slice(0, -1)) current = child(current, part, true);
    const last = path[path.length - 1]!;
    if (Object.hasOwn(current, last)) fail(`key ${path.join('.')} is already defined`);
    Object.defineProperty(current, last, { value, enumerable: true, writable: true, configurable: true });
  };
  const value = (): unknown => {
    const character = peek();
    if (character === '"') {
      if (source.startsWith('"""', index)) fail('multi-line strings are not supported');
      return basicString();
    }
    if (character === "'") {
      if (source.startsWith("'''", index)) fail('multi-line strings are not supported');
      return literalString();
    }
    if (character === '[') {
      index++;
      const items: unknown[] = [];
      for (;;) {
        blank();
        if (peek() === ']') { index++; return items; }
        items.push(value());
        blank();
        if (peek() === ',') { index++; continue; }
        if (peek() === ']') { index++; return items; }
        fail('expected , or ] in array');
      }
    }
    if (character === '{') {
      index++;
      const inline: Table = {};
      spaces();
      if (peek() === '}') { index++; closed.add(inline); return inline; }
      for (;;) {
        spaces();
        const path = dottedKey();
        spaces();
        if (peek() !== '=') fail('expected = in inline table');
        index++; spaces();
        assign(inline, path, value());
        spaces();
        if (peek() === ',') { index++; continue; }
        if (peek() === '}') { index++; closed.add(inline); return inline; }
        fail('expected , or } in inline table');
      }
    }
    const word = /^[^\s,\]}#]+/.exec(source.slice(index))?.[0] ?? '';
    if (word === 'true' || word === 'false') { index += word.length; return word === 'true'; }
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(word)) {
      const number = Number(word.replace(/_/g, ''));
      if (!Number.isSafeInteger(number)) fail('integer out of range');
      index += word.length;
      return number;
    }
    return fail(word ? `unsupported value ${word}` : 'expected a value');
  };

  let current = root;
  for (;;) {
    blank();
    if (index >= source.length) return root;
    if (peek() === '[') {
      if (source[index + 1] === '[') fail('arrays of tables are not supported');
      index++; spaces();
      const path = dottedKey();
      spaces();
      if (peek() !== ']') fail('expected ] after table name');
      index++;
      let target = root;
      for (const part of path.slice(0, -1)) target = child(target, part, true);
      const table = child(target, path[path.length - 1]!, false);
      explicit.add(table);
      current = table;
      endOfLine();
      continue;
    }
    const path = dottedKey();
    spaces();
    if (peek() !== '=') fail('expected = after key');
    index++; spaces();
    assign(current, path, value());
    endOfLine();
  }
}
