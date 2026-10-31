/**
 * Tool bridge between Claude's MCP calls and Pi's tool loop.
 *
 * Claude Code invokes the host MCP handler and waits. The handler parks here
 * until Pi has authorized and executed the call, which happens in the following
 * Pi model call. Correlation uses the tool_use id Claude Code passes in
 * `_meta.claudecode/toolUseId`, so parallel or resumed calls cannot be answered
 * with the wrong result. When that id is absent, the oldest announced call with
 * the same tool name answers it. Anything unmatched fails closed: the host never
 * runs a tool call it cannot attribute.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";

/** MCP tool result content this transport produces. */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError: boolean;
}

export const CANCELLED_RESULT: McpToolResult = {
  content: [{ type: "text", text: "Cancelled by the Pi host. The tool did not run." }],
  isError: true,
};

/** MCP tool result from one Pi tool-result message. */
export function toMcpResult(message: ToolResultMessage): McpToolResult {
  const content: McpContent[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: message.isError ? "Tool failed with no output." : "Tool completed with no output.",
    });
  }
  return { content, isError: message.isError };
}

interface Parked {
  name: string;
  resolve: (result: McpToolResult) => void;
}

export class ToolBridge {
  /** Announced calls that Claude Code has not dispatched yet: tool_use id → name. */
  private readonly announced = new Map<string, string>();
  private readonly parked = new Map<string, Parked>();
  /** Results Pi produced before Claude Code dispatched the matching handler. */
  private readonly delivered = new Map<string, McpToolResult>();
  private settled = false;

  /** Announce a tool_use id as soon as its block streams. Idempotent. */
  announce(id: string, name: string): void {
    if (!id) return;
    this.announced.set(id, name);
  }

  /** Ids of calls that are announced or parked, in announcement order. */
  get outstanding(): string[] {
    return [...this.announced.keys(), ...this.parked.keys()];
  }

  /**
   * Park a Claude Code MCP invocation until Pi supplies its result.
   * `metaId` is `_meta.claudecode/toolUseId` when Claude Code sends it.
   */
  call(metaId: string | null, name: string): Promise<McpToolResult> {
    const id = metaId ?? this.claimAnnounced(name);
    if (id === null) {
      return Promise.resolve({
        content: [{
          type: "text",
          text:
            `Pi could not match this ${name} call to a tool_use id, so it did not run. ` +
            "This host does not execute unattributed tool calls.",
        }],
        isError: true,
      });
    }
    const ready = this.delivered.get(id);
    if (ready) {
      this.delivered.delete(id);
      return Promise.resolve(ready);
    }
    if (this.settled) {
      return Promise.resolve(CANCELLED_RESULT);
    }
    const existing = this.parked.get(id);
    if (existing) {
      return Promise.resolve({
        content: [{ type: "text", text: `Duplicate dispatch of tool call ${id}; it was not run again.` }],
        isError: true,
      });
    }
    return new Promise<McpToolResult>((resolve) => {
      this.parked.set(id, { name, resolve });
    });
  }

  /** Deliver Pi's result for one tool_use id. False when the id is unknown. */
  deliver(id: string, result: McpToolResult): boolean {
    const parked = this.parked.get(id);
    if (parked) {
      this.parked.delete(id);
      this.announced.delete(id);
      parked.resolve(result);
      return true;
    }
    if (this.settled) return false;
    if (!this.announced.has(id)) return false;
    this.delivered.set(id, result);
    return true;
  }

  /** Settle every parked call. Used on cancellation and shutdown. */
  settleAll(result: McpToolResult = CANCELLED_RESULT): void {
    this.settled = true;
    for (const [id, parked] of this.parked) {
      this.parked.delete(id);
      parked.resolve(result);
    }
    this.delivered.clear();
    this.announced.clear();
  }

  /** Make the bridge usable again after a cancellation settled it. */
  reset(): void {
    this.settled = false;
    this.parked.clear();
    this.delivered.clear();
    this.announced.clear();
  }

  private claimAnnounced(name: string): string | null {
    for (const [id, announcedName] of this.announced) {
      if (announcedName === name) {
        return id;
      }
    }
    return null;
  }
}
