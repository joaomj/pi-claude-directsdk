/** CLI resolution and request-time authentication/version probes.
 * Catalog discovery lives in discovery.ts and never calls synchronous probes.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Resolve the `claude` executable. Returns argv head or undefined. */
export function resolveClaude(
  command: string | string[] | undefined,
  env: NodeJS.ProcessEnv,
): string[] | undefined {
  const parts =
    command !== undefined
      ? Array.isArray(command)
        ? command
        : [command]
      : [env["CLAUDE_DIRECTSDK_COMMAND"] || "claude"];
  const head = parts[0];
  if (head === undefined || head === "") {
    return undefined;
  }
  const exe = isExecutable(head, env) ? head : findOnPath(head, env);
  return exe === undefined ? undefined : [exe, ...parts.slice(1)];
}

function isExecutable(path: string, _env: NodeJS.ProcessEnv): boolean {
  const absolute =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  if (!absolute) {
    return false;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env["PATH"] ?? "";
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching.
      }
    }
  }
  return undefined;
}

/** Child environment for catalog discovery probes. Never forwards the override variable itself. */
export function setupChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  const config = child["CLAUDE_DIRECTSDK_CONFIG_DIR"];
  delete child["CLAUDE_DIRECTSDK_CONFIG_DIR"];
  if (config) {
    child["CLAUDE_CONFIG_DIR"] = config;
  }
  child["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  child["DISABLE_TELEMETRY"] = "1";
  child["DISABLE_ERROR_REPORTING"] = "1";
  return child;
}
