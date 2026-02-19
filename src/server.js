import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { DeviceGenerator, validateIMEI as validateImeiHelper, DEFAULT_DEVICE_TYPES } from './device-generator.js';
import { buildKeyHashCandidates } from './key-utils.js';
import { OtpService } from './otp-service.js';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function parseEnvContent(raw) {
  return raw
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

function applyDemoEnv() {
  const demoPath = path.join(process.cwd(), '.env.demo');
  if (!fs.existsSync(demoPath)) {
    return;
  }
  const content = fs.readFileSync(demoPath, 'utf8');
  const entries = parseEnvContent(content);
  Object.entries(entries).forEach(([key, value]) => {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

applyDemoEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY_PEPPER = process.env.API_KEY_PEPPER || '';
const ALLOW_PLAIN_KEY_HASH_FALLBACK = process.env.MCP_ALLOW_PLAIN_KEY_HASH_FALLBACK !== 'false';
const SUPABASE_TABLE = process.env.SUPABASE_MCP_TABLE || 'mcp_keys';
const SCOPE_PUBLIC = 'public';
const SCOPE_INTERNAL = 'internal';
const PUBLIC_SCOPE_ALIASES = new Set(['public', 'driver', 'kitchen', 'courier', 'field', 'laura-mobile']);
const INTERNAL_SCOPE_ALIASES = new Set(['internal', 'finance', 'approver', 'logistics', 'admin', 'backoffice', 'hr']);
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SHOULD_INCLUDE_PLAIN_HASH_FALLBACK = ALLOW_PLAIN_KEY_HASH_FALLBACK && API_KEY_PEPPER.length > 0;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY ? process.env.SENDGRID_API_KEY.trim() : '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL ? process.env.SENDGRID_FROM_EMAIL.trim() : '';
const SENDGRID_FROM_NAME =
  process.env.SENDGRID_FROM_NAME && process.env.SENDGRID_FROM_NAME.trim().length > 0
    ? process.env.SENDGRID_FROM_NAME.trim()
    : 'HeySalad MCP';
const OTP_EMAIL_SUBJECT = process.env.MCP_OTP_EMAIL_SUBJECT || 'Your HeySalad MCP login code';
const OTP_ALLOWED_EMAILS = parseEmailList(process.env.MCP_OTP_ALLOWED_EMAILS || process.env.ADMIN_EMAILS || '');
const OTP_ALLOWED_EMAIL_SET = new Set(OTP_ALLOWED_EMAILS);
const OTP_TTL_MS = Number(process.env.MCP_OTP_TTL_MS || 10 * 60 * 1000);
const OTP_RESEND_INTERVAL_MS = Number(process.env.MCP_OTP_RESEND_INTERVAL_MS || 60 * 1000);
const OTP_CODE_LENGTH = Number(process.env.MCP_OTP_CODE_LENGTH || 6);
const OTP_SCOPE_RAW = (process.env.MCP_OTP_SCOPE || 'internal').trim().toLowerCase();
const OTP_GRANTED_SCOPE = OTP_SCOPE_RAW === SCOPE_PUBLIC ? SCOPE_PUBLIC : SCOPE_INTERNAL;
const OTP_SENDGRID_AVAILABLE = Boolean(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL);
const OTP_ENABLED = OTP_SENDGRID_AVAILABLE && OTP_ALLOWED_EMAILS.length > 0;

if (OTP_SENDGRID_AVAILABLE) {
  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log(`[heysalad-mcp] SendGrid configured for OTP emails (from ${SENDGRID_FROM_EMAIL}).`);
  } catch (error) {
    console.error('[heysalad-mcp] Failed to configure SendGrid API key:', error.message);
  }
} else if (process.env.SENDGRID_API_KEY || process.env.SENDGRID_FROM_EMAIL) {
  console.warn('[heysalad-mcp] SendGrid env vars are incomplete; OTP emails are disabled.');
}

const config = loadConfig();
const app = express();
const otpService = OTP_ENABLED
  ? new OtpService({
      ttlMs: OTP_TTL_MS,
      resendIntervalMs: OTP_RESEND_INTERVAL_MS,
      codeLength: OTP_CODE_LENGTH,
      scope: OTP_GRANTED_SCOPE
    })
  : null;
if (OTP_ENABLED) {
  console.log(
    `[heysalad-mcp] OTP login enabled for ${OTP_ALLOWED_EMAILS.length} email(s); scope=${OTP_GRANTED_SCOPE}.`
  );
}
const rawDemoToken = !SUPABASE_CONFIGURED ? process.env.MCP_CHATGPT_DEMO_TOKEN : null;
const DEMO_MCP_TOKEN =
  typeof rawDemoToken === 'string' && rawDemoToken.trim().length > 0 ? rawDemoToken.trim() : null;

if (DEMO_MCP_TOKEN) {
  console.log(
    `[heysalad-mcp] Demo token auth enabled (MCP_CHATGPT_DEMO_TOKEN present, len=${DEMO_MCP_TOKEN.length})`
  );
} else if (process.env.MCP_CHATGPT_DEMO_TOKEN && SUPABASE_CONFIGURED) {
  console.log('[heysalad-mcp] Supabase auth detected; ignoring MCP_CHATGPT_DEMO_TOKEN.');
}

app.use(express.json({ limit: '2mb' }));
app.use(
  express.urlencoded({
    extended: false,
    limit: '1mb'
  })
);
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

function buildHealthUrl(service, overrideUrl) {
  try {
    if (overrideUrl) {
      return new URL(overrideUrl);
    }
    const base = new URL(service.baseUrl);
    return new URL(service.healthPath || '/', base);
  } catch (error) {
    throw new Error(`Invalid URL for ${service.id}: ${error.message}`);
  }
}

async function fetchServiceHealth(service, overrideUrl) {
  let url;
  try {
    url = buildHealthUrl(service, overrideUrl);
  } catch (error) {
    return {
      serviceId: service.id,
      url: overrideUrl || service.baseUrl,
      ok: false,
      status: null,
      statusText: 'invalid-url',
      durationMs: 0,
      error: error.message
    };
  }
  const controller = new AbortController();
  const timeoutMs = service.timeoutMs || 5000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain;q=0.8'
      }
    });
    const rawBody = await response.text();
    const durationMs = Date.now() - started;
    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    return {
      serviceId: service.id,
      url: url.toString(),
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      body
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    return {
      serviceId: service.id,
      url: url.toString(),
      ok: false,
      status: null,
      statusText: error.name,
      durationMs,
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildServiceOperationUrl(service, path) {
  if (!path) {
    throw new Error(`Service ${service.id} does not define the requested operation path.`);
  }
  try {
    const isAbsolute = /^https?:\/\//i.test(path);
    if (isAbsolute) {
      return new URL(path);
    }
    const base = new URL(service.baseUrl);
    return new URL(path, base);
  } catch (error) {
    throw new Error(`Invalid operation URL for ${service.id}: ${error.message}`);
  }
}

async function fetchOperationPayload(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json, text/plain;q=0.8',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body
  });

  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    body = rawBody;
  }

  return { response, body };
}

