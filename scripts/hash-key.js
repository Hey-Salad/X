#!/usr/bin/env node

import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashKey as hashKeyDigest } from '../src/key-utils.js';

const resolvedPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isCli = invokedPath === resolvedPath;

export function computeHashValues(apiKey, pepper = '') {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('API key is required to compute hashes.');
  }
  const normalizedKey = apiKey.trim();
  const normalizedPepper = typeof pepper === 'string' ? pepper : '';
  const pepperedHash = hashKeyDigest(normalizedKey, normalizedPepper);
  const plainHash = hashKeyDigest(normalizedKey, '');
  return {
    key: normalizedKey,
    pepper: normalizedPepper,
    plain: plainHash,
    peppered: normalizedPepper ? pepperedHash : plainHash
  };
}

function usage() {
  console.log(`Usage:
  node scripts/hash-key.js [options] <api-key>

Options:
  --pepper <value>    Override pepper (defaults to API_KEY_PEPPER env)
  --stdin             Read the key from stdin (safer than passing an arg)
  --json              Emit JSON instead of human-readable text
  -h, --help          Show this message
`);
}

function parseArgs(rawArgs) {
  const options = {
    pepper: process.env.API_KEY_PEPPER || '',
    json: false,
    stdin: false,
    help: false,
    key: null
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (token === '--pepper' || token === '-p') {
      if (i + 1 >= rawArgs.length) {
        throw new Error('--pepper requires a value.');
      }
      options.pepper = rawArgs[i + 1];
      i += 1;
    } else if (token === '--stdin') {
      options.stdin = true;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--no-pepper') {
      options.pepper = '';
    } else if (!token.startsWith('-') && !options.key) {
      options.key = token;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function readKeyFromStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    process.exit(0);
  }

  let key = args.key;
  if (!key && args.stdin) {
    key = await readKeyFromStdin();
  }

  if (!key) {
    console.error('Error: API key is required. Provide it as an argument or via --stdin.');
    usage();
    process.exit(1);
  }

  let hashPair;
  try {
    hashPair = computeHashValues(key, args.pepper);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const payload = {
    keyPrefix: hashPair.key.slice(0, 6),
    keyLength: hashPair.key.length,
    pepperLength: hashPair.pepper.length,
    sha256: hashPair.plain,
    sha256WithPepper: hashPair.peppered,
    pepperApplied: hashPair.pepper.length > 0
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Input key prefix: ${payload.keyPrefix || '<n/a>'} (len=${payload.keyLength})`);
  if (hashPair.pepper.length > 0) {
    console.log(`Using pepper (len=${hashPair.pepper.length}) from ${args.pepper ? 'argument' : 'API_KEY_PEPPER env'}.`);
  } else {
    console.log('No pepper applied (API_KEY_PEPPER empty).');
  }
  console.log(`sha256(key)             = ${payload.sha256}`);
  console.log(`sha256(key + pepper)   = ${payload.sha256WithPepper}`);
}

if (isCli) {
  main().catch(error => {
    console.error('Failed to compute hashes:', error.message);
    process.exit(1);
  });
}
