#!/usr/bin/env node
/**
 * Measurements against the installed Claude Code.
 *
 *   node ... scripts/measure.mjs session        token velocity and cache reuse
 *   node ... scripts/measure.mjs cache          the same with a padded instruction block
 *   node ... scripts/measure.mjs restart        cache reuse across a process restart
 *   node ... scripts/measure.mjs compaction     what Pi compaction does to the next turn
 *   node ... scripts/measure.mjs cancellation   cancel during generation, cancel
 *                                               with a parked tool call, stalled CLI
 *   node ... scripts/measure.mjs quota          what each arm drains from the plan window
 *   node ... scripts/measure.mjs quota-sweep    which token kind drives the plan window
 *
 * Both modes spend real model calls on the operator's own login. Results are
 * printed as JSON so they can be quoted in the documentation without retyping.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { closeAllSessions, streamClaudeDirectSdk } from "../src/sdk/stream.ts";
import { readWindows } from "./quota.mjs";

const MODEL = process.env.MEASURE_MODEL ?? "claude-haiku-4-5-20251001";
const CLI = process.env.CLAUDE_DIRECTSDK_COMMAND ?? "claude";
const TIMEOUT_MS = Number(process.env.MEASURE_TIMEOUT_MS ?? 120_000);


/** A long, incompressible instruction block: it pushes the prompt past the
 * model's minimum cacheable prefix so cache reuse becomes observable. */
function pad() {
  const lines = [];
  for (let index = 0; index < 260; index += 1) {
    lines.push(
      `Rule ${index + 1}: when the request mentions item ${index + 1}, prefer the answer that keeps ` +
        `quantity ${index + 1} in position ${index + 1} and never repeat rule ${((index + 7) % 260) + 1}.`,
    );
  }
  return lines.join("\n");
}

const TURNS = [
  "Name three primary colours in one line.",
  "Now name three secondary colours that mix those, in one line.",
  "List all six colours you have named in one comma-separated line.",
];

const now = () => Date.now();
const log = (...args) => console.error("[measure]", ...args);

function model() {
  return {
    id: MODEL,
    name: MODEL,
    api: "claude-directsdk",
    provider: "claude-directsdk",
    baseUrl: "process://claude-directsdk",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block?.type === "text" ? block.text : "")).join("");
}

/** Usage from either the native wire shape or Pi's mapped shape. */
function usageOf(usage) {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: usage.input_tokens ?? usage.input ?? 0,
    output: usage.output_tokens ?? usage.output ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
  };
}

function summarise(usage) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    ...usage,
    promptTokens: prompt,
    totalTokens: prompt + usage.output,
    cacheReadShare: prompt === 0 ? null : Number((usage.cacheRead / prompt).toFixed(4)),
  };
}

/** One Pi-facing turn through the transport under test. */
async function transportTurn(sessionId, messages, signal, systemPrompt) {
  const context = normalizeContext({
    systemPrompt: systemPrompt ?? "You are Pi. Answer in one line unless asked for more.",
    tools: [],
    messages,
  });
  const started = now();
  const events = [];
  const stream = streamClaudeDirectSdk(model(), context, {
    sessionId,
    timeoutMs: TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  for await (const event of stream) events.push(event);
  const last = events.at(-1);
  const message = last?.type === "done" ? last.message : (last?.error ?? {});
  return {
    prompt: textOf(message.content),
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: usageOf(message.usage),
    costUsd: message.diagnostics?.find((item) => item.type === "pi-claude-directsdk/session")
      ?.details?.nativeCostUsd ?? null,
    wallMs: now() - started,
  };
}

/** Add the assistant answer to the history, as Pi stores it. */
function appendAssistant(messages, turn) {
  return [...messages, {
    role: "assistant",
    api: "claude-directsdk",
    provider: "claude-directsdk",
    model: MODEL,
    content: [{ type: "text", text: turn.prompt }],
    stopReason: "stop",
    usage: turn.usage,
    timestamp: now(),
  }];
}

/** One `claude -p` invocation, optionally continuing a session. */
function vanillaTurn({ prompt, sessionId, resume, appendSystemPrompt }) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", MODEL];
    if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
    if (sessionId && resume) args.push("--resume", sessionId);
    else if (sessionId) args.push("--session-id", sessionId);
    const started = now();
    const child = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const frames = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          // Non-JSON banner lines are not part of the protocol.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      const result = frames.find((frame) => frame.type === "result");
      const init = frames.find((frame) => frame.type === "system" && frame.subtype === "init");
      const rate = frames.filter((frame) => frame.type === "rate_limit_event");
      if (!result) {
        reject(new Error(`no result frame. stderr: ${stderr.slice(-400)}`));
        return;
      }
      resolve({
        prompt: textOf(result.result ?? ""),
        stopReason: result.stop_reason ?? null,
        usage: usageOf(result.usage),
        costUsd: result.total_cost_usd ?? null,
        numTurns: result.num_turns ?? null,
        wallMs: now() - started,
        init: init
          ? {
              version: init.claude_code_version ?? null,
              tools: Array.isArray(init.tools) ? init.tools.length : null,
              mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.length : null,
              sessionId: init.session_id ?? null,
            }
          : null,
        rateLimit: rate.map((frame) => frame.rate_limit_info ?? null),
        stderr: stderr.trim().slice(-400) || null,
      });
    });
  });
}