function parseOriginList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => entry.toLowerCase());
}

function parseEmailList(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

const DEFAULT_LOCAL_ORIGINS = [
  'http://127.0.0.1:4141',
  'http://localhost:4141',
  'https://chat.openai.com',
  'https://chatgpt.com'
];

function normalizeOrigin(value) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function buildAllowedOriginList() {
  const configOrigins = (config.allowedOrigins || []).map(normalizeOrigin);
  const envOrigins = parseOriginList(process.env.MCP_ALLOWED_ORIGINS).map(normalizeOrigin);
  const baseOrigins = DEFAULT_LOCAL_ORIGINS.map(normalizeOrigin);
  const merged = [...baseOrigins, ...configOrigins, ...envOrigins];
  const uniqueOrigins = [...new Set(merged)];
  return uniqueOrigins;
}

const ALLOWED_ORIGINS = buildAllowedOriginList();
const allowedOriginSet = new Set(ALLOWED_ORIGINS);
const allowedOriginsDisplay = ALLOWED_ORIGINS.join(', ') || '<none>';
console.log(`[heysalad-mcp] Allowed origins: ${allowedOriginsDisplay}`);

function normalizeOtpEmail(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function isEmailAllowedForOtp(email) {
  if (!email) {
    return false;
  }
  return OTP_ALLOWED_EMAIL_SET.has(email);
}

async function sendOtpLoginCode(email, code, { client } = {}) {
  if (!OTP_ENABLED || !otpService || !OTP_SENDGRID_AVAILABLE) {
    throw new Error('OTP email delivery is not enabled.');
  }
  const recipient = normalizeOtpEmail(email);
  if (!recipient) {
    throw new Error('Recipient email is required.');
  }
  const ttlMinutes = Math.max(1, Math.round(OTP_TTL_MS / 60000));
  const clientLabel = client?.displayName || client?.clientId;
  const contextText = clientLabel ? ` for "${clientLabel}"` : '';
  const text = `Your HeySalad MCP login code${contextText} is ${code}. It expires in ${ttlMinutes} minute(s).`;
  const htmlBody = `
    <p>Use this one-time login code${clientLabel ? ` for <strong>${htmlEscape(clientLabel)}</strong>` : ''} within the next ${ttlMinutes} minute(s):</p>
    <p style="font-size:28px;letter-spacing:6px;font-weight:600;margin:24px 0;">${code}</p>
    <p>If you did not request this code you can safely ignore this email.</p>
  `;
  await sgMail.send({
    to: recipient,
    from: {
      email: SENDGRID_FROM_EMAIL,
      name: SENDGRID_FROM_NAME
    },
    subject: OTP_EMAIL_SUBJECT,
    text,
    html: `<!doctype html><html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color:#111;">${htmlBody}</body></html>`
  });
  console.log(`[heysalad-mcp] Sent OTP login code to ${recipient}${clientLabel ? ` for ${clientLabel}` : ''}.`);
}

const DEFAULT_OAUTH_REDIRECT_ORIGINS = ['https://chat.openai.com', 'https://chatgpt.com'];
const DEFAULT_OAUTH_CLIENT_ID = process.env.MCP_OAUTH_CLIENT_ID || 'heysalad-chatgpt';
const DEFAULT_OAUTH_CLIENT_NAME = process.env.MCP_OAUTH_CLIENT_NAME || 'ChatGPT';
const DEFAULT_OAUTH_CLIENT_SECRET =
  process.env.MCP_OAUTH_CLIENT_SECRET && process.env.MCP_OAUTH_CLIENT_SECRET.trim().length > 0
    ? process.env.MCP_OAUTH_CLIENT_SECRET.trim()
    : null;
const DEFAULT_OAUTH_REDIRECT_LIST = (() => {
  const fromEnv = parseOriginList(process.env.MCP_OAUTH_REDIRECT_ORIGINS);
  const fallback = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_OAUTH_REDIRECT_ORIGINS;
  return [...new Set(fallback.map(normalizeOrigin))];
})();
const OAUTH_CODE_TTL_MS = Number(process.env.MCP_OAUTH_CODE_TTL_MS || 5 * 60 * 1000);
const OAUTH_ACCESS_TOKEN_TTL_MS = Number(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_MS || 60 * 60 * 1000);
const OAUTH_REFRESH_TOKEN_TTL_MS = Number(process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const OAUTH_ISSUER =
  process.env.MCP_OAUTH_ISSUER ||
  (process.env.MCP_PUBLIC_BASE_URL ? process.env.MCP_PUBLIC_BASE_URL.replace(/\/$/, '') : 'https://mcp.heysalad.app');

function normalizeClientEntry(entry = {}) {
  const clientId = String(entry.clientId || '').trim();
  if (!clientId) {
    return null;
  }
  const redirectOrigins = entry.redirectOrigins && entry.redirectOrigins.length > 0 ? entry.redirectOrigins : null;
  const normalizedOrigins = (redirectOrigins || DEFAULT_OAUTH_REDIRECT_LIST).map(normalizeOrigin);
  return {
    clientId,
    clientSecret: typeof entry.clientSecret === 'string' && entry.clientSecret.trim().length > 0 ? entry.clientSecret : null,
    displayName: entry.displayName || clientId,
    description: entry.description,
    redirectOrigins: [...new Set(normalizedOrigins)]
  };
}

function loadOAuthClients() {
  const raw = process.env.MCP_OAUTH_CLIENTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeClientEntry).filter(Boolean);
      }
    } catch (error) {
      console.warn('[heysalad-mcp] Failed to parse MCP_OAUTH_CLIENTS:', error.message);
    }
  }

  const single = normalizeClientEntry({
    clientId: DEFAULT_OAUTH_CLIENT_ID,
    clientSecret: DEFAULT_OAUTH_CLIENT_SECRET,
    displayName: DEFAULT_OAUTH_CLIENT_NAME,
    redirectOrigins: DEFAULT_OAUTH_REDIRECT_LIST
  });

  return single ? [single] : [];
}

const oauthClients = loadOAuthClients();
const oauthClientIndex = new Map(oauthClients.map(client => [client.clientId, client]));
if (!oauthClients.length) {
  console.warn('[heysalad-mcp] WARNING: No OAuth clients configured; OAuth endpoints will reject all requests.');
} else {
  console.log(
    `[heysalad-mcp] OAuth clients enabled for: ${oauthClients
      .map(client => `${client.clientId} (${client.redirectOrigins.join(', ')})`)
      .join('; ')}`
  );
}

