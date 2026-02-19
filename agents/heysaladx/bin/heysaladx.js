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

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

import pc from "picocolors";
import chalk from "chalk";
import boxen from "boxen";
import { Command } from "commander";
import { OpenAI } from "openai";
import { marked } from "marked";
import TerminalRendererMod from "marked-terminal";
import wordWrap from "word-wrap";
import inquirer from "inquirer";

const TerminalRenderer = TerminalRendererMod?.default || TerminalRendererMod;

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, "..", "..", "..");
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
    prefix: "x>",
    borderColor: useStyle ? "#dcdcdc" : COLORS.peach,
    backgroundColor: useStyle ? "#2b2b2b" : COLORS.peach,
    textColor: useStyle ? "#ffffff" : COLORS.userText,
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
const STATUS_BAR_FRAMES = [
  "▓▒░░░░░░",
  "▒░░░░░░▓",
  "░░░░░░▓▒",
  "░░░░░▓▒░",
  "░░░░▓▒░░",
  "░░▓▒░░░░",
  "▓▒░░░░░░",
  "▒░░░░░░▓"
];
const STATUS_ACTIONS = {
  cooking: { label: "cooking" },
  thinking: { label: "thinking" },
  analyzing: { label: "analyzing" },
  building: { label: "building" },
  deploying: { label: "deploying" }
};
const TIP_MESSAGES = [
  "Context low. Try /summarize to compress history",
  "Use 'esc' to interrupt long operations",
  "Type /chain prompt for AI-powered prompts",
  "Run heysaladx --no-codex for plain output",
  "Check AGENTS.md for all available agents"
];
const CHECKBOXES = {
  TODO: useStyle ? chalk.hex("#666666")("[ ]") : "[ ]",
  DOING: useStyle ? chalk.hex("#faa09a").bold("[⚡]") : "[⚡]",
  DONE: useStyle ? chalk.hex("#00ff00").bold("[x]") : "[x]",
  ERROR: useStyle ? chalk.hex("#ff0000").bold("[✗]") : "[✗]"
};
const TEXT_STYLES = {
  primary: (text) => (useStyle ? chalk.bold.hex(COLORS.peach)(text) : text),
  normal: (text) => (useStyle ? chalk.white(text) : text),
  muted: (text) => (useStyle ? chalk.dim(text) : text),
  success: (text) => (useStyle ? chalk.bold.hex("#00ff00")(text) : text),
  error: (text) => (useStyle ? chalk.bold.hex("#ff0000")(text) : text)
};
function formatHeader(text) {
  return TEXT_STYLES.primary(text);
}

function formatAccent(text) {
  return TEXT_STYLES.normal(text);
}

function formatMuted(text) {
  return TEXT_STYLES.muted(text);
}

function formatPercentage(current, total) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  return TEXT_STYLES.primary(`${percent}%`);
}
const collapseQueue = [];
const GIT_REFRESH_INTERVAL = 5000;
let successCommandCount = 0;
let lastTipContextPercent = 100;
let lastTipTime = 0;
let promptContext = { branch: "main", ahead: 0, percent: 72 };
let pendingStatusLine = null;
let lastGitStatusCheck = 0;
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;

function getContextPercent(historyLength = 0) {
  const clamped = Math.max(0, historyLength);
  return Math.max(5, Math.min(95, 100 - Math.min(clamped * 2, 80)));
}

