import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { generate } from '../scripts/generate.mjs';

test('committed generated types exactly match a clean, deterministic generation', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'deskly-generated-'));
  try {
    const first = await generate(temporary);
    const second = await generate(temporary);
    assert.deepEqual([...first], [...second]);
    const checkedIn = new URL('../src/generated/', import.meta.url);
    assert.deepEqual((await readdir(checkedIn)).sort(), [...first.keys()].sort());
    for (const [name, expected] of first) {
      assert.equal(await readFile(new URL(name, checkedIn), 'utf8'), expected,
        `${name} is stale; run pnpm run generate and commit the result`);
      assert.equal(await readFile(resolve(temporary, name), 'utf8'), expected);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
