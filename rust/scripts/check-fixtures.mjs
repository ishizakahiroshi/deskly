// Read-only parity check. No real home, accounts, or ledgers are accessed.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { examples } from '../../core/tests/fixtures.mjs';

const directory = new URL('../crates/deskly-types/tests/fixtures/', import.meta.url);
assert.deepEqual((await readdir(directory)).sort(), Object.keys(examples).map((name) => `${name}.json`).sort());
for (const [name, expected] of Object.entries(examples)) {
  const actual = JSON.parse(await readFile(new URL(`${name}.json`, directory), 'utf8'));
  assert.deepEqual(actual, expected, `${name} must match core/tests/fixtures.mjs`);
}
console.log('All eight Rust fixtures match core/tests/fixtures.mjs');
