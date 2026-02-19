import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHashValues } from '../scripts/hash-key.js';

test('computeHashValues produces expected hashes without pepper', () => {
  const result = computeHashValues('abc');
  assert.equal(
    result.plain,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(result.peppered, result.plain);
  assert.equal(result.key, 'abc');
  assert.equal(result.pepper, '');
});

test('computeHashValues applies pepper when provided', () => {
  const result = computeHashValues('abc', 'pepper');
  assert.equal(
    result.peppered,
    'e5c5d287a03c5b390a364c2ef137aa2d1fb6a78291cec2276b27b054c2012b22'
  );
  assert.equal(result.plain, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('computeHashValues rejects missing keys', () => {
  assert.throws(() => computeHashValues(''), /API key is required/i);
  assert.throws(() => computeHashValues('   '), /API key is required/i);
});
