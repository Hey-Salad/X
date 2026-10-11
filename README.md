## HeySalad MCP Server

Lightweight Model Context Protocol (MCP) server that exposes HeySalad operational data (service metadata, health checks, and prompts) over the Streamable HTTP transport. Pair it with Cloudflare Tunnels to make the server securely available at `mcp.heysalad.app` for Claude Code, VS Code MCP, Cursor, or any other MCP-aware client.

---

### Project Layout

| Path | Purpose |
| --- | --- |
| `src/server.js` | Express + MCP wiring, resource/tool/prompt registration, health route |
| `src/config.js` | Loads config from `config/services.json` + env overrides |
| `config/services.example.json` | Starter config – copy to `config/services.json` and edit |

---

### 1. Configure Services

```bash
cd ~/heysalad-mcp
cp config/services.example.json config/services.json
nano config/services.json  # tweak baseUrl/ports/descriptions
```

`config/services.json` is the source of truth for every downstream integration. The Laura Mobile logistics/HR spec ships with the following entries so the MCP server can reason about each component:

| ID | Scope | Purpose |
| --- | --- | --- |
| `cloud-printer`, `kiosk-portal`, `oss-kiosk` | internal/public | Legacy kiosk stack touchpoints. |
| `laura` | public | Primary Laura portal (devices, rewards). |
| `laura-firebase` | public | Firebase edge that keeps the mobile app in sync. |
| `laura-driver-telemetry` | public | Real-time driver route + hardware health. |
| `laura-approvals` | internal | HR/logistics approvals, onboarding packets. |
| `laura-docs` | internal | Document/PDF generation for contracts + SOPs. |
| `laura-finance` | internal | Finance + payroll adjustments. |
| `gpt-gateway` | internal | Codex/Claude/Cursor guardrail + caching gateway. |
| `ota-service` | internal | Firmware + Raspberry Pi rollout coordinator. |

Feel free to add/edit services in that file only—the server bootstraps its MCP resources and tools directly from it, so no code changes are needed when new services come online.

Environment overrides:

| Variable | Description |
| --- | --- |
| `PORT` | TCP port for the HTTP server (defaults to `4141`) |
| `MCP_ALLOWED_HOSTS` | Comma separated hostnames for DNS rebinding protection |
| `MCP_ALLOWED_ORIGINS` | Comma separated origins allowed to hit `/mcp` |
| `HEYSALAD_MCP_CONFIG` | Alternate config file path |
| `CLOUD_PRINTER_URL`, `KIOSK_PORTAL_URL`, `OSS_KIOSK_URL` | Convenience overrides for default services |

---

### 2. Run Locally

```bash
cd ~/heysalad-mcp
npm install
npm start
# MCP endpoint: http://127.0.0.1:4141/mcp
# Health check: http://127.0.0.1:4141/healthz
```

Download MCP Inspector on your workstation and connect to `http://<RPI-LAN-IP>:4141/mcp` to verify tools/resources.

---

### 3. Expose Through Cloudflare

Cloudflare is already installed on the Pi, so you only need to create a dedicated tunnel and DNS route.

```bash
# 1) Authenticate if needed
cloudflared tunnel login

# 2) Create (one-time)
cloudflared tunnel create heysalad-mcp

# 3) Map DNS record (Cloudflare automatically adds mcp.heysalad.app)
cloudflared tunnel route dns heysalad-mcp mcp.heysalad.app

# 4) Run the tunnel pointing at the MCP endpoint
cloudflared tunnel run heysalad-mcp --url http://127.0.0.1:4141
```

Recommended persistent config at `~/.cloudflared/config.yml`:

```yaml
tunnel: heysalad-mcp
credentials-file: /home/admin/.cloudflared/heysalad-mcp.json
ingress:
  - hostname: mcp.heysalad.app
    service: http://127.0.0.1:4141
  - service: http_status:404
```

Then enable the service with `sudo systemctl enable --now cloudflared@heysalad-mcp`.

---

### 4. Register the MCP Server with Clients