async function sessionMode(options = {}) {
  const systemPrompt = options.padded
    ? `${pad()}\nYou are Pi. Answer in one line unless asked for more.`
    : undefined;
  const suffix = options.padded ? " Keep it to one line." : "";
  const report = {
    model: MODEL,
    cli: spawnSync(CLI, ["--version"], { encoding: "utf8" }).stdout?.trim(),
    paddedSystemPromptChars: systemPrompt?.length ?? 0,
    turns: [],
    transport: [],
    vanilla: [],
    rebuild: null,
  };

  // Arm A: one conversation on the transport under test.
  let messages = [];
  const transportSession = `measure-${Date.now()}`;
  for (const prompt of TURNS) {
    messages = [...messages, { role: "user", content: prompt + suffix, timestamp: now() }];
    const turn = await transportTurn(transportSession, messages, undefined, systemPrompt);
    log("transport turn", turn.stopReason, JSON.stringify(summarise(turn.usage)), `${turn.wallMs}ms`);
    report.transport.push({ prompt, ...turn, ...summarise(turn.usage) });
    messages = [...messages, {
      role: "assistant",
      api: "claude-directsdk",
      provider: "claude-directsdk",
      model: MODEL,
      content: [{ type: "text", text: turn.prompt }],
      stopReason: "stop",
      usage: turn.usage,
      timestamp: now(),
    }];
  }

  // A rebuilt session: one earlier message changes, so the session cannot be reused.
  const edited = messages.map((message, index) =>
    index === 0 ? { ...message, content: `${message.content} Be brief.` } : message,
  );
  const rebuiltTurn = await transportTurn(
    transportSession,
    [...edited, { role: "user", content: "Repeat the six colours in reverse order, one line.", timestamp: now() }],
    undefined,
    systemPrompt,
  );
  log("transport rebuilt turn", rebuiltTurn.stopReason, JSON.stringify(summarise(rebuiltTurn.usage)));
  report.rebuild = { ...rebuiltTurn, ...summarise(rebuiltTurn.usage) };

  // Arm B: the same conversation as three chained `claude -p` invocations.
  const vanillaSession = randomUUID();
  for (const [index, prompt] of TURNS.entries()) {
    const turn = await vanillaTurn({
      prompt: prompt + suffix,
      sessionId: vanillaSession,
      resume: index > 0,
      appendSystemPrompt: systemPrompt,
    });
    log("vanilla turn", turn.stopReason, JSON.stringify(summarise(turn.usage)), `${turn.wallMs}ms`);
    report.vanilla.push({ prompt, ...turn, ...summarise(turn.usage) });
    if (index === 0) report.vanillaInit = turn.init;
  }

  closeAllSessions();
  report.totals = {
    transport: total(report.transport),
    vanilla: total(report.vanilla),
    note: "costUsd is cumulative per conversation in both arms; totals report the last turn, not the sum.",
  };
  return report;
}

