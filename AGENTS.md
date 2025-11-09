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

Or use OAuth (PKCE) with:

```
Authorization URL: https://developer.heysalad.app/oauth/authorize
Token URL: https://developer.heysalad.app/oauth/token
Scope: <driver|kitchen|logistics|...>
MCP URL (post-auth): https://mcp.heysalad.app/mcp
```

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

Keep this file close when onboarding new agents so they can self-serve credentials and understand which endpoints they should call.

---

### 6. HeySaladX Orchestrator & Specialist Agents

- **HeySaladX (Node CLI)** lives at `agents/heysaladx/bin/heysaladx.js`. Run `npm run heysaladx` to drop into the enhanced interactive REPL with rich terminal UI (persistent history, `/help`, `/chain`, `/select-agents`, `/priority`, `/history`, `/quit` commands) or pass a single instruction (`npm run heysaladx -- "Plan MCP + firmware rollout"`). Features custom cooking spinner, brand colors, and interactive prompts. It gathers outputs from the delegated agents, optionally calls OpenAI/Codex, and synthesizes everything via GPT-OSS-120B. Flags: `--chain`, `--skip-summary`, `--json`, `--history`, `--system`, `--list-agents`, `--plain`.
- **Hardware & Firmware Agent** (`agents/hardware_agent.py`) understands Raspberry Pi bring-up, PlatformIO, Arduino/C++, Python, and web stack glue. Point it at the KellAI repo (`export KELLAI_REPO=/path/to/KellAI` if not already located at `~/KellAI`) and optionally add an SSH probe with `--probe-rpi admin@raspbx --probe-command "uname -a"` to feed Pi diagnostics into the model before reasoning.
- **Autonomous GPT-OSS Developer** (`agents/autodev_agent.py`) is the free-form “smartest chatbot” persona—just give it a prompt and it will reason about your request without extra scaffolding. Chain it from HeySaladX via `/chain autodev` or run the script directly for quick ideation.
- **File Ops Agent** (`agents/file_ops_agent.py`) gives GPT-OSS the ability to scan, read, and write files inside the repo (`list_repo_files`, `search_repo`, `read_repo_file`, `write_repo_file`). Useful for generating patches or scaffolding new files on the fly. Chain via `/chain fileops` or call the script directly.
- **Prompt Curator Agent** (`agents/prompt_agent.py`) manages prompt/response archives. Use it to refine instructions, list recent asks, or persist curated prompts before handing work to other agents (`/chain prompt` in HeySaladX).
