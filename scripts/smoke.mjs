#!/usr/bin/env node
/**
 * Real round trip through the transport, against the installed Claude Code.
 *
 * Two Pi model calls on one conversation: the first must come back as a tool
 * call, the second must be answered from the tool result Pi supplies. This
 * spends two small model calls on the user's own Claude Code login.
 *
 * Run: npm run smoke [-- <model>]
 */

import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../src/models.ts";
import { closeAllSessions, streamClaudeDirectSdk } from "../src/sdk/stream.ts";

const MODEL_ID = process.argv[2] ?? "claude-haiku-4-5-20251001";

const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: "claude-directsdk",
  provider: PROVIDER_ID,
  baseUrl: "process://claude-directsdk",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const tools = [
  {
    name: "echo",
    description: "Return the text it was given, unchanged.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Text to return" } },
      required: ["text"],
    },
  },
];

const conversation = [{ role: "user", content: "Call the echo tool once with the text \"pi-directsdk-ok\", then answer with only the text it returned.", timestamp: 1 }];

function contextOf(messages) {
  return normalizeContext({ systemPrompt: "You are a transport smoke test.", tools, messages });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function final(events) {
  const last = events.at(-1);
  assert.ok(last, "no events");
  if (last.type === "done") return last.message;
  if (last.type === "error") return last.error;
  assert.fail(`stream ended with ${last.type}`);
}

const started = Date.now();
const first = final(await collect(streamClaudeDirectSdk(model, contextOf(conversation), { sessionId: "smoke", timeoutMs: 120_000 })));
if (first.stopReason !== "toolUse") {
  console.error(JSON.stringify({ stage: "step1", stopReason: first.stopReason, errorMessage: first.errorMessage, content: first.content }, null, 2));
  process.exit(1);
}
const call = first.content.find((block) => block.type === "toolCall");
assert.ok(call, "no tool call");
const answer = String(call.arguments?.text ?? "");

const history = [
  ...conversation,
  first,
  {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: answer }],
    isError: false,
    timestamp: 2,
  },
];
const second = final(await collect(streamClaudeDirectSdk(model, contextOf(history), { sessionId: "smoke", timeoutMs: 120_000 })));
const text = second.content.map((block) => (block.type === "text" ? block.text : "")).join("");

const summary = {
  model: MODEL_ID,
  tool: { id: call.id, name: call.name, arguments: call.arguments },
  firstStop: first.stopReason,
  secondStop: second.stopReason,
  answer: text.slice(0, 200),
  usage: { input: second.usage.input, output: second.usage.output, cacheRead: second.usage.cacheRead },
  elapsedMs: Date.now() - started,
};
console.log(JSON.stringify(summary, null, 2));

// The transport keeps one Claude Code process per conversation; the script owns it.
closeAllSessions();

assert.equal(second.stopReason, "stop", `second stop: ${second.errorMessage ?? ""}`);
assert.match(text, /pi-directsdk-ok/, "the answer must repeat the tool result");
console.log("SMOKE PASS");