function total(turns) {
  const sum = turns.reduce(
    (acc, turn) => {
      // Turns carry either a native `usage` object or the flattened summary.
      const usage = turn.usage ?? turn;
      return {
        input: acc.input + usage.input,
        output: acc.output + usage.output,
        cacheRead: acc.cacheRead + usage.cacheRead,
        cacheWrite: acc.cacheWrite + usage.cacheWrite,
        promptTokens: acc.promptTokens + (turn.promptTokens ?? 0),
        totalTokens: acc.totalTokens + (turn.totalTokens ?? 0),
        costUsd: turn.costUsd ?? acc.costUsd,
        wallMs: acc.wallMs + turn.wallMs,
      };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, promptTokens: 0, totalTokens: 0, costUsd: 0, wallMs: 0 },
  );
  return {
    ...sum,
    cacheReadShare: sum.promptTokens ? Number((sum.cacheRead / sum.promptTokens).toFixed(4)) : null,
    promptChars: turns.reduce((acc, turn) => acc + (turn.prompt?.length ?? 0), 0),
  };
}

function children(pid) {
  const out = spawnSync("ps", ["-o", "pid=,stat=,command=", "--ppid", String(pid)], { encoding: "utf8" });
  return (out.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [childPid, stat, ...rest] = line.trim().split(/\s+/);
      return { pid: Number(childPid), stat, command: rest.join(" ") };
    });
}