function refreshGitContext() {
  const now = Date.now();
  if (now - lastGitStatusCheck < GIT_REFRESH_INTERVAL) {
    return;
  }
  lastGitStatusCheck = now;
  try {
    const result = spawnSync("git", ["status", "-sb"], {
      cwd: REPO_ROOT,
      encoding: "utf-8"
    });
    if (result.status !== 0) {
      return;
    }
    const line = (result.stdout || "").split("\n")[0] || "";
    const branchPart = line.replace(/^##\s+/, "").split("...")[0].trim();
    if (branchPart) {
      promptContext.branch = branchPart;
    }
    const aheadMatch = line.match(/ahead (\d+)/);
    promptContext.ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  } catch (error) {
    // ignore git errors
  }
}

function getPromptMarker() {
  return TEXT_STYLES.primary("x> ");
}

function buildContextLine() {
  const percentColor =
    promptContext.percent > 60
      ? chalk.green
      : promptContext.percent >= 30
      ? chalk.yellow
      : chalk.red;
  const percentText = percentColor(`${promptContext.percent}% context`);
  const aheadText = promptContext.ahead ? ` ↑${promptContext.ahead}` : "";
  return TEXT_STYLES.muted(`[${promptContext.branch}${aheadText}] ${percentText}`);
}

function updatePromptContext(rl, historyLength = 0) {
  promptContext.percent = getContextPercent(historyLength);
  refreshGitContext();
  if (rl) {
    rl.setPrompt(getPromptMarker());
  }
  return buildContextLine();
}

function showPrompt(rl) {
  console.log(renderContextBar());
  rl.prompt();
}

function renderContextBar() {
  const contextLine = buildContextLine();
  if (!useStyle) {
    return contextLine;
  }
  return chalk.bgHex("#1b1b1b").white(` ${contextLine} `);
}

function logAction(message) {
  console.log(TEXT_STYLES.normal(`• ${message}`));
}

class StatusLine {
  constructor(action = "thinking", detail = "") {
    this.action = action;
    this.detail = detail;
    this.frameIndex = 0;
    this.interval = null;
    this.started = false;
  }

  start() {
    if (!useSpinner) return;
    this.render();
    this.interval = setInterval(() => this.render(), 140);
    process.stdout.write("\x1B[?25l");
  }

  render() {
    const actionMeta = STATUS_ACTIONS[this.action] || { label: this.action };
    const frame = STATUS_BAR_FRAMES[this.frameIndex % STATUS_BAR_FRAMES.length];
    const detailSuffix = this.detail ? ` ${chalk.dim(this.detail)}` : "";
    const statusText = `[HeySaladX] • ${actionMeta.label}... ${frame}${detailSuffix}`;
    if (!this.started) {
      process.stdout.write(`${statusText}\n`);
      this.started = true;
    } else {
      process.stdout.write("\x1b[1A\x1b[K" + statusText + "\n");
    }
    this.frameIndex++;
  }

  update(action, detail) {
    if (action) {
      this.action = action;
    }
    if (detail) {
      this.detail = detail;
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.started) {
      process.stdout.write("\x1b[1A\x1b[K");
    }
    process.stdout.write("\x1B[?25h");
  }
}

function startStatusLine(action = "thinking", detail = "") {
  if (!useSpinner) return null;
  const line = new StatusLine(action, detail);
  pendingStatusLine = line;
  line.start();
  return line;
}
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

function renderStartupCard(currentChain = []) {
  if (!useStyle) {
    console.log("HeySaladX Interactive Session");
    return;
  }
  const modelName = process.env.HEYSALADX_MODEL || "deepseek-chat";
  const chainDisplay = currentChain.length ? currentChain.join(" · ") : "autodev";
  const directoryDisplay = path.relative(os.homedir(), REPO_ROOT) || "~";
  const headerLines = [
    "╭───────────────────────────────────────────────╮",
    `│ >_ HeySaladX (${process.env.HEYSALADX_VERSION || "v1.0.0"})                           │`,
    `│ model:     ${modelName.padEnd(24)} /model to change │`,
    `│ chain:     ${chainDisplay.padEnd(24)} /chain to change │`,
    `│ directory: ${directoryDisplay.padEnd(24)} /pwd       │`,
    "╰───────────────────────────────────────────────╯"
  ];
  console.log(headerLines.join("\n"));
}

function displayStartupHints() {
  const hints = [
    "• /help   - show commands",
    "• /chain  - adjust delegation chain",
    "• /status - show session config",
    "• /quit   - exit cleanly",
    "",
    "Use Enter on a blank line to expand collapsed output."
  ];
  hints.forEach((line) => console.log(line));
}

// Wrapped text with proper formatting
function formatWrappedText(text, width = 80) {
  if (!useStyle) return text;
  return wordWrap(text, { width, indent: "" });
}

function renderTaskRow(item = {}) {
  const { title = "Task", status = "TODO", meta = "" } = typeof item === "string" ? { title: item } : item;
  const checkbox = CHECKBOXES[status.toUpperCase()] || CHECKBOXES.TODO;
  const name = TEXT_STYLES.normal(title);
  const suffix = meta ? ` ${TEXT_STYLES.muted(meta)}` : "";
  const bullet = TEXT_STYLES.normal("•");
  return `${bullet} ${checkbox} ${name}${suffix}`;
}

function displayTaskList(tasks = []) {
  if (!tasks.length) return;
  tasks.forEach((task) => {
    console.log(renderTaskRow(task));
  });
}

function renderPromptBox(title, lines = []) {
  const content = [title, ...lines].filter(Boolean).join("\n");
  return boxen(content, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: 0,
    borderColor: COLORS.peach,
    borderStyle: "round"
  });
}

