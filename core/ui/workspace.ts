/** One framework-free workspace UI. Only the frozen, same-origin v1 API is used. */
import type { Project } from '../src/generated/project.js';
import type { Milestone } from '../src/generated/milestone.js';
import type { WorkItem } from '../src/generated/work_item.js';
import type { Workspace } from '../src/generated/workspace.js';
import type { CurrentProjectRoles, EffectiveRole } from '../src/generated/project_roles.js';
import type { Membership, ProjectMembership, WorkspaceMembership } from '../src/generated/membership.js';
import type { Event as WorkspaceEvent } from '../src/generated/event.js';
import type { CommandPreview, CommandRequest } from '../src/service.js';

type Entity = Project | Milestone | WorkItem;
type Kind = Entity['type'];
type Tab = 'all' | 'detail' | 'mine' | 'access';
type Field = readonly [name: string, label: string, choices?: readonly string[] | 'date' | 'member' | 'milestone'];
const states = ['未確認', '進行中', '待ち', '完了', '保留'] as const;
const schemas: Record<Kind, readonly Field[]> = {
  project: [['name', '案件名'], ['purpose', '目的'], ['owner_id', '主担当', 'member'], ['state', '状態', ['未確認', '進行中', '保留', '終了']]],
  milestone: [['goal', '目標'], ['acceptance', '受入条件'], ['assignee_id', '担当', 'member'], ['check_date', '確認日', 'date'], ['state', '状態', states]],
  work_item: [['kind', '分野', ['開発', '営業', '運営']], ['title', '題名'], ['assignee_id', '担当', 'member'],
    ['next_action', '次の行動'], ['check_date', '確認日', 'date'], ['waiting_reason', '待ち理由'], ['state', '状態', states], ['milestone_id', 'マイルストーン', 'milestone']],
};
const labels: Record<string, string> = { ...Object.fromEntries(Object.values(schemas).flat().map(([name, label]) => [name, label])),
  id: 'ID', workspace_id: 'workspace ID', project_id: '案件 ID', type: '種類', version: '版番号', archived: 'アーカイブ',
  member_id: 'メンバー', role: '権限', active: '有効', name: '名前', scope: '範囲' };
