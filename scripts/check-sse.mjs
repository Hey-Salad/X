if (typeof fetch !== 'function') {
  console.error('Node 18+ is required so that fetch is available globally.');
  process.exit(1);
}

const BASE_HOST = process.env.MCP_HOST || '127.0.0.1';
const BASE_PORT = process.env.PORT || '4141';
const BASE_URL = process.env.MCP_BASE_URL || `http://${BASE_HOST}:${BASE_PORT}`;
const PUBLIC_BASE_URL = 'https://tunnel.to.secure.mcp.heysalad.app';

const DEMO_TOKEN = process.env.MCP_CHATGPT_DEMO_TOKEN;

if (!DEMO_TOKEN) {
  console.error('MCP_CHATGPT_DEMO_TOKEN is required but missing from the environment.');
  process.exit(1);
}

const SSE_HEADERS = {
  Authorization: `Bearer ${DEMO_TOKEN}`,
  Origin: 'https://chat.openai.com',
  Accept: 'text/event-stream'
};

const CHECKS = [
  {
    name: 'LOCAL /healthz',
    url: `${BASE_URL}/healthz`,
    headers: {}
  },
  {
    name: 'LOCAL /sse',
    url: `${BASE_URL}/sse`,
    headers: SSE_HEADERS
  },
  {
    name: 'PUBLIC /healthz',
    url: `${PUBLIC_BASE_URL}/healthz`,
    headers: {}
  },
  {
    name: 'PUBLIC /sse',
    url: `${PUBLIC_BASE_URL}/sse`,
    headers: SSE_HEADERS
  }
];

async function runCheck(check) {
  try {
    const response = await fetch(check.url, {
      method: 'GET',
      headers: check.headers,
      redirect: 'manual'
    });
    const contentType = response.headers.get('content-type') || 'n/a';
    console.log(
      `[OK] ${check.name} -> ${response.status}` +
        (check.name.includes('/sse') ? `, content-type: ${contentType}` : '')
    );
  } catch (error) {
    console.log(`[FAIL] ${check.name} -> ${error.message}`);
  }
}

async function main() {
  for (const check of CHECKS) {
    await runCheck(check);
  }
}

main().catch(error => {
  console.error('check-sse script failed:', error.message);
  process.exit(1);
});
