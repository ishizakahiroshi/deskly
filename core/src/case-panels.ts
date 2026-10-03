/**
 * The four case panels (design section 5) and the list derivations, computed
 * on read from rows the caller may already see; nothing here is stored.
 * Every panel counts the same rows: cases whose status is in the configured
 * open set, without any period cut. Dates compare as UTC calendar days.
 */
import type { Case } from './ports.js';
import type { CaseSettings, CaseWaiting } from './case-settings.js';

export type CaseWaitingCounts = Record<CaseWaiting, number>;
export interface CaseKindCount { kind: string; count: number }
export interface CaseScreenCount { screen_id: string | null; count: number }
export interface CaseSourcePanel {
  source: string;
  open: number;
  overdue: number;
  waiting: CaseWaitingCounts;
  kinds: CaseKindCount[];
}
export interface CasePanels {
  /** The UTC day the panels were counted on. */
  today: string;
  /** Cases in an open status, the population of every panel. */
  open: number;
  /** Open cases whose promised_due is before today. */
  overdue: number;
  /** Open cases by who they wait for, from the configured waiting map. */
  waiting: CaseWaitingCounts;
  /** Open cases by screen_id; most first, cases without a screen last. */
  screens: CaseScreenCount[];
  /** Open cases by configured kind, in settings order, zeros included. */
  kinds: CaseKindCount[];
  /** Per-source breakdown; present only for an operator (all sources and all tenants). */
  by_source?: CaseSourcePanel[];
}
/** A list row: the stored case plus marks derived on read. */
export type CaseListItem = Case & {
  /** A terminal case with no case_links row: nothing shows how it was fixed. */
  evidence_missing: boolean;
};

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isOpen = (settings: CaseSettings, row: Case): boolean => settings.statuses.open.includes(row.status);
const isOverdue = (row: Case, today: string): boolean => row.promised_due !== null && row.promised_due < today;

/** Open cases that must float to the top: hold_until has come, or promised_due has passed. */
export function needsAttention(settings: CaseSettings, row: Case, today: string): boolean {
  return isOpen(settings, row) && ((row.hold_until !== null && row.hold_until <= today) || isOverdue(row, today));
}

function waitingCounts(settings: CaseSettings, rows: readonly Case[]): CaseWaitingCounts {
  const counts: CaseWaitingCounts = { us: 0, them: 0, none: 0 };
  for (const row of rows) {
    const waiting = settings.statuses.waiting[row.status];
    if (waiting) counts[waiting] += 1;
  }
  return counts;
}
function kindCounts(settings: CaseSettings, rows: readonly Case[]): CaseKindCount[] {
  return settings.kinds.values.map(kind => ({ kind, count: rows.filter(row => row.kind === kind).length }));
}

/** Count panels over rows already cut to the caller's scope. */
export function casePanels(settings: CaseSettings, visible: readonly Case[], today: string, operator: boolean): CasePanels {
  const rows = visible.filter(row => isOpen(settings, row));
  const screens = new Map<string | null, number>();
  for (const row of rows) screens.set(row.screen_id, (screens.get(row.screen_id) ?? 0) + 1);
  const panels: CasePanels = {
    today,
    open: rows.length,
    overdue: rows.filter(row => isOverdue(row, today)).length,
    waiting: waitingCounts(settings, rows),
    screens: [...screens].map(([screen_id, count]) => ({ screen_id, count }))
      .sort((a, b) => b.count - a.count || (a.screen_id === null ? 1 : b.screen_id === null ? -1 : byCodePoint(a.screen_id, b.screen_id))),
    kinds: kindCounts(settings, rows),
  };
  if (operator) {
    const sources = [...new Set(rows.map(row => row.source))].sort(byCodePoint);
    panels.by_source = sources.map(source => {
      const own = rows.filter(row => row.source === source);
      return { source, open: own.length, overdue: own.filter(row => isOverdue(row, today)).length,
        waiting: waitingCounts(settings, own), kinds: kindCounts(settings, own) };
    });
  }
  return panels;
}