const oauthAuthorizationCodes = new Map();
const oauthAccessTokens = new Map();
const oauthRefreshTokens = new Map();

function getOAuthClient(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    return null;
  }
  return oauthClientIndex.get(clientId) || null;
}

function isRedirectAllowedForClient(client, redirectUri) {
  if (!client || !redirectUri) {
    return false;
  }
  try {
    const origin = new URL(redirectUri).origin.toLowerCase();
    return client.redirectOrigins.includes(origin);
  } catch {
    return false;
  }
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateOpaqueToken(prefix) {
  const raw = base64UrlEncode(crypto.randomBytes(32));
  return `${prefix || 'hs_'}${raw}`;
}

function createAuthorizationCode(payload) {
  const code = generateOpaqueToken('hscode_');
  oauthAuthorizationCodes.set(code, {
    ...payload,
    createdAt: Date.now(),
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS
  });
  return code;
}

function consumeAuthorizationCode(code) {
  if (!code) {
    return null;
  }
  const entry = oauthAuthorizationCodes.get(code);
  if (!entry) {
    return null;
  }
  oauthAuthorizationCodes.delete(code);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry;
}

function getValidOAuthAccessToken(token) {
  if (!token) {
    return null;
  }
  const entry = oauthAccessTokens.get(token);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    oauthAccessTokens.delete(token);
    return null;
  }
  return entry;
}

function getValidOAuthRefreshToken(token) {
  if (!token) {
    return null;
  }
  const entry = oauthRefreshTokens.get(token);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    oauthRefreshTokens.delete(token);
    return null;
  }
  return entry;
}

