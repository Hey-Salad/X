import test from 'node:test';
import assert from 'node:assert/strict';
import { hashKey, buildKeyHashCandidates } from '../src/key-utils.js';

test('hashKey applies pepper when provided', () => {
  const withPepper = hashKey('abc', 'pepper');
  assert.equal(withPepper, 'e5c5d287a03c5b390a364c2ef137aa2d1fb6a78291cec2276b27b054c2012b22');

  const withoutPepper = hashKey('abc');
  assert.equal(withoutPepper, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('buildKeyHashCandidates returns fallback plain hash when enabled', () => {
  const candidates = buildKeyHashCandidates('abc', {
    pepper: 'pepper',
    includePlainFallback: true
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map(entry => entry.variant),
    ['peppered', 'plain']
  );
  assert.equal(
    candidates[1].hash,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('buildKeyHashCandidates avoids duplicate fallback when hashes match', () => {
  const candidates = buildKeyHashCandidates('abc', {
    pepper: '',
    includePlainFallback: true
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].variant, 'plain');
});
