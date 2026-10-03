/** Portable, authorization-first workspace application service. No host I/O. */
import type { Workspace } from './generated/workspace.js';
import type { Account } from './generated/account.js';
import type { Contact } from './generated/contact.js';
import type { Project } from './generated/project.js';
import type { Milestone } from './generated/milestone.js';
import type { WorkItem } from './generated/work_item.js';
import type { Membership, WorkspaceMembership, ProjectMembership, SourceMembership } from './generated/membership.js';
import type { EntitySnapshot, EntityEvent, Event, AccessSnapshot, AccessEvent, Reference, Observation } from './generated/event.js';
import type { Principal, ServiceDependencies, StoreSession } from './ports.js';
import { ServiceError, ConflictError } from './ports.js';
import { ContactLedgerService, validateContact } from './contact-service.js';
import { CaseService } from './case-service.js';
import type { CurrentProjectRoles } from './generated/project_roles.js';
import * as v from './service-validation.js';

export type CommandResult = Project | Milestone | WorkItem;
export interface CommandRequest {
  operation_id: string;
  action: v.CommandAction;
  type: v.CommandKind;
  id: string | null;
  project_id: string | null;
  expected_version: number | null;
  data: v.JsonObject | null;
  reason: string;
}
export interface CommandPreview {
  request: CommandRequest & { id: string };
  before: CommandResult | null;
  after: CommandResult;
  preview_token: string;
}
export type SharedContact = Pick<Contact, 'id' | 'state' | 'state_inferred' | 'project' | 'recipient' |
  'channel' | 'sent_at' | 'due' | 'promise' | 'agreement' | 'basis' | 'note' | 'references' |
  'shared_url' | 'body' | 'created_at' | 'updated_at'>;
interface Context { workspace: Workspace; member: WorkspaceMembership; memberships: Membership[] }
interface Prepared { request: CommandPreview['request']; before: CommandResult | null; after: CommandResult }
const COMMAND_FIELDS = ['operation_id', 'action', 'type', 'id', 'project_id', 'expected_version', 'data', 'reason'];
const SHARED_FIELDS = ['id', 'state', 'state_inferred', 'project', 'recipient', 'channel', 'sent_at', 'due',
  'promise', 'agreement', 'basis', 'note', 'references', 'shared_url', 'body', 'created_at', 'updated_at'] as const;
