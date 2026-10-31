/**
 * Lazily loaded access to the official Claude Agent SDK and the MCP server
 * implementation. Both are imported only when a model call needs them, so Pi's
 * startup path never loads them.
 */

import type {
  McpServerConfig,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServerFactory, McpServerLike } from "./tools.js";
import { DirectSdkError } from "../errors.js";

export interface SdkRuntime {
  /** Start one persistent streaming-input query. */
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query;
  /** Low-level MCP server factory for the host tool server. */
  tools: McpServerFactory;
  /** Wrap a host MCP server instance for `options.mcpServers`. */
  toolServerConfig(name: string, instance: unknown): McpServerConfig;
}

let runtimePromise: Promise<SdkRuntime> | null = null;

/** Load the SDK once per process. */
export function loadRuntime(): Promise<SdkRuntime> {
  runtimePromise ??= createRuntime().catch((error: unknown) => {
    runtimePromise = null;
    throw new DirectSdkError(
      "sdk",
      "The Claude Agent SDK is not available. Install this package with its dependencies " +
        `(npm install --omit=optional), then restart Pi. Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      { cause: error },
    );
  });
  return runtimePromise;
}

async function createRuntime(): Promise<SdkRuntime> {
  const [sdk, mcpServer, mcpTypes] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const tools: McpServerFactory = {
    create: (info) =>
      new mcpServer.Server(info, { capabilities: { tools: {} } }) as unknown as McpServerLike,
    listToolsSchema: mcpTypes.ListToolsRequestSchema,
    callToolSchema: mcpTypes.CallToolRequestSchema,
  };
  return {
    query: (params) => sdk.query(params),
    tools,
    toolServerConfig: (name, instance) =>
      ({ type: "sdk", name, instance }) as unknown as McpServerConfig,
  };
}

/** Messages this transport consumes. Every other SDK message is ignored. */
export type Frame = SDKMessage;
