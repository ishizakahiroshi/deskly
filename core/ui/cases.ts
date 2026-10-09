import type { Case } from '../src/generated/case.js';
import type { CaseActor, CaseEvent } from '../src/generated/case_event.js';
import type { CaseLink } from '../src/generated/case_link.js';
import type { CaseListItem, CasePanels } from '../src/case-panels.js';
import type { CaseDetail } from '../src/case-service.js';
import type { CaseSettings, CaseWaiting } from '../src/case-settings.js';

/*
 * Kinds, statuses and approval states are never written here: their identifiers,
 * order, open/terminal split, waiting map and display words all come from the
 * authorized settings API. The words below name values fixed by the design itself
 * (where a case came from, evidence kinds, who it waits for, field names).
 */
const ORIGIN_WORDS: Readonly<Record<Case['origin'], string>> = { human: '人が報告', detected: 'アプリが検知' };
const LINK_WORDS: Readonly<Record<CaseLink['link_type'], string>> = { commit: 'コミット', doc: '文書', url: '外部 URL' };
const WAITING_WORDS: Readonly<Record<CaseWaiting, string>> = { us: 'こちら待ち', them: '相手待ち', none: '待ちなし' };
type Field = CaseEvent['changes'][number]['field'];
const FIELD_WORDS: Readonly<Record<Field, string>> = { status: '状態', approval_state: '承認状態',
  promised_due: '約束した期日', hold_until: '保留の解除期限', closed_at: '閉じた日時' };
