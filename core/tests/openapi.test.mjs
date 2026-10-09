import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { contact, examples, ids, milestone, project, workItem } from './fixtures.mjs';

const directory = new URL('../../schema/', import.meta.url);
const openapiUrl = new URL('openapi.json', directory);
const openapiId = 'https://deskly.example/schema/openapi.json';
const spec = JSON.parse(await readFile(openapiUrl, 'utf8'));
const documents = new Map([[openapiUrl.href, spec], [openapiId, spec]]);
const entitySchemas = new Map();
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

for (const name of (await readdir(directory)).filter((name) => name.endsWith('.schema.json'))) {
  const schema = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
  entitySchemas.set(name, schema);
  documents.set(new URL(name, directory).href, schema);
  documents.set(schema.$id, schema);
  ajv.addSchema(schema);
}

// OpenAPI metadata is not JSON Schema. Relocate only the components container
// and its local pointers into $defs; compile every actual schema with strict AJV.
// A separate test resolves every original OpenAPI reference without rewriting it.
const componentSchemas = structuredClone(spec.components.schemas);
function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === 'object') {
    visit(value);
    for (const item of Object.values(value)) walk(item, visit);
  }
}
walk(componentSchemas, (node) => {
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    node.$ref = node.$ref.replace('#/components/schemas/', '#/$defs/');
  }
});
ajv.addSchema({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: openapiId,
  $defs: componentSchemas,
});
const validator = (name) => {
  const validate = ajv.getSchema(`${openapiId}#/$defs/${name}`);
  assert.ok(validate, `missing OpenAPI component ${name}`);
  return validate;
};
const check = (name, value, expected = true) => {
  const validate = validator(name);
  assert.equal(validate(value), expected, `${name}: ${JSON.stringify(validate.errors)}`);
};
const dataFor = (kind, entity) => Object.fromEntries(
  Object.keys(entitySchemas.get(`${kind}.schema.json`).$defs.data.properties)
    .map((key) => [key, entity[key]]),
);
const entities = { project, milestone, work_item: workItem };
const commandFor = (kind, action) => ({
  operation_id: ids.operation,
  action,
  type: kind,
  id: action === 'create' ? null : entities[kind].id,
  project_id: kind === 'project' ? null : ids.project,
  expected_version: action === 'create' ? null : 1,
  data: ['create', 'update'].includes(action) ? dataFor(kind, entities[kind]) : null,
  reason: '合成の変更理由',
});
const previewFor = (kind, action) => {
  const entity = entities[kind];
  return {
    request: { ...commandFor(kind, action), id: entity.id },
    before: action === 'create' ? null : { ...entity, archived: action === 'restore' },
    after: { ...entity, archived: action === 'archive', version: action === 'create' ? 1 : 2 },
    // Deliberately synthetic; validates shape only and cannot authorize a write.
    preview_token: '0'.repeat(64),
  };
};

const workspacePath = '/api/v1/workspaces/{workspace_id}';
const projectPath = `${workspacePath}/projects/{project_id}`;
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, operation]) => ({ path, item, method, operation })),
);

test('OpenAPI 3.1 resolves all original references locally without network access', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  let references = 0;
  for (const [name, document] of documents) {
    const base = document.$id ?? name;
    walk(document, (node) => {
      if (!('$ref' in node)) return;
      assert.equal(typeof node.$ref, 'string');
      assert.ok(!/^https?:/.test(node.$ref), `nonlocal reference ${node.$ref}`);
      const target = new URL(node.$ref, base);
      const fragment = decodeURIComponent(target.hash.slice(1));
      target.hash = '';
      let resolved = documents.get(target.href);
      assert.notEqual(resolved, undefined, `missing local document ${target.href}`);
      assert.ok(fragment === '' || fragment.startsWith('/'), `unsupported anchor ${fragment}`);
      for (const token of fragment.slice(1).split('/').filter((_, index) => fragment !== '' || index > 0)) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        assert.ok(Object.hasOwn(resolved, key), `unresolved pointer ${node.$ref} in ${name}`);
        resolved = resolved[key];
      }
      references += 1;
    });
  }
  assert.ok(references > 100, 'the resource, parameter, response and schema references were traversed');
});

test('every OpenAPI component compiles with strict JSON Schema semantics', () => {
  for (const name of Object.keys(spec.components.schemas)) validator(name);
});

