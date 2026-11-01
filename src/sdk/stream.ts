/**
 * Pi `streamSimple` implementation on the official Claude Agent SDK.
 *
 * One persistent Claude Code session per Pi conversation. Each Pi model call
 * consumes one assistant step from that session: deltas stream through as they
 * arrive, tool calls return to Pi for authorization and execution, and the next
 * call delivers those results back to Claude through the parked MCP handlers.
 * Pi's visible history stays authoritative; when it cannot be matched to the
 * live session, the session is rebuilt from a checkpoint instead of guessing.
 */

import { createHash } from "node:crypto";
import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  JsonObject,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai/compat";
import {
  enforceUsageCredits,
  rateLimitDiagnostic,
  usageCreditsRejectionError,
  type RateLimitInfo,
} from "../billing.js";
import { buildChildEnv, checkEnvConflicts, COMMAND_ENV } from "../env.js";
import {
  DirectSdkError,
  cancelledError,
  envConflictError,
  incompleteError,
  loggedOutError,
  nativeError,
  sdkError,
  toolError,
} from "../errors.js";
import { PROVIDER_ID, nativeModel } from "../models.js";
import { resolveClaude } from "../setup.js";
import { isRecord } from "../types.js";
import { loadRuntime, type SdkRuntime } from "./adapter.js";
import { toMcpResult, ToolBridge } from "./bridge.js";
import { checkpointPrompt, checkpointText } from "./checkpoint.js";
import { toEffort, type Effort } from "./options.js";
import { ClaudeSession } from "./session.js";
import { prepareToolSpecs, MCP_SERVER_NAME, TOOL_NAME_PREFIX, toolBareName, type PiToolSpec } from "./tools.js";
import { logTransportEvent } from "./log.js";

const DEFAULT_TIMEOUT_MS = 180_000;

/** How many unoffered calls one turn tolerates before it fails. */
const MAX_UNOFFERED_CALLS = 3;
const NATIVE_API = "claude-directsdk";
const SESSION_DIAGNOSTIC = "pi-claude-directsdk/session";

export interface ManagedSession {
  session: ClaudeSession;
  /** Native model id the session was started with. */
  model: string;
  effort: Effort | undefined;
  toolNames: string[];
  promptDigest: string;
  /** Tool call ids Claude Code is waiting on Pi to execute. */
  awaiting: string[];
  /** Number of Pi messages the session has already seen, assistant output included. */
  historyLength: number;
  /** Digest of those messages: any edit makes the session unusable. */
  historyDigest: string;
}

/** Live sessions, keyed by the Pi conversation they belong to. */
export class SessionRegistry {
  private readonly entries = new Map<string, ManagedSession>();

  get(key: string): ManagedSession | undefined {
    return this.entries.get(key);
  }

  set(key: string, managed: ManagedSession): void {
    this.entries.set(key, managed);
  }

  drop(key: string): void {
    const managed = this.entries.get(key);
    if (!managed) return;
    this.entries.delete(key);
    managed.session.close();
  }

  closeAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.drop(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

const sessions = new SessionRegistry();

/** Stop every live Claude session. Extension shutdown calls this. */
export function closeAllSessions(): void {
  sessions.closeAll();
}

export interface CallDeps {
  loadRuntime: () => Promise<SdkRuntime>;
  resolveCli: (env: NodeJS.ProcessEnv) => string[] | undefined;
  cwd: () => string;
  sessions: SessionRegistry;
}

export const defaultDeps: CallDeps = {
  loadRuntime,
  resolveCli: (env) => resolveClaude(env[COMMAND_ENV], env),
  cwd: () => process.cwd(),
  sessions,
};

export function streamClaudeDirectSdk(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  deps: CallDeps = defaultDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void executeCall(model, context, options ?? {}, stream, deps).catch((error: unknown) => {
    // executeCall terminates the stream itself; this only guards an internal bug.
    void error;
  });
  return stream;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pi usage from native usage. Returns null when incomplete. */
function mapUsage(usage: unknown): Usage | null {
  if (!isRecord(usage)) return null;
  const input = toNumber(usage["input_tokens"]);
  const output = toNumber(usage["output_tokens"]);
  if (input === null || output === null) return null;
  const cacheRead = toNumber(usage["cache_read_input_tokens"]) ?? 0;
  const cacheWrite = toNumber(usage["cache_creation_input_tokens"]) ?? 0;
  const cacheCreation = usage["cache_creation"];
  const cacheWrite1h = isRecord(cacheCreation)
    ? toNumber(cacheCreation["ephemeral_1h_input_tokens"]) ?? undefined
    : undefined;
  const details = usage["output_tokens_details"];
  const reasoning = isRecord(details)
    ? toNumber(details["thinking_tokens"]) ?? undefined
    : undefined;
  const mapped: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (cacheWrite1h !== undefined) mapped.cacheWrite1h = cacheWrite1h;
  if (reasoning !== undefined) mapped.reasoning = reasoning;
  return mapped;
}

function mapStopReason(stop: string, detail?: string): {
  stopReason: "stop" | "length" | "toolUse" | "error";
  errorMessage?: string;
} {
  switch (stop) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return { stopReason: "error", errorMessage: detail || "The model refused to complete the request" };
    default:
      return { stopReason: "error", errorMessage: `Unhandled stop reason: ${stop}` };
  }
}

/** Stable content of one message: timestamps and usage are not conversation. */
function compactMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((block) =>
        block.type === "toolCall"
          ? { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }
          : block,
      ),
      stopReason: message.stopReason,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
    };
  }
  return { role: message.role };
}

function digestMessages(messages: Message[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map(compactMessage)))
    .digest("hex");
}

function sameNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((name, index) => name === sorted[index]);
}

function nonSystem(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== "system");
}

function trailingToolResults(messages: Message[]): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult") break;
    results.unshift(message);
  }
  return results;
}

function userContent(message: Message): string | Array<Record<string, unknown>> {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    }
  }
  return blocks.length === 0 ? "" : blocks;
}

interface Progressive {
  kind: "text" | "thinking";
  nativeIndex: number;
  contentIndex: number;
  redacted: boolean;
}

interface PendingTool {
  index: number;
  id: string;
  name: string;
  /** Streamed `input_json_delta` payload, before parsing. */
  json: string;
}

/** Converts one Claude step's frames into Pi stream events. */
class Renderer {
  readonly assistants: Array<Record<string, unknown>> = [];
  readonly progressive: Progressive[] = [];
  readonly pendingTools: PendingTool[] = [];
  lastUsage: unknown;
  stopReason: string | null = null;
  streamId: string | undefined;
  streamModel: string | undefined;

  private readonly output: AssistantMessage;
  private readonly push: (event: AssistantMessageEvent) => void;
  private readonly bridge: ToolBridge;

  constructor(
    output: AssistantMessage,
    push: (event: AssistantMessageEvent) => void,
    bridge: ToolBridge,
  ) {
    this.output = output;
    this.push = push;
    this.bridge = bridge;
  }

  assistant(message: Record<string, unknown>): void {
    this.assistants.push(message);
    if (isRecord(message["usage"])) this.lastUsage = message["usage"];
    if (typeof message["id"] === "string" && !this.streamId) this.streamId = message["id"];
    if (typeof message["model"] === "string" && !this.streamModel) this.streamModel = message["model"];
    if (typeof message["stop_reason"] === "string") this.stopReason = message["stop_reason"];
    for (const block of Array.isArray(message["content"]) ? message["content"] : []) {
      if (!isRecord(block) || block["type"] !== "tool_use") continue;
      const id = typeof block["id"] === "string" ? block["id"] : "";
      const bare = toolBareName(typeof block["name"] === "string" ? block["name"] : "");
      if (id && bare) this.bridge.announce(id, bare);
    }
  }

