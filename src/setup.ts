/**
 * Setup-time probes of the user's Claude CLI: binary resolution, login state,
 * and the account's live model picker.
 *
 * Both probes are offline with respect to Anthropic: `auth status` reads the
 * local credential store, and the `initialize` handshake enumerates the
 * picker without a Messages request (the admission relay proves it by
 * counting upstream calls). Anything unexpected returns a safe fallback so
 * callers use the pinned catalog rather than failing setup.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AdmissionRelay } from "./admission.js";
import { LOGIN_HINT, INSTALL_HINT } from "./errors.js";
import { nativeModel, parseCliVersion } from "./models.js";

export interface SetupStatus {
  available: boolean;
  loggedIn: boolean;
  plan: string;
  detail: string;
  loginCommand: string[] | null;
  version: string;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  note: string;
  upstreamRequests: number;
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

/**
 * The account's live picker in Pi route ids, or null when the CLI is
 * missing, logged out, or the handshake fails. Makes zero upstream requests.
 */
export async function discoverModels(options?: {
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<DiscoveredModel[] | null> {
  const env = options?.env ?? process.env;
  const resolved = resolveClaude(options?.command, env);
  if (!resolved) {
    return null;
  }
  if (!setupStatus({ command: resolved, env, timeoutMs: 20000 }).loggedIn) {
    return null;
  }
  const timeoutMs = options?.timeoutMs ?? 40000;
  const relay = await AdmissionRelay.create("https://api.anthropic.com", timeoutMs);
  const pickerCwd = mkdtempSync(join(tmpdir(), "pi-directsdk-picker-"));
  try {
    const child: NodeJS.ProcessEnv = {
      ...setupChildEnv(env),
      ANTHROPIC_BASE_URL: relay.url,
    };
    const [pickerBin = "", ...pickerRest] = resolved;
    const argv = [
      pickerBin,
      ...pickerRest,
      "-p",
      "--model",
      "sonnet",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
    const handshake = `${JSON.stringify({
      type: "control_request",
      request_id: "pi-picker",
      request: { subtype: "initialize" },
    })}\n`;
    let rows: Array<Record<string, unknown>>;
    try {
      const run = spawnSync(argv[0] ?? "", argv.slice(1), {
        env: child,
        cwd: pickerCwd,
        input: handshake,
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = typeof run.stdout === "string" ? run.stdout : "";
      rows = out
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return null;
    }
    const response = rows.find((row) => row["type"] === "control_response")?.[
      "response"
    ] as Record<string, unknown> | undefined;
    const inner = response?.["response"] as Record<string, unknown> | undefined;
    const nativeList = inner?.["models"];
    if (relay.used || !Array.isArray(nativeList) || nativeList.length === 0) {
      return null;
    }
    const account = inner?.["account"] as Record<string, unknown> | undefined;
    const plan = String(account?.["subscriptionType"] ?? "").toLowerCase();
    const creditBilled =
      plan && !plan.includes("max") ? new Set(["claude-fable-5-1"]) : new Set<string>();
    const announced = nativeList.map(
      (row) =>
        String(
          (row as Record<string, unknown>)["resolvedModel"] ??
            (row as Record<string, unknown>)["value"] ??
            "",
        ),
    );
    const longContext = new Set(
      announced.filter((m) => m.endsWith("[1m]")).map((m) => m.slice(0, -4)),
    );
    const routes = new Map<string, DiscoveredModel>();
    nativeList.forEach((rowUnknown, i) => {
      const row = rowUnknown as Record<string, unknown>;
      const model = announced[i] ?? "";
      const base = model.endsWith("[1m]") ? model.slice(0, -4) : model;
      if (!base) {
        return;
      }
      let route: string;
      try {
        route = nativeModel(base);
      } catch {
        return;
      }
      if (!row["resolvedModel"]) {
        // An unresolved `value` (default, best) is an alias row, not a model.
        return;
      }
      if (!model.endsWith("[1m]") && longContext.has(base)) {
        route = `${base}[1m]`;
      }
      const label =
        String(row["description"] ?? "").split("·")[0]?.trim() || route;
      const entry = routes.get(route) ?? {
        id: route,
        label,
        note: "",
        upstreamRequests: 0,
      };
      if (
        String(row["description"] ?? "").toLowerCase().includes("usage credit") ||
        creditBilled.has(base)
      ) {
        entry.note = "usage credits";
      }
      routes.set(route, entry);
    });
    const list = [...routes.values()];
    return list.length > 0 ? list : null;
  } finally {
    rmSync(pickerCwd, { recursive: true, force: true });
    await relay.close();
  }
}
