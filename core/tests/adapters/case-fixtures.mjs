// Synthetic received-case helpers for the SQLite/D1-specific tests. No real app,
// tenant or person: prefixes and references are placeholders only.
import { readFile } from 'node:fs/promises';
import { WorkspaceService } from '../../.build/service.js';
import { parseCaseSettingsToml } from '../../.build/case-settings.js';
import { createConfirmationSigner } from '../../.build/confirmation.js';
import { clockTime, ids, uuid } from '../contract/fixtures.mjs';

export const caseSettings = parseCaseSettingsToml(
  await readFile(new URL('../../config/case-settings.example.toml', import.meta.url), 'utf8'));
export const app = (name, sources = [name], tenants = ['*']) =>
  ({ kind: 'app', workspace_id: ids.workspace, app: name, sources, tenants });
export const newCase = (overrides = {}) => ({ origin: 'human', kind: caseSettings.kinds.values[0],
  title: '合成の受付', body: '合成の本文', ...overrides });

/** The case service over any Store, with the example settings and a fixed UTC clock. */
export async function caseService(store) {
  const signer = await createConfirmationSigner(new Uint8Array(32).fill(7)); // Synthetic test key only.
  return new WorkspaceService({ store, signer, clock: { now: () => clockTime },
    ids: { next: () => uuid(9900) }, caseSettings }).cases;
}

/** A complete stored case row, as CaseService.create would write it. */
export const caseRecord = (seq, overrides = {}) => ({ workspace_id: ids.workspace, number: `app_one-${seq}`,
  source: 'app_one', tenant_ref: null, seq, origin: 'human', kind: caseSettings.kinds.values[0],
  status: caseSettings.statuses.initial, approval_state: caseSettings.approval_states.initial_free,
  title: '合成の受付', body: '合成の本文', reporter_ref: null, screen_id: null, feature_id: null,
  environment: null, version: null, url: null, fingerprint: null, promised_due: null, hold_until: null,
  closed_at: null, duplicate_of: null, legacy_ref: null, revision: 1, created_at: clockTime, updated_at: clockTime,
  ...overrides });
export const caseEvent = (number, seq = 1) => ({ workspace_id: ids.workspace, case_number: number, seq,
  action: seq === 1 ? 'create' : 'update', actor: { kind: 'app', app: 'app_one' }, actor_ref: null, reason: null,
  at_utc: clockTime, changes: [{ field: 'status', before: null, after: caseSettings.statuses.initial }] });

/** Number, row and first event through the port only, in the caller's transaction. */
export async function writeCase(tx, overrides = {}) {
  const seq = await tx.cases.allocate(ids.workspace, 'app_one');
  const record = caseRecord(seq, overrides);
  await tx.cases.put(record, null);
  await tx.cases.appendEvent(caseEvent(record.number));
  return record.number;
}

/** Two cases with an update, a person, a reply and a link, through the service. */
export async function fillCases(cases) {
  const sender = app('app_one');
  const { number } = await cases.create(sender, ids.workspace, newCase({ legacy_ref: 'legacy-1' }));
  await cases.create(sender, ids.workspace, newCase());
  await cases.update(sender, ids.workspace, number, { expected_revision: 1,
    status: caseSettings.statuses.terminal[0], reason: '合成の完了' });
  await cases.addPerson(sender, ids.workspace, number, { reporter_ref: 'u-synthetic-2' });
  await cases.addReply(sender, ids.workspace, number, { body: '合成の返事' });
  await cases.addLink(sender, ids.workspace, number, { link_type: 'commit', ref: 'a'.repeat(40) });
  return number;
}

/** Every case of the synthetic workspace and all of its children, through public ports. */
export function caseRows(store) {
  return store.read(async (tx) => Promise.all((await tx.cases.list(ids.workspace)).map(async (row) => ({
    row, events: await tx.cases.events(ids.workspace, row.number), people: await tx.cases.people(ids.workspace, row.number),
    replies: await tx.cases.replies(ids.workspace, row.number), links: await tx.cases.links(ids.workspace, row.number),
  }))));
}

/** Every write method of a read session's CasePort must refuse. */
export async function assertCaseReadOnly(assert, store) {
  await store.read(async (tx) => {
    await assert.rejects(tx.cases.allocate(ids.workspace, 'app_one'), /immutable/);
    await assert.rejects(tx.cases.put(caseRecord(1), null), /immutable/);
    for (const method of ['appendEvent', 'addPerson', 'addReply', 'addLink']) {
      await assert.rejects(tx.cases[method]({ workspace_id: ids.workspace, case_number: 'app_one-1' }), /immutable/);
    }
  });
}
