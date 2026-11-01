/**
 * A scripted Claude Agent SDK runtime.
 *
 * It implements the same surface the transport consumes — `query()`, the MCP
 * server factory, and the tool-server wrapper — and emits the frames the real
 * SDK emits, in the order the real SDK emits them. The tests drive turns
 * explicitly, so a stall is a test bug rather than a race.
 */

import type {
  McpServerConfig,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { PROVIDER_ID } from "../src/models.js";
import type { SdkRuntime } from "../src/sdk/adapter.js";
import type { McpServerFactory, McpServerLike } from "../src/sdk/tools.js";

export const LIST_TOOLS = Symbol("pi.listTools");
export const CALL_TOOL = Symbol("pi.callTool");

export const USAGE = {
  input_tokens: 10,
  output_tokens: 7,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 2,
};

export function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-haiku-4-5-20251001",
    name: "Haiku",
    api: "claude-directsdk" as Api,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-directsdk",
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

export interface InitOptions {
  mcpStatus?: string;
  mcpServers?: Array<{ name: string; status: string }> | undefined;
}

export function initFrame(options: InitOptions = {}): SDKMessage {
  const servers =
    options.mcpServers ??
    [{ name: "pi", status: options.mcpStatus ?? "connected" }];
  return {
    type: "system",
    subtype: "init",
    session_id: "sess_fake",
    claude_code_version: "9.9.9",
    tools: [],
    mcp_servers: servers,
    model: "claude-haiku-4-5-20251001",
  } as unknown as SDKMessage;
}

/** One complete answer step, as the SDK reports it. */
export function textStep(text: string, options: InitOptions = {}): SDKMessage[] {
  return [
    initFrame(options),
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg_fake",
          model: "claude-haiku-4-5-20251001",
          role: "assistant",
          content: [],
          usage: { ...USAGE, output_tokens: 0 },
        },
      },
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "assistant",
      message: {
        id: "msg_fake",
        model: "claude-haiku-4-5-20251001",
        role: "assistant",
        content: [{ type: "text", text }],
        stop_reason: null,
        usage: USAGE,
      },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: USAGE.output_tokens },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      usage: USAGE,
      total_cost_usd: 0.01,
      session_id: "sess_fake",
    },
  ] as unknown as SDKMessage[];
}

/** A step that stops for tool use. There is no `result` frame until Pi answers. */
export function toolStep(
  calls: Array<{ id: string; name: string; input: unknown }>,
  text = "",
): SDKMessage[] {
  const frames: unknown[] = [
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg_fake",
          model: "claude-haiku-4-5-20251001",
          role: "assistant",
          content: [],
          usage: { ...USAGE, output_tokens: 0 },
        },
      },
    },
  ];
  if (text) {
    frames.push(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    );
  }
  for (const [offset, call] of calls.entries()) {
    const index = text ? offset + 1 : offset;
    frames.push(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index } },
    );
  }
  frames.push(
    {
      type: "assistant",
      message: {
        id: "msg_fake",
        model: "claude-haiku-4-5-20251001",
        role: "assistant",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
        stop_reason: null,
        usage: USAGE,
      },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: USAGE.output_tokens },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  );
  return frames as unknown as SDKMessage[];
}

/**
 * A step with two thinking blocks and one text block: the first thinking block
 * carries readable reasoning, the second only a signature, which is what Claude
 * Code sends for encrypted reasoning.
 */
export function reasoningStep(text: string, options: InitOptions = {}): SDKMessage[] {
  return [
    initFrame(options),
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg_fake",
          model: "claude-haiku-4-5-20251001",
          role: "assistant",
          content: [],
          usage: { ...USAGE, output_tokens: 0 },
        },
      },
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "readable reasoning" } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "sig-only" } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 2 } },
    {
      type: "assistant",
      message: {
        id: "msg_fake",
        model: "claude-haiku-4-5-20251001",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "readable reasoning", signature: "sig-1" },
          { type: "thinking", thinking: "", signature: "sig-only" },
          { type: "text", text },
        ],
        stop_reason: null,
        usage: USAGE,
      },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: USAGE.output_tokens },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      usage: USAGE,
      total_cost_usd: 0.01,
      session_id: "sess_fake",
    },
  ] as unknown as SDKMessage[];
}

export function overageFrame(): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      resetsAt: 1_800_000_000,
      isUsingOverage: true,
    },
    session_id: "sess_fake",
  } as unknown as SDKMessage;
}

