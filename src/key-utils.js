import crypto from 'crypto';

function normalizeKey(input) {
  if (typeof input !== 'string') {
    throw new Error('API key must be a string.');
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('API key is required.');
  }
  return trimmed;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashKey(apiKey, pepper = '') {
  const normalizedKey = normalizeKey(apiKey);
  const normalizedPepper = typeof pepper === 'string' ? pepper : '';
  return sha256Hex(`${normalizedKey}${normalizedPepper}`);
}

export function buildKeyHashCandidates(apiKey, { pepper = '', includePlainFallback = false } = {}) {
  const normalizedKey = normalizeKey(apiKey);
  const normalizedPepper = typeof pepper === 'string' ? pepper : '';
  const candidates = [];
  const primaryVariant = normalizedPepper ? 'peppered' : 'plain';
  const primaryHash = sha256Hex(`${normalizedKey}${normalizedPepper}`);

  candidates.push({
    hash: primaryHash,
    variant: primaryVariant
  });

  if (includePlainFallback) {
    const plainHash = sha256Hex(normalizedKey);
    if (plainHash !== primaryHash) {
      candidates.push({
        hash: plainHash,
        variant: 'plain'
      });
    }
  }

  return candidates;
}
