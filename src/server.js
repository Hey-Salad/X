const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { completable } = require('@modelcontextprotocol/sdk/server/completable.js');
const { z } = require('zod');
const { loadConfig } = require('./config');
const { DeviceGenerator, validateIMEI: validateImeiHelper, DEFAULT_DEVICE_TYPES } = require('./device-generator');
const pkg = require('../package.json');

const config = loadConfig();
const app = express();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_KEY_PEPPER = process.env.API_KEY_PEPPER || '';
const SUPABASE_TABLE = process.env.SUPABASE_MCP_TABLE || 'mcp_keys';
const SCOPE_PUBLIC = 'public';
const SCOPE_INTERNAL = 'internal';
const PUBLIC_SCOPE_ALIASES = new Set(['public', 'driver', 'kitchen', 'courier', 'field', 'laura-mobile']);
const INTERNAL_SCOPE_ALIASES = new Set(['internal', 'finance', 'approver', 'logistics', 'admin', 'backoffice', 'hr']);

app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: true,
    credentials: true
  })
);

const transportOptions = createTransportOptions(config);

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

function createTransportOptions(mcpConfig) {
  return {
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection:
      (mcpConfig.allowedHosts && mcpConfig.allowedHosts.length > 0) ||
      (mcpConfig.allowedOrigins && mcpConfig.allowedOrigins.length > 0),
    allowedHosts:
      mcpConfig.allowedHosts && mcpConfig.allowedHosts.length > 0 ? mcpConfig.allowedHosts : undefined,
    allowedOrigins:
      mcpConfig.allowedOrigins && mcpConfig.allowedOrigins.length > 0 ? mcpConfig.allowedOrigins : undefined
  };
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
    requiredScope: service.requiredScope
  };
}

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  baseUrl: z.string(),
  healthPath: z.string(),
  docsUrl: z.string().optional(),
  timeoutMs: z.number().optional(),
  requiredScope: z.enum([SCOPE_PUBLIC, SCOPE_INTERNAL])
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

app.all('/mcp', requireApiKey, handleMcpRequest);

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

function hashKey(apiKey) {
  return crypto.createHash('sha256').update(`${apiKey}${API_KEY_PEPPER}`).digest('hex');
}

function buildSupabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function fetchKeyRecord(hashedKey) {
  const baseUrl = SUPABASE_URL ? SUPABASE_URL.replace(/\/$/, '') : null;
  if (!baseUrl) {
    return null;
  }
  const url = new URL(`/rest/v1/${SUPABASE_TABLE}`, baseUrl);
  url.searchParams.set('select', 'id,user_id,user_email,key_prefix,scope');
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

function requireApiKey(req, res, next) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'API key enforcement not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
    });
  }

  const apiKey = extractBearer(req);
  if (!apiKey) {
    return res.status(401).json({
      ok: false,
      error: 'Missing Authorization header (use Bearer API key).'
    });
  }

  const hashedKey = hashKey(apiKey);

  fetchKeyRecord(hashedKey)
    .then(record => {
      if (!record) {
        return res.status(403).json({
          ok: false,
          error: 'Invalid API key.'
        });
      }

      const role = normalizeRole(record.scope);
      const accessLevel = toAccessLevel(role);

      req.mcpIdentity = {
        keyId: record.id,
        userId: record.user_id,
        email: record.user_email,
        keyPrefix: record.key_prefix,
        scope: accessLevel,
        role
      };

      markKeyUsed(record.id).finally(() => next());
    })
    .catch(error => {
      console.error('[heysalad-mcp] API key verification failed:', error);
      res.status(502).json({
        ok: false,
        error: 'Failed to validate API key.'
      });
    });
}
