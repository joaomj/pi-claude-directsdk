/**
 * One persistent Claude Agent SDK query per Pi conversation.
 *
 * The query is a streaming-input session: Pi sends a user message, consumes the
 * assistant output of one step, and keeps the same process for the next step.
 * Tool handlers park in the bridge while Pi executes a call, so a tool round
 * trip never restarts Claude Code and never replays history.
 */

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "./channel.js";
import type { SdkRuntime } from "./adapter.js";
import { buildSdkOptions, type Effort } from "./options.js";
import { createToolServer, MCP_SERVER_NAME, type PiToolSpec } from "./tools.js";
import type { ToolBridge } from "./bridge.js";
import { missingError, sdkError } from "../errors.js";

/** Grace period for a graceful interrupt before the session is dropped. */
const INTERRUPT_GRACE_MS = 3_000;
const STDERR_CAP = 16 * 1024;

export interface SessionOpenInput {
  runtime: SdkRuntime;
  cliPath: string;
  /** Native model id for Claude Code. */
  model: string;
  effort: Effort | undefined;
  /** Pi instructions appended to Claude Code's base prompt. */
  append: string;
  specs: PiToolSpec[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  bridge: ToolBridge;
  onStderr?: ((chunk: string) => void) | undefined;
}

export interface McpServerStatus {
  name: string;
  status: string;
}

export class ClaudeSession {
  readonly bridge: ToolBridge;
  readonly specs: PiToolSpec[];
  sessionId: string | undefined;
  cliVersion: string | undefined;
  mcpServers: McpServerStatus[] = [];

  private readonly frames = new Channel<SDKMessage>();
  private readonly input = new Channel<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private query: Query | undefined;
  private stderrTail = "";
  private interrupting: Promise<boolean> | undefined;
  private closed = false;
  private finished = false;

  private constructor(bridge: ToolBridge, specs: PiToolSpec[]) {
    this.bridge = bridge;
    this.specs = specs;
  }

