import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { NATIVE_TOOL_CHANGES_BETA } from "../src/transcript.ts";
import { PROVIDER_ID } from "../src/models.ts";
import { defaultDeps, streamClaudeDirectSdk, type CallDeps } from "../src/stream.ts";

const FAKE_CLAUDE = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import readline from "node:readline";

const settingsPath = process.argv[process.argv.indexOf("--settings") + 1];
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const extraBody = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY);
const usage = { input_tokens: 3, output_tokens: 1 };
const payload = {
  ...extraBody,
  messages: [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "one" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ],
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage }));
    continue;
  }
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": "existing-beta" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text);
    process.exit(1);
  }
  console.log(JSON.stringify({
    type: "assistant",
    message: { id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage },
  }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage, total_cost_usd: 0 }));
}
`;

const alpha: Tool = {
  name: "alpha",
  description: "alpha",
  parameters: { type: "object", properties: {} },
};
const beta: Tool = {
  name: "beta",
  description: "beta",
  parameters: { type: "object", properties: {} },
};

function model(): Model<Api> {
  return {
    id: "claude-opus-5",
    name: "Opus",
    api: "claude-directsdk" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-directsdk",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    // The catalog sets this from Anthropic's published model list.
    compat: { supportsMidConvoToolChanges: true },
  };
}

test("streams a removed tool without rewriting the initial request prefix", async (t) => {
  let seenBeta = "";
  let seenBody: Record<string, unknown> | undefined;
  const upstream = createServer((request, response) => {
    seenBeta = String(request.headers["anthropic-beta"] ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const events = [
        { type: "message_start", message: { id: "msg_test", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 1 } },
        { type: "message_stop" },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");

  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-directsdk-tools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);

  const deps: CallDeps = {
    ...defaultDeps,
    checkCli: () => true,
    makeRequestDir: () => mkdtempSync(join(root, "request-")),
    childCwd: () => root,
  };
  const context = {
    messages: [
      { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
      { role: "user", content: "first", timestamp: 1 },
      { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
      {
        role: "assistant",
        api: "claude-directsdk",
        provider: PROVIDER_ID,
        model: "claude-opus-5",
        content: [{ type: "text", text: "one" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 3,
      },
      { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
      { role: "user", content: "second", timestamp: 5 },
    ],
  } as unknown as TranscriptContext;

  const events: AssistantMessageEvent[] = [];
  const stream = streamClaudeDirectSdk(model(), context, {
    timeoutMs: 5_000,
    env: {
      PI_DIRECTSDK_TEST_UPSTREAM: "1",
      CLAUDE_DIRECTSDK_COMMAND: executable,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      DISABLE_PROMPT_CACHING: "0",
      DISABLE_PROMPT_CACHING_OPUS: "0",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    },
  }, deps);
  for await (const event of stream) events.push(event);

  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.match(seenBeta, new RegExp(NATIVE_TOOL_CHANGES_BETA));
  assert.match(seenBeta, /existing-beta/);
  assert.ok(seenBody);

  const tools = seenBody["tools"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    tools.map((tool) => [tool["name"], tool["defer_loading"] ?? false]),
    [
      ["mcp__pi__alpha", false],
      ["__pi_deferred_placeholder__", true],
      ["mcp__pi__beta", true],
    ],
  );
  // Claude Code adds its own breakpoints; with the replay anchor, a tool
  // breakpoint would exceed Anthropic's limit of four.
  assert.equal(tools.some((tool) => "cache_control" in tool), false);

  const messages = seenBody["messages"] as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages.map((message) => message.role), [
    "user",
    "system",
    "assistant",
    "user",
    "system",
  ]);
  assert.deepEqual(messages[1]?.content, [
    { type: "text", text: "beta is available" },
    { type: "tool_addition", tool: { type: "tool_reference", name: "mcp__pi__beta" } },
  ]);
  assert.deepEqual(messages[4]?.content, [
    { type: "text", text: "alpha is gone" },
    { type: "tool_removal", tool: { type: "tool_reference", name: "mcp__pi__alpha" } },
  ]);
});
