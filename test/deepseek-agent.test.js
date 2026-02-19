import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import { buildDeepseekServer } from '../agents/deepseek_api_agent.js';

async function startMockDeepseek(responder) {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const responseBody = await responder(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responseBody));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    });
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`
      });
    });
  });
}

async function startAgent(stateDir, baseUrl, retentionLimit = 5) {
  const { app } = buildDeepseekServer({
    apiKey: 'test-key',
    baseUrl,
    model: 'deepseek-chat',
    stateDir,
    retentionLimit
  });
  await fs.mkdir(stateDir, { recursive: true });
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('chat endpoint stores transcript and returns response', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-test-'));
  const mock = await startMockDeepseek(() => ({
    choices: [{ message: { content: 'Hello from Deepseek.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }));
  const { server, port } = await startAgent(stateDir, mock.baseUrl, 3);
  t.after(() => {
    server.close();
    mock.server.close();
  });

  const response = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Say hello',
      systemPrompt: 'You are helpful',
      history: [],
      includeFiles: [],
      searches: []
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.taskId);
  assert.equal(data.response, 'Hello from Deepseek.');

  const transcriptPath = path.join(stateDir, `${data.taskId}.json`);
  const transcriptRaw = await fs.readFile(transcriptPath, 'utf8');
  const transcript = JSON.parse(transcriptRaw);
  assert.equal(transcript.response, 'Hello from Deepseek.');
});

test('transcript retention limit and task retrieval', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-test-'));
  const replies = ['First', 'Second', 'Third'];
  let callCount = 0;
  const mock = await startMockDeepseek(() => {
    const content = replies[callCount] || 'Fallback';
    callCount += 1;
    return { choices: [{ message: { content } }], usage: null };
  });
  const { server, port } = await startAgent(stateDir, mock.baseUrl, 2);
  t.after(() => {
    server.close();
    mock.server.close();
  });

  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const resp = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `Task ${i}`, history: [] })
    });
    const json = await resp.json();
    ids.push(json.taskId);
  }

  const files = (await fs.readdir(stateDir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 2);

  const lastId = ids.at(-1);
  const taskResp = await fetch(`http://127.0.0.1:${port}/tasks/${lastId}`);
  assert.equal(taskResp.status, 200);
  const taskData = await taskResp.json();
  assert.equal(taskData.prompt, 'Task 2');
});

test('healthz reports missing API key', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-test-'));
  const { app } = buildDeepseekServer({
    apiKey: '',
    baseUrl: 'http://127.0.0.1:9999/v1',
    stateDir
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 500);
});
