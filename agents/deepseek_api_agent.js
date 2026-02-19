import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { gatherContext, REPO_ROOT } from './lib/deepseek_context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultConfig = {
  port: Number(process.env.PORT || 5055),
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  stateDir: path.resolve(REPO_ROOT, 'agents', 'state', 'deepseek'),
  retentionLimit: Number(process.env.DEEPSEEK_RETENTION || 100)
};

const historySchema = z.array(
  z.object({
    role: z.string(),
    content: z.string()
  })
);

const chatRequestSchema = z.object({
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  history: historySchema.optional().default([]),
  includeFiles: z.array(z.string()).optional().default([]),
  listFiles: z.number().int().positive().max(500).optional(),
  searches: z.array(z.string()).optional().default([]),
  maxNewTokens: z.number().int().min(16).max(4096).optional().default(1024),
  topP: z.number().min(0.05).max(1).optional().default(0.9),
  topK: z.number().int().min(1).max(2048).optional().default(50),
  repetitionPenalty: z.number().min(1).max(2).optional().default(1.05),
  stream: z.boolean().optional().default(false),
  prefetchedContext: z.string().optional()
});

async function ensureDir(dirPath) {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

async function saveTranscript(stateDir, retentionLimit, transcript) {
  await ensureDir(stateDir);
  const filePath = path.join(stateDir, `${transcript.taskId}.json`);
  await fsPromises.writeFile(filePath, JSON.stringify(transcript, null, 2), 'utf8');
  await pruneTranscripts(stateDir, retentionLimit);
}

async function pruneTranscripts(stateDir, retentionLimit) {
  if (!Number.isFinite(retentionLimit) || retentionLimit <= 0) {
    return;
  }
  const entries = await fsPromises.readdir(stateDir);
  const jsonFiles = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(stateDir, file);
    const stats = await fsPromises.stat(fullPath);
    jsonFiles.push({ file: fullPath, mtime: stats.mtimeMs });
  }
  if (jsonFiles.length <= retentionLimit) {
    return;
  }
  jsonFiles.sort((a, b) => a.mtime - b.mtime);
  const excess = jsonFiles.length - retentionLimit;
  for (let i = 0; i < excess; i += 1) {
    await fsPromises.unlink(jsonFiles[i].file).catch(() => {});
  }
}

async function callDeepseek(apiConfig, payload, contextBlock) {
  if (!apiConfig.apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured.');
  }
  const base = apiConfig.baseUrl.endsWith('/') ? apiConfig.baseUrl : `${apiConfig.baseUrl}/`;
  const url = new URL('chat/completions', base).toString();
  const messages = [];
  if (payload.systemPrompt) {
    messages.push({ role: 'system', content: payload.systemPrompt });
  }
  for (const entry of payload.history) {
    messages.push({ role: entry.role, content: entry.content });
  }
  const userContent = contextBlock
    ? `Context from repository:\n${contextBlock}\n\nUser Request:\n${payload.prompt}`
    : payload.prompt;
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: apiConfig.model,
    messages,
    max_tokens: payload.maxNewTokens,
    top_p: payload.topP,
    top_k: payload.topK,
    repetition_penalty: payload.repetitionPenalty,
    stream: false
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepseek API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage ?? null;
  return { content, usage, raw: data };
}

export function buildDeepseekServer(customConfig = {}) {
  const config = { ...defaultConfig, ...customConfig };
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', async (req, res) => {
    try {
      await ensureDir(config.stateDir);
    } catch (error) {
      return res.status(500).json({ ok: false, error: `state_dir_error: ${error.message}` });
    }
    if (!config.apiKey) {
      return res.status(500).json({ ok: false, error: 'missing_api_key' });
    }
    return res.json({ ok: true, model: config.model });
  });

  app.post('/chat', async (req, res) => {
    let parsed;
    try {
      parsed = chatRequestSchema.parse(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: 'invalid_request', details: error.issues ?? error.message });
    }

    try {
      const context =
        parsed.prefetchedContext ??
        (await gatherContext({
          includeFiles: parsed.includeFiles,
          listLimit: parsed.listFiles,
          searches: parsed.searches
        }));
      const deepseekResult = await callDeepseek(config, parsed, context);
      const taskId = crypto.randomUUID();
      const transcript = {
        taskId,
        timestamp: new Date().toISOString(),
        prompt: parsed.prompt,
        systemPrompt: parsed.systemPrompt,
        history: parsed.history,
        context,
        response: deepseekResult.content,
        usage: deepseekResult.usage,
        model: config.model
      };
      await saveTranscript(config.stateDir, config.retentionLimit, transcript);
      return res.json({
        taskId,
        response: deepseekResult.content,
        usage: deepseekResult.usage,
        model: config.model
      });
    } catch (error) {
      return res.status(500).json({ error: 'deepseek_failed', message: error.message });
    }
  });

  app.get('/tasks/:id', async (req, res) => {
    const filePath = path.join(config.stateDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'not_found' });
    }
    try {
      const data = await fsPromises.readFile(filePath, 'utf8');
      return res.json(JSON.parse(data));
    } catch (error) {
      return res.status(500).json({ error: 'read_failed', message: error.message });
    }
  });

  return { app, config };
}

const modulePath = fileURLToPath(import.meta.url);
const executedDirectly =
  (process.argv[1] && path.resolve(process.argv[1]) === modulePath) ||
  (process.env.pm_exec_path && path.resolve(process.env.pm_exec_path) === modulePath);

if (executedDirectly) {
  const { app, config } = buildDeepseekServer();
  app.listen(config.port, () => {
    console.log(`heysalad-deepseek-coder listening on port ${config.port}`); // eslint-disable-line no-console
  });
}