**Claude Code**

```bash
claude mcp add --transport http heysalad-mcp https://mcp.heysalad.app/mcp
```

**VS Code / Copilot MCP**

Add to `settings.json`:

```jsonc
"copilot.experimental.modelContextProtocol.serverConfigurations": [
  {
    "name": "heysalad-mcp",
    "type": "http",
    "url": "https://mcp.heysalad.app/mcp"
  }
]
```

**Cursor**

Open `cursor://anysphere.cursor-deeplink/mcp/install?name=heysalad-mcp&config=eyJ1cmwiOiJodHRwczovL21jcC5oZXlzYWxhZC5hcHAvbWNwIn0=` (or add manually via Settings → MCP).

**ChatGPT Connectors / Developer Mode (OAuth + PKCE)**

1. Enable *Developer mode* under Settings → Connectors.
2. Click **Add MCP server** and fill:
   - `Server URL`: `https://mcp.heysalad.app/mcp`
   - `Authorization URL`: `https://mcp.heysalad.app/oauth/authorize`
   - `Token URL`: `https://mcp.heysalad.app/oauth/token`
   - `Client ID`: `heysalad-chatgpt`
   - `Client secret`: *(leave blank — public PKCE client)*
3. Save. ChatGPT opens a browser window on `mcp.heysalad.app` asking for a HeySalad MCP API key; paste one from `https://developer.heysalad.app/` (VPN + SSO).
4. After the OAuth window closes, run `list_services` or `service-health-report` from the connector to confirm access. Tokens refresh automatically with PKCE, so you only enter the API key during the initial grant.

---

#### OAuth configuration knobs

| Env var | Purpose | Default |
| --- | --- | --- |
| `MCP_OAUTH_CLIENTS` | JSON array of `{clientId, clientSecret?, redirectOrigins?, displayName?}` to override all clients. | *(undefined → fall back to the entries below)* |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_NAME` | ID + label for the built-in ChatGPT client. | `heysalad-chatgpt` / `ChatGPT` |
| `MCP_OAUTH_CLIENT_SECRET` | Optional secret for confidential clients. Leave blank for PKCE-only public clients. | none |
| `MCP_OAUTH_REDIRECT_ORIGINS` | Comma-separated origins allowed to receive auth codes. | `https://chat.openai.com,https://chatgpt.com` |
| `MCP_OAUTH_CODE_TTL_MS`, `MCP_OAUTH_ACCESS_TOKEN_TTL_MS`, `MCP_OAUTH_REFRESH_TOKEN_TTL_MS` | Lifetimes for auth codes, access tokens, and refresh tokens. | 5 min / 1 h / 7 d |
| `MCP_OAUTH_ISSUER` | Public base URL used in `/.well-known/oauth-authorization-server`. | `https://mcp.heysalad.app` |

Access tokens issued through OAuth are cached in memory and honored by the existing `requireApiKey` middleware, so the MCP tools continue to see the same `req.mcpIdentity` shape regardless of whether authentication came from a raw API key or an OAuth grant.

---

#### Email Login Codes (SendGrid fallback)

If the Developer Portal is unreachable you can let trusted admins approve OAuth connections by emailing a one-time login code. Configure the following environment variables (examples shown in the user request):

| Variable | Description |
| --- | --- |
| `SENDGRID_API_KEY` | SendGrid API token used to deliver the OTP email. |
| `SENDGRID_FROM_EMAIL` | Sender mailbox (e.g., `noreply@heysalad.io`). |
| `SENDGRID_FROM_NAME` | Friendly sender name (defaults to `HeySalad MCP`). |
| `MCP_OTP_ALLOWED_EMAILS` or `ADMIN_EMAILS` | Comma-separated list of inboxes that are allowed to request codes. |
| `MCP_OTP_TTL_MS` | Code lifetime in milliseconds (default 10 minutes). |
| `MCP_OTP_RESEND_INTERVAL_MS` | Minimum delay between code sends to the same address (default 60 seconds). |
| `MCP_OTP_SCOPE` | Scope granted to OTP sessions (`public` or `internal`, default `internal`). |

