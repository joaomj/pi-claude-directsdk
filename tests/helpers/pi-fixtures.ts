/** Pi transcript fixtures for Gate 1 tests. */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  Model,
  SystemMessage,
  Tool,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai/compat";

export function testModel(id = "claude-opus-5-5"): Model<Api> {
  return {
    api: "claude-directsdk",
    provider: "claude-directsdk",
    id,
    name: id,
    baseUrl: "process://claude-directsdk",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000,
    maxTokens: 32000,
  } as Model<Api>;
}

export function systemMessage(
  text: string,
  tools: Tool[] = [],
): SystemMessage {
  const message: SystemMessage = {
    role: "system",
    content: text,
    timestamp: Date.now(),
  };
  if (tools.length > 0) {
    message.toolsAdded = tools;
  }
  return message;
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function assistantMessage(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "claude-directsdk",
    provider: "claude-directsdk",
    model: "claude-opus-5-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export function readTool(): Tool {
  return {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  } as Tool;
}

export function contextWith(...messages: Message[]): TranscriptContext {
  return { messages } as unknown as TranscriptContext;
}

export async function collectEvents(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export function eventTypes(events: AssistantMessageEvent[]): string[] {
  return events.map((event) => event.type);
}
