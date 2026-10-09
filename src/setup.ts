/** CLI resolution and request-time authentication/version probes.
 * Catalog discovery lives in discovery.ts and never calls synchronous probes.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { LOGIN_HINT, INSTALL_HINT } from "./errors.js";
import { parseCliVersion, cliVersionSupported } from "./models.js";

export interface SetupStatus {
  available: boolean;
  loggedIn: boolean;
  plan: string;
  detail: string;
  loginCommand: string[] | null;
  version: string;
}

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

/** Child environment for setup probes. Never forwards the override variable itself. */
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

function planLabel(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) {
    return "";
  }
  return text.toLowerCase().startsWith("claude")
    ? text
    : `Claude ${text.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

/** `{available, loggedIn, plan, detail, loginCommand, version}` from `auth status`. */
export function setupStatus(options?: {
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): SetupStatus {
  const env = options?.env ?? process.env;
  const resolved = resolveClaude(options?.command, env);
  if (!resolved) {
    return {
      available: false,
      loggedIn: false,
      plan: "",
      detail: INSTALL_HINT,
      loginCommand: null,
      version: "unknown",
    };
  }
  const loginCommand = [...resolved, "auth", "login"];
  const [bin = "", ...rest] = resolved;
  let auth: Record<string, unknown> = {};
  let version = "unknown";
  try {
    const run = spawnSync(bin, [...rest, "auth", "status"], {
      env: setupChildEnv(env),
      input: "",
      encoding: "utf-8",
      timeout: options?.timeoutMs ?? 20000,
    });
    const out = typeof run.stdout === "string" ? run.stdout.trim() : "";
    if (out.startsWith("{")) {
      auth = JSON.parse(out) as Record<string, unknown>;
    }
    try {
      const v = spawnSync(bin, [...rest, "--version"], {
        env: setupChildEnv(env),
        input: "",
        encoding: "utf-8",
        timeout: 10000,
      });
      const vout = typeof v.stdout === "string" ? v.stdout : "";
      version = parseCliVersion(vout);
    } catch {
      // Version is informational; login state decides the outcome.
    }
  } catch {
    auth = {};
  }
  const loggedIn = auth["loggedIn"] === true;
  return {
    available: true,
    loggedIn,
    plan: planLabel(auth["subscriptionType"]),
    detail: loggedIn ? "" : LOGIN_HINT,
    loginCommand,
    version,
  };
}

/**
 * Probe the CLI `--version` output and refuse unqualified executables.
 * The result is cached per resolved command for the process lifetime.
 */
const qualifiedCache = new Map<string, boolean>();

export function qualifiedCli(resolved: string[], env: NodeJS.ProcessEnv): boolean {
  const key = resolved.join("\0");
  const cached = qualifiedCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let ok = false;
  try {
    const [bin = "", ...rest] = resolved;
    const run = spawnSync(bin, [...rest, "--version"], {
      env: setupChildEnv(env),
      input: "",
      encoding: "utf-8",
      timeout: 15000,
    });
    const out = typeof run.stdout === "string" ? run.stdout : "";
    ok = cliVersionSupported(parseCliVersion(out));
  } catch {
    ok = false;
  }
  qualifiedCache.set(key, ok);
  return ok;
}
