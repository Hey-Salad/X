import fs from 'fs';
import path from 'path';

const DEFAULT_PORT = 4141;

const defaultServices = [
  {
    id: 'cloud-printer',
    name: 'Cloud Printer Backend',
    description: 'Accepts pending kiosk jobs and forwards them to registered printers.',
    baseUrl: process.env.CLOUD_PRINTER_URL || 'http://127.0.0.1:3100',
    healthPath: '/healthz',
    docsUrl: 'heysalad-cloud-printer-backend/README.md',
    requiredScope: 'internal'
  },
  {
    id: 'kiosk-portal',
    name: 'Kiosk Portal API',
    description: 'Local management plane for captive portal onboarding.',
    baseUrl: process.env.KIOSK_PORTAL_URL || 'http://127.0.0.1:3200',
    healthPath: '/healthz',
    docsUrl: 'kiosk_portal.py',
    requiredScope: 'internal'
  },
  {
    id: 'oss-kiosk',
    name: 'OSS GPT Kiosk Backend',
    description: 'LLM gateway for GPT-enabled kiosks (Open-Source stack).',
    baseUrl: process.env.OSS_KIOSK_URL || 'http://127.0.0.1:3300',
    healthPath: '/healthz',
    docsUrl: 'heysalad-gpt-oss-kiosk-backend/README.md',
    requiredScope: 'public'
  }
];

const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  allowedHosts: [],
  allowedOrigins: [],
  services: defaultServices
};

function parseList(value) {
  if (!value) {
    return undefined;
  }

  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[heysalad-mcp] Failed to read ${filePath}:`, error.message);
    return undefined;
  }
}

function normalizeScope(scope) {
  return scope === 'internal' ? 'internal' : 'public';
}

function sanitizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return undefined;
  }

  if (/^https?:\/\//.test(baseUrl)) {
    return baseUrl;
  }

  return `http://${baseUrl}`;
}

function normalizeService(service) {
  if (!service || !service.id || !service.baseUrl) {
    throw new Error('Each service entry requires at least an id and baseUrl');
  }

  return {
    id: service.id,
    name: service.name || service.id,
    description: service.description || '',
    baseUrl: sanitizeBaseUrl(service.baseUrl),
    healthPath: service.healthPath || '/healthz',
    docsUrl: service.docsUrl,
    timeoutMs: Number(service.timeoutMs || 5000),
    requiredScope: normalizeScope(service.requiredScope)
  };
}

function loadConfig() {
  const fallbackConfigPath = path.join(import.meta.dirname, '..', 'config', 'services.json');
  const configPath = process.env.HEYSALAD_MCP_CONFIG || fallbackConfigPath;
  const fileConfig = readJsonIfExists(configPath) || {};

  const envOverrides = {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    allowedHosts: parseList(process.env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(process.env.MCP_ALLOWED_ORIGINS)
  };

  const servicesPayload =
    (fileConfig.services && Array.isArray(fileConfig.services) && fileConfig.services.length > 0
      ? fileConfig.services
      : DEFAULT_CONFIG.services) || [];

  return {
    port: envOverrides.port ?? fileConfig.port ?? DEFAULT_CONFIG.port,
    allowedHosts: envOverrides.allowedHosts ?? fileConfig.allowedHosts ?? DEFAULT_CONFIG.allowedHosts,
    allowedOrigins: envOverrides.allowedOrigins ?? fileConfig.allowedOrigins ?? DEFAULT_CONFIG.allowedOrigins,
    services: servicesPayload.map(normalizeService),
    configPath
  };
}

export { loadConfig, DEFAULT_CONFIG };
