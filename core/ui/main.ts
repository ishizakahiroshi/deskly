import { mountWorkspace } from './workspace.js';
import type { WorkspaceOptions } from './workspace.js';
import { mountCases } from './cases.js';
import type { ContactRecord, ContactState } from '../src/generated/contact_record.js';
import type { ContactActionCommand } from '../src/generated/contact_command.js';
import type { ContactActionPreview } from '../src/generated/contact_preview.js';
import type { ContactWaitingRow } from '../src/generated/contact_waiting.js';
import type { ContactEvent } from '../src/generated/contact_event.js';

const states: readonly ContactState[] = ['下書き', '送信済み', '回答待ち', '対応中', '完了', '送らない'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const labels: Record<string, string> = { project: '案件', recipient: '宛先', channel: '連絡手段', state: '状態',
  sent_at: '送信日時', due: '期限', promise: '約束', agreement: '合意', basis: '根拠', note: '補足',
  references: '参照', shared_url: '共有先', sensitive: '機微の指定', body: '本文', summary: '返信の要約',
  created_at: '作成日時', updated_at: '更新日時', state_inferred: '状態の推定', id: '連絡 ID',
  version: '版番号', workspace_id: 'workspace ID', source_id: '接続元 ID' };
const summaryFields = ['id', 'project', 'recipient', 'channel', 'state', 'due'] as const;
type Summary = { version: number; contact: Pick<ContactRecord['contact'], typeof summaryFields[number]> };
class ContactApiError extends Error { constructor(readonly status: number) { super('Contact request failed'); } }
class StaleContactRequest extends Error {}
export interface ContactOptions {
  workspaceId: string;
  fetch?: typeof fetch;
  confirmDiscard?: () => boolean;
  onAccess?: (owner: boolean) => void;
}

/** Private text lives in the current DOM/confirmation only, never storage, history or URLs. */
export function mountContacts(root: HTMLElement, options: ContactOptions) {
  const doc = root.ownerDocument, win = doc.defaultView!;
  const fetcher = options.fetch ?? win.fetch.bind(win);
  const base = `/api/v1/workspaces/${options.workspaceId}`;
  let owner = false, busy = false, destroyed = false, epoch = 0, reopenRequested = false;
  const requests = new Set<AbortController>();
  let sourceId = '', selected: Summary | null = null;
  let editing: ContactActionCommand['action'] | null = null;
  // The signed API contract requires full snapshots; keep only while confirmation is pending.
  let pending: ContactActionPreview | null = null;
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = root.querySelector(`#contact-${id}`);
    if (!node) throw new Error('Missing contact element'); return node as T;
  };
  const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: unknown, className?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.textContent = String(value ?? '');
    if (className) node.className = className; return node;
  };
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const node = text('button', label); node.type = 'button';
    node.addEventListener('click', () => { if (!busy && !destroyed) action(); }); return node;
  };
  const message = (value: string): void => { el('message').textContent = value; };
  const field = (parent: HTMLElement, key: string, value: unknown): void => {
    const row = text('p', ''); row.append(text('strong', `${labels[key] ?? key}: `), text('span', value || '—')); parent.append(row);
  };
  function project(record: ContactRecord): Summary {
    return { version: record.version, contact: Object.fromEntries(summaryFields.map(key => [key, record.contact[key]])) as Summary['contact'] };
  }
  function clearPreview(): void { ++epoch; pending = null; el('preview').hidden = true; el('diff').replaceChildren(); }
  function clearBody(): void { el('body').replaceChildren(); el('body-panel').hidden = true; el('export').hidden = true; }
  function closeEditor(): void {
    clearPreview(); editing = null; el('fields').replaceChildren(); el('editor').hidden = true;
    el<HTMLInputElement>('reason').value = '';
  }
  function clearPrivate(): void {
    ++epoch; for (const request of requests) request.abort();
    closeEditor(); clearBody(); selected = null; el('detail').replaceChildren();
  }
  function discard(): boolean {
    return !(editing || pending) || (options.confirmDiscard?.() ?? win.confirm('未保存の入力があります。破棄して続けますか？'));
  }
  function leave(): boolean {
    if (busy || !discard()) return false;
    clearPrivate(); el('rows').replaceChildren(); el('waiting').replaceChildren();
    el<HTMLFormElement>('filters').reset(); message(''); return true;
  }
  function accessDenied(login = false): void {
    owner = false; clearPrivate(); el('rows').replaceChildren(); el('waiting').replaceChildren();
    el('content').hidden = true; options.onAccess?.(false);
    message(login ? 'ログインが必要です' : 'この画面を見る権限がありません');
  }
  function setBusy(value: boolean): void {
    busy = value; root.setAttribute('aria-busy', String(value));
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) control.disabled = value;
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const started = epoch, controller = new AbortController(); requests.add(controller);
    try {
      const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      if (started !== epoch || destroyed) throw new StaleContactRequest();
      if (!response.ok) throw new ContactApiError(response.status); // Never read/render the server's error text.
      const result: unknown = await response.json();
      if (started !== epoch || destroyed) throw new StaleContactRequest();
      return result as T;
    } catch (error) {
      if (started !== epoch || destroyed) throw new StaleContactRequest();
      throw error;
    } finally { requests.delete(controller); }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || destroyed) return;
    setBusy(true);
    try { await action(); } catch (error) {
      if (error instanceof StaleContactRequest || destroyed) return;
      if (error instanceof ContactApiError && [401, 403].includes(error.status)) accessDenied(error.status === 401);
      else if (error instanceof ContactApiError && error.status === 409) {
        clearPreview(); clearBody(); message('他の人が先に更新しました。「連絡を再読込」で最新の内容を確認し、もう一度変更を確認してください。');
      } else if (error instanceof ContactApiError && error.status === 404) {
        clearPrivate(); message('接続元または連絡が見つかりません。接続元 ID を確認し、「連絡を再読込」を押してください。');
      } else if (error instanceof ContactApiError && [400, 422].includes(error.status)) {
        clearPreview(); message('入力を確認してください。変更を保存できませんでした。');
      } else message('読み込みまたは保存を確認できませんでした。通信状態を確認して再試行してください。');
    } finally {
      if (!destroyed) {
        setBusy(false);
        if (reopenRequested) { reopenRequested = false; if (!root.hidden) void open(); }
      }
    }
  }
  const ledger = (): string => `${base}/sources/${sourceId}`;
  const contactPath = (id: string): string => `${ledger()}/contacts/${encodeURIComponent(id)}`;
  async function authorize(): Promise<void> {
    await api('/api/v1/accounts/me');
    await api(`${base}/memberships`); // This existing endpoint succeeds for persisted owners only.
    owner = true; options.onAccess?.(true); el('content').hidden = false;
  }
  async function open(): Promise<void> {
    clearPrivate(); root.hidden = false;
    return run(async () => {
      if (!uuid.test(options.workspaceId)) { accessDenied(true); return; }
      await authorize(); message('接続元 ID を指定して連絡を表示してください。');
      el<HTMLInputElement>('source').focus();
    });
  }
  function renderWaiting(rows: ContactWaitingRow[]): void {
    const box = el('waiting'); box.replaceChildren(text('h2', '誰の番か'));
    if (!rows.length) box.append(text('p', '次の連絡はありません。'));
    // The API uses Python views.py's turn/overdue/due/project/reference ordering. Do not re-sort.
    for (const row of rows) {
      const card = text('article', '', `workspace-card${row.overdue ? ' workspace-overdue' : ''}`);
      card.dataset.waitingRef = row.contact_ids[0]; card.append(text('h3', row.project || '案件なし'));
      field(card, '番', row.turn); field(card, 'due', row.due); field(card, '件数', row.count);
      field(card, 'state', row.states.join('・'));
      if (row.overdue) card.append(text('p', '期限切れ', 'overdue-label'));
      card.append(button('関連する連絡', () => {
        if (!discard()) return; clearPrivate();
        const filter = el<HTMLFormElement>('filters'); filter.reset();
        void run(async () => {
          await loadList(row.contact_ids);
          // Empty projects remain one row per contact, rather than opening every ungrouped contact.
          if (row.project === null && row.contact_ids[0]) await showDetail(row.contact_ids[0]);
        });
      })); box.append(card);
    }
  }
  async function loadList(contactIds?: readonly string[]): Promise<void> {
    const filters = el<HTMLFormElement>('filters');
    const query = new URLSearchParams();
    for (const key of ['state', 'project', 'q']) {
      const value = (filters.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement).value.trim(); if (value) query.set(key, value);
    }
    // List responses currently include body; immediately project to display-only metadata.
    const rows = (await api<{ items: ContactRecord[] }>(`${ledger()}/contacts${query.size ? `?${query}` : ''}`)).items.map(project).filter(item => !contactIds || contactIds.includes(item.contact.id));
    const box = el('rows'); box.replaceChildren(text('h2', `連絡の一覧 · ${rows.length} 件`));
    if (!rows.length) box.append(text('p', '一致する連絡はありません。'));
    for (const item of rows) {
      const card = text('article', '', 'workspace-card'); card.dataset.contactId = item.contact.id;
      card.append(text('h3', item.contact.project || '案件なし'));
      for (const key of ['recipient', 'channel', 'state', 'due'] as const) field(card, key, item.contact[key]);
      card.append(button('連絡の詳細', () => { if (discard()) { clearPrivate(); void run(() => showDetail(item.contact.id)); } }));
      box.append(card);
    }
  }
  async function reload(): Promise<void> {
    clearPrivate(); el('rows').replaceChildren(); el('waiting').replaceChildren();
    const source = el<HTMLInputElement>('source').value.trim();
    if (!uuid.test(source)) { sourceId = ''; message('接続元 ID を UUID 形式で入力してください。'); return; }
    sourceId = source;
    await authorize();
    renderWaiting((await api<{ items: ContactWaitingRow[] }>(`${ledger()}/waiting?include_summaries=false`)).items);
    await loadList(); message('連絡を読み込みました');
  }
  function appendDiff(parent: HTMLElement, before: ContactRecord | null, after: ContactRecord): void {
    const visible = text('dl', ''), technical = text('details', '');
    technical.append(text('summary', '内部情報（ID・版番号）'));
    const ids = text('dl', ''); technical.append(ids);
    for (const key of ['project', 'recipient', 'channel', 'state', 'due', 'sent_at', 'promise', 'agreement', 'basis', 'note', 'references', 'shared_url', 'sensitive', 'body'] as const) {
      const old = before?.contact[key] ?? '', next = after.contact[key];
      if (old === next) continue;
      visible.append(text('dt', labels[key]), text('dd', key === 'body' ? '入力した本文を保存します（本文は編集欄で確認）' : `${old || '—'} → ${next || '—'}`));
    }
    if (!visible.childNodes.length) visible.append(text('dt', '変更'), text('dd', '変更はありません'));
    for (const key of ['id', 'version', 'workspace_id', 'source_id'] as const) {
      const previous = key === 'id' ? before?.contact.id : before?.[key];
      const next = key === 'id' ? after.contact.id : after[key];
      ids.append(text('dt', labels[key]), text('dd', `${previous ?? '—'} → ${next}`));
    }
    parent.append(visible, technical);
  }
  async function showDetail(id: string): Promise<void> {
    const record = await api<ContactRecord>(contactPath(id));
    selected = project(record); clearBody();
    const box = el('detail'); box.replaceChildren(text('h2', '連絡の詳細'));
    for (const key of ['project', 'recipient', 'channel', 'state', 'due', 'sent_at', 'promise', 'agreement', 'basis', 'note', 'references', 'shared_url', 'sensitive'] as const) field(box, key, record.contact[key]);
    const actions = text('div', '', 'actions');
    actions.append(button('状態を変更', () => openEditor('set_state')), button('返信を記録', () => openEditor('record_reply')),
      button('本文を見る', () => { if (discard()) { closeEditor(); void run(() => showBody(false)); } }),
      button('本文の書き出しを確認', () => { if (discard()) { closeEditor(); void run(() => showBody(true)); } }),
      button('履歴を見る', () => { if (discard()) { closeEditor(); clearBody(); void run(showHistory); } }));
    box.append(actions); box.scrollIntoView?.({ block: 'nearest' });
  }
  async function showHistory(): Promise<void> {
    if (!selected) return;
    const id = selected.contact.id;
    const events = (await api<{ events: ContactEvent[] }>(`${contactPath(id)}/history`)).events;
    el('detail').querySelector('[data-history]')?.remove();
    const history = text('section', ''); history.dataset.history = ''; history.append(text('h3', '変更の履歴'));
    if (!events.length) history.append(text('p', '履歴はありません。'));
    for (const event of events) {
      const row = text('article', '', 'workspace-card'); field(row, '日時', event.at_utc); field(row, '変更理由', event.reason);
      // Full API snapshots are not retained or copied into attributes; body/import metadata never render.
      appendDiff(row, event.before, event.after);
      const bodyChange = row.querySelector('dl');
      if (bodyChange) for (const term of bodyChange.querySelectorAll('dt')) if (term.textContent === '本文' && term.nextElementSibling) term.nextElementSibling.textContent = '本文を変更しました（履歴では非表示）';
      const detail = row.querySelector('details dl'); if (detail) {
        detail.append(text('dt', '操作した本人 ID'), text('dd', event.requester_member_id));
      }
      history.append(row);
    }
    el('detail').append(history);
  }
  async function showBody(exporting: boolean): Promise<void> {
    if (!selected) return;
    clearBody();
    const result = await api<{ body: string }>(`${contactPath(selected.contact.id)}/body`);
    el('body').textContent = result.body; el('body-panel').hidden = false; el('export').hidden = !exporting;
    el('body-heading').textContent = exporting ? '本文の書き出しの見本' : '本文';
    message(exporting ? '内容を確認してから「この本文を書き出す」を押してください。送信は行いません。' : '本文はこの画面を離れると破棄します。');
    el('body-panel').scrollIntoView?.({ block: 'nearest' });
  }
  function addInput(name: string, kind: 'text' | 'date' | 'textarea' | 'state', value = ''): void {
    const label = text('label', labels[name] ?? name);
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (kind === 'state') {
      const select = doc.createElement('select');
      for (const state of states) { const option = text('option', state); option.value = state; select.append(option); } control = select;
    } else if (kind === 'textarea') { const area = doc.createElement('textarea'); area.rows = name === 'body' ? 7 : 3; area.maxLength = name === 'body' ? 200000 : 4000; control = area; }
    else { const input = doc.createElement('input'); input.type = kind; input.maxLength = 500; control = input; }
    control.name = name; control.value = value;
    if (control instanceof win.HTMLInputElement || control instanceof win.HTMLTextAreaElement) control.autocomplete = 'off';
    control.required = name === 'summary'; label.append(control); el('fields').append(label);
  }
  function openEditor(action: ContactActionCommand['action']): void {
    if (!owner || !sourceId || !discard() || (action !== 'add_draft' && !selected)) return;
    closeEditor(); clearBody(); editing = action;
    if (action === 'add_draft') {
      for (const key of ['project', 'recipient', 'channel', 'due', 'promise', 'agreement', 'note', 'body']) addInput(key, key === 'body' || key === 'note' ? 'textarea' : key === 'due' ? 'date' : 'text');
    } else if (action === 'set_state') addInput('state', 'state', selected!.contact.state);
    else addInput('summary', 'textarea');
    el('edit-heading').textContent = action === 'add_draft' ? '下書きを追加' : action === 'set_state' ? '状態を変更' : '返信を記録';
    el<HTMLInputElement>('reason').value = '連絡の記録を更新'; el('editor').hidden = false;
    el('editor').scrollIntoView?.({ block: 'start' }); el('fields').querySelector<HTMLElement>('input, select, textarea')?.focus(); message('');
  }
  const submit = (event: Event): void => {
    event.preventDefault();
    if (busy || !owner || !editing || !el<HTMLFormElement>('form').reportValidity()) return;
    const values = Object.fromEntries(new win.FormData(el<HTMLFormElement>('form')).entries()) as Record<string, string>;
    const common = { operation_id: win.crypto.randomUUID(), reason: values.reason!.trim() };
    let command: ContactActionCommand;
    if (editing === 'add_draft') { const { reason: _reason, ...data } = values; command = { ...common, action: editing, contact_id: null, expected_version: null, data }; }
    else if (!selected) return;
    else if (editing === 'set_state') command = { ...common, action: editing, contact_id: selected.contact.id, expected_version: selected.version, data: { state: values.state as ContactState } };
    else command = { ...common, action: editing, contact_id: selected.contact.id, expected_version: selected.version, data: { summary: values.summary! } };
    void run(async () => {
      clearPreview(); pending = await api<ContactActionPreview>(`${ledger()}/contacts/commands/preview`, command);
      appendDiff(el('diff'), pending.before, pending.after); el('preview').hidden = false;
      message('変更の見本を確認してから「この連絡を保存」を押してください。');
      el('preview').scrollIntoView?.({ block: 'nearest' });
    });
  };
  el('form').addEventListener('submit', submit);
  el('form').addEventListener('input', clearPreview); el('form').addEventListener('change', clearPreview);
  el('source-form').addEventListener('submit', event => { event.preventDefault(); if (!busy && discard()) void run(reload); });
  el('source').addEventListener('input', () => {
    if (!discard()) { el<HTMLInputElement>('source').value = sourceId; return; }
    clearPrivate(); sourceId = ''; el('rows').replaceChildren(); el('waiting').replaceChildren();
  });
  el('refresh').addEventListener('click', () => { if (!busy && discard()) void run(reload); });
  el('filters').addEventListener('submit', event => {
    event.preventDefault(); if (!busy && owner && sourceId && discard()) { clearPrivate(); void run(() => loadList()); }
  });
  el('add').addEventListener('click', () => { if (!busy) openEditor('add_draft'); });
  el('edit-cancel').addEventListener('click', () => { if (!busy && discard()) { closeEditor(); message(''); } });
  el('cancel').addEventListener('click', () => { if (!busy) { clearPreview(); message('変更の見本を閉じました。保存していません。'); } });
  el('body-close').addEventListener('click', () => { if (!busy) { clearBody(); message(''); } });
  el('apply').addEventListener('click', () => {
    if (busy || !pending || !owner) return;
    void run(async () => {
      const saved = project(await api<ContactRecord>(`${ledger()}/contacts/commands/apply`, pending));
      closeEditor(); clearBody(); selected = saved; el('detail').replaceChildren();
      message('保存しました');
      try {
        renderWaiting((await api<{ items: ContactWaitingRow[] }>(`${ledger()}/waiting?include_summaries=false`)).items);
        await loadList(); await showDetail(saved.contact.id);
      } catch (error) {
        if (error instanceof ContactApiError && [401, 403].includes(error.status)) accessDenied(error.status === 401);
        else if (!(error instanceof StaleContactRequest)) message('保存しましたが、最新の表示を取得できませんでした。「連絡を再読込」で確認してください。');
      }
    });
  });
  el('export').addEventListener('click', () => {
    if (busy || el('body-panel').hidden || el('export').hidden) return;
    try {
      const blob = new win.Blob([el('body').textContent ?? ''], { type: 'text/plain;charset=utf-8' });
      const url = win.URL.createObjectURL(blob);
      try { const link = doc.createElement('a'); link.href = url; link.download = 'deskly-contact.txt'; link.click(); }
      finally { win.URL.revokeObjectURL(url); }
      clearBody(); message('本文を書き出しました。外部への送信は行っていません。');
    } catch { clearBody(); message('本文を書き出せませんでした。ブラウザの設定を確認してください。'); }
  });
  const pageHide = (): void => { clearPrivate(); el('rows').replaceChildren(); el('waiting').replaceChildren(); el<HTMLFormElement>('filters').reset(); };
  const pageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      pageHide(); if (!root.hidden) { if (busy) reopenRequested = true; else void open(); }
    }
  };
  const beforeUnload = (event: BeforeUnloadEvent): void => { if (editing || pending) { event.preventDefault(); event.returnValue = ''; } };
  win.addEventListener('pagehide', pageHide); win.addEventListener('pageshow', pageShow); win.addEventListener('beforeunload', beforeUnload);
  return { open, canNavigate: leave, revoke: accessDenied, destroy(): void {
    destroyed = true; pageHide(); win.removeEventListener('pagehide', pageHide); win.removeEventListener('pageshow', pageShow); win.removeEventListener('beforeunload', beforeUnload);
  } };
}

