/** Typed errors for the Claude DirectSDK provider. */

export type DirectSdkErrorKind =
  | "missing"
  | "logged-out"
  | "env-conflict"
  | "sdk"
  | "tool"
  | "incomplete"
  | "native"
  | "billing"
  | "timeout"
  | "cancelled";

export class DirectSdkError extends Error {
  readonly kind: DirectSdkErrorKind;

  constructor(kind: DirectSdkErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectSdkError";
    this.kind = kind;
  }
}

export const INSTALL_HINT =
  "Claude Code is not installed (no `claude` on PATH). " +
  "Install it with `npm install -g @anthropic-ai/claude-code` " +
  "or set CLAUDE_DIRECTSDK_COMMAND to the executable path.";

export const LOGIN_HINT =
  "Claude Code is installed but not logged in. " +
  "Run `claude auth login`, then select this provider again.";

export const LOGGED_OUT_HINT =
  "Claude Code is installed but has no usable login in the environment Pi runs it in. " +
  "Run `claude auth login` as the user Pi runs as, " +
  "set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in Pi's environment, " +
  "or point CLAUDE_DIRECTSDK_CONFIG_DIR at a logged-in config directory, then try again.";

export function missingError(): DirectSdkError {
  return new DirectSdkError("missing", INSTALL_HINT);
}

export function loggedOutError(detail?: string): DirectSdkError {
  const suffix = detail ? ` (native: ${detail})` : "";
  return new DirectSdkError("logged-out", `${LOGGED_OUT_HINT}${suffix}`);
}

export function envConflictError(names: string[]): DirectSdkError {
  return new DirectSdkError(
    "env-conflict",
    "Subscription mode refuses conflicting native auth/backend overrides: " +
      names.join(", ") +
      ". Remove them from the launching environment. " +
      "Values are never printed.",
  );
}

/** The SDK subprocess or its protocol failed, not the model. */
export function sdkError(detail: string, options?: ErrorOptions): DirectSdkError {
  return new DirectSdkError("sdk", `Claude Code transport: ${detail}`, options);
}

/** A tool call could not be attributed or delivered to Pi. */
export function toolError(detail: string): DirectSdkError {
  return new DirectSdkError("tool", `Pi tool bridge: ${detail}`);
}

export function incompleteError(detail: string): DirectSdkError {
  return new DirectSdkError("incomplete", `Incomplete native response: ${detail}`);
}

export function nativeError(detail: string): DirectSdkError {
  return new DirectSdkError("native", `Native request failed: ${detail}`);
}

export function timeoutError(detail: string): DirectSdkError {
  return new DirectSdkError("timeout", `Claude request timed out: ${detail}`);
}

export function cancelledError(): DirectSdkError {
  return new DirectSdkError("cancelled", "Claude request cancelled");
}

/** True when the error represents user/outer cancellation rather than a failure. */
export function isCancelled(error: unknown): boolean {
  return (
    (error instanceof DirectSdkError && error.kind === "cancelled") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
