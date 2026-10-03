/* Generated from schema/contact_waiting.schema.json. Do not edit. Run pnpm run generate. */

export type ContactState = '下書き' | '送信済み' | '回答待ち' | '対応中' | '完了' | '送らない';
/**
 * Legacy contact identifier; retained unchanged, never recast as a UUID.
 */
export type ContactId = string;

export interface ContactWaitingRow {
  project: string | null;
  turn: 'こちら' | '相手' | null;
  due: string | null;
  overdue: boolean;
  states: ContactState[];
  summaries: string[];
  contact_ids: ContactId[];
  count: number;
  ledger_names: string[];
  contact_refs: string[];
}
