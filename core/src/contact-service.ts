/** Trusted-owner contact ledger API. Private contents never enter shared views. */
import type { Contact } from './generated/contact.js';
import type { AddDraft, ContactActionCommand } from './generated/contact_command.js';
import type { ContactActionPreview } from './generated/contact_preview.js';
import type { Workspace } from './generated/workspace.js';
import { ConflictError, ServiceError } from './ports.js';
import type { ContactEvent, ContactRecord, Principal, ServiceDependencies, StoreSession } from './ports.js';
import { canonical } from './confirmation.js';
import { compareTimestamps, changes, entity as validateEntity, contactId, contactState, exact, integer, nextTimestamp, object, text, timestamp, uuid } from './service-validation.js';
import { buildWaitingRows, casefold, compareContacts, contactDate, contactMatches, pythonStrip, workspaceToday } from './contact-views.js';
import type { WaitingOptions, WaitingRow } from './contact-views.js';
export type { ContactActionCommand } from './generated/contact_command.js';
export type { ContactActionPreview } from './generated/contact_preview.js';

const CONTACT_FIELDS = ['id', 'state', 'state_inferred', 'project', 'recipient', 'channel', 'sent_at', 'due', 'promise', 'agreement', 'sensitive', 'basis', 'note', 'references', 'shared_url', 'body', 'source_path', 'source_hash', 'extra', 'created_at', 'updated_at'];
export function validateContact(value: unknown): Contact {
  const data = exact(value, CONTACT_FIELDS);
  contactId(data.id); contactState(data.state);
  if (typeof data.state_inferred !== 'boolean') throw new ServiceError('invalid_field');
  for (const field of CONTACT_FIELDS.filter(field => !['state_inferred', 'extra'].includes(field))) {
    if (typeof data[field] !== 'string') throw new ServiceError('invalid_field');
  }
  if (Object.values(object(data.extra)).some(value => typeof value !== 'string')) throw new ServiceError('invalid_field');
  return structuredClone(data) as unknown as Contact;
}
export interface ContactCommand {
  operation_id: string;
  action: 'create' | 'update';
  expected_version: number | null;
  data: Contact;
  reason: string;
}
export interface ContactPreview {
  request: ContactCommand;
  before: ContactRecord | null;
  after: ContactRecord;
  preview_token: string;
}
export type ContactDraftData = AddDraft['data'];
export interface ContactListOptions {
  state?: string[];
  project?: string;
  q?: string;
}
const DRAFT_FIELDS = CONTACT_FIELDS.filter(field => !['id', 'state', 'created_at', 'updated_at'].includes(field));
function draftFields(value: unknown): ContactDraftData {
  const data = object(value);
  if (Object.keys(data).some(field => !DRAFT_FIELDS.includes(field))) throw new ServiceError('invalid_fields');
  for (const [field, value] of Object.entries(data)) {
    if (field === 'state_inferred') {
      if (typeof value !== 'boolean') throw new ServiceError('invalid_field');
    } else if (field === 'extra') {
      if (Object.values(object(value)).some(item => typeof item !== 'string')) throw new ServiceError('invalid_field');
    } else if (typeof value !== 'string') throw new ServiceError('invalid_field');
  }
  return structuredClone(data) as ContactDraftData;
}
function draftContact(id: string, data: ContactDraftData): Contact {
  return { id, state: '下書き', state_inferred: false, project: '', recipient: '', channel: '', sent_at: '',
    due: '', promise: '', agreement: '', sensitive: '', basis: '', note: '', references: '', shared_url: '',
    body: '', source_path: '', source_hash: '', extra: {}, created_at: '', updated_at: '', ...data };
}
export class ContactLedgerService {
  private readonly route: string;
  constructor(private readonly dependencies: ServiceDependencies) {
    this.route = dependencies.route ?? 'dashboard';
    if (!['dashboard', 'shared-cli', 'shared-admin-cli', 'workspace-access'].includes(this.route)) throw new ServiceError('invalid_route');
  }
  private async owner(tx: StoreSession, p: Principal, w: string, source: string): Promise<Workspace> {
    uuid(w); uuid(source); uuid(p.member_id);
    if (p.active !== true) throw new ServiceError('member_inactive', 403);
    if (p.workspace_id !== w) throw new ServiceError('not_found', 404);
    const workspace = await tx.workspaces.get(w);
    if (!workspace || workspace.workspace_id !== w) throw new ServiceError('not_found', 404);
    if (workspace.schema_version !== 3) throw new ConflictError('sharing_not_enabled');
    const members = (await tx.memberships.list(w)).filter(v => v.scope === 'workspace' && v.workspace_id === w && v.member_id === p.member_id);
    const member = members[0];
    if (members.length !== 1 || !member || member.scope !== 'workspace' || member.active !== true || member.role !== 'owner') throw new ServiceError('forbidden', 403);
    const raw = await tx.resources.get(w, source);
    const entity = raw && validateEntity(raw, w);
    if (!entity || entity.id !== source || entity.type !== 'source' || entity.archived || entity.adapter !== 'contact'
      || entity.project_id !== null || entity.workspace_id !== w || !/^[a-z][a-z0-9_-]*$/.test(entity.binding)) {
      throw new ServiceError('not_found', 404);
    }
    return workspace;
  }
  private record(value: unknown, w: string, source: string, id?: string): ContactRecord {
    const raw = exact(value, ['workspace_id', 'source_id', 'version', 'contact']);
    if (raw.workspace_id !== w || raw.source_id !== source) throw new ServiceError('not_found', 404);
    const contact = validateContact(raw.contact);
    if (id !== undefined && contact.id !== id) throw new ServiceError('not_found', 404);
    return { workspace_id: w, source_id: source, version: integer(raw.version), contact };
  }
  private event(value: ContactEvent, w: string, source: string, id: string): ContactEvent {
    if (value.workspace_id !== w || value.source_id !== source || value.contact_id !== id) throw new ServiceError('not_found', 404);
    const before = value.before === null ? null : this.record(value.before, w, source, id);
    const after = this.record(value.after, w, source, id);
    if (after.version !== (before?.version ?? 0) + 1 || !/^[0-9a-f]{64}$/.test(value.request_hash)) throw new ServiceError('invalid_event');
    return { operation_id: uuid(value.operation_id), workspace_id: w, source_id: source, contact_id: id,
      requester_member_id: uuid(value.requester_member_id), route: text(value.route, true),
      reason: text(value.reason, true, 240), at_utc: timestamp(value.at_utc), before, after,
      changes: changes(before?.contact ?? null, after.contact), request_hash: value.request_hash };
  }
  private command(value: unknown): ContactCommand {
    const data = exact(value, ['operation_id', 'action', 'expected_version', 'data', 'reason'], 'invalid_request');
    if (data.action !== 'create' && data.action !== 'update') throw new ServiceError('invalid_action');
    if (data.action === 'create' && data.expected_version !== null) throw new ServiceError('invalid_version');
    return { operation_id: uuid(data.operation_id), action: data.action,
      expected_version: data.action === 'create' ? null : integer(data.expected_version),
      data: validateContact(data.data), reason: text(data.reason, true, 240) };
  }
  private payload(p: Principal, w: string, source: string, preview: Omit<ContactPreview, 'preview_token'>): string {
    return canonical({ domain: 'contact-ledger', workspace_id: w, source_id: source, member_id: p.member_id, route: this.route, ...preview });
  }
  private async prepare(tx: StoreSession, p: Principal, w: string, source: string, value: unknown, candidateTime: string): Promise<Omit<ContactPreview, 'preview_token'>> {
    await this.owner(tx, p, w, source);
    const request = this.command(value);
    const stored = await tx.contacts.get(w, source, request.data.id);
    const before = stored === null ? null : this.record(stored, w, source, request.data.id);
    if (request.action === 'create' && before) throw new ConflictError('duplicate_id');
    if (request.action === 'update' && !before) throw new ServiceError('not_found', 404);
    if (before && before.version !== request.expected_version) throw new ConflictError('version_conflict');
    const at = nextTimestamp(candidateTime, before?.contact.updated_at ?? '');
    const nextVersion = integer((before?.version ?? 0) + 1);
    const after: ContactRecord = { workspace_id: w, source_id: source, version: nextVersion,
      contact: { ...request.data, created_at: before?.contact.created_at ?? at, updated_at: at } };
    return { request, before, after };
  }
  async preview(p: Principal, w: string, source: string, input: unknown): Promise<ContactPreview> {
    const prepared = await this.dependencies.store.read(tx => this.prepare(tx, p, w, source, input, timestamp(this.dependencies.clock.now())));
    return { ...prepared, preview_token: await this.dependencies.signer.sign(this.payload(p, w, source, prepared)) };
  }
  async apply(p: Principal, w: string, source: string, input: unknown): Promise<ContactRecord> {
    const value = exact(input, ['request', 'before', 'after', 'preview_token'], 'invalid_preview');
    if (typeof value.preview_token !== 'string') throw new ServiceError('invalid_preview');
    const supplied = { request: value.request, before: value.before, after: value.after } as Omit<ContactPreview, 'preview_token'>;
    if (!await this.dependencies.signer.verify(this.payload(p, w, source, supplied), value.preview_token)) throw new ServiceError('invalid_preview', 403);
    const request = this.command(value.request);
    const hash = await this.dependencies.signer.digest(canonical({ workspace_id: w, source_id: source, route: this.route, request }));
    return this.dependencies.store.transaction(async tx => {
      await this.owner(tx, p, w, source);
      const prior = await tx.contacts.event(w, request.operation_id);
      if (prior) {
        if (prior.request_hash !== hash || prior.requester_member_id !== p.member_id || prior.source_id !== source) throw new ConflictError('operation_conflict');
        const safe = this.event(prior, w, source, request.data.id);
        if (safe.operation_id !== request.operation_id || safe.route !== this.route) throw new ConflictError('operation_conflict');
        return safe.after;
      }
      if (await tx.events.get(w, request.operation_id)) throw new ConflictError('operation_conflict');
      const candidate = object(value.after);
      const candidateContact = validateContact(candidate.contact);
      const prepared = await this.prepare(tx, p, w, source, request, timestamp(candidateContact.updated_at));
      if (canonical(prepared.before) !== canonical(value.before) || canonical(prepared.after) !== canonical(value.after)) throw new ConflictError('stale_preview');
      await tx.contacts.put(prepared.after, request.expected_version);
      const event: ContactEvent = { operation_id: request.operation_id, workspace_id: w, source_id: source,
        contact_id: request.data.id, requester_member_id: p.member_id, route: this.route,
        reason: request.reason, changes: changes(prepared.before?.contact ?? null, prepared.after.contact), at_utc: timestamp(this.dependencies.clock.now()), before: prepared.before,
        after: prepared.after, request_hash: hash };
      await tx.contacts.append(event);
      return prepared.after;
    });
  }
  private actionCommand(value: unknown): ContactActionCommand {
    const data = exact(value, ['operation_id', 'action', 'contact_id', 'expected_version', 'data', 'reason'], 'invalid_request');
    const base = { operation_id: uuid(data.operation_id), reason: text(data.reason, true, 240) };
    if (data.action === 'add_draft') {
      if (data.expected_version !== null) throw new ServiceError('invalid_version');
      const id = data.contact_id === null ? null : contactId(data.contact_id);
      return { ...base, action: data.action, contact_id: id, expected_version: null, data: draftFields(data.data) };
    }
    if (data.action !== 'set_state' && data.action !== 'record_reply') throw new ServiceError('invalid_action');
    const common = { ...base, contact_id: contactId(data.contact_id), expected_version: integer(data.expected_version) };
    if (data.action === 'set_state') {
      const fields = exact(data.data, ['state']);
      return { ...common, action: data.action, data: { state: contactState(fields.state) as Contact['state'] } };
    }
    const fields = exact(data.data, ['summary']);
    if (typeof fields.summary !== 'string') throw new ServiceError('invalid_field');
    const summary = pythonStrip(fields.summary);
    if (!summary) throw new ServiceError('required_field');
    return { ...common, action: data.action, data: { summary } };
  }
  private actionPayload(p: Principal, w: string, source: string, preview: Omit<ContactActionPreview, 'preview_token'>): string {
    return canonical({ domain: 'contact-ledger-command', workspace_id: w, source_id: source,
      member_id: p.member_id, route: this.route, ...preview });
  }
  private async prepareAction(tx: StoreSession, p: Principal, w: string, source: string,
    request: ContactActionCommand, candidateTime: string): Promise<Omit<ContactActionPreview, 'preview_token'>> {
    await this.owner(tx, p, w, source);
    const id = contactId(request.contact_id);
    const stored = await tx.contacts.get(w, source, id);
    const before = stored === null ? null : this.record(stored, w, source, id);
    if (request.action === 'add_draft' && before) throw new ConflictError('duplicate_id');
    if (request.action !== 'add_draft' && !before) throw new ServiceError('not_found', 404);
    if (before && before.version !== request.expected_version) throw new ConflictError('version_conflict');
    let contact: Contact;
    if (request.action === 'add_draft') contact = draftContact(id, request.data);
    else {
      contact = { ...before!.contact };
      const state = request.action === 'set_state' ? request.data.state : '対応中';
      if (contact.state !== state) {
        contact.state = state;
        contact.state_inferred = false;
      }
      if (request.action === 'record_reply') {
        contact.note += `${contact.note ? '\n' : ''}返信要約: ${request.data.summary}`;
      }
      // The legacy store preserves every byte and version for a same-state no-op.
      if (canonical(contact) === canonical(before!.contact)) return { request, before, after: before! };
    }
    const at = nextTimestamp(candidateTime, before?.contact.updated_at ?? '');
    const after: ContactRecord = { workspace_id: w, source_id: source, version: integer((before?.version ?? 0) + 1),
      contact: { ...contact, created_at: before?.contact.created_at ?? at, updated_at: at } };
    return { request, before, after };
  }
  async previewCommand(p: Principal, w: string, source: string, input: unknown): Promise<ContactActionPreview> {
    const prepared = await this.dependencies.store.read(async tx => {
      // Resolve generated IDs only after authorization and field validation.
      const workspace = await this.owner(tx, p, w, source);
      let request = this.actionCommand(input);
      const now = timestamp(this.dependencies.clock.now());
      if (request.action === 'add_draft' && request.contact_id === null) {
        const day = workspaceToday(now, workspace.timezone).replace(/-/g, '');
        const id = `c-${day}-${uuid(this.dependencies.ids.next()).replace(/-/g, '').slice(-8)}`;
        request = { ...request, contact_id: id };
      }
      return this.prepareAction(tx, p, w, source, request, now);
    });
    return { ...prepared, preview_token: await this.dependencies.signer.sign(this.actionPayload(p, w, source, prepared)) };
  }
  async applyCommand(p: Principal, w: string, source: string, input: unknown): Promise<ContactRecord> {
    const value = exact(input, ['request', 'before', 'after', 'preview_token'], 'invalid_preview');
    if (typeof value.preview_token !== 'string') throw new ServiceError('invalid_preview');
    const supplied = { request: value.request, before: value.before, after: value.after } as Omit<ContactActionPreview, 'preview_token'>;
    if (!await this.dependencies.signer.verify(this.actionPayload(p, w, source, supplied), value.preview_token)) {
      throw new ServiceError('invalid_preview', 403);
    }
    const request = this.actionCommand(value.request);
    const id = contactId(request.contact_id);
    if (canonical(request) !== canonical(value.request)) throw new ServiceError('invalid_preview');
    const suppliedBefore = value.before === null ? null : this.record(value.before, w, source, id);
    const suppliedAfter = this.record(value.after, w, source, id);
    const hash = await this.dependencies.signer.digest(canonical({ domain: 'contact-ledger-command',
      workspace_id: w, source_id: source, route: this.route, request }));
    return this.dependencies.store.transaction(async tx => {
      await this.owner(tx, p, w, source);
      const prior = await tx.contacts.event(w, request.operation_id);
      if (prior) {
        if (prior.request_hash !== hash || prior.requester_member_id !== p.member_id || prior.source_id !== source) {
          throw new ConflictError('operation_conflict');
        }
        const safe = this.event(prior, w, source, id);
        if (safe.operation_id !== request.operation_id || safe.route !== this.route) throw new ConflictError('operation_conflict');
        return safe.after;
      }
      if (await tx.events.get(w, request.operation_id)) throw new ConflictError('operation_conflict');
      const prepared = await this.prepareAction(tx, p, w, source, request, suppliedAfter.contact.updated_at);
      if (canonical(prepared.before) !== canonical(suppliedBefore) || canonical(prepared.after) !== canonical(suppliedAfter)) {
        throw new ConflictError('stale_preview');
      }
      // No-op commands still perform all authorization, signature, replay and CAS
      // checks, but must not fabricate a mutation or a legacy history entry.
      if (prepared.before?.version === prepared.after.version) return prepared.after;
      await tx.contacts.put(prepared.after, request.expected_version);
      await tx.contacts.append({ operation_id: request.operation_id, workspace_id: w, source_id: source,
        contact_id: id, requester_member_id: p.member_id, route: this.route, reason: request.reason,
        changes: changes(prepared.before?.contact ?? null, prepared.after.contact), at_utc: timestamp(this.dependencies.clock.now()),
        before: prepared.before, after: prepared.after, request_hash: hash });
      return prepared.after;
    });
  }
  async read(p: Principal, w: string, source: string, id: string): Promise<ContactRecord> {
    contactId(id);
    return this.dependencies.store.read(async tx => {
      await this.owner(tx, p, w, source);
      const record = await tx.contacts.get(w, source, id);
      if (!record) throw new ServiceError('not_found', 404);
      return this.record(record, w, source, id);
    });
  }
  async list(p: Principal, w: string, source: string, options: ContactListOptions = {}): Promise<ContactRecord[]> {
    return this.dependencies.store.read(async tx => {
      await this.owner(tx, p, w, source);
      const query = object(options);
      if (Object.keys(query).some(key => !['state', 'project', 'q'].includes(key))) throw new ServiceError('invalid_query');
      let states: Set<string> | undefined;
      if (Object.hasOwn(query, 'state')) {
        if (!Array.isArray(query.state)) throw new ServiceError('invalid_query');
        states = new Set(query.state.map(contactState));
      }
      if (Object.hasOwn(query, 'project') && typeof query.project !== 'string') throw new ServiceError('invalid_query');
      let needle: string | undefined;
      if (Object.hasOwn(query, 'q')) {
        if (typeof query.q !== 'string') throw new ServiceError('invalid_query');
        needle = casefold(pythonStrip(query.q));
        if (!needle) throw new ServiceError('invalid_query');
      }
      const rows = await tx.contacts.list(w, source);
      return rows.map(row => this.record(row, w, source))
        .filter(({ contact }) => (states === undefined || states.has(contact.state))
          && (query.project === undefined || contact.project === query.project)
          && (needle === undefined || contactMatches(contact, needle)))
        .sort((a, b) => compareContacts(a.contact, b.contact));
    });
  }
  async waiting(p: Principal, w: string, source: string, options: WaitingOptions = {}): Promise<WaitingRow[]> {
    return this.dependencies.store.read(async tx => {
      const workspace = await this.owner(tx, p, w, source);
      const query = object(options);
      if (Object.keys(query).some(key => !['include_all', 'include_summaries', 'today'].includes(key))) throw new ServiceError('invalid_query');
      for (const field of ['include_all', 'include_summaries']) {
        if (Object.hasOwn(query, field) && typeof query[field] !== 'boolean') throw new ServiceError('invalid_query');
      }
      let today: string;
      if (Object.hasOwn(query, 'today')) {
        if (typeof query.today !== 'string' || contactDate(query.today) === null) throw new ServiceError('invalid_date');
        today = query.today;
      } else today = workspaceToday(timestamp(this.dependencies.clock.now()), workspace.timezone);
      const rows = (await tx.contacts.list(w, source)).map(row => this.record(row, w, source).contact);
      return buildWaitingRows(rows, today, options);
    });
  }
  async exportBody(p: Principal, w: string, source: string, id: string): Promise<{ body: string }> {
    return { body: (await this.read(p, w, source, id)).contact.body };
  }
  async history(p: Principal, w: string, source: string, id: string): Promise<ContactEvent[]> {
    contactId(id);
    return this.dependencies.store.read(async tx => {
      await this.owner(tx, p, w, source);
      const record = await tx.contacts.get(w, source, id);
      if (!record) throw new ServiceError('not_found', 404);
      this.record(record, w, source, id);
      return (await tx.contacts.history(w, source, id)).map(row => this.event(row, w, source, id))
        .sort((a, b) => compareTimestamps(a.at_utc, b.at_utc) || a.operation_id.localeCompare(b.operation_id));
    });
  }
}