const PATCH_FIELDS = ['status', 'approval_state', 'promised_due', 'hold_until'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONFLICT = '他の人が先に更新しました。「受付を再読込」で最新の内容を確認し、もう一度変更を確認してください。';
const GENERIC = '読み込みまたは保存を確認できませんでした。通信状態を確認して再試行してください。';
const ROW_FIELDS = ['number', 'source', 'kind', 'status', 'approval_state', 'title', 'promised_due', 'hold_until', 'evidence_missing'] as const;
type Row = Pick<CaseListItem, typeof ROW_FIELDS[number]>;
type Selected = Pick<Case, 'number' | 'title' | 'revision' | 'kind' | 'status' | 'approval_state' | 'promised_due' | 'hold_until'> & { links: number };
type Editing = 'status' | 'approval' | 'dates' | 'reply' | 'link';
interface PatchBody {
  expected_revision: number; reason: string;
  status?: string; approval_state?: string; promised_due?: string | null; hold_until?: string | null;
}
type Pending = { kind: 'patch'; body: PatchBody } | { kind: 'reply'; body: { body: string } }
  | { kind: 'link'; body: { link_type: CaseLink['link_type']; ref: string } };
class CaseApiError extends Error { constructor(readonly status: number, readonly code: string) { super('Case request failed'); } }
class StaleCaseRequest extends Error {}
export interface CaseOptions {
  workspaceId: string;
  fetch?: typeof fetch;
  confirmDiscard?: () => boolean;
  onAccess?: (readable: boolean) => void;
  /** Display language; defaults to the document's lang. Settings without it show identifiers. */
  language?: string;
}

/** Scoped received-case view. Case text lives in the current DOM only, never storage, history or URLs. */
export function mountCases(root: HTMLElement, options: CaseOptions) {
  const doc = root.ownerDocument, win = doc.defaultView!;
  const fetcher = options.fetch ?? win.fetch.bind(win);
  const language = options.language ?? (doc.documentElement.lang || 'ja');
  const base = `/api/v1/workspaces/${options.workspaceId}/cases`;
  let readable = false, writable = false, busy = false, destroyed = false, epoch = 0, reopenRequested = false;
  const requests = new Set<AbortController>();
  let settings: CaseSettings | null = null, today = '', rows: Row[] = [];
  let selected: Selected | null = null, editing: Editing | null = null, pending: Pending | null = null;
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = root.querySelector(`#case-${id}`);
    if (!node) throw new Error('Missing case element'); return node as T;
  };
  const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: unknown, className?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.textContent = String(value ?? '');
    if (className) node.className = className; return node;
  };
  const button = (label: string, action: () => void, className?: string): HTMLButtonElement => {
    const node = text('button', label, className); node.type = 'button';
    node.addEventListener('click', () => { if (!busy && !destroyed) action(); }); return node;
  };
  const message = (value: string): void => { el('message').textContent = value; };
  const pair = (list: HTMLElement, term: string, value: unknown): void => {
    list.append(text('dt', term), text('dd', value === null || value === undefined || value === '' ? '—' : value));
  };
  const has = <T>(record: Readonly<Record<string, T>>, key: string): boolean => Object.hasOwn(record, key);
  /** Display word for a stored identifier; a missing language or label shows the identifier itself. */
  function label(value: string): string {
    const words = settings && has(settings.labels, language) ? settings.labels[language]! : undefined;
    return words && has(words, value) ? words[value]! : value;
  }
  const sourceName = (source: string): string =>
    settings && has(settings.numbering.display_names, source) ? settings.numbering.display_names[source]! : source;
  const isOpen = (status: string): boolean => settings?.statuses.open.includes(status) === true;
  const isTerminal = (status: string): boolean => settings?.statuses.terminal.includes(status) === true;
  const waitingOf = (status: string): CaseWaiting | undefined => settings && has(settings.statuses.waiting, status) ? settings.statuses.waiting[status] : undefined;
  const overdue = (row: Pick<Case, 'status' | 'promised_due'>): boolean => isOpen(row.status) && row.promised_due !== null && row.promised_due < today;
  const holdCame = (row: Pick<Case, 'status' | 'hold_until'>): boolean => isOpen(row.status) && row.hold_until !== null && row.hold_until <= today;
  const actorText = (actor: CaseActor): string => actor.kind === 'app' ? `アプリ ${actor.app}` : `メンバー ${actor.member_id}`;
  const shown = (field: Field, value: string | null): string => value === null ? '—' : field === 'status' || field === 'approval_state' ? label(value) : value;
  const holdHint = (): string => `保留の解除期限は、承認状態が「${label(settings!.approval_states.hold)}」のときだけ入力できます。`;
  function errorText(code: string): string {
    const known: Record<string, string> = {
      hold_until_requires_hold: settings ? holdHint() : '保留の解除期限を入力できない承認状態です。',
      approval_not_required: 'この種別は承認が要らないため、承認状態を変えられません。',
      invalid_status: '設定にない状態は選べません。「受付を再読込」で最新の設定を読み直してください。',
      invalid_approval_state: '設定にない承認状態は選べません。「受付を再読込」で最新の設定を読み直してください。',
      invalid_date: '日付は年-月-日（YYYY-MM-DD）の形で入力してください。',
      invalid_link: '関連の値を確認してください。コミットは 7〜64 文字の小文字の 16 進数、外部 URL は http:// か https:// で始まる URL です。',
      body_too_long: '本文が長すぎます。短くしてから保存してください。',
      required_field: '必須の欄が空です。入力してから保存してください。',
      no_changes: '変更がありません。',
    };
    return Object.hasOwn(known, code) ? known[code]! : '入力を確認してください。変更を保存できませんでした。';
  }

  function clearPreview(): void { ++epoch; pending = null; el('preview').hidden = true; el('diff').replaceChildren(); }
  function closeEditor(): void {
    clearPreview(); editing = null; el('fields').replaceChildren(); el('editor').hidden = true;
    el<HTMLInputElement>('reason').value = ''; el('edit-target').textContent = '';
  }
  function clearPrivate(): void {
    ++epoch; for (const request of requests) request.abort();
    closeEditor(); selected = null; el('detail').replaceChildren();
  }
  function clearLists(): void { rows = []; el('rows').replaceChildren(); el('panels').replaceChildren(); }
  function discard(): boolean {
    return !(editing || pending) || (options.confirmDiscard?.() ?? win.confirm('未保存の入力があります。破棄して続けますか？'));
  }
  function leave(): boolean {
    if (busy || !discard()) return false;
    clearPrivate(); clearLists(); el<HTMLFormElement>('filters').reset(); message(''); return true;
  }
  function accessDenied(login = false): void {
    readable = false; writable = false; settings = null; clearPrivate(); clearLists();
    el('content').hidden = true; options.onAccess?.(false);
    message(login ? 'ログインが必要です' : 'この画面を見る権限がありません');
  }
  /** Re-apply the rules that depend on the current input after any enable/disable pass. */
  function syncControls(): void {
    const reason = el<HTMLInputElement>('reason'), patching = editing === 'status' || editing === 'approval' || editing === 'dates';
    reason.disabled = busy || !patching; el('reason-label').hidden = !patching;
    const hold = el('fields').querySelector<HTMLInputElement>('[name="hold_until"]');
    if (!hold || !settings || !selected) return;
    const approval = el('fields').querySelector<HTMLSelectElement>('[name="approval_state"]');
    const allowed = (approval ? approval.value : selected.approval_state) === settings.approval_states.hold;
    if (!allowed) hold.value = '';
    hold.disabled = busy || !allowed;
  }
  function setBusy(value: boolean): void {
    busy = value; root.setAttribute('aria-busy', String(value));
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) control.disabled = value;
    syncControls();
  }
  async function api<T>(path: string, method: 'GET' | 'PATCH' | 'POST' = 'GET', body?: unknown): Promise<T> {
    const started = epoch, controller = new AbortController(); requests.add(controller);
    const stale = (): boolean => started !== epoch || destroyed;
    try {
      const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'GET' ? {} : { method }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (stale()) throw new StaleCaseRequest();
      if (!response.ok) {
        // Only the machine code picks a fixed Japanese message; the server's text is never shown.
        let code = '';
        try {
          const value: unknown = await response.json();
          if (value !== null && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string') code = (value as { error: string }).error;
        } catch { code = ''; }
        if (stale()) throw new StaleCaseRequest();
        throw new CaseApiError(response.status, code);
      }
      const result: unknown = await response.json();
      if (stale()) throw new StaleCaseRequest();
      return result as T;
    } catch (error) {
      if (stale()) throw new StaleCaseRequest();
      throw error;
    } finally { requests.delete(controller); }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || destroyed) return;
    setBusy(true);
    try { await action(); } catch (error) {
      if (error instanceof StaleCaseRequest || destroyed) return;
      if (!(error instanceof CaseApiError)) message(GENERIC);
      else if ([401, 403].includes(error.status)) accessDenied(error.status === 401);
      else if (error.status === 409) {
        clearPreview(); message(error.code === 'sharing_not_enabled' ? 'この workspace ではまだ受付を使えません。' : CONFLICT);
      } else if (error.status === 404 && error.code === 'cases_not_enabled') {
        clearPrivate(); clearLists(); el('content').hidden = true;
        message('受付は有効になっていません。受付の設定を置くと使えるようになります。');
      } else if (error.status === 404) {
        clearPrivate(); message('受付が見つかりません。「受付を再読込」で最新の一覧を確認してください。');
      } else if ([400, 422].includes(error.status)) { clearPreview(); message(errorText(error.code)); }
      else message(GENERIC);
    } finally {
      if (!destroyed) {
        setBusy(false);
        if (reopenRequested) { reopenRequested = false; if (!root.hidden) void open(); }
      }
    }
  }
  const casePath = (number: string): string => `${base}/${encodeURIComponent(number)}`;

  async function open(): Promise<void> {
    clearPrivate(); root.hidden = false;
    return run(async () => {
      if (!uuid.test(options.workspaceId)) { accessDenied(true); return; }
      await reload();
    });
  }
  async function reload(): Promise<void> {
    clearPrivate(); clearLists();
    await authority();
    el('content').hidden = false;
    await refresh();
    message(`受付を読み込みました（${rows.length} 件）`);
  }
  async function authority(): Promise<void> {
    readable = false; writable = false;
    settings = await api<CaseSettings>(`${base}/settings`);
    if (settings.member_access.enabled) {
      try {
        const scope = await api<{ role: 'viewer' | 'editor' }>(`${base}/member-scopes/me`);
        writable = scope.role === 'editor';
      } catch (error) {
        if (!(error instanceof CaseApiError) || error.status !== 404 || error.code !== 'not_found') throw error;
        // Owners have no scope row. Verify owner authority separately: a revoked
        // member's missing row must never turn into an editor permission.
        await api(base.replace(/\/cases$/, '/memberships'));
        writable = true;
      }
    } else writable = true; // Disabled member access makes settings owner-only.
    readable = true; options.onAccess?.(true);
  }
  async function checkAccess(): Promise<void> {
    clearPrivate(); clearLists(); el('content').hidden = true;
    try { await authority(); } catch (error) {
      if (error instanceof StaleCaseRequest || destroyed) return;
      accessDenied(error instanceof CaseApiError && error.status === 401);
    }
  }
  async function refresh(): Promise<void> {
    const panels = await api<CasePanels>(`${base}/panels`);
    // Lists include body; keep only the display fields of each row.
    const items = (await api<{ items: CaseListItem[] }>(base)).items;
    today = panels.today;
    rows = items.map(item => Object.fromEntries(ROW_FIELDS.map(key => [key, item[key]])) as Row);
    renderPanels(panels); renderFilters(); renderList();
  }

  function renderPanels(panels: CasePanels): void {
    const box = el('panels');
    box.replaceChildren(text('h2', '受付のパネル'),
      text('p', `未完了の受付 ${panels.open} 件を、期間で区切らずに数えています（${panels.today} 時点・UTC）。`, 'muted'));
    const grid = text('div', '', 'case-panels');
    const card = (name: string, heading: string): HTMLElement => {
      const node = text('article', '', 'workspace-card'); node.dataset.panel = name; node.append(text('h3', heading)); grid.append(node); return node;
    };
    const overdueCard = card('overdue', '期限を過ぎた');
    overdueCard.append(text('p', `${panels.overdue} 件`, 'case-count'),
      text('p', panels.overdue ? '約束した期日を過ぎています。今日どれから手を付けるかを決めます。' : '期限を過ぎた受付はありません。', 'muted'));
    const waitingList = text('dl', '');
    for (const key of ['us', 'them', 'none'] as const) pair(waitingList, WAITING_WORDS[key], `${panels.waiting[key]} 件`);
    card('waiting', '誰待ちで止まっているか').append(waitingList);
    const screens = card('screens', 'どの画面で起きているか');
    if (!panels.screens.length) screens.append(text('p', '未完了の受付はありません。', 'muted'));
    else {
      const list = text('dl', '');
      for (const row of panels.screens.slice(0, 10)) pair(list, row.screen_id ?? '画面の指定なし', `${row.count} 件`);
      screens.append(list);
      if (panels.screens.length > 10) screens.append(text('p', `ほか ${panels.screens.length - 10} 画面`, 'muted'));
    }
    const kinds = text('dl', '');
    for (const row of panels.kinds) {
      pair(kinds, label(row.kind), `${row.count} 件（${panels.open ? Math.round(row.count * 100 / panels.open) : 0}%）`);
    }
    card('kinds', '種類の比率').append(kinds);
    if (panels.by_source) {
      // Operators only (the API omits by_source for everyone else).
      const sources = card('sources', 'アプリ別の内訳');
      if (!panels.by_source.length) sources.append(text('p', '未完了の受付はありません。', 'muted'));
      for (const row of panels.by_source) {
        const part = text('section', '', 'case-source'); part.dataset.source = row.source;
        part.append(text('h4', sourceName(row.source)),
          text('p', `未完了 ${row.open} 件 · 期限切れ ${row.overdue} 件`),
          text('p', (['us', 'them', 'none'] as const).map(key => `${WAITING_WORDS[key]} ${row.waiting[key]}`).join(' · ')),
          text('p', row.kinds.filter(item => item.count > 0).map(item => `${label(item.kind)} ${item.count}`).join(' · ') || '—', 'muted'));
        sources.append(part);
      }
    }
    box.append(grid);
  }
  const filterControl = (name: string): HTMLSelectElement | HTMLInputElement =>
    el<HTMLFormElement>('filters').elements.namedItem(name) as HTMLSelectElement | HTMLInputElement;
  function fillSelect(select: HTMLSelectElement, values: readonly (readonly [string, string])[]): void {
    const current = select.value;
    const all = text('option', 'すべて'); all.value = '';
    select.replaceChildren(all, ...values.map(([value, word]) => { const option = text('option', word); option.value = value; return option; }));
    select.value = values.some(([value]) => value === current) ? current : '';
  }
  function renderFilters(): void {
    if (!settings) return;
    fillSelect(filterControl('status') as HTMLSelectElement, settings.statuses.values.map(value => [value, label(value)] as const));
    fillSelect(filterControl('kind') as HTMLSelectElement, settings.kinds.values.map(value => [value, label(value)] as const));
    const sources = [...new Set(rows.map(row => row.source))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    fillSelect(filterControl('source') as HTMLSelectElement, sources.map(value => [value, sourceName(value)] as const));
    fillSelect(filterControl('waiting') as HTMLSelectElement, (['us', 'them', 'none'] as const).map(value => [value, WAITING_WORDS[value]] as const));
  }
  function marks(parent: HTMLElement, row: Pick<Case, 'status' | 'promised_due' | 'hold_until'>, evidenceMissing: boolean): void {
    const line = text('p', '', 'case-marks');
    if (overdue(row)) line.append(text('span', '期限切れ', 'overdue-label case-mark-overdue'));
    if (holdCame(row)) line.append(text('span', '保留の解除期限が来た', 'overdue-label case-mark-hold'));
    if (evidenceMissing) line.append(text('span', '証拠なし', 'case-mark-evidence'));
    if (line.childNodes.length) parent.append(line);
  }
  function renderList(): void {
    const value = (name: string): string => filterControl(name).value;
    const onlyOverdue = (filterControl('overdue') as HTMLInputElement).checked;
    // The API already puts open cases whose hold_until has come or whose promised_due has passed first. Never re-sort.
    const visible = rows.filter(row => (!value('status') || row.status === value('status')) && (!value('kind') || row.kind === value('kind'))
      && (!value('source') || row.source === value('source')) && (!value('waiting') || waitingOf(row.status) === value('waiting'))
      && (!onlyOverdue || overdue(row)));
    const box = el('rows');
    box.replaceChildren(text('h2', `受付の一覧 · ${visible.length} 件${visible.length === rows.length ? '' : `（全 ${rows.length} 件）`}`));
    if (!visible.length) box.append(text('p', rows.length ? '一致する受付はありません。' : '受付はまだありません。'));
    for (const row of visible) {
      const card = text('article', '', `workspace-card${overdue(row) || holdCame(row) ? ' workspace-overdue' : ''}`);
      card.dataset.caseNumber = row.number;
      card.append(text('h3', `${row.number} ${row.title}`));
      marks(card, row, row.evidence_missing);
      const list = text('dl', '');
      pair(list, '種別', label(row.kind)); pair(list, '状態', label(row.status)); pair(list, '承認状態', label(row.approval_state));
      const waiting = waitingOf(row.status);
      pair(list, '誰待ち', waiting ? WAITING_WORDS[waiting] : '—'); pair(list, 'アプリ', sourceName(row.source));
      pair(list, FIELD_WORDS.promised_due, row.promised_due);
      if (row.hold_until !== null) pair(list, FIELD_WORDS.hold_until, row.hold_until);
      card.append(list, button('受付の詳細', () => { if (discard()) { clearPrivate(); void run(() => showDetail(row.number)); } }));
      box.append(card);
    }
  }

  async function showDetail(number: string): Promise<void> {
    const detail = await api<CaseDetail>(casePath(number));
    const row = detail.case;
    selected = { number: row.number, title: row.title, revision: row.revision, kind: row.kind, status: row.status,
      approval_state: row.approval_state, promised_due: row.promised_due, hold_until: row.hold_until, links: detail.links.length };
    const box = el('detail');
    box.replaceChildren(text('h2', '受付の詳細'), text('h3', `${row.number} ${row.title}`));
    const terminalWithoutEvidence = isTerminal(row.status) && detail.links.length === 0;
    marks(box, row, terminalWithoutEvidence);
    const summary = text('dl', '');
    const waiting = waitingOf(row.status);
    pair(summary, 'アプリ', sourceName(row.source)); pair(summary, '顧客', row.tenant_ref); pair(summary, '出どころ', ORIGIN_WORDS[row.origin]);
    pair(summary, '種別', label(row.kind)); pair(summary, '状態', label(row.status)); pair(summary, '承認状態', label(row.approval_state));
    pair(summary, '誰待ち', waiting ? WAITING_WORDS[waiting] : '—');
    pair(summary, FIELD_WORDS.promised_due, row.promised_due); pair(summary, FIELD_WORDS.hold_until, row.hold_until);
    pair(summary, FIELD_WORDS.closed_at, row.closed_at); pair(summary, '報告した人', row.reporter_ref);
    pair(summary, '受け付けた日時', row.created_at); pair(summary, '更新した日時', row.updated_at);
    box.append(summary);
    const actions = text('div', '', 'actions');
    actions.append(button('状態を変更', () => openEditor('status')));
    if (settings?.kinds.requires_approval.includes(row.kind)) actions.append(button('承認状態を変更', () => openEditor('approval')));
    actions.append(button('期日を変更', () => openEditor('dates')), button('返事を追加', () => openEditor('reply')),
      button('関連を追加', () => openEditor('link')));
    if (writable) box.append(actions);
    if (!settings?.kinds.requires_approval.includes(row.kind)) box.append(text('p', 'この種別は承認が要らないため、承認状態は変えられません。', 'muted'));

    const section = (heading: string): HTMLElement => { const node = text('section', '', 'case-section'); node.append(text('h3', heading)); box.append(node); return node; };
    section('本文').append(text('pre', row.body || '（本文なし）', 'case-text'));
    const place = text('dl', '');
    pair(place, '画面', row.screen_id); pair(place, '機能', row.feature_id); pair(place, '環境', row.environment);
    pair(place, '版', row.version); pair(place, 'URL', row.url);
    if (row.fingerprint !== null) pair(place, '検知の指紋', row.fingerprint);
    if (row.legacy_ref !== null) pair(place, '送り手の ID', row.legacy_ref);
    if (row.duplicate_of !== null) pair(place, '重複先の受付', row.duplicate_of);
    section('発生した場所').append(place);

    const links = section(`関連 · ${detail.links.length} 件`); links.dataset.caseLinks = '';
    if (terminalWithoutEvidence) links.append(text('p', '証拠なし: 終わった受付ですが、直した証拠（コミット・文書・URL）がまだありません。', 'case-mark-evidence'));
    else if (!detail.links.length) links.append(text('p', '関連はまだありません。', 'muted'));
    for (const link of detail.links) {
      const item = text('dl', ''); pair(item, LINK_WORDS[link.link_type], link.ref);
      pair(item, '追加した主体', actorText(link.added_by)); pair(item, '追加した日時', link.created_at); links.append(item);
    }
    const replies = section(`返事 · ${detail.replies.length} 件`); replies.dataset.caseReplies = '';
    if (!detail.replies.length) replies.append(text('p', '返事はまだありません。', 'muted'));
    for (const reply of detail.replies) {
      const item = text('article', '', 'workspace-card'), facts = text('dl', '');
      pair(facts, '保存した日時', reply.created_at); pair(facts, '届いた日時', reply.delivered_at ?? '記録なし');
      pair(facts, '書いた主体', actorText(reply.author)); if (reply.author_ref !== null) pair(facts, '書いた人', reply.author_ref);
      item.append(facts, text('pre', reply.body, 'case-text')); replies.append(item);
    }
    const people = section(`同じことを報告した人 · ${detail.people.length} 人`);
    if (!detail.people.length) people.append(text('p', '追加の報告者はいません。', 'muted'));
    for (const person of detail.people) {
      const item = text('dl', ''); pair(item, '報告した人', person.reporter_ref);
      pair(item, '追加した主体', actorText(person.added_by)); pair(item, '追加した日時', person.created_at); people.append(item);
    }
    const history = section('履歴'); history.dataset.caseHistory = '';
    for (const event of detail.events) {
      const item = text('article', '', 'workspace-card'), facts = text('dl', '');
      pair(facts, '日時', event.at_utc); pair(facts, '操作', event.action === 'create' ? '受け付け' : '更新');
      pair(facts, '主体', actorText(event.actor));
      if (event.actor_ref !== null) pair(facts, '操作した人', event.actor_ref);
      if (event.reason !== null) pair(facts, '変更理由', event.reason);
      for (const change of event.changes) pair(facts, FIELD_WORDS[change.field], `${shown(change.field, change.before)} → ${shown(change.field, change.after)}`);
      item.append(facts); history.append(item);
    }
    const technical = text('details', ''), ids = text('dl', '');
    technical.append(text('summary', '内部情報（版番号・workspace ID）'), ids);
    pair(ids, '版番号', row.revision); pair(ids, 'workspace ID', row.workspace_id); pair(ids, '連番', row.seq);
    box.append(technical); box.scrollIntoView?.({ block: 'nearest' });
  }

  function addControl(name: string, word: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
    const node = text('label', word); control.name = name;
    if (!(control instanceof win.HTMLSelectElement)) control.autocomplete = 'off';
    node.append(control); el('fields').append(node);
  }
  function choose(name: string, word: string, values: readonly (readonly [string, string])[], current: string): void {
    const select = doc.createElement('select');
    for (const [value, display] of values) { const option = text('option', display); option.value = value; select.append(option); }
    select.value = current; addControl(name, word, select);
  }
  function dateInput(name: 'promised_due' | 'hold_until', current: string | null): void {
    const input = doc.createElement('input'); input.type = 'date'; input.value = current ?? '';
    addControl(name, `${FIELD_WORDS[name]}（空で消す）`, input);
  }
  function openEditor(kind: Editing): void {
    if (!writable || !settings || !selected || !discard()) return;
    closeEditor(); editing = kind;
    const s = settings, current = selected;
    const headings: Record<Editing, string> = { status: '状態を変更', approval: '承認状態を変更', dates: '期日を変更', reply: '返事を追加', link: '関連を追加' };
    if (kind === 'status') choose('status', '状態', s.statuses.values.map(value => [value, label(value)] as const), current.status);
    else if (kind === 'approval') {
      choose('approval_state', '承認状態', s.approval_states.values.map(value => [value, label(value)] as const), current.approval_state);
      dateInput('hold_until', current.hold_until);
    } else if (kind === 'dates') { dateInput('promised_due', current.promised_due); dateInput('hold_until', current.hold_until); }
    else if (kind === 'reply') {
      const area = doc.createElement('textarea'); area.rows = 6; area.maxLength = 50_000; area.required = true;
      addControl('body', '返事の本文', area);
      el('fields').append(text('p', '保存するのは記録だけです。相手へは送信しません。', 'muted'));
    } else {
      choose('link_type', '関連の種類', (Object.keys(LINK_WORDS) as CaseLink['link_type'][]).map(value => [value, LINK_WORDS[value]] as const), 'commit');
      const input = doc.createElement('input'); input.type = 'text'; input.maxLength = 2000; input.required = true;
      addControl('ref', '値（コミットのハッシュ・文書の場所・URL）', input);
    }
    if (el('fields').querySelector('[name="hold_until"]')) el('fields').append(text('p', holdHint(), 'muted'));
    el('edit-heading').textContent = headings[kind];
    el('edit-target').textContent = `${current.number} ${current.title}`;
    el<HTMLInputElement>('reason').value = '受付の状況を更新';
    el('editor').hidden = false; syncControls();
    el('editor').scrollIntoView?.({ block: 'start' });
    el('fields').querySelector<HTMLElement>('input:not([disabled]), select, textarea')?.focus(); message('');
  }
  function renderPending(): void {
    if (!pending || !selected) return;
    const box = el('diff'), list = text('dl', '');
    box.replaceChildren(list);
    if (pending.kind === 'patch') {
      const body = pending.body, current = selected;
      for (const key of PATCH_FIELDS) {
        if (!Object.hasOwn(body, key)) continue;
        pair(list, FIELD_WORDS[key], `${shown(key, current[key])} → ${shown(key, body[key] ?? null)}`);
      }
      pair(list, '変更理由', body.reason);
      if (body.status !== undefined && isTerminal(body.status) && !isTerminal(current.status)) {
        box.append(text('p', '閉じた日時は、保存したときに台帳が入れます。', 'muted'));
        if (current.links === 0) box.append(text('p', '直した証拠（関連）がまだ 1 件もないため、保存すると一覧に「証拠なし」の印が付きます。', 'case-mark-evidence'));
      }
      if (body.status !== undefined && !isTerminal(body.status) && isTerminal(current.status)) box.append(text('p', '閉じた日時は空に戻ります。', 'muted'));
    } else if (pending.kind === 'reply') {
      pair(list, '操作', '返事を記録します（相手へは送信しません）');
      box.append(text('h3', '返事の本文'), text('pre', pending.body.body, 'case-text'));
    } else {
      pair(list, '操作', '関連を追加します'); pair(list, '関連の種類', LINK_WORDS[pending.body.link_type]); pair(list, '値', pending.body.ref);
      box.append(text('p', '同じ種類と値の関連が既にあれば、新しい行は増えません。', 'muted'));
    }
    const technical = text('details', ''), ids = text('dl', '');
    technical.append(text('summary', '内部情報（受付番号・版番号）'), ids);
    pair(ids, '受付番号', selected.number); pair(ids, '版番号', selected.revision);
    box.append(technical);
  }
  const submit = (event: Event): void => {
    event.preventDefault();
    const form = el<HTMLFormElement>('form');
    if (busy || !writable || !settings || !editing || !selected || !form.reportValidity()) return;
    const value = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? '';
    const current = selected, hold = settings.approval_states.hold;
    let next: Pending;
    if (editing === 'reply') {
      const body = value('body');
      if (!body.trim()) { message('返事の本文を入力してください。'); return; }
      next = { kind: 'reply', body: { body } };
    } else if (editing === 'link') {
      const type = value('link_type'), ref = value('ref').trim();
      if (!Object.hasOwn(LINK_WORDS, type) || !ref) { message('関連の種類と値を入力してください。'); return; }
      next = { kind: 'link', body: { link_type: type as CaseLink['link_type'], ref } };
    } else {
      const body: PatchBody = { expected_revision: current.revision, reason: value('reason').trim() };
      if (editing === 'status' && value('status') !== current.status) body.status = value('status');
      if (editing === 'approval') {
        const approval = value('approval_state');
        if (approval !== current.approval_state) body.approval_state = approval;
        const until = approval === hold ? value('hold_until') || null : null;
        if (until !== current.hold_until) body.hold_until = until;
      }
      if (editing === 'dates') {
        const due = value('promised_due') || null;
        if (due !== current.promised_due) body.promised_due = due;
        if (current.approval_state === hold) {
          const until = value('hold_until') || null;
          if (until !== current.hold_until) body.hold_until = until;
        }
      }
      if (!PATCH_FIELDS.some(key => Object.hasOwn(body, key))) { message('変更がありません。'); return; }
      next = { kind: 'patch', body };
    }
    clearPreview(); pending = next; renderPending(); el('preview').hidden = false;
    message('変更の内容を確認してから「この内容で受付を保存」を押してください。');
    el('preview').scrollIntoView?.({ block: 'nearest' });
  };
  const apply = (): void => {
    if (busy || !pending || !writable || !selected) return;
    const action = pending, number = selected.number;
    void run(async () => {
      try {
        if (action.kind === 'patch') await api<Case>(casePath(number), 'PATCH', action.body);
        else await api<unknown>(`${casePath(number)}/${action.kind === 'reply' ? 'replies' : 'links'}`, 'POST', action.body);
      } catch (error) {
        // A lost answer may still have been saved; never resend blindly (a reply would be stored twice).
        if (error instanceof StaleCaseRequest || (error instanceof CaseApiError && error.status < 500)) throw error;
        clearPreview(); message('保存できたかを確認できませんでした。「受付を再読込」で保存されたかを確かめてから、必要ならもう一度操作してください。');
        return;
      }
      closeEditor(); message('保存しました');
      try { await refresh(); await showDetail(number); } catch (error) {
        if (error instanceof CaseApiError && [401, 403].includes(error.status)) accessDenied(error.status === 401);
        else if (!(error instanceof StaleCaseRequest)) message('保存しましたが、最新の表示を取得できませんでした。「受付を再読込」で確認してください。');
      }
    });
  };
  el('form').addEventListener('submit', submit);
  const changed = (): void => { clearPreview(); syncControls(); };
  el('form').addEventListener('input', changed); el('form').addEventListener('change', changed);
  el('refresh').addEventListener('click', () => { if (!busy && discard()) void run(reload); });
  el('filters').addEventListener('submit', event => { event.preventDefault(); if (readable && settings) renderList(); });
  el('filters').addEventListener('change', () => { if (readable && settings) renderList(); });
  el('edit-cancel').addEventListener('click', () => { if (!busy && discard()) { closeEditor(); message(''); } });
  el('cancel').addEventListener('click', () => { if (!busy) { clearPreview(); message('確認を閉じました。保存していません。'); } });
  el('apply').addEventListener('click', apply);
  const pageHide = (): void => { clearPrivate(); clearLists(); el<HTMLFormElement>('filters').reset(); };
  const pageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      pageHide(); if (!root.hidden) { if (busy) reopenRequested = true; else void open(); }
    }
  };
  const beforeUnload = (event: BeforeUnloadEvent): void => { if (editing || pending) { event.preventDefault(); event.returnValue = ''; } };
  win.addEventListener('pagehide', pageHide); win.addEventListener('pageshow', pageShow); win.addEventListener('beforeunload', beforeUnload);
  return { open, checkAccess, canNavigate: leave, revoke: accessDenied, destroy(): void {
    destroyed = true; pageHide(); win.removeEventListener('pagehide', pageHide); win.removeEventListener('pageshow', pageShow); win.removeEventListener('beforeunload', beforeUnload);
  } };
}