function issueOAuthTokenPair({ identity, scope, clientId, scopeResponse }) {
  const normalizedIdentity = { ...identity, scope };
  const normalizedScopeResponse = normalizeScopeResponse(scopeResponse, scope);
  const now = Date.now();
  const accessToken = generateOpaqueToken('hsat_');
  const refreshToken = generateOpaqueToken('hsrt_');
  oauthAccessTokens.set(accessToken, {
    identity: normalizedIdentity,
    scope,
    scopeResponse: normalizedScopeResponse,
    clientId,
    expiresAt: now + OAUTH_ACCESS_TOKEN_TTL_MS
  });
  oauthRefreshTokens.set(refreshToken, {
    identity: normalizedIdentity,
    scope,
    scopeResponse: normalizedScopeResponse,
    clientId,
    expiresAt: now + OAUTH_REFRESH_TOKEN_TTL_MS
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(OAUTH_ACCESS_TOKEN_TTL_MS / 1000)
  };
}

function verifyPkce(codeVerifier, expectedChallenge, method = 'S256') {
  if (!expectedChallenge) {
    return false;
  }
  if (!codeVerifier) {
    return false;
  }
  if (method.toUpperCase() === 'PLAIN') {
    return codeVerifier === expectedChallenge;
  }
  if (method.toUpperCase() !== 'S256') {
    return false;
  }
  const computed = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  return computed === expectedChallenge;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuthorizeFormPage({
  client,
  redirectUri,
  state,
  scope,
  codeChallenge,
  codeChallengeMethod,
  error,
  notice,
  otpEnabled = false,
  otpEmailValue = '',
  allowedOtpEmails = []
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Authorize ${htmlEscape(client?.displayName || client?.clientId || 'client')}</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; margin: 0; padding: 0; color: #111; }
      main { max-width: 540px; margin: 5vh auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 10px 30px rgba(15,19,36,0.08); }
      h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
      p { margin-top: 0.4rem; color: #333; }
      .app { font-weight: 600; }
      label { display: block; font-weight: 600; margin-top: 1rem; }
      input { width: 100%; padding: 12px; font-size: 1rem; border: 1px solid #c8ccd8; border-radius: 8px; margin-top: 0.35rem; box-sizing: border-box; }
      button { width: 100%; margin-top: 1.25rem; padding: 12px; font-size: 1rem; border: none; border-radius: 999px; background: #121a2f; color: #fff; cursor: pointer; }
      button.secondary { background: #e4e6ed; color: #111; }
      button.secondary:hover { background: #d5d8e2; }
      button:hover { background: #0d1426; }
      .error, .notice { margin-top: 1rem; padding: 12px; border-radius: 8px; }
      .error { background: #ffe5e5; color: #a40000; }
      .notice { background: #e5f5ff; color: #064a72; }
      .note { font-size: 0.9rem; color: #555; margin-top: 0.75rem; }
      .meta { font-size: 0.95rem; color: #444; margin-top: 1rem; line-height: 1.5; }
      .card { border: 1px solid #e2e6ef; border-radius: 12px; padding: 18px 20px; margin-top: 1.5rem; background: #fafbff; }
      .card h2 { margin: 0 0 0.4rem 0; font-size: 1.1rem; }
      .actions { margin-top: 2rem; }
      a { color: #0d47a1; }
      .allowed-list { font-size: 0.85rem; color: #555; margin-top: 0.4rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect <span class="app">${htmlEscape(client?.displayName || client?.clientId || 'client')}</span></h1>
      <p>This step proves to HeySalad MCP that you authorize this connector.</p>
      <div class="meta">
        <div><strong>Redirect to:</strong> ${htmlEscape(redirectUri || '')}</div>
        ${state ? `<div><strong>State:</strong> ${htmlEscape(state)}</div>` : ''}
      </div>
      ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
      ${notice ? `<div class="notice">${htmlEscape(notice)}</div>` : ''}
      <form method="post">
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value="${htmlEscape(client?.clientId || '')}" />
        <input type="hidden" name="redirect_uri" value="${htmlEscape(redirectUri || '')}" />
        ${state ? `<input type="hidden" name="state" value="${htmlEscape(state)}" />` : ''}
        <input type="hidden" name="code_challenge" value="${htmlEscape(codeChallenge || '')}" />
        <input type="hidden" name="code_challenge_method" value="${htmlEscape(codeChallengeMethod || '')}" />
        ${scope ? `<input type="hidden" name="scope" value="${htmlEscape(scope)}" />` : ''}
        <section class="card">
          <h2>Option A · Paste API key</h2>
          <label for="api_key">HeySalad MCP API key</label>
          <input id="api_key" name="api_key" type="password" autocomplete="off" placeholder="sk-..." />
          <p class="note">Need a key? Visit <a href="https://developer.heysalad.app/" target="_blank" rel="noopener">developer.heysalad.app</a> while on VPN/SSO and copy it after approval.</p>
        </section>
        ${
          otpEnabled
            ? `<section class="card">
          <h2>Option B · Email login code</h2>
          <p class="note">We can send a one-time code to an approved admin inbox if you cannot reach the developer portal.</p>
          ${
            allowedOtpEmails.length
              ? `<p class="allowed-list">Approved emails: ${allowedOtpEmails.map(htmlEscape).join(', ')}</p>`
              : ''
          }
          <label for="otp_email">Approved email</label>
          <input id="otp_email" name="otp_email" type="email" autocomplete="email" value="${htmlEscape(
            otpEmailValue || ''
          )}" placeholder="you@heysalad.io" />
          <button type="submit" name="action" value="send_code" class="secondary" formnovalidate>Send login code</button>
          <label for="otp_code">Login code</label>
          <input id="otp_code" name="otp_code" type="text" inputmode="numeric" pattern="[0-9\\s-]*" placeholder="123456" />
        </section>`
            : ''
        }
        <div class="actions">
          <button type="submit" name="action" value="authorize">Authorize</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

function extractScopeToken(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const tokens = raw
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (!tokens.length) {
    return null;
  }
  const internalToken = tokens.find(token => normalizeScopeValue(token) === SCOPE_INTERNAL);
  if (internalToken) {
    return internalToken;
  }
  return tokens[0];
}

function normalizeScopeResponse(value, fallback) {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return fallback;
}

function resolveGrantedScope(requestedScope, identityScope) {
  if (!identityScope) {
    return null;
  }
  if (!requestedScope) {
    return identityScope;
  }
  const normalizedRequest = normalizeScopeValue(requestedScope);
  if (normalizedRequest === SCOPE_INTERNAL && identityScope !== SCOPE_INTERNAL) {
    return null;
  }
  return normalizedRequest;
}

function buildOAuthMetadata() {
  const issuer = OAUTH_ISSUER.replace(/\/$/, '');
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE_PUBLIC, SCOPE_INTERNAL]
  };
}

const transportOptions = createTransportOptions(config);

function createTransportOptions(mcpConfig) {
  return {
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection:
      (mcpConfig.allowedHosts && mcpConfig.allowedHosts.length > 0) ||
      ALLOWED_ORIGINS.length > 0,
    allowedHosts:
      mcpConfig.allowedHosts && mcpConfig.allowedHosts.length > 0 ? mcpConfig.allowedHosts : undefined,
    allowedOrigins: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : undefined
  };
}

function logOriginDecision(origin, allowed) {
  if (allowed) {
    console.log(
      `[heysalad-mcp] SSE origin allowed: ${origin} (allowed origins: ${allowedOriginsDisplay})`
    );
  } else {
    console.warn(
      `[heysalad-mcp] SSE origin REJECTED: ${origin} (allowed origins: ${allowedOriginsDisplay})`
    );
  }
}

function verifyOrigin(req, res, next) {
  const origin = req.headers.origin;
  const normalized = origin ? normalizeOrigin(origin) : null;
  if (!normalized || allowedOriginSet.has(normalized)) {
    if (origin) {
      logOriginDecision(origin, true);
    }
    return next();
  }
  logOriginDecision(origin, false);
  res.status(403).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message: `Invalid Origin header: ${origin}`
    },
    id: null
  });
}

function toSerializableService(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    baseUrl: service.baseUrl,
    healthPath: service.healthPath,
    docsUrl: service.docsUrl,
    timeoutMs: service.timeoutMs,
    requiredScope: service.requiredScope,
    operations: service.operations
  };
}

const serviceOperationsSchema = z
  .object({
    queueDepthPath: z.string().optional(),
    restartJobPath: z.string().optional(),
    restartJobMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional()
  })
  .optional();

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  baseUrl: z.string(),
  healthPath: z.string(),
  docsUrl: z.string().optional(),
  timeoutMs: z.number().optional(),
  requiredScope: z.enum([SCOPE_PUBLIC, SCOPE_INTERNAL]),
  operations: serviceOperationsSchema
});

function buildMcpContext(services) {
  const serviceIndex = new Map(services.map(service => [service.id, service]));
  const listServiceIds = (prefix = '') => {
    const needle = prefix.toLowerCase();
    return services.map(service => service.id).filter(id => id.toLowerCase().startsWith(needle));
  };

  function getService(serviceId) {
    if (!serviceId) {
      throw new Error('serviceId is required');
    }
    const service = serviceIndex.get(serviceId);
    if (!service) {
      throw new Error(`Unknown service: ${serviceId}`);
    }
    return service;
  }

  const server = new McpServer({
    name: 'heysalad-mcp',
    version: pkg.version
  });

  const serviceTemplate = new ResourceTemplate('heysalad://service/{serviceId}', {
    list: async () => ({
      resources: services.map(service => ({
        uri: `heysalad://service/${service.id}`,
        name: service.name,
        description: service.description,
        mimeType: 'application/json'
      }))
    }),
    complete: {
      serviceId: async value => listServiceIds(value || '')
    }
  });

  server.registerResource(
    'heysalad-service',
    serviceTemplate,
    {
      title: 'HeySalad Service Registry',
      description: 'Service metadata merged with live health information',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const service = getService(variables.serviceId);
      const health = await fetchServiceHealth(service);
      const payload = {
        uri: uri.href,
        checkedAt: new Date().toISOString(),
        service: toSerializableService(service),
        health
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2)
          }
        ]
      };
    }
  );

  server.registerTool(
    'list_services',
    {
      title: 'List Configured HeySalad Services',
      description: 'Return the services known to the MCP server',
      outputSchema: {
        services: z.array(serviceSchema)
      }
    },
    async () => {
      const servicesPayload = services.map(toSerializableService);
      const output = { services: servicesPayload };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2)
          }
        ],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    'check_service_health',
    {
      title: 'Check Service Health',
      description: 'Calls the configured health endpoint for a service',
      inputSchema: {
        serviceId: z
          .string()
          .describe('ID defined in services.json or environment variables'),
        urlOverride: z
          .string()
          .url()
          .optional()
          .describe('Optional absolute URL if you need to hit a one-off endpoint')
      },
      outputSchema: {
        serviceId: z.string(),
        url: z.string(),
        ok: z.boolean(),
        status: z.number().nullable(),
        statusText: z.string().nullable(),
        durationMs: z.number(),
        body: z.any().optional(),
        error: z.string().optional()
      }
    },
    async ({ serviceId, urlOverride }) => {
      const service = getService(serviceId);
      const health = await fetchServiceHealth(service, urlOverride);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(health, null, 2)
          }
        ],
        structuredContent: health
      };
    }
  );

  const serviceIdArgument = completable(
    z.string().describe('Service identifier defined in config/services.json'),
    async (value = '') => listServiceIds(value)
  );

  server.registerTool(
    'get_queue_depth',
    {
      title: 'Inspect Service Queue Depth',
      description: 'Reads the reported queue depth or rollout wave status from a service-defined endpoint.',
      inputSchema: {
        serviceId: serviceIdArgument,
        queueName: z
          .string()
          .optional()
          .describe('Optional queue identifier appended as ?queue=<name>.'),
        pathOverride: z
          .string()
          .optional()
          .describe('Absolute or relative path if you need a one-off endpoint.')
      },
      outputSchema: {
        serviceId: z.string(),
        url: z.string(),
        queueName: z.string().nullable(),
        ok: z.boolean(),
        status: z.number(),
        statusText: z.string(),
        body: z.any().optional(),
        error: z.string().optional()
      }
    },
    async ({ serviceId, queueName, pathOverride }) => {
      const service = getService(serviceId);
      const defaultPath = service.operations?.queueDepthPath;
      if (!defaultPath && !pathOverride) {
        throw new Error(
          `Service ${service.id} does not declare operations.queueDepthPath. Provide pathOverride to call a custom endpoint.`
        );
      }
      const url = buildServiceOperationUrl(service, pathOverride || defaultPath);
      if (queueName) {
        url.searchParams.set('queue', queueName);
      }
      let payload;
      try {
        const { response, body } = await fetchOperationPayload(url);
        payload = {
          serviceId,
          url: url.toString(),
          queueName: queueName || null,
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          body
        };
      } catch (error) {
        payload = {
          serviceId,
          url: url.toString(),
          queueName: queueName || null,
          ok: false,
          status: 0,
          statusText: error.name || 'error',
          error: error.message
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2)
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.registerTool(
    'restart_service_job',
    {
      title: 'Restart Service Job/Run',
      description: 'Issues a restart command to a downstream service for a stuck job, rollout, or prompt run.',
      inputSchema: {
        serviceId: serviceIdArgument,
        jobId: z.string().describe('Identifier for the job/run to restart.'),
        pathOverride: z
          .string()
          .optional()
          .describe('Absolute or relative override path if the default does not apply.'),
        methodOverride: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .optional()
          .describe('Override the HTTP verb (defaults to service config or POST).'),
        payload: z
          .record(z.any())
          .optional()
          .describe('Optional JSON body merged with the jobId.')
      },
      outputSchema: {
        serviceId: z.string(),
        url: z.string(),
        ok: z.boolean(),
        status: z.number(),
        statusText: z.string(),
        body: z.any().optional(),
        error: z.string().optional()
      }
    },
    async ({ serviceId, jobId, pathOverride, methodOverride, payload }) => {
      const service = getService(serviceId);
      const defaultPath = service.operations?.restartJobPath;
      if (!defaultPath && !pathOverride) {
        throw new Error(
          `Service ${service.id} does not declare operations.restartJobPath. Provide pathOverride to call a custom endpoint.`
        );
      }
      const url = buildServiceOperationUrl(service, pathOverride || defaultPath);
      const method = methodOverride || service.operations?.restartJobMethod || 'POST';
      const bodyPayload = JSON.stringify({
        jobId,
        ...(payload || {})
      });
      let result;
      try {
        const { response, body } = await fetchOperationPayload(url, {
          method,
          body: bodyPayload
        });
        result = {
          serviceId,
          url: url.toString(),
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          body
        };
      } catch (error) {
        result = {
          serviceId,
          url: url.toString(),
          ok: false,
          status: 0,
          statusText: error.name || 'error',
          error: error.message
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: result
      };
    }
  );

  server.registerPrompt(
    'service-health-report',
    {
      title: 'Generate Service Health Report',
      description: 'Summarize the latest health check for a HeySalad service',
      argsSchema: {
        serviceId: serviceIdArgument,
        includeRawBody: z
          .boolean()
          .default(false)
          .describe('Include the raw body returned by the service')
      }
    },
    async ({ serviceId, includeRawBody }) => {
      const service = getService(serviceId);
      const health = await fetchServiceHealth(service);
      const summaryLines = [
        `Service: ${service.name} (${service.id})`,
        `Endpoint: ${health.url}`,
        `Status: ${health.ok ? 'healthy' : 'unhealthy'} (${health.status ?? 'n/a'})`,
        `Latency: ${health.durationMs} ms`
      ];

      if (!health.ok && health.error) {
        summaryLines.push(`Error: ${health.error}`);
      }

      if (includeRawBody && health.body) {
        summaryLines.push(
          'Body:',
          typeof health.body === 'string' ? health.body : JSON.stringify(health.body, null, 2)
        );
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: summaryLines.join('\n')
            }
          }
        ]
      };
    }
  );

  const deviceTypeEnum = z.enum([...DEFAULT_DEVICE_TYPES]);

  server.registerTool(
    'generate_device',
    {
      title: 'Generate HeySalad Device Identity',
      description: 'Create IMEI, HeySalad serial, provisioning URL, and QR code for hardware provisioning.',
      inputSchema: {
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(1)
          .describe('How many devices to generate (1-20).'),
        deviceType: deviceTypeEnum.optional().describe('Device type (defaults to KIO).'),
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe('Provisioning base URL override.'),
        seed: z
          .string()
          .optional()
          .describe('Optional deterministic seed shared across the generated devices.')
      },
      outputSchema: {
        devices: z.array(
          z.object({
            imei: z.string(),
            serial: z.string(),
            provisioningURL: z.string(),
            qrCode: z.string(),
            metadata: z.object({
              seed: z.string(),
              deviceType: deviceTypeEnum,
              generatedAt: z.string(),
              imei14: z.string(),
              luhnCheckDigit: z.number()
            })
          })
        )
      }
    },
    async ({ count = 1, deviceType, baseUrl, seed }) => {
      const generator = new DeviceGenerator(seed);
      const devices = [];
      for (let i = 0; i < count; i += 1) {
        const device = await generator.generateDevice({
          deviceType,
          baseURL: baseUrl,
          sequence: i
        });
        devices.push(device);
      }
      const payload = { devices };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload, null, 2)
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.registerTool(
    'validate_imei',
    {
      title: 'Validate IMEI Identifier',
      description: 'Checks whether a 15-digit IMEI passes the Luhn checksum.',
      inputSchema: {
        imei: z
          .string()
          .min(15)
          .max(15)
          .describe('15 digit IMEI to validate.')
      },
      outputSchema: {
        imei: z.string(),
        valid: z.boolean()
      }
    },
    async ({ imei }) => {
      const valid = validateImeiHelper(imei);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ imei, valid }, null, 2)
          }
        ],
        structuredContent: { imei, valid }
      };
    }
  );

  return { server, services };
}

