/** Native protocol line builders for Gate 1 tests. */

import type {
  NativeAssistantMessage,
  NativeUsage,
} from "../../src/types.js";

export function usage(patch: Partial<NativeUsage> = {}): NativeUsage {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
    ...patch,
  };
}

export function assistantLine(message: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message });
}

export function textAssistant(
  text: string,
  opts: { id?: string; model?: string; stop?: string; usage?: NativeUsage } = {},
): string {
  const message: Record<string, unknown> = {
    type: "message",
    role: "assistant",
    id: opts.id ?? "msg_test",
    model: opts.model ?? "claude-opus-4-6",
    content: [{ type: "text", text }],
    stop_reason: opts.stop ?? "end_turn",
    usage: opts.usage ?? usage(),
  };
  return assistantLine(message);
}

export function toolAssistant(
  calls: Array<{ id: string; name: string; input: unknown }>,
  opts: { stop?: string; usage?: NativeUsage; leadingText?: string } = {},
): string {
  const content: unknown[] = [];
  if (opts.leadingText) {
    content.push({ type: "text", text: opts.leadingText });
  }
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  return assistantLine({
    type: "message",
    role: "assistant",
    id: "msg_tool",
    model: "claude-opus-4-6",
    content,
    stop_reason: opts.stop ?? "tool_use",
    usage: opts.usage ?? usage(),
  });
}

export function resultLine(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 100,
    num_turns: 1,
    result: "",
    session_id: "sess_test",
    usage: usage(),
    total_cost_usd: 0.01,
    ...patch,
  });
}

export function ackLine(): string {
  return resultLine({
    subtype: "success",
    is_error: false,
    num_turns: 0,
    result: "",
  });
}

export function streamEvent(event: Record<string, unknown>): string {
  return JSON.stringify({ type: "stream_event", event });
}

/** Progressive events for one text block, index 0. */
export function textStreamEvents(
  text: string,
  opts: { usage?: NativeUsage; stop?: string; model?: string } = {},
): string[] {
  const mid = Math.max(1, Math.floor(text.length / 2));
  return [
    streamEvent({
      type: "message_start",
      message: {
        id: "msg_stream",
        model: opts.model ?? "claude-opus-4-6",
        usage: { input_tokens: 10 },
      },
    }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, mid) },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(mid) },
    }),
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({
      type: "message_delta",
      delta: { stop_reason: opts.stop ?? "end_turn" },
      usage: opts.usage ?? usage(),
    }),
    streamEvent({ type: "message_stop" }),
  ];
}

/** Progressive events for one tool_use block, native index 1. */
export function toolStreamEvents(
  call: { id: string; name: string; input: unknown },
  textPrefix = "",
): string[] {
  const events: string[] = [
    streamEvent({
      type: "message_start",
      message: { id: "msg_stream", model: "claude-opus-4-6", usage: { input_tokens: 10 } },
    }),
  ];
  if (textPrefix) {
    events.push(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: textPrefix },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    );
  }
  const raw = JSON.stringify(call.input);
  events.push(
    streamEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: call.id, name: call.name },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: raw.slice(0, 5) },
    }),
    streamEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: raw.slice(5) },
    }),
    streamEvent({ type: "content_block_stop", index: 1 }),
    streamEvent({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: usage(),
    }),
    streamEvent({ type: "message_stop" }),
  );
  return events;
}

export function asMessage(line: string): NativeAssistantMessage {
  return (JSON.parse(line) as { message: NativeAssistantMessage }).message;
}
