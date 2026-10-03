/** Offline conversion. Input and output contain private data; never print their values. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from '../.build/service-validation.js';
import { migrations, checksum } from '../.build/adapters/sql/migrations.js';

const tables = ['projects', 'milestones', 'work_items', 'events'];
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const literal = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const json = value => literal(JSON.stringify(value));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function mappedId(namespace, value, preserveUuid = true) {
  if (preserveUuid && typeof value === 'string' && uuidPattern.test(value)) return value.toLowerCase();
  if (!((typeof value === 'string' && value.length > 0) || (Number.isSafeInteger(value) && value > 0))) fail('invalid_legacy_id');
  const h = sha(JSON.stringify(['deskly-personal-migration-v1', namespace, value]));
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

export async function convertPersonal(inputText, config) {
  const backup = JSON.parse(inputText);
  if (backup?.format !== 'deskly-personal-d1-v2') fail('invalid_format');
  v.timestamp(backup.exported_at);
  const workspace = v.uuid(config.workspace_id), member = v.uuid(config.member_id), account = v.uuid(config.account_subject);
  if (v.text(config.name, true) !== config.name || v.text(config.login, true) !== config.login) fail('invalid_config');
  v.exact(config.identity, ['issuer', 'subject'], 'invalid_identity');
  if (typeof config.identity.subject !== 'string' || !config.identity.subject || config.identity.subject.trim() !== config.identity.subject) fail('invalid_identity');
  const issuer = new URL(config.identity.issuer);
  if (issuer.protocol !== 'https:' || issuer.origin !== config.identity.issuer) fail('invalid_identity');
  const ids = new Map(), allIds = new Set();
  for (const table of tables) {
    if (!Array.isArray(backup[table])) fail(`invalid_${table}`);
    const seen = new Set();
    for (const row of backup[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`invalid_${table}_row`);
      const key = JSON.stringify(row.id);
      if (seen.has(key)) fail(`duplicate_${table}`);
      seen.add(key);
      if (table === 'events') { v.integer(row.id); if (row.before_json !== null) JSON.parse(row.before_json); JSON.parse(row.after_json); continue; }
      const id = mappedId(table, row.id);
      if (allIds.has(id)) fail('duplicate_normalized_id');
      allIds.add(id); ids.set(`${table}:${key}`, id);
      v.integer(row.version); v.timestamp(row.created_at); v.timestamp(row.updated_at);
    }
  }
  const lookup = (table, id) => ids.get(`${table}:${JSON.stringify(id)}`) ?? fail('invalid_relation');
  const resources = [], events = [];
  for (const table of tables.slice(0,3)) for (const row of backup[table]) {
    const base = { id: lookup(table, row.id), workspace_id: workspace, project_id: table === 'projects' ? null : lookup('projects', row.project_id), type: table === 'projects' ? 'project' : table === 'milestones' ? 'milestone' : 'work_item', version: row.version, archived: false };
    let entity;
    if (table === 'projects') {
      if (!['personal', 'hybrid'].includes(row.scope)) fail('invalid_scope');
      entity = { ...base, name: row.name, purpose: row.purpose, owner_id: member, state: '進行中' };
    } else if (table === 'milestones') entity = { ...base, goal: row.goal, acceptance: row.acceptance, assignee_id: member, check_date: row.check_date, state: row.state };
    else {
      const milestone = row.milestone_id === null ? '' : lookup('milestones', row.milestone_id);
      if (milestone && backup.milestones.find(m => lookup('milestones', m.id) === milestone)?.project_id !== row.project_id) fail('invalid_milestone_relation');
      entity = { ...base, title: row.title, next_action: row.next_action, check_date: row.check_date, state: row.state, kind: '開発', assignee_id: member, waiting_reason: '', milestone_id: milestone };
    }
    try { v.entity(entity, workspace); } catch (error) { fail(`incompatible_${table}_${sha(JSON.stringify(row.id)).slice(0,12)}_${error.code ?? 'validation'}`); }
    resources.push(entity);
    if (table === 'projects' && row.repository_url !== '') {
      if (typeof row.repository_url !== 'string') fail('invalid_repository_url');
      const reference = { id: mappedId('repository-reference', row.id, false), workspace_id: workspace, project_id: entity.id, type: 'reference', version: 1, archived: false, kind: 'https', target: row.repository_url, label: 'リポジトリ', linked_id: '', source_id: '' };
      v.entity(reference, workspace); if (allIds.has(reference.id)) fail('duplicate_normalized_id'); allIds.add(reference.id); resources.push(reference);
    }
    events.push({ event_kind: 'entity', operation_id: mappedId('migration-operation', row.id + ':' + table, false), workspace_id: workspace, requester_member_id: member, member_id: member, entity_id: entity.id, route: 'migration', executor_kind: 'unknown', executor_ref: null, executor_verified: false, reason: '旧個人台帳から移行。旧履歴は原文保管表に保存。', at_utc: backup.exported_at, before: null, after: entity, changes: v.changes(null, entity) });
  }
  const lines = ['-- Private data. Apply only to a NEW empty database.', 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;'];
  for (const [i, migration] of migrations.entries()) lines.push(migration.sql, `INSERT INTO schema_migrations VALUES (${i+1},${literal(migration.name)},${literal(await checksum(migration.sql))});`);
  const archive = `CREATE TABLE legacy_personal_export (sha256 TEXT PRIMARY KEY, raw_text TEXT NOT NULL) STRICT;
CREATE TABLE legacy_personal_rows (table_name TEXT NOT NULL, row_key TEXT NOT NULL, sha256 TEXT NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), PRIMARY KEY(table_name,row_key)) STRICT;`;
  lines.push(archive);
  for (const table of ['legacy_personal_export', 'legacy_personal_rows']) for (const action of ['UPDATE', 'DELETE']) lines.push(`CREATE TRIGGER ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'legacy archive is append-only'); END;`);
  // INSERT OR REPLACE must not bypass append-only guarantees even with recursive_triggers off.
  for (const table of ['legacy_personal_export', 'legacy_personal_rows']) lines.push(`CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${table === 'legacy_personal_export' ? 'sha256=NEW.sha256' : 'table_name=NEW.table_name AND row_key=NEW.row_key'}) BEGIN SELECT RAISE(ABORT,'legacy archive is append-only'); END;`);
  lines.push(`INSERT INTO legacy_personal_export VALUES (${literal(sha(inputText))},${literal(inputText)});`);
  for (const table of tables) for (const row of backup[table]) { const raw = JSON.stringify(row); lines.push(`INSERT INTO legacy_personal_rows VALUES (${literal(table)},${literal(JSON.stringify(row.id))},${literal(sha(raw))},${literal(raw)});`); }
  const workspaceData = { workspace_id: workspace, name: config.name, timezone: 'Asia/Tokyo', schema_version: 3 };
  const accountData = { subject: account, login: config.login, active: true, revision: 1 };
  const membership = { scope: 'workspace', workspace_id: workspace, member_id: member, name: config.name, role: 'owner', active: true, version: 1, identity: config.identity };
  lines.push(`INSERT INTO workspaces VALUES (${literal(workspace)},${json(workspaceData)});`, `INSERT INTO accounts VALUES (${literal(account)},${json(accountData)});`, `INSERT INTO workspace_memberships VALUES (${literal(workspace)},${literal(member)},1,${json(membership)});`);
  for (const row of resources) lines.push(`INSERT INTO resources VALUES (${literal(workspace)},${literal(row.id)},${literal(row.type)},${literal(row.project_id)},${row.version},${json(row)});`);
  for (const row of events) lines.push(`INSERT INTO events VALUES (${literal(workspace)},${literal(row.operation_id)},'workspace',NULL,NULL,${literal(member)},${json(row)});`);
  return { sql: lines.join('\n')+'\n', hash: sha(inputText), counts: Object.fromEntries(tables.map(table => [table, backup[table].length])) };
}

export async function runCli(args) {
  if (args.length !== 3) fail('usage: node scripts/migrate-legacy-personal.mjs INPUT.json CONFIG.json NEW.sql');
  const [input, configPath, output] = args.map(p => resolve(p));
  const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const parent = await realpath(dirname(output));
  const location = relative(repo, parent);
  if (!location || (!(location === '..' || location.startsWith('..' + sep)) && !isAbsolute(location))) fail('output_must_be_outside_repository');
  if ((await stat(input)).size > 100_000_000 || (await stat(configPath)).size > 100_000) fail('input_too_large');
  const result = await convertPersonal(await readFile(input,'utf8'), JSON.parse(await readFile(configPath,'utf8')));
  await writeFile(output, result.sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { counts: result.counts, sha256: result.hash };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(error => {
    const code = error.code === 'EEXIST' ? 'output_exists' : error.message;
    // Parser/filesystem errors can contain input fragments or private paths.
    process.stderr.write(/^(invalid_|duplicate_|incompatible_|output_|input_|usage:)/.test(code) ? code+'\n' : 'migration_failed\n'); process.exitCode = 1;
  });
}
