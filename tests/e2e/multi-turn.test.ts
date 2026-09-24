/**
 * E2E-05: multi-turn script-writing session through the gateway (paid opt-in).
 *
 * History holds a completed turn where the model wrote a bash time script
 * through the save_script tool. The live follow-up asks for a Python script
 * that prints random numbers between 1 and 1000 with the best randomization
 * available, saved through the tool and shown back.
 *
 * Asserts the replayed history is accepted, the live turn ends `done` /
 * `toolUse`, and the new tool call carries a `.py` name plus content that
 * uses the `secrets` module over the 1-1000 range.
 *
 * Justification: the only coverage of multi-turn replay with tool
 * round-trips and large generated payloads. This shape already caught the
 * missing `shouldQuery: false` bug that single-turn tests cannot see.
 * Runs only with PI_DIRECTSDK_GATEWAY=1 (paid). Never runs in CI.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Tool, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { streamClaudeDirectSdk } from "../../src/stream.js";
import { collectTerminal } from "./helpers.js";
import {
  GATEWAY_SKIP_REASON,
  catalogModel,
  gatewayEnv,
  gatewayPayload,
  requireGateway,
} from "./gateway-helpers.js";

const GATEWAY = process.env["PI_DIRECTSDK_GATEWAY"] === "1";
if (GATEWAY) {
  requireGateway();
}

const tools = [
  {
    name: "save_script",
    description: "Save a script file and report its path and size.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
      },
      required: ["name", "content"],
    },
  },
] as unknown as Tool[];

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function context(): TranscriptContext {
  const t = Date.now();
  return normalizeContext({
    systemPrompt:
      "You are a test assistant. Write every requested script with the " +
      "save_script tool, then show the script content back briefly.",
    messages: [
      {
        role: "user",
        content: "Write a bash script that shows the current system time.",
        timestamp: t,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll save that script." },
          {
            type: "toolCall",
            id: "call_hist_bash",
            name: "save_script",
            arguments: {
              name: "show-time.sh",
              content: "#!/bin/bash\n# Show the current system time.\ndate\n",
            },
          },
        ],
        api: "claude-directsdk",
        provider: "claude-directsdk",
        model: "opus",
        usage: { ...usage },
        stopReason: "toolUse",
        timestamp: t + 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_hist_bash",
        toolName: "save_script",
        content: [{ type: "text", text: "saved to show-time.sh (52 bytes)" }],
        isError: false,
        timestamp: t + 2,
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Saved `show-time.sh`:\n```bash\n#!/bin/bash\ndate\n```",
          },
        ],
        api: "claude-directsdk",
        provider: "claude-directsdk",
        model: "opus",
        usage: { ...usage },
        stopReason: "stop",
        timestamp: t + 3,
      },
      {
        role: "user",
        content:
          "Now write a python script that prints 5 random numbers between " +
          "1 and 1000 using the best randomization process available. " +
          "Save it with the tool and show it to me.",
        timestamp: t + 4,
      },
    ],
    tools,
  });
}

test(
  "e2e-05: multi-turn replay ends in a python script tool call",
  { timeout: 240_000, skip: GATEWAY ? false : GATEWAY_SKIP_REASON },
  async () => {
    const stream = streamClaudeDirectSdk(catalogModel("opus"), context(), {
      env: gatewayEnv(),
      onPayload: gatewayPayload,
    });
    const { events, terminal } = await collectTerminal(stream, 210_000);
    assert.equal(terminal.type, "done", JSON.stringify(terminal).slice(0, 500));
    assert.equal(terminal.reason, "toolUse");
    const starts = events.filter((event) => event.type === "toolcall_start");
    assert.equal(starts.length, 1, `expected 1 tool call, saw ${starts.length}`);
    const calls = terminal.message.content.filter(
      (block) => block.type === "toolCall",
    );
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call && call.type === "toolCall");
    assert.match(call.name, /save_script/);
    const args = call.arguments as Record<string, unknown>;
    assert.match(String(args["name"] ?? ""), /\.py$/);
    const content = String(args["content"] ?? "");
    assert.match(content, /secrets/);
    assert.match(content, /1000/);
  },
);
