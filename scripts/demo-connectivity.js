import fs from 'fs';
import path from 'path';

const ENV_FILE = path.join(process.cwd(), '.env.demo');

function parseEnv(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .reduce((acc, line) => {
      const index = line.indexOf('=');
      if (index < 0) {
        return acc;
      }
      const key = line.slice(0, index);
      const value = line.slice(index + 1);
      acc[key] = value;
      return acc;
    }, {});
}

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Missing ${ENV_FILE}; create it with your demo secrets first.`);
  }
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  return parseEnv(raw);
}

async function checkEndpoint(name, url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || 'n/a';
  console.log(`${name}: ${response.status} (${contentType})`);
  if (!response.ok) {
    throw new Error(`${name} returned ${response.status}`);
  }
  if (name === 'sse' && response.body?.cancel) {
    response.body.cancel();
  } else if (name === 'sse' && typeof response.body?.destroy === 'function') {
    response.body.destroy();
  }
  return response;
}

async function main() {
  const env = loadEnv();
  const token = env.MCP_CHATGPT_DEMO_TOKEN;
  if (!token) {
    throw new Error('MCP_CHATGPT_DEMO_TOKEN is missing from .env.demo');
  }

  const host = env.MCP_HOST || '127.0.0.1';
  const port = env.PORT || '4141';
  const baseUrl = env.MCP_BASE_URL || `http://${host}:${port}`;

  console.log(`Using MCP endpoint base: ${baseUrl}`);
  console.log(`MCP_CHATGPT_DEMO_TOKEN=${token}`);

  await checkEndpoint('healthz', `${baseUrl}/healthz`);
  const sseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'text/event-stream'
  };
  sseHeaders.Origin = env.MCP_CLIENT_ORIGIN || 'https://mcp.heysalad.app';
  await checkEndpoint('sse', `${baseUrl}/sse`, {
    headers: sseHeaders
  });

  console.log('Demo connectivity check succeeded.');
}

main().catch(error => {
  console.error('Demo connectivity check failed:', error.message);
  process.exit(1);
});
