/** Server-Sent Events builders for admission tests. */

export function sseFrame(data: unknown, event?: string): string {
  let out = "";
  if (event) {
    out += `event: ${event}\n`;
  }
  for (const line of JSON.stringify(data).split("\n")) {
    out += `data: ${line}\n`;
  }
  return `${out}\n`;
}

/** A complete upstream message exchange: text plus one tool call. */
export function scriptedExchange(opts: {
  id?: string;
  model?: string;
  text?: string;
  toolName?: string;
  stop?: string;
}): string {
  const id = opts.id ?? "msg_up";
  const model = opts.model ?? "claude-opus-4-6";
  const text = opts.text ?? "Hello from upstream";
  const toolName = opts.toolName ?? "mcp__pi__read";
  const stop = opts.stop ?? "tool_use";
  const frames = [
    sseFrame({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    sseFrame({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sseFrame({ type: "content_block_stop", index: 0 }),
    sseFrame({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: toolName },
    }),
    sseFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }),
    sseFrame({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' },
    }),
    sseFrame({ type: "content_block_stop", index: 1 }),
    sseFrame({
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    }),
    sseFrame({ type: "message_stop" }),
  ];
  return frames.join("");
}
