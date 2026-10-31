/**
 * Small shared helpers plus the JSON value guard used at every boundary where
 * untrusted input arrives: SDK frames, MCP requests, catalog documents.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
