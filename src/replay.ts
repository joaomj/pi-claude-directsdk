/**
 * Pi transcript to native `stream-json` history replay.
 *
 * Pi owns the transcript. Each model call replays prior assistant, user, and
 * tool-result frames in native form through a fresh request-scoped child.
 * Historical user frames use `shouldQuery: false` with zero-turn
 * acknowledgments; only the final frame may generate.
 *
 * Unsupported history is rejected, never flattened into prose. Signed native
 * thinking survives only inside a durable carrier attached to the Pi
 * assistant message, and only while the visible projection is unchanged.
 */

import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  JsonObject,
  Message,
} from "@earendil-works/pi-ai/compat";
import { replayError } from "./errors.js";
import { toolPrefixedName } from "./request.js";
import {
  NativeAssistantMessage,
  NativeContentBlock,
  NativeFrame,
  deepClone,
  isRecord,
} from "./types.js";

/** Diagnostics type carrying preserved native assistant blocks. */
export const CARRIER_TYPE = "pi-claude-directsdk/native";
const CARRIER_VERSION = 1;

export interface CarrierProjection {
  text: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
}

export interface ReplayOutput {
  /** Frames in order; the last one is a nonempty user frame. */
  frames: NativeFrame[];
}

/**
 * Visible projection of a Pi assistant message. The carrier is restored only
 * when this projection still matches: any edit drops the native blocks so a
 * stale signature is never attached to rewritten content.
 */
export function messageProjection(message: AssistantMessage): CarrierProjection {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: CarrierProjection["toolCalls"] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (block.type === "thinking") {
      thinking.push(block.thinking);
    } else if (block.type === "toolCall") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: deepClone(block.arguments),
      });
    }
  }
  return {
    text: text.join("").trim(),
    thinking: thinking.join(""),
    toolCalls,
  };
}

function projectionsEqual(a: CarrierProjection, b: CarrierProjection): boolean {
  if (a.text !== b.text || a.thinking !== b.thinking) {
    return false;
  }
  if (a.toolCalls.length !== b.toolCalls.length) {
    return false;
  }
  return a.toolCalls.every((call, i) => {
    const other = b.toolCalls[i];
    return (
      other !== undefined &&
      call.id === other.id &&
      call.name === other.name &&
      JSON.stringify(call.input) === JSON.stringify(other.input)
    );
  });
}

function readCarrier(message: AssistantMessage): {
  messages: NativeAssistantMessage[];
  projection: CarrierProjection;
} | null {
  const carriers = (message.diagnostics ?? []).filter(
    (d): d is AssistantMessageDiagnostic =>
      isRecord(d) && d["type"] === CARRIER_TYPE,
  );
  if (carriers.length !== 1) {
    return null;
  }
  const details = carriers[0]?.details as Record<string, unknown> | undefined;
  if (!isRecord(details) || details["version"] !== CARRIER_VERSION) {
    return null;
  }
  if (!Array.isArray(details["messages"]) || !isRecord(details["projection"])) {
    return null;
  }
  return {
    messages: deepClone(details["messages"] as unknown as NativeAssistantMessage[]),
    projection: deepClone(details["projection"] as unknown as CarrierProjection),
  };
}

/**
 * Build the durable carrier for a fresh native response. `text` and
 * `toolCalls` describe the visible Pi message; `thinking` covers visible
 * thinking blocks. The carrier restores only while all three still match.
 */
export function encodeCarrier(
  natives: NativeAssistantMessage[],
  projection: CarrierProjection,
): AssistantMessageDiagnostic {
  // A JSON round-trip keeps the diagnostic within pi-ai's JsonValue type.
  const details = JSON.parse(
    JSON.stringify({
      version: CARRIER_VERSION,
      messages: natives,
      projection,
    }),
  ) as JsonObject;
  return { type: CARRIER_TYPE, timestamp: Date.now(), details };
}

function toNativeImage(data: string, mimeType: string): NativeContentBlock {
  if (!data || !mimeType) {
    throw replayError("Image blocks need base64 data and a media type");
  }
  return {
    type: "image",
    source: { type: "base64", media_type: mimeType, data },
  };
}

