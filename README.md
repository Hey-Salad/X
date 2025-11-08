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

Let me know if you need help wiring systemd units, adding auth, or automating Cloudflare bootstrap. 
