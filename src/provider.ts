/** Register an empty catalog; refresh only after Pi allows network work. */
import type {
  Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { Provider } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.js";
import { lazyStream } from "./lazy-stream.js";

export { PROVIDER_ID };

export function createDirectSdkProvider(report: (message: string) => void): Provider {
  let models: Model<Api>[] = [];
  let refreshedAt = 0;
  return {
    id: PROVIDER_ID,
    name: "Claude DirectSDK",
    baseUrl: "process://claude-directsdk",
    auth: {
      apiKey: {
        name: "Claude CLI authentication",
        resolve: async () => ({ auth: { apiKey: "[REDACTED]" }, source: "Claude CLI" }),
      },
    },
    getModels: () => models,
    async refreshModels(context) {
      // This path must not import discovery, run a child, or contact the web.
      if (context.signal.aborted) return;
      if (!context.allowNetwork) {
        if (!models.length && context.stored?.checkedAt) {
          await context.publish({ update: () => {
            models = context.stored!.models.map(model => ({ ...model,
              name: `${model.name} (last verified snapshot)` }));
            refreshedAt = context.stored!.checkedAt!;
          } });
        }
        return;
      }
      if (!context.force && Date.now() - refreshedAt < 15 * 60_000) return;
      const deadline = AbortSignal.timeout(12_000);
      const signal = AbortSignal.any([context.signal, deadline]);
      try {
        const [{ discoverModels }, { loadWebCatalog }] = await Promise.all([
          import("./discovery.js"), import("./web-catalog.js"),
        ]);
        const picker = await discoverModels(signal);
        const result = await loadWebCatalog(picker, signal);
        signal.throwIfAborted();
        const accepted = await context.publish({ persist: { models: result.models, checkedAt: Date.now() }, update: () => {
          models = result.models;
          refreshedAt = Date.now();
        } });
        if (!accepted) return;
        if (result.warnings.length) {
          report(`Claude DirectSDK excluded models with incomplete metadata:\n${result.warnings.join("\n")}`);
        }
        if (!result.models.length) throw new Error("No Claude models have complete, verified metadata");
      } catch (error) {
        if (context.signal.aborted) throw error;
        await context.publish({ persist: null, update: () => { models = []; refreshedAt = 0; } });
        const message = `Claude DirectSDK catalog refresh failed: ${error instanceof Error ? error.message : error}. No pinned fallback is used.`;
        report(message);
        throw new Error(message, { cause: error });
      }
    },
    stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
    streamSimple,
  };
}

export function streamSimple(
  model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const { streamClaudeDirectSdk } = await import("./stream.js");
    return streamClaudeDirectSdk(model, context, options);
  });
}
