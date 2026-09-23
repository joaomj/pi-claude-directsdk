import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai/compat";
import { AdmissionRelay, SseCapture } from "../src/admission.js";
import {
  type CallDeps,
  streamClaudeDirectSdk,
} from "../src/stream.js";
import { FakeChild } from "./helpers/fake-child.js";
import {
  ackLine,
  resultLine,
  streamEvent,
  textAssistant,
  textStreamEvents,
  toolAssistant,
  toolStreamEvents,
} from "./helpers/native-lines.js";
import {
  assistantMessage,
  collectEvents,
  contextWith,
  eventTypes,
  readTool,
  systemMessage,
  testModel,
  userMessage,
} from "./helpers/pi-fixtures.js";
import { scriptedExchange } from "./helpers/sse.js";

class FakeRelay {
  url = "http://127.0.0.1:1/";
  used = false;
  denied = 0;
  status: number | null = null;
  requestId: string | null = "req_test";
  capture = new SseCapture();
  failure: string | null = null;
  closed = false;
  aborted = false;
  responseCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  private handler:
    | ((status: number, headers: Record<string, string>) => void)
    | null = null;

  set onUpstreamResponse(
    fn: ((status: number, headers: Record<string, string>) => void) | null,
  ) {
    this.handler = fn;
    for (const call of this.responseCalls.splice(0)) {
      fn?.(call.status, call.headers);
    }
  }

  get onUpstreamResponse() {
    return this.handler;
  }

  fire(status: number, headers: Record<string, string>): void {
    if (this.handler) {
      this.handler(status, headers);
    } else {
      this.responseCalls.push({ status, headers });
    }
  }

  errorText(): string {
    return "";
  }

