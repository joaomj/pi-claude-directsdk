/**
 * Environment boundary for the Claude Agent SDK transport.
 *
 * Pi owns the tool loop, so the child must be isolated from Claude Code's own
 * instruction sources and must never silently switch billing route. This module
 * is the single place that reads the launching environment; everything else
 * trusts its output.
 */

/** Explicit test-mode bypass for the subscription env guard. Never set in production. */
export const TEST_UPSTREAM_ENV = "PI_DIRECTSDK_TEST_UPSTREAM";

/** Claude Code config directory override; forwarded as `CLAUDE_CONFIG_DIR`. */
export const CONFIG_DIR_ENV = "CLAUDE_DIRECTSDK_CONFIG_DIR";

/** Claude Code executable override. */
export const COMMAND_ENV = "CLAUDE_DIRECTSDK_COMMAND";

/** User override for the client label the child reports. */
export const ENTRYPOINT_ENV = "CLAUDE_DIRECTSDK_ENTRYPOINT";

/** Report this client instead of the Agent SDK's `sdk-ts` label. */
export const DEFAULT_ENTRYPOINT = "pi-claude-directsdk";

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
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value.toLowerCase());
}

/**
 * Conflicting native auth/backend overrides present in the merged environment.
 * Subscription mode rejects them; explicit test mode allows loopback fixtures.
 * Values are never returned.
 */
export function checkEnvConflicts(env: NodeJS.ProcessEnv): string[] {
  if (isTruthy(env[TEST_UPSTREAM_ENV])) {
    return [];
  }
  const conflicts: string[] = CONFLICTING_API_VARS.filter((name) => (env[name] ?? "") !== "");
  for (const name of CONFLICTING_BACKEND_VARS) {
    if (isTruthy(env[name])) {
      conflicts.push(name);
    }
  }
  return conflicts;
}

/**
 * Client label for the child. An inherited label is replaced, because a Pi
 * started from inside another Claude client would otherwise report that
 * client's identity. An empty override leaves the label to the CLI.
 */
function childEntrypoint(env: NodeJS.ProcessEnv): string | undefined {
  const override = env[ENTRYPOINT_ENV];
  if (override === undefined) return DEFAULT_ENTRYPOINT;
  if (override === "") return undefined;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(override)) {
    throw new Error(
      `${ENTRYPOINT_ENV} must be 1-64 characters of letters, digits, dot, underscore, or hyphen; ` +
        `unset it for ${DEFAULT_ENTRYPOINT}, or set it to an empty string to let Claude Code label the session`,
    );
  }
  return override;
}

/**
 * Child environment for the SDK-spawned Claude Code process.
 *
 * The SDK replaces the subprocess environment entirely, so the full merged
 * environment is passed explicitly. Native autonomous behavior that duplicates
 * Pi's responsibilities is disabled here; Pi's own provider handles compaction,
 * memory, and retries.
 */
export function buildChildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const config = env[CONFIG_DIR_ENV];
  delete env[CONFIG_DIR_ENV];
  if (config) {
    env["CLAUDE_CONFIG_DIR"] = config;
  }
  // No relay: the SDK transport talks to the provider directly.
  delete env["ANTHROPIC_BASE_URL"];
  // Claude Code owns request-level retries in this transport.
  delete env["CLAUDE_CODE_MAX_RETRIES"];
  env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  env["DISABLE_AUTO_COMPACT"] = "1";
  env["DISABLE_COMPACT"] = "1";
  // Pi owns budgets; a native replayed reminder would invalidate the prompt prefix.
  env["CLAUDE_CODE_TOTAL_TOKENS_REMINDER"] = "off";
  // The SDK otherwise labels the child `sdk-ts`, which the plan window meters
  // faster than a client label. Replace an inherited label as well.
  const entrypoint = childEntrypoint(baseEnv);
  if (entrypoint) {
    env["CLAUDE_CODE_ENTRYPOINT"] = entrypoint;
  } else {
    delete env["CLAUDE_CODE_ENTRYPOINT"];
  }
  return env;
}
