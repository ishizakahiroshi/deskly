import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, changes, compareTimestamps, nextTimestamp } from '../.build/service-validation.js';
import { createConfirmationSigner } from '../.build/confirmation.js';

test('canonical JSON rejects ambiguous values, cycles, sparse arrays and excessive nesting', () => {
  assert.equal(canonical({ second: [1, null], first: true }), '{"first":true,"second":[1,null]}');
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, new Date(), [undefined], Array(1), cycle]) {
    assert.throws(() => canonical(value), { code: 'invalid_request' });
  }
  let nested = null;
  for (let index = 0; index < 130; index++) nested = [nested];
  assert.throws(() => canonical(nested), { code: 'invalid_request' });
});

test('runtime event differences preserve null versus absence and sorted complete fields', () => {
  assert.deepEqual(changes({ removed: null, same: [1, 2] }, { added: null, same: [1, 2] }), [
    { field: 'added', before_present: false, after_present: true, before: null, after: null },
    { field: 'removed', before_present: true, after_present: false, before: null, after: null },
  ]);
});

test('contact timestamps advance a microsecond, retain precision and are stable on apply', () => {
  const now = '2026-01-01T00:00:00Z';
  const samples = [
    [now, '2026-01-01T00:00:00.000001Z'],
    ['2026-01-01T00:00:00.999999Z', '2026-01-01T00:00:01.000000Z'],
    ['2027-01-01T01:00:00.123456+01:00', '2027-01-01T00:00:00.123457Z'],
  ];
  for (const [previous, expected] of samples) {
    assert.equal(nextTimestamp(now, previous), expected);
    assert.equal(nextTimestamp(expected, previous), expected);
  }
  assert.equal(nextTimestamp(now, 'legacy text'), now);
  assert.equal(nextTimestamp(now, '2025-01-01T00:00:00Z'), now);
  assert.throws(() => nextTimestamp('2026-02-30T00:00:00Z'), { code: 'invalid_date' });
});

test('Web Crypto confirmation verifies exact payload and rejects invalid or different signatures', async () => {
  const signer = await createConfirmationSigner(new Uint8Array(32).fill(9)); // Synthetic key only.
  const token = await signer.sign('synthetic preview');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await signer.verify('synthetic preview', token), true);
  assert.equal(await signer.verify('changed preview', token), false);
  assert.equal(await signer.verify('synthetic preview', 'invalid'), false);
  assert.equal(await signer.verify('synthetic preview', token.toUpperCase()), false);
  assert.equal((await signer.digest('synthetic preview')).length, 64);
  await assert.rejects(createConfirmationSigner(new Uint8Array(31)), /32 bytes/);
});

test('UTC ordering handles mixed fractional precision without millisecond rounding', () => {
  const values = ['2026-01-01T00:00:00.10000001Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.1Z'];
  assert.deepEqual(values.toSorted(compareTimestamps), [values[1], values[2], values[0]]);
  assert.equal(compareTimestamps('2026-01-01T00:00:00.100Z', '2026-01-01T00:00:00.1Z'), 0);
});
