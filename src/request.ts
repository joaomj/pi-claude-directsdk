/**
 * Native request assembly: tool manifest, request body, child argv and
 * environment, and per-request private files.
 *
 * The current system prompt and tool schemas travel through private files
 * (system prompt file plus a settings file carrying `CLAUDE_CODE_EXTRA_BODY`)
 * to avoid OS argument and environment-string limits. Authentication and
 * identity headers are never replaced; the relay preserves them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { ThinkingLevel, Tool } from "@earendil-works/pi-ai/compat";
import { isRecord } from "./types.js";
import { INERT_MCP_SOURCE } from "./inert-mcp.js";
import { supportsAdaptiveThinking } from "./models.js";

/** MCP server name in the native child. Tool names are `mcp__pi__<name>`. */
export const MCP_SERVER_NAME = "pi";
export const TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Explicit test-mode bypass for the subscription env guard. Never set in production. */
export const TEST_UPSTREAM_ENV = "PI_DIRECTSDK_TEST_UPSTREAM";

const CONFLICTING_API_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
] as const;

const CONFLICTING_BACKEND_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function isTruthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    !["", "0", "false", "no", "off"].includes(value.toLowerCase())
  );
}

/**
 * Names of conflicting native auth/backend overrides present in the merged
 * environment. Subscription mode rejects them; explicit test mode
 * (`PI_DIRECTSDK_TEST_UPSTREAM=1`) allows them for loopback and gateway
 * fixtures. Values are never returned.
 */
export function checkEnvConflicts(env: NodeJS.ProcessEnv): string[] {
  if (isTruthy(env[TEST_UPSTREAM_ENV])) {
    return [];
  }
  const conflicts: string[] = CONFLICTING_API_VARS.filter(
    (name) => (env[name] ?? "") !== "",
  );
  for (const name of CONFLICTING_BACKEND_VARS) {
    if (isTruthy(env[name])) {
      conflicts.push(name);
    }
  }
  return conflicts;
}

export function toolPrefixedName(bare: string): string {
  return `${TOOL_NAME_PREFIX}${bare}`;
}

/** Bare Pi tool name for a native tool name, or null when foreign. */
export function toolBareName(native: string): string | null {
  return native.startsWith(TOOL_NAME_PREFIX)
    ? native.slice(TOOL_NAME_PREFIX.length)
    : null;
}

const BANNED_TOP_LEVEL = ["oneOf", "allOf", "anyOf"] as const;

/**
 * Normalize a Pi tool schema for the native validator, which rejects
 * top-level combinators. Nested unions stay untouched. Best-effort mirror of
 * the reference implementation; re-verify against the qualified CLI.
 */
export function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    throw new Error("Tool schema must be an object");
  }
  const out: Record<string, unknown> = { ...schema };
  if (Array.isArray(out["type"])) {
    const rest = (out["type"] as unknown[]).filter((t) => t !== "null");
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

export interface ManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RequestBuild {
  /** `CLAUDE_CODE_EXTRA_BODY` object. */
  body: Record<string, unknown>;
  /** Inert MCP manifest; same shape as the body tools. */
  manifest: ManifestEntry[];
  /** Bare Pi tool names in order. */
  toolNames: string[];
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Build the native request body and the inert MCP manifest from Pi tools.
 * Throws on anything the native transport cannot express.
 */
export function buildRequestBody(options: {
  tools: Tool[];
  toolChoice?: "auto" | "none" | undefined;
  reasoning?: ThinkingLevel | undefined;
  thinkingLevelMap?: Partial<Record<string, string | null>> | undefined;
  nativeModelId: string;
  maxTokens?: number | undefined;
}): RequestBuild {
  const { tools, nativeModelId } = options;
  if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") {
    throw new Error("Only tool_choice auto and none are supported");
  }
  const useTools = options.toolChoice !== "none";
  const manifest: ManifestEntry[] = [];
  const bodyTools: Array<Record<string, unknown>> = [];
  const toolNames: string[] = [];
  const seen = new Set<string>();

  if (useTools) {
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
      if (tool.constrainedSampling) {
        throw new Error(`Grammar-constrained tools are unsupported: ${name}`);
      }
      // JSON round-trip drops typebox symbols and undefined fields.
      const raw = tool.parameters === undefined ? { type: "object" } : tool.parameters;
      const schema = normalizeInputSchema(JSON.parse(JSON.stringify(raw)) as unknown);
      manifest.push({ name, description: tool.description, inputSchema: schema });
      bodyTools.push({
        name: toolPrefixedName(name),
        description: tool.description,
        input_schema: schema,
      });
      toolNames.push(name);
    }
  }

  const body: Record<string, unknown> = { tools: bodyTools };

  // Pi has no thinking-off level: an undefined reasoning keeps native
  // defaults (best-effort mirror of the reference implementation).
  if (options.reasoning !== undefined) {
    const mapped =
      options.thinkingLevelMap?.[options.reasoning] ?? defaultEffort(options.reasoning);
    if (mapped !== null) {
      if (supportsAdaptiveThinking(nativeModelId)) {
        body["thinking"] = { type: "adaptive" };
      }
      body["output_config"] = { effort: mapped };
    }
  }

  if (options.maxTokens !== undefined) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new Error("maxTokens must be a positive integer");
    }
    body["max_tokens"] = options.maxTokens;
  }
  // Subscription routes reject sampling controls, so temperature/top_p from
  // Pi options are intentionally dropped, never forwarded.
  return { body, manifest, toolNames };
}

