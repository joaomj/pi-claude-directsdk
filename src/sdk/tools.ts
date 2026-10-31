/**
 * Pi tools as an SDK MCP server, plus the schemas Claude Code accepts.
 *
 * The server is a plain MCP `Server` with JSON-Schema tool definitions, so this
 * transport needs no schema-conversion library. Tool calls never execute here:
 * every call parks in the bridge until Pi authorizes and runs it.
 */

import type { Tool } from "@earendil-works/pi-ai/compat";
import type { McpToolResult, ToolBridge } from "./bridge.js";
import { isRecord } from "../types.js";

/** MCP server name Claude Code sees. Tools become `mcp__pi__<name>`. */
export const MCP_SERVER_NAME = "pi";
export const TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const BANNED_TOP_LEVEL = ["oneOf", "allOf", "anyOf"] as const;

export function toolPrefixedName(bare: string): string {
  return `${TOOL_NAME_PREFIX}${bare}`;
}

/** Bare Pi tool name for a Claude tool name, or null when foreign. */
export function toolBareName(native: string): string | null {
  return native.startsWith(TOOL_NAME_PREFIX) ? native.slice(TOOL_NAME_PREFIX.length) : null;
}

/**
 * Normalize a Pi tool schema for Claude's validator, which rejects top-level
 * combinators. Nested unions stay untouched.
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    throw new Error("Tool schema must be an object");
  }
  const out: Record<string, unknown> = { ...schema };
  if (Array.isArray(out["type"])) {
    const rest = (out["type"] as unknown[]).filter((value) => value !== "null");
    if (rest.length === 1) {
      out["type"] = rest[0];
    } else if (rest.length === 0) {
      delete out["type"];
    } else {
      out["type"] = rest;
    }
  }
  for (const key of BANNED_TOP_LEVEL) {
    delete out[key];
  }
  if (out["type"] === undefined) {
    out["type"] = "object";
  }
  if (out["type"] === "object" && !isRecord(out["properties"])) {
    out["properties"] = {};
  }
  return out;
}

export interface PiToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Validate Pi tools and return the MCP definitions. Throws on anything this
 * transport cannot express instead of silently degrading the schema.
 */
export function prepareToolSpecs(tools: Tool[]): PiToolSpec[] {
  const specs: PiToolSpec[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = tool.name;
    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`Tool names must be unique ASCII identifiers of at most 50 characters: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate tool name: ${name}`);
    }
    seen.add(name);
    if (typeof tool.description !== "string") {
      throw new Error(`Tool description must be a string: ${name}`);
    }
    const sampling = tool.constrainedSampling as { type?: unknown; strict?: unknown } | false | undefined;
    if (sampling) {
      // Grammar variants have no MCP equivalent; best-effort strict schemas fall
      // back to normal tool calling. Required strict stays rejected rather than
      // silently unenforced.
      const bestEffort =
        sampling.type === "grammar" ||
        (sampling.type === "json_schema" && sampling.strict === "prefer");
      if (!bestEffort) {
        throw new Error(
          `Strict constrained sampling is unsupported by this transport: ${name}. ` +
          `Only grammar fallback and best-effort (strict "prefer") tools are accepted.`,
        );
      }
    }
    // JSON round-trip drops typebox symbols and undefined fields.
    const raw = tool.parameters === undefined ? { type: "object" } : tool.parameters;
    specs.push({
      name,
      description: tool.description,
      inputSchema: normalizeInputSchema(JSON.parse(JSON.stringify(raw)) as unknown),
    });
  }
  return specs;
}

/** Structural view of the low-level MCP server, so this module imports no MCP code. */
export interface McpServerLike {
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown) => Promise<unknown>,
  ): void;
}

export interface McpServerFactory {
  create(info: { name: string; version: string }): McpServerLike;
  listToolsSchema: unknown;
  callToolSchema: unknown;
}

/** MCP tool-call request params this transport reads. */
interface CallToolParams {
  name?: unknown;
  arguments?: unknown;
  _meta?: unknown;
}

function toolUseIdFrom(params: CallToolParams): string | null {
  const meta = params._meta;
  if (!isRecord(meta)) return null;
  const id = meta["claudecode/toolUseId"];
  return typeof id === "string" && id ? id : null;
}

/**
 * Build the MCP server that advertises Pi tools. Every call parks in the bridge;
 * nothing here executes a tool or authorizes one.
 */
export function createToolServer(
  factory: McpServerFactory,
  specs: PiToolSpec[],
  bridge: ToolBridge,
): McpServerLike {
  const server = factory.create({ name: MCP_SERVER_NAME, version: "1.0.0" });
  server.setRequestHandler(factory.listToolsSchema, async () => ({
    tools: specs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // Pi decides permissions; Claude Code must not add its own approval step
      // for a tool whose execution the host owns.
      annotations: { readOnlyHint: false },
    })),
  }));
  server.setRequestHandler(factory.callToolSchema, async (request: unknown) => {
    const params = (isRecord(request) && isRecord(request["params"]) ? request["params"] : {}) as CallToolParams;
    const name = typeof params.name === "string" ? params.name : "";
    if (!specs.some((spec) => spec.name === name)) {
      throw new Error(`Claude Code called an unoffered Pi tool: ${name}`);
    }
    const result: McpToolResult = await bridge.call(toolUseIdFrom(params), name);
    return { content: result.content, isError: result.isError };
  });
  return server;
}
