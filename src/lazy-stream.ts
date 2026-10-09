import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai/compat";

/** Load the transport on demand and report setup failures through its stream. */
export function lazyStream(
  model: Model<Api>,
  setup: () => Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  const timestamp = Date.now();
  void (async () => {
    try {
      const inner = await setup();
      for await (const event of inner) outer.push(event);
      outer.end(await inner.result());
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp,
      };
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    }
  })();
  return outer;
}