const contexts = {
  internal: buildMcpContext(config.services),
  public: buildMcpContext(config.services.filter(service => service.requiredScope === 'public'))
};

function getScopeFromRequest(req) {
  const scope = req?.mcpIdentity?.scope;
  return scope === SCOPE_INTERNAL ? SCOPE_INTERNAL : SCOPE_PUBLIC;
}

const oauthMetadata = buildOAuthMetadata();

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json(oauthMetadata);
});

app.get('/.well-known/openid-configuration', (_req, res) => {
  res.json(oauthMetadata);
});

app.all('/oauth/authorize', async (req, res) => {
  if (!oauthClients.length) {
    return res
      .status(503)
      .send('OAuth is not configured for this MCP server. Ask HeySalad infra to enable MCP_OAUTH_CLIENTS.');
  }

  const merged = { ...(req.query || {}) };
  if (req.method === 'POST') {
    Object.assign(merged, req.body || {});
  }

  const responseType = String(merged.response_type || 'code').toLowerCase();
  const clientId = merged.client_id;
  const redirectUri = merged.redirect_uri;
  const state = merged.state;
  const rawScope = merged.scope;
  const codeChallenge = merged.code_challenge;
  const codeChallengeMethod = (merged.code_challenge_method || 'S256').toUpperCase();
  const requestedScope = extractScopeToken(rawScope);
  const action = typeof merged.action === 'string' ? merged.action.toLowerCase() : 'authorize';
  const apiKeyInput =
    typeof merged.api_key === 'string' && merged.api_key.trim().length > 0 ? merged.api_key.trim() : null;
  const otpEmailInputRaw = typeof merged.otp_email === 'string' ? merged.otp_email.trim() : '';
  const otpEmailNormalized = normalizeOtpEmail(otpEmailInputRaw);
  const otpCodeInput =
    typeof merged.otp_code === 'string' && merged.otp_code.trim().length > 0
      ? merged.otp_code.replace(/\s+/g, '').trim()
      : '';

  const client = getOAuthClient(clientId);
  const baseRenderProps = {
    redirectUri,
    state,
    scope: rawScope,
    codeChallenge,
    codeChallengeMethod,
    otpEnabled: OTP_ENABLED,
    allowedOtpEmails: OTP_ALLOWED_EMAILS,
    otpEmailValue: otpEmailInputRaw
  };
  const renderFormResponse = ({
    error: formError = null,
    notice = null,
    clientOverride = null,
    statusCode
  } = {}) => {
    const targetClient =
      clientOverride ||
      client || { clientId, displayName: clientId || 'Unknown client', redirectOrigins: [] };
    return res
      .status(typeof statusCode === 'number' ? statusCode : formError ? 400 : 200)
      .send(
        renderAuthorizeFormPage({
          ...baseRenderProps,
          client: targetClient,
          error: formError,
          notice
        })
      );
  };

  if (!client) {
    return renderFormResponse({
      error: 'Unknown client_id.',
      clientOverride: { clientId, displayName: clientId || 'Unknown client', redirectOrigins: [] }
    });
  }

  if (responseType !== 'code') {
    return renderFormResponse({ error: 'Only response_type=code is supported.' });
  }

  if (!redirectUri) {
    return renderFormResponse({ error: 'Missing redirect_uri.' });
  }

  if (!isRedirectAllowedForClient(client, redirectUri)) {
    return renderFormResponse({ error: 'redirect_uri is not allowed for this client.' });
  }

  if (!codeChallenge) {
    return renderFormResponse({ error: 'PKCE code_challenge is required.' });
  }

  if (codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'PLAIN') {
    return renderFormResponse({ error: 'Only S256 PKCE code_challenge_method is supported.' });
  }

  if (req.method !== 'POST' && action !== 'send_code') {
    return renderFormResponse();
  }

  if (action === 'send_code') {
    if (req.method !== 'POST') {
      return renderFormResponse();
    }
    if (!OTP_ENABLED || !otpService) {
      return renderFormResponse({ error: 'Login codes are not enabled for this server.' });
    }
    if (!otpEmailNormalized) {
      return renderFormResponse({ error: 'Email is required to send a login code.' });
    }
    if (!isEmailAllowedForOtp(otpEmailNormalized)) {
      return renderFormResponse({ error: 'That email is not approved for login codes.' });
    }
    try {
      const { code } = otpService.createCode(otpEmailNormalized);
      try {
        await sendOtpLoginCode(otpEmailNormalized, code, { client });
        return renderFormResponse({
          notice: `Login code sent to ${otpEmailNormalized}. Check your inbox within the next few minutes.`
        });
      } catch (error) {
        otpService.invalidateCode(code, { resetThrottle: true });
        console.error('[heysalad-mcp] Failed to send OTP email:', error);
        return renderFormResponse({ error: 'Failed to send a login code. Please try again later.' });
      }
    } catch (error) {
      if (error.code === 'OTP_THROTTLED') {
        const waitSeconds = Math.ceil((error.retryInMs || 0) / 1000);
        return renderFormResponse({ error: `Please wait ${waitSeconds}s before requesting another code.` });
      }
      console.error('[heysalad-mcp] Failed to create OTP code:', error);
      return renderFormResponse({ error: 'Unable to create a login code right now.' });
    }
  }

  if (req.method !== 'POST') {
    return renderFormResponse();
  }

  let resolvedIdentity;
  let identitySource = null;

  if (apiKeyInput) {
    try {
      resolvedIdentity = await resolveApiKeyIdentity(apiKeyInput);
    } catch (error) {
      console.error('[heysalad-mcp] OAuth authorize failed to resolve API key:', error);
      return renderFormResponse({ error: 'Failed to validate API key. Please try again.' });
    }

    if (!resolvedIdentity) {
      return renderFormResponse({ error: 'Invalid API key.' });
    }
    identitySource = 'api-key';
  } else if (otpCodeInput) {
    if (!OTP_ENABLED || !otpService) {
      return renderFormResponse({ error: 'Login codes are not enabled on this server.' });
    }
    const otpResult = otpService.verifyCode(otpCodeInput, otpEmailNormalized);
    if (!otpResult) {
      return renderFormResponse({ error: 'Invalid or expired login code.' });
    }
    resolvedIdentity = {
      identity: {
        keyId: `otp-${crypto.randomUUID()}`,
        userId: otpResult.email,
        email: otpResult.email,
        keyPrefix: 'otp',
        scope: otpResult.scope,
        role: otpResult.scope === SCOPE_INTERNAL ? 'otp-internal' : 'otp',
        authType: 'otp'
      },
      record: null
    };
    identitySource = 'otp';
  } else {
    return renderFormResponse({ error: 'Provide an API key or a login code before continuing.' });
  }

  const grantedScope = resolveGrantedScope(requestedScope, resolvedIdentity.identity.scope);
  if (!grantedScope) {
    return renderFormResponse({ error: 'This identity cannot grant the requested scope.' });
  }

  const scopeResponse = normalizeScopeResponse(rawScope, grantedScope);
  const identity = { ...resolvedIdentity.identity, scope: grantedScope };
  const authorizationCode = createAuthorizationCode({
    clientId: client.clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: grantedScope,
    scopeResponse,
    identity
  });

  if (identitySource === 'api-key' && resolvedIdentity.record?.id) {
    markKeyUsed(resolvedIdentity.record.id).catch(error => {
      console.warn('[heysalad-mcp] Failed to update key usage after OAuth authorize:', error.message);
    });
  }

  const target = new URL(redirectUri);
  target.searchParams.set('code', authorizationCode);
  if (state) {
    target.searchParams.set('state', state);
  }
  return res.redirect(target.toString());
});

