/**
 * Behaviour of the SDK transport through its real entry point.
 *
 * The Claude Agent SDK is replaced by a scripted runtime, so these tests cover
 * what Pi observes: streamed events, usage, stop reasons, the tool round trip
 * across model calls, session reuse and rebuild, cancellation, and failures.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetryableAssistantError, normalizeContext } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { ALLOW_USAGE_CREDITS_ENV } from "../src/billing.ts";
import { TEST_UPSTREAM_ENV } from "../src/env.ts";
import { LOG_ENV, logPath, logTransportEvent } from "../src/sdk/log.ts";
import { SessionRegistry, streamClaudeDirectSdk, type CallDeps } from "../src/sdk/stream.ts";
import {
  apiErrorFrame,
  FakeClaude,
  model,
  overageFrame,
  reasoningStep,
  textStep,
  toolStep,
  USAGE,
} from "./fake-sdk.ts";

const PROMPT = "You are Pi. Answer with the host tools.";

/** A log file no other test reads. */
function tmpLog(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `directsdk-${name}-`)), "log.jsonl");
}
const SYSTEM_PROMPT = "Pi system prompt";

function harness(): { fake: FakeClaude; deps: CallDeps } {
  const fake = new FakeClaude();
  const deps: CallDeps = {
    loadRuntime: async () => fake,
    resolveCli: () => ["/fake/claude"],
    cwd: () => "/fake/work",
    sessions: new SessionRegistry(),
  };
  return { fake, deps };
}

function readTool(): Tool {
  return {
    name: "read",
    description: "Read a file from the workspace",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    } as unknown as Tool["parameters"],
  };
}

function context(messages: unknown[], tools: Tool[] = []): ReturnType<typeof normalizeContext> {
  return normalizeContext({
    systemPrompt: SYSTEM_PROMPT,
    tools,
    messages: messages as never,
  });
}

function call(
  deps: CallDeps,
  messages: unknown[],
  options: {
    tools?: Tool[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionId?: string;
    reasoning?: string;
  } = {},
): AssistantMessageEventStream {
  return streamClaudeDirectSdk(
    model(),
    context(messages, options.tools ?? []),
    {
      timeoutMs: options.timeoutMs ?? 2_000,
      sessionId: options.sessionId ?? "conversation",
      env: { [TEST_UPSTREAM_ENV]: "1", [LOG_ENV]: "", ...options.env },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    } as never,
    deps,
  );
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function final(events: AssistantMessageEvent[]): AssistantMessage {
  const last = events[events.length - 1];
  assert.ok(last, "the stream produced no events");
  if (last.type === "done") return last.message;
  if (last.type === "error") return last.error;
  assert.fail(`the stream ended with ${last.type}`);
}

function failure(events: AssistantMessageEvent[]): AssistantMessage {
  const message = final(events);
  assert.equal(message.stopReason, "error", `expected an error, got: ${JSON.stringify(message.content)}`);
  return message;
}

function userText(text: string, timestamp = 1): unknown {
  return { role: "user", content: text, timestamp };
}

function assistantWith(call: { id: string; name: string; arguments: Record<string, unknown> }): unknown {
  return {
    role: "assistant",
    content: [{ type: "toolCall", ...call }],
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  } as ToolResultMessage;
}

test("streams one answer with usage, and isolates Claude Code from its own tools and settings", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("hello")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("hi there"));

  const done = final(await events);
  assert.equal(done.stopReason, "stop");
  assert.equal(done.rawStopReason, "end_turn");
  assert.deepEqual(
    done.content.map((block) => (block.type === "text" ? block.text : block.type)),
    ["hi there"],
  );
  assert.equal(done.usage.input, USAGE.input_tokens);
  assert.equal(done.usage.output, USAGE.output_tokens);
  assert.equal(done.usage.cacheRead, USAGE.cache_read_input_tokens);
  assert.equal(done.usage.cacheWrite, USAGE.cache_creation_input_tokens);
  assert.equal(done.usage.totalTokens, 24);
  assert.equal(done.responseId, "msg_fake");

  // Pi supplies the tools, the instructions, and the approvals.
  assert.deepEqual(query.options.tools, []);
  assert.deepEqual(query.options.settingSources, []);
  assert.deepEqual(query.options.skills, []);
  assert.equal(query.options.permissionMode, "dontAsk");
  assert.equal(query.options.persistSession, false);
  assert.equal(query.options.strictMcpConfig, true);
  assert.equal(query.options.includePartialMessages, true);
  assert.equal(query.options.model, "claude-haiku-4-5-20251001");
  const systemPrompt = query.options.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(systemPrompt.type, "preset");
  assert.equal(systemPrompt.append, SYSTEM_PROMPT);
  assert.match(query.users[0] ?? "", /hello/);
});