  streamEvent(event: Record<string, unknown>): void {
    switch (event["type"]) {
      case "message_start": {
        const message = event["message"];
        if (!isRecord(message)) return;
        if (typeof message["id"] === "string") this.streamId = message["id"];
        if (typeof message["model"] === "string") this.streamModel = message["model"];
        if (isRecord(message["usage"])) this.lastUsage = message["usage"];
        return;
      }
      case "content_block_start": {
        const block = event["content_block"];
        if (!isRecord(block)) return;
        const index = toNumber(event["index"]) ?? this.output.content.length;
        const contentIndex = this.output.content.length;
        if (block["type"] === "text") {
          this.output.content.push({ type: "text", text: "" });
          this.progressive.push({ kind: "text", nativeIndex: index, contentIndex, redacted: false });
          this.push({ type: "text_start", contentIndex, partial: this.output });
          return;
        }
        if (block["type"] === "thinking") {
          this.output.content.push({
            type: "thinking",
            thinking: "",
            thinkingSignature: typeof block["signature"] === "string" ? block["signature"] : "",
          } satisfies ThinkingContent);
          this.progressive.push({ kind: "thinking", nativeIndex: index, contentIndex, redacted: false });
          this.push({ type: "thinking_start", contentIndex, partial: this.output });
          return;
        }
        if (block["type"] === "redacted_thinking") {
          this.output.content.push({
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: typeof block["data"] === "string" ? block["data"] : "",
            redacted: true,
          } satisfies ThinkingContent);
          this.progressive.push({ kind: "thinking", nativeIndex: index, contentIndex, redacted: true });
          this.push({ type: "thinking_start", contentIndex, partial: this.output });
          return;
        }
        if (block["type"] === "tool_use") {
          const id = typeof block["id"] === "string" ? block["id"] : "";
          const name = typeof block["name"] === "string" ? block["name"] : "";
          this.pendingTools.push({ index, id, name, json: "" });
          const bare = toolBareName(name);
          if (id && bare) this.bridge.announce(id, bare);
        }
        return;
      }
      case "content_block_delta": {
        const delta = event["delta"];
        if (!isRecord(delta)) return;
        const index = toNumber(event["index"]) ?? -1;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          const target = this.find("text", index);
          const block = target ? this.output.content[target.contentIndex] : undefined;
          if (!target || block?.type !== "text") return;
          block.text += delta["text"];
          this.push({ type: "text_delta", contentIndex: target.contentIndex, delta: delta["text"], partial: this.output });
          return;
        }
        if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          const target = this.find("thinking", index);
          if (!target || target.redacted) return;
          const block = this.output.content[target.contentIndex];
          if (block?.type !== "thinking") return;
          block.thinking += delta["thinking"];
          this.push({ type: "thinking_delta", contentIndex: target.contentIndex, delta: delta["thinking"], partial: this.output });
          return;
        }
        if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
          const tool = this.pendingTools.find((entry) => entry.index === index);
          if (tool) tool.json += delta["partial_json"];
          return;
        }
        if (delta["type"] === "signature_delta" && typeof delta["signature"] === "string") {
          const target = this.find("thinking", index);
          if (!target) return;
          const block = this.output.content[target.contentIndex];
          if (block?.type === "thinking") {
            block.thinkingSignature = (block.thinkingSignature ?? "") + delta["signature"];
          }
          return;
        }
        return;
      }
      case "message_delta": {
        const delta = event["delta"];
        if (isRecord(delta) && typeof delta["stop_reason"] === "string") {
          this.stopReason = delta["stop_reason"];
        }
        const usage = event["usage"];
        if (isRecord(usage)) {
          this.lastUsage = isRecord(this.lastUsage) ? { ...this.lastUsage, ...usage } : usage;
        }
        return;
      }
      default:
        return;
    }
  }

  /** Close open text/thinking blocks with their authoritative content. */
  closeBlocks(): void {
    for (const prog of this.progressive) {
      const block = this.output.content[prog.contentIndex];
      if (prog.kind === "thinking" && block?.type === "thinking") {
        this.push({
          type: "thinking_end",
          contentIndex: prog.contentIndex,
          content: block.thinking,
          partial: this.output,
        });
      }
      if (prog.kind === "text" && block?.type === "text") {
        this.push({
          type: "text_end",
          contentIndex: prog.contentIndex,
          content: block.text,
          partial: this.output,
        });
      }
    }
  }

  /**
   * Tool calls from the completed step, in order.
   *
   * The streamed blocks are authoritative because Claude Code's complete
   * `assistant` message can arrive after `message_stop`. The complete message
   * is only a fallback for the input of a call that streamed without one.
   */
  toolCalls(): Array<{ id: string; name: string; input: unknown }> {
    const completed = new Map<string, unknown>();
    for (const assistant of this.assistants) {
      for (const block of Array.isArray(assistant["content"]) ? assistant["content"] : []) {
        if (!isRecord(block) || block["type"] !== "tool_use") continue;
        if (typeof block["id"] === "string") completed.set(block["id"], block["input"]);
      }
    }
    if (this.pendingTools.length === 0) {
      const calls: Array<{ id: string; name: string; input: unknown }> = [];
      for (const assistant of this.assistants) {
        for (const block of Array.isArray(assistant["content"]) ? assistant["content"] : []) {
          if (!isRecord(block) || block["type"] !== "tool_use") continue;
          calls.push({
            id: typeof block["id"] === "string" ? block["id"] : "",
            name: typeof block["name"] === "string" ? block["name"] : "",
            input: block["input"],
          });
        }
      }
      return calls;
    }
    return this.pendingTools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      input: parseStreamedInput(tool.json, completed.get(tool.id)),
    }));
  }

  /** Fill the answer from the complete message when no deltas arrived at all. */
  adoptCompleted(): void {
    if (this.progressive.length > 0 || this.pendingTools.length > 0) return;
    const last = this.assistants[this.assistants.length - 1];
    if (!last || !Array.isArray(last["content"])) return;
    for (const block of last["content"]) {
      if (!isRecord(block)) continue;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        this.output.content.push({ type: "text", text: block["text"] });
      } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        this.output.content.push({
          type: "thinking",
          thinking: block["thinking"],
          thinkingSignature: typeof block["signature"] === "string" ? block["signature"] : "",
        } satisfies ThinkingContent);
      }
    }
  }

  refusalText(): string {
    const text = this.assistants
      .flatMap((assistant) => (Array.isArray(assistant["content"]) ? assistant["content"] : []))
      .filter((block): block is Record<string, unknown> => isRecord(block) && block["type"] === "text")
      .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
      .join("");
    return text || "The model refused to complete the request";
  }

  private find(kind: Progressive["kind"], nativeIndex: number): Progressive | undefined {
    return (
      this.progressive.find((entry) => entry.kind === kind && entry.nativeIndex === nativeIndex) ??
      [...this.progressive].reverse().find((entry) => entry.kind === kind)
    );
  }
}

