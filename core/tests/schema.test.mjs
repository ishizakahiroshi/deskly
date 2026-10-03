import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CONTACT_STATES, ITEM_STATES, PROJECT_STATES, WORK_ITEM_KINDS } from '../.build/status.js';
import { contact, event, examples, ids, milestone, project, workItem } from './fixtures.mjs';

const directory = new URL('../../schema/', import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemas = new Map();
for (const name of (await readdir(directory)).filter((name) => name.endsWith('.schema.json'))) {
  const schema = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
  schemas.set(name, schema);
  ajv.addSchema(schema);
}
const validate = (name) => ajv.getSchema(`https://deskly.example/schema/${name}.schema.json`);
const check = (name, value, valid) => {
  const validator = validate(name);
  assert.ok(validator, `missing ${name} schema`);
  assert.equal(validator(value), valid, `${name}: ${JSON.stringify(validator.errors)}`);
};

test('all eight entity schemas compile and accept synthetic source-compatible examples', () => {
  for (const [name, example] of Object.entries(examples)) check(name, example, true);
});

test('state and kind constants have exactly the authoritative vocabulary', () => {
  const definitions = schemas.get('common.schema.json').$defs;
  for (const [values, name] of [[CONTACT_STATES, 'contact_state'], [ITEM_STATES, 'item_state'],
    [PROJECT_STATES, 'project_state'], [WORK_ITEM_KINDS, 'work_kind']]) {
    assert.deepEqual(values, definitions[name].enum);
    assert.equal(new Set(values).size, values.length);
  }
  for (const state of CONTACT_STATES) check('contact', { ...contact, state }, true);
  for (const state of PROJECT_STATES) check('project', { ...project, state }, true);
  for (const state of ITEM_STATES) {
    check('work_item', { ...workItem, state }, true);
    check('milestone', { ...milestone, state }, true);
  }
  check('contact', { ...contact, state: '待ち' }, false);
  check('work_item', { ...workItem, state: '終了' }, false);
  check('project', { ...project, state: '完了' }, false);
});

test('all legacy Contact fields remain required and strings are not silently tightened', () => {
  assert.deepEqual([...schemas.get('contact.schema.json').required].sort(), Object.keys(contact).sort());
  check('contact', { ...contact, sent_at: '日時未確認', due: '合成の期日', extra: { custom: '合成' } }, true);
  check('contact', { ...contact, extra: { custom: 1 } }, false);
  check('contact', { ...contact, state_inferred: 1 }, false);
  check('contact', { ...contact, id: ids.project }, false);
  for (const key of Object.keys(contact)) {
    const incomplete = { ...contact };
    delete incomplete[key];
    check('contact', incomplete, false);
  }
});

test('versioned entities enforce IDs, required fields, bounds, dates and closed objects', () => {
  check('project', { ...project, id: '合成案件' }, false);
  check('project', { ...project, id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }, false);
  check('project', { ...project, version: true }, false);
  check('project', { ...project, version: 0 }, false);
  check('project', { ...project, version: 1.5 }, false);
  check('project', { ...project, unexpected: '' }, false);
  check('project', { ...project, name: ' ' }, false);
  check('project', { ...project, name: 'a'.repeat(121) }, false);
  check('project', { ...project, purpose: 'a'.repeat(501) }, false);
  check('project', { ...project, purpose: 'line\nbreak' }, false);
  check('milestone', { ...milestone, project_id: null }, false);
  check('work_item', { ...workItem, check_date: '2024-02-29' }, true);
  check('work_item', { ...workItem, check_date: '2025-02-29' }, false);
  check('work_item', { ...workItem, check_date: '2026-1-01' }, false);
  check('work_item', { ...workItem, milestone_id: ids.milestone }, true);
  check('work_item', { ...workItem, milestone_id: null }, false);
  check('work_item', { ...workItem, kind: 'other' }, false);
});

test('mutable data definitions preserve exact Python service fields', () => {
  for (const [name, fields] of [
    ['project', ['name', 'purpose', 'owner_id', 'state']],
    ['milestone', ['goal', 'acceptance', 'assignee_id', 'check_date', 'state']],
    ['work_item', ['kind', 'title', 'assignee_id', 'next_action', 'check_date', 'waiting_reason', 'state', 'milestone_id']],
  ]) {
    const data = schemas.get(`${name}.schema.json`).$defs.data;
    assert.deepEqual(Object.keys(data.properties).sort(), [...fields].sort());
    assert.deepEqual([...data.required].sort(), [...fields].sort());
    assert.equal(data.additionalProperties, false);
  }
});

test('workspace owner, project grants, source grants and revocation stay distinct', () => {
  const member = { scope: 'workspace', workspace_id: ids.workspace, member_id: ids.member,
    name: '合成member', role: 'owner', active: true };
  check('membership', member, true);
  check('membership', { ...member, role: 'member' }, true);
  check('membership', { ...member, role: 'editor' }, false);
  check('membership', { ...examples.membership, role: null, version: 2 }, true);
  check('membership', { ...examples.membership, role: 'viewer' }, true);
  check('membership', { ...examples.membership, role: 'owner' }, false);
  check('membership', { scope: 'source', workspace_id: ids.workspace, source_id: ids.source,
    member_id: ids.member, allowed: false, version: 2 }, true);
});

test('credential material is excluded and audit identity cannot be forged by shape aliases', () => {
  check('account', { ...examples.account, password_hash: 'synthetic' }, false);
  check('account', { ...examples.account, salt: 'synthetic' }, false);
  check('account', { ...examples.account, revision: 0 }, false);
  check('event', { ...event, actor_member_id: ids.member }, false);
  check('event', { ...event, executor_verified: true }, false);
  check('event', { ...event, executor_ref: 'unverified' }, false);
  check('event', { ...event, at_utc: '2026-01-01T00:00:00+01:00' }, false);
  const { entity_id, member_id, ...access } = event;
  check('event', { ...access, event_kind: 'access', actor_member_id: ids.member,
    target_type: 'project_role', target_id: ids.member,
    after: { role: 'viewer', version: 2 }, changes: [] }, true);
});

test('a field diff distinguishes missing values from null and history excludes contact bodies', () => {
  check('event', { ...event, changes: [{ field: 'project_id', before_present: false,
    after_present: true, before: null, after: null }] }, true);
  check('event', { ...event, changes: [{ field: 'project_id', before_present: false,
    after_present: true, before: 'not-absent', after: null }] }, false);
  check('event', { ...event, after: contact }, false);
});

test('entity and access events reject cross-kind snapshots and missing audit identifiers', () => {
  const { entity_id, member_id, ...shared } = event;
  const access = { ...shared, event_kind: 'access', actor_member_id: ids.member,
    target_type: 'project_role', target_id: ids.project,
    before: { role: 'viewer', version: 1 }, after: { role: 'editor', version: 2 } };
  check('event', access, true);
  for (const key of ['before', 'after']) {
    check('event', { ...event, [key]: { member_id: ids.member, issuer: 'https://identity.example', subject: 'synthetic-subject' } }, false);
    check('event', { ...access, [key]: project }, false);
  }
  for (const key of ['entity_id', 'member_id']) {
    const invalid = { ...event };
    delete invalid[key];
    check('event', invalid, false);
  }
  for (const key of ['actor_member_id', 'target_type', 'target_id']) {
    const invalid = { ...access };
    delete invalid[key];
    check('event', invalid, false);
  }
  check('event', { ...event, unexpected_audit: true }, false);
  check('event', { ...access, unexpected_audit: true }, false);
});
