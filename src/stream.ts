/**
 * Pi `streamSimple` implementation for the Claude DirectSDK provider.
 *
 * One Pi model call spawns one request-scoped `claude` child, replays Pi
 * history in native `stream-json` form, admits at most one upstream Messages
 * request through the loopback relay, and converts the native response to Pi
 * stream events. Pi alone executes tools: native tool calls are published
 * only after the first upstream response is complete, usage and stop reason
 * are captured, and the child has exited.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  AssistantMessageEventStream,
  JsonObject,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { AdmissionRelay } from "./admission.js";
import {
  DirectSdkError,
  cancelledError,
  envConflictError,
  incompleteError,
  isCancelled,
  loggedOutError,
  missingError,
  nativeError,
  upstreamError,
} from "./errors.js";
import { PROVIDER_ID, QUALIFIED_CLI_RANGE, nativeModel } from "./models.js";
import {
  encodeCarrier,
  messageProjection,
  prepareHistory,
} from "./replay.js";
import {
  buildArgv,
  buildChildEnv,
  buildRequestBody,
  checkEnvConflicts,
  toolBareName,
  writeRequestFiles,
} from "./request.js";
import { qualifiedCli, resolveClaude } from "./setup.js";
import {
  NativeAssistantMessage,
  NativeContentBlock,
  NativeResultLine,
  NativeUsage,
  deepClone,
  isRecord,
} from "./types.js";
import {
  ChildHandle,
  spawnSupervised,
  stableChildCwd,
} from "./process.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const NATIVE_API = "claude-directsdk";

export interface CallDeps {
  spawn: (options: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }) => ChildHandle;
  createRelay: (upstream: string, timeoutMs: number) => Promise<AdmissionRelay>;
  checkCli: (resolved: string[], env: NodeJS.ProcessEnv) => boolean;
  makeRequestDir: () => string;
  childCwd: () => string;
}

export const defaultDeps: CallDeps = {
  spawn: (options) => spawnSupervised(options),
  createRelay: (upstream, timeoutMs) => AdmissionRelay.create(upstream, timeoutMs),
  checkCli: (resolved, env) => qualifiedCli(resolved, env),
  makeRequestDir: () => mkdtempSync(join(tmpdir(), "pi-directsdk-")),
  childCwd: () => stableChildCwd(),
};

function zeroUsage(): AssistantMessage["usage"] {
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

/** Pi usage from authoritative native usage. Returns null when incomplete. */
function mapUsage(usage: NativeUsage | undefined): AssistantMessage["usage"] | null {
  const input = toNumber(usage?.input_tokens);
  const output = toNumber(usage?.output_tokens);
  if (input === null || output === null) {
    return null;
  }
  const cacheRead = toNumber(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = toNumber(usage?.cache_creation_input_tokens) ?? 0;
  const cacheWrite1h =
    toNumber(usage?.cache_creation?.ephemeral_1h_input_tokens) ?? undefined;
  const reasoning =
    toNumber(usage?.output_tokens_details?.thinking_tokens) ?? undefined;
  const mapped: AssistantMessage["usage"] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (cacheWrite1h !== undefined) {
    mapped.cacheWrite1h = cacheWrite1h;
  }
  if (reasoning !== undefined) {
    mapped.reasoning = reasoning;
  }
  return mapped;
}

function mapStopReason(stop: string, detail?: string): {
  stopReason: "stop" | "length" | "toolUse" | "error";
  errorMessage?: string;
} {
  switch (stop) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "pause_turn":
    case "stop_sequence":
      return { stopReason: "stop" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: detail || "The model refused to complete the request",
      };
    default:
      return { stopReason: "error", errorMessage: `Unhandled stop reason: ${stop}` };
  }
}

interface ProgressiveBlock {
  kind: "text" | "thinking";
  /** Native content-block index from the upstream stream. */
  nativeIndex: number;
  contentIndex: number;
  emitted: string;
  signature: string;
  redacted: boolean;
}

function findProgressive(
  progressive: ProgressiveBlock[],
  kind: ProgressiveBlock["kind"],
  nativeIndex: number,
): ProgressiveBlock | undefined {
  return (
    progressive.find((p) => p.kind === kind && p.nativeIndex === nativeIndex) ??
    [...progressive].reverse().find((p) => p.kind === kind)
  );
}