interface SessionRequest {
  deps: CallDeps;
  runtime: SdkRuntime;
  key: string;
  cliPath: string;
  /** Native model id Claude Code receives. */
  nativeModelId: string;
  effort: Effort | undefined;
  append: string;
  specs: PiToolSpec[];
  env: NodeJS.ProcessEnv;
  context: TranscriptContext;
  signal: AbortSignal | undefined;
}

interface Acquired {
  managed: ManagedSession;
  /** True when this call sent a prompt and must read a new step. */
  sent: boolean;
}

/**
 * Reuse the live Claude session when Pi's history still matches it, otherwise
 * rebuild from a checkpoint. Never silently continue an unrelated session.
 */
async function acquireSession(request: SessionRequest): Promise<Acquired> {
  const { deps, key, context, specs } = request;
  const messages = nonSystem(context.messages);
  const toolNames = specs.map((spec) => spec.name);
  const promptDigest = createHash("sha256").update(request.append).digest("hex");
  const existing = deps.sessions.get(key);

  if (existing && !existing.session.ended) {
    const compatible =
      existing.model === request.nativeModelId &&
      existing.effort === request.effort &&
      existing.promptDigest === promptDigest &&
      sameNames(existing.toolNames, toolNames);
    if (compatible) {
      const continued = tryContinue(existing, messages);
      if (continued) return continued;
    }
  }
  if (existing) {
    deps.sessions.drop(key);
  }

  const session = await ClaudeSession.open({
    runtime: request.runtime,
    cliPath: request.cliPath,
    model: request.nativeModelId,
    effort: request.effort,
    append: request.append,
    specs,
    env: request.env,
    cwd: deps.cwd(),
    bridge: new ToolBridge(),
  });
  const managed: ManagedSession = {
    session,
    model: request.nativeModelId,
    effort: request.effort,
    toolNames,
    promptDigest,
    awaiting: [],
    historyLength: 0,
    historyDigest: "",
  };
  deps.sessions.set(key, managed);
  session.sendUser(checkpointText(checkpointPrompt(messages)));
  return { managed, sent: true };
}

