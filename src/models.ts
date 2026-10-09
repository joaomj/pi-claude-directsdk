/** Claude Code transport identity and version qualification. */
export const PROVIDER_ID = "claude-directsdk";

/** Re-run the transport gate before widening this range. */
export const QUALIFIED_CLI_RANGE = ">=2.1.263 <2.2.0";

/** Select long context from verified model metadata, not a route table. */
export function nativeModel(model: string, contextWindow: number): string {
  if (!model) throw new Error("model is required");
  if (model.endsWith("[1m]")) return model;
  return contextWindow >= 1_000_000 ? `${model}[1m]` : model;
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
