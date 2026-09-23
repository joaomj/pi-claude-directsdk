/**
 * Native Claude Code `stream-json` protocol types.
 *
 * This module covers the subset of the native wire format that the provider
 * produces (history replay frames) and consumes (assistant messages, usage,
 * result lines). The shapes mirror the official CLI's `stream-json` output;
 * they are a version-sensitive interface, not a public SDK guarantee.
 * `QUALIFIED_CLI_RANGE` in `models.ts` pins the qualified CLI versions.
 */

/** Token usage as reported by the native message stream. */
export interface NativeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  output_tokens_details?: {
    thinking_tokens?: number;
  };
  [key: string]: unknown;
}

/** One native content block. Only the variants below are supported. */
export type NativeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: string; [key: string]: unknown }>;
      is_error?: boolean;
    };

/** One native assistant message, either replayed or captured. */
export interface NativeAssistantMessage {
  id?: string;
  type?: string;
  role: "assistant";
  model?: string;
  content: NativeContentBlock[];
  stop_reason?: string | null;
  usage?: NativeUsage;
  [key: string]: unknown;
}

/**
 * One history frame written to the child stdin. Historical user frames carry
 * `shouldQuery: false` and expect a zero-turn acknowledgment; only the final
 * frame may generate.
 */
export interface NativeFrame {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: NativeContentBlock[];
  };
  shouldQuery?: boolean;
}

/** Terminal `result` line emitted by the child on stdout. */
export interface NativeResultLine {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  usage?: NativeUsage;
  total_cost_usd?: number;
  modelUsage?: unknown;
  num_turns?: number;
  [key: string]: unknown;
}

/** Native `assistant` line emitted by the child on stdout. */
export interface NativeAssistantLine {
  type: "assistant";
  message: NativeAssistantMessage;
  [key: string]: unknown;
}

/** Native `stream_event` line wrapping one upstream SSE event. */
export interface NativeStreamEventLine {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    delta?: { type: string; [key: string]: unknown };
    message?: NativeAssistantMessage;
    content_block?: NativeContentBlock;
    usage?: NativeUsage;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type NativeStdoutLine =
  | NativeAssistantLine
  | NativeStreamEventLine
  | NativeResultLine
  | { type: string; [key: string]: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-safe deep copy for native payloads. */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
