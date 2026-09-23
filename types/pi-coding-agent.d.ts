/**
 * Minimal ambient types for the Pi extension host.
 *
 * Mirrors `@earendil-works/pi-coding-agent` 0.87.1
 * (`dist/core/extensions/types.d.ts`) for exactly the surface this project
 * uses. The real package supplies these at runtime; every import from it is
 * type-only and erased, so this shim carries zero runtime behavior. Re-check
 * the definitions when the pinned Pi version changes.
 */

declare module "@earendil-works/pi-coding-agent" {
  import type {
    Api,
    AssistantMessageEventStream,
    Model,
    RefreshModelsContext,
    SimpleStreamOptions,
    TranscriptContext,
  } from "@earendil-works/pi-ai/compat";

  /** Configuration for registering a provider via pi.registerProvider(). */
  export interface ProviderConfig {
    /** Display name for the provider in UI. */
    name?: string;
    /** Base URL for the API endpoint. Required when defining models. */
    baseUrl?: string;
    /** API key literal, env interpolation, or leading !command. Required when defining models (unless oauth provided). */
    apiKey?: string;
    /** API type. Required at provider or model level when defining models. */
    api?: Api;
    /**
     * Optional streamSimple handler for custom APIs.
     * Implementations must invoke `options.onPayload` before sending the provider request and use any
     * returned replacement payload. They must invoke `options.onResponse` after receiving the response
     * and before consuming its body, matching built-in providers.
     */
    streamSimple?: (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
    /** Custom headers to include in requests. */
    headers?: Record<string, string>;
    /** If true, adds Authorization: Bearer header with the resolved API key. */
    authHeader?: boolean;
    /** Models to register. If provided, replaces all existing models for this provider. */
    models?: ProviderModelConfig[];
    /**
     * Refresh this provider's model list. The returned list replaces extension-provided models.
     * Use context.publish({ persist: entry }) when the catalog should persist across sessions.
     */
    refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
  }

  /** Configuration for a model within a provider. */
  export interface ProviderModelConfig {
    /** Model ID (e.g., "claude-sonnet-4-20250514"). */
    id: string;
    /** Display name (e.g., "Claude 4 Sonnet"). */
    name: string;
    /** API type override for this model. */
    api?: Api;
    /** API endpoint URL override for this model. */
    baseUrl?: string;
    /** Whether the model supports extended thinking. */
    reasoning: boolean;
    /** Maps pi thinking levels to provider/model-specific values; null marks a level unsupported. */
    thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
    /** Supported input types. */
    input: ("text" | "image")[];
    /** Provider input limits and cache-safe image preprocessing metadata. */
    inputLimits?: Model<Api>["inputLimits"];
    /** Per-million-token cost rates and optional request-wide input pricing tiers. */
    cost: Model<Api>["cost"];
    /** Best-effort prompt cache lifetime in seconds per retention tier. Unset disables cache warming. */
    promptCache?: Model<Api>["promptCache"];
    /** Maximum context window size in tokens. */
    contextWindow: number;
    /** Maximum output tokens. */
    maxTokens: number;
    /** Custom headers for this model. */
    headers?: Record<string, string>;
    /** OpenAI compatibility settings. */
    compat?: Model<Api>["compat"];
  }

  export interface ExtensionAPI {
    registerProvider(name: string, config: ProviderConfig): void;
    unregisterProvider(name: string): void;
  }
}
