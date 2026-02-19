## HeySalad MCP Agents Guide

Operational assistants (ChatGPT, Claude, Cursor, mobile agents, etc.) talk to the HeySalad stack through two HTTPS entrypoints:

| Purpose | URL |
| --- | --- |
| MCP transport | `https://mcp.heysalad.app/mcp` |
| Health + metadata | `https://mcp.heysalad.app/` and `https://mcp.heysalad.app/healthz` |
| API key portal & OAuth broker | `https://developer.heysalad.app/` |

### 1. Get Credentials

1. Visit the Developer Portal (`developer.heysalad.app`) while on the HeySalad network / VPN. Cloudflare Access will prompt for SSO.
2. Under **Your API Keys**, request the scope your agent needs:

| Role (scope) | Access level | Typical agent |
| --- | --- | --- |
| `driver`, `kitchen`, `public` | Public (Firebase sync, telemetry, OSS GPT kiosk) | Laura Mobile driver/kiosk support |
| `logistics`, `approver`, `finance`, `hr`, `internal` | Internal (adds approvals, document generator, finance portal, etc.) | Dispatch, HR, payroll, engineering |

3. Copy the plaintext key immediately (shown once). Treat it like a password.

> **OAuth option**: for clients that can’t store long-lived keys, use the built-in Authorization Code + PKCE endpoints (`/oauth/authorize`, `/oauth/token`). The resulting Bearer token carries the same `scope` and `access_level` claims and can be refreshed without issuing a new secret.

### 2. Configure ChatGPT / Claude / Cursor

Use a static key:

```
Connector URL: https://mcp.heysalad.app/mcp
Header: Authorization: Bearer <YOUR_KEY>
Transport: HTTP
```

Or use OAuth (PKCE) end-to-end on the MCP host (works with ChatGPT Connectors / Deep Research):

```
Authorization URL: https://mcp.heysalad.app/oauth/authorize
Token URL: https://mcp.heysalad.app/oauth/token
Client ID: heysalad-chatgpt
Client Secret: (leave blank)
Scope: <driver|kitchen|logistics|...>  # optional; defaults to your key’s scope
MCP URL: https://mcp.heysalad.app/mcp
```

When the browser window opens, paste a HeySalad API key from https://developer.heysalad.app/ (VPN + SSO). The OAuth service exchanges it for short-lived tokens so ChatGPT never stores the raw key.

After saving, run the `list_services` tool or the `service-health-report` prompt to confirm access.

### 3. Know What Each Service Does

The MCP server loads `config/services.json`. Today it exposes:

| ID | Scope | Description |
| --- | --- | --- |
| `cloud-printer`, `kiosk-portal` | internal | Legacy kiosk administration APIs. |
| `oss-kiosk`, `laura`, `laura-firebase`, `laura-driver-telemetry` | public | Laura Mobile telemetry, Firebase sync, OSS GPT kiosk. |
| `laura-approvals`, `laura-docs`, `laura-finance` | internal | Approvals, PDF/document generator, finance/payroll portal. |

Health probes hit each service’s `healthPath` and surface status/duration/body back to the agent.

### 4. When Things Fail

- `401/403` → Missing/invalid `Authorization` header. Issue a new key.
- `503` → Supabase secrets not configured on the MCP server; contact infra.
- `invalid_scope` when using OAuth → request one of the supported scopes listed above.

### 5. Testing Checklist

1. `curl https://mcp.heysalad.app/healthz` – verify downstream services are reachable.
2. `curl -H "Authorization: Bearer <key>" https://mcp.heysalad.app/mcp` with a `list_resources` MCP call – confirms the agent sees the right context.
3. From ChatGPT/Claude/Cursor, execute `list_services` and ensure only the expected services appear for that role.
4. Use `get_queue_depth` (e.g., `{"serviceId":"gpt-gateway"}`) and `restart_service_job` (e.g., `{"serviceId":"ota-service","jobId":"wave-123"}`) to confirm Codex can operate on guarded service actions.