/** Compose the views so navigation discards private contact/case text and rechecks permissions. */
export function mountDeskly(doc: Document, options: WorkspaceOptions) {
  const root = doc.getElementById('workspace-view')!;
  const contactRoot = doc.getElementById('contact-view')!;
  const caseRoot = doc.getElementById('case-view')!;
  const contactsButton = doc.getElementById('open-contacts') as HTMLButtonElement;
  const casesButton = doc.getElementById('open-cases') as HTMLButtonElement;
  const workspaceButton = doc.getElementById('open-workspace') as HTMLButtonElement;
  const displayAccess = (owner: boolean): void => {
    contactsButton.hidden = !owner; doc.getElementById('contact-access-message')!.hidden = owner;
  };
  const shared = { workspaceId: options.workspaceId, ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.confirmDiscard ? { confirmDiscard: options.confirmDiscard } : {}), onAccess: displayAccess };
  const contacts = mountContacts(contactRoot, shared);
  const cases = mountCases(caseRoot, { ...shared, onAccess(readable) {
    casesButton.hidden = !readable; doc.getElementById('case-access-message')!.hidden = readable;
  } });
  let caseAccess: Promise<void> = Promise.resolve();
  const workspace = mountWorkspace(root, { ...options, onAccess(owner) {
    displayAccess(owner); options.onAccess?.(owner); if (!owner) contacts.revoke();
    cases.revoke(); caseAccess = cases.checkAccess();
  } });
  const current = (button: HTMLButtonElement): void => {
    for (const item of [workspaceButton, contactsButton, casesButton]) item.setAttribute('aria-current', item === button ? 'page' : 'false');
  };
  const openContacts = (): void => {
    if (!contactRoot.hidden) return;
    if (!workspace.canNavigate() || !cases.canNavigate() || !contacts.canNavigate()) return;
    root.hidden = true; caseRoot.hidden = true; current(contactsButton); void contacts.open();
  };
  const openCases = (): void => {
    if (!caseRoot.hidden) return;
    if (!workspace.canNavigate() || !contacts.canNavigate() || !cases.canNavigate()) return;
    root.hidden = true; contactRoot.hidden = true; current(casesButton); void cases.open();
  };
  const openWorkspace = (): void => {
    if (!root.hidden) return;
    if (!contacts.canNavigate() || !cases.canNavigate()) return;
    contactRoot.hidden = true; caseRoot.hidden = true; root.hidden = false; current(workspaceButton); void workspace.load();
  };
  contactsButton.addEventListener('click', openContacts); casesButton.addEventListener('click', openCases);
  workspaceButton.addEventListener('click', openWorkspace);
  return { async load() { await workspace.load(); await caseAccess; }, destroy(): void {
    contacts.destroy(); cases.destroy(); workspace.destroy(); contactsButton.removeEventListener('click', openContacts);
    casesButton.removeEventListener('click', openCases); workspaceButton.removeEventListener('click', openWorkspace);
  } };
}
if (typeof document !== 'undefined' && document.getElementById('workspace-view')) {
  const meta = (name: string): string => document.querySelector<HTMLMetaElement>(`meta[name="deskly-${name}"]`)?.content ?? '';
  void mountDeskly(document, { workspaceId: meta('workspace'), memberId: meta('member') }).load();
}