interface PendingTool {
  index: number;
  id: string;
  name: string;
  json: string;
}

export function streamClaudeDirectSdk(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  deps: CallDeps = defaultDeps,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void executeCall(model, context, options ?? {}, stream, deps).catch((error) => {
    // executeCall always terminates the stream itself; this is unreachable.
    void error;
  });
  return stream;
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
  let started = false;
  const fail = (error: unknown): void => {
    const aborted = isCancelled(error) || options.signal?.aborted === true;
    // A failed or interrupted request is never reported as free: keep any
    // usage captured before the failure instead of zeroing it.
    output.stopReason = aborted ? "aborted" : "error";
    output.errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);
    if (!started) {
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
      return;
    }
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  };

  let relay: AdmissionRelay | null = null;
  let child: ChildHandle | null = null;
  let requestDir: string | null = null;
  const cleanup = (): void => {
    if (child) {
      child.cancel();
    }
    if (relay) {
      void relay.close().catch(() => undefined);
    }
    if (requestDir) {
      try {
        rmSync(requestDir, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the request outcome.
      }
    }
  };
  if (options.signal?.aborted) {
    fail(cancelledError());
    return;
  }

  try {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    const conflicts = checkEnvConflicts(mergedEnv);
    if (conflicts.length > 0) {
      throw envConflictError(conflicts);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive milliseconds");
    }

    const collapsed = collapseSystemMessages(context);
    const systemPrompt = getCurrentSystemPrompt(collapsed.messages);
    const tools = getCurrentTools(collapsed.messages);
    const history = collapsed.messages.filter((m) => m.role !== "system");
    const nativeModelId = nativeModel(model.id);
    const build = buildRequestBody({
      tools,
      toolChoice: options.toolChoice,
      reasoning: options.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      nativeModelId,
      maxTokens: options["maxTokens"] as number | undefined,
    });
    const { frames } = prepareHistory(history, new Set(build.toolNames));

    // Extension request inspection hook. The replacement replaces the native
    // request body when it returns one.
    const payloadReplacement = await options.onPayload?.(
      deepClone(build.body),
      model,
    );
    const body =
      payloadReplacement === undefined
        ? build.body
        : isRecord(payloadReplacement)
          ? (payloadReplacement as Record<string, unknown>)
          : (() => {
              throw new Error("onPayload replacement must be an object");
            })();

    const resolved = resolveClaude(undefined, mergedEnv);
    if (!resolved?.[0]) {
      throw missingError();
    }
    if (!deps.checkCli(resolved, mergedEnv)) {
      throw nativeError(
        `Unsupported claude version: this provider qualifies ${QUALIFIED_CLI_RANGE}`,
      );
    }
    const upstream = mergedEnv["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com";

    requestDir = deps.makeRequestDir();
    const files = writeRequestFiles(requestDir, {
      systemPrompt,
      body,
      manifest: build.manifest,
    });
    relay = await deps.createRelay(upstream, timeoutMs);
    const activeRelay = relay;
    // Stashed at header time, invoked after the response completes and
    // before the completion gate consumes it, per the streamSimple contract.
    let providerResponse: { status: number; headers: Record<string, string> } | null = null;
    activeRelay.onUpstreamResponse = (status, headers) => {
      providerResponse = { status, headers };
    };
    const abortRelay = (): void => {
      activeRelay.abort();
    };
    options.signal?.addEventListener("abort", abortRelay, { once: true });

    const childEnv = buildChildEnv({ baseEnv: mergedEnv, relayUrl: relay.url, body });
    const { command, args } = buildArgv({
      claudeBin: resolved[0],
      nativeModelId,
      files,
    });
    child = deps.spawn({
      command,
      args,
      env: childEnv,
      cwd: deps.childCwd(),
      timeoutMs,
      signal: options.signal,
    });

    stream.push({ type: "start", partial: output });
    started = true;

    // Replay history. Historical user frames expect zero-turn
    // acknowledgments; only the final frame may generate.
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i];
      if (!frame) {
        continue;
      }
      await child.writeLine(JSON.stringify(frame));
      if (frame.type === "user" && i < frames.length - 1) {
        for (;;) {
          const line = await child.nextLine();
          if (line === null) {
            throw incompleteError("Native exited before replay acknowledgment");
          }
          const ack = parseNativeLine(line);
          if (ack.type !== "result") {
            continue;
          }
          if (ack.num_turns !== 0 || ack.is_error) {
            throw incompleteError(
              "Native history replay not supported: expected zero-turn acknowledgment",
            );
          }
          break;
        }
      }
    }
    child.closeStdin();

    // Consume the final response.
    const assistants: NativeAssistantMessage[] = [];
    const results: NativeResultLine[] = [];
    let stopped = false;
    let streamId: string | undefined;
    let streamModel: string | undefined;
    let streamUsage: NativeUsage | undefined;
    let streamStop: string | undefined;
    let nativeErrorText: string | undefined;
    let emittedText = "";
    const progressive: ProgressiveBlock[] = [];
    const pendingTools: PendingTool[] = [];

    for (;;) {
      const line = await child.nextLine();
      if (line === null) {
        break;
      }
      const event = parseNativeLine(line);
      if (event.type === "assistant") {
        const message = (event as { message?: unknown }).message;
        if (isRecord(message)) {
          const detail = assistantErrorDetail(message);
          if (detail) {
            nativeErrorText = nativeErrorText ? `${nativeErrorText}\n${detail.text}` : detail.text;
            if (detail.code === "authentication_failed") {
              nativeErrorText = `authentication_failed: ${nativeErrorText}`;
            }
          } else {
            assistants.push(message as unknown as NativeAssistantMessage);
          }
        }
      } else if (event.type === "result") {
        results.push(event as unknown as NativeResultLine);
      } else if (event.type === "stream_event") {
        const native = (event as { event?: unknown }).event;
        if (!isRecord(native)) {
          continue;
        }
        switch (native["type"]) {
          case "message_start": {
            const message = native["message"];
            if (isRecord(message)) {
              streamId = typeof message["id"] === "string" ? message["id"] : streamId;
              streamModel =
                typeof message["model"] === "string" ? message["model"] : streamModel;
              if (isRecord(message["usage"])) {
                streamUsage = message["usage"] as NativeUsage;
              }
            }
            break;
          }
          case "content_block_start": {
            const index = toNumber(native["index"]) ?? pendingTools.length + progressive.length;
            const block = native["content_block"];
            if (!isRecord(block)) {
              break;
            }
            if (block["type"] === "text") {
              const contentIndex = output.content.length;
              output.content.push({ type: "text", text: "" });
              progressive.push({ kind: "text", nativeIndex: index, contentIndex, emitted: "", signature: "", redacted: false });
              stream.push({ type: "text_start", contentIndex, partial: output });
            } else if (block["type"] === "thinking") {
              const contentIndex = output.content.length;
              const thinkingBlock: ThinkingContent = {
                type: "thinking",
                thinking: "",
                thinkingSignature: typeof block["signature"] === "string" ? block["signature"] : "",
              };
              output.content.push(thinkingBlock);
              progressive.push({
                kind: "thinking",
                nativeIndex: index,
                contentIndex,
                emitted: "",
                signature: thinkingBlock.thinkingSignature ?? "",
                redacted: false,
              });
              stream.push({ type: "thinking_start", contentIndex, partial: output });
            } else if (block["type"] === "redacted_thinking") {
              const contentIndex = output.content.length;
              output.content.push({
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: typeof block["data"] === "string" ? block["data"] : "",
                redacted: true,
              });
              progressive.push({
                kind: "thinking",
                nativeIndex: index,
                contentIndex,
                emitted: "[Reasoning redacted]",
                signature: "",
                redacted: true,
              });
              stream.push({ type: "thinking_start", contentIndex, partial: output });
            } else if (block["type"] === "tool_use") {
              pendingTools.push({
                index,
                id: typeof block["id"] === "string" ? block["id"] : "",
                name: typeof block["name"] === "string" ? block["name"] : "",
                json: "",
              });
            } else {
              throw new DirectSdkError(
                "native",
                `Unsupported native content block: ${String(block["type"])}`,
              );
            }
            break;
          }
          case "content_block_delta": {
            const delta = native["delta"];
            const index = toNumber(native["index"]) ?? -1;
            if (!isRecord(delta)) {
              break;
            }
            if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
              const target = findProgressive(progressive, "text", index);
              if (target) {
                const block = output.content[target.contentIndex];
                if (block?.type === "text") {
                  block.text += delta["text"];
                  target.emitted += delta["text"];
                  emittedText += delta["text"];
                  stream.push({
                    type: "text_delta",
                    contentIndex: target.contentIndex,
                    delta: delta["text"],
                    partial: output,
                  });
                }
              }
            } else if (
              delta["type"] === "thinking_delta" &&
              typeof delta["thinking"] === "string"
            ) {
              const target = findProgressive(progressive, "thinking", index);
              const open = target && !target.redacted ? target : undefined;
              if (open) {
                const block = output.content[open.contentIndex];
                if (block?.type === "thinking") {
                  block.thinking += delta["thinking"];
                  open.emitted += delta["thinking"];
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: open.contentIndex,
                    delta: delta["thinking"],
                    partial: output,
                  });
                }
              }
            } else if (delta["type"] === "signature_delta" && typeof delta["signature"] === "string") {
              const target = findProgressive(progressive, "thinking", index);
              if (target) {
                target.signature += delta["signature"];
                const block = output.content[target.contentIndex];
                if (block?.type === "thinking") {
                  block.thinkingSignature = (block.thinkingSignature ?? "") + delta["signature"];
                }
              }
            } else if (delta["type"] === "input_json_delta") {
              const tool = pendingTools.find((t) => t.index === index) ?? pendingTools[pendingTools.length - 1];
              if (tool && typeof delta["partial_json"] === "string") {
                tool.json += delta["partial_json"];
              }
            }
            break;
          }
          case "content_block_stop":
            break;
          case "message_delta": {
            const delta = native["delta"];
            if (isRecord(delta) && typeof delta["stop_reason"] === "string") {
              streamStop = delta["stop_reason"];
            }
            const usage = native["usage"];
            if (isRecord(usage)) {
              streamUsage = { ...(streamUsage ?? {}), ...(usage as NativeUsage) } as NativeUsage;
            }
            break;
          }
          case "message_stop":
            stopped = true;
            break;
          default:
            break;
        }
      }
      if (options.signal?.aborted) {
        throw cancelledError();
      }
    }
    const exitInfo = await child.wait();
    options.signal?.removeEventListener("abort", abortRelay);
    if (options.signal?.aborted) {
      throw cancelledError();
    }
    if (providerResponse) {
      await options.onResponse?.(providerResponse, model);
    }

    // Completion gate. Tool calls publish only after the first upstream
    // response is complete, usage and stop reason are captured, and the
    // child has exited.
    const used = relay.used;
    let authoritative: NativeAssistantMessage;
    const soleResult = results[0];
    // Stderr is the only CLI diagnostic when the native protocol breaks.
    const childDetail = child
      ? ` (exit ${child.exitInfo?.code ?? "?"}${
          child.exitInfo?.signal ? `/${child.exitInfo.signal}` : ""
        }, stderr: ${child.stderrTail(500) || "<empty>"})`
      : "";
    if (results.length !== 1 || !soleResult) {
      throw incompleteError(
        `Expected exactly one native result, saw ${results.length}${childDetail}`,
      );
    }
    const result: NativeResultLine = soleResult;
    if (used) {
      if (relay.status !== 200 || !relay.capture.complete || !relay.capture.message) {
        throw upstreamError(
          `first upstream attempt: status ${relay.status ?? "unknown"}, ` +
            `capture ${relay.capture.complete ? "complete" : "incomplete"}` +
            (relay.failure ? `, relay failure ${relay.failure}` : "") +
            `, native retries denied: ${relay.denied}` +
            (relay.errorText() ? `, upstream said: ${relay.errorText().slice(0, 500)}` : "") +
            (nativeErrorText ? `: ${nativeErrorText}` : ""),
        );
      }
      authoritative = relay.capture.message;
      stopped = true;
    } else {
      if (nativeErrorText && /authentication_failed|not logged in/i.test(nativeErrorText)) {
        throw loggedOutError(nativeErrorText);
      }
      if (nativeErrorText) {
        throw nativeError(nativeErrorText);
      }
      if (assistants.length === 0 || !stopped) {
        const resultText =
          typeof result["result"] === "string" ? result["result"] : undefined;
        if (resultText && /not logged in/i.test(resultText)) {
          throw loggedOutError(resultText);
        }
        throw incompleteError(`assistant, message_stop and one result required${childDetail}`);
      }
      authoritative = mergeAssistants(assistants, result);
    }

    const denialHandled = relay.denied > 0 || authoritative.stop_reason === "refusal";
    if (nativeErrorText && !denialHandled) {
      throw nativeError(nativeErrorText);
    }
    const exitCode = exitInfo.code;
    const calls = blocksOf(authoritative, "tool_use");
    const boundary =
      calls.length > 0 && result?.subtype === "error_max_turns" && exitCode === 1;
    if (
      !boundary &&
      !denialHandled &&
      (exitCode !== 0 || result?.is_error || result?.subtype !== "success")
    ) {
      const detail =
        typeof result?.["result"] === "string" && result["result"]
          ? `: ${result["result"]}`
          : "";
      throw nativeError(`${result?.subtype ?? "unknown exit"}${detail}`);
    }

    const usage = mapUsage(authoritative.usage ?? streamUsage);
    if (!usage) {
      throw incompleteError("Native result missing complete token usage");
    }
    output.usage = usage;
    if (typeof authoritative.id === "string" && authoritative.id) {
      output.responseId = authoritative.id;
    } else if (streamId) {
      output.responseId = streamId;
    }
    const responseModel = authoritative.model ?? streamModel;
    if (responseModel && responseModel !== model.id) {
      output.responseModel = responseModel;
    }
    output.rawStopReason = authoritative.stop_reason ?? streamStop ?? result?.subtype ?? "unknown";
    output.endTurn = (authoritative.stop_reason ?? streamStop) === "end_turn";

    // Reconcile progressive text/thinking with the authoritative message,
    // then close every open block and publish tool calls.
    const finalText = textOf(authoritative);
    if (emittedText !== finalText) {
      if (emittedText && !finalText.startsWith(emittedText)) {
        throw incompleteError("Native final text differs from incremental stream");
      }
      const tail = finalText.slice(emittedText.length);
      if (tail) {
        const target = [...progressive].reverse().find((p) => p.kind === "text");
        if (target) {
          const block = output.content[target.contentIndex];
          if (block?.type === "text") {
            block.text += tail;
            stream.push({
              type: "text_delta",
              contentIndex: target.contentIndex,
              delta: tail,
              partial: output,
            });
          }
        } else {
          const contentIndex = output.content.length;
          output.content.push({ type: "text", text: tail });
          stream.push({ type: "text_start", contentIndex, partial: output });
          stream.push({ type: "text_delta", contentIndex, delta: tail, partial: output });
        }
      }
    }
    const finalThinkings = blocksOf(authoritative, "thinking");
    const openThinkings = progressive.filter((p) => p.kind === "thinking");
    openThinkings.forEach((prog, i) => {
      const block = output.content[prog.contentIndex];
      const native = finalThinkings[i] as
        | { thinking?: unknown; signature?: unknown }
        | undefined;
      if (block?.type === "thinking" && !prog.redacted) {
        if (typeof native?.signature === "string") {
          block.thinkingSignature = native.signature;
        } else if (prog.signature) {
          block.thinkingSignature = prog.signature;
        }
      }
      if (block?.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: prog.contentIndex,
          content: block.thinking,
          partial: output,
        });
      }
    });
    const openTexts = progressive.filter((p) => p.kind === "text");
    for (const prog of openTexts) {
      const block = output.content[prog.contentIndex];
      if (block?.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: prog.contentIndex,
          content: block.text,
          partial: output,
        });
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const block of calls) {
      const raw = block as unknown as Record<string, unknown>;
      const name = typeof raw["name"] === "string" ? raw["name"] : "";
      const bare = toolBareName(name);
      if (!bare || !build.toolNames.includes(bare)) {
        throw new DirectSdkError(
          "native",
          "Native returned a tool outside the current host inventory",
        );
      }
      const parsed = parseToolInput(raw["input"]);
      const toolCall: ToolCall = {
        type: "toolCall",
        id: typeof raw["id"] === "string" && raw["id"] ? raw["id"] : `tool-${toolCalls.length}`,
        name: bare,
        arguments: parsed,
      };
      const contentIndex = output.content.length;
      output.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      const delta = JSON.stringify(parsed);
      stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
      const final = output.content[contentIndex];
      if (final?.type === "toolCall") {
        final.arguments = parsed;
      }
      toolCalls.push(toolCall);
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    }

    const stop = authoritative.stop_reason ?? streamStop ?? (calls.length > 0 ? "tool_use" : "end_turn");
    const mapped = mapStopReason(
      stop,
      stop === "refusal" ? refusalText(authoritative) : undefined,
    );
    if (mapped.stopReason === "toolUse" && toolCalls.length === 0) {
      throw incompleteError("Native stopped for tool use without tool calls");
    }
    output.stopReason = mapped.stopReason;
    if (mapped.errorMessage) {
      output.errorMessage = mapped.errorMessage;
    }
    calculateCost(model, output.usage);

    const projection = messageProjection(output);
    const natives = used && relay.capture.message ? [relay.capture.message] : assistants;
    output.diagnostics = [
      encodeCarrier(natives, projection),
      {
        type: "pi-claude-directsdk/meta",
        timestamp: Date.now(),
        details: {
          nativeModel: nativeModelId,
          requestId: relay.requestId ?? "",
          upstreamRequests: used ? 1 : 0,
          blockedRequests: relay.denied,
          nativeCostUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : -1,
          nativeCostNote: "estimate, not subscription charge",
          cliAvailable: true,
        },
      },
    ];

    if (output.stopReason === "error") {
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
      return;
    }
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    // Preserve partial usage captured before the failure; the provider must
    // never report a failed request as free when tokens were consumed.
    if (started && relay?.capture.message?.usage) {
      const partial = mapUsage(relay.capture.message.usage);
      if (partial) {
        try {
          calculateCost(model, partial);
          output.usage = partial;
        } catch {
          // Accounting must not mask the original failure.
        }
      }
    }
    fail(error);
  } finally {
    cleanup();
  }
}

