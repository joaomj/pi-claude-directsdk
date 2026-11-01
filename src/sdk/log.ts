/**
 * Failure log for the Claude transport.
 *
 * A failed turn is already recorded in Pi's session transcript, but nothing
 * separates transport failures from conversation content, and the CLI's stderr
 * and upstream request id are lost when the reason is logged. This module keeps
 * one JSON line per transport event so an operator can read them on their own.
 *
 * Logging never breaks a turn: every failure here is swallowed.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Path override; an empty value disables the log. */
export const LOG_ENV = "CLAUDE_DIRECTSDK_LOG";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "logs");
const DEFAULT_FILE = "claude-directsdk.jsonl";

/** The file is rotated once at this size, so a stuck loop cannot fill the disk. */
const MAX_BYTES = 1024 * 1024;
const MAX_FIELD = 2000;

export interface TransportEvent {
  /** `error`, `aborted`, `unoffered_tool`, or a `DirectSdkError` kind. */
  kind: string;
  message: string;
  model?: string | undefined;
  cliVersion?: string | undefined;
  claudeSessionId?: string | undefined;
  mcpServers?: string[] | undefined;
  requestId?: string | undefined;
  stderrTail?: string | undefined;
  piSessionId?: string | undefined;
  resultSubtype?: string | undefined;
}

/** Log path for one process, or null when the log is disabled. */
export function logPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[LOG_ENV];
  if (configured !== undefined) {
    const value = configured.trim();
    if (value === "" || ["0", "false", "no", "off"].includes(value.toLowerCase())) return null;
    return value;
  }
  return join(DEFAULT_DIR, DEFAULT_FILE);
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
}

/** Write one event. Returns the path written, or null when logging is off. */
export function logTransportEvent(event: TransportEvent, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = logPath(env);
  if (!path) return null;
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    kind: event.kind,
    message: trim(event.message),
    model: event.model,
    cliVersion: event.cliVersion,
    claudeSessionId: event.claudeSessionId,
    mcpServers: event.mcpServers,
    requestId: event.requestId,
    resultSubtype: event.resultSubtype,
    piSessionId: event.piSessionId,
    stderrTail: trim(event.stderrTail),
  })}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size + Buffer.byteLength(line) > MAX_BYTES) {
      // One generation is enough: the previous file survives the rotation, and
      // an older one is replaced instead of growing a numbered history.
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line);
    return path;
  } catch {
    return null;
  }
}