const names: Record<Kind, string> = { project: '案件', milestone: 'マイルストーン', work_item: '作業' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
class ApiError extends Error {
  constructor(readonly status: number, readonly assignedWork = false) { super('API request failed'); }
}
interface ProjectData { project: Project; milestones: Milestone[]; work: WorkItem[] }
interface GrantRequest { operation_id: string; expected_version: number; role: ProjectMembership['role']; reason: string }
type Pending = { kind: 'entity'; preview: CommandPreview } | { kind: 'grant'; path: string; request: GrantRequest };
export interface WorkspaceOptions {
  /** Display context from the host's existing authenticator, never a permission grant. */
  workspaceId: string;
  memberId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  confirmDiscard?: () => boolean;
  /** Reports server-verified owner access so sibling views can clear private content. */
  onAccess?: (owner: boolean) => void;
}

export function mountWorkspace(root: HTMLElement, options: WorkspaceOptions) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const fetcher = options.fetch ?? win.fetch.bind(win);
  const now = options.now ?? (() => new Date());
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = doc.getElementById(id);
    if (!node) throw new Error('Missing workspace element');
    return node as T;
  };
  const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: unknown, className?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.textContent = String(value ?? '');
    if (className) node.className = className;
    return node;
  };
  const message = (value: string): void => { el('workspace-message').textContent = value; };
  const form = el<HTMLFormElement>('workspace-form');
  let workspace: Workspace | null = null;
  let projects: Project[] = [];
  let archived: Project[] = [];
  let details = new Map<string, ProjectData>();
  let memberships: Membership[] = [];
  let owner = false;
  let projectRoles = new Map<string, EffectiveRole>();
  let memberId = options.memberId;
  let tab: Tab = 'all';
  let projectId: string | null = null;
  let editing: { kind: Kind; item: Entity | null; projectId: string | null } | null = null;
  let pending: Pending | null = null;
  let baseline = '';
  let searchTerm = '';
  let busy = false;
  let reloadAfterBusy = false;
  let loadEpoch = 0;
  let detailEpoch = 0;
  let editEpoch = 0;
  let destroyed = false;
  const base = `/api/v1/workspaces/${options.workspaceId}`;
  const members = (): WorkspaceMembership[] => memberships.filter((m): m is WorkspaceMembership => m.scope === 'workspace');
  const fieldValue = (entity: object | null, key: string): unknown => entity && (entity as Record<string, unknown>)[key];
  const entityTitle = (entity: Entity): string => entity.type === 'project' ? entity.name : entity.type === 'milestone' ? entity.goal : entity.title;
  const memberName = (id: string): string => members().find(m => m.member_id === id)?.name ?? (id === memberId ? '自分' : id);
  // These roles only guide the UI. Preview and apply recheck current authority on the server.
  const canEditProject = (id: string | null): boolean => owner || (!!id && ['owner', 'editor'].includes(projectRoles.get(id) ?? ''));
  const canEdit = (kind: Kind, item: Entity | null, parent: string | null): boolean =>
    kind === 'project' && !item ? owner : canEditProject(kind === 'project' ? item?.id ?? null : parent);
  const currentForm = (): string => JSON.stringify([...new win.FormData(form).entries()]);
  const dirty = (): boolean => !!pending || (!!editing && currentForm() !== baseline);
  const discard = (): boolean => !dirty() || (options.confirmDiscard?.() ?? win.confirm('未保存の入力があります。破棄して続けますか？'));
  const setDisabled = (disabled: boolean): void => {
    for (const node of root.querySelectorAll<HTMLButtonElement>('button')) node.disabled = disabled;
    for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) node.disabled = disabled;
  };
  const clearPreview = (): void => { pending = null; editEpoch++; el('workspace-preview').hidden = true; };
  const closeEditor = (): void => { clearPreview(); editing = null; baseline = ''; el('workspace-editor').hidden = true; };
  const showTab = (next: Tab): void => {
    tab = next === 'access' && !owner ? 'all' : next;
    for (const name of ['all', 'detail', 'mine', 'access']) el(`workspace-${name}`).hidden = tab !== name;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
    }
  };
  function loginRequired(): void {
    ++loadEpoch; ++detailEpoch; closeEditor(); owner = false; workspace = null;
    projects = []; archived = []; details.clear(); memberships = []; projectRoles.clear();
    el('workspace-access-tab').hidden = true; options.onAccess?.(false);
    for (const name of ['all', 'detail', 'mine', 'access', 'fields', 'diff', 'edit-target', 'preview-target', 'preview-reason']) el(`workspace-${name}`).replaceChildren();
    el<HTMLInputElement>('workspace-reason').value = '';
    el('workspace-content').hidden = true;
    el('workspace-status').textContent = '';
    message('ログインが必要です');
  }
  async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
    if (!response.ok) {
      // Never render a server-supplied message. Only this one known conflict gets extra guidance.
      const error: unknown = await response.json().catch(() => null);
      const assignedWork = !!error && typeof error === 'object' && 'error' in error && error.error === 'assigned_work_remaining';
      throw new ApiError(response.status, assignedWork);
    }
    return await response.json() as T;
  }
  function invalidateAccess(): void {
    // A previously loaded role is not a continuing grant after a server denial.
    closeEditor(); owner = false; projectRoles.clear(); memberships = [];
    for (const node of root.querySelectorAll('[data-workspace-mutation]')) node.remove();
    el('workspace-access-tab').hidden = true; renderAccess(); showTab(tab); options.onAccess?.(false);
  }
  function fail(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) { loginRequired(); return; }
    if (error instanceof ApiError && error.status === 409) {
      clearPreview();
      message(`他の人が先に更新しました。「台帳を再読込」で最新の内容を確認し、もう一度変更を確認してください。${error.assignedWork ? '担当中の仕事がある場合は、先に担当を変更してください。' : ''}`);
    } else if (error instanceof ApiError && [403, 404].includes(error.status)) {
      invalidateAccess();
      message('この操作の権限がないか、対象が見つかりません。「台帳を再読込」で確認してください。');
    } else if (error instanceof ApiError && error.status === 400) {
      clearPreview(); message('入力を確認してください。変更を保存できませんでした。');
    } else message('読み込みまたは保存を確認できませんでした。通信状態を確認して再試行してください。');
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || destroyed) return;
    busy = true; setDisabled(true);
    try { await action(); } catch (error) { fail(error); }
    finally {
      busy = false;
      if (!destroyed) {
        setDisabled(false);
        if (reloadAfterBusy) { reloadAfterBusy = false; void load(); }
      }
    }
  }
  const button = (label: string, action: () => void, secondary = false): HTMLButtonElement => {
    const node = text('button', label, secondary ? 'secondary-button' : undefined); node.type = 'button';
    node.addEventListener('click', () => { if (!busy) action(); });
    return node;
  };
  const mutationButton = (label: string, action: () => void, secondary = false): HTMLButtonElement => {
    const node = button(label, action, secondary); node.dataset.workspaceMutation = ''; return node;
  };
  const focusEditor = (): void => {
    const fields = el('workspace-fields');
    (fields.querySelector<HTMLInputElement>('input[type="text"]') ?? fields.querySelector<HTMLElement>('input, select'))?.focus({ preventScroll: true });
    el('workspace-editor').scrollIntoView?.({ block: 'start' });
  };
  const field = (parent: HTMLElement, label: string, value: unknown): void => {
    const row = text('p', ''); row.append(text('strong', `${label}: `), text('span', value === '' || value === null || value === undefined ? '—' : value)); parent.append(row);
  };
  function display(key: string, value: unknown): string {
    if (value === '' || value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
    if (key === 'role') return value === 'editor' ? '編集' : value === 'viewer' ? '閲覧' : value === 'owner' ? '管理者' : 'メンバー';
    if (key === 'type' && typeof value === 'string' && value in names) return names[value as Kind];
    if (['owner_id', 'assignee_id', 'member_id'].includes(key) && typeof value === 'string') return memberName(value);
    if (key === 'milestone_id' && typeof value === 'string') return [...details.values()].flatMap(d => d.milestones).find(m => m.id === value)?.goal ?? value;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  function diff(parent: HTMLElement, before: object | null, after: object): void {
    parent.replaceChildren();
    const technical = ['id', 'workspace_id', 'project_id', 'version', 'type', 'scope'];
    const kind = fieldValue(after, 'type');
    const primary = typeof kind === 'string' && kind in schemas ? schemas[kind as Kind].map(([key]) => key) : [];
    const keys = [...new Set([...primary, 'archived', ...Object.keys(before ?? {}), ...Object.keys(after)])];
    const changed = keys.filter(key => JSON.stringify(fieldValue(before, key)) !== JSON.stringify(fieldValue(after, key)));
    for (const key of changed.filter(key => !technical.includes(key))) {
      parent.append(text('dt', labels[key] ?? key), text('dd', `${display(key, fieldValue(before, key))} → ${display(key, fieldValue(after, key))}`));
    }
    if (!parent.childNodes.length) parent.append(text('dt', '変更'), text('dd', '変更はありません'));
    const metadata = technical.filter(key => key in after || !!before && key in before);
    if (metadata.length) {
      const more = text('details', '', 'workspace-diff-details');
      more.append(text('summary', 'ID・版番号など'));
      const values = text('dl', '');
      for (const key of metadata) {
        const oldValue = fieldValue(before, key), newValue = fieldValue(after, key);
        values.append(text('dt', labels[key] ?? key), text('dd', changed.includes(key)
          ? `${display(key, oldValue)} → ${display(key, newValue)}` : display(key, newValue)));
      }
      more.append(values);
      const value = text('dd', ''); value.append(more);
      parent.append(text('dt', '管理情報'), value);
    }
  }
  function showPreview(before: object | null, after: object, title: string, reason: string): void {
    diff(el('workspace-diff'), before, after);
    el('workspace-preview-target').textContent = title;
    el('workspace-preview-reason').textContent = `変更理由: ${reason}`;
    el('workspace-preview').hidden = false;
    message('変更の見本を確認してから「この内容で保存」を押してください');
    const preview = el('workspace-preview'); preview.tabIndex = -1; preview.focus({ preventScroll: true });
    preview.scrollIntoView?.({ block: 'start' });
  }
  async function previewCommand(request: CommandRequest): Promise<void> {
    clearPreview(); const epoch = editEpoch;
    const preview = await api<CommandPreview>(`${base}/commands/preview`, request);
    if (epoch !== editEpoch || destroyed) return;
    pending = { kind: 'entity', preview };
    showPreview(preview.before, preview.after, `${names[preview.after.type]} · ${entityTitle(preview.after)}`, request.reason);
  }
  function openEditor(kind: Kind, item: Entity | null = null, parent = projectId): void {
    if (!canEdit(kind, item, parent) || !discard()) return;
    closeEditor(); editing = { kind, item, projectId: kind === 'project' ? null : parent };
    const fields = el('workspace-fields'); fields.replaceChildren();
    for (const [name, label, widget] of schemas[kind]) {
      const wrapper = text('label', `${label} `);
      let control: HTMLInputElement | HTMLSelectElement;
      if (Array.isArray(widget) || widget === 'member' || widget === 'milestone') {
        const select = doc.createElement('select'); control = select;
        let choices: readonly (readonly [string, string])[];
        if (widget === 'member') {
          const project = kind === 'project' ? item?.id : parent;
          choices = members().filter(m => m.active && (!project || m.role === 'owner' || memberships.some(g => g.scope === 'project' && g.project_id === project && g.member_id === m.member_id && g.role !== null)))
            .map(m => [m.member_id, m.name]);
          // Editors cannot read the owner-only member directory. Offer the caller and
          // retain the existing assignee without inventing access to other members.
          if (!owner) choices = [[memberId, '自分']];
        } else if (widget === 'milestone') {
          choices = [['', 'なし'], ...(details.get(parent ?? '')?.milestones ?? []).filter(m => !m.archived).map(m => [m.id, m.goal] as const)];
        } else choices = (widget as readonly string[]).map(value => [value, value]);
        for (const [value, title] of choices) { const option = text('option', title); option.value = value; select.append(option); }
        const old = item ? String(fieldValue(item, name) ?? '') : widget === 'member' ? memberId : null;
        if (old !== null && !choices.some(([value]) => value === old)) { const option = text('option', old || '未設定'); option.value = old; select.append(option); }
        if (old !== null) select.value = old;
      } else {
        const input = doc.createElement('input'); control = input; input.type = widget === 'date' ? 'date' : 'text';
        input.maxLength = ['purpose', 'acceptance', 'next_action', 'waiting_reason'].includes(name) ? 500 : 120;
        input.value = item ? String(fieldValue(item, name) ?? '') : '';
      }
      control.name = name;
      control.required = ['name', 'purpose', 'goal', 'acceptance', 'title', 'next_action', 'owner_id', 'assignee_id'].includes(name);
      wrapper.append(control); fields.append(wrapper);
    }
    el<HTMLInputElement>('workspace-reason').value = '日常作業の更新';
    el('workspace-edit-target').textContent = `${item ? '編集' : '新規作成'}: ${names[kind]}${item ? ` · ${entityTitle(item)}` : ''}`;
    el('workspace-editor').hidden = false; baseline = currentForm(); message('');
    focusEditor();
  }
  function card(item: Entity, title = entityTitle(item)): HTMLElement {
    const box = text('article', '', 'workspace-card'); box.dataset.entityId = item.id; box.append(text('h3', title));
    for (const [name, label] of schemas[item.type]) field(box, label, display(name, fieldValue(item, name)));
    if (item.archived) field(box, '状態', 'アーカイブ済み');
    const actions = text('div', '', 'actions');
    if (canEditProject(item.type === 'project' ? item.id : item.project_id)) {
      if (!item.archived) actions.append(mutationButton('編集', () => openEditor(item.type, item, item.type === 'project' ? item.id : item.project_id), true));
      actions.append(mutationButton(item.archived ? 'アーカイブ解除' : 'アーカイブ', () => {
        if (!canEditProject(item.type === 'project' ? item.id : item.project_id) || !discard()) return;
        closeEditor();
        void run(() => previewCommand({ operation_id: win.crypto.randomUUID(), action: item.archived ? 'restore' : 'archive',
          type: item.type, id: item.id, project_id: item.project_id, expected_version: item.version, data: null,
          reason: item.archived ? '画面からアーカイブ解除' : '画面からアーカイブ' }));
      }, true));
    }
    if (item.type === 'project' && !item.archived) actions.append(button('詳細を見る', () => {
      if (!discard()) return;
      closeEditor(); projectId = item.id; showTab('detail'); void run(renderDetail);
    }));
    box.append(actions); return box;
  }
  function activeWork(): WorkItem[] { return [...details.values()].flatMap(d => d.work).filter(w => !w.archived); }
  function renderSearch(container: HTMLElement): void {
    container.replaceChildren();
    const query = searchTerm.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja'); if (!query) return;
    const results: { project: Project; item: Entity }[] = [];
    for (const entry of details.values()) for (const item of [entry.project, ...entry.milestones, ...entry.work]) {
      if (item.archived) continue;
      const fields = item.type === 'project' ? ['name', 'purpose', 'state'] : item.type === 'milestone' ? ['goal', 'state'] : ['title', 'next_action', 'waiting_reason', 'state'];
      if (fields.some(name => String(fieldValue(item, name) ?? '').toLocaleLowerCase('ja').includes(query))) results.push({ project: entry.project, item });
    }
    container.append(text('p', `${results.length} 件${results.length > 100 ? '（先頭100件を表示）' : ''}`));
    if (!results.length) container.append(text('p', '一致する項目はありません。'));
    for (const result of results.slice(0, 100)) {
      const node = button(`${result.project.name} · ${entityTitle(result.item)}`, () => {
        if (!discard()) return;
        closeEditor(); projectId = result.project.id; showTab('detail'); void run(renderDetail);
      }); node.className = 'workspace-search-result'; container.append(node);
    }
  }
  function renderAll(): void {
    const box = el('workspace-all'); box.replaceChildren(text('h2', '全体'));
    const summary = text('section', '', 'workspace-summary'); summary.setAttribute('aria-label', '表示できる案件の集計');
    const work = activeWork();
    for (const [key, label, value] of [['projects', '案件', projects.length], ['work', '作業', work.length],
      ['milestones', 'マイルストーン', [...details.values()].flatMap(d => d.milestones).filter(m => !m.archived).length],
      ['unconfirmed', '未確認', work.filter(w => w.state === '未確認').length]] as const) {
      const item = text('p', ''); item.dataset.count = key; item.append(text('strong', value), text('span', label)); summary.append(item);
    }
    const search = text('form', '', 'workspace-search');
    const label = text('label', '案件と作業を検索'); const input = doc.createElement('input'); input.name = 'query'; input.maxLength = 100; input.value = searchTerm;
    input.placeholder = '案件名、作業名、次の行動など'; label.append(input);
    const submit = text('button', '検索'); submit.type = 'submit';
    const results = text('div', '', 'workspace-search-results'); results.setAttribute('aria-live', 'polite');
    search.append(label, submit); search.addEventListener('submit', event => { event.preventDefault(); searchTerm = input.value; renderSearch(results); });
    box.append(summary, search, results); renderSearch(results);
    if (owner) box.append(mutationButton('案件を作成', () => openEditor('project')));
    else box.append(text('p', [...projectRoles.values()].some(role => role === 'editor')
      ? '編集権限がある案件を更新できます。案件の新規作成と権限管理は管理者が行います。'
      : '閲覧モードです。編集が必要な場合は管理者に確認してください。', 'muted'));
    if (!projects.length) box.append(text('p', '表示できる案件はありません。'));
    for (const project of projects) {
      const node = card(project);
      for (const [key, label] of [['next_milestone', '次のマイルストーン'], ['next_action', '次の行動'], ['check_date', '確認日'], ['waiting_reason', '待ち理由'], ['unconfirmed_count', '未確認件数']] as const) field(node, label, project[key]);
      box.append(node);
    }
    if (archived.length) { box.append(text('h2', 'アーカイブ済み案件')); for (const project of archived) box.append(card(project)); }
  }
  function today(): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: workspace?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now());
    const get = (part: string): string => parts.find(p => p.type === part)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function renderMine(): void {
    const box = el('workspace-mine'); box.replaceChildren(text('h2', '自分の仕事'));
    const day = today();
    const work = activeWork().filter(w => w.assignee_id === memberId && w.state !== '完了')
      .sort((a, b) => (a.check_date || '9999-99-99').localeCompare(b.check_date || '9999-99-99') || Number(!!a.waiting_reason) - Number(!!b.waiting_reason) || a.id.localeCompare(b.id));
    if (!work.length) box.append(text('p', '担当する未完了作業はありません。'));
    for (const item of work) {
      const node = card(item, `${details.get(item.project_id)?.project.name ?? ''} · ${item.title}`);
      if (item.check_date && item.check_date < day) { node.classList.add('workspace-overdue'); node.prepend(text('p', '期限切れ', 'overdue-label')); }
      box.append(node);
    }
  }
  async function renderDetail(): Promise<void> {
    const epoch = ++detailEpoch, id = projectId;
    const box = el('workspace-detail'); box.replaceChildren(text('h2', '案件詳細'));
    const data = details.get(id ?? '');
    if (!data || !id) { box.append(text('p', '案件を選んでください。')); return; }
    const history = await api<{ events: WorkspaceEvent[] }>(`${base}/projects/${id}/events`);
    if (epoch !== detailEpoch || id !== projectId || destroyed) return;
    box.append(card(data.project));
    for (const [kind, items] of [['milestone', data.milestones], ['work_item', data.work]] as const) {
      const section = text('section', ''); section.dataset.section = kind; section.append(text('h2', names[kind]));
      if (canEditProject(id)) section.append(mutationButton(`${names[kind]}を作成`, () => openEditor(kind, null, id)));
      const active = items.filter(item => !item.archived), inactive = items.filter(item => item.archived);
      if (!active.length) section.append(text('p', '登録はありません。'));
      for (const item of active) section.append(card(item));
      if (inactive.length) section.append(text('h3', `${names[kind]} · アーカイブ済み`));
      for (const item of inactive) section.append(card(item));
      box.append(section);
    }
    const section = text('section', ''); section.dataset.section = 'history'; section.append(text('h2', '変更履歴'));
    if (!history.events.length) section.append(text('p', '変更履歴はありません。'));
    for (const event of history.events) {
      const row = text('article', '', 'workspace-card'); row.dataset.operationId = event.operation_id;
      row.append(text('h3', event.reason)); field(row, '日時', event.at_utc); field(row, '変更者', memberName(event.requester_member_id));
      const values = text('dl', ''); diff(values, event.before, event.after); row.append(values); section.append(row);
    }
    box.append(section);
  }
  function renderAccess(): void {
    const box = el('workspace-access'); box.replaceChildren(); if (!owner) return;
    box.append(text('h2', 'メンバーと案件権限'), text('p', '変更の見本を確認してから保存します。権限の取り消しも変更履歴に残ります。'));
    for (const member of members()) {
      const row = text('article', '', 'workspace-card'); row.dataset.memberId = member.member_id;
      row.append(text('h3', `${member.name} · ${member.role === 'owner' ? '管理者' : member.active ? '有効' : '無効'}`));
      if (member.active && member.role !== 'owner') for (const project of projects) {
        const grant = memberships.find((m): m is ProjectMembership => m.scope === 'project' && m.project_id === project.id && m.member_id === member.member_id);
        const grantForm = text('form', '', 'access-row'); grantForm.dataset.projectId = project.id;
        const label = text('label', `${project.name} `), select = doc.createElement('select'); select.name = 'role';
        for (const [value, title] of [['', '権限なし'], ['viewer', '閲覧'], ['editor', '編集']]) { const option = text('option', title); option.value = value!; select.append(option); }
        select.value = grant?.role ?? ''; label.append(select);
        const reasonLabel = text('label', '変更理由 '), reason = doc.createElement('input'); reason.name = 'reason'; reason.required = true; reason.maxLength = 240; reasonLabel.append(reason);
        const submit = text('button', '権限の変更を確認'); submit.type = 'submit'; grantForm.append(label, reasonLabel, submit);
        grantForm.addEventListener('input', clearPreview);
        grantForm.addEventListener('submit', event => {
          event.preventDefault(); if (busy) return;
          if (select.value === (grant?.role ?? '')) { message('権限に変更はありません'); return; }
          if (!grantForm.reportValidity() || !discard()) return;
          closeEditor();
          const role = (select.value || null) as ProjectMembership['role'];
          const request: GrantRequest = { operation_id: win.crypto.randomUUID(), expected_version: grant?.version ?? 0, role, reason: reason.value.trim() };
          pending = { kind: 'grant', path: `${base}/projects/${project.id}/memberships/${member.member_id}`, request };
          // The frozen API has no permission-preview endpoint. This local diff performs no write;
          // the PUT after explicit confirmation validates owner, target, reason and CAS atomically.
          showPreview({ role: grant?.role ?? null }, { role }, `${project.name} · ${member.name}`, request.reason);
        });
        row.append(grantForm);
      }
      box.append(row);
    }
  }
  async function refresh(): Promise<void> {
    const epoch = ++loadEpoch;
    const [nextWorkspace, projectList, roles, access] = await Promise.all([
      api<Workspace>(base), api<{ projects: Project[]; archived_projects: Project[] }>(`${base}/projects`),
      api<CurrentProjectRoles>(`${base}/project-roles/me`),
      api<{ memberships: Membership[] }>(`${base}/memberships`).catch(error => {
        if (error instanceof ApiError && error.status === 403) return null; throw error;
      }),
    ]);
    const nextDetails = new Map<string, ProjectData>();
    await Promise.all(projectList.projects.map(async project => {
      const url = `${base}/projects/${project.id}`;
      const [milestones, work] = await Promise.all([api<{ items: Milestone[] }>(`${url}/milestones`), api<{ items: WorkItem[] }>(`${url}/work-items`)]);
      nextDetails.set(project.id, { project, milestones: milestones.items, work: work.items });
    }));
    if (epoch !== loadEpoch || destroyed) return;
    workspace = nextWorkspace; projects = projectList.projects; archived = projectList.archived_projects;
    // Owner-only API success is the authority; never trust a role from HTML or a URL.
    owner = access !== null; memberships = access?.memberships ?? [];
    projectRoles = new Map(roles.items.map(item => [item.project_id, item.role])); memberId = roles.member_id;
    options.onAccess?.(owner);
    details = new Map(projects.map(p => [p.id, nextDetails.get(p.id)!]));
    if (!projects.some(p => p.id === projectId)) projectId = projects[0]?.id ?? null;
    el('workspace-status').textContent = `${workspace.name} · ${workspace.timezone}`;
    el('workspace-content').hidden = false; el('workspace-access-tab').hidden = !owner;
    renderAll(); renderMine(); renderAccess(); showTab(tab);
    if (tab === 'detail') await renderDetail();
  }
  async function load(): Promise<void> {
    return run(async () => {
      if (!uuid.test(options.workspaceId) || !uuid.test(options.memberId)) {
        // An unauthenticated shell has no embedded context. The existing API still determines 401.
        await api('/api/v1/accounts/me');
        message('画面の表示情報を確認できません。ページを再読込してください。'); return;
      }
      await refresh(); message('');
    });
  }
  form.addEventListener('input', clearPreview);
  form.addEventListener('change', clearPreview);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!editing || !canEdit(editing.kind, editing.item, editing.projectId) || busy || !form.reportValidity()) return;
    const current = editing;
    const data = Object.fromEntries([...new win.FormData(form).entries()].filter(([name]) => name !== 'reason')) as Record<string, string>;
    void run(() => previewCommand({ operation_id: win.crypto.randomUUID(), action: current.item ? 'update' : 'create',
      type: current.kind, id: current.item?.id ?? null, project_id: current.projectId, expected_version: current.item?.version ?? null,
      data, reason: el<HTMLInputElement>('workspace-reason').value.trim() }));
  });
  el('workspace-apply').addEventListener('click', () => {
    if (!pending || busy) return;
    const savedPending = pending;
    void run(async () => {
      if (savedPending.kind === 'entity') {
        const saved = await api<Entity>(`${base}/commands/apply`, savedPending.preview);
        projectId = saved.type === 'project' ? saved.id : saved.project_id;
      } else await api<ProjectMembership>(savedPending.path, savedPending.request, 'PUT');
      closeEditor(); message('保存しました');
      try { await refresh(); } catch (error) {
        if (error instanceof ApiError && error.status === 401) loginRequired();
        else {
          if (error instanceof ApiError && [403, 404].includes(error.status)) invalidateAccess();
          message('保存しましたが、最新の表示を取得できませんでした。「台帳を再読込」で確認してください。');
        }
      }
    });
  });
  el('workspace-cancel').addEventListener('click', () => { if (!busy) { clearPreview(); if (editing) focusEditor(); message('変更の見本を閉じました。保存していません。'); } });
  el('workspace-edit-cancel').addEventListener('click', () => { if (!busy && discard()) { closeEditor(); message(''); } });
  el('workspace-refresh').addEventListener('click', () => {
    if (busy || !discard()) return;
    void run(async () => { await refresh(); closeEditor(); message('台帳を再読込しました'); });
  });
  for (const node of root.querySelectorAll<HTMLButtonElement>('[data-tab]')) node.addEventListener('click', () => {
    const next = node.dataset.tab as Tab; if (busy || !discard()) return;
    closeEditor(); showTab(next); if (next === 'detail') void run(renderDetail);
  });
  const beforeUnload = (event: BeforeUnloadEvent): void => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  const pageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    ++loadEpoch; ++detailEpoch; closeEditor();
    // A request suspended by BFCache must not swallow the fresh permission check.
    if (busy) reloadAfterBusy = true; else void load();
  };
  win.addEventListener('beforeunload', beforeUnload); win.addEventListener('pageshow', pageShow);
  return { load, canNavigate(): boolean { if (busy || !discard()) return false; closeEditor(); return true; }, destroy(): void { destroyed = true; ++loadEpoch; ++detailEpoch; clearPreview(); win.removeEventListener('beforeunload', beforeUnload); win.removeEventListener('pageshow', pageShow); } };
}
