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