/** An API rejection the CLI could not classify, with the id Anthropic support asks for. */
export function apiErrorFrame(text: string, requestId = "req_abc123"): SDKMessage {
  return {
    type: "assistant",
    error: "unknown",
    is_api_error_message: true,
    request_id: requestId,
    session_id: "sess_fake",
    message: {
      id: "msg_error",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text }],
      usage: USAGE,
    },
  } as unknown as SDKMessage;
}

/** The messages one test query received and the frames the test fed it. */
export class FakeQuery {
  readonly users: string[] = [];
  readonly emitted: SDKMessage[] = [];
  interrupted = false;
  closed = false;

  private readonly queue: SDKMessage[] = [];
  private readonly readers: Array<(value: SDKMessage | null) => void> = [];
  private readonly userWaiters: Array<() => void> = [];
  private done = false;

  readonly options: Options;

  constructor(options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    this.options = options;
    void this.consume(prompt);
  }

  /** Resolve once `count` user messages (or the query end) arrived. */
  async waitForUsers(count = 1): Promise<void> {
    while (this.users.length < count && !this.done) {
      await new Promise<void>((resolve) => this.userWaiters.push(resolve));
    }
  }

  emit(...frames: SDKMessage[]): void {
    for (const frame of frames) {
      this.emitted.push(frame);
      const reader = this.readers.shift();
      if (reader) reader(frame);
      else this.queue.push(frame);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const reader of this.readers.splice(0)) reader(null);
    for (const waiter of this.userWaiters.splice(0)) waiter();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.end();
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKMessage>> => {
        const buffered = this.queue.shift();
        if (buffered) return { value: buffered, done: false };
        if (this.done) return { value: undefined as never, done: true };
        const value = await new Promise<SDKMessage | null>((resolve) => this.readers.push(resolve));
        if (value === null) return { value: undefined as never, done: true };
        return { value, done: false };
      },
    };
  }

  private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of prompt) {
        this.users.push(textOfUser(message));
        for (const waiter of this.userWaiters.splice(0)) waiter();
      }
    } catch {
      // A closed input channel ends the loop; that is not a test failure.
    }
    this.end();
  }
}

function textOfUser(message: SDKUserMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = block as unknown as Record<string, unknown>;
      return record["type"] === "text" && typeof record["text"] === "string"
        ? (record["text"] as string)
        : `[${String(record["type"])}]`;
    })
    .join("");
}

export class FakeToolServer implements McpServerLike {
  readonly handlers = new Map<unknown, (request: unknown) => Promise<unknown>>();

  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void {
    this.handlers.set(schema, handler);
  }

  /** Invoke the MCP tool call handler the way Claude Code does. */
  dispatch(name: string, args: unknown, toolUseId: string | null): Promise<unknown> {
    const handler = this.handlers.get(CALL_TOOL);
    if (!handler) throw new Error("no tool-call handler registered");
    const _meta = toolUseId === null ? undefined : { "claudecode/toolUseId": toolUseId };
    return handler({ method: "tools/call", params: { name, arguments: args, _meta } });
  }

  /** Advertised tools, as Claude Code would read them. */
  async list(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const handler = this.handlers.get(LIST_TOOLS);
    if (!handler) throw new Error("no list-tools handler registered");
    const result = (await handler({ method: "tools/list", params: {} })) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    return result.tools;
  }
}

export class FakeClaude implements SdkRuntime {
  readonly queries: FakeQuery[] = [];
  readonly servers: FakeToolServer[] = [];

  readonly tools: McpServerFactory = {
    create: () => {
      const server = new FakeToolServer();
      this.servers.push(server);
      return server;
    },
    listToolsSchema: LIST_TOOLS,
    callToolSchema: CALL_TOOL,
  };

  readonly toolServerConfig = (name: string): McpServerConfig =>
    ({ type: "sdk", name, instance: {} }) as unknown as McpServerConfig;

  readonly query = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const created = new FakeQuery(params.options, params.prompt);
    this.queries.push(created);
    return created as unknown as Query;
  };

  /** The session's tool server, once the transport created it. */
  get toolServer(): FakeToolServer {
    const server = this.servers[0];
    if (!server) throw new Error("the transport did not create a tool server");
    return server;
  }

  /** Wait for query number `count` (1-based) to exist. */
  async nextQuery(count = 1): Promise<FakeQuery> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const found = this.queries[count - 1];
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`query ${count} was never created`);
  }
}