function defaultEffort(level: ThinkingLevel | "off"): string | null {
  switch (level) {
    case "off":
      return null;
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return null;
  }
}

export interface RequestFiles {
  systemPath: string;
  settingsPath: string;
  toolsPath: string;
  mcpPath: string;
  mcpConfigJson: string;
}

/** Write per-request private files with owner-only permissions. */
export function writeRequestFiles(
  dir: string,
  files: { systemPrompt: string; body: Record<string, unknown>; manifest: ManifestEntry[] },
): RequestFiles {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const systemPath = `${dir}/system.md`;
  const settingsPath = `${dir}/settings.json`;
  const toolsPath = `${dir}/tools.json`;
  const mcpPath = `${dir}/inert-mcp.mjs`;
  writeFileSync(systemPath, files.systemPrompt, { encoding: "utf-8", mode: 0o600 });
  writeFileSync(
    settingsPath,
    JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(files.body) } }),
    { encoding: "utf-8", mode: 0o600 },
  );
  writeFileSync(toolsPath, JSON.stringify(files.manifest), {
    encoding: "utf-8",
    mode: 0o600,
  });
  writeFileSync(mcpPath, INERT_MCP_SOURCE, { encoding: "utf-8", mode: 0o600 });
  const mcpConfigJson = JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [mcpPath, toolsPath],
      },
    },
  });
  return { systemPath, settingsPath, toolsPath, mcpPath, mcpConfigJson };
}

/**
 * Build the child argv. `--max-turns 1` is accepted by the qualified CLI
 * even though recent `--help` output hides it; the fake-upstream gate
 * re-verifies it on every CLI bump.
 */
export function buildArgv(options: {
  claudeBin: string;
  nativeModelId: string;
  files: RequestFiles;
}): { command: string; args: string[] } {
  const { claudeBin, nativeModelId, files } = options;
  const args = [
    "-p",
    "--model",
    nativeModelId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    "",
    "--system-prompt-file",
    files.systemPath,
    "--settings",
    files.settingsPath,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--mcp-config",
    files.mcpConfigJson,
  ];
  return { command: claudeBin, args };
}

const WINDOWS_ESSENTIALS = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
] as const;

/** Child environment: relay routing plus native isolation flags. */
export function buildChildEnv(options: {
  baseEnv: NodeJS.ProcessEnv;
  relayUrl: string;
  body: Record<string, unknown>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.baseEnv };
  const config = env["CLAUDE_DIRECTSDK_CONFIG_DIR"];
  if (config) {
    env["CLAUDE_CONFIG_DIR"] = config;
  }
  delete env["CLAUDE_CODE_EXTRA_BODY"];
  env["ANTHROPIC_BASE_URL"] = options.relayUrl;
  env["ENABLE_TOOL_SEARCH"] = "false";
  env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  env["CLAUDE_CODE_MAX_RETRIES"] = "0";
  env["DISABLE_AUTO_COMPACT"] = "1";
  env["DISABLE_COMPACT"] = "1";
  // Pi owns budgets; the native replayed reminder would invalidate cached history.
  env["CLAUDE_CODE_TOTAL_TOKENS_REMINDER"] = "off";
  const requestBody = options.body;
  const bodyMaxTokens: unknown = requestBody["max_tokens"];
  if (typeof bodyMaxTokens === "number") {
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(bodyMaxTokens);
  }
  if (process.platform === "win32") {
    const present = new Set(Object.keys(env).map((k) => k.toUpperCase()));
    for (const [key, value] of Object.entries(process.env)) {
      const name = key.toUpperCase() as (typeof WINDOWS_ESSENTIALS)[number];
      if (
        (WINDOWS_ESSENTIALS as readonly string[]).includes(name) &&
        !present.has(name) &&
        value !== undefined
      ) {
        env[key] = value;
      }
    }
  }
  return env;
}
