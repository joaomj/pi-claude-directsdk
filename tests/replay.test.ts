import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCarrier,
  messageProjection,
  prepareHistory,
} from "../src/replay.js";
import {
  assistantMessage,
  contextWith,
  systemMessage,
  userMessage,
} from "./helpers/pi-fixtures.js";

describe("replay", () => {
  it("replays a simple turn", () => {
    const context = contextWith(
      systemMessage("Be brief"),
      userMessage("Hello"),
    );
    const { frames } = prepareHistory(
      context.messages.filter((m) => m.role !== "system"),
      new Set(),
    );
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.type, "user");
  });

  it("round-trips a tool call and result with prefixed names", () => {
    const assistant = assistantMessage("Working");
    assistant.content.push({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: { path: "/tmp/x" },
    });
    const context = contextWith(
      systemMessage("s"),
      userMessage("read it"),
      assistant,
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: Date.now(),
      },
    );
    const { frames } = prepareHistory(
      context.messages.filter((m) => m.role !== "system"),
      new Set(["read"]),
    );
    assert.equal(frames.length, 3);
    assert.equal(frames[0]?.type, "user");
    assert.equal(frames[1]?.type, "assistant");
    assert.equal(frames[2]?.type, "user");
    const toolUse = (
      frames[1] as { message: { content: Array<{ name?: string }> } }
    ).message.content.find((b) => b.name !== undefined);
    assert.equal(toolUse?.name, "mcp__pi__read");
  });

  it("rejects cross-turn tool results without a live call", () => {
    const context = contextWith(
      systemMessage("s"),
      userMessage("a"),
      assistantMessage("done"),
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "read",
        content: [{ type: "text", text: "x" }],
        isError: false,
        timestamp: Date.now(),
      },
    );
    assert.throws(
      () =>
        prepareHistory(
          context.messages.filter((m) => m.role !== "system"),
          new Set(["read"]),
        ),
      /without a matching tool call/,
    );
  });

  it("strips tool blocks when tools are unavailable", () => {
    const assistant = assistantMessage("Working");
    assistant.content.push({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: {},
    });
    const { frames } = prepareHistory(
      [userMessage("hi"), assistant],
      new Set(),
    );
    const replayed = frames[1] as { message: { content: unknown[] } };
    assert.equal(replayed.message.content.length, 1);
  });

  it("rejects message edits", () => {
    const first = assistantMessage("one");
    const second = assistantMessage("two");
    second.content.push({
      type: "toolCall",
      id: "call_9",
      name: "read",
      arguments: {},
    });
    assert.throws(
      () =>
        prepareHistory(
          [userMessage("a"), first, userMessage("b"), second],
          new Set(["read"]),
        ),
      /edits are unsupported/,
    );
  });

  it("restores the carrier only while the projection matches", () => {
    const message = assistantMessage("Hello");
    const projection = messageProjection(message);
    const carrier = encodeCarrier(
      [{ role: "assistant", content: [{ type: "text", text: "native" }] }],
      projection,
    );
    const withCarrier = { ...message, diagnostics: [carrier] };
    const { frames } = prepareHistory([userMessage("hi"), withCarrier], new Set());
    const restored = frames[1] as { message: { content: Array<{ text?: string }> } };
    assert.equal(restored.message.content[0]?.text, "native");

    const edited = { ...assistantMessage("Hello edited"), diagnostics: [carrier] };
    const dropped = prepareHistory([userMessage("hi"), edited], new Set());
    const plain = dropped.frames[1] as { message: { content: Array<{ text?: string }> } };
    assert.equal(plain.message.content[0]?.text, "Hello edited");
    assert.equal(plain.message.content.length, 1);
  });
});