function tryContinue(existing: ManagedSession, messages: Message[]): Acquired | null {
  const known = messages.slice(0, existing.historyLength);
  // Resume, branch, edit, or compaction changed the record: the live session no
  // longer describes what Pi shows the user.
  if (known.length !== existing.historyLength || digestMessages(known) !== existing.historyDigest) {
    return null;
  }
  const tail = messages.slice(existing.historyLength);
  if (existing.awaiting.length > 0) {
    const results = trailingToolResults(tail);
    if (results.length !== tail.length) return null;
    const ids = results.map((result) => result.toolCallId);
    if (ids.length !== existing.awaiting.length) return null;
    if (!existing.awaiting.every((id) => ids.includes(id))) return null;
    for (const result of results) {
      if (!existing.session.bridge.deliver(result.toolCallId, toMcpResult(result))) {
        return null;
      }
    }
    existing.awaiting = [];
    return { managed: existing, sent: false };
  }
  const only = tail[0];
  if (tail.length !== 1 || only?.role !== "user") return null;
  existing.session.sendUser(userContent(only));
  return { managed: existing, sent: true };
}

async function executeCall(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions,
  stream: AssistantMessageEventStream,
  deps: CallDeps,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: NATIVE_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const key = options.sessionId ?? "default";
  let managed: ManagedSession | null = null;
  let keepSession = false;
  let latestRateLimit: RateLimitInfo | undefined;
  let nativeCostUsd = -1;
  let resultSubtype: string | undefined;
  let requestId: string | undefined;
  let logEnv: NodeJS.ProcessEnv = process.env;
  let abortListener: (() => void) | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  const diagnostic = (kind: string): AssistantMessageDiagnostic => ({
    type: kind,
    timestamp: Date.now(),
    details: {
      nativeModel: model.id,
      cliVersion: managed?.session.cliVersion ?? "",
      claudeSessionId: managed?.session.sessionId ?? "",
      mcpServers: (managed?.session.mcpServers ?? []).map((server) => `${server.name}:${server.status}`),
      resultSubtype: resultSubtype ?? "",
      nativeCostUsd,
      nativeCostNote: "estimate, not subscription charge",
      pendingToolCalls: managed?.awaiting.length ?? 0,
    } satisfies JsonObject,
  });

  const fail = (error: unknown): void => {
    const aborted = error instanceof DirectSdkError && error.kind === "cancelled";
    output.stopReason = aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    logTransportEvent({
      kind: aborted ? "aborted" : (error instanceof DirectSdkError ? error.kind : "error"),
      message: output.errorMessage,
      model: model.id,
      cliVersion: managed?.session.cliVersion,
      claudeSessionId: managed?.session.sessionId,
      mcpServers: managed?.session.mcpServers.map((server) => `${server.name}:${server.status}`),
      requestId,
      stderrTail: managed?.session.stderr(),
      piSessionId: options.sessionId,
      resultSubtype,
    }, logEnv);
    output.diagnostics = [
      ...(latestRateLimit ? [rateLimitDiagnostic(latestRateLimit)] : []),
      diagnostic(SESSION_DIAGNOSTIC),
    ];
    stream.push({ type: "error", reason: output.stopReason === "aborted" ? "aborted" : "error", error: output });
    stream.end(output);
  };

  if (options.signal?.aborted) {
    fail(cancelledError());
    return;
  }

  try {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    logEnv = mergedEnv;
    const conflicts = checkEnvConflicts(mergedEnv);
    if (conflicts.length > 0) throw envConflictError(conflicts);
    timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive milliseconds");
    }
    const resolved = deps.resolveCli(mergedEnv);
    const cliPath = resolved?.[0];
    if (!cliPath) {
      throw sdkError(
        "Claude Code was not found. Install it (`npm install -g @anthropic-ai/claude-code`) " +
          `or set ${COMMAND_ENV} to the executable path.`,
      );
    }
    const runtime = await deps.loadRuntime();

    const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
    const specs = prepareToolSpecs(tools);
    const append = getCurrentSystemPrompt(collapseSystemMessages(context).messages);
    const reasoning = options.reasoning;
    const backing = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
    const effort = toEffort(backing);

    const acquired = await acquireSession({
      deps,
      runtime,
      key,
      cliPath,
      nativeModelId: nativeModel(model.id, model.contextWindow),
      effort,
      append,
      specs,
      env: buildChildEnv(mergedEnv),
      context,
      signal: options.signal,
    });
    managed = acquired.managed;
    const session = acquired.managed.session;

    abortListener = (): void => {
      void session.interrupt();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    stream.push({ type: "start", partial: output });

    const renderer = new Renderer(output, (event) => stream.push(event), session.bridge);
    let resultFrame: Record<string, unknown> | undefined;
    let unofferedSeen = 0;

    for (;;) {
      if (options.signal?.aborted) throw cancelledError();
      const frame = await session.nextFrame(timeoutMs).catch((error: unknown) => {
        // A cancelled wait reports cancellation, not a silent Claude Code.
        if (options.signal?.aborted) throw cancelledError();
        throw error;
      });
      if (options.signal?.aborted) throw cancelledError();
      if (frame === null) {
        throw incompleteError(
          `Claude Code ended the session before the step completed${session.stderr() ? `, stderr: ${session.stderr()}` : ""}`,
        );
      }
      const record = frame as unknown as Record<string, unknown>;
      if (typeof record["request_id"] === "string" && record["request_id"]) requestId = record["request_id"];
      const type = typeof record["type"] === "string" ? record["type"] : "";
      if (type === "stream_event") {
        const event = record["event"];
        if (!isRecord(event)) continue;
        renderer.streamEvent(event);
        if (event["type"] === "message_stop" && renderer.stopReason === "tool_use") {
          // Only a call for an offered Pi tool parks here. Claude Code answers a
          // call for a tool it does not have with an error result and keeps
          // streaming, so Pi waits for the corrected step instead of failing.
          const step = renderer.toolCalls();
          if (step.some((call) => isOffered(call.name, specs))) break;
          unofferedSeen += step.length;
          if (unofferedSeen > MAX_UNOFFERED_CALLS) {
            const names = [...new Set(step.map((call) => call.name || "(unnamed)"))].join(", ");
            throw toolError(
              `Claude called a tool Pi did not offer ${unofferedSeen} times in one turn: ${names}. ` +
                "Pi never substitutes its own tool for an offered one. Retry the turn.",
            );
          }
          continue;
        }
        continue;
      }
      if (type === "assistant") {
        const message = record["message"];
        if (!isRecord(message)) continue;
        const errorCode = record["error"];
        if (typeof errorCode === "string" && errorCode) {
          // The CLI reports API failures it cannot classify as "unknown" and puts
          // the provider's text in a synthetic assistant message. That text is
          // the only explanation the user gets, so it becomes the error.
          const apiText = record["is_api_error_message"] === true ? apiErrorText(message) : "";
          if (apiText) throw sdkError(withRequestId(apiText, requestId));
          throw assistantFailure(errorCode, model, session.stderr());
        }
        renderer.assistant(message);
        continue;
      }
      if (type === "rate_limit_event") {
        const info = record["rate_limit_info"];
        if (isRecord(info)) latestRateLimit = info as RateLimitInfo;
        continue;
      }
      if (type === "system") {
        const subtype = record["subtype"];
        if (subtype === "init") {
          checkToolServer(session.mcpServers, specs);
        } else if (subtype === "permission_denied") {
          const denied = typeof record["tool_name"] === "string" ? record["tool_name"] : "";
          if (denied.startsWith(TOOL_NAME_PREFIX)) {
            throw toolError(
              `Claude Code denied the offered tool ${denied} instead of dispatching it to Pi. ` +
                "Pi never lets Claude Code substitute its own tool for an offered one.",
            );
          }
        }
        continue;
      }
      if (type === "result") {
        resultFrame = record;
        resultSubtype = typeof record["subtype"] === "string" ? record["subtype"] : undefined;
        nativeCostUsd = toNumber(record["total_cost_usd"]) ?? -1;
        break;
      }
    }

    if (resultFrame && resultFrame["is_error"] === true) {
      const errors = Array.isArray(resultFrame["errors"])
        ? resultFrame["errors"].filter((entry): entry is string => typeof entry === "string")
        : [];
      const text = typeof resultFrame["result"] === "string" ? resultFrame["result"] : "";
      throw resultFailure([...errors, text].filter(Boolean).join("; "), resultSubtype, model);
    }

    const nativeStop =
      renderer.stopReason ??
      (typeof resultFrame?.["stop_reason"] === "string" ? resultFrame["stop_reason"] : null);
    const usage = mapUsage(renderer.lastUsage) ?? mapUsage(resultFrame?.["usage"]);
    if (!usage) {
      throw incompleteError("Claude Code returned no token usage for this step");
    }

    const calls = renderer.toolCalls();
    const stop = nativeStop ?? (calls.length > 0 ? "tool_use" : "end_turn");
    const mapped = mapStopReason(stop, stop === "refusal" ? renderer.refusalText() : undefined);
    if (mapped.stopReason === "toolUse" && calls.length === 0) {
      throw incompleteError("Claude stopped for tool use without any tool call");
    }

    renderer.adoptCompleted();
    renderer.closeBlocks();

    // Claude Code streams reasoning as an encrypted signature without readable
    // text. A block with neither is not a reasoning step Pi can show.
    output.content = output.content.filter(
      (block) => block.type !== "thinking" || block.thinking.trim() !== "" || block.redacted === true,
    );

    const toolCalls: ToolCall[] = [];
    const unoffered: string[] = [];
    for (const [index, call] of calls.entries()) {
      const bare = toolBareName(call.name);
      if (bare === null || !isOffered(call.name, specs)) {
        // Pi never runs a tool it did not offer. Claude Code answers the call
        // itself, and the model usually corrects itself in the next step.
        unoffered.push(call.name || "(unnamed)");
        continue;
      }
      const parsed = parseToolInput(call.input);
      const toolCall: ToolCall = {
        type: "toolCall",
        id: call.id || `tool-${index}`,
        name: bare,
        arguments: parsed,
      };
      const contentIndex = output.content.length;
      output.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(parsed), partial: output });
      const final = output.content[contentIndex];
      if (final?.type === "toolCall") final.arguments = parsed;
      toolCalls.push(toolCall);
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }

    if (unoffered.length > 0) {
      const names = [...new Set(unoffered)].join(", ");
      logTransportEvent({
        kind: "unoffered_tool",
        message: `Claude called a tool Pi did not offer: ${names}`,
        model: model.id,
        cliVersion: session.cliVersion,
        claudeSessionId: session.sessionId,
        requestId,
        stderrTail: session.stderr(),
        piSessionId: options.sessionId,
      }, logEnv);
      if (unoffered.length > MAX_UNOFFERED_CALLS) {
        throw toolError(
          `Claude called a tool Pi did not offer ${unoffered.length} times in one turn: ${names}. ` +
            "Pi never substitutes its own tool for an offered one. Retry the turn.",
        );
      }
    }

    output.usage = usage;
    calculateCost(model, output.usage);
    if (renderer.streamId) output.responseId = renderer.streamId;
    if (renderer.streamModel && renderer.streamModel !== model.id) {
      output.responseModel = renderer.streamModel;
    }
    output.rawStopReason = stop;
    output.endTurn = stop === "end_turn";
    output.stopReason = mapped.stopReason;
    if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;

    // A turn can spend its whole output budget on thinking. Pi would publish an
    // empty message with a generic truncation notice, so name the cause instead.
    const answered = output.content.some(
      (block) => (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall",
    );
    if (stop === "max_tokens" && !answered) {
      throw nativeError(
        `${model.id} spent its whole output budget on thinking and returned no answer. ` +
          "Lower the thinking level or switch models, then retry.",
      );
    }

    enforceUsageCredits(latestRateLimit, mergedEnv);

    const known = nonSystem(context.messages);
    managed.historyLength = known.length + 1;
    managed.historyDigest = digestMessages([...known, output]);
    managed.awaiting = mapped.stopReason === "toolUse" ? toolCalls.map((call) => call.id) : [];
    keepSession = true;
    output.diagnostics = [
      ...(latestRateLimit ? [rateLimitDiagnostic(latestRateLimit)] : []),
      diagnostic(SESSION_DIAGNOSTIC),
    ];

    if (output.stopReason === "error") {
      stream.push({ type: "error", reason: "error", error: output });
      stream.end(output);
      return;
    }
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end(output);
  } catch (error) {
    fail(error);
  } finally {
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
    if (!keepSession) {
      // The session state is unknown after a failure; Pi's history is rebuilt
      // from a checkpoint on the next call instead of being trusted.
      deps.sessions.drop(key);
    }
  }
}

