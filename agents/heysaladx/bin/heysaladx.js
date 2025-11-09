#!/usr/bin/env node

/**
 * HeySaladX orchestrator CLI (Codex-style interactive session).
 *
 * - Delegates requests to repo-aware sub-agents (DeepSeek, Qwen, senior reviewer, hardware, etc.)
 * - Optionally consults OpenAI Codex/GPT when OPENAI_API_KEY is set.
 * - Synthesizes final guidance with GPT-OSS-120B via Hugging Face (HF_TOKEN required).
 *
 * Run with no arguments to enter an interactive REPL, or pass a task for single-shot mode:
 *   npm run heysaladx
 *   npm run heysaladx -- "Ship MCP + KellAI OTA rollout"
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const process = require("node:process");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const pc = require("picocolors");
const chalk = require("chalk");
const boxen = require("boxen");
const ora = require("ora");
const { Command } = require("commander");
const { OpenAI } = require("openai");
const marked = require("marked");
const TerminalRendererMod = require("marked-terminal");
const TerminalRenderer = TerminalRendererMod?.default || TerminalRendererMod;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLI_HISTORY_FILE = path.join(os.homedir(), ".heysaladx_history");
const TODO_PATH = path.join(REPO_ROOT, "heysaladx.todo.md");
const DEFAULT_SYSTEM_PROMPT =
  "You are HeySaladX, the orchestration brain that coordinates every HeySalad agent. " +
  "Blend insights from specialized sub-agents, hardware probes, and Codex-style models. " +
  "Always cite which agent produced which insight, recommend next actions, and call out risks.";
let useStyle = true;
let useSpinner = true;
let animationDelay = Math.max(0, Number(process.env.HEYSALADX_ANIMATE_DELAY ?? "2"));
const wrapColor = (colorFn) => (text) => (useStyle ? colorFn(text) : text);
const BRAND = {
  primary: wrapColor(pc.magentaBright),
  accent: wrapColor(pc.white),
  muted: wrapColor(pc.dim)
};
const COLORS = {
  header: "#ed4c4c",
  peach: "#faa09a",
  dark: "#1a1a1a",
  userText: "#1a1a1a",
  aiText: "#ffffff"
};
const BOX_STYLES = {
  user: {
    prefix: "$",
    borderColor: COLORS.peach,
    backgroundColor: COLORS.peach,
    textColor: COLORS.userText,
    alignRight: true
  },
  ai: {
    prefix: ">",
    borderColor: COLORS.dark,
    backgroundColor: COLORS.dark,
    textColor: COLORS.aiText,
    alignRight: false
  }
};
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
const getPrompt = () => (useStyle ? chalk.hex(COLORS.peach)("heysaladx> ") : "heysaladx> ");
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: false,
    showSectionPrefix: false,
    tab: 2
  })
});

const SUB_AGENTS = {
  dev: {
    title: "DeepSeek LangChain Dev Agent",
    command: "python",
    args: ["agents/dev_agent.py"]
  },
  qwen: {
    title: "Qwen Full Stack Agent",
    command: "python",
    args: ["agents/qwen_agent.py"]
  },
  senior: {
    title: "Senior Engineering Agent (GPT-OSS-120B)",
    command: "python",
    args: ["agents/senior_engineer_agent.py"]
  },
  safety: {
    title: "GPT OSS Safeguard Agent",
    command: "python",
    args: ["agents/safety_agent.py"]
  },
  hardware: {
    title: "Hardware & Firmware Agent (KellAI + MCP)",
    command: "python",
    args: ["agents/hardware_agent.py"]
  },
  deepseek: {
    title: "DeepSeek Coding Agent",
    command: "python",
    args: ["agents/deepseek_coding_agent.py"]
  },
  autodev: {
    title: "Autonomous GPT-OSS Developer",
    command: "python",
    args: ["agents/autodev_agent.py"]
  },
  fileops: {
    title: "File Ops Agent (scan/create/write)",
    command: "python",
    args: ["agents/file_ops_agent.py"]
  },
  prompt: {
    title: "Prompt Curator Agent",
    command: "python",
    args: ["agents/prompt_agent.py"]
  }
};

function listAgents() {
  console.log(BRAND.primary("Available sub-agents:"));
  Object.entries(SUB_AGENTS).forEach(([key, spec]) => {
    console.log(`  ${pc.magenta(key.padEnd(10))} ${pc.white("·")} ${BRAND.accent(spec.title)}`);
  });
}

function brandBanner() {
  if (!useStyle) {
    console.log("HeySaladX Interactive Session\n");
    return;
  }
  const header = boxen(chalk.bgHex(COLORS.header).white.bold(" HeySaladX │ Autonomous Dev Console "), {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    borderColor: COLORS.header,
    borderStyle: "round"
  });
  console.log(`${header}\n`);
}

function startSpinner(text) {
  if (!useSpinner) {
    return null;
  }
  const spinner = ora({ text, color: "red" }).start();
  return () => spinner.stop();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripAnsi(text = "") {
  return text.replace(ANSI_REGEX, "");
}

function renderMarkdown(text) {
  if (!text) return "";
  const rendered = marked.parse(text);
  return stripAnsi(rendered).trimEnd();
}

function alignRight(block) {
  if (!useStyle) {
    return block;
  }
  const width = process.stdout.columns || 80;
  return block
    .split("\n")
    .map((line) => {
      const len = stripAnsi(line).length;
      if (len >= width) {
        return line;
      }
      return `${" ".repeat(width - len)}${line}`;
    })
    .join("\n");
}

function buildBox(text, role) {
  const cfg = BOX_STYLES[role];
  const body = `${cfg.prefix} ${text}`;
  if (!useStyle) {
    return body;
  }
  const colored = chalk.hex(cfg.textColor)(body);
  return boxen(colored, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: "round",
    borderColor: cfg.borderColor,
    backgroundColor: cfg.backgroundColor
  });
}

async function streamPlainText(text) {
  const delay = Math.min(animationDelay, 10);
  if (!useStyle || delay <= 0) {
    console.log(text);
    return;
  }
  for (const char of `${text}\n`) {
    process.stdout.write(char);
    await sleep(delay);
  }
}

async function streamBox(block, alignRightOutput = false) {
  const output = alignRightOutput ? alignRight(block) : block;
  const delay = Math.min(animationDelay, 10);
  if (!useStyle || delay <= 0) {
    console.log(output);
    return;
  }
  for (const char of `${output}\n`) {
    process.stdout.write(char);
    await sleep(delay);
  }
}

function renderUserMessage(text) {
  if (!text) return;
  const box = buildBox(text, "user");
  if (!useStyle) {
    console.log(box);
    return;
  }
  console.log(alignRight(box));
}

async function renderAiMessage(text) {
  if (!text) return;
  const body = renderMarkdown(text);
  const box = buildBox(body, "ai");
  if (!useStyle) {
    await streamPlainText(box);
    return;
  }
  await streamBox(box, BOX_STYLES.ai.alignRight);
}

function printSection(title) {
  const label = useStyle ? chalk.hex(COLORS.header).bold(`\n${title}`) : `\n${title}`;
  console.log(label);
}

function extractLinksFromText(texts) {
  const regex = /https?:\/\/[^\s)>\]]+/gi;
  const links = new Set();
  texts.filter(Boolean).forEach((text) => {
    const matches = text.match(regex);
    if (matches) {
      matches.forEach((link) => links.add(link));
    }
  });
  return Array.from(links);
}

function extractTasksFromText(texts) {
  const tasks = [];
  const seen = new Set();
  const candidateRegex = /^(\-|\*|\d+\.)\s+/;
  texts
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line) return;
      let normalized = line;
      if (candidateRegex.test(line)) {
        normalized = line.replace(candidateRegex, "").trim();
      } else if (/^(todo|task|action)[:\s]/i.test(line)) {
        normalized = line.replace(/^(todo|task|action)[:\s]*/i, "").trim();
      } else {
        return;
      }
      if (normalized.length < 4) return;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tasks.push(normalized);
      }
    });
  return tasks.slice(0, 5);
}

