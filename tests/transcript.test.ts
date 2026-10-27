import assert from "node:assert/strict";
import test from "node:test";
import { getDeclaredTools } from "@earendil-works/pi-ai/compat";
import type { Message, Tool, Usage } from "@earendil-works/pi-ai/compat";
import { supportsNativeToolChanges } from "../src/model-compat.ts";
import { prepareHistory } from "../src/replay.ts";
import { prepareNativeTranscript } from "../src/transcript.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function conversation(): Message[] {
  return [
    { role: "system", content: "base", toolsAdded: [alpha], timestamp: 0 },
    { role: "user", content: "first", timestamp: 1 },
    { role: "system", content: "beta is available", toolsAdded: [beta], timestamp: 2 },
    {
      role: "assistant",
      api: "claude-directsdk",
      provider: "claude-directsdk",
      model: "claude-opus-5",
      content: [{ type: "text", text: "one" }],
      usage,
      stopReason: "stop",
      timestamp: 3,
    },
    { role: "system", content: "alpha is gone", toolsRemoved: [{ name: "alpha" }], timestamp: 4 },
    { role: "user", content: "second", timestamp: 5 },
  ];
}

test("gates the native tool-change plan on model metadata and tool redefinitions", () => {
  assert.equal(supportsNativeToolChanges({ supportsMidConvoToolChanges: true }), true);
  assert.equal(supportsNativeToolChanges({ supportsMidConvoToolChanges: false }), false);
  assert.equal(supportsNativeToolChanges(undefined), false);
  assert.equal(prepareNativeTranscript(conversation(), false), undefined);
  assert.equal(
    prepareNativeTranscript(
      [
        { role: "system", content: "base", timestamp: 0 },
        { role: "system", content: "late", toolsAdded: [alpha], timestamp: 1 },
        { role: "user", content: "go", timestamp: 2 },
      ],
      true,
    ),
    undefined,
  );
  assert.equal(
    prepareNativeTranscript(
      [
        ...conversation(),
        {
          role: "system",
          content: "",
          toolsAdded: [{ ...alpha, description: "changed" }],
          timestamp: 6,
        },
      ],
      true,
    ),
    undefined,
  );
});

test("accepts historical calls to tools declared earlier in the transcript", () => {
  const history: Message[] = [
    { role: "user", content: "use alpha", timestamp: 0 },
    {
      role: "assistant",
      api: "claude-directsdk",
      provider: "claude-directsdk",
      model: "claude-opus-5",
      content: [{ type: "toolCall", id: "t1", name: "alpha", arguments: {} }],
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "alpha",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 2,
    },
    { role: "user", content: "continue", timestamp: 3 },
  ];
  assert.throws(
    () => prepareHistory(history, new Set(["beta"])),
    /Tool call outside the current inventory/,
  );
  const declared = new Set(getDeclaredTools(conversation()).map((tool) => tool.name));
  assert.deepEqual([...declared], ["alpha", "beta"]);
  assert.doesNotThrow(() => prepareHistory(history, declared));
});