function parseNativeLine(line: string): { type: string; [key: string]: unknown } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      throw new Error("not a native event");
    }
    return parsed as { type: string; [key: string]: unknown };
  } catch (error) {
    throw new DirectSdkError(
      "native",
      `Invalid native stream-json output: ${JSON.stringify(line.slice(0, 300))}`,
      { cause: error },
    );
  }
}

function assistantErrorDetail(message: Record<string, unknown>): {
  text: string;
  code?: string | undefined;
} | null {
  const direct = message["error"];
  if (typeof direct === "string" && direct) {
    return { text: direct };
  }
  if (isRecord(direct)) {
    return {
      text: typeof direct["message"] === "string" ? direct["message"] : JSON.stringify(direct),
      code: typeof direct["code"] === "string" ? direct["code"] : undefined,
    };
  }
  const content = message["message"];
  const blocks = isRecord(content) ? content["content"] : message["content"];
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter(isRecord)
      .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("\n");
    const nested = (message["message"] as Record<string, unknown> | undefined)?.["error"];
    if (text && nested) {
      return { text };
    }
  }
  return null;
}

/** Merge stdout assistant messages for the non-relay fallback path. */
function mergeAssistants(
  assistants: NativeAssistantMessage[],
  result: NativeResultLine,
): NativeAssistantMessage {
  const content: NativeContentBlock[] = [];
  let stop: string | null | undefined;
  let id: string | undefined;
  let model: string | undefined;
  for (const assistant of assistants) {
    content.push(...deepClone(assistant.content));
    stop = assistant.stop_reason ?? stop;
    id = assistant.id ?? id;
    model = assistant.model ?? model;
  }
  return {
    role: "assistant",
    content,
    stop_reason: stop ?? null,
    usage: deepClone(result.usage ?? { input_tokens: 0, output_tokens: 0 }),
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
  };
}

function blocksOf(message: NativeAssistantMessage, type: string): NativeContentBlock[] {
  return message.content.filter((b) => b.type === type);
}

function textOf(message: NativeAssistantMessage): string {
  return blocksOf(message, "text")
    .map((b) => ((b as unknown as Record<string, unknown>)["text"] as string) ?? "")
    .join("");
}

function refusalText(message: NativeAssistantMessage): string {
  const text = textOf(message);
  return text || "The model refused to complete the request";
}

function parseToolInput(input: unknown): JsonObject {
  const coerce = (value: unknown): JsonObject => {
    if (!isRecord(value)) {
      throw new DirectSdkError("native", "Native tool input is not an object");
    }
    // A JSON round-trip keeps the arguments within pi-ai's JsonValue type.
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  };
  if (typeof input === "string") {
    return coerce(input.trim() ? (JSON.parse(input) as unknown) : {});
  }
  return coerce(input);
}