function persistTodoEntries(tasks, prompt) {
  if (!tasks.length) return;
  const timestamp = new Date().toISOString();
  const block = [
    `## ${timestamp}`,
    `Prompt: ${prompt}`,
    ...tasks.map((task) => `- [ ] ${task}`),
    ""
  ].join("\n");
  fs.appendFileSync(TODO_PATH, block, { encoding: "utf-8" });
}

function parseChain(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .filter((id) => SUB_AGENTS[id]);
}

function runSubAgent(agentId, task) {
  const spec = SUB_AGENTS[agentId];
  if (!spec) {
    return `Unknown agent '${agentId}'.`;
  }
  const child = spawnSync(spec.command, [...spec.args, task], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (child.error) {
    return `Failed to run ${spec.title}: ${child.error.message}`;
  }
  if (child.status !== 0) {
    const details = child.stdout?.trim() || child.stderr?.trim() || `exit code ${child.status}`;
    return `Failed to run ${spec.title}: ${details}`;
  }
  return (child.stdout || "").trim();
}

async function callCodex(task, contextBlocks) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  try {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: process.env.HEYSALADX_CODEX_MODEL || "gpt-4o-mini",
      max_tokens: Number(process.env.HEYSALADX_CODEX_MAX_TOKENS || 600),
      temperature: Number(process.env.HEYSALADX_CODEX_TEMPERATURE || 0.4),
      messages: [
        {
          role: "system",
          content: "You are the HeySaladX coding co-pilot (Codex). Provide concise diffs and commands."
        },
        {
          role: "user",
          content: `Task: ${task}\n\nContext:\n${contextBlocks.join("\n\n---\n\n")}`
        }
      ]
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch (error) {
    return `Codex request failed: ${error.message}`;
  }
}

function loadHistory(filePath) {
  if (!filePath) {
    return [];
  }
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  if (!Array.isArray(data)) {
    throw new Error("History file must contain an array of {role, content} objects.");
  }
  return data;
}

function saveHistory(filePath, history) {
  if (!filePath) {
    return;
  }
  const resolved = path.resolve(process.cwd(), filePath);
  fs.writeFileSync(resolved, JSON.stringify(history, null, 2));
}

function loadCliHistory() {
  try {
    const data = fs.readFileSync(CLI_HISTORY_FILE, "utf-8");
    return data.split("\n").filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function saveCliHistory(history) {
  try {
    const lines = (history || []).slice().reverse().join("\n");
    fs.writeFileSync(CLI_HISTORY_FILE, lines, "utf-8");
  } catch {
    // ignore
  }
}

async function orchestrate(task, options, contextBlocks, historyMessages) {
  const token = process.env.HF_TOKEN;
  if (!token) {
    throw new Error("HF_TOKEN is required to contact GPT-OSS-120B. Export it before running heysaladx.");
  }
  const client = new OpenAI({
    apiKey: token,
    baseURL: process.env.HF_BASE_URL || "https://router.huggingface.co/v1"
  });

  const messages = [];
  const systemPrompt = options.system || DEFAULT_SYSTEM_PROMPT;
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  const history = historyMessages ?? loadHistory(options.history);
  if (history.length) {
    messages.push(...history);
  }

  const contextText = contextBlocks.length
    ? `Context from delegated agents:\n${contextBlocks.join("\n\n---\n\n")}\n\n`
    : "";
  messages.push({
    role: "user",
    content: `${contextText}Primary task:\n${task}`
  });

  const response = await client.chat.completions.create({
    model: process.env.HEYSALADX_MODEL || "openai/gpt-oss-120b:groq",
    max_tokens: Number(process.env.HEYSALADX_MAX_TOKENS || 900),
    temperature: Number(process.env.HEYSALADX_TEMPERATURE || 0.2),
    messages
  });
  return response.choices[0]?.message?.content?.trim() || "";
}

async function runWorkflow(task, options, chainList, historyMessages) {
  const effectiveChain = chainList.length ? chainList : ["autodev"];
  const contextBlocks = [];
  const delegated = {};

  if (effectiveChain.length) {
    for (const id of effectiveChain) {
      const output = runSubAgent(id, task);
      delegated[id] = output;
      contextBlocks.push(`${SUB_AGENTS[id].title} (${id})\n${output}`);
    }
  }

  let codexOutput = null;
  if (options.codex !== false) {
    const codex = await callCodex(task, contextBlocks);
    if (codex) {
      codexOutput = codex;
      contextBlocks.push(`OpenAI Codex Helper\n${codex}`);
    }
  }

  let summary = null;
  if (!options.skipSummary) {
    summary = await orchestrate(task, options, contextBlocks, historyMessages);
  }

  return {
    task,
    delegated,
    codex: codexOutput,
    summary,
    contextBlocks
  };
}

function delegatedSummary(result) {
  const lines = [];
  Object.entries(result.delegated).forEach(([agent, text]) => {
    lines.push(`[${agent}] ${SUB_AGENTS[agent].title}\n${text}`);
  });
  if (result.codex) {
    lines.push(`[codex]\n${result.codex}`);
  }
  return lines.join("\n\n").trim();
}

async function printResult(result, promptText) {
  const agentKeys = Object.keys(result.delegated);
  if (agentKeys.length) {
    console.log(BRAND.muted(`Delegated context ingested from: ${agentKeys.join(", ")}`));
  }
  if (result.codex) {
    console.log(BRAND.muted("Codex helper output included."));
  }

  let aiMessage;
  if (result.summary) {
    printSection("HeySaladX Summary");
    aiMessage = result.summary;
  } else {
    printSection("Delegated output (summary disabled)");
    aiMessage = delegatedSummary(result) || "No delegated responses available.";
  }
  await renderAiMessage(aiMessage);

  const texts = [
    result.summary,
    result.codex,
    ...Object.values(result.delegated)
  ].filter(Boolean);

  const links = extractLinksFromText(texts);
  if (links.length) {
    printSection("Links");
    links.forEach((link) => console.log(pc.underline(BRAND.accent(`• ${link}`))));
  }

  const tasks = extractTasksFromText(texts);
  if (tasks.length) {
    printSection("Next Tasks / TODO");
    tasks.forEach((task, idx) => console.log(BRAND.accent(`${idx + 1}. ${task}`)));
    persistTodoEntries(tasks, promptText);
    console.log(BRAND.muted(`Tasks appended to ${path.relative(REPO_ROOT, TODO_PATH)}.`));
  }
}

function printHistoryTranscript(history) {
  if (!history.length) {
    console.log(pc.dim("No conversation history yet."));
    return;
  }
  history.forEach((entry, idx) => {
    console.log(pc.bold(`[${idx + 1}] ${entry.role}`));
    console.log(entry.content);
    console.log();
  });
}

async function startRepl(options, chainList) {
  brandBanner();
  console.log(BRAND.muted("Type /help for commands, Ctrl+C to exit.\n"));

  let sessionHistory;
  try {
    sessionHistory = loadHistory(options.history);
  } catch (error) {
    console.warn(pc.red(`Failed to load history: ${error.message}`));
    sessionHistory = [];
  }

  let currentChain = chainList.length ? [...chainList] : ["autodev"];
  if (!chainList.length) {
    console.log(pc.dim("Default delegation chain → autodev (change via /chain)."));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
    historySize: 200
  });
  rl.history = loadCliHistory();

  const persistAndExit = () => {
    saveCliHistory(rl.history);
    try {
      saveHistory(options.history, sessionHistory);
    } catch (error) {
      if (options.history) {
        console.warn(pc.red(`Failed to save history: ${error.message}`));
      }
    }
    rl.close();
  };

  rl.on("SIGINT", () => {
    console.log();
    persistAndExit();
  });

  const commandHandlers = {
    help() {
      console.log(
        [
          "/help            Show this help message",
          "/agents          List available delegated agents",
          "/chain           Show current delegation chain",
          "/chain <a,b>     Update delegation chain (comma separated IDs)",
          "/history         Print the chat transcript for this session",
          "/clear           Clear conversation history (memory only)",
          "/quit            Exit the session"
        ].join("\n")
      );
    },
    agents: listAgents,
    chain(arg) {
      if (!arg) {
        console.log(
          currentChain.length
            ? `Current chain: ${currentChain.join(", ")}`
            : "No agents chained. Use /chain dev,qwen to add some."
        );
        return;
      }
      const next = parseChain(arg);
      currentChain = next;
      console.log(
        currentChain.length
          ? `Delegation chain updated → ${currentChain.join(", ")}`
          : "Delegation chain cleared."
      );
    },
    history() {
      printHistoryTranscript(sessionHistory);
    },
    clear() {
      sessionHistory = [];
      console.log(pc.dim("Session history cleared."));
    },
    quit() {
      persistAndExit();
    },
    exit() {
      persistAndExit();
    }
  };

  const handleCommand = (raw) => {
    const [, cmd = "", rest = ""] = raw.match(/^[:/](\w+)\s*(.*)$/) || [];
    if (!cmd) {
      console.log(pc.red("Unknown command. Type /help for a list of commands."));
      return;
    }
    const handler = commandHandlers[cmd.toLowerCase()];
    if (!handler) {
      console.log(pc.red(`Unknown command '${cmd}'. Type /help for help.`));
      return;
    }
    handler(rest.trim());
  };

  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed.startsWith("/") || trimmed.startsWith(":")) {
      handleCommand(trimmed);
      rl.prompt();
      return;
    }
    renderUserMessage(trimmed);
    const stopSpinner = startSpinner("Orchestrating with HeySaladX");
    let result;
    try {
      result = await runWorkflow(trimmed, options, currentChain, sessionHistory);
    } catch (error) {
      stopSpinner?.();
      console.error(pc.red(`Failed to process request: ${error.message}`));
      console.log();
      rl.prompt();
      return;
    }
    stopSpinner?.();
    console.log();
    try {
      await printResult(result, trimmed);
      const assistantMessage = result.summary || delegatedSummary(result) || "(no response)";
      sessionHistory.push({ role: "user", content: trimmed });
      sessionHistory.push({ role: "assistant", content: assistantMessage });
      saveHistory(options.history, sessionHistory);
    } catch (error) {
      console.error(pc.red(`Failed to process request: ${error.message}`));
    }
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    saveCliHistory(rl.history);
    process.exit(0);
  });
}

