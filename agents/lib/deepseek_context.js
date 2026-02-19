import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_MAX_FILE_CHARS = 4000;
export const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.mypy_cache']);
const SKIP_SUFFIXES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.woff', '.ttf', '.otf', '.mp4']);

async function walkFiles(dir, limit = Infinity) {
  const stack = [dir];
  const files = [];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const relPath = path.relative(REPO_ROOT, fullPath);
      if (relPath.split(path.sep).some(part => IGNORE_DIRS.has(part))) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_SUFFIXES.has(ext)) {
        continue;
      }
      files.push(fullPath);
      if (files.length >= limit) {
        return files;
      }
    }
  }

  return files;
}

export async function listRepoFiles(limit = 40) {
  const files = await walkFiles(REPO_ROOT, limit);
  if (!files.length) {
    return 'No files discovered.';
  }
  return files
    .map(fullPath => path.relative(REPO_ROOT, fullPath))
    .join('\n');
}

export async function readRepoFile(relativePath, maxChars = DEFAULT_MAX_FILE_CHARS) {
  const targetPath = path.resolve(REPO_ROOT, relativePath);
  if (!targetPath.startsWith(REPO_ROOT)) {
    throw new Error('Only files inside the repository may be read.');
  }
  const data = await fs.readFile(targetPath, 'utf8');
  if (data.length > maxChars) {
    return `${data.slice(0, maxChars)}\n\n… (truncated to ${maxChars} characters)`;
  }
  return data;
}

export async function searchRepo(keyword, maxHits = 20) {
  const needle = keyword.toLowerCase();
  const files = await walkFiles(REPO_ROOT);
  const matches = [];
  for (const filePath of files) {
    if (matches.length >= maxHits) {
      break;
    }
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const index = lower.indexOf(needle);
    if (index === -1) continue;
    const rel = path.relative(REPO_ROOT, filePath);
    const lineNumber = content.slice(0, index).split('\n').length;
    const line = content.split('\n')[lineNumber - 1]?.trim() ?? '';
    matches.push(`${rel}:${lineNumber}: ${line}`);
  }
  if (!matches.length) {
    return `No matches for "${keyword}".`;
  }
  return `Matches:\n${matches.join('\n')}`;
}

export async function gatherContext({ includeFiles = [], listLimit, searches = [] }) {
  const blocks = [];
  for (const relPath of includeFiles) {
    try {
      const contents = await readRepoFile(relPath);
      blocks.push(`File \`${relPath}\` contents:\n\`\`\`\n${contents}\n\`\`\``);
    } catch (error) {
      blocks.push(`Failed to read \`${relPath}\`: ${error.message}`);
    }
  }
  if (typeof listLimit === 'number' && listLimit > 0) {
    try {
      const listing = await listRepoFiles(listLimit);
      blocks.push(`File inventory (first ${listLimit} entries):\n${listing}`);
    } catch (error) {
      blocks.push(`Failed to list repo files: ${error.message}`);
    }
  }
  for (const keyword of searches) {
    try {
      const results = await searchRepo(keyword);
      blocks.push(`Search results for "${keyword}":\n${results}`);
    } catch (error) {
      blocks.push(`Search for "${keyword}" failed: ${error.message}`);
    }
  }
  return blocks.join('\n\n');
}