  static async open(input: SessionOpenInput): Promise<ClaudeSession> {
    const session = new ClaudeSession(input.bridge, input.specs);
    const serialised = input.specs.map((spec) => spec.name);
    const allowedTools = serialised.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);
    const server = createToolServer(input.runtime.tools, input.specs, input.bridge);
    const options = buildSdkOptions({
      cliPath: input.cliPath,
      model: input.model,
      effort: input.effort,
      append: input.append,
      allowedTools,
      toolServer: input.runtime.toolServerConfig(MCP_SERVER_NAME, server),
      env: input.env,
      cwd: input.cwd,
      abortController: session.abortController,
      onStderr: (chunk) => {
        session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_CAP);
        input.onStderr?.(chunk);
      },
    });
    try {
      session.query = input.runtime.query({ prompt: session.prompt(), options });
    } catch (error) {
      throw startError(error, input.cliPath);
    }
    void session.pump(input.cliPath);
    return session;
  }

  /** True once the CLI process ended; the session cannot be reused. */
  get ended(): boolean {
    return this.finished || this.frames.isClosed;
  }

  /** Queue one user message. Pi tool results travel through the bridge instead. */
  sendUser(content: string | Array<Record<string, unknown>>): void {
    if (this.closed) return;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    this.input.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: blocks },
    } as unknown as SDKUserMessage);
  }

  /** Next SDK message, or null when the session ended. Deadline resets per frame. */
  nextFrame(timeoutMs: number): Promise<SDKMessage | null> {
    return this.frames.next(timeoutMs);
  }

  stderr(maxChars = 500): string {
    return this.stderrTail.slice(-maxChars);
  }

  /**
   * Ask Claude Code to stop the current turn and keep the process. Claude Code
   * ends the turn with a `result` frame and keeps its conversation, so the next
   * turn still reads the cached prefix. Concurrent callers share one request.
   * Resolves false, with the session closed, when the interrupt is not acknowledged.
   */
  interrupt(): Promise<boolean> {
    this.interrupting ??= this.requestInterrupt();
    return this.interrupting;
  }

  /** Change the reasoning effort of the live session; undefined restores the model default. */
  async setEffort(effort: Effort | undefined): Promise<void> {
    if (!this.query || this.closed) throw sdkError("the Claude session is closed");
    await withDeadline(this.query.applyFlagSettings({ effortLevel: effort ?? null }), INTERRUPT_GRACE_MS);
  }

  /**
   * Discard the frames of an interrupted turn up to its `result`. Parked tool
   * calls are answered as not run, so Claude Code never waits on them.
   * False when the turn did not end in time; the session is then closed.
   */
  async finishInterrupted(resultSeen: boolean): Promise<boolean> {
    const acknowledged = await this.interrupt();
    this.interrupting = undefined;
    this.bridge.settleAll();
    this.bridge.reset();
    if (!acknowledged) return false;
    while (!resultSeen) {
      const frame = await this.frames.next(INTERRUPT_GRACE_MS).catch(() => null);
      if (frame === null) {
        this.close();
        return false;
      }
      resultSeen = frame.type === "result";
    }
    return !this.ended;
  }

  private async requestInterrupt(): Promise<boolean> {
    const query = this.query;
    if (!query || this.closed) return false;
    try {
      await withDeadline(query.interrupt(), INTERRUPT_GRACE_MS);
      return true;
    } catch {
      // An interrupt that cannot be delivered is followed by a hard close.
      this.close();
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge.settleAll();
    this.input.close();
    this.frames.close();
    try {
      this.query?.close();
    } catch {
      // Closing an already-finished query is not an error worth reporting.
    }
    this.query = undefined;
    this.abortController.abort();
  }

  private async *prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = await this.input.next();
      if (next === null) return;
      yield next;
    }
  }

  private async pump(cliPath: string): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      for await (const message of query) {
        this.observe(message);
        this.frames.push(message);
      }
      this.frames.close();
    } catch (error) {
      if (this.closed) {
        this.frames.close();
        return;
      }
      this.frames.close(protocolError(error, cliPath, this.stderrTail));
    } finally {
      this.finished = true;
    }
  }

  private observe(message: SDKMessage): void {
    if (message.type !== "system" || message.subtype !== "init") return;
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    if (typeof message.claude_code_version === "string") {
      this.cliVersion = message.claude_code_version;
    }
    if (Array.isArray(message.mcp_servers)) {
      this.mcpServers = message.mcp_servers.map((server) => ({
        name: String(server.name),
        status: String(server.status),
      }));
    }
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Referenced on purpose: nothing else may be pending while the CLI ignores
    // an interrupt, and an unref'd timer lets the process exit before it fires.
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** SDK launch failures carry the path; Pi needs the fix, not only the path. */
function startError(error: unknown, cliPath: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (/not found at|ENOENT|no such file/i.test(detail)) {
    const missing = missingError();
    return sdkError(`${missing.message} Claude Code path: ${cliPath}. SDK said: ${detail}`, {
      cause: error,
    });
  }
  return sdkError(`could not start Claude Code at ${cliPath}: ${detail}`, { cause: error });
}

function protocolError(error: unknown, cliPath: string, stderr: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const tail = stderr.trim();
  const suffix = tail ? ` stderr: ${tail.slice(-500)}` : " stderr: <empty>";
  if (/not logged in|authentication_failed|oauth|api key/i.test(detail + tail)) {
    return sdkError(
      `Claude Code is not logged in. Run \`claude auth login\` as the user Pi runs as, then retry. ` +
        `SDK said: ${detail}${suffix}`,
      { cause: error },
    );
  }
  return sdkError(
    `Claude Code at ${cliPath} failed or exited mid-turn. Check that it supports the Agent SDK. ` +
      `SDK said: ${detail}${suffix}`,
    { cause: error },
  );
}