Keep this file close when onboarding new agents so they can self-serve credentials and understand which endpoints they should call.

---

### 6. HeySaladX Orchestrator & Specialist Agents

- **HeySaladX (Node CLI)** lives at `agents/heysaladx/bin/heysaladx.js`. Run `npm run heysaladx` to drop into the enhanced interactive REPL with rich terminal UI (persistent history, `/help`, `/chain`, `/select-agents`, `/priority`, `/history`, `/quit` commands) or pass a single instruction (`npm run heysaladx -- "Plan MCP + firmware rollout"`). Features custom cooking spinner, brand colors, and interactive prompts. It gathers outputs from the delegated agents, optionally calls OpenAI/Codex, and synthesizes everything via GPT-OSS-120B. Flags: `--chain`, `--skip-summary`, `--json`, `--history`, `--system`, `--list-agents`, `--plain`.
- **Hardware & Firmware Agent** (`agents/hardware_agent.py`) understands Raspberry Pi bring-up, PlatformIO, Arduino/C++, Python, and web stack glue. Point it at the KellAI repo (`export KELLAI_REPO=/path/to/KellAI` if not already located at `~/KellAI`) and optionally add an SSH probe with `--probe-rpi admin@raspbx --probe-command "uname -a"` to feed Pi diagnostics into the model before reasoning.
- **Autonomous GPT-OSS Developer** (`agents/autodev_agent.py`) is the free-form “smartest chatbot” persona—just give it a prompt and it will reason about your request without extra scaffolding. Chain it from HeySaladX via `/chain autodev` or run the script directly for quick ideation.
- **File Ops Agent** (`agents/file_ops_agent.py`) gives GPT-OSS the ability to scan, read, and write files inside the repo (`list_repo_files`, `search_repo`, `read_repo_file`, `write_repo_file`). Useful for generating patches or scaffolding new files on the fly. Chain via `/chain fileops` or call the script directly.
- **Prompt Curator Agent** (`agents/prompt_agent.py`) manages prompt/response archives. Use it to refine instructions, list recent asks, or persist curated prompts before handing work to other agents (`/chain prompt` in HeySaladX).

### 7. HeySalad Deepseek Coder Service

- Runs from `agents/deepseek_api_agent.js` (Express) and proxies `/chat` calls to `https://api.deepseek.com/v1/chat/completions`.
- Requires `DEEPSEEK_API_KEY` (`sk-…`), optional `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, and `PORT` (default `5055`). Transcripts persist under `agents/state/deepseek/` (latest 100 by default).
- Local smoke test: `npm run deepseek:agent` then `curl -X POST http://127.0.0.1:5055/chat -H "Content-Type: application/json" -d '{"prompt":"Summarize README"}'`.
- Health check: `curl http://127.0.0.1:5055/healthz` (fails if API key missing or state dir unwritable).
- PM2: `pm2 start ecosystem.config.cjs --only heysalad-deepseek-coder` and `npm run pm2:reload:deepseek` after code changes. Logs stream via `pm2 logs heysalad-deepseek-coder`.
- The CLI (`agents/deepseek_coding_agent.py`) now POSTs to the local service; set `DEEPSEEK_AGENT_URL` or `--endpoint` if it runs elsewhere, and keep using `--include-file`, `--list-files`, and `--search` for repo context.
- Cloudflare exposure: update `/etc/cloudflared/config.yml` to include `hostname: api.deepseek.coding.agent.heysalad.app -> service: http://localhost:5055`, then restart the existing service (`sudo systemctl restart cloudflared`). If you prefer dedicated units, generate a tunnel install token from the Cloudflare dashboard and run `cloudflared service install <TOKEN>` to create `cloudflared@heysalad-mcp`.

### 8. MCP OAuth Troubleshooting Handoff

Use this section whenever an OAuth/API key regression needs human eyes (e.g., ChatGPT connector shows “Invalid API key”).