test("drops the signature-only reasoning block Claude Code sends for encrypted thinking", async () => {
  const { fake, deps } = harness();
  const collecting = collect(call(deps, [userText("think, then answer")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...reasoningStep("done"));

  const events = await collecting;
  const done = final(events);
  assert.equal(done.stopReason, "stop");
  assert.deepEqual(
    done.content.map((block) =>
      block.type === "thinking" ? `thinking:${block.thinking}` : block.type === "text" ? `text:${block.text}` : block.type,
    ),
    ["thinking:readable reasoning", "text:done"],
  );
  // The deltas still streamed; only the published message is filtered.
  assert.ok(events.some((event) => event.type === "thinking_delta"));
});

test("returns a tool call to Pi, then continues the same session with Pi's result", async () => {
  const { fake, deps } = harness();
  const tools = [readTool()];

  const first = collect(call(deps, [userText("read a.txt")], { tools }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...toolStep([{ id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } }]));

  const step = final(await first);
  assert.equal(step.stopReason, "toolUse");
  const callBlock = step.content.find((block) => block.type === "toolCall");
  assert.ok(callBlock && callBlock.type === "toolCall");
  assert.equal(callBlock.id, "toolu_1");
  assert.equal(callBlock.name, "read");
  assert.deepEqual(callBlock.arguments, { path: "a.txt" });

  // Claude Code dispatches the call and waits for the host.
  const pending = fake.toolServer.dispatch("read", { path: "a.txt" }, "toolu_1");

  const history = [userText("read a.txt"), step, toolResult("toolu_1", "read", "file body")];
  const second = collect(call(deps, history, { tools }));
  const delivered = (await pending) as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(delivered.isError, false);
  assert.equal(delivered.content[0]?.text, "file body");

  query.emit(...textStep("the file says hello"));
  const done = final(await second);
  assert.equal(done.stopReason, "stop");
  assert.deepEqual(
    done.content.map((block) => (block.type === "text" ? block.text : block.type)),
    ["the file says hello"],
  );

  // One session: the tool round trip never restarted Claude Code and never
  // replayed the conversation.
  assert.equal(fake.queries.length, 1);
  assert.equal(query.users.length, 1);
});

test("answers parallel tool calls with their own results", async () => {
  const { fake, deps } = harness();
  const tools = [readTool()];

  const first = collect(call(deps, [userText("read both")], { tools }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...toolStep([
    { id: "toolu_a", name: "mcp__pi__read", input: { path: "a.txt" } },
    { id: "toolu_b", name: "mcp__pi__read", input: { path: "b.txt" } },
  ]));

  const step = final(await first);
  assert.equal(step.stopReason, "toolUse");
  const ids = step.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
  assert.deepEqual(ids, ["toolu_a", "toolu_b"]);

  const pendingA = fake.toolServer.dispatch("read", { path: "a.txt" }, "toolu_a");
  const pendingB = fake.toolServer.dispatch("read", { path: "b.txt" }, "toolu_b");

  const history = [
    userText("read both"),
    step,
    toolResult("toolu_a", "read", "contents of a"),
    toolResult("toolu_b", "read", "contents of b"),
  ];
  const second = collect(call(deps, history, { tools }));
  const [resultA, resultB] = (await Promise.all([pendingA, pendingB])) as Array<{
    content: Array<{ text: string }>;
  }>;
  assert.equal(resultA?.content[0]?.text, "contents of a");
  assert.equal(resultB?.content[0]?.text, "contents of b");

  query.emit(...textStep("both read"));
  assert.equal(final(await second).stopReason, "stop");
  assert.equal(fake.queries.length, 1);
});

test("rebuilds the session from Pi history when the history no longer matches", async () => {
  const { fake, deps } = harness();
  const first = collect(call(deps, [userText("hello")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("hi there"));
  const step = final(await first);
  assert.equal(step.stopReason, "stop");

  // Pi rewrote an earlier message: the live session holds the old text, so it
  // must not be reused even though the last message is still Pi's newest request.
  const second = collect(call(deps, [
    userText("hello (rewritten)", 1),
    step,
    userText("and now the real question", 4),
  ]));
  const rebuilt = await fake.nextQuery(2);
  await rebuilt.waitForUsers(1);
  rebuilt.emit(...textStep("answer for the edited request"));
  const done = final(await second);

  assert.equal(done.stopReason, "stop");
  assert.equal(fake.queries.length, 2);
  assert.equal(query.closed || query.interrupted, true);
  const prompt = rebuilt.users[0] ?? "";
  assert.match(prompt, /hello \(rewritten\)/);
  assert.match(prompt, /hi there/);
  assert.match(prompt, /and now the real question/);
});

test("a rebuilt session keeps completed tool results instead of re-running them", async () => {
  const { fake, deps } = harness();
  const history = [
    userText("read a.txt"),
    assistantWith({ id: "toolu_1", name: "read", arguments: { path: "a.txt" } }),
    toolResult("toolu_1", "read", "file body from disk"),
  ];
  const events = collect(call(deps, history, { tools: [readTool()] }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("the file holds: file body from disk"));

  const done = final(await events);
  assert.equal(done.stopReason, "stop");
  const prompt = query.users[0] ?? "";
  assert.match(prompt, /Tool read returned:/);
  assert.match(prompt, /file body from disk/);
  assert.match(prompt, /Continue the task/);
});

function abortedStep(): unknown {
  return { role: "assistant", content: [], stopReason: "aborted", timestamp: 5 };
}

test("a cancelled tool call is answered as not run, and the next message reuses the session", async () => {
  const { fake, deps } = harness();
  const tools = [readTool()];
  const controller = new AbortController();
  const events = collect(call(deps, [userText("read a.txt")], { tools, signal: controller.signal }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...toolStep([{ id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } }]));
  const step = final(await events);
  assert.equal(step.stopReason, "toolUse");

  // The user cancels while the tool runs: the handler must not hang and the
  // tool must not run.
  const pending = fake.toolServer.dispatch("read", { path: "a.txt" }, "toolu_1");
  controller.abort();
  const cancelledResult = { ...toolResult("toolu_1", "read", "Operation aborted"), isError: true };
  const history = [userText("read a.txt"), step, cancelledResult];
  const aborted = final(await collect(call(deps, history, { tools, signal: controller.signal })));
  assert.equal(aborted.stopReason, "aborted");
  const settled = (await pending) as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(settled.isError, true);
  assert.match(settled.content[0]?.text ?? "", /did not run/);

  // Re-caching the conversation costs more than the turn did: the next message
  // goes to the same Claude Code process.
  const next = collect(call(deps, [...history, abortedStep(), userText("read b.txt instead")], { tools }));
  await query.waitForUsers(2);
  query.emit(...textStep("reading b"));
  assert.equal(final(await next).stopReason, "stop");
  assert.equal(fake.queries.length, 1);
  assert.equal(query.users[1], "read b.txt instead");
});

test("a turn cancelled while the model writes keeps the session for the next message", async () => {
  const { fake, deps } = harness();
  const controller = new AbortController();
  const events = collect(call(deps, [userText("write an essay")], { signal: controller.signal }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  controller.abort();
  assert.equal(final(await events).stopReason, "aborted");
  assert.equal(query.interrupted, true);

  const next = collect(call(deps, [userText("write an essay"), abortedStep(), userText("just one line")]));
  await query.waitForUsers(2);
  query.emit(...textStep("one line"));
  assert.equal(final(await next).stopReason, "stop");
  assert.equal(fake.queries.length, 1);
  assert.equal(query.closed, false);
});

test("a message sent while a tool runs travels with the tool result, in the same session", async () => {
  const { fake, deps } = harness();
  const tools = [readTool()];
  const first = collect(call(deps, [userText("read a.txt")], { tools }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...toolStep([{ id: "toolu_1", name: "mcp__pi__read", input: { path: "a.txt" } }]));
  const step = final(await first);

  const pending = fake.toolServer.dispatch("read", { path: "a.txt" }, "toolu_1");
  const history = [userText("read a.txt"), step, toolResult("toolu_1", "read", "file body"), userText("also commit it", 4)];
  const second = collect(call(deps, history, { tools }));
  const delivered = (await pending) as { content: Array<{ text: string }> };
  const texts = delivered.content.map((block) => block.text);
  assert.equal(texts[0], "file body");
  assert.ok(texts.includes("also commit it"), `steering text missing from ${JSON.stringify(texts)}`);

  query.emit(...textStep("read and committed"));
  assert.equal(final(await second).stopReason, "stop");
  assert.equal(fake.queries.length, 1);
  assert.equal(query.users.length, 1);
});

test("a thinking-level change applies to the live session instead of rebuilding it", async () => {
  const { fake, deps } = harness();
  const first = collect(call(deps, [userText("hello")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("hi there"));
  const step = final(await first);

  const second = collect(call(deps, [userText("hello"), step, userText("think harder", 4)], { reasoning: "high" }));
  await query.waitForUsers(2);
  query.emit(...textStep("thought harder"));
  assert.equal(final(await second).stopReason, "stop");
  assert.equal(fake.queries.length, 1);
  assert.deepEqual(query.efforts, ["high"]);
});

test("a turn fails when Claude Code denies a tool Pi offered", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("read a.txt")], { tools: [readTool()] }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(
    {
      type: "system",
      subtype: "permission_denied",
      tool_name: "mcp__pi__read",
      reason: "not allowed",
      session_id: "sess_fake",
    } as never,
    ...textStep("I cannot read files"),
  );

  const message = failure(await events);
  assert.match(message.errorMessage ?? "", /denied the offered tool mcp__pi__read/);
});

test("a turn fails when the Pi tool server is not connected", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("read a.txt")], { tools: [readTool()] }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("answer without tools", { mcpStatus: "failed" }));

  const message = failure(await events);
  assert.match(message.errorMessage ?? "", /did not connect the Pi tool server/);
  assert.match(message.errorMessage ?? "", /failed/);
});

test("a tool Pi did not offer is never run, and Claude Code corrects itself", async () => {
  const log = tmpLog("unoffered");
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("list files")], { tools: [readTool()], env: { [LOG_ENV]: log } }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  // The model asks for a native tool Claude Code no longer has; Claude Code
  // answers that call itself and streams the corrected step.
  query.emit(...toolStep([{ id: "toolu_x", name: "Bash", input: { command: "ls" } }]));
  query.emit(...textStep("I will read the file instead."));

  const message = final(await events);
  assert.equal(message.stopReason, "stop");
  assert.equal(message.content.some((block) => block.type === "toolCall"), false);
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(line.kind, "unoffered_tool");
  assert.match(line.message, /did not offer: Bash/);
});

test("a turn fails when the model keeps asking for tools Pi does not offer", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("list files")], { tools: [readTool()] }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  const repeat = (n: number) =>
    Array.from({ length: n }, (_, index) => ({ id: `toolu_${index}`, name: "Bash", input: { command: "ls" } }));
  query.emit(...toolStep(repeat(4)));

  const message = failure(await events);
  assert.match(message.errorMessage ?? "", /did not offer 4 times/);
});

test("stops before an overage charge unless the user opted in", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("hello")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(overageFrame(), ...textStep("hi there"));

  const message = failure(await events);
  assert.match(message.errorMessage ?? "", /^Claude Code billing:/);
  assert.match(message.errorMessage ?? "", /usage credits/);
  // A charge is not a transient failure: Pi must not retry it.
  assert.equal(isRetryableAssistantError(message), false);
});

test("an overage charge continues when the user opted in", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("hello")], {
    env: { [ALLOW_USAGE_CREDITS_ENV]: "1" },
  }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(overageFrame(), ...textStep("hi there"));

  const done = final(await events);
  assert.equal(done.stopReason, "stop");
});