  abort(): void {
    this.aborted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeDeps(child: FakeChild, relay: FakeRelay): CallDeps {
  let spawns = 0;
  return {
    spawn: () => {
      spawns += 1;
      return child;
    },
    createRelay: async () => relay as unknown as AdmissionRelay,
    checkCli: () => true,
    makeRequestDir: () => mkdtempSync(join(tmpdir(), "pi-directsdk-test-")),
    childCwd: () => tmpdir(),
  };
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done", "expected a done event");
  return done.message;
}

function errorMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const error = events.find((e) => e.type === "error");
  assert.ok(error && error.type === "error", "expected an error event");
  return error.error;
}

describe("stream", () => {
  it("streams a text turn and maps usage and cost", async () => {
    const text = "Hello world";
    const child = new FakeChild([
      textAssistant(text),
      ...textStreamEvents(text),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    const stream = streamClaudeDirectSdk(
      testModel(),
      contextWith(systemMessage("Be brief"), userMessage("Hi")),
      {},
      makeDeps(child, relay),
    );
    const events = await collectEvents(stream);
    const types = eventTypes(events);
    assert.equal(types[0], "start");
    assert.equal(types[types.length - 1], "done");
    assert.ok(types.includes("text_start"));
    assert.ok(types.includes("text_delta"));
    assert.ok(types.includes("text_end"));

    const message = doneMessage(events);
    assert.equal(message.stopReason, "stop");
    assert.equal(message.endTurn, true);
    assert.equal(message.rawStopReason, "end_turn");
    assert.deepEqual(message.content, [{ type: "text", text }]);
    assert.equal(message.usage.input, 10);
    assert.equal(message.usage.output, 5);
    assert.equal(message.usage.cacheRead, 2);
    assert.equal(message.usage.cacheWrite, 1);
    assert.equal(message.usage.totalTokens, 18);
    assert.ok(message.usage.cost.total > 0);
    assert.equal(message.responseId, "msg_test");
    assert.equal(child.stdinClosed, true);
    assert.equal(relay.closed, true);

    const carrier = message.diagnostics?.find(
      (d) => d.type === "pi-claude-directsdk/native",
    );
    assert.ok(carrier, "expected a durable native carrier");
    const meta = message.diagnostics?.find(
      (d) => d.type === "pi-claude-directsdk/meta",
    );
    assert.ok(meta);
  });

  it("appends the authoritative tail when the stream ends early", async () => {
    const child = new FakeChild([
      textAssistant("Hello world"),
      ...textStreamEvents("Hello"),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    const stream = streamClaudeDirectSdk(
      testModel(),
      contextWith(systemMessage("s"), userMessage("Hi")),
      {},
      makeDeps(child, relay),
    );
    const events = await collectEvents(stream);
    const message = doneMessage(events);
    assert.deepEqual(message.content, [{ type: "text", text: "Hello world" }]);
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""));
    assert.equal(deltas.join(""), "Hello world");
  });

  it("publishes tool calls only after the completion gate", async () => {
    const call = { id: "call_1", name: "mcp__pi__read", input: { path: "/tmp/x" } };
    const child = new FakeChild([
      toolAssistant([call], { leadingText: "Reading" }),
      ...toolStreamEvents(call, "Reading"),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    const stream = streamClaudeDirectSdk(
      testModel(),
      contextWith(systemMessage("s", [readTool()]), userMessage("read it")),
      {},
      makeDeps(child, relay),
    );
    const events = await collectEvents(stream);
    const types = eventTypes(events);
    const toolStart = types.indexOf("toolcall_start");
    assert.ok(toolStart > 0, "expected toolcall events");
    const message = doneMessage(events);
    assert.equal(message.stopReason, "toolUse");
    const toolCall = message.content.find((b) => b.type === "toolCall");
    assert.ok(toolCall && toolCall.type === "toolCall");
    assert.equal(toolCall.name, "read");
    assert.deepEqual(toolCall.arguments, { path: "/tmp/x" });
    // One request-scoped frame per Pi call history entry.
    const written = child.written.map((line) => JSON.parse(line) as { type: string });
    assert.equal(written.length, 1);
  });

  it("withholds tool calls when the native result fails", async () => {
    const call = { id: "call_1", name: "mcp__pi__read", input: {} };
    const child = new FakeChild([
      toolAssistant([call]),
      ...toolStreamEvents(call),
      resultLine({ subtype: "error_during_execution", is_error: true }),
    ]);
    const relay = new FakeRelay();
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s", [readTool()]), userMessage("x")),
        {},
        makeDeps(child, relay),
      ),
    );
    const message = errorMessage(events);
    assert.equal(message.stopReason, "error");
    assert.ok(!eventTypes(events).some((t) => t.startsWith("toolcall")));
  });

  it("rejects tools outside the host inventory", async () => {
    const call = { id: "call_1", name: "mcp__other__evil", input: {} };
    const child = new FakeChild([
      toolAssistant([call]),
      ...toolStreamEvents(call),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s", [readTool()]), userMessage("x")),
        {},
        makeDeps(child, relay),
      ),
    );
    const message = errorMessage(events);
    assert.match(message.errorMessage ?? "", /outside the current host inventory/);
  });

  it("maps max_tokens and refusal stop reasons", async () => {
    const child = new FakeChild([
      textAssistant("partial", { stop: "max_tokens" }),
      ...textStreamEvents("partial", { stop: "max_tokens" }),
      resultLine(),
    ]);
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {},
        makeDeps(child, new FakeRelay()),
      ),
    );
    assert.equal(doneMessage(events).stopReason, "length");

    const refused = new FakeChild([
      textAssistant("I cannot do that", { stop: "refusal" }),
      ...textStreamEvents("I cannot do that", { stop: "refusal" }),
      resultLine(),
    ]);
    const refusedEvents = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {},
        makeDeps(refused, new FakeRelay()),
      ),
    );
    const error = errorMessage(refusedEvents);
    assert.equal(error.stopReason, "error");
    assert.match(error.errorMessage ?? "", /I cannot do that/);
  });