async function promptYesNo(rl, config = {}) {
  const {
    title = "Confirm action",
    detail = "",
    yesLabel = "YES, commit now",
    noLabel = "NO, let me review"
  } = config;
  const box = renderPromptBox(`🍅 ${title}`, [
    detail,
    "",
    `   [1] ✔ ${yesLabel}`,
    `   [2] ✘ ${noLabel}`,
    "",
    "   (press 1-2 or use arrow keys)"
  ]);
  console.log(box);
  const prompt = [
    {
      type: "list",
      name: "choice",
      message: "",
      choices: [
        { name: `[1] ✔ ${yesLabel}`, value: true },
        { name: `[2] ✘ ${noLabel}`, value: false }
      ],
      prefix: ""
    }
  ];
  rl.pause();
  const { choice } = await inquirer.prompt(prompt);
  rl.resume();
  return choice;
}

async function promptMultiSelect(rl, config = {}) {
  const {
    title = "Select options",
    detail = "",
    choices = [],
    hint = "↑↓ navigate  Space select  Enter done"
  } = config;
  const body = [detail, "", `   ${hint}`];
  console.log(renderPromptBox(`🍳 ${title}`, body));
  const prompt = [
    {
      type: "checkbox",
      name: "selected",
      message: "",
      choices: choices.map((choice) => ({
        name: `${choice.checked ? CHECKBOXES.DONE : CHECKBOXES.TODO} ${choice.label}`,
        value: choice.value ?? choice.label,
        checked: Boolean(choice.checked)
      })),
      prefix: ""
    }
  ];
  rl.pause();
  const { selected } = await inquirer.prompt(prompt);
  rl.resume();
  return selected;
}

function queueCollapsibleOutput(title, lines = []) {
  const preview = lines.slice(0, 5);
  console.log(TEXT_STYLES.primary(title));
  console.log("↳");
  preview.forEach((line) => console.log(`  ${line}`));
  if (lines.length > preview.length) {
    console.log(`  … +${lines.length - preview.length} lines (press enter to expand)`);
    collapseQueue.push({ title, remaining: lines.slice(preview.length) });
  }
}

function expandNextCollapsedOutput() {
  if (!collapseQueue.length) {
    return false;
  }
  const { title, remaining } = collapseQueue.shift();
  console.log(TEXT_STYLES.normal(`Expanded: ${title}`));
  remaining.forEach((line) => console.log(`  ${line}`));
  return true;
}

function maybeShowTip({ fromLongWait = false, contextPercent = 100 }) {
  successCommandCount += 1;
  const randomTrigger = Math.random() < 0.1;
  const milestoneTrigger = successCommandCount % 5 === 0;
  const contextTrigger = contextPercent < 40 && contextPercent !== lastTipContextPercent;
  const longWaitTrigger = fromLongWait;
  if (!(randomTrigger || milestoneTrigger || contextTrigger || longWaitTrigger)) {
    return;
  }
  lastTipContextPercent = contextPercent;
  const tip = TIP_MESSAGES[Math.floor(Math.random() * TIP_MESSAGES.length)];
  const box = boxen(`Tip: ${tip}`, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderColor: COLORS.peach,
    borderStyle: "round"
  });
  console.log(box);
  lastTipTime = Date.now();
}