/** Every CLI descendant of this process, as pid, ppid, state, and command. */
async function waitForTree(rootPid, timeoutMs) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const all = spawnSync("ps", ["-o", "pid=,ppid=,stat=,command=", "-ax"], { encoding: "utf8" }).stdout ?? "";
    const rows = all
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, stat, ...rest] = line.split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), stat, command: rest.join(" ") };
      })
      .filter((row) => /claude-code|bin\/claude|claude --output-format/.test(row.command));
    const descendants = [];
    const frontier = [rootPid];
    while (frontier.length > 0) {
      const parent = frontier.pop();
      for (const row of rows) {
        if (row.ppid === parent && !descendants.some((entry) => entry.pid === row.pid)) {
          descendants.push(row);
          frontier.push(row.pid);
        }
      }
    }
    if (descendants.length > 0) return descendants;
    if (now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExit(pid, timeoutMs) {
  if (pid === null) return true;
  const deadline = now() + timeoutMs;
  for (;;) {
    const alive = spawnSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
    if (!alive) return true;
    if (now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function claudeTree() {
  const out = spawnSync("pgrep", ["-af", "claude"], { encoding: "utf8" });
  return (out.stdout ?? "")
    .split("\n")
    .filter((line) => line && !line.includes("measure.mjs") && !line.includes("pgrep"));
}

async function cancellationMode() {
  const report = { model: MODEL, cases: [], leftoverBefore: claudeTree().length };

  // 1. Cancel while the model is generating text.
  {
    const controller = new AbortController();
    const messages = [{ role: "user", content: "Write a 400 word essay about lighthouses.", timestamp: now() }];
    let sawDelta = false;
    const started = now();
    const stream = streamClaudeDirectSdk(
      model(),
      normalizeContext({ systemPrompt: "Answer in full.", tools: [], messages }),
      { sessionId: "cancel-text", timeoutMs: TIMEOUT_MS, signal: controller.signal },
    );
    const collected = [];
    for await (const event of stream) {
      collected.push(event);
      if (event.type === "text_delta" && !sawDelta) {
        sawDelta = true;
        setTimeout(() => controller.abort(), 50);
      }
    }
    const last = collected.at(-1);
    const message = last?.type === "done" ? last.message : (last?.error ?? {});
    report.cases.push({
      case: "cancel during generation",
      abortedAfterFirstDelta: sawDelta,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      partialChars: textOf(message.content).length,
      wallMs: now() - started,
    });
    log("case 1", message.stopReason, `${now() - started}ms`);
  }

  // 2. Pi stops while a tool call is parked: the session closes, the parked
  // handler is settled, and the process exits.
  {
    const tools = [{
      name: "echo",
      description: "Return the text it was given.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }];
    const messages = [{ role: "user", content: "Call the echo tool with the text park-me, then answer with its result.", timestamp: now() }];
    const context = normalizeContext({ systemPrompt: "Use the tool when asked.", tools, messages });
    const started = now();
    const stream = streamClaudeDirectSdk(model(), context, { sessionId: "cancel-tool", timeoutMs: TIMEOUT_MS });
    const collected = [];
    let sawToolCall = false;
    for await (const event of stream) {
      collected.push(event);
      if (event.type === "toolcall_end") sawToolCall = true;
      // The step ends at the tool call; the handler is parked from here on.
      if (sawToolCall) break;
    }
    const parkedPid = children(process.pid).find((entry) => /claude/.test(entry.command))?.pid ?? null;
    const closeStarted = now();
    closeAllSessions();
    const childGone = await waitForExit(parkedPid, 15_000);
    // A follow-up call for the same conversation must start a fresh session.
    const followUp = await transportTurn("cancel-tool", [
      ...messages,
      { role: "user", content: "Answer without any tool: what is 2 plus 2?", timestamp: now() },
    ]);
    report.cases.push({
      case: "close while a tool call is parked",
      toolCallPublished: sawToolCall,
      parkedChildPid: parkedPid,
      childExited: childGone,
      closeToExitMs: now() - closeStarted,
      followUpStopReason: followUp.stopReason,
      followUpAnswer: followUp.prompt.slice(0, 60),
      wallMs: now() - started,
    });
    log("case 2", { toolCallPublished: sawToolCall, childGone, closeToExitMs: now() - closeStarted });
  }

  // 3. Freeze the whole CLI process tree before it writes a frame: the frame
  // deadline must fire, and the frozen processes must be cleaned up afterwards.
  // SIGTERM cannot be delivered to a stopped process, so the check continues it
  // before close and reports the state it observes.
  {
    const started = now();
    const messages = [{ role: "user", content: "Write a 300 word story about a slow train.", timestamp: now() }];
    const stream = streamClaudeDirectSdk(
      model(),
      normalizeContext({ systemPrompt: "Answer in full.", tools: [], messages }),
      { sessionId: "stall", timeoutMs: 3_000 },
    );
    await waitForTree(process.pid, 1_000);
    // A descendant seen within the first few milliseconds can still be the
    // launcher, not the CLI. Let the process settle, then freeze what remains.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const tree = await waitForTree(process.pid, 500);
    for (const entry of tree) spawnSync("kill", ["-STOP", String(entry.pid)]);
    log("froze the CLI tree", tree.map((entry) => entry.pid), "at", now() - started, "ms");
    const collected = [];
    for await (const event of stream) collected.push(event);
    const deadlineHitMs = now() - started;
    const last = collected.at(-1);
    const message = last?.type === "done" ? last.message : (last?.error ?? {});
    const stateOf = (pid) =>
      spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim() || "gone";
    const stateAtClose = tree.map((entry) => ({ pid: entry.pid, state: stateOf(entry.pid) }));
    for (const entry of tree) spawnSync("kill", ["-CONT", String(entry.pid)]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stateAfterClose = tree.map((entry) => ({ pid: entry.pid, state: stateOf(entry.pid) }));
    report.cases.push({
      case: "stalled CLI tree (SIGSTOP before any frame), 3000 ms deadline",
      frozePids: tree.map((entry) => entry.pid),
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      contentBlocks: message.content?.length ?? 0,
      deadlineHitMs,
      stateAtClose,
      stateAfterClose,
    });
    log("case 3", { stopReason: message.stopReason, errorMessage: message.errorMessage, deadlineHitMs, stateAtClose, stateAfterClose });
  }

  closeAllSessions();
  report.leftoverAtClose = claudeTree().length;
  const drainDeadline = now() + 15_000;
  while (claudeTree().length > 0 && now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  report.leftoverAfter15s = claudeTree();
  return report;
}

/** The same three turns, split by a process restart on both arms. */
async function restartMode() {
  // The marker goes first so this run's instruction prefix is unique: a cache
  // read after the restart can then only come from this run's own write.
  const systemPrompt = `Measurement run ${randomUUID()}\n${pad()}\nYou are Pi. Answer in one line unless asked for more.`;
  const report = {
    model: MODEL,
    paddedSystemPromptChars: systemPrompt.length,
    before: [],
    vanillaBefore: [],
    gapMs: null,
    after: null,
    vanillaAfter: null,
  };

  // Phase 1: two turns on one live session, then the process tree goes away.
  let messages = [];
  for (const prompt of TURNS.slice(0, 2)) {
    messages = [...messages, { role: "user", content: prompt, timestamp: now() }];
    const turn = await transportTurn("restart-a", messages, undefined, systemPrompt);
    report.before.push({ prompt, ...turn, ...summarise(turn.usage) });
    messages = appendAssistant(messages, turn);
  }

  // The vanilla arm continues the same two turns, each in its own process.
  const vanillaSession = randomUUID();
  for (const [index, prompt] of TURNS.slice(0, 2).entries()) {
    const turn = await vanillaTurn({
      prompt,
      sessionId: vanillaSession,
      resume: index > 0,
      appendSystemPrompt: systemPrompt,
    });
    report.vanillaBefore.push({ prompt, ...turn, ...summarise(turn.usage) });
  }

  closeAllSessions();
  await waitForExit(null, 0);
  log("phase 1 closed; starting a new process for the next turn");

  const statePath = join(tmpdir(), `measure-restart-${randomUUID()}.json`);
  writeFileSync(statePath, JSON.stringify({
    systemPrompt,
    messages,
    vanillaSession,
    nextPrompt: TURNS[2],
    closedAt: now(),
  }));
  const closedAt = now();
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "restart-phase2", statePath],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  try {
    unlinkSync(statePath);
  } catch {
    // A missing state file only means the child removed it first.
  }
  if (child.status !== 0) {
    throw new Error(`phase 2 failed (${child.status}): ${(child.stderr ?? "").slice(-600)}`);
  }
  const after = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
  // How long the cache sat idle: the last turn ended before close, and phase 2
  // issued its first request at startedAt in the new process.
  report.idleMs = after.startedAt - closedAt;
  report.after = { ...after.transport, ...summarise(after.transport.usage) };
  report.vanillaAfter = { ...after.vanilla, ...summarise(after.vanilla.usage) };
  return report;
}

/** Phase 2 of `restart`: a new process rebuilds the history and asks the next turn. */
async function restartPhase2(statePath) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const startedAt = now();
  const messages = [...state.messages, { role: "user", content: state.nextPrompt, timestamp: now() }];
  // The transport keeps no session on disk, so this is a rebuild: the same
  // history, a new CLI process. A cache hit here is server-side reuse.
  const transport = await transportTurn("restart-b", messages, undefined, state.systemPrompt);
  log("transport after restart", transport.stopReason, JSON.stringify(summarise(transport.usage)));
  const vanilla = await vanillaTurn({
    prompt: state.nextPrompt,
    sessionId: state.vanillaSession,
    resume: true,
    appendSystemPrompt: state.systemPrompt,
  });
  log("vanilla after restart", vanilla.stopReason, JSON.stringify(summarise(vanilla.usage)));
  closeAllSessions();
  return { startedAt, transport, vanilla };
}

const DOC_TURN = (doc) => `Here are my project notes:\n\n${doc}\n\nHow many numbered rules did I paste? Answer in one line.`;

/** Pi compaction replaces the history with a summary. Measure the next turn both ways. */
async function compactionMode() {
  // Unique marker first, so the first turn writes this run's prefix from cold
  // instead of reading a prefix cached by an earlier run.
  const systemPrompt = `Measurement run ${randomUUID()}\nYou are Pi. Answer in one line unless asked for more.`;
  const report = { model: MODEL, turns: [], continued: null, compacted: null };

  // A conversation that carries a large pasted document, the case compaction exists for.
  const prompts = [
    DOC_TURN(pad()),
    "Which rule mentions quantity 7? Answer in one line.",
    "Summarise rules 1 to 3 in one line.",
    "Which rule numbers are named in rule 8? Answer in one line.",
  ];
  let messages = [];
  for (const prompt of prompts) {
    messages = [...messages, { role: "user", content: prompt, timestamp: now() }];
    const turn = await transportTurn("compact", messages, undefined, systemPrompt);
    log("turn", turn.stopReason, JSON.stringify(summarise(turn.usage)), `${turn.wallMs}ms`);
    report.turns.push({ prompt: prompt.slice(0, 60), ...turn, ...summarise(turn.usage) });
    messages = appendAssistant(messages, turn);
  }

  // Reference: the same session continues, history intact.
  const nextPrompt = "In one line, what was the last question I asked?";
  const continued = await transportTurn(
    "compact",
    [...messages, { role: "user", content: nextPrompt, timestamp: now() }],
    undefined,
    systemPrompt,
  );
  log("continued", continued.stopReason, JSON.stringify(summarise(continued.usage)));
  report.continued = { ...continued, ...summarise(continued.usage) };

  // Pi compacts: the history becomes a summary message, the recent entries are
  // kept, and the session must be rebuilt. The summary wrapper is Pi's own text.
  const summary = [
    "The user pasted 260 numbered rules and asked questions about them.",
    "The number of rules is 260.",
    "The rule mentioning quantity 7 is rule 7, which keeps quantity 7 in position 7.",
    "Rules 1 to 3 each keep their own quantity in their own position.",
    "Rule 8 names rule 15 and rule 8.",
  ].join(" ");
  const summaryMessage = [
    "The conversation history before this point was compacted into the following summary:",
    "",
    "<summary>",
    summary,
    "</summary>",
  ].join("\n");
  const compacted = await transportTurn(
    "compact",
    [
      { role: "user", content: summaryMessage, timestamp: now() },
      {
        role: "assistant",
        api: "claude-directsdk",
        provider: "claude-directsdk",
        model: MODEL,
        content: [{ type: "text", text: report.turns.at(-1).prompt }],
        stopReason: "stop",
        usage: report.turns.at(-1).usage,
        timestamp: now(),
      },
      { role: "user", content: nextPrompt, timestamp: now() },
    ],
    undefined,
    systemPrompt,
  );
  log("after compaction", compacted.stopReason, JSON.stringify(summarise(compacted.usage)));
  report.compacted = { ...compacted, ...summarise(compacted.usage) };
  report.summaryChars = summary.length;
  closeAllSessions();
  return report;
}

/**
 * Plan-window drain.
 *
 * Reads the snapshot that @joaomj/pi-claude-usage writes to the XDG cache after
 * querying GET api.anthropic.com/api/oauth/usage. The extension does the token
 * work; this script only reads the percentages it stored, so no credential is
 * opened here. The endpoint reports whole percent, so one point is the finest
 * reading available.
 */
const USAGE_CACHE = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "pi-claude-usage.json",
);

function usageSnapshot() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(USAGE_CACHE, "utf8"));
  } catch {
    return null;
  }
  const entries = Object.values(raw).filter(
    (entry) => entry && typeof entry.fetchedAt === "number",
  );
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
}

/**
 * Refresh the footer snapshot and read what the extension stored.
 *
 * @joaomj/pi-claude-usage only activates when Pi runs in its TUI (`ctx.mode ===
 * "tui"`), and it refreshes at startup only when its cached snapshot is older
 * than five minutes. So the probe waits for that staleness, then opens a real
 * TUI inside a detached `screen` session and lets the extension fetch fresh
 * numbers. This script reads the stored percentages; it never opens the
 * credential file the extension uses.
 */
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function quotaProbe(label) {
  const screen = (args) => spawnSync("screen", args, { encoding: "utf8" });

  // The extension skips its startup refresh while the snapshot is fresh.
  const current = usageSnapshot();
  if (current) {
    const staleAt = current.fetchedAt + USAGE_CACHE_TTL_MS + 15_000;
    if (staleAt > now()) {
      log("quota probe", label, `waiting ${Math.ceil((staleAt - now()) / 1000)}s for the cached snapshot to expire`);
      await new Promise((resolve) => setTimeout(resolve, staleAt - now()));
    }
  }

  const before = usageSnapshot();
  const name = `piquota-${label}-${process.pid}`;
  screen(["-dmS", name, "pi", "--model", `claude-directsdk/${MODEL}`]);
  try {
    const deadline = now() + 120_000;
    while (now() < deadline) {
      const snap = usageSnapshot();
      if (snap && (!before || snap.fetchedAt > before.fetchedAt)) {
        screen(["-S", name, "-X", "hardcopy", "-h", `/tmp/${name}.txt`]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        let footer = null;
        try {
          footer = readFileSync(`/tmp/${name}.txt`, "utf8")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.includes("5h:")) ?? null;
        } catch {
          // A missing hardcopy only costs the human-readable line.
        }
        log("quota probe", label, footer?.replace(/[^\x20-\x7e]/g, "") ?? `5h:${snap.session?.remaining}% wk:${snap.weekly?.remaining}%`);
        return { label, fetchedAt: snap.fetchedAt, session: snap.session, weekly: snap.weekly, footer };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`the usage snapshot did not refresh for probe ${label}`);
  } finally {
    screen(["-S", name, "-X", "quit"]);
  }
}

const QUOTA_CONVERSATIONS = 3;

async function quotaMode() {
  const systemPrompt = `${pad()}\nYou are Pi. Answer in one line unless asked for more.`;
  const report = {
    model: MODEL,
    paddedSystemPromptChars: systemPrompt.length,
    conversationsPerArm: QUOTA_CONVERSATIONS,
    probes: [],
    transport: [],
    vanilla: [],
  };

  const start = await quotaProbe("before");
  report.probes.push(start);

  // Arm A: the same conversation repeated three times on the transport.
  for (let conversation = 0; conversation < QUOTA_CONVERSATIONS; conversation += 1) {
    let messages = [];
    const sessionId = `quota-a-${conversation}-${Date.now()}`;
    for (const prompt of TURNS) {
      messages = [...messages, { role: "user", content: prompt, timestamp: now() }];
      const turn = await transportTurn(sessionId, messages, undefined, systemPrompt);
      report.transport.push({
        conversation,
        prompt,
        ...summarise(turn.usage),
        costUsd: turn.costUsd,
        wallMs: turn.wallMs,
      });
      messages = appendAssistant(messages, turn);
    }
    log("transport conversation", conversation + 1, JSON.stringify(total(report.transport.filter((t) => t.conversation === conversation))));
  }

  const afterTransport = await quotaProbe("afterTransport");
  report.probes.push(afterTransport);

  // Arm B: the same three conversations as chained `claude -p --resume` calls.
  for (let conversation = 0; conversation < QUOTA_CONVERSATIONS; conversation += 1) {
    const sessionId = randomUUID();
    for (const [index, prompt] of TURNS.entries()) {
      const turn = await vanillaTurn({
        prompt,
        sessionId,
        resume: index > 0,
        appendSystemPrompt: systemPrompt,
      });
      report.vanilla.push({
        conversation,
        prompt,
        ...summarise(turn.usage),
        costUsd: turn.costUsd,
        wallMs: turn.wallMs,
      });
    }
    log("vanilla conversation", conversation + 1, JSON.stringify(total(report.vanilla.filter((t) => t.conversation === conversation))));
  }

  const afterVanilla = await quotaProbe("afterVanilla");
  report.probes.push(afterVanilla);

  const drain = (a, b, window) => {
    const first = a[window]?.remaining;
    const last = b[window]?.remaining;
    return Number.isFinite(first) && Number.isFinite(last) ? first - last : null;
  };
  report.drain = {
    transport: {
      sessionPoints: drain(start, afterTransport, "session"),
      weeklyPoints: drain(start, afterTransport, "weekly"),
    },
    vanilla: {
      sessionPoints: drain(afterTransport, afterVanilla, "session"),
      weeklyPoints: drain(afterTransport, afterVanilla, "weekly"),
    },
    note: "Points are percentage points of the window, whole numbers only. The 5h window drains across the whole run, so the second arm's share is the difference between the two probes around it.",
  };
  report.tokens = { transport: total(report.transport), vanilla: total(report.vanilla) };
  closeAllSessions();
  return report;
}

/**
 * Which token kind drains the 5-hour window.
 *
 * The endpoint reports whole percent, so each condition runs enough requests to
 * move the counter by several points and the per-request cost is derived from
 * that delta. Conditions differ in one variable each: output length, warm
 * input, and cold input.
 */
async function quotaSweepMode() {
  const report = { model: MODEL, conditions: [], startedAt: new Date().toISOString() };

  const sessionUsed = async () => {
    const w = await readWindows();
    return w.session?.usedPercent ?? null;
  };

  /**
   * The percentage is eventually consistent. A burst of requests can leave it
   * unmoved for several minutes: two runs of six requests each read 37 percent
   * before and after. So a settle waits five minutes before the first read and
   * keeps reading once a minute while the value has not moved.
   */
  const settled = async (previous) => {
    await new Promise((resolve) => setTimeout(resolve, 300_000));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const used = await sessionUsed();
      if (used === null) throw new Error("the usage endpoint returned no session window");
      if (previous === null || used > previous) return used;
      log("sweep settle", `still ${used}% after ${5 + attempt} min`);
    }
    return previous;
  };

  const runRequests = async (condition) => {
    const turns = [];
    for (const request of condition.requests) {
      const sessionId = `sweep-${condition.name}-${turns.length}-${Date.now()}`;
      const turn = await transportTurn(
        sessionId,
        [{ role: "user", content: request.prompt, timestamp: now() }],
        undefined,
        request.systemPrompt,
      );
      turns.push({
        stopReason: turn.stopReason,
        ...summarise(turn.usage),
        answerChars: turn.prompt.length,
      });
    }
    return turns;
  };

  const only = process.argv[3];
  const conditions = [
    {
      name: "longOutput",
      why: "tiny prompt, long answers: isolates output tokens",
      requests: Array.from({ length: 3 }, () => ({
        prompt: "Write about 400 words about a slow train crossing a plain. No lists.",
      })),
    },
    {
      name: "warmInput",
      why: "12k-token instruction block cached after the first request, one line out",
      requests: Array.from({ length: 10 }, () => ({
        prompt: "Reply with the single word OK.",
        systemPrompt: `${pad()}\nYou are Pi. Answer in one line.`,
      })),
    },
    {
      name: "coldInput",
      why: "12k-token instruction block with unique bytes every request, one line out",
      requests: Array.from({ length: 5 }, () => ({
        prompt: "Reply with the single word OK.",
        systemPrompt: `Sweep ${randomUUID()}\n${pad()}\nYou are Pi. Answer in one line.`,
      })),
    },
  ].filter((condition) => !only || condition.name === only);

  let previous = await sessionUsed();
  report.startUsedPercent = previous;
  log("sweep start", `session used ${previous}%`);

  for (const condition of conditions) {
    const before = previous;
    const turns = await runRequests(condition);
    const after = await settled(before);
    previous = after;
    const requests = turns.length;
    const output = turns.reduce((acc, turn) => acc + turn.output, 0);
    const uncachedInput = turns.reduce((acc, turn) => acc + turn.input + turn.cacheWrite, 0);
    const cacheRead = turns.reduce((acc, turn) => acc + turn.cacheRead, 0);
    const points = after - before;
    report.conditions.push({
      name: condition.name,
      why: condition.why,
      requests,
      points,
      pointsPerRequest: Number((points / requests).toFixed(3)),
      outputTokens: output,
      outputPerPoint: points > 0 ? Math.round(output / points) : null,
      uncachedInputTokens: uncachedInput,
      uncachedInputPerPoint: points > 0 ? Math.round(uncachedInput / points) : null,
      cacheReadTokens: cacheRead,
      turns,
    });
    log("sweep condition", condition.name, `points ${points}`, `requests ${requests}`, `output ${output}`, `uncached ${uncachedInput}`, `cacheRead ${cacheRead}`);
  }

  report.endUsedPercent = previous;
  closeAllSessions();
  return report;
}

const mode = process.argv[2] ?? "session";

const modes = {
  "restart-phase2": () => restartPhase2(process.argv[3]),
  cancellation: cancellationMode,
  restart: restartMode,
  compaction: compactionMode,
  "quota-probe": () => quotaProbe("manual"),
  "quota-sweep": quotaSweepMode,
  quota: quotaMode,
  cache: () => sessionMode({ padded: true }),
  session: () => sessionMode(),
};
const run = modes[mode];
if (!run) {
  console.error(`unknown mode ${mode}. Modes: ${Object.keys(modes).join(", ")}`);
  process.exit(2);
}
const report = await run();
console.log(JSON.stringify(report, null, 2));