  it("accepts the max-turns tool boundary", async () => {
    const call = { id: "call_1", name: "mcp__pi__read", input: {} };
    const child = new FakeChild(
      [
        toolAssistant([call]),
        ...toolStreamEvents(call),
        resultLine({ subtype: "error_max_turns", is_error: true }),
      ],
      { code: 1, signal: null },
    );
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s", [readTool()]), userMessage("x")),
        {},
        makeDeps(child, new FakeRelay()),
      ),
    );
    assert.equal(doneMessage(events).stopReason, "toolUse");
  });

  it("replays multi-turn history with acknowledgments", async () => {
    const child = new FakeChild([
      ackLine(),
      textAssistant("Second"),
      ...textStreamEvents("Second"),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(
          systemMessage("s"),
          userMessage("first"),
          assistantMessage("First"),
          userMessage("second"),
        ),
        {},
        makeDeps(child, relay),
      ),
    );
    assert.equal(doneMessage(events).stopReason, "stop");
    assert.equal(child.written.length, 3);
    const first = JSON.parse(child.written[0] ?? "{}") as { type: string };
    const second = JSON.parse(child.written[1] ?? "{}") as { type: string };
    assert.equal(first.type, "user");
    assert.equal(second.type, "assistant");
  });

  it("fails when replay is not acknowledged", async () => {
    const child = new FakeChild([
      resultLine({ num_turns: 2 }),
      textAssistant("x"),
      ...textStreamEvents("x"),
      resultLine(),
    ]);
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(
          systemMessage("s"),
          userMessage("first"),
          assistantMessage("First"),
          userMessage("second"),
        ),
        {},
        makeDeps(child, new FakeRelay()),
      ),
    );
    const error = errorMessage(events);
    assert.match(error.errorMessage ?? "", /replay not supported/);
  });

  it("fails before spawn without tool results or on env conflicts", async () => {
    let spawns = 0;
    const deps: CallDeps = {
      ...makeDeps(new FakeChild(), new FakeRelay()),
      spawn: () => {
        spawns += 1;
        return new FakeChild();
      },
    };
    const orphan = assistantMessage("Working");
    orphan.content.push({
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: {},
    });
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(
          systemMessage("s", [readTool()]),
          userMessage("x"),
          orphan,
          userMessage("y"),
        ),
        {},
        deps,
      ),
    );
    assert.match(errorMessage(events).errorMessage ?? "", /without a matching tool call/);
    assert.equal(spawns, 0);

    const conflicted = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        { env: { ANTHROPIC_API_KEY: "leaked" } },
        deps,
      ),
    );
    assert.match(
      errorMessage(conflicted).errorMessage ?? "",
      /Conflicting environment/,
    );
    assert.equal(spawns, 0);
  });

  it("refuses unqualified CLIs", async () => {
    const deps: CallDeps = {
      ...makeDeps(new FakeChild(), new FakeRelay()),
      checkCli: () => false,
    };
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {},
        deps,
      ),
    );
    assert.match(errorMessage(events).errorMessage ?? "", /Unsupported claude version/);
  });

  it("reports cancellation as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        { signal: controller.signal },
        makeDeps(new FakeChild(), new FakeRelay()),
      ),
    );
    const error = errorMessage(events);
    assert.equal(error.stopReason, "aborted");
  });

  it("rejects invalid onPayload replacements", async () => {
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        { onPayload: async () => 42 },
        makeDeps(new FakeChild(), new FakeRelay()),
      ),
    );
    assert.match(
      errorMessage(events).errorMessage ?? "",
      /onPayload replacement must be an object/,
    );
  });

  it("invokes onResponse after the upstream response completes", async () => {
    const seen: Array<{ status: number; headers: Record<string, string> }> = [];
    const text = "Relayed";
    const child = new FakeChild([
      textAssistant(text),
      ...textStreamEvents(text),
      resultLine(),
    ]);
    const relay = new FakeRelay();
    relay.fire(200, { "content-type": "text/event-stream" });
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {
          onResponse: async (response) => {
            seen.push({ status: response.status, headers: response.headers });
          },
        },
        makeDeps(child, relay),
      ),
    );
    assert.equal(doneMessage(events).stopReason, "stop");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.status, 200);
  });

  it("authorizes from the admitted upstream capture", async () => {
    const relay = new FakeRelay();
    for (const line of scriptedExchange({}).split("\n")) {
      relay.capture.feedLine(line);
    }
    relay.used = true;
    relay.status = 200;
    const child = new FakeChild([resultLine()]);
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel("claude-sonnet-4-6"),
        contextWith(systemMessage("s", [readTool()]), userMessage("x")),
        {},
        makeDeps(child, relay),
      ),
    );
    const message = doneMessage(events);
    assert.equal(message.stopReason, "toolUse");
    const text = message.content.find((b) => b.type === "text");
    assert.deepEqual(text, { type: "text", text: "Hello from upstream" });
    const toolCall = message.content.find((b) => b.type === "toolCall");
    assert.ok(toolCall && toolCall.type === "toolCall");
    assert.equal(toolCall.name, "read");
    assert.equal(message.usage.input, 12);
    assert.equal(message.usage.output, 20);
    const meta = message.diagnostics?.find(
      (d) => d.type === "pi-claude-directsdk/meta",
    );
    assert.ok(meta);
  });

  it("surfaces native login failures with the login hint", async () => {
    const child = new FakeChild([
      JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: null,
          error: {
            code: "authentication_failed",
            message: "OAuth token expired",
          },
        },
      }),
      resultLine({ subtype: "error", is_error: true }),
    ]);
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {},
        makeDeps(child, new FakeRelay()),
      ),
    );
    const error = errorMessage(events);
    assert.match(error.errorMessage ?? "", /login/i);
  });

  it("keeps unknown stream_event traffic from breaking the call", async () => {
    const text = "Steady";
    const child = new FakeChild([
      textAssistant(text),
      streamEvent({ type: "ping" }),
      ...textStreamEvents(text),
      JSON.stringify({ type: "control_response", response: {} }),
      resultLine(),
    ]);
    const events = await collectEvents(
      streamClaudeDirectSdk(
        testModel(),
        contextWith(systemMessage("s"), userMessage("x")),
        {},
        makeDeps(child, new FakeRelay()),
      ),
    );
    assert.equal(doneMessage(events).stopReason, "stop");
  });
});
