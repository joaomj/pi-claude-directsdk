#!/usr/bin/env node
/**
 * Measurements against the installed Claude Code.
 *
 *   node ... scripts/measure.mjs session        token velocity and cache reuse
 *   node ... scripts/measure.mjs cancellation   cancel during generation, cancel
 *                                               with a parked tool call, stalled CLI
 *
 * Both modes spend real model calls on the operator's own login. Results are
 * printed as JSON so they can be quoted in the documentation without retyping.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { closeAllSessions, streamClaudeDirectSdk } from "../src/sdk/stream.ts";

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
    (acc, turn) => ({
      input: acc.input + turn.usage.input,
      output: acc.output + turn.usage.output,
      cacheRead: acc.cacheRead + turn.usage.cacheRead,
      cacheWrite: acc.cacheWrite + turn.usage.cacheWrite,
      promptTokens: acc.promptTokens + (turn.promptTokens ?? 0),
      totalTokens: acc.totalTokens + (turn.totalTokens ?? 0),
      costUsd: turn.costUsd ?? acc.costUsd,
      wallMs: acc.wallMs + turn.wallMs,
    }),
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

const mode = process.argv[2] ?? "session";
const report =
  mode === "cancellation"
    ? await cancellationMode()
    : await sessionMode({ padded: mode === "cache" });
console.log(JSON.stringify(report, null, 2));
