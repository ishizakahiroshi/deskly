/** Pure legacy contact projections, matching deskly.views and deskly.ledgers. */
import type { Contact } from './generated/contact.js';
import type { ContactWaitingRow } from './generated/contact_waiting.js';
import { ServiceError } from './ports.js';
import { date } from './service-validation.js';

export type WaitingRow = ContactWaitingRow;
export interface WaitingOptions {
  include_all?: boolean;
  include_summaries?: boolean;
  today?: string;
}

// Python str.strip()/re \s include the information separators and U+0085,
// but not U+FEFF. JavaScript trim()/\s differ on those characters.
const WHITESPACE = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const EDGE_WHITESPACE = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, 'gu');
const ANY_WHITESPACE = new RegExp(`${WHITESPACE}+`, 'gu');
export function pythonStrip(value: string): string { return value.replace(EDGE_WHITESPACE, ''); }

/** Python compares Unicode code points, independently of host locale. */
export function compareContactText(left: string, right: string): number {
  const a = [...left]; const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
export function compareContacts(left: Contact, right: Contact): number {
  return compareContactText(left.created_at, right.created_at) || compareContactText(left.id, right.id);
}

// Full Unicode 15.0 default case-fold data, verified against Python 3.12.
// Ranges encode [first, last, stride, offset]; all other changes are below.
// Host toLowerCase is intentionally avoided: newer host Unicode versions can
// otherwise change search results for legacy contacts across deployments.
const CASE_FOLD_RANGES: readonly (readonly [number, number, number, number])[] = [
  [0x41, 0x5a, 1, 32],
  [0xc0, 0xd6, 1, 32],
  [0xd8, 0xde, 1, 32],
  [0x100, 0x12e, 2, 1],
  [0x132, 0x136, 2, 1],
  [0x139, 0x147, 2, 1],
  [0x14a, 0x176, 2, 1],
  [0x179, 0x17d, 2, 1],
  [0x1a0, 0x1a4, 2, 1],
  [0x1cb, 0x1db, 2, 1],
  [0x1de, 0x1ee, 2, 1],
  [0x1f8, 0x21e, 2, 1],
  [0x222, 0x232, 2, 1],
  [0x246, 0x24e, 2, 1],
  [0x388, 0x38a, 1, 37],
  [0x391, 0x3a1, 1, 32],
  [0x3a3, 0x3ab, 1, 32],
  [0x3d8, 0x3ee, 2, 1],
  [0x3fd, 0x3ff, 1, -130],
  [0x400, 0x40f, 1, 80],
  [0x410, 0x42f, 1, 32],
  [0x460, 0x480, 2, 1],
  [0x48a, 0x4be, 2, 1],
  [0x4c1, 0x4cd, 2, 1],
  [0x4d0, 0x52e, 2, 1],
  [0x531, 0x556, 1, 48],
  [0x10a0, 0x10c5, 1, 7264],
  [0x13f8, 0x13fd, 1, -8],
  [0x1c90, 0x1cba, 1, -3008],
  [0x1cbd, 0x1cbf, 1, -3008],
  [0x1e00, 0x1e94, 2, 1],
  [0x1ea0, 0x1efe, 2, 1],
  [0x1f08, 0x1f0f, 1, -8],
  [0x1f18, 0x1f1d, 1, -8],
  [0x1f28, 0x1f2f, 1, -8],
  [0x1f38, 0x1f3f, 1, -8],
  [0x1f48, 0x1f4d, 1, -8],
  [0x1f59, 0x1f5f, 2, -8],
  [0x1f68, 0x1f6f, 1, -8],
  [0x1fc8, 0x1fcb, 1, -86],
  [0x2160, 0x216f, 1, 16],
  [0x24b6, 0x24cf, 1, 26],
  [0x2c00, 0x2c2f, 1, 48],
  [0x2c67, 0x2c6b, 2, 1],
  [0x2c80, 0x2ce2, 2, 1],
  [0xa640, 0xa66c, 2, 1],
  [0xa680, 0xa69a, 2, 1],
  [0xa722, 0xa72e, 2, 1],
  [0xa732, 0xa76e, 2, 1],
  [0xa77e, 0xa786, 2, 1],
  [0xa796, 0xa7a8, 2, 1],
  [0xa7b4, 0xa7c2, 2, 1],
  [0xab70, 0xabbf, 1, -38864],
  [0xff21, 0xff3a, 1, 32],
  [0x10400, 0x10427, 1, 40],
  [0x104b0, 0x104d3, 1, 40],
  [0x10570, 0x1057a, 1, 39],
  [0x1057c, 0x1058a, 1, 39],
  [0x1058c, 0x10592, 1, 39],
  [0x10c80, 0x10cb2, 1, 64],
  [0x118a0, 0x118bf, 1, 32],
  [0x16e40, 0x16e5f, 1, 32],
  [0x1e900, 0x1e921, 1, 34],
];
const CASE_FOLD: Readonly<Record<string, string>> = {
  "\u00b5": "\u03bc", "\u00df": "ss", "\u0130": "i\u0307", "\u0149": "\u02bcn", "\u0178": "\u00ff",
  "\u017f": "s", "\u0181": "\u0253", "\u0182": "\u0183", "\u0184": "\u0185", "\u0186": "\u0254",
  "\u0187": "\u0188", "\u0189": "\u0256", "\u018a": "\u0257", "\u018b": "\u018c", "\u018e": "\u01dd",
  "\u018f": "\u0259", "\u0190": "\u025b", "\u0191": "\u0192", "\u0193": "\u0260", "\u0194": "\u0263",
  "\u0196": "\u0269", "\u0197": "\u0268", "\u0198": "\u0199", "\u019c": "\u026f", "\u019d": "\u0272",
  "\u019f": "\u0275", "\u01a6": "\u0280", "\u01a7": "\u01a8", "\u01a9": "\u0283", "\u01ac": "\u01ad",
  "\u01ae": "\u0288", "\u01af": "\u01b0", "\u01b1": "\u028a", "\u01b2": "\u028b", "\u01b3": "\u01b4",
  "\u01b5": "\u01b6", "\u01b7": "\u0292", "\u01b8": "\u01b9", "\u01bc": "\u01bd", "\u01c4": "\u01c6",
  "\u01c5": "\u01c6", "\u01c7": "\u01c9", "\u01c8": "\u01c9", "\u01ca": "\u01cc", "\u01f0": "j\u030c",
  "\u01f1": "\u01f3", "\u01f2": "\u01f3", "\u01f4": "\u01f5", "\u01f6": "\u0195", "\u01f7": "\u01bf",
  "\u0220": "\u019e", "\u023a": "\u2c65", "\u023b": "\u023c", "\u023d": "\u019a", "\u023e": "\u2c66",
  "\u0241": "\u0242", "\u0243": "\u0180", "\u0244": "\u0289", "\u0245": "\u028c", "\u0345": "\u03b9",
  "\u0370": "\u0371", "\u0372": "\u0373", "\u0376": "\u0377", "\u037f": "\u03f3", "\u0386": "\u03ac",
  "\u038c": "\u03cc", "\u038e": "\u03cd", "\u038f": "\u03ce", "\u0390": "\u03b9\u0308\u0301", "\u03b0": "\u03c5\u0308\u0301",
  "\u03c2": "\u03c3", "\u03cf": "\u03d7", "\u03d0": "\u03b2", "\u03d1": "\u03b8", "\u03d5": "\u03c6",
  "\u03d6": "\u03c0", "\u03f0": "\u03ba", "\u03f1": "\u03c1", "\u03f4": "\u03b8", "\u03f5": "\u03b5",
  "\u03f7": "\u03f8", "\u03f9": "\u03f2", "\u03fa": "\u03fb", "\u04c0": "\u04cf", "\u0587": "\u0565\u0582",
  "\u10c7": "\u2d27", "\u10cd": "\u2d2d", "\u1c80": "\u0432", "\u1c81": "\u0434", "\u1c82": "\u043e",
  "\u1c83": "\u0441", "\u1c84": "\u0442", "\u1c85": "\u0442", "\u1c86": "\u044a", "\u1c87": "\u0463",
  "\u1c88": "\ua64b", "\u1e96": "h\u0331", "\u1e97": "t\u0308", "\u1e98": "w\u030a", "\u1e99": "y\u030a",
  "\u1e9a": "a\u02be", "\u1e9b": "\u1e61", "\u1e9e": "ss", "\u1f50": "\u03c5\u0313", "\u1f52": "\u03c5\u0313\u0300",
  "\u1f54": "\u03c5\u0313\u0301", "\u1f56": "\u03c5\u0313\u0342", "\u1f80": "\u1f00\u03b9", "\u1f81": "\u1f01\u03b9", "\u1f82": "\u1f02\u03b9",
  "\u1f83": "\u1f03\u03b9", "\u1f84": "\u1f04\u03b9", "\u1f85": "\u1f05\u03b9", "\u1f86": "\u1f06\u03b9", "\u1f87": "\u1f07\u03b9",
  "\u1f88": "\u1f00\u03b9", "\u1f89": "\u1f01\u03b9", "\u1f8a": "\u1f02\u03b9", "\u1f8b": "\u1f03\u03b9", "\u1f8c": "\u1f04\u03b9",
  "\u1f8d": "\u1f05\u03b9", "\u1f8e": "\u1f06\u03b9", "\u1f8f": "\u1f07\u03b9", "\u1f90": "\u1f20\u03b9", "\u1f91": "\u1f21\u03b9",
  "\u1f92": "\u1f22\u03b9", "\u1f93": "\u1f23\u03b9", "\u1f94": "\u1f24\u03b9", "\u1f95": "\u1f25\u03b9", "\u1f96": "\u1f26\u03b9",
  "\u1f97": "\u1f27\u03b9", "\u1f98": "\u1f20\u03b9", "\u1f99": "\u1f21\u03b9", "\u1f9a": "\u1f22\u03b9", "\u1f9b": "\u1f23\u03b9",
  "\u1f9c": "\u1f24\u03b9", "\u1f9d": "\u1f25\u03b9", "\u1f9e": "\u1f26\u03b9", "\u1f9f": "\u1f27\u03b9", "\u1fa0": "\u1f60\u03b9",
  "\u1fa1": "\u1f61\u03b9", "\u1fa2": "\u1f62\u03b9", "\u1fa3": "\u1f63\u03b9", "\u1fa4": "\u1f64\u03b9", "\u1fa5": "\u1f65\u03b9",
  "\u1fa6": "\u1f66\u03b9", "\u1fa7": "\u1f67\u03b9", "\u1fa8": "\u1f60\u03b9", "\u1fa9": "\u1f61\u03b9", "\u1faa": "\u1f62\u03b9",
  "\u1fab": "\u1f63\u03b9", "\u1fac": "\u1f64\u03b9", "\u1fad": "\u1f65\u03b9", "\u1fae": "\u1f66\u03b9", "\u1faf": "\u1f67\u03b9",
  "\u1fb2": "\u1f70\u03b9", "\u1fb3": "\u03b1\u03b9", "\u1fb4": "\u03ac\u03b9", "\u1fb6": "\u03b1\u0342", "\u1fb7": "\u03b1\u0342\u03b9",
  "\u1fb8": "\u1fb0", "\u1fb9": "\u1fb1", "\u1fba": "\u1f70", "\u1fbb": "\u1f71", "\u1fbc": "\u03b1\u03b9",
  "\u1fbe": "\u03b9", "\u1fc2": "\u1f74\u03b9", "\u1fc3": "\u03b7\u03b9", "\u1fc4": "\u03ae\u03b9", "\u1fc6": "\u03b7\u0342",
  "\u1fc7": "\u03b7\u0342\u03b9", "\u1fcc": "\u03b7\u03b9", "\u1fd2": "\u03b9\u0308\u0300", "\u1fd3": "\u03b9\u0308\u0301", "\u1fd6": "\u03b9\u0342",
  "\u1fd7": "\u03b9\u0308\u0342", "\u1fd8": "\u1fd0", "\u1fd9": "\u1fd1", "\u1fda": "\u1f76", "\u1fdb": "\u1f77",
  "\u1fe2": "\u03c5\u0308\u0300", "\u1fe3": "\u03c5\u0308\u0301", "\u1fe4": "\u03c1\u0313", "\u1fe6": "\u03c5\u0342", "\u1fe7": "\u03c5\u0308\u0342",
  "\u1fe8": "\u1fe0", "\u1fe9": "\u1fe1", "\u1fea": "\u1f7a", "\u1feb": "\u1f7b", "\u1fec": "\u1fe5",
  "\u1ff2": "\u1f7c\u03b9", "\u1ff3": "\u03c9\u03b9", "\u1ff4": "\u03ce\u03b9", "\u1ff6": "\u03c9\u0342", "\u1ff7": "\u03c9\u0342\u03b9",
  "\u1ff8": "\u1f78", "\u1ff9": "\u1f79", "\u1ffa": "\u1f7c", "\u1ffb": "\u1f7d", "\u1ffc": "\u03c9\u03b9",
  "\u2126": "\u03c9", "\u212a": "k", "\u212b": "\u00e5", "\u2132": "\u214e", "\u2183": "\u2184",
  "\u2c60": "\u2c61", "\u2c62": "\u026b", "\u2c63": "\u1d7d", "\u2c64": "\u027d", "\u2c6d": "\u0251",
  "\u2c6e": "\u0271", "\u2c6f": "\u0250", "\u2c70": "\u0252", "\u2c72": "\u2c73", "\u2c75": "\u2c76",
  "\u2c7e": "\u023f", "\u2c7f": "\u0240", "\u2ceb": "\u2cec", "\u2ced": "\u2cee", "\u2cf2": "\u2cf3",
  "\ua779": "\ua77a", "\ua77b": "\ua77c", "\ua77d": "\u1d79", "\ua78b": "\ua78c", "\ua78d": "\u0265",
  "\ua790": "\ua791", "\ua792": "\ua793", "\ua7aa": "\u0266", "\ua7ab": "\u025c", "\ua7ac": "\u0261",
  "\ua7ad": "\u026c", "\ua7ae": "\u026a", "\ua7b0": "\u029e", "\ua7b1": "\u0287", "\ua7b2": "\u029d",
  "\ua7b3": "\uab53", "\ua7c4": "\ua794", "\ua7c5": "\u0282", "\ua7c6": "\u1d8e", "\ua7c7": "\ua7c8",
  "\ua7c9": "\ua7ca", "\ua7d0": "\ua7d1", "\ua7d6": "\ua7d7", "\ua7d8": "\ua7d9", "\ua7f5": "\ua7f6",
  "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl",
  "\ufb05": "st", "\ufb06": "st", "\ufb13": "\u0574\u0576", "\ufb14": "\u0574\u0565", "\ufb15": "\u0574\u056b",
  "\ufb16": "\u057e\u0576", "\ufb17": "\u0574\u056d", "\ud801\udd94": "\ud801\uddbb", "\ud801\udd95": "\ud801\uddbc",
};
export function casefold(value: string): string {
  return [...value].map(character => {
    const replacement = CASE_FOLD[character];
    if (replacement !== undefined) return replacement;
    const point = character.codePointAt(0)!;
    let lower = 0; let upper = CASE_FOLD_RANGES.length - 1;
    while (lower <= upper) {
      const middle = (lower + upper) >>> 1;
      const [first, last, stride, offset] = CASE_FOLD_RANGES[middle]!;
      if (point < first) upper = middle - 1;
      else if (point > last) lower = middle + 1;
      else return (point - first) % stride === 0 ? String.fromCodePoint(point + offset) : character;
    }
    return character;
  }).join('');
}
const SEARCH_FIELDS = ['project', 'recipient', 'channel', 'promise', 'agreement', 'basis', 'note', 'body'] as const;
export function contactMatches(contact: Contact, needle: string): boolean {
  return SEARCH_FIELDS.some(field => casefold(contact[field]).includes(needle));
}

/** Strict canonical Gregorian date; invalid legacy due strings are ignored. */
export function contactDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try { return date(value); } catch { return null; }
}
export function workspaceToday(now: string, timezone: string): string {
  if (typeof timezone !== 'string' || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timezone)) {
    throw new ServiceError('invalid_timezone');
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
    }).formatToParts(new Date(now));
    const part = (type: string): string => parts.find(item => item.type === type)?.value ?? '';
    const result = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
    if (part('era') !== 'AD' || contactDate(result) === null) throw new ServiceError('invalid_date');
    return result;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('invalid_timezone');
  }
}
function summary(contact: Contact): string {
  const firstLine = contact.body.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
    .find(line => pythonStrip(line));
  if (firstLine !== undefined) return pythonStrip(firstLine.replace(ANY_WHITESPACE, ' '));
  // PurePosixPath drops redundant slashes and dot components before .name/.stem.
  const parts = contact.source_path.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
  const name = parts.at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}