function startSpinner(detail = "orchestrating", action = "thinking") {
  const status = startStatusLine(action, detail);
  if (!status) return null;
  return () => {
    status.stop();
    pendingStatusLine = null;
  };
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
  const label = formatHeader(`\n${title}`);
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
  logAction(`Running ${spec.title}`);
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
  // Try DeepSeek first (free tier, no token required)
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  const hfToken = process.env.HF_TOKEN;
  
  let client;
  let model;
  
  if (deepseekApiKey) {
    // Use DeepSeek
    client = new OpenAI({
      apiKey: deepseekApiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
    });
    model = process.env.HEYSALADX_MODEL || "deepseek-chat";
  } else if (hfToken) {
    // Fall back to GPT-OSS via Hugging Face
    client = new OpenAI({
      apiKey: hfToken,
      baseURL: process.env.HF_BASE_URL || "https://router.huggingface.co/v1"
    });
    model = process.env.HEYSALADX_MODEL || "openai/gpt-oss-120b:groq";
  } else {
    throw new Error(
      "No API key found. Set either DEEPSEEK_API_KEY (recommended) or HF_TOKEN. " +
      "Get DeepSeek API key from: https://platform.deepseek.com/api_keys"
    );
  }

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
    model,
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

async function printResult(result, promptText, contextPercent = 100, longWait = false) {
  const agentKeys = Object.keys(result.delegated);
  if (agentKeys.length) {
    logAction(`Delegated context ingested from: ${agentKeys.join(", ")}`);
    logAction(`Context processed: ${formatPercentage(agentKeys.length, Object.keys(SUB_AGENTS).length)}`);
  }
  if (result.codex) {
    logAction("Codex helper output included.");
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
    links.forEach((link) => console.log(formatAccent(`• ${link}`)));
  }

  const tasks = extractTasksFromText(texts);
  if (tasks.length) {
    printSection("Next Tasks / TODO");
    displayTaskList(tasks);
    persistTodoEntries(tasks, promptText);
    console.log(formatMuted(`Tasks appended to ${path.relative(REPO_ROOT, TODO_PATH)}.`));
  }
  maybeShowTip({ fromLongWait: longWait, contextPercent });
}

function printHistoryTranscript(history) {
  if (!history.length) {
    console.log(pc.dim("No conversation history yet."));
    return;
  }
  history.forEach((entry, idx) => {
    console.log(pc.bold(`[${idx + 1}] ${entry.role}`));
    const lines = entry.content.split("\n");
    if (lines.length > 8) {
      queueCollapsibleOutput(`Entry ${idx + 1}: ${entry.role}`, lines);
    } else {
      console.log(entry.content);
    }
    console.log();
  });
}

async function startRepl(options, chainList) {
  brandBanner();
  renderStartupCard(chainList.length ? chainList : ["autodev"]);
  displayStartupHints();
  console.log();

  let sessionHistory = [];
  try {
    sessionHistory = loadHistory(options.history);
  } catch (error) {
    console.warn(pc.red(`Failed to load history: ${error.message}`));
    sessionHistory = [];
  }

  let currentChain = chainList.length ? [...chainList] : ["autodev"];
  if (!chainList.length) {
    console.log(TEXT_STYLES.muted("Default delegation chain → autodev (change via /chain)."));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPromptMarker(),
    historySize: 200
  });
  rl.history = loadCliHistory();
  updatePromptContext(rl, sessionHistory.length);
  showPrompt(rl);

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
    async help() {
      console.log(
        [
          "/help            Show this help message",
          "/agents          List available delegated agents",
          "/chain           Show current delegation chain",
          "/chain <a,b>     Update delegation chain (comma separated IDs)",
          "/history         Print the chat transcript for this session",
          "/clear           Clear conversation history (memory only)",
          "/expand          Reveal collapsed output",
          "/quit            Exit the session"
        ].join("\n")
      );
    },
    async agents() {
      listAgents();
    },
    async chain(arg) {
      if (!arg) {
        const choices = Object.entries(SUB_AGENTS).map(([key, spec]) => ({
          label: `${key} · ${spec.title}`,
          value: key,
          checked: currentChain.includes(key)
        }));
        const selected = await promptMultiSelect(rl, {
          title: "Select agents to chain",
          detail: "Toggle the agents you want to consult next.",
          choices
        });
        currentChain = selected || [];
        if (currentChain.length) {
          console.log(formatAccent(`Delegation chain updated → ${currentChain.join(", ")}`));
        } else {
          console.log(formatMuted("No agents chained. Use /chain dev,qwen to add some."));
        }
        return;
      }
      const next = parseChain(arg);
      currentChain = next;
      console.log(
        currentChain.length
          ? formatAccent(`Delegation chain updated → ${currentChain.join(", ")}`)
          : formatMuted("Delegation chain cleared.")
      );
    },
    async history() {
      printHistoryTranscript(sessionHistory);
    },
    async clear() {
      sessionHistory = [];
      console.log(formatMuted("Session history cleared."));
    },
    async quit() {
      const confirmed = await promptYesNo(rl, {
        title: "Ready to exit?",
        detail: "Save history and close HeySaladX?",
        yesLabel: "YES, exit",
        noLabel: "NO, stay"
      });
      if (confirmed) {
        persistAndExit();
      }
    },
    async exit() {
      await commandHandlers.quit();
    },
    async expand() {
      if (!expandNextCollapsedOutput()) {
        console.log(formatMuted("Nothing to expand right now."));
      }
    }
  };

  const handleCommand = async (raw) => {
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
    await handler(rest.trim());
  };

  showPrompt(rl);
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      if (expandNextCollapsedOutput()) {
        showPrompt(rl);
        return;
      }
      showPrompt(rl);
      return;
    }
    if (trimmed.startsWith("/") || trimmed.startsWith(":")) {
      await handleCommand(trimmed);
      showPrompt(rl);
      return;
    }
    renderUserMessage(trimmed);
    const startTime = Date.now();
    const stopSpinner = startSpinner("Orchestrating with HeySaladX", "analyzing");
    let result;
    try {
      result = await runWorkflow(trimmed, options, currentChain, sessionHistory);
    } catch (error) {
      stopSpinner?.();
      console.error(pc.red(`Failed to process request: ${error.message}`));
      console.log();
      showPrompt(rl);
      return;
    }
    stopSpinner?.();
    console.log();
    const durationMs = Date.now() - startTime;
    const contextPercent = getContextPercent(sessionHistory.length);
    try {
      await printResult(result, trimmed, contextPercent, durationMs >= 10000);
      const assistantMessage = result.summary || delegatedSummary(result) || "(no response)";
      sessionHistory.push({ role: "user", content: trimmed });
      sessionHistory.push({ role: "assistant", content: assistantMessage });
      saveHistory(options.history, sessionHistory);
      updatePromptContext(rl, sessionHistory.length);
    } catch (error) {
      console.error(pc.red(`Failed to process request: ${error.message}`));
    }
    console.log();
    showPrompt(rl);
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
  const startTime = Date.now();
  let stopSpinner = null;
  if (!opts.json) {
    stopSpinner = startSpinner("Orchestrating with HeySaladX", "analyzing");
  }
  let result;
  try {
    result = await runWorkflow(task, opts, chainList, null);
  } catch (error) {
    stopSpinner?.();
    console.error(pc.red(`Orchestration failed: ${error.message}`));
    if (error.message.includes("DEEPSEEK_API_KEY")) {
      console.log(formatMuted("Get your free API key from: https://platform.deepseek.com/api_keys"));
    }
    process.exit(1);
  }
  if (stopSpinner) {
    stopSpinner();
    console.log();
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const contextPercent = getContextPercent(0);
    const durationMs = Date.now() - startTime;
    await printResult(result, task, contextPercent, durationMs >= 10000);
  }
}

main().catch((error) => {
  console.error(pc.red(`heysaladx failed: ${error.message}`));
  process.exit(1);
});