test("a reply that talks about billing is still a success", async () => {
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("explain the error")]));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(...textStep("That message means third-party apps draw from extra usage."));

  const done = final(await events);
  assert.equal(done.stopReason, "stop");
  assert.match(
    done.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    /third-party apps/,
  );
});

test("a silent Claude Code fails the turn instead of hanging Pi", async () => {
  const { deps } = harness();
  const events = await collect(call(deps, [userText("hello")], { timeoutMs: 60 }));
  const message = failure(events);
  assert.match(message.errorMessage ?? "", /no output from Claude Code within 60ms/);
});


test("the failure log is on by default, and one path selects it", () => {
  assert.match(logPath({}) ?? "", /claude-directsdk\.jsonl$/);
  assert.equal(logPath({ [LOG_ENV]: "" }), null);
  assert.equal(logPath({ [LOG_ENV]: "off" }), null);
  assert.equal(logPath({ [LOG_ENV]: "/tmp/elsewhere.jsonl" }), "/tmp/elsewhere.jsonl");
});

test("a failed turn lands in the log with its model and message", async () => {
  const log = tmpLog("failure");
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("hello")], { env: { [LOG_ENV]: log } }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(overageFrame(), ...textStep("hi there"));

  failure(await events);
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(line.kind, "billing");
  assert.equal(line.model, "claude-haiku-4-5-20251001");
  assert.match(line.message, /usage credits/);
  assert.equal(line.piSessionId, "conversation");
});

test("an API rejection carries the upstream request id in the error and the log", async () => {
  const log = tmpLog("request-id");
  const { fake, deps } = harness();
  const events = collect(call(deps, [userText("hello")], { env: { [LOG_ENV]: log } }));
  const query = await fake.nextQuery();
  await query.waitForUsers(1);
  query.emit(apiErrorFrame("API Error: 400 Third-party apps now draw from your extra usage."));

  const message = failure(await events);
  assert.match(message.errorMessage ?? "", /Third-party apps/);
  assert.match(message.errorMessage ?? "", /request id req_abc123/);
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.equal(line.requestId, "req_abc123");
});

test("the log rotates instead of growing without bound", () => {
  const log = tmpLog("rotate");
  writeFileSync(log, "x".repeat(1024 * 1024));
  const written = logTransportEvent({ kind: "probe", message: "after rotation" }, { [LOG_ENV]: log });
  assert.equal(written, log);
  assert.ok(existsSync(`${log}.1`), "the previous file is kept once");
  assert.ok(statSync(log).size < 4096, "the live file starts over");
  assert.match(readFileSync(log, "utf8"), /after rotation/);
});