const compareIds = (left: { id: string }, right: { id: string }): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export class WorkspaceService {
  private readonly route: NonNullable<ServiceDependencies['route']>;
  readonly contactLedger: ContactLedgerService;
  /** Received cases; fails closed with cases_not_enabled without settings or a CasePort. */
  readonly cases: CaseService;
  constructor(private readonly dependencies: ServiceDependencies) {
    this.contactLedger = new ContactLedgerService(dependencies);
    this.cases = new CaseService(dependencies);
    this.route = dependencies.route ?? 'dashboard';
    if (!['dashboard', 'shared-cli', 'shared-admin-cli', 'workspace-access'].includes(this.route)) throw new ServiceError('invalid_route');
  }

  /** Membership is loaded from the same snapshot/transaction as the operation. */
  private async context(session: StoreSession, principal: Principal, workspaceId: string, owner = false): Promise<Context> {
    v.uuid(workspaceId);
    if (!principal || typeof principal !== 'object' || typeof principal.member_id !== 'string') throw new ServiceError('unauthorized', 401);
    v.uuid(principal.member_id);
    if (principal.workspace_id !== workspaceId) throw new ServiceError('not_found', 404);
    if (principal.active !== true) throw new ServiceError('member_inactive', 403);
    const workspace = await session.workspaces.get(workspaceId);
    if (!workspace || workspace.workspace_id !== workspaceId) throw new ServiceError('not_found', 404);
    // Sharing of v1/v2 stores requires an explicit, backed-up migration first.
    if (workspace.schema_version !== 3) throw new ConflictError('sharing_not_enabled');
    v.text(workspace.name, true);
    // Modern Intl also accepts numeric UTC offsets, but the frozen contract
    // requires an IANA database identifier (including its UTC/GMT aliases).
    if (typeof workspace.timezone !== 'string' || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(workspace.timezone)) {
      throw new ServiceError('invalid_timezone');
    }
    try { new Intl.DateTimeFormat('en', { timeZone: workspace.timezone }).format(0); }
    catch { throw new ServiceError('invalid_timezone'); }
    const memberships = (await session.memberships.list(workspaceId)).filter((row) => row.workspace_id === workspaceId);
    const matches = memberships.filter((row): row is WorkspaceMembership => row.scope === 'workspace' && row.member_id === principal.member_id);
    const member = matches[0];
    if (matches.length !== 1 || !member || member.active !== true || !['owner', 'member'].includes(member.role)) throw new ServiceError('member_inactive', 403);
    if (owner && member.role !== 'owner') throw new ServiceError('forbidden', 403);
    return { workspace, member, memberships };
  }
  private owner(ctx: Context): void {
    if (ctx.member.role !== 'owner') throw new ServiceError('forbidden', 403);
  }
  private projectAccess(ctx: Context, projectId: string, write = false): void {
    v.uuid(projectId);
    if (ctx.member.role === 'owner') return;
    const grants = ctx.memberships.filter((row): row is ProjectMembership => row.scope === 'project' && row.project_id === projectId && row.member_id === ctx.member.member_id);
    const grant = grants[0];
    if (grants.length !== 1 || !grant || (grant.role !== 'editor' && grant.role !== 'viewer') || (write && grant.role !== 'editor')) throw new ServiceError('not_found', 404);
    v.integer(grant.version);
  }
  private sourceAccess(ctx: Context, sourceId: string): boolean {
    if (ctx.member.role === 'owner') return true;
    const grants = ctx.memberships.filter((row): row is SourceMembership => row.scope === 'source' && row.source_id === sourceId && row.member_id === ctx.member.member_id);
    const grant = grants[0];
    return grants.length === 1 && !!grant && grant.allowed === true && Number.isSafeInteger(grant.version) && grant.version >= 1;
  }
  private member(ctx: Context, memberId: string, projectId?: string): WorkspaceMembership {
    v.uuid(memberId);
    const matches = ctx.memberships.filter((row): row is WorkspaceMembership => row.scope === 'workspace' && row.member_id === memberId);
    const result = matches[0];
    if (matches.length !== 1 || !result || result.active !== true || !['member', 'owner'].includes(result.role)) throw new ServiceError('invalid_member', 403);
    if (projectId && result.role !== 'owner') {
      const grants = ctx.memberships.filter((row): row is ProjectMembership => row.scope === 'project' && row.project_id === projectId && row.member_id === memberId);
      const grant = grants[0];
      if (grants.length !== 1 || !grant || (grant.role !== 'editor' && grant.role !== 'viewer')) throw new ServiceError('invalid_member', 403);
      v.integer(grant.version);
    }
    return result;
  }
  private async resource(session: StoreSession, workspaceId: string, id: string): Promise<EntitySnapshot> {
    v.uuid(id);
    const result = await session.resources.get(workspaceId, id);
    if (!result || result.id !== id || result.workspace_id !== workspaceId) throw new ServiceError('not_found', 404);
    return v.entity(result, workspaceId);
  }
  private async activeProject(session: StoreSession, ctx: Context, projectId: string, write = false): Promise<Project> {
    this.projectAccess(ctx, projectId, write);
    const project = await this.resource(session, ctx.workspace.workspace_id, projectId);
    if (project.type !== 'project' || project.archived) throw new ServiceError('not_found', 404);
    return project;
  }

  async workspace(principal: Principal, workspaceId: string): Promise<Workspace> {
    return this.dependencies.store.read(async (session) => {
      const { workspace } = await this.context(session, principal, workspaceId);
      return { workspace_id: workspace.workspace_id, name: workspace.name, timezone: workspace.timezone, schema_version: workspace.schema_version };
    });
  }
  async account(principal: Principal): Promise<Account> {
    return this.dependencies.store.read(async (session) => {
      await this.context(session, principal, principal.workspace_id);
      if (!principal.account_subject) throw new ServiceError('not_found', 404);
      v.uuid(principal.account_subject);
      const account = await session.accounts.get(principal.account_subject);
      if (!account || account.subject !== principal.account_subject || account.active !== true) throw new ServiceError('unauthorized', 401);
      v.text(account.login, true);
      v.integer(account.revision);
      return { subject: account.subject, login: account.login, active: account.active, revision: account.revision };
    });
  }
  async projects(principal: Principal, workspaceId: string): Promise<{ projects: Project[]; archived_projects: Project[] }> {
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      const resources = (await session.resources.list(workspaceId)).filter((row) => row.workspace_id === workspaceId);
      const projects: Project[] = [];
      const archived: Project[] = [];
      for (const row of resources.filter((item) => item.type === 'project').sort(compareIds)) {
        try { this.projectAccess(ctx, row.id); } catch (error) { if (error instanceof ServiceError && error.status === 404) continue; throw error; }
        const project = v.entity(row, workspaceId) as Project;
        if (project.archived) { archived.push(project); continue; }
        const children = resources.filter((item) => item.project_id === project.id && !item.archived
          && (item.type === 'work_item' || item.type === 'milestone')).map((item) => v.entity(item, workspaceId)).sort(compareIds);
        const nextWork = children.find((item): item is WorkItem => item.type === 'work_item' && item.state !== '完了');
        const nextMilestone = children.find((item): item is Milestone => item.type === 'milestone' && item.state !== '完了');
        projects.push({ ...project, next_milestone: nextMilestone?.goal ?? '', next_action: nextWork?.next_action ?? '',
          check_date: nextWork?.check_date ?? '', waiting_reason: nextWork?.waiting_reason ?? '',
          unconfirmed_count: children.filter((item) => (item.type === 'milestone' || item.type === 'work_item') && item.state === '未確認').length });
      }
      return { projects, archived_projects: archived };
    });
  }
  /** Effective roles for the authenticated caller only; never returns others' grants. */
  async projectRoles(principal: Principal, workspaceId: string): Promise<CurrentProjectRoles> {
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      const items: CurrentProjectRoles['items'] = [];
      const rows = (await session.resources.list(workspaceId))
        .filter(row => row.workspace_id === workspaceId && row.type === 'project').sort(compareIds);
      for (const row of rows) {
        try { this.projectAccess(ctx, row.id); }
        catch (error) { if (error instanceof ServiceError && error.status === 404) continue; throw error; }
        const project = v.entity(row, workspaceId);
        if (project.type !== 'project') continue;
        const grant = ctx.memberships.find((value): value is ProjectMembership =>
          value.scope === 'project' && value.project_id === project.id && value.member_id === ctx.member.member_id);
        const role = ctx.member.role === 'owner' ? 'owner' : grant?.role;
        if (role === 'owner' || role === 'editor' || role === 'viewer') items.push({ project_id: project.id, role });
      }
      return { member_id: ctx.member.member_id, items };
    });
  }
  async project(principal: Principal, workspaceId: string, projectId: string): Promise<Project> {
    return this.dependencies.store.read(async (session) => this.activeProject(session, await this.context(session, principal, workspaceId), projectId));
  }
  private async children<K extends 'milestone' | 'work_item'>(principal: Principal, workspaceId: string, projectId: string, kind: K): Promise<{ items: Extract<EntitySnapshot, { type: K }>[] }> {
    return this.dependencies.store.read(async (session) => {
      await this.activeProject(session, await this.context(session, principal, workspaceId), projectId);
      const items = (await session.resources.list(workspaceId)).filter((item) => item.workspace_id === workspaceId && item.project_id === projectId && item.type === kind)
        .map((item) => v.entity(item, workspaceId) as Extract<EntitySnapshot, { type: K }>).sort(compareIds);
      return { items };
    });
  }
  async milestones(principal: Principal, workspaceId: string, projectId: string): Promise<{ items: Milestone[] }> {
    return this.children(principal, workspaceId, projectId, 'milestone');
  }
  async workItems(principal: Principal, workspaceId: string, projectId: string): Promise<{ items: WorkItem[] }> {
    return this.children(principal, workspaceId, projectId, 'work_item');
  }
  private async child<K extends 'milestone' | 'work_item'>(principal: Principal, workspaceId: string, projectId: string, id: string, kind: K): Promise<Extract<EntitySnapshot, { type: K }>> {
    return this.dependencies.store.read(async (session) => {
      await this.activeProject(session, await this.context(session, principal, workspaceId), projectId);
      const result = await this.resource(session, workspaceId, id);
      if (result.type !== kind || result.project_id !== projectId) throw new ServiceError('not_found', 404);
      return result as Extract<EntitySnapshot, { type: K }>;
    });
  }
  async milestone(principal: Principal, workspaceId: string, projectId: string, id: string): Promise<Milestone> {
    return this.child(principal, workspaceId, projectId, id, 'milestone');
  }
  async workItem(principal: Principal, workspaceId: string, projectId: string, id: string): Promise<WorkItem> {
    return this.child(principal, workspaceId, projectId, id, 'work_item');
  }

  private request(input: unknown, generateId: boolean): CommandPreview['request'] {
    const raw = v.exact(input, COMMAND_FIELDS, 'invalid_request');
    const operationId = v.uuid(raw.operation_id);
    if (raw.type !== 'project' && raw.type !== 'milestone' && raw.type !== 'work_item') throw new ServiceError('invalid_action');
    if (raw.action !== 'create' && raw.action !== 'update' && raw.action !== 'archive' && raw.action !== 'restore') throw new ServiceError('invalid_action');
    const id = raw.id === null && raw.action === 'create' && generateId ? v.uuid(this.dependencies.ids.next()) : v.uuid(raw.id);
    if (raw.type === 'project' && raw.project_id !== null) throw new ServiceError('invalid_project');
    const projectId = raw.type === 'project' ? null : v.uuid(raw.project_id);
    const expectedVersion = raw.action === 'create' ? null : v.integer(raw.expected_version);
    if (raw.action === 'create' && raw.expected_version !== null) throw new ServiceError('invalid_version');
    if ((raw.action === 'archive' || raw.action === 'restore') && raw.data !== null) throw new ServiceError('invalid_fields');
    const data = raw.action === 'create' || raw.action === 'update' ? v.data(raw.type, raw.data) : null;
    return { operation_id: operationId, action: raw.action, type: raw.type, id, project_id: projectId,
      expected_version: expectedVersion, data, reason: v.text(raw.reason, true, 240) };
  }
  private authorizeCommand(ctx: Context, request: CommandPreview['request']): void {
    if (request.type === 'project' && request.action === 'create') this.owner(ctx);
    else this.projectAccess(ctx, request.project_id ?? request.id, true);
  }
  private async validatedData(session: StoreSession, ctx: Context, kind: v.CommandKind, raw: unknown, projectId: string | null, entityId: string, creating: boolean): Promise<v.JsonObject> {
    const data = v.data(kind, raw);
    if (kind === 'project') {
      this.member(ctx, String(data.owner_id), creating ? undefined : entityId);
    } else {
      if (!projectId) throw new ServiceError('invalid_project');
      const parent = await this.resource(session, ctx.workspace.workspace_id, projectId);
      if (parent.type !== 'project' || parent.archived) throw new ServiceError('invalid_project');
      this.member(ctx, String(data.assignee_id), projectId);
      if (kind === 'work_item' && data.milestone_id) {
        const milestone = await this.resource(session, ctx.workspace.workspace_id, String(data.milestone_id));
        if (milestone.type !== 'milestone' || milestone.project_id !== projectId || milestone.archived) throw new ServiceError('invalid_reference');
      }
    }
    return data;
  }
  private async prepare(session: StoreSession, ctx: Context, input: unknown, generateId: boolean): Promise<Prepared> {
    const request = this.request(input, generateId);
    this.authorizeCommand(ctx, request);
    const workspaceId = ctx.workspace.workspace_id;
    let before: CommandResult | null = null;
    let data: v.JsonObject;
    if (request.action === 'create') {
      if (await session.resources.get(workspaceId, request.id)) throw new ConflictError('duplicate_id');
      data = await this.validatedData(session, ctx, request.type, request.data, request.project_id, request.id, true);
    } else {
      const current = await this.resource(session, workspaceId, request.id);
      if (current.type !== request.type || current.project_id !== request.project_id) throw new ServiceError('invalid_target', 404);
      before = current as CommandResult;
      if (before.version !== request.expected_version) throw new ConflictError('version_conflict');
      if (before.archived !== (request.action === 'restore')) throw new ConflictError('archived');
      if (request.action === 'restore' && request.project_id) {
        const parent = await this.resource(session, workspaceId, request.project_id);
        if (parent.type !== 'project' || parent.archived) throw new ConflictError('invalid_project');
      }
      const oldData = Object.fromEntries(v.FIELDS[request.type].map((key) => [key, (before as unknown as v.JsonObject)[key]]));
      if (request.action === 'archive') {
        // Python archives preserve stored fields even if the parent is archived
        // or a former assignee is now inactive; archive is how they are retired.
        data = oldData;
        if (request.type === 'project') {
          const assigned = ctx.memberships.filter((row): row is WorkspaceMembership => row.scope === 'workspace' && row.member_id === data.owner_id);
          const member = assigned[0];
          if (assigned.length !== 1 || !member || (member.role !== 'owner' && !ctx.memberships.some((row) => row.scope === 'project'
            && row.project_id === request.id && row.member_id === member.member_id && (row.role === 'editor' || row.role === 'viewer')))) {
            throw new ServiceError('invalid_member', 403);
          }
        }
      } else {
        data = await this.validatedData(session, ctx, request.type, request.action === 'update' ? request.data : oldData,
          request.project_id, request.id, false);
      }
    }
    const after = v.entity({ id: request.id, workspace_id: workspaceId, project_id: request.project_id,
      type: request.type, version: before ? before.version + 1 : 1, archived: request.action === 'archive', ...data }, workspaceId) as CommandResult;
    return { request, before, after };
  }
  private confirmationPayload(workspaceId: string, principal: Principal, preview: Prepared): string {
    return v.canonical({ workspace_id: workspaceId, member_id: principal.member_id, execution_route: this.route, ...preview });
  }
  async preview(principal: Principal, workspaceId: string, input: unknown): Promise<CommandPreview> {
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      const prepared = await this.prepare(session, ctx, input, true);
      return { ...prepared, preview_token: await this.dependencies.signer.sign(this.confirmationPayload(workspaceId, principal, prepared)) };
    });
  }
  async apply(principal: Principal, workspaceId: string, input: unknown): Promise<CommandResult> {
    const raw = v.exact(input, ['request', 'before', 'after', 'preview_token'], 'invalid_preview');
    if (typeof raw.preview_token !== 'string' || !/^[0-9a-f]{64}$/.test(raw.preview_token)) throw new ServiceError('invalid_preview');
    const request = this.request(raw.request, false);
    // Verify the exact submitted snapshots and request, before touching replay state.
    const signed = { request: raw.request, before: raw.before, after: raw.after };
    const payload = v.canonical({ workspace_id: workspaceId, member_id: principal.member_id, execution_route: this.route, ...signed });
    if (!await this.dependencies.signer.verify(payload, raw.preview_token)) throw new ServiceError('invalid_preview', 403);
    if (v.canonical(request) !== v.canonical(raw.request)) throw new ServiceError('invalid_preview', 403);
    const requestHash = await this.dependencies.signer.digest(v.canonical(request));
    return this.dependencies.store.transaction(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      this.authorizeCommand(ctx, request);
      const prior = await session.events.get(workspaceId, request.operation_id);
      if (prior) {
        if (prior.operation_id !== request.operation_id || prior.workspace_id !== workspaceId || prior.event_kind !== 'entity' || prior.requester_member_id !== principal.member_id
          || prior.member_id !== principal.member_id || prior.request_hash !== requestHash || prior.entity_id !== request.id
          || prior.route !== this.route || v.canonical(prior.after) !== v.canonical(raw.after)
          || v.canonical(prior.before) !== v.canonical(raw.before)) throw new ConflictError('operation_conflict');
        const result = v.entity(prior.after, workspaceId);
        if (result.type !== request.type || result.id !== request.id || result.project_id !== request.project_id) throw new ConflictError('operation_conflict');
        return result as CommandResult;
      }
      if (await session.contacts.event(workspaceId, request.operation_id)) throw new ConflictError('operation_conflict');
      const prepared = await this.prepare(session, ctx, request, false);
      if (v.canonical(prepared.before) !== v.canonical(raw.before) || v.canonical(prepared.after) !== v.canonical(raw.after)) throw new ConflictError('stale_preview');
      const event: EntityEvent = { event_kind: 'entity', operation_id: request.operation_id, workspace_id: workspaceId,
        entity_id: prepared.after.id, member_id: principal.member_id, requester_member_id: principal.member_id,
        route: this.route, executor_kind: 'unknown', executor_ref: null, executor_verified: false,
        reason: request.reason, at_utc: v.timestamp(this.dependencies.clock.now()), before: prepared.before,
        after: prepared.after, changes: v.changes(prepared.before, prepared.after), request_hash: requestHash };
      await session.resources.put(prepared.after, prepared.before?.version ?? null);
      await session.events.append(event);
      return prepared.after;
    });
  }

  async memberships(principal: Principal, workspaceId: string): Promise<{ memberships: Membership[] }> {
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId, true);
      const memberships = ctx.memberships.map((row): Membership => {
        v.uuid(row.member_id);
        if (row.scope === 'workspace') {
          if (!['owner', 'member'].includes(row.role) || typeof row.active !== 'boolean') throw new ServiceError('invalid_member');
          // Identity bindings are not part of the shared Web member listing.
          return { scope: 'workspace', workspace_id: workspaceId, member_id: row.member_id,
            name: v.text(row.name, true), role: row.role, active: row.active, version: row.active ? 1 : 2 };
        }
        v.integer(row.version);
        if (row.scope === 'project') {
          v.uuid(row.project_id);
          if (row.role !== null && row.role !== 'editor' && row.role !== 'viewer') throw new ServiceError('invalid_grant');
          return { scope: 'project', workspace_id: workspaceId, project_id: row.project_id, member_id: row.member_id, role: row.role, version: row.version };
        }
        if (row.scope !== 'source' || typeof row.allowed !== 'boolean') throw new ServiceError('invalid_grant');
        return { scope: 'source', workspace_id: workspaceId, source_id: v.uuid(row.source_id), member_id: row.member_id, allowed: row.allowed, version: row.version };
      });
      memberships.sort((a, b) => {
        const key = (row: Membership): string => `${row.scope}:${row.scope === 'project' ? row.project_id : row.scope === 'source' ? row.source_id : ''}:${row.member_id}`;
        return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      });
      return { memberships };
    });
  }
  private accessSnapshot(grant: ProjectMembership | SourceMembership): AccessSnapshot {
    if (grant.scope === 'project') return { workspace_id: grant.workspace_id, project_id: grant.project_id,
      member_id: grant.member_id, role: grant.role, version: grant.version };
    return { workspace_id: grant.workspace_id, source_id: grant.source_id, member_id: grant.member_id,
      allowed: grant.allowed, version: grant.version };
  }
  private async appendAccess(session: StoreSession, ctx: Context, operationId: string, kind: 'project_role' | 'source_access',
    targetId: string, reason: string, before: AccessSnapshot | null, after: AccessSnapshot, requestHash: string): Promise<void> {
    const event: AccessEvent = { event_kind: 'access', operation_id: operationId, workspace_id: ctx.workspace.workspace_id,
      actor_member_id: ctx.member.member_id, requester_member_id: ctx.member.member_id, target_type: kind, target_id: targetId,
      route: this.route, executor_kind: 'unknown', executor_ref: null, executor_verified: false, reason,
      at_utc: v.timestamp(this.dependencies.clock.now()), before, after, changes: v.changes(before, after), request_hash: requestHash };
    await session.events.append(event);
  }
  private async accessReplay(session: StoreSession, ctx: Context, operationId: string, payload: unknown,
    targetType: 'project_role' | 'source_access', targetId: string): Promise<{ hash: string; prior: AccessSnapshot | null }> {
    const hash = await this.dependencies.signer.digest(v.canonical(payload));
    const previous = await session.events.get(ctx.workspace.workspace_id, operationId);
    if (!previous) {
      if (await session.contacts.event(ctx.workspace.workspace_id, operationId)) throw new ConflictError('operation_conflict');
      return { hash, prior: null };
    }
    if (previous.operation_id !== operationId || previous.workspace_id !== ctx.workspace.workspace_id || previous.event_kind !== 'access'
      || previous.requester_member_id !== ctx.member.member_id || previous.actor_member_id !== ctx.member.member_id
      || previous.request_hash !== hash || previous.route !== this.route || previous.target_type !== targetType || previous.target_id !== targetId) {
      throw new ConflictError('operation_conflict');
    }
    return { hash, prior: previous.after };
  }
  async setProjectMembership(principal: Principal, workspaceId: string, projectId: string, memberId: string, input: unknown): Promise<ProjectMembership> {
    v.uuid(projectId); v.uuid(memberId);
    const raw = v.exact(input, ['operation_id', 'expected_version', 'role', 'reason'], 'invalid_grant');
    const operationId = v.uuid(raw.operation_id);
    const expectedVersion = v.integer(raw.expected_version, 0, 'invalid_grant');
    if (raw.role !== null && raw.role !== 'editor' && raw.role !== 'viewer') throw new ServiceError('invalid_grant');
    const role = raw.role;
    if (role === null && expectedVersion === 0) throw new ServiceError('invalid_grant');
    const reason = v.text(raw.reason, true, 240);
    const payload = { kind: 'project_role', project_id: projectId, member_id: memberId, role, expected_version: expectedVersion, reason };
    return this.dependencies.store.transaction(async (session) => {
      const ctx = await this.context(session, principal, workspaceId, true);
      const { hash, prior } = await this.accessReplay(session, ctx, operationId, payload, 'project_role', projectId);
      if (prior) {
        if (prior.workspace_id !== workspaceId || prior.project_id !== projectId || prior.member_id !== memberId || prior.role !== role
          || prior.version !== expectedVersion + 1) throw new ConflictError('operation_conflict');
        return { scope: 'project', workspace_id: workspaceId, project_id: projectId, member_id: memberId, role, version: v.integer(prior.version) };
      }
      const project = await this.resource(session, workspaceId, projectId);
      if (project.type !== 'project' || project.archived) throw new ServiceError('invalid_project', 404);
      if (this.member(ctx, memberId).role === 'owner') throw new ServiceError('invalid_member', 403);
      const matches = ctx.memberships.filter((row): row is ProjectMembership => row.scope === 'project' && row.project_id === projectId && row.member_id === memberId);
      const current = matches[0];
      if (matches.length > 1) throw new ServiceError('invalid_grant');
      if (current) {
        v.integer(current.version);
        if (current.role !== null && current.role !== 'editor' && current.role !== 'viewer') throw new ServiceError('invalid_grant');
      }
      if ((current?.version ?? 0) !== expectedVersion) throw new ConflictError('version_conflict');
      if (role !== 'editor') {
        const resources = await session.resources.list(workspaceId);
        for (const rawEntity of resources) {
          if (rawEntity.workspace_id !== workspaceId || rawEntity.archived || (rawEntity.id !== projectId && rawEntity.project_id !== projectId)
            || (rawEntity.type !== 'project' && rawEntity.type !== 'milestone' && rawEntity.type !== 'work_item')) continue;
          const entity = v.entity(rawEntity, workspaceId) as CommandResult;
          const assigned = entity.type === 'project' ? entity.owner_id : entity.assignee_id;
          if (assigned === memberId && entity.state !== '完了' && entity.state !== '終了') throw new ConflictError('assigned_work_remaining');
        }
      }
      if (role === null && (!current || current.role === null)) throw new ServiceError('invalid_grant');
      const after: ProjectMembership = { scope: 'project', workspace_id: workspaceId, project_id: projectId,
        member_id: memberId, role, version: expectedVersion + 1 };
      await session.memberships.put(after, expectedVersion);
      await this.appendAccess(session, ctx, operationId, 'project_role', projectId, reason,
        current ? this.accessSnapshot(current) : null, this.accessSnapshot(after), hash);
      return after;
    });
  }
  async setSourceMembership(principal: Principal, workspaceId: string, sourceId: string, memberId: string, input: unknown): Promise<SourceMembership> {
    v.uuid(sourceId); v.uuid(memberId);
    const raw = v.exact(input, ['operation_id', 'expected_version', 'allowed', 'reason'], 'invalid_grant');
    const operationId = v.uuid(raw.operation_id);
    const expectedVersion = v.integer(raw.expected_version, 0, 'invalid_grant');
    if (typeof raw.allowed !== 'boolean' || (!raw.allowed && expectedVersion === 0)) throw new ServiceError('invalid_grant');
    const allowed = raw.allowed;
    const reason = v.text(raw.reason, true, 240);
    const payload = { kind: 'source_access', source_id: sourceId, member_id: memberId, allowed, expected_version: expectedVersion, reason };
    return this.dependencies.store.transaction(async (session) => {
      const ctx = await this.context(session, principal, workspaceId, true);
      const { hash, prior } = await this.accessReplay(session, ctx, operationId, payload, 'source_access', sourceId);
      if (prior) {
        if (prior.workspace_id !== workspaceId || prior.source_id !== sourceId || prior.member_id !== memberId || prior.allowed !== allowed
          || prior.version !== expectedVersion + 1) throw new ConflictError('operation_conflict');
        return { scope: 'source', workspace_id: workspaceId, source_id: sourceId, member_id: memberId, allowed, version: v.integer(prior.version) };
      }
      const source = await this.resource(session, workspaceId, sourceId);
      if (source.type !== 'source' || source.archived) throw new ServiceError('invalid_source', 404);
      if (this.member(ctx, memberId).role === 'owner') throw new ServiceError('invalid_member', 403);
      const matches = ctx.memberships.filter((row): row is SourceMembership => row.scope === 'source' && row.source_id === sourceId && row.member_id === memberId);
      const current = matches[0];
      if (matches.length > 1) throw new ServiceError('invalid_grant');
      if (current) { v.integer(current.version); if (typeof current.allowed !== 'boolean') throw new ServiceError('invalid_grant'); }
      if ((current?.version ?? 0) !== expectedVersion) throw new ConflictError('version_conflict');
      if (!allowed && !current) throw new ServiceError('invalid_grant');
      const after: SourceMembership = { scope: 'source', workspace_id: workspaceId, source_id: sourceId,
        member_id: memberId, allowed, version: expectedVersion + 1 };
      await session.memberships.put(after, expectedVersion);
      await this.appendAccess(session, ctx, operationId, 'source_access', sourceId, reason,
        current ? this.accessSnapshot(current) : null, this.accessSnapshot(after), hash);
      return after;
    });
  }

  /** Validate both link semantics and independent current source authorization. */
  private async visibleReference(session: StoreSession, ctx: Context, reference: Reference): Promise<boolean> {
    try {
      const projectId = reference.project_id;
      if (reference.linked_id) {
        const linked = await this.resource(session, ctx.workspace.workspace_id, reference.linked_id);
        if (linked.project_id !== projectId || (linked.type !== 'milestone' && linked.type !== 'work_item')) return false;
      }
      if (reference.kind === 'md' || reference.kind === 'https') return reference.source_id === '';
      const source = await this.resource(session, ctx.workspace.workspace_id, reference.source_id);
      return source.type === 'source' && !source.archived && source.adapter === reference.kind && this.sourceAccess(ctx, source.id);
    } catch (error) { if (error instanceof ServiceError) return false; throw error; }
  }
  private async visibleObservation(session: StoreSession, ctx: Context, observation: Observation): Promise<boolean> {
    try {
      const reference = await this.resource(session, ctx.workspace.workspace_id, observation.reference_id);
      if (reference.type !== 'reference' || reference.archived || reference.project_id !== observation.project_id
        || (reference.kind !== 'contact' && reference.kind !== 'external_case') || !await this.visibleReference(session, ctx, reference)) return false;
      // Observation snapshots contain a reference ID, not the former source ID.
      // Check retained reference snapshots too: retargeting cannot launder source
      // history into a newly visible observation for a non-owner.
      if (ctx.member.role !== 'owner') {
        for (const event of await session.events.list(ctx.workspace.workspace_id)) {
          if (event.workspace_id !== ctx.workspace.workspace_id || event.event_kind !== 'entity' || event.entity_id !== reference.id) continue;
          for (const snapshot of [event.before, event.after]) {
            if (!snapshot) continue;
            const old = v.entity(snapshot, ctx.workspace.workspace_id);
            if (old.type !== 'reference' || old.project_id !== observation.project_id || !await this.visibleReference(session, ctx, old)) return false;
          }
        }
      }
      return true;
    } catch (error) { if (error instanceof ServiceError) return false; throw error; }
  }
  private async visibleSnapshot(session: StoreSession, ctx: Context, input: unknown, projectId: string): Promise<boolean> {
    try {
      const snapshot = v.entity(input, ctx.workspace.workspace_id);
      if (snapshot.type === 'project') return snapshot.id === projectId;
      if (snapshot.project_id !== projectId) return false;
      if (snapshot.type === 'reference') return this.visibleReference(session, ctx, snapshot);
      if (snapshot.type === 'observation') return this.visibleObservation(session, ctx, snapshot);
      return snapshot.type === 'milestone' || snapshot.type === 'work_item';
    } catch (error) { if (error instanceof ServiceError) return false; throw error; }
  }
  async events(principal: Principal, workspaceId: string, projectId: string): Promise<{ events: Event[] }> {
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      await this.activeProject(session, ctx, projectId);
      const rows = (await session.events.list(workspaceId)).filter((event): event is EntityEvent => event.workspace_id === workspaceId && event.event_kind === 'entity');
      const events: Event[] = [];
      for (const event of rows) {
        if (event.after.id !== event.entity_id || (event.before && event.before.id !== event.entity_id)) continue;
        const current = await session.resources.get(workspaceId, event.entity_id);
        if (!current || current.type !== event.after.type || current.project_id !== event.after.project_id
          || !await this.visibleSnapshot(session, ctx, current, projectId)
          || !await this.visibleSnapshot(session, ctx, event.after, projectId)
          || (event.before && !await this.visibleSnapshot(session, ctx, event.before, projectId))) continue;
        if (event.before && (event.before.type !== event.after.type || event.before.project_id !== event.after.project_id)) continue;
        if (!['unknown', 'human', 'ai', 'service'].includes(event.executor_kind) || typeof event.executor_verified !== 'boolean'
          || (event.executor_ref !== null && typeof event.executor_ref !== 'string')
          || (event.executor_kind === 'unknown' && (event.executor_ref !== null || event.executor_verified))
          || (event.executor_verified && event.executor_ref === null)) continue;
        if (event.executor_ref !== null) {
          try { if (v.text(event.executor_ref, true, 500) !== event.executor_ref) continue; }
          catch (error) { if (error instanceof ServiceError) continue; throw error; }
        }
        // An allowlist also prevents adapter/private fields entering the shared feed.
        events.push({ event_kind: 'entity', operation_id: v.uuid(event.operation_id), workspace_id: workspaceId,
          entity_id: v.uuid(event.entity_id), member_id: v.uuid(event.member_id), requester_member_id: v.uuid(event.requester_member_id),
          route: v.text(event.route, true), executor_kind: event.executor_kind, executor_ref: event.executor_ref,
          executor_verified: event.executor_verified, reason: v.text(event.reason, true, 240), at_utc: v.timestamp(event.at_utc),
          before: event.before, after: event.after, changes: v.changes(event.before, event.after) });
      }
      events.sort((a, b) => v.compareTimestamps(a.at_utc, b.at_utc) || (a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0));
      return { events };
    });
  }
  async linkedContact(principal: Principal, workspaceId: string, projectId: string, sourceId: string, id: string): Promise<SharedContact> {
    v.uuid(sourceId); v.contactId(id);
    return this.dependencies.store.read(async (session) => {
      const ctx = await this.context(session, principal, workspaceId);
      await this.activeProject(session, ctx, projectId);
      if (!this.sourceAccess(ctx, sourceId)) throw new ServiceError('not_found', 404);
      let source: EntitySnapshot;
      try { source = await this.resource(session, workspaceId, sourceId); }
      catch (error) { if (error instanceof ServiceError) throw new ServiceError('not_found', 404); throw error; }
      if (source.type !== 'source' || source.archived || source.adapter !== 'contact') throw new ServiceError('not_found', 404);
      let linked = false;
      for (const raw of await session.resources.list(workspaceId)) {
        if (raw.workspace_id !== workspaceId || raw.project_id !== projectId || raw.type !== 'reference'
          || raw.archived || raw.kind !== 'contact' || raw.source_id !== sourceId || raw.target !== id) continue;
        try {
          const reference = v.entity(raw, workspaceId);
          if (reference.type === 'reference' && await this.visibleReference(session, ctx, reference)) { linked = true; break; }
        } catch (error) { if (!(error instanceof ServiceError)) throw error; }
      }
      if (!linked) throw new ServiceError('not_found', 404);
      const record = await session.contacts.get(workspaceId, sourceId, id);
      if (!record || record.workspace_id !== workspaceId || record.source_id !== sourceId || record.contact.id !== id
        || record.contact.sensitive !== '') throw new ServiceError('not_found', 404);
      let contact: Contact;
      try { contact = validateContact(record.contact); }
      catch (error) { if (error instanceof ServiceError) throw new ServiceError('not_found', 404); throw error; }
      v.integer(record.version);
      v.contactState(contact.state);
      if (typeof contact.state_inferred !== 'boolean') throw new ServiceError('not_found', 404);
      const shared: Record<string, unknown> = {};
      for (const key of SHARED_FIELDS) {
        if (key !== 'state_inferred' && typeof contact[key] !== 'string') throw new ServiceError('not_found', 404);
        shared[key] = contact[key];
      }
      return shared as SharedContact;
    });
  }
}