/**
 * Replay Pi messages (system messages already removed) into native frames.
 *
 * @param allowedToolNames current Pi tool inventory; historic and fresh tool
 *   calls outside it are rejected because native requests only accept
 *   declared tools.
 */
export function prepareHistory(
  messages: Message[],
  allowedToolNames?: Set<string>,
): ReplayOutput {
  const frames: NativeFrame[] = [];
  const pushUserBlocks = (blocks: NativeContentBlock[]): void => {
    if (blocks.length === 0) {
      return;
    }
    const last = frames[frames.length - 1];
    if (last?.type === "user") {
      last.message.content.push(...blocks);
    } else {
      frames.push({ type: "user", message: { role: "user", content: blocks } });
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
        throw replayError("System messages must precede conversation history");
      case "user": {
        const blocks: NativeContentBlock[] = [];
        if (typeof message.content === "string") {
          if (message.content) {
            blocks.push({ type: "text", text: message.content });
          }
        } else {
          for (const block of message.content) {
            if (block.type === "text") {
              if (block.text) {
                blocks.push({ type: "text", text: block.text });
              }
            } else if (block.type === "image") {
              blocks.push(toNativeImage(block.data, block.mimeType));
            } else {
              throw replayError(
                `Unsupported user content block: ${(block as { type: string }).type}`,
              );
            }
          }
        }
        pushUserBlocks(blocks);
        break;
      }
      case "assistant": {
        const carrier = readCarrier(message);
        if (carrier && projectionsEqual(carrier.projection, messageProjection(message))) {
          for (const native of carrier.messages) {
            frames.push({
              type: "assistant",
              message: { role: "assistant", content: deepClone(native.content) },
            });
          }
          break;
        }
        // No (or stale) carrier: the visible content must map to native
        // blocks directly. Thinking without a signature cannot be replayed.
        const blocks: NativeContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text") {
            if (block.text) {
              blocks.push({ type: "text", text: block.text });
            }
          } else if (block.type === "thinking") {
            throw replayError(
              "Assistant thinking without a native signature cannot be replayed; " +
                "compact or restart the session to continue with this provider",
            );
          } else if (block.type === "toolCall") {
            if (allowedToolNames && !allowedToolNames.has(block.name)) {
              throw replayError(`Tool call outside the current inventory: ${block.name}`);
            }
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: toolPrefixedName(block.name),
              input: deepClone(block.arguments),
            });
          } else {
            throw replayError(
              `Unsupported assistant content block: ${(block as { type: string }).type}`,
            );
          }
        }
        if (blocks.length === 0) {
          throw replayError("Empty assistant message cannot be replayed");
        }
        frames.push({ type: "assistant", message: { role: "assistant", content: blocks } });
        break;
      }
      case "toolResult": {
        const blocks: NativeContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            blocks.push(toNativeImage(block.data, block.mimeType));
          } else {
            throw replayError(
              `Unsupported tool-result content block: ${(block as { type: string }).type}`,
            );
          }
        }
        pushUserBlocks([
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content:
              blocks.length === 1 && blocks[0]?.type === "text"
                ? (blocks[0] as { text: string }).text
                : blocks,
            ...(message.isError ? { is_error: true } : {}),
          },
        ]);
        break;
      }
      default:
        throw replayError(
          `Unsupported message role: ${(message as { role: string }).role}`,
        );
    }
  }

  const last = frames[frames.length - 1];
  if (
    !last ||
    last.type !== "user" ||
    last.message.content.length === 0
  ) {
    throw replayError(
      "History must end in a nonempty user/tool-result message; assistant prefill is unsupported",
    );
  }
  // Every historical user frame must not query: only the final frame may
  // generate, and it keeps the native default. Without this flag the child
  // runs a turn per historical frame and replay acknowledgment fails.
  for (let i = 0; i < frames.length - 1; i++) {
    const frame = frames[i];
    if (frame?.type === "user") {
      frame.shouldQuery = false;
    }
  }
  return { frames };
}