/** True when a reported tool name maps to a tool Pi offered this turn. */
function isOffered(name: string, specs: PiToolSpec[]): boolean {
  const bare = toolBareName(name);
  return bare !== "" && specs.some((spec) => spec.name === bare);
}

/** Anthropic support asks for this id first; keep it next to the provider's text. */
function withRequestId(text: string, requestId: string | undefined): string {
  return requestId ? `${text} (request id ${requestId})` : text;
}

/** Text of a synthetic API error message, which is the provider's own wording. */
function apiErrorText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
    .join("")
    .trim();
}

/** Claude Code must report the host tool server as connected. */
function checkToolServer(servers: Array<{ name: string; status: string }>, specs: PiToolSpec[]): void {
  if (specs.length === 0) return;
  const server = servers.find((entry) => entry.name === MCP_SERVER_NAME);
  if (!server || server.status !== "connected") {
    throw toolError(
      `Claude Code did not connect the Pi tool server (status: ${server?.status ?? "missing"}). ` +
        "Pi will not fall back to Claude Code's own tools.",
    );
  }
}

function assistantFailure(code: string, model: Model<Api>, stderr?: string): DirectSdkError {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return loggedOutError(code);
    case "billing_error":
      return new DirectSdkError(
        "billing",
        "Claude Code reported a billing error for this request. Pi does not switch to an API key, " +
          "gateway, or cloud billing route. Check your Claude plan and usage limits, then retry.",
      );
    case "model_not_found":
      return new DirectSdkError(
        "native",
        `Claude Code does not offer ${model.id} to this account. Pick another model from /model.`,
      );
    default: {
      // The CLI classifies what it cannot attribute as "unknown"; its stderr is
      // often the only place the real reason appears.
      const detail = stderr?.trim().slice(-400);
      return sdkError(`Claude Code reported ${code}${detail ? `, stderr: ${detail}` : ""}`);
    }
  }
}