- **Current state (2025‑02‑13):** Developer Portal keys land in `public.mcp_keys`, but `/oauth/authorize` can’t find the inserted hash, so users see “Invalid API key.” Supabase connectivity works; the issue is most likely a hash/pepper mismatch or stale env vars on the MCP host.
- **Supabase access:**  
  - Pooler: `psql "postgresql://postgres.ybecdgbzgldafwvzwkpd:GutenTag$800M!@aws-0-eu-west-2.pooler.supabase.com:6543/postgres?sslmode=require"`  
  - Direct (migrations/heavy reads): `psql "postgresql://postgres.ybecdgbzgldafwvzwkpd:GutenTag$800M!@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require"`
- **Table schema:** `public.mcp_keys(id uuid, user_email text, key_hash text(64), key_prefix text, scope text, created_at timestamptz, last_used_at timestamptz)`. Hashes are hex‐encoded SHA‑256 strings.
- **To continue the investigation:**
  1. On the MCP host (PM2/systemd box), echo `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_MCP_TABLE`, and `API_KEY_PEPPER`. They must match the values used by the Developer Portal when inserting rows.
  2. Mint a fresh key via `developer.heysalad.app`, then query Supabase:  
     `select id, key_prefix, scope, created_at from public.mcp_keys order by created_at desc limit 5;`
  3. Ask the requestor for the raw `sk-...` string (or have them run `node scripts/hash-key.js <key>`). Compute both `sha256(key)` and `sha256(key + API_KEY_PEPPER)` to see which matches the stored `key_hash`.
  4. If neither matches, inspect the portal code path that writes `mcp_keys` to ensure it uses the same pepper and encoding.
  5. Once hashes align, hit `https://mcp.heysalad.app/mcp` with `curl -H "Authorization: Bearer <key>"` (should succeed), then re-test the ChatGPT OAuth window: it should close after pasting the same key.
  6. During migrations you can leave `MCP_ALLOW_PLAIN_KEY_HASH_FALLBACK` at its default (`true` when `API_KEY_PEPPER` is set) so the MCP host tries both the peppered and plain SHA-256 values. Set it to `false` once the Developer Portal and MCP host definitely share the same pepper.

#### OTP email fallback (SendGrid)

- When the Developer Portal is unavailable, enable the SendGrid-based OTP flow by setting `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, and either `MCP_OTP_ALLOWED_EMAILS` or `ADMIN_EMAILS` (comma-separated `@heysalad.io` inboxes allowed to receive codes). Optional knobs: `SENDGRID_FROM_NAME`, `MCP_OTP_TTL_MS`, `MCP_OTP_RESEND_INTERVAL_MS`, `MCP_OTP_SCOPE`, `MCP_OTP_EMAIL_SUBJECT`.
- The OAuth authorize page now shows “Option B · Email login code.” Operators type one of the approved emails, click **Send login code**, retrieve the six-digit code from the inbox, and submit it along with the PKCE request. Successful OTP sessions inherit the `MCP_OTP_SCOPE` you configured (defaults to `internal`).
- OTP storage is in-memory with automatic expiry; logs will show `[heysalad-mcp] Sent OTP login code to ...` for traceability. Keep the approved email list short and rotate the SendGrid key if it appears outside infra.
- **Verification snippets:**  
  ```bash
  # Hash a candidate key the same way the MCP server does
  API_KEY_PEPPER="" # set to production value if non-empty
  KEY="sk-your-test-key"
  node -e "const crypto=require('crypto');const key=process.env.KEY;const pepper=process.env.API_KEY_PEPPER||'';console.log(crypto.createHash('sha256').update(`${key}${pepper}`).digest('hex'))" 
  ```  
  ```bash
  # Check that the MCP server can reach Supabase
  curl -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_URL/rest/v1/mcp_keys?limit=1"
  ```
- **Hand-off expectation:** record any env/SQL changes here (date + short summary) so the next agent can pick up without re-discovering the plumbing.