async function main() {
  const program = new Command();
  program
    .argument("[task...]", "Task for HeySaladX (omit for interactive session).")
    .option("-c, --chain <agents>", "Comma separated sub-agents to consult (e.g., dev,qwen,hardware).")
    .option("--skip-summary", false, "Skip GPT-OSS synthesis and only show delegated output.")
    .option("--no-codex", "Disable the OpenAI Codex/GPT helper even if OPENAI_API_KEY is set.")
    .option("--system <prompt>", "Override the orchestrator system instructions.")
    .option("--history <file>", "Optional JSON file used to persist chat history between runs.")
    .option("--list-agents", false, "List available agents and exit.")
    .option("--json", false, "Emit JSON with raw delegated outputs plus the summary when running once.")
    .option("--plain", false, "Disable colors, animation, and spinner output.")
    .allowExcessArguments(false)
    .parse(process.argv);

  const opts = program.opts();
  const plainMode = Boolean(opts.plain || process.env.HEYSALADX_PLAIN === "1");
  if (plainMode) {
    useStyle = false;
    useSpinner = false;
    animationDelay = 0;
  } else if (process.env.HEYSALADX_NO_SPINNER === "1") {
    useSpinner = false;
  }
  const listAgentsRequested = program.getOptionValueSource?.("listAgents") === "cli";

  if (opts.listAgents && listAgentsRequested) {
    listAgents();
    return;
  }

  const chainList = parseChain(opts.chain);
  const task = (program.args || []).join(" ").trim();

  if (!task) {
    await startRepl(opts, chainList);
    return;
  }

  renderUserMessage(task);
  let stopSpinner = null;
  if (!opts.json) {
    stopSpinner = startSpinner("Orchestrating with HeySaladX");
  }
  const result = await runWorkflow(task, opts, chainList, null);
  if (stopSpinner) {
    stopSpinner();
    console.log();
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    await printResult(result, task);
  }
}

main().catch((error) => {
  console.error(pc.red(`heysaladx failed: ${error.message}`));
  process.exit(1);
});