function resultFailure(detail: string, subtype: string | undefined, model: Model<Api>): Error {
  if (/not logged in|authentication_failed|oauth/i.test(detail)) {
    return loggedOutError(detail);
  }
  const rejection = usageCreditsRejectionError(detail);
  if (rejection) return rejection;
  if (/prompt is too long|context_length_exceeded|context window/i.test(detail)) {
    return nativeError(
      `context_length_exceeded: ${detail}. Model ${model.id} has a configured context window of ` +
        `${model.contextWindow.toLocaleString("en-US")} tokens. Compact the session or check the model override.`,
    );
  }
  return sdkError(`${subtype ?? "failed"}: ${detail}`);
}

/** Tool input from streamed JSON, falling back to the complete message. */
function parseStreamedInput(json: string, completed: unknown): unknown {
  if (json.trim() === "") return completed ?? {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    if (completed !== undefined) return completed;
    throw toolError(`Claude streamed tool input that is not valid JSON: ${json.slice(0, 200)}`);
  }
}

function parseToolInput(input: unknown): JsonObject {
  const coerce = (value: unknown): JsonObject => {
    if (!isRecord(value)) {
      throw toolError("Claude returned tool input that is not an object");
    }
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  };
  if (typeof input === "string") {
    return coerce(input.trim() ? (JSON.parse(input) as unknown) : {});
  }
  return coerce(input);
}
