// Explicit, disposable browser preview. Never opens an existing database or a real home.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../.build/adapters/vps/server.js';
import { createConfirmationSigner } from '../.build/confirmation.js';
import { caseSettings, parseCaseSettingsToml } from '../.build/case-settings.js';
import { WorkspaceService } from '../.build/service.js';
if (process.env.NODE_ENV !== 'development' || process.env.DESKLY_UI_PREVIEW !== '1') {
  throw new Error('Set NODE_ENV=development and DESKLY_UI_PREVIEW=1 for the disposable synthetic preview');
}
const workspace = '00000000-0000-0000-0000-000000000001';
const member = '00000000-0000-0000-0000-000000000002';
const account = '00000000-0000-0000-0000-000000000004';
const project = '00000000-0000-0000-0000-000000000011';
const milestone = '00000000-0000-0000-0000-000000000012';
const source = '00000000-0000-0000-0000-000000000021';
/**
 * Synthetic received cases through the real service: every configured status, an overdue
 * promise, a hold that has come and one that has not, a terminal case without evidence,
 * evidence of each link type, replies, an extra reporter and three sending apps (one
 * without a display name). Kinds, statuses and approval states are picked from the
 * settings by their role (initial, hold, terminal...), not written as literals.
 */
async function seedCases(service) {
  const settings = await service.cases.settingsView(principal, workspace);
  const { kinds, statuses, approval_states: approvals } = settings;
  const approvalKind = kinds.requires_approval[0];
  const [freeKind, secondFree = freeKind, thirdFree = freeKind] = kinds.values.filter(kind => !kinds.requires_approval.includes(kind));
  const theirs = statuses.open.find(status => statuses.waiting[status] === 'them') ?? statuses.initial;
  const working = statuses.open.find(status => status !== statuses.initial && statuses.waiting[status] === 'us') ?? statuses.initial;
  const [closed, dropped = closed] = statuses.terminal;
  const decided = approvals.values.find(value => ![approvals.initial, approvals.initial_free, approvals.hold].includes(value)) ?? approvals.initial;
  const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const app = name => ({ kind: 'app', workspace_id: workspace, app: name, sources: [name], tenants: ['*'] });
  const create = async (source, input) => (await service.cases.create(app(source), workspace, { origin: 'human',
    reporter_ref: 'u-synthetic-1', body: '合成の確認用の受付です。\n実際の報告ではありません。', ...input })).number;
  const update = async (number, change) => {
    const { case: current } = await service.cases.read(principal, workspace, number);
    await service.cases.update(principal, workspace, number, { expected_revision: current.revision, reason: '合成の準備', ...change });
  };
  const place = (screen) => ({ screen_id: screen, feature_id: 'save', environment: 'staging', version: '0.0.1', url: 'https://app.example.com/synthetic' });
  await create('app_one', { kind: freeKind, title: '合成: 保存ボタンが反応しない', place: place('synthetic-order-form'), promised_due: day(-3) });
  const held = await create('app_one', { kind: approvalKind, title: '合成: 一覧に列を足したい', place: place('synthetic-list') });
  await update(held, { status: theirs, approval_state: approvals.hold, hold_until: day(-1) });
  const missing = await create('app_one', { kind: freeKind, title: '合成: 直したが証拠が無い', place: place('synthetic-order-form') });
  await update(missing, { status: closed });
  const fixed = await create('app_one', { kind: freeKind, title: '合成: 直して証拠がある', place: place('synthetic-order-form') });
  await service.cases.addLink(principal, workspace, fixed, { link_type: 'commit', ref: '0123456789abcdef0123456789abcdef01234567' });
  await service.cases.addReply(principal, workspace, fixed, { body: '合成の返事: 直しました。' });
  await update(fixed, { status: closed });
  const asked = await create('app_two', { kind: secondFree, title: '合成: 使い方を知りたい', promised_due: day(5) });
  await update(asked, { status: working });
  await service.cases.addPerson(app('app_two'), workspace, asked, { reporter_ref: 'u-synthetic-2' });
  await create('app_two', { kind: approvalKind, title: '合成: 承認を待っている要望', place: place('synthetic-settings') });
  const later = await create('app_two', { kind: approvalKind, title: '合成: 先まで保留する要望', place: place('synthetic-settings') });
  await update(later, { approval_state: approvals.hold, hold_until: day(10) });
  const approved = await create('app_two', { kind: approvalKind, title: '合成: 承認された要望', place: place('synthetic-list') });
  await update(approved, { approval_state: decided, promised_due: day(14) });
  const declined = await create('app_three', { kind: thirdFree, title: '合成: 見送ると決めた件' });
  await service.cases.addLink(principal, workspace, declined, { link_type: 'doc', ref: 'docs/synthetic-decision.md' });
  await update(declined, { status: dropped });
  await create('app_two', { origin: 'detected', reporter_ref: null, fingerprint: 'f'.repeat(64), kind: freeKind,
    title: '合成: アプリが検知した例外', place: place('synthetic-report') });
}
const directory = await mkdtemp(join(tmpdir(), 'deskly-ui-preview-'));
const principal = { workspace_id: workspace, member_id: member, role: 'owner', active: true, account_subject: account };
// Case settings: the example file, plus display words for the approval states from the
// design's section 2 table (the example leaves them out) so every label can be seen.
const example = parseCaseSettingsToml(await readFile(new URL('../config/case-settings.example.toml', import.meta.url), 'utf8'));
const approvalWords = { not_required: '承認不要', pending: '承認待ち', approved: '承認済み', rejected: '却下', on_hold: '保留' };
let running;
try {
  const settingsDocument = structuredClone(example);
  settingsDocument.labels.ja = { ...settingsDocument.labels.ja, ...Object.fromEntries(Object.entries(approvalWords)
    .filter(([value]) => example.approval_states.values.includes(value))) };
  const caseSettingsPath = join(directory, 'case-settings.json');
  await writeFile(caseSettingsPath, JSON.stringify(settingsDocument));
  running = await startServer({ databasePath: join(directory, 'preview.sqlite'), origin: 'http://127.0.0.1:3000', port: 3000, caseSettingsPath }, {
    authenticator: { async authenticate() { return { ...principal }; } },
    signer: await createConfirmationSigner(new Uint8Array(randomBytes(32))),
  });
  await running.store.transaction(async session => {
    await session.workspaces.put({ workspace_id: workspace, name: '合成 workspace', timezone: 'Asia/Tokyo', schema_version: 3 });
    await session.accounts.put({ subject: account, login: 'synthetic_preview', active: true, revision: 1 });
    await session.memberships.put({ scope: 'workspace', workspace_id: workspace, member_id: member, role: 'owner', active: true, name: '合成管理者' }, null);
    await session.memberships.put({ scope: 'workspace', workspace_id: workspace,
      member_id: '00000000-0000-0000-0000-000000000003', name: '合成メンバー', role: 'member', active: true }, null);
    const common = { workspace_id: workspace, version: 1, archived: false };
    await session.resources.put({ ...common, id: project, project_id: null, type: 'project', name: '合成の確認案件',
      purpose: '画面で次の行動と変更内容を確かめる', owner_id: member, state: '進行中' }, null);
    await session.resources.put({ ...common, id: milestone, project_id: project, type: 'milestone', goal: '合成の動作確認',
      acceptance: '見本と保存結果を確認できる', assignee_id: member, check_date: '2026-10-02', state: '進行中' }, null);
    await session.resources.put({ ...common, id: '00000000-0000-0000-0000-000000000013', project_id: project, type: 'work_item',
      kind: '開発', title: '合成の確認作業', assignee_id: member, next_action: '変更の見本を確認する',
      check_date: '2026-10-02', waiting_reason: '', state: '未確認', milestone_id: milestone }, null);
    await session.resources.put({ ...common, id: source, project_id: null, type: 'source',
      label: '合成連絡台帳', adapter: 'contact', binding: 'synthetic_preview' }, null);
    const states = ['下書き', '送信済み', '回答待ち', '対応中', '完了', '送らない'];
    for (const [index, state] of states.entries()) await session.contacts.put({
      workspace_id: workspace, source_id: source, version: 1, contact: {
        id: `c-20261001-${String(index + 1).padStart(8, '0')}`, state, state_inferred: false,
        project: index === 2 ? '合成の返信待ち案件' : index < 4 ? '合成の確認案件' : '', recipient: `合成宛先 ${index + 1}`, channel: 'メール',
        sent_at: state === '下書き' ? '' : '2026-10-01', due: index === 0 || index === 2 ? '2026-09-30' : '2026-10-02',
        promise: '合成の確認結果をまとめる', agreement: '', sensitive: '', basis: '',
        note: '実際の連絡ではない確認用データ', references: '', shared_url: '',
        body: `合成宛先 ${index + 1} への本文です。\nこの確認用の内容は送信されません。`,
        source_path: '', source_hash: '', extra: {}, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
      },
    }, null);
  });
  await seedCases(new WorkspaceService({ store: running.store, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, signer: await createConfirmationSigner(new Uint8Array(randomBytes(32))),
    caseSettings: caseSettings(settingsDocument) }));
  console.log('Synthetic workspace/contact/case preview: http://127.0.0.1:3000 (temporary data is removed when stopped)');
  console.log(`Contact source ID: ${source}`);
  console.log('Cases: press 受付 (every status, overdue, hold expired, missing evidence, three apps)');
} catch (error) {
  await running?.close(); await rm(directory, { recursive: true, force: true }); throw error;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void running.close().finally(() => rm(directory, { recursive: true, force: true })).catch(() => { process.exitCode = 1; });
});