const OPEN = new Set<Contact['state']>(['下書き', '回答待ち', '対応中']);
const ALL = new Set<Contact['state']>([...OPEN, '送信済み', '完了', '送らない']);
const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Plain Contact behavior for one source: no ledger labels or ref prefixes. */
export function buildWaitingRows(contacts: readonly Contact[], today: string,
  options: Pick<WaitingOptions, 'include_all' | 'include_summaries'> = {}): WaitingRow[] {
  const groups = new Map<string, { project: string | null; contacts: Contact[] }>();
  for (const contact of contacts) {
    if (!(options.include_all ? ALL : OPEN).has(contact.state)) continue;
    const project = pythonStrip(contact.project);
    const key = project ? `project:${project}` : `contact:${contact.id}`;
    const group = groups.get(key) ?? { project: project || null, contacts: [] };
    group.contacts.push(contact); groups.set(key, group);
  }
  const rows = [...groups.values()].map(({ project, contacts: group }): WaitingRow => {
    const ordered = group.sort(compareContacts);
    const active = ordered.filter(contact => OPEN.has(contact.state));
    const turn = active.some(contact => contact.state === '下書き' || contact.state === '対応中') ? 'こちら'
      : active.length ? '相手' : null;
    const due = active.map(contact => contactDate(pythonStrip(contact.due)))
      .filter((value): value is string => value !== null).sort(compareContactText)[0] ?? null;
    const summaries = options.include_summaries === false ? [] : unique((active.length ? active : ordered).map(summary).filter(Boolean));
    const contactIds = ordered.map(contact => contact.id);
    return { project, turn, due, overdue: due !== null && due < today,
      states: unique(ordered.map(contact => contact.state)), summaries,
      contact_ids: contactIds, count: ordered.length, ledger_names: [], contact_refs: [...contactIds] };
  });
  const turnOrder = (turn: WaitingRow['turn']): number => turn === 'こちら' ? 0 : turn === '相手' ? 1 : 2;
  return rows.sort((a, b) => turnOrder(a.turn) - turnOrder(b.turn)
    || Number(b.overdue) - Number(a.overdue)
    || compareContactText(a.due ?? '9999-12-31', b.due ?? '9999-12-31')
    || compareContactText(casefold(a.project ?? ''), casefold(b.project ?? ''))
    || compareContactText(a.contact_refs[0]!, b.contact_refs[0]!));
}