With those set, the OAuth form renders two options: paste a standard API key or request a login code. Agents enter one of the approved emails, click **Send login code**, then paste the six-digit code sent via SendGrid. The resulting OAuth tokens inherit the configured `MCP_OTP_SCOPE`, so you can keep this path restricted to internal operators.

---

### 4.5 Operate Queues & Jobs from Codex

Two new MCP tools keep Codex (or any MCP client) self-sufficient once it is connected:

| Tool | Purpose | Example |
| --- | --- | --- |
| `get_queue_depth` | Reads queue/backlog stats from the service’s `operations.queueDepthPath`. | `mcp call get_queue_depth '{"serviceId":"gpt-gateway","queueName":"priority"}'` |
| `restart_service_job` | Issues POST/PUT/etc. to `operations.restartJobPath` to nudge a stuck rollout/run. | `mcp call restart_service_job '{"serviceId":"ota-service","jobId":"wave-2024-05-01"}'` |

If a service lacks the baked-in path, pass `pathOverride` (absolute or relative to `baseUrl`). Both tools echo the target URL, status code, and JSON body/error so Codex can reason about the result without additional logging.

---

### 5. Next Steps

1. Extend `config/services.json` with every stack component you care about (printer backend, kiosk portal, captive portal, GPT gateway, OTA service, etc.).
2. Implement additional MCP tools (e.g., queue depth, job restart) by importing your existing services/SDKs inside `src/server.js`.
3. Optionally wrap the Node app with a systemd service (e.g., `heysalad-mcp.service`) so it restarts with the Pi.
4. Once the tunnel is active and DNS propagated, test from outside your LAN: `curl https://mcp.heysalad.app/healthz`.

API keys can now be issued for role-based scopes such as Driver, Kitchen Staff, Logistics, Finance, or Approver. Each key stores its role in Supabase; the server maps those roles back to either the `public` or `internal` access context and exposes the normalized metadata on `req.mcpIdentity.role` for downstream tooling.

Let me know if you need help wiring systemd units, adding auth, or automating Cloudflare bootstrap. 

---

- ### 6. Developer Agents & Tooling

- The `agents/` directory hosts CLI helpers (DeepSeek, Qwen, OCR, Stability, hardware, file-ops, autonomous GPT-OSS developer, etc.) used to reason about the repo or external services. Install them with a virtualenv (`pip install -r agents/requirements.txt`) and see `agents/README.md` plus `AGENTS.md` for setup, credentials, and sample commands.
- Run `npm run heysaladx` to enter the Codex-style HeySaladX REPL (type `/help` once inside) or pass a one-off instruction via `npm run heysaladx -- "Task description"`. The orchestrator chains any configured sub-agents (including the hardware/file-ops specialists) and synthesizes the result via DeepSeek (recommended) or GPT-OSS-120B. Export `DEEPSEEK_API_KEY` (recommended, free tier available) or `HF_TOKEN`, and optionally `OPENAI_API_KEY` for Codex/GPT snippets.
- Each REPL turn extracts action items and appends them to `heysaladx.todo.md`, giving you a running backlog mapped to every prompt.
- Supabase test credentials live in `agents/.env.supabase.test` (ignored by git). Use `agents/supabase_cli_helper.sh` to run scoped Supabase CLI commands with those env vars preloaded.

---

### Continuous Integration

All pushes and pull requests run `.github/workflows/build.yml`, which:

- Executes `npm ci && npm test` on Node 20 to cover the MCP server and device generator suite.
- Installs the Python agent dependencies and byte-compiles `agents/*.py` to catch syntax errors before merging.

Extend the workflow as you add linting, integration tests, or deployment steps.

## License

Copyright (C) 2025-2026 HeySalad Inc.

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you run a modified version of this software to provide a network service, the AGPL requires you to offer its users the corresponding source code. Versions published before this change remain under their previous licence.
