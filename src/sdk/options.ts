/**
 * SDK options assembled from one Pi model call.
 *
 * Native tools, filesystem settings, hooks, skills, and project instructions are
 * all disabled here: Pi supplies the tools, the instructions, and the approvals.
 * Claude Code keeps its base system prompt with Pi's prompt appended.
 */

import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME } from "./tools.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Keep only effort levels Claude Code accepts. */
export function toEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? (value as Effort)
    : undefined;
}

export interface SdkOptionsInput {
  cliPath: string;
  model: string;
  effort: Effort | undefined;
  /** Pi's instructions, appended to Claude Code's base prompt. */
  append: string;
  /** Claude-facing tool names (`mcp__pi__<name>`) that Pi offers this turn. */
  allowedTools: string[];
  toolServer: McpServerConfig;
  env: NodeJS.ProcessEnv;
  cwd: string;
  abortController: AbortController;
  onStderr?: (chunk: string) => void;
}

export function buildSdkOptions(input: SdkOptionsInput): Options {
  const options: Options = {
    pathToClaudeCodeExecutable: input.cliPath,
    cwd: input.cwd,
    model: input.model,
    // No native tools: every tool call must arrive at the host MCP server.
    tools: [],
    // Claude Code's permission layer must not decide anything Pi owns; listing
    // the offered tools lets the call reach the host handler, where Pi decides.
    allowedTools: input.allowedTools,
    // No user, project, or local settings, and no CLAUDE.md discovery.
    settingSources: [],
    strictMcpConfig: true,
    // No skill listing or Skill tool.
    skills: [],
    // Pi owns the transcript: Claude Code must not keep a second copy of the
    // conversation in ~/.claude/projects, and this transport never resumes one.
    persistSession: false,
    includePartialMessages: true,
    permissionMode: "dontAsk",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.append,
    },
    mcpServers: { [MCP_SERVER_NAME]: input.toolServer },
    settings: {
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
    },
    env: input.env,
    abortController: input.abortController,
  };
  if (input.effort) {
    options.effort = input.effort;
  }
  if (input.onStderr) {
    options.stderr = input.onStderr;
  }
  return options;
}
