/**
 * Pinned native model catalog.
 *
 * Route table, aliases, and the `[1m]` long-context selection rule follow the
 * qualified reference implementation (Hermes Claude Subscription DirectSDK,
 * MIT). The replay acknowledgments and admission behavior are
 * version-sensitive interfaces; `QUALIFIED_CLI_RANGE` pins the CLI versions
 * this provider is qualified against. Re-run the fake-upstream gate before
 * widening the range.
 *
 * Cost rates are native list-price rates in USD per million tokens. They feed
 * Pi usage accounting and the list-price estimate label. They are estimates,
 * not subscription charges.
 */

export const PROVIDER_ID = "claude-directsdk";

/** Qualified Claude Code versions. Recorded per call; behavior failures fail at runtime. */
export const QUALIFIED_CLI_RANGE = ">=2.1.263 <2.2.0";

/** Native context windows by canonical route. */
export const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-fable-5-1": 1_000_000,
};

/**
 * Families that reject `thinking: {"type": "disabled"}`. A disable request is
 * omitted for them: thinking stays on at the model default, which beats a
 * dead request.
 */
const MANDATORY_THINKING = ["claude-fable"] as const;

export const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

/**
 * Routes that reject `thinking: {"type": "adaptive"}`. Their own default
 * thinking plus the effort signal stands in for it. Unknown routes keep
 * adaptive so future models are not silently downgraded.
 */
const NO_ADAPTIVE_THINKING = new Set(["claude-haiku-4-5-20251001"]);

export interface CatalogEntry {
  /** Pi model id and canonical native route (before `[1m]` selection). */
  id: string;
  name: string;
  contextWindow: number;
  /** Declared output cap for Pi display and accounting. */
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5 (subscription)",
    contextWindow: 1_000_000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5 (subscription)",
    contextWindow: 1_000_000,
    maxTokens: 32000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5 (subscription)",
    contextWindow: 1_000_000,
    maxTokens: 32000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (subscription)",
    contextWindow: 1_000_000,
    maxTokens: 32000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1 (subscription)",
    contextWindow: 1_000_000,
    maxTokens: 32000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (subscription)",
    contextWindow: 200_000,
    maxTokens: 32000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
];

/** Pi-facing alias ids that resolve to canonical routes. */
export const ALIAS_IDS = ["sonnet", "opus", "haiku", "fable", "claude-haiku-4-5"] as const;

function canonicalRoute(model: string): string {
  const base = model.endsWith("[1m]") ? model.slice(0, -4) : model;
  return ALIASES[base] ?? base;
}

/**
 * Select the native `--model` value. A loopback gateway needs explicit
 * long-context selection: 1M routes get the `[1m]` suffix, and routes
 * without 1M support reject it.
 */
export function nativeModel(model: string): string {
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("model is required");
  }
  const base = model.endsWith("[1m]") ? model.slice(0, -4) : model;
  const canonical = ALIASES[base] ?? base;
  const window = CONTEXT_WINDOWS[canonical];
  if (window === 1_000_000) {
    return `${canonical}[1m]`;
  }
  if (window === 200_000) {
    if (model.endsWith("[1m]")) {
      throw new Error("Haiku 4.5 does not support a 1M context window");
    }
    return canonical;
  }
  return model;
}

export function acceptsThinkingDisable(model: unknown): boolean {
  const base =
    typeof model === "string" && model.endsWith("[1m]") ? model.slice(0, -4) : model;
  if (typeof base !== "string") {
    return true;
  }
  const canonical = ALIASES[base] ?? base;
  return !MANDATORY_THINKING.some((prefix) => canonical.startsWith(prefix));
}

export function supportsAdaptiveThinking(model: unknown): boolean {
  const base =
    typeof model === "string" && model.endsWith("[1m]") ? model.slice(0, -4) : model;
  if (typeof base !== "string") {
    return true;
  }
  const canonical = ALIASES[base] ?? base;
  return !NO_ADAPTIVE_THINKING.has(canonical);
}

/** Context window for a Pi model id, falling back to 200k for unknown routes. */
export function contextWindowFor(model: string): number {
  return CONTEXT_WINDOWS[canonicalRoute(model)] ?? 200_000;
}

/** Parse `2.1.267 (Claude Code)` style version output. */
export function parseCliVersion(output: string): string {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1] ?? "unknown";
}

/** True when the detected CLI is inside the qualified range (>=2.1.263 <2.2.0). */
export function cliVersionSupported(version: string): boolean {
  const parts = version.split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
    return false;
  }
  const [major, minor, patch] = parts as [number, number, number];
  return major === 2 && minor === 1 && patch >= 263;
}
