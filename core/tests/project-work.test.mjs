import assert from 'node:assert/strict';
import test from 'node:test';
import { nextProjectWork, pendingProjectWork } from '../.build/project-work.js';

const workspace_id = '00000000-0000-0000-0000-000000000001';
const member_id = '00000000-0000-0000-0000-000000000002';
const project = Object.freeze({
  id: '00000000-0000-0000-0000-000000000003', workspace_id, project_id: null,
  type: 'project', version: 1, archived: false,
  name: '合成案件', purpose: '合成の目的', owner_id: member_id, state: '進行中',
});
const work = (suffix, overrides = {}) => Object.freeze({
  id: `00000000-0000-0000-0000-${suffix.padStart(12, '0')}`,
  workspace_id, project_id: project.id, type: 'work_item', version: 1, archived: false,
  kind: '開発', title: '合成作業', assignee_id: member_id,
  next_action: '合成確認', check_date: '', waiting_reason: '',
  state: '未確認', milestone_id: '', ...overrides,
});

test('pending work uses workspace/project IDs, ignores archived and completed work', () => {
  const pending = work('10');
  const items = Object.freeze([
    work('11', { state: '完了' }), work('12', { archived: true }),
    work('13', { project_id: '00000000-0000-0000-0000-000000000099' }),
    work('14', { workspace_id: '00000000-0000-0000-0000-000000000098' }), pending,
  ]);
  assert.deepEqual(pendingProjectWork(project, items), [pending]);
  assert.equal(nextProjectWork(project, items), pending);
  assert.equal(items[0].state, '完了');
});

test('all non-complete states stay pending and order matches Python stable-ID order', () => {
  const waiting = work('12', { state: '待ち' });
  const held = work('11', { state: '保留' });
  const active = work('13', { state: '進行中' });
  const items = Object.freeze([waiting, active, held]);
  assert.deepEqual(pendingProjectWork(project, items), [held, waiting, active]);
  assert.deepEqual(items, [waiting, active, held]);
});

test('empty or archived projects have no next work', () => {
  assert.equal(nextProjectWork(project, []), undefined);
  assert.deepEqual(pendingProjectWork({ ...project, archived: true }, [work('10')]), []);
  assert.equal(nextProjectWork(project, [work('10', { state: '完了' })]), undefined);
});
