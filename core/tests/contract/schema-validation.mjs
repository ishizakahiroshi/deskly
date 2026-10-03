import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const directory = new URL('../../../schema/', import.meta.url);
export const spec = JSON.parse(await readFile(new URL('openapi.json', directory), 'utf8'));
const openapiId = 'https://deskly.example/schema/openapi.json';
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const name of (await readdir(directory)).filter((name) => name.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(await readFile(new URL(name, directory), 'utf8')));
}
const definitions = structuredClone(spec.components.schemas);
function rewrite(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
    value.$ref = value.$ref.replace('#/components/schemas/', '#/$defs/');
  }
  for (const item of Object.values(value)) rewrite(item);
}
rewrite(definitions);
ajv.addSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: openapiId, $defs: definitions });

export function assertApiSchema(name, value) {
  const validator = ajv.getSchema(`${openapiId}#/$defs/${name}`);
  assert.ok(validator, `unknown OpenAPI schema ${name}`);
  assert.equal(validator(value), true, `${name}: ${JSON.stringify(validator.errors)}\n${JSON.stringify(value)}`);
}
export function assertEntitySchema(filename, value) {
  const validator = ajv.getSchema(`https://deskly.example/schema/${filename}.schema.json`);
  assert.ok(validator, `unknown entity schema ${filename}`);
  assert.equal(validator(value), true, `${filename}: ${JSON.stringify(validator.errors)}`);
}
export const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
);
const pattern = (path) => new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
export function assertHttpContract(method, path, status, body) {
  const found = operations.find((entry) => entry.method === method && pattern(entry.path).test(path.split('?')[0]));
  if (!found) {
    assertApiSchema('Error', body);
    return null;
  }
  let response = found.operation.responses[String(status)];
  assert.ok(response, `${method} ${path} returned undocumented status ${status}`);
  if (response.$ref) response = spec.components.responses[response.$ref.split('/').at(-1)];
  const reference = response.content['application/json'].schema.$ref;
  assertApiSchema(reference.split('/').at(-1), body);
  return found.operation.operationId;
}
