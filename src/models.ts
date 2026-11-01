/** Claude Code transport identity. */
export const PROVIDER_ID = "claude-directsdk";

/** Select long context from verified model metadata, not a route table. */
export function nativeModel(model: string, contextWindow: number): string {
  if (!model) throw new Error("model is required");
  if (model.endsWith("[1m]")) return model;
  return contextWindow >= 1_000_000 ? `${model}[1m]` : model;
}
