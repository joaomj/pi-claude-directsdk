/**
 * Pi provider assembly for Claude DirectSDK.
 *
 * Registers a static pinned catalog (cost metadata is verified list-price
 * data) and merges live picker labels for known routes on refresh. Unknown
 * live routes stay unlisted: without verified cost metadata this provider
 * cannot price them honestly.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Model,
  RefreshModelsContext,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  ALIASES,
  ALIAS_IDS,
  CATALOG,
  CONTEXT_WINDOWS,
  PROVIDER_ID,
} from "./models.js";
import { discoverModels } from "./setup.js";
import { streamClaudeDirectSdk } from "./stream.js";

export { PROVIDER_ID };

function entryFor(route: string): (typeof CATALOG)[number] | undefined {
  return CATALOG.find((entry) => entry.id === route);
}

function toModelConfig(id: string, name: string, route: string): ProviderModelConfig {
  const entry = entryFor(route);
  return {
    id,
    name,
    api: "claude-directsdk",
    reasoning: true,
    thinkingLevelMap: { minimal: "low" },
    input: ["text", "image"],
    cost: entry?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry?.contextWindow ?? CONTEXT_WINDOWS[route] ?? 200_000,
    maxTokens: entry !== undefined && entry.maxTokens !== undefined ? entry.maxTokens : 32000,
  };
}

function pinnedModels(): ProviderModelConfig[] {
  const models = CATALOG.map((entry) => toModelConfig(entry.id, entry.name, entry.id));
  for (const alias of ALIAS_IDS) {
    const route = ALIASES[alias];
    if (route) {
      const entry = entryFor(route);
      models.push(
        toModelConfig(alias, entry ? `${entry.name} (alias)` : alias, route),
      );
    }
  }
  return models;
}

export const MODELS: ProviderModelConfig[] = pinnedModels();

/**
 * Refresh the catalog. Live picker labels annotate known routes; the pinned
 * list is authoritative for visibility, context windows, and costs. Any
 * failure keeps the pinned catalog.
 */
export async function refreshModels(
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  if (context.signal.aborted) {
    return MODELS;
  }
  try {
    const discovered = await discoverModels({ timeoutMs: 40000 });
    if (!discovered || context.signal.aborted) {
      return MODELS;
    }
    const labels = new Map(discovered.map((d) => [d.id, d]));
    return MODELS.map((model) => {
      const live = labels.get(model.id);
      if (!live) {
        return model;
      }
      const note = live.note ? ` (${live.note})` : "";
      return { ...model, name: `${live.label}${note}` };
    });
  } catch {
    return MODELS;
  }
}

export function streamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamClaudeDirectSdk(model, context, options);
}