function sendTokenError(res, status, errorCode, description) {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache'
  });
  res.status(status).json({
    error: errorCode,
    error_description: description
  });
}

app.post('/oauth/token', (req, res) => {
  if (!oauthClients.length) {
    return sendTokenError(res, 503, 'temporarily_unavailable', 'OAuth is not configured for this MCP server.');
  }

  const grantType = req.body?.grant_type;
  if (grantType === 'authorization_code') {
    const code = req.body.code;
    const codeVerifier = req.body.code_verifier;
    const redirectUri = req.body.redirect_uri;
    const clientId = req.body.client_id;
    const clientSecret = req.body.client_secret;
    const requestedScopeRaw =
      typeof req.body.scope === 'string' && req.body.scope.trim().length > 0 ? req.body.scope : null;

    if (!code || !codeVerifier || !redirectUri || !clientId) {
      return sendTokenError(res, 400, 'invalid_request', 'code, code_verifier, redirect_uri, and client_id are required.');
    }

    const client = getOAuthClient(clientId);
    if (!client) {
      return sendTokenError(res, 400, 'invalid_client', 'Unknown client_id.');
    }
    if (client.clientSecret && client.clientSecret !== (clientSecret || '')) {
      return sendTokenError(res, 401, 'invalid_client', 'Client authentication failed.');
    }
    if (!isRedirectAllowedForClient(client, redirectUri)) {
      return sendTokenError(res, 400, 'invalid_request', 'redirect_uri is not allowed for this client.');
    }

    const codeEntry = consumeAuthorizationCode(code);
    if (!codeEntry) {
      return sendTokenError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
    }
    if (codeEntry.clientId !== client.clientId) {
      return sendTokenError(res, 400, 'invalid_grant', 'Authorization code was issued to a different client.');
    }
    if (codeEntry.redirectUri !== redirectUri) {
      return sendTokenError(res, 400, 'invalid_grant', 'redirect_uri does not match the original request.');
    }
    if (!verifyPkce(codeVerifier, codeEntry.codeChallenge, codeEntry.codeChallengeMethod)) {
      return sendTokenError(res, 400, 'invalid_grant', 'Invalid code_verifier.');
    }

    const requestedScope = extractScopeToken(requestedScopeRaw);
    const grantedScope = resolveGrantedScope(requestedScope, codeEntry.scope);
    if (!grantedScope) {
      return sendTokenError(res, 400, 'invalid_scope', 'Requested scope is not permitted.');
    }

    const identity = { ...codeEntry.identity, scope: grantedScope };
    const responseScope = normalizeScopeResponse(requestedScopeRaw || codeEntry.scopeResponse, grantedScope);
    const tokens = issueOAuthTokenPair({
      identity,
      scope: grantedScope,
      clientId: client.clientId,
      scopeResponse: responseScope
    });

    res.set({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache'
    });
    return res.json({
      token_type: 'Bearer',
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      scope: responseScope
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = req.body.refresh_token;
    const clientId = req.body.client_id;
    const clientSecret = req.body.client_secret;
    const requestedScopeRaw =
      typeof req.body.scope === 'string' && req.body.scope.trim().length > 0 ? req.body.scope : null;
    if (!refreshToken || !clientId) {
      return sendTokenError(res, 400, 'invalid_request', 'refresh_token and client_id are required.');
    }
    const client = getOAuthClient(clientId);
    if (!client) {
      return sendTokenError(res, 400, 'invalid_client', 'Unknown client_id.');
    }
    if (client.clientSecret && client.clientSecret !== (clientSecret || '')) {
      return sendTokenError(res, 401, 'invalid_client', 'Client authentication failed.');
    }

    const refreshEntry = getValidOAuthRefreshToken(refreshToken);
    if (!refreshEntry) {
      return sendTokenError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (refreshEntry.clientId !== client.clientId) {
      return sendTokenError(res, 400, 'invalid_grant', 'Refresh token was issued to a different client.');
    }

    oauthRefreshTokens.delete(refreshToken);

    const requestedScope = extractScopeToken(requestedScopeRaw);
    const grantedScope = resolveGrantedScope(requestedScope, refreshEntry.scope);
    if (!grantedScope) {
      return sendTokenError(res, 400, 'invalid_scope', 'Requested scope is not permitted.');
    }

    const identity = { ...refreshEntry.identity, scope: grantedScope };
    const responseScope = normalizeScopeResponse(requestedScopeRaw || refreshEntry.scopeResponse, grantedScope);
    const tokens = issueOAuthTokenPair({
      identity,
      scope: grantedScope,
      clientId: client.clientId,
      scopeResponse: responseScope
    });

    res.set({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache'
    });
    return res.json({
      token_type: 'Bearer',
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
      scope: responseScope
    });
  }

  return sendTokenError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported.');
});

async function handleMcpRequest(req, res) {
  try {
    const scope = getScopeFromRequest(req);
    const context = scope === SCOPE_INTERNAL ? contexts.internal : contexts.public;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    res.on('close', () => transport.close());
    res.on('finish', () => transport.close());

    await context.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[heysalad-mcp] Failed to handle MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
}

app.all('/mcp', requireApiKey, verifyOrigin, handleMcpRequest);
app.all('/sse', requireApiKey, verifyOrigin, handleMcpRequest);

app.get('/healthz', async (_req, res) => {
  const checks = await Promise.all(
    config.services.map(service =>
      fetchServiceHealth(service)
        .then(result => ({ ...result, requiredScope: service.requiredScope }))
        .catch(error => ({
          serviceId: service.id,
          ok: false,
          error: error.message,
          requiredScope: service.requiredScope
        }))
    )
  );

  res.json({
    status: checks.every(check => check.ok) ? 'ok' : 'degraded',
    version: pkg.version,
    services: checks
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'heysalad-mcp',
    version: pkg.version,
    mcpEndpoint: '/mcp',
    configPath: config.configPath,
    scopes: {
      public: contexts.public.services.map(toSerializableService),
      internal: contexts.internal.services.map(toSerializableService)
    }
  });
});

const serverInstance = app.listen(config.port, () => {
  console.log(
    `[heysalad-mcp] Listening on http://localhost:${config.port} (config: ${config.configPath})`
  );
  console.log(
    `[heysalad-mcp] Point your Cloudflare Tunnel to http://127.0.0.1:${config.port}/mcp`
  );
});

function gracefulShutdown(signal) {
  console.log(`[heysalad-mcp] Received ${signal}, shutting down...`);
  serverInstance.close(() => {
    Promise.allSettled([contexts.public.server.close(), contexts.internal.server.close()])
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function normalizeRole(scope) {
  if (typeof scope === 'string' && scope.trim().length > 0) {
    return scope.trim().toLowerCase();
  }
  return SCOPE_PUBLIC;
}

function toAccessLevel(role) {
  return INTERNAL_SCOPE_ALIASES.has(role) ? SCOPE_INTERNAL : SCOPE_PUBLIC;
}

function normalizeScopeValue(scope) {
  const role = normalizeRole(scope);
  return toAccessLevel(role);
}

function getKeyHashCandidates(apiKey) {
  return buildKeyHashCandidates(apiKey, {
    pepper: API_KEY_PEPPER,
    includePlainFallback: SHOULD_INCLUDE_PLAIN_HASH_FALLBACK
  });
}

function buildSupabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function fetchKeyRecordByHash(hashedKey) {
  const baseUrl = SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') : null;
  if (!baseUrl) {
    return null;
  }
  const url = new URL(`/rest/v1/${SUPABASE_TABLE}`, baseUrl);
  url.searchParams.set('select', '*');
  url.searchParams.set('key_hash', `eq.${hashedKey}`);
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: buildSupabaseHeaders()
  });

  if (!response.ok) {
    throw new Error(`Supabase responded with ${response.status}`);
  }

  const payload = await response.json();
  return payload?.[0] || null;
}

async function lookupKeyRecord(apiKey) {
  const candidates = getKeyHashCandidates(apiKey);
  const primaryVariant = candidates[0]?.variant;

  for (const candidate of candidates) {
    const record = await fetchKeyRecordByHash(candidate.hash);
    if (record) {
      if (primaryVariant && candidate.variant !== primaryVariant) {
        const prefix = record.key_prefix || candidate.hash.slice(0, 6);
        console.warn(
          `[heysalad-mcp] API key ${prefix} matched ${candidate.variant} hash fallback. Align API_KEY_PEPPER between developer portal and MCP host.`
        );
      }
      return { record, variant: candidate.variant };
    }
  }

  return null;
}

async function markKeyUsed(keyId) {
  const baseUrl = SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') : null;
  if (!baseUrl) {
    return;
  }
  const url = new URL(`/rest/v1/${SUPABASE_TABLE}`, baseUrl);
  url.searchParams.set('id', `eq.${keyId}`);
  await fetch(url, {
    method: 'PATCH',
    headers: {
      ...buildSupabaseHeaders(),
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      last_used_at: new Date().toISOString()
    })
  }).catch(error => {
    console.warn('[heysalad-mcp] Failed to update last_used_at:', error.message);
  });
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers['x-api-key'];
  if (!header) {
    return null;
  }
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return header.trim();
}

function extractApiKey(req) {
  const headerKey = extractBearer(req);
  if (headerKey) {
    return headerKey;
  }
  const query = req.query || {};
  const candidate =
    query.api_key ??
    query.apiKey ??
    query.apikey ??
    query.token ??
    query.key ??
    null;
  if (!candidate) {
    return null;
  }
  if (Array.isArray(candidate)) {
    return candidate.find(value => typeof value === 'string' && value.trim().length > 0)?.trim() || null;
  }
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return null;
}

async function resolveApiKeyIdentity(apiKey) {
  if (!apiKey) {
    return null;
  }
  const lookupResult = await lookupKeyRecord(apiKey);
  if (!lookupResult) {
    return null;
  }
  const { record, variant } = lookupResult;
  const roleSource = record.scope ?? record.role ?? record.access_level ?? 'public';
  const role = normalizeRole(roleSource);
  const accessLevel = toAccessLevel(role);
  const identity = {
    keyId: record.id,
    userId: record.user_id,
    email: record.user_email,
    keyPrefix: record.key_prefix,
    scope: accessLevel,
    role
  };
  if (variant && variant !== 'peppered') {
    identity.hashVariant = variant;
  }
  return { identity, record };
}

function requireApiKey(req, res, next) {
  if (DEMO_MCP_TOKEN) {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      console.warn('[heysalad-mcp] Demo auth failed: missing Authorization header');
      return res.status(401).json({
        error: 'Invalid or missing MCP demo token'
      });
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      console.warn('[heysalad-mcp] Demo auth failed: Authorization header missing Bearer token');
      return res.status(401).json({
        error: 'Invalid or missing MCP demo token'
      });
    }

    const providedToken = match[1].trim();
    if (!providedToken) {
      console.warn('[heysalad-mcp] Demo auth failed: empty Bearer token');
      return res.status(401).json({
        error: 'Invalid or missing MCP demo token'
      });
    }

    if (providedToken !== DEMO_MCP_TOKEN) {
      console.warn('[heysalad-mcp] Demo auth failed: token mismatch');
      return res.status(401).json({
        error: 'Invalid or missing MCP demo token'
      });
    }

    req.mcpIdentity = {
      keyId: 'demo',
      userId: 'demo',
      email: null,
      keyPrefix: 'demo',
      scope: SCOPE_PUBLIC,
      role: 'demo'
    };
    return next();
  }

  if (!SUPABASE_CONFIGURED) {
    return res.status(503).json({
      ok: false,
      error: 'API key enforcement not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    });
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      ok: false,
      error: 'Missing API key (supply Authorization: Bearer <key> or ?api_key=...).'
    });
  }

  const oauthEntry = getValidOAuthAccessToken(apiKey);
  if (oauthEntry) {
    req.mcpIdentity = oauthEntry.identity;
    return next();
  }

  resolveApiKeyIdentity(apiKey)
    .then(result => {
      if (!result) {
        return res.status(403).json({
          ok: false,
          error: 'Invalid API key.'
        });
      }

      req.mcpIdentity = result.identity;
      markKeyUsed(result.record.id).finally(() => next());
    })
    .catch(error => {
      console.error('[heysalad-mcp] API key verification failed:', error);
      res.status(502).json({
        ok: false,
        error: 'Failed to validate API key.'
      });
    });
}