test('resource coverage, path parameters, authentication and typed responses are explicit', () => {
  assert.equal(spec['x-implementation-status'], 'contract-only');
  assert.deepEqual(spec.security, [{ SharedSession: [] }]);
  const security = spec.components.securitySchemes.SharedSession;
  assert.equal(security.type, 'apiKey');
  assert.equal(security.in, 'cookie');
  assert.equal(security.name, 'deskly_shared_session');
  const operationIds = operations.map(({ operation }) => operation.operationId);
  assert.equal(new Set(operationIds).size, operationIds.length);
  for (const tag of ['workspaces', 'projects', 'milestones', 'work_items', 'contacts', 'events', 'accounts', 'memberships']) {
    assert.ok(operations.some(({ operation }) => operation.tags.includes(tag)), `missing ${tag} resource`);
  }
  for (const { path, item, method, operation } of operations) {
    assert.equal(operation['x-implementation-status'], 'contract-only');
    assert.ok(!Object.hasOwn(operation, 'security'), 'operations cannot disable global authentication');
    const declared = item.parameters.map(({ $ref }) => spec.components.parameters[$ref.split('/').at(-1)]);
    assert.deepEqual(declared.map(({ name }) => name).sort(),
      [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort());
    for (const parameter of declared) {
      assert.equal(parameter.in, 'path');
      assert.equal(parameter.required, true);
      assert.ok(parameter.schema.$ref);
    }
    assert.ok(operation.responses['200'].content['application/json'].schema.$ref);
    for (const code of ['400', '401', '403', '404', '409']) {
      assert.ok(operation.responses[code].$ref, `${operation.operationId} missing ${code}`);
    }
    assert.equal(Object.hasOwn(operation, 'requestBody'), method !== 'get');
    if (method !== 'get') {
      assert.equal(operation.requestBody.required, true);
      assert.ok(operation.requestBody.content['application/json'].schema.$ref);
      assert.deepEqual(operation['x-origin-checks'], ['Host', 'Origin', 'Sec-Fetch-Site']);
    }
  }
});

test('first-party writes use exact authoritative data through preview and apply only', () => {
  for (const [kind, label] of [['project', 'Project'], ['milestone', 'Milestone'], ['work_item', 'WorkItem']]) {
    for (const action of ['Create', 'Update']) {
      assert.equal(spec.components.schemas[`${action}${label}Command`].properties.data.$ref,
        `./${kind}.schema.json#/$defs/data`);
    }
  }
  const preview = spec.paths[`${workspacePath}/commands/preview`].post;
  const apply = spec.paths[`${workspacePath}/commands/apply`].post;
  assert.equal(preview.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CommandRequest');
  assert.equal(preview.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/CommandPreview');
  assert.equal(apply.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CommandPreview');
  assert.equal(apply.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/CommandResult');
  assert.match(apply.description, /same normalized request and same principal/);
  assert.match(apply.description, /same transaction|one transaction/);
  for (const { method, operation } of operations) {
    if (operation.tags.some((tag) => ['projects', 'milestones', 'work_items'].includes(tag))) {
      assert.equal(method, 'get', 'direct mutations must not bypass two-phase commands');
    }
  }
});

test('all 12 command forms and previews enforce version, identity and archive shapes', () => {
  for (const kind of Object.keys(entities)) {
    for (const action of ['create', 'update', 'archive', 'restore']) {
      const command = commandFor(kind, action);
      check('CommandRequest', command);
      for (const field of ['actor', 'member_id', 'requester_member_id', 'executor_kind', 'route']) {
        check('CommandRequest', { ...command, [field]: 'client-assertion' }, false);
      }
      for (const version of [true, 0, -1, 1.5, '1']) {
        check('CommandRequest', { ...command, expected_version: version }, false);
      }
      check('CommandRequest', { ...command, reason: ' ' }, false);
      check('CommandRequest', { ...command, operation_id: 'not-a-uuid' }, false);
      const missing = { ...command };
      delete missing.expected_version;
      check('CommandRequest', missing, false);
      const preview = previewFor(kind, action);
      check('CommandPreview', preview);
      check('CommandPreview', { ...preview, preview_token: 'invalid' }, false);
      check('CommandPreview', { ...preview, request: { ...preview.request, id: null } }, false);
      check('CommandPreview', { ...preview, actor: ids.member }, false);
      check('CommandPreview', { ...preview, after: { ...preview.after, archived: action !== 'archive' } }, false);
      if (['archive', 'restore'].includes(action)) {
        check('CommandRequest', { ...command, data: dataFor(kind, entities[kind]) }, false);
      } else {
        check('CommandRequest', { ...command, data: { ...command.data, version: 7 } }, false);
      }
      if (action === 'create') {
        check('CommandRequest', { ...command, id: entities[kind].id });
        check('CommandRequest', { ...command, expected_version: 1 }, false);
        check('CommandPreview', { ...preview, before: entities[kind] }, false);
      } else {
        check('CommandRequest', { ...command, expected_version: null }, false);
        check('CommandPreview', { ...preview, after: { ...preview.after, version: 1 } }, false);
        check('CommandPreview', { ...preview, before: { ...preview.before, archived: action !== 'restore' } }, false);
      }
    }
  }
});

test('commands preserve current Python vocabulary and complete-field replacement', () => {
  for (const kind of ['milestone', 'work_item']) {
    const command = commandFor(kind, 'create');
    for (const state of ['未着手', '取りやめ', '終了']) {
      check('CommandRequest', { ...command, data: { ...command.data, state } }, false);
    }
    for (const field of Object.keys(command.data)) {
      const data = { ...command.data };
      delete data[field];
      check('CommandRequest', { ...command, data }, false);
    }
  }
  check('CommandRequest', { ...commandFor('project', 'create'), project_id: ids.project }, false);
  check('CommandRequest', { ...commandFor('milestone', 'create'), project_id: null }, false);
});

test('owner-only grants distinguish initial zero, persisted versions and revocation', () => {
  const grant = { operation_id: ids.operation, expected_version: 0, role: 'editor', reason: '合成の権限変更' };
  for (const role of ['editor', 'viewer']) check('SetProjectRoleRequest', { ...grant, role });
  check('SetProjectRoleRequest', { ...grant, role: null, expected_version: 1 });
  check('SetProjectRoleRequest', { ...grant, role: null }, false);
  for (const role of ['owner', 'member', '']) check('SetProjectRoleRequest', { ...grant, role }, false);
  for (const version of [true, -1, null, 1.5, '1']) {
    check('SetProjectRoleRequest', { ...grant, expected_version: version }, false);
  }
  check('SetProjectRoleRequest', { ...grant, actor: ids.member }, false);
  const sourceGrant = { operation_id: ids.operation, expected_version: 0, allowed: true, reason: '合成の権限変更' };
  check('SetSourceAccessRequest', sourceGrant);
  check('SetSourceAccessRequest', { ...sourceGrant, allowed: false }, false);
  check('SetSourceAccessRequest', { ...sourceGrant, expected_version: 1, allowed: false });
  check('SetSourceAccessRequest', { ...sourceGrant, allowed: 1 }, false);
  for (const { method, operation } of operations.filter(({ operation }) => operation.tags.includes('memberships'))) {
    assert.equal(operation['x-required-access'], 'workspace-owner');
    if (method === 'put') assert.match(operation.description, /operation_id/);
  }
});

test('contact/account/event surfaces stay read-only and exclude sensitive transport fields', () => {
  for (const { method, operation } of operations) {
    if (operation.tags.some((tag) => ['workspaces', 'contacts', 'accounts', 'events'].includes(tag))) {
      assert.equal(method, 'get');
    }
  }
  assert.ok(operations.every(({ method }) => method !== 'delete'));
  const contactOperation = spec.paths[`${projectPath}/sources/{source_id}/contacts/{contact_id}`].get;
  assert.equal(contactOperation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/SharedContact');
  assert.equal(spec.components.schemas.SharedContact.$ref, './contact.schema.json#/$defs/sharedContact');
  assert.match(contactOperation.description, /both project read permission and source-use permission/);
  assert.match(contactOperation.description, /same 404/);
  const shared = Object.fromEntries(Object.entries(contact).filter(([key]) =>
    !['sensitive', 'source_path', 'source_hash', 'extra'].includes(key)));
  check('SharedContact', shared);
  for (const key of ['sensitive', 'source_path', 'source_hash', 'extra']) {
    check('SharedContact', { ...shared, [key]: contact[key] }, false);
  }
  check('Account', examples.account);
  for (const key of ['password', 'password_hash', 'salt', 'session_token']) {
    check('Account', { ...examples.account, [key]: 'synthetic' }, false);
  }
  check('Event', examples.event);
  check('Event', { ...examples.event, after: contact }, false);
});

test('409 conflict bodies are typed and never carry hidden latest records', () => {
  for (const error of ['version_conflict', 'operation_conflict', 'stale_preview', 'assigned_work_remaining']) {
    check('Conflict', { error });
  }
  check('Conflict', { error: 'forbidden' }, false);
  check('Conflict', { error: 'version_conflict', latest: project }, false);
  assert.match(spec.components.responses.Conflict.description, /Keep unsaved input/);
  assert.match(spec.components.responses.Conflict.description, /fresh confirmation/);
});
