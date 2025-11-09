# DeepSeek Developer Agent

Small LangChain agent that uses the DeepSeek API to answer developer questions about this repository.

## Prerequisites

- Python 3.10+ with `venv` available
- DeepSeek API key (`DEEPSEEK_API_KEY`) – create one at [platform.deepseek.com](https://platform.deepseek.com/)
- Optional: set `DEEPSEEK_MODEL`, `DEEPSEEK_API_BASE`, or `DEEPSEEK_TEMPERATURE` to customize the model, API endpoint, or creativity.

## Setup

```bash
cd ~/heysalad-mcp/agents
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
export DEEPSEEK_API_KEY=sk-your-key
python dev_agent.py "Summarize how API keys are validated in the server"
```

Flags:

- `--verbose` – bubble up LangChain tool traces (helpful when extending the agent)
- `--history history.json` – reuse a previous `chat_history` array saved to disk

## Built-in Tools

| Tool | Purpose |
| --- | --- |
| `list_repo_files(limit)` | Quick inventory of relevant files so the LLM can pick targets |
| `search_repo(keyword)` | Keyword search across source files (skips binaries and `node_modules`) |
| `read_repo_file(path)` | Fetches a truncated (4K char default) view of a file |

These cover the minimum viable loop for “read → reason → propose” workflows without granting the agent blanket shell access. Extend `agents/dev_agent.py` with more LangChain tools (tests, formatters, MCP calls, etc.) as your use cases grow.

---

# DeepSeek Coding Agent (Hugging Face Space)

Lightweight CLI that calls `https://deepseek-ai-deepseek-coder-33b-instruct.hf.space/--replicas/52w5c/` using `gradio_client`.

```bash
cd ~/heysalad-mcp/agents
python deepseek_coding_agent.py "Devise a plan for adding the MCP approval workflow."
```

Options:

- `--system` to override the system prompt (default clarifies HeySalad focus)
- `--include-file path` to inline specific file contents
- `--list-files N` to append a repository inventory
- `--search keyword` to include matching lines as context
- Sampling controls: `--max-new-tokens`, `--top-p`, `--top-k`, `--repetition-penalty`
- `--history history.json` to stash/replay conversations (JSON list of `{role,content}`)

`gradio_client` must be installed (see `requirements.txt`).

---

# GPT Safeguard Agent

CLI helper around the Hugging Face Router + `openai/gpt-oss-safeguard-20b:groq` model that performs policy screening for arbitrary prompts.

## Prerequisites

- Same virtualenv as above
- Hugging Face access token exported as `HF_TOKEN`

## Usage

```bash
export HF_TOKEN=hf_your_token
python safety_agent.py "Rate this kiosk conversation for safety concerns."
```

Flags:

- `--system` to override the default “HeySalad safety agent” instructions
- `--history history.json` to replay prior `{role, content}` messages
- `--stream` to stream tokens (mirrors the sample in the prompt)
- `--model` if you want to try a different router-hosted safeguard model

All responses go through `https://router.huggingface.co/v1`, so the CLI works anywhere you can set `HF_TOKEN`.

---

# Supabase Test Credentials

Give any agent (CLI or LLM) scoped access to a Supabase project by storing *non-production* credentials in `agents/.env.supabase.test`.

1. Copy the template and fill it with the test project values:
   ```bash
   cd ~/heysalad-mcp/agents
   cp .env.supabase.test.example .env.supabase.test
   $EDITOR .env.supabase.test
   ```
2. Use the helper to run Supabase CLI commands with those vars exported:
   ```bash
   ./supabase_cli_helper.sh status
   ./supabase_cli_helper.sh db remote commit --project-ref "$SUPABASE_PROJECT_ID"
   ```
3. For other tools (psql, scripts, agents), source the file:
   ```bash
   set -a && source .env.supabase.test && set +a
   python dev_agent.py "Seed the test DB using Supabase CLI."
   ```

`.env.supabase.test` stays out of git thanks to `.gitignore`, so you can safely rotate or replace credentials without committing secrets. Document clearly which schemas/tables test agents are allowed to mutate before handing out the file.

---

# Senior Engineering Agent

High-context CLI helper that routes prompts to `openai/gpt-oss-120b:groq` via Hugging Face’s API router. Tailored for full-stack design/code reviews.

```bash
export HF_TOKEN=hf_your_token
python senior_engineer_agent.py --stream "Outline the steps to add Supabase migrations to the MCP repo."
```

Options mirror the other agents:

- `--system` to tweak persona
- `--history @chat.json` to resume conversations
- `--temperature` / `--max-tokens`
- `--prompt @file.md` to send longer briefs from disk

---

# Qwen Full Stack Agent

`Qwen/Qwen-2.5-Coder-Artifacts` provides deep reasoning plus code generation for multi-file fixes. It exposes the same repo inspection tools (file listing/search/reader) so it can gather context before answering.

```bash
export HF_TOKEN=hf_your_token
python qwen_agent.py "Design a deployment pipeline that syncs HeySalad MCP with Supabase."
```

Use `--verbose` to reveal LangChain traces, or point the `task` argument at `@notes.md` for long-form prompts. The script automatically looks for `HF_TOKEN` or `HUGGINGFACEHUB_API_TOKEN` in the environment.

---

# Stability AI Image Helper

Lightweight CLI that calls Stability AI’s REST API (`stable-diffusion-v1-5` by default) via `stability_sdk`. Configure `STABILITY_API_KEY` (e.g., `sk-your-stability-key`), then run:

```bash
source .venv/bin/activate
export STABILITY_API_KEY=sk-your-stability-key
python stability_agent.py "Generate a neon HeySalad kiosk splash screen."
```

Adjust fidelity with `--steps`/`--scale`, override the engine via `--engine`, and capture outputs (PNG) into `agents/stability_outputs/` or specify `--out`.

---

# DeepSeek OCR Agent

Uses `deepseek-ai/DeepSeek-OCR:novita` via the Hugging Face router to describe screenshots.

```
export HF_TOKEN=hf_your_token
python deepseek_ocr_agent.py "Describe the text in the photo" --image https://example.com/photo.jpg
```

- `--stream` streams the model output.
- `--history chat.json` replays prior conversation turns.
- `--system` overrides the assistant prompt.

---

# Hardware & Firmware Agent (KellAI + MCP)

`hardware_agent.py` brings a hardware-focused GPT-OSS-120B persona with tools for both this repo and the [KellAI](https://github.com/Hey-Salad/KellAI) PlatformIO workspace.

```bash
export HF_TOKEN=hf_your_token
export KELLAI_REPO=~/KellAI  # optional if it already lives there
python hardware_agent.py --probe-rpi admin@raspbx \
  --probe-command "uname -a" \
  "Audit the KellAI bootloader and MCP provisioning flow."
```

Highlights:

- Tools to `read_hw_repo_file`, `search_hw_repo`, `list_hw_repo_files`, and dump `platformio.ini`
- Works across both MCP + KellAI trees (set `KELLAI_REPO` if cloned elsewhere)
- Optional SSH snapshot via `--probe-rpi <host>` to capture Pi diagnostics (`ssh` must be installed)
- `--max-chars` tunes file truncation limits when reading code

---

# File Ops Agent (Scan / Create / Write)

`file_ops_agent.py` equips GPT-OSS with repo-scoped file tools: listing, searching, reading,
and writing files (it will create directories as needed but stays within the MCP repo).

```bash
export HF_TOKEN=hf_your_token
python file_ops_agent.py "Create docs/DEPLOYMENT.md with rollout steps."
```

Available LangChain tools:

- `list_repo_files(limit)` – quick inventory
- `search_repo(keyword)` – textual search
- `read_repo_file(path)` – bounded file contents
- `write_repo_file(path, content)` – create/overwrite files

Chain it from HeySaladX via `/chain fileops` for automated patching flows.

---

# Prompt Curator Agent

`prompt_agent.py` keeps a running archive of curated prompts/responses, helping you refine
instructions before handing them to other agents.

```bash
export HF_TOKEN=hf_your_token
python prompt_agent.py "Write a prompt for scanning the MCP repo" \
  --history prompt_history.json
```

Built-in LangChain tools:

- `store_prompt(payload)` – save `{prompt,response,tags}` JSON blobs to `prompt_agent.log.json`
- `list_prompt_history(limit)` – preview the latest curated prompts

Use `/chain prompt` inside HeySaladX when you want every instruction vetted or logged automatically.

---

# Autonomous GPT-OSS Developer

`autodev_agent.py` is the “always-on” conversational expert—no extra tooling, just a
smart GPT-OSS model that understands user intent and produces actionable plans/code.

```bash
export HF_TOKEN=hf_your_token
python autodev_agent.py "Scan the repo for security issues and propose fixes."
```

Flags:

- `--system`, `--model`, `--max-tokens`, `--temperature` for persona tweaks
- `--history history.json` to continue prior chats
- `--stream` for live token streaming

Tip: chain this agent from HeySaladX via `/chain autodev` (or `-c autodev`) when you
want a free-form assistant to lead the response.

---

# HeySaladX Orchestrator (Node CLI)

`agents/heysaladx/bin/heysaladx.js` is the “control tower” that chains multiple agents, Codex/GPT helpers, and produces an aggregated plan via GPT-OSS-120B. Now with enhanced ESM-based interactive terminal UI.

```bash
cd ~/heysalad-mcp
npm run heysaladx                # interactive REPL with rich UI (type /help once inside)
npm run heysaladx -- --list-agents
HF_TOKEN=hf_your_token OPENAI_API_KEY=sk-... npm run heysaladx -- \
  -c dev,hardware,qwen "Ship the MCP + firmware update workflow"
```

## Enhanced UI Features

- **ESM Migration**: Full ES Modules support with modern import/export syntax
- **Cooking Theme**: Custom spinner: `[HeySaladX] cooking... ▓▒░░░░ 🍳` with rotating emojis
- **Brand Colors**: Peach (#faa09a) and cherry red (#ed4c4c) throughout
- **Interactive Prompts**: Checkbox selections and priority settings
- **Task Visualization**: Checkbox states: [ ] todo, [⚡] doing, [x] done
- **Context Indicators**: Percentage completion and progress tracking

## REPL Commands

- `/help` – list commands
- `/chain <ids>` – view or update delegated agents (`dev`, `qwen`, `hardware`, etc.)
- `/select-agents` – interactive checkbox selection of agents
- `/priority` – set task priority with visual indicators
- `/history` – print the current transcript (persists if `--history file.json` is set)
- `/agents`, `/clear`, `/quit`

## One-off Flags

- `--chain dev,qwen,hardware` – run those agents first and feed their output into the orchestrator
- `--skip-summary` – only print delegated output (no GPT-OSS summary)
- `--json` – emit machine-readable results (delegated outputs, Codex response, summary)
- `--history history.json` / `--system prompt` – customize or persist the GPT-OSS orchestration context
- `--list-agents` – print the agent table and exit
- `--plain` – disable enhanced UI (colors, spinner, animations) for backward compatibility

## Environment Variables

- `HF_TOKEN` (required for the GPT-OSS summary), `HF_BASE_URL`, `HEYSALADX_MODEL/TEMPERATURE/MAX_TOKENS`
- `OPENAI_API_KEY` (optional) plus `HEYSALADX_CODEX_MODEL/TEMPERATURE/MAX_TOKENS` for the Codex helper
- `HEYSALADX_PLAIN=1` – enable plain mode (equivalent to `--plain`)

**Tip**: Run `npm link` inside the repo to install the `heysaladx` binary globally, then invoke it from any directory. The REPL automatically logs derived tasks to `heysaladx.todo.md`; open that file anytime for a running backlog.
